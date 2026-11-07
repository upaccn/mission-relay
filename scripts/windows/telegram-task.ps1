# Optional Windows interactive-user lifecycle for the Mission Relay Telegram poller.
# No task or credentials are created until the owner runs -Action Enroll locally.
param(
    [ValidateSet('Enroll','Worker','Status','Start','Restart','Upgrade','UpgradeSchedule','SetProxy','ClearProxy','Remove')]
    [string]$Action = 'Status',
    [string]$ProxyUrl = '',
    [string]$ExpectedSha = '',
    [string]$ResumeMissionId = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [Console]::InputEncoding = [System.Text.UTF8Encoding]::new()

$taskName = 'MissionRelay-Telegram'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$node = Join-Path $env:USERPROFILE 'scoop\apps\nodejs-lts\current\node.exe'
$cli = Join-Path $root 'dist\cli.js'
$privateDir = Join-Path $env:LOCALAPPDATA 'MissionRelay\telegram-task'
$tokenFile = Join-Path $privateDir 'bot-token.dpapi'
$settingsFile = Join-Path $privateDir 'owner.json'

function Assert-LocalProxy([string]$url) {
    if ($url -notmatch '^http://127\.0\.0\.1:([0-9]{1,5})$') {
        throw 'Proxy must be a local HTTP endpoint such as http://127.0.0.1:20808'
    }
    $port = [int]$Matches[1]
    if ($port -lt 1 -or $port -gt 65535) { throw 'Invalid local proxy port' }
}

function Assert-Prerequisites {
    if (-not $IsWindows) { throw 'Windows required' }
    if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { throw 'Node LTS not found in Scoop current path' }
    if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) { throw 'Run npm run build before managing the Telegram task' }
}

function Assert-InteractiveSession([int]$sessionId = [System.Diagnostics.Process]::GetCurrentProcess().SessionId) {
    # The Playwriter-enabled Chrome profile belongs to the signed-in desktop.
    # A service/Session 0 worker must never attempt to control or launch Chrome.
    if ($sessionId -eq 0) {
        throw 'Mission Relay Telegram worker requires an interactive Windows session; Session 0 is prohibited'
    }
}

function Get-ChannelStatus {
    $text = (& $node $cli channel-status | Out-String)
    if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect Telegram channel state' }
    return ($text | ConvertFrom-Json)
}

function Get-Task {
    return Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
}

function New-RecoveryTriggers {
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent().Name
    $logon=New-ScheduledTaskTrigger -AtLogOn -User $identity
    # A repeating DAILY trigger is intentional: unlike RestartOnFailure,
    # a recurring trigger can recover a task whose action exited nonzero.
    # IgnoreNew prevents another instance while the controller is running.
    $daily=New-ScheduledTaskTrigger -Daily -At '00:00'
    $template=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
        -RepetitionInterval (New-TimeSpan -Minutes 2) `
        -RepetitionDuration (New-TimeSpan -Days 1)
    $daily.Repetition=$template.Repetition
    return @($logon,$daily)
}

function Assert-OurTask {
    $task = Get-Task
    if (-not $task) { throw 'Task not installed; use Enroll in the local interactive PowerShell session' }
    $expected = [IO.Path]::GetFullPath($PSCommandPath)
    if (-not ($task.Actions | Where-Object { $_.Arguments -like "*${expected}*" -and $_.Arguments -like '*-Action Worker*' })) {
        throw 'Existing task has a different action; refusing to modify it'
    }
    return $task
}

function Assert-SafeRestart {
    $channel = Get-ChannelStatus
    if ($channel.pendingReplies -ne 0) { throw 'Undelivered Telegram replies: restart deferred' }
    # Read the canonical SQLite file without mutating source or executing any Mission.
    $dbFile = Join-Path $env:LOCALAPPDATA 'MissionRelay\missions.sqlite'
    if (-not (Test-Path -LiteralPath $dbFile)) { throw 'Mission database missing; restart deferred' }
    $check = Join-Path $root 'scripts\windows\telegram-restart-check.mjs'
    & $node $check $dbFile
    if ($LASTEXITCODE -ne 0) { throw 'A Mission is active or has an unresolved browser Send; restart deferred' }
}

function Wait-ForChannel([bool]$expected, [int]$seconds = 40) {
    for ($i = 0; $i -lt $seconds; $i++) {
        Start-Sleep -Seconds 1
        $status=Get-ChannelStatus
        if (-not $expected -and -not $status.pollerPresent) { return }
        if ($expected -and $status.pollerPresent -and $status.transportHealth -eq 'healthy') { return }
    }
    throw "Telegram poller did not reach expected state with successful Bot API polling: $expected"
}

function Request-ChannelDrain {
    $raw = (& $node $cli channel-drain-request | Out-String)
    if ($LASTEXITCODE -ne 0) { throw 'Failed to reserve Telegram maintenance drain' }
    $result = $raw | ConvertFrom-Json
    if ([string]$result.drainId -notmatch '^[0-9a-f-]{36}$') { throw 'Invalid maintenance drain receipt' }
    return [string]$result.drainId
}

function Release-ChannelDrain([string]$drainId) {
    $null = & $node $cli channel-drain-release --id $drainId
    if ($LASTEXITCODE -ne 0) { throw 'Maintenance drain could not be released: do not start another worker' }
}

function Assert-UpgradeTarget([string]$sha) {
    if ($sha -cnotmatch '^[0-9a-f]{40}$') {
        throw 'Upgrade requires an exact lowercase 40-character GitHub main SHA (-ExpectedSha)'
    }
    if ($ResumeMissionId -and $ResumeMissionId -notmatch '^[0-9a-fA-F-]{36}$') {
        throw 'ResumeMissionId must be one existing Mission UUID'
    }
    $branch = (& git -C $root symbolic-ref --quiet --short HEAD | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $branch -ne 'main') {
        throw 'Pull-only upgrade requires the clean main branch, not a detached checkout'
    }
    $changes = (& git -C $root status --porcelain=v1 --untracked-files=all | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $changes) {
        throw 'GMK checkout has local changes; source must be reconciled in AIOS before upgrade'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $root 'node_modules\typescript\bin\tsc') -PathType Leaf)) {
        throw 'Existing GMK TypeScript dependencies missing; do not run npm ci against live DLLs'
    }
    if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
        throw 'npm.cmd is unavailable; build prerequisites must be installed before a maintenance drain'
    }
}

# Only called under the durable SQLite drain. Do not touch unowned or in-flight
# Telegram pollers; the existing enrolled task is the sole process boundary.
function Stop-FencedTelegramTask {
    if ((Get-Task).State -eq 'Running') {
        for ($i=0; $i -lt 25; $i++) {
            if (-not (Get-ChannelStatus).pollerPresent) { break }
            Start-Sleep -Seconds 1
        }
        if ((Get-ChannelStatus).pollerPresent) {
            Assert-SafeRestart
            Stop-ScheduledTask -TaskName $taskName
            Wait-ForChannel $false
        }
        for ($i=0; $i -lt 12; $i++) {
            if ((Get-Task).State -ne 'Running') { break }
            Start-Sleep -Seconds 1
        }
        if ((Get-Task).State -eq 'Running') {
            throw 'Old Telegram task did not exit; checkout and drain must remain unchanged'
        }
    } elseif ((Get-ChannelStatus).pollerPresent) {
        throw 'Non-task Telegram poller running; cannot upgrade while another writer owns SQLite'
    }
    if ((Get-ChannelStatus).pollerPresent) {
        throw 'A poller remains present after task exit; refusing to modify the checkout'
    }
}

switch ($Action) {
    'Worker' {
        Assert-Prerequisites
        Assert-InteractiveSession
        if (-not (Test-Path -LiteralPath $tokenFile) -or -not (Test-Path -LiteralPath $settingsFile)) {
            throw 'Owner enrollment missing; no Telegram poller started'
        }
        $owner = Get-Content -LiteralPath $settingsFile -Raw -Encoding utf8 | ConvertFrom-Json
        if ($owner.userId -notmatch '^[1-9]\d*$' -or $owner.chatId -notmatch '^[1-9]\d*$') {
            throw 'Invalid owner allowlist'
        }
        $configuredProxy = [string]($owner.PSObject.Properties['proxyUrl']?.Value)
        if ($configuredProxy) {
            Assert-LocalProxy $configuredProxy
            # Node.js built-in fetch honors these when NODE_USE_ENV_PROXY=1
            # on supported Node 24+ releases. Loopback browser relay remains direct.
            $env:HTTP_PROXY = $configuredProxy
            $env:HTTPS_PROXY = $configuredProxy
            $env:NO_PROXY = 'localhost,127.0.0.1,::1'
            $env:NODE_USE_ENV_PROXY = '1'
        }
        $secure = (Get-Content -LiteralPath $tokenFile -Raw -Encoding utf8).Trim() | ConvertTo-SecureString
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        try { $env:MISSION_RELAY_TELEGRAM_BOT_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
        $env:MISSION_RELAY_TELEGRAM_USER_ID = [string]$owner.userId
        $env:MISSION_RELAY_TELEGRAM_CHAT_ID = [string]$owner.chatId
        try {
            Push-Location $root
            try { & $node $cli telegram; $exitCode = $LASTEXITCODE }
            finally { Pop-Location }
        } finally {
            Remove-Item Env:MISSION_RELAY_TELEGRAM_BOT_TOKEN -ErrorAction SilentlyContinue
            Remove-Item Env:MISSION_RELAY_TELEGRAM_USER_ID -ErrorAction SilentlyContinue
            Remove-Item Env:MISSION_RELAY_TELEGRAM_CHAT_ID -ErrorAction SilentlyContinue
            if ($configuredProxy) {
                Remove-Item Env:HTTP_PROXY,Env:HTTPS_PROXY,Env:NO_PROXY,Env:NODE_USE_ENV_PROXY -ErrorAction SilentlyContinue
            }
        }
        # Unexpected normal process exit is also a failure, eligible for bounded task restart.
        # A cooperative, explicitly fenced maintenance exit must be successful,
        # so Task Scheduler will not immediately restart the old compiled CLI.
        if ($exitCode -eq 0 -and (Get-ChannelStatus).drainRequested) { exit 0 }
        if ($exitCode -ne 0) { exit $exitCode }
        exit 1
    }
    'Enroll' {
        Assert-Prerequisites
        if (Get-Task) { throw 'Task already exists; refusing duplicate enrollment' }
        if ((Get-ChannelStatus).pollerPresent) { throw 'A Telegram poller is already running; stop it before enrolling' }
        if ((Get-ChannelStatus).drainRequested) { throw 'Clear the previous maintenance drain before enrolling' }
        if ((Test-Path $tokenFile) -xor (Test-Path $settingsFile)) {
            throw 'Incomplete credential enrollment; inspect the private folder before retrying'
        }
        if (-not (Test-Path $tokenFile)) {
            $userId = (Read-Host 'Private Telegram owner user ID').Trim()
            $chatId = (Read-Host 'Private Telegram chat ID').Trim()
            if ($userId -notmatch '^[1-9]\d*$' -or $chatId -notmatch '^[1-9]\d*$') { throw 'IDs must be positive numeric values' }
            $token = Read-Host 'Telegram Bot token (entered only in this local terminal)' -AsSecureString
            if ($token.Length -lt 20) { throw 'Bot token is too short' }
            New-Item -ItemType Directory -Force -Path $privateDir | Out-Null
            $acl = Get-Acl -LiteralPath $privateDir
            $acl.SetAccessRuleProtection($true,$false)
            foreach ($sid in @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544')) {
                $identityRef = [Security.Principal.SecurityIdentifier]::new($sid)
                $rule = [Security.AccessControl.FileSystemAccessRule]::new($identityRef,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
                $acl.AddAccessRule($rule)
            }
            Set-Acl -LiteralPath $privateDir -AclObject $acl
            # DPAPI user/machine-bound; no portable plaintext key is stored.
            $token | ConvertFrom-SecureString | Set-Content -LiteralPath $tokenFile -Encoding utf8 -NoNewline
            @{userId=$userId;chatId=$chatId} | ConvertTo-Json -Compress | Set-Content -LiteralPath $settingsFile -Encoding utf8
        } else {
            # Fail early if the current Windows user cannot unlock the old enrollment.
            $null = (Get-Content -LiteralPath $tokenFile -Raw -Encoding utf8).Trim() | ConvertTo-SecureString
        }
        $pwsh = Join-Path $env:ProgramFiles 'PowerShell\7\pwsh.exe'
        $actionArgs = '-NoProfile -NonInteractive -File "' + $PSCommandPath + '" -Action Worker'
        $actionSpec = New-ScheduledTaskAction -Execute $pwsh -Argument $actionArgs -WorkingDirectory $root
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
        $principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
        $trigger = @(New-RecoveryTriggers)
        $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 3 `
            -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) `
            -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
        Register-ScheduledTask -TaskName $taskName -Action $actionSpec -Principal $principal `
            -Trigger $trigger -Settings $settings -Description 'One owner-approved interactive Telegram poller for Mission Relay' | Out-Null
        Write-Output 'User-scoped Telegram task installed. Starting and checking its SQLite lease.'
        Start-ScheduledTask -TaskName $taskName
        Wait-ForChannel $true
        Get-ChannelStatus | Select-Object source,pollerPresent,pollerPid,transportHealth,lastPollSuccessAt,pendingReplies
    }
    'Status' {
        Assert-Prerequisites
        $task = Get-Task
        $channel = Get-ChannelStatus
        [pscustomobject]@{ installed=[bool]$task; taskState=if($task){[string]$task.State}else{'Absent'};
            pollerPresent=$channel.pollerPresent; pollerPid=$channel.pollerPid;
            pendingReplies=$channel.pendingReplies; credentialsEnrolled=((Test-Path $tokenFile) -and (Test-Path $settingsFile));
            transportHealth=$channel.transportHealth; lastPollSuccessAt=$channel.lastPollSuccessAt;
            recoverySchedule=if($task){ [bool](@($task.Triggers | Where-Object { $_.Repetition.Interval -eq 'PT2M' }).Count) }else{$false};
            proxyUrl=if(Test-Path $settingsFile){ [string]((Get-Content $settingsFile -Raw -Encoding utf8 | ConvertFrom-Json).PSObject.Properties['proxyUrl']?.Value) }else{''} }
    }
    'UpgradeSchedule' {
        Assert-Prerequisites
        $task=Assert-OurTask
        $before=Get-ChannelStatus
        if (@($task.Triggers | Where-Object {$_.Repetition.Interval -eq 'PT2M'}).Count -eq 0) {
            Set-ScheduledTask -TaskName $taskName -Trigger @(New-RecoveryTriggers) | Out-Null
        }
        $updated=Assert-OurTask
        if (@($updated.Triggers | Where-Object {$_.Repetition.Interval -eq 'PT2M'}).Count -ne 1 -or
            $updated.Settings.MultipleInstances.ToString() -ne 'IgnoreNew') {
            throw 'Recovery schedule readback failed'
        }
        $after=Get-ChannelStatus
        if ($before.pollerPresent -and
            ((-not $after.pollerPresent) -or $after.pollerPid -ne $before.pollerPid)) {
            throw 'Task schedule update unexpectedly changed the live poller'
        }
        Write-Output 'Daily repeating retry trigger is active; enrolled Telegram poller unchanged.'
    }
    'SetProxy' {
        Assert-Prerequisites
        $null = Assert-OurTask
        Assert-LocalProxy $ProxyUrl
        if (-not (Test-Path -LiteralPath $settingsFile)) { throw 'Owner enrollment is incomplete' }
        $owner=Get-Content -LiteralPath $settingsFile -Raw -Encoding utf8 | ConvertFrom-Json
        $owner | Add-Member -NotePropertyName proxyUrl -NotePropertyValue $ProxyUrl -Force
        $owner | ConvertTo-Json -Compress | Set-Content -LiteralPath $settingsFile -Encoding utf8
        Write-Output 'Private Telegram worker proxy configured; restart the task after the idle preflight to apply it.'
    }
    'ClearProxy' {
        Assert-Prerequisites
        $null = Assert-OurTask
        if (-not (Test-Path -LiteralPath $settingsFile)) { throw 'Owner enrollment is incomplete' }
        $owner=Get-Content -LiteralPath $settingsFile -Raw -Encoding utf8 | ConvertFrom-Json
        $owner.PSObject.Properties.Remove('proxyUrl')
        $owner | ConvertTo-Json -Compress | Set-Content -LiteralPath $settingsFile -Encoding utf8
        Write-Output 'Private Telegram worker proxy removed; restart the task after the idle preflight to apply it.'
    }
    'Start' {
        Assert-Prerequisites
        $null = Assert-OurTask
        if ((Get-ChannelStatus).pollerPresent) { throw 'Telegram poller already present: no second instance started' }
        if ((Get-ChannelStatus).drainRequested) { throw 'Previous maintenance drain still held; inspect channel-drain-status' }
        Start-ScheduledTask -TaskName $taskName
        Wait-ForChannel $true
        Write-Output 'Telegram poller started and lease verified.'
    }
    'Restart' {
        Assert-Prerequisites
        $null = Assert-OurTask
        Assert-SafeRestart
        $exitMode = 'previously stopped'
        if ((Get-Task).State -eq 'Running') {
            $drainId = Request-ChannelDrain
            $exitMode = 'cooperative'
            try {
                # Newer workers exit cooperatively after finishing any accepted
                # work. During the first upgrade from an older worker, only the
                # specifically enrolled Scheduled Task may require Stop.
                for ($i = 0; $i -lt 25; $i++) {
                    if (-not (Get-ChannelStatus).pollerPresent) { break }
                    Start-Sleep -Seconds 1
                }
                if ((Get-ChannelStatus).pollerPresent) {
                    Assert-SafeRestart
                    $exitMode = 'task-scoped fallback for older worker'
                    Stop-ScheduledTask -TaskName $taskName
                    Wait-ForChannel $false
                }
                for ($i = 0; $i -lt 12; $i++) {
                    if ((Get-Task).State -ne 'Running') { break }
                    Start-Sleep -Seconds 1
                }
                if ((Get-Task).State -eq 'Running') {
                    throw 'Old Telegram task has not exited; new worker will not start'
                }
            } finally {
                Release-ChannelDrain $drainId
            }
        } elseif ((Get-ChannelStatus).pollerPresent) {
            throw 'A non-task Telegram poller is running; refusing to terminate it'
        } elseif ((Get-ChannelStatus).drainRequested) {
            throw 'Another maintenance drain remains active; do not start worker'
        }
        Start-ScheduledTask -TaskName $taskName
        Wait-ForChannel $true
        Write-Output ('Telegram task restarted; new PID and healthy Bot API poll verified. Exit mode: ' +
            $exitMode)
    }
    'Upgrade' {
        # A single, explicit pull-only upgrade after the original Send has
        # settled. Never initiate this while Exit 3 blocks maintenance.
        Assert-Prerequisites
        Assert-InteractiveSession
        $null=Assert-OurTask
        Assert-UpgradeTarget $ExpectedSha
        Assert-SafeRestart
        if ((Get-ChannelStatus).drainRequested) {
            throw 'Another maintenance drain is active; refusing duplicate upgrade'
        }
        $oldSha=(& git -C $root rev-parse HEAD | Out-String).Trim()
        if ($LASTEXITCODE -ne 0 -or $oldSha -cnotmatch '^[0-9a-f]{40}$') {
            throw 'Cannot identify an exact rollback commit'
        }
        $drainId=Request-ChannelDrain
        $backup=Join-Path $env:TEMP ('mission-relay-upgrade-' + [guid]::NewGuid().ToString('N'))
        $changedHead=$false
        $completed=$false
        $rollbackSafe=$true
        $workerStopped=$false
        $backupComplete=$false
        $buildStarted=$false
        $oldPid=(Get-ChannelStatus).pollerPid
        try {
            Stop-FencedTelegramTask
            $workerStopped=$true
            New-Item -ItemType Directory -Path $backup -ErrorAction Stop | Out-Null
            Copy-Item -LiteralPath (Join-Path $root 'dist') -Destination (Join-Path $backup 'dist') -Recurse -ErrorAction Stop
            $backupComplete=$true
            & git -C $root fetch origin main
            if ($LASTEXITCODE -ne 0) { throw 'GitHub fetch failed; no pull allowed' }
            $remoteSha=(& git -C $root rev-parse refs/remotes/origin/main | Out-String).Trim()
            if ($LASTEXITCODE -ne 0 -or $remoteSha -cne $ExpectedSha) {
                throw 'Fetched GitHub main does not match the previously verified exact CI SHA'
            }
            & git -C $root merge-base --is-ancestor $oldSha $remoteSha
            if ($LASTEXITCODE -ne 0) { throw 'GMK HEAD cannot fast-forward to reviewed GitHub main' }
            & git -C $root pull --ff-only origin main
            $pullExit=$LASTEXITCODE
            $afterPull=(& git -C $root rev-parse HEAD | Out-String).Trim()
            $changedHead=$afterPull -cne $oldSha
            if ($pullExit -ne 0) { throw 'Fast-forward only GitHub pull failed' }
            if ((& git -C $root rev-parse HEAD | Out-String).Trim() -cne $ExpectedSha) {
                throw 'Post-pull commit does not equal the authorized SHA'
            }
            Push-Location $root
            try {
                $buildStarted=$true
                & npm.cmd run build
                if ($LASTEXITCODE -ne 0) { throw 'GMK TypeScript build failed' }
            }
            finally { Pop-Location }
            Assert-UpgradeTarget $ExpectedSha
            $completed=$true
        } catch {
            # Checkout was clean before drain, so restoring exactly the old
            # reviewed commit + compiled dist is a bounded rollback; no SQLite,
            # credentials or Chrome profile files live in this Git checkout.
            if ($changedHead) {
                $head=(& git -C $root rev-parse HEAD | Out-String).Trim()
                if ($head -cne $ExpectedSha) { $rollbackSafe=$false }
                else {
                    $unexpectedChanges=(& git -C $root status --porcelain=v1 --untracked-files=all | Out-String).Trim()
                    if ($LASTEXITCODE -ne 0 -or $unexpectedChanges) { $rollbackSafe=$false }
                    else {
                        & git -C $root reset --hard $oldSha
                        if ($LASTEXITCODE -ne 0) { $rollbackSafe=$false }
                    }
                }
            }
            if ($buildStarted) {
                if ($rollbackSafe) {
                    if (-not $backupComplete) { $rollbackSafe=$false }
                    else {
                    try {
                        Remove-Item -LiteralPath (Join-Path $root 'dist') -Recurse -Force -ErrorAction Stop
                        Copy-Item -LiteralPath (Join-Path $backup 'dist') -Destination (Join-Path $root 'dist') -Recurse -ErrorAction Stop
                    } catch { $rollbackSafe=$false }
                    }
                }
            }
            if (-not $rollbackSafe) { throw 'Upgrade failed; rollback did not verify. Drain remains held; do not restart' }
            throw
        } finally {
            if ($rollbackSafe) {
                Release-ChannelDrain $drainId
                if ($workerStopped -and (Get-Task).State -ne 'Running') {
                    Start-ScheduledTask -TaskName $taskName
                }
                if ($workerStopped -or (Get-ChannelStatus).pollerPresent) {
                    Wait-ForChannel $true
                }
                if (Test-Path -LiteralPath $backup) {
                    Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction SilentlyContinue
                }
            }
        }
        if (-not $completed) { throw 'Upgrade was not completed; original runtime restored' }
        $nowSha=(& git -C $root rev-parse HEAD | Out-String).Trim()
        if ($nowSha -cne $ExpectedSha) { throw 'Healthy worker but wrong checkout SHA; inspect before resuming PI' }
        $current=(Get-ChannelStatus)
        if ($oldPid -and $current.pollerPid -eq $oldPid) {
            throw 'Upgrade did not replace the original worker PID; do not resume Mission'
        }
        if ($ResumeMissionId) {
            # This is a *previously owner-paused* exact observed PI checkpoint.
            # pi-resume has its own transactional SHA/owner/revision gates;
            # no browser Send occurs here. The running worker rechecks Chrome.
            $state=(& $node $cli show $ResumeMissionId | Out-String | ConvertFrom-Json)
            if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect owner-paused Mission for post-upgrade resume' }
            & $node $cli pi-resume $ResumeMissionId --revision ([string]$state.version) --acknowledge-side-effects | Out-Null
            if ($LASTEXITCODE -ne 0) { throw 'Upgrade is active but PI checkpoint did not pass its resume gate' }
        }
        Write-Output ('GMK pull-only upgrade verified at ' + $nowSha + '; healthy single Telegram poller')
    }
    'Remove' {
        $null = Assert-OurTask
        Assert-SafeRestart
        if ((Get-Task).State -eq 'Running') {
            Stop-ScheduledTask -TaskName $taskName
            Wait-ForChannel $false
        }
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        Write-Output 'Scheduled task removed. Encrypted credential files were preserved; revoke the token separately if necessary.'
    }
}
