# Optional Windows interactive-user lifecycle for the Mission Relay Telegram poller.
# No task or credentials are created until the owner runs -Action Enroll locally.
param(
    [ValidateSet('Enroll','Worker','Status','Start','Restart','SetProxy','ClearProxy','Remove')]
    [string]$Action = 'Status',
    [string]$ProxyUrl = ''
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

function Get-ChannelStatus {
    $text = (& $node $cli channel-status | Out-String)
    if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect Telegram channel state' }
    return ($text | ConvertFrom-Json)
}

function Get-Task {
    return Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
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

switch ($Action) {
    'Worker' {
        Assert-Prerequisites
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
        if ($exitCode -ne 0) { exit $exitCode }
        exit 1
    }
    'Enroll' {
        Assert-Prerequisites
        if (Get-Task) { throw 'Task already exists; refusing duplicate enrollment' }
        if ((Get-ChannelStatus).pollerPresent) { throw 'A Telegram poller is already running; stop it before enrolling' }
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
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
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
            proxyUrl=if(Test-Path $settingsFile){ [string]((Get-Content $settingsFile -Raw -Encoding utf8 | ConvertFrom-Json).PSObject.Properties['proxyUrl']?.Value) }else{''} }
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
        Start-ScheduledTask -TaskName $taskName
        Wait-ForChannel $true
        Write-Output 'Telegram poller started and lease verified.'
    }
    'Restart' {
        Assert-Prerequisites
        $null = Assert-OurTask
        Assert-SafeRestart
        if ((Get-Task).State -eq 'Running') {
            Stop-ScheduledTask -TaskName $taskName
            Wait-ForChannel $false
        } elseif ((Get-ChannelStatus).pollerPresent) {
            throw 'A non-task Telegram poller is running; refusing to terminate it'
        }
        Start-ScheduledTask -TaskName $taskName
        Wait-ForChannel $true
        Write-Output 'Telegram task restarted; new PID and SQLite lease verified.'
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
