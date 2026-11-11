# Optional Windows interactive-user lifecycle for the Mission Relay Telegram poller.
# No task or credentials are created until the owner runs -Action Enroll locally.
param(
    [ValidateSet('Enroll','Worker','Status','Start','Restart','Upgrade','Compatibility','UpgradeSchedule','HideWorker','SetProxy','ClearProxy','Remove')]
    [string]$Action = 'Status',
    [string]$ProxyUrl = '',
    [string]$ExpectedSha = '',
    [string]$ResumeMissionId = '',
    # One-time, explicitly selected history cutover after the public repository
    # is rebuilt as a parentless clean release root. Existing workers stay
    # fenced, backup/restore and rollback are identical to a normal upgrade.
    [switch]$HistoryReset,
    # One-time bootstrap of Upgrade from an exact reviewed GitHub script
    # while an older pull-only GMK checkout still lacks this action.
    [string]$BootstrapRoot = '',
    # Explicit owner authorization for the one known pre-fenced GMK version.
    # Never auto-select this recovery mode from a model or version mismatch.
    [switch]$LegacyMigration
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [Console]::InputEncoding = [System.Text.UTF8Encoding]::new()

$taskName = 'MissionRelay-Telegram'
if ($BootstrapRoot -and $Action -notin @('Upgrade','Compatibility')) {
    throw 'BootstrapRoot is permitted only for reviewed Upgrade or read-only Compatibility'
}
if ($LegacyMigration -and ($Action -notin @('Upgrade','Compatibility') -or -not $BootstrapRoot)) {
    throw 'Legacy migration requires an exact reviewed bootstrap outside the checkout'
}
if ($HistoryReset -and $Action -ne 'Upgrade') {
    throw 'HistoryReset requires an explicit guarded Upgrade action'
}
$root = if ($BootstrapRoot) {
    (Resolve-Path -LiteralPath $BootstrapRoot -ErrorAction Stop).Path
} else {
    (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
}
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

# A PID alone is not a process identity: after an abrupt exit Windows can
# reuse it while the original SQLite lease and short-lived poll proof remain.
# Independently inspect the actual Node child and enrolled PowerShell parent.
# Missing or inaccessible WMI process data must fail closed for ReleaseProbes.
function Get-WorkerProcessIdentity([int]$workerPid) {
    if ($workerPid -le 0) { return $null }
    try {
        $worker=Get-CimInstance Win32_Process -Filter "ProcessId = $workerPid" -ErrorAction Stop
        if (-not $worker -or -not $worker.ParentProcessId) { return $null }
        $parent=Get-CimInstance Win32_Process -Filter "ProcessId = $($worker.ParentProcessId)" -ErrorAction Stop
        if (-not $parent) { return $null }
        $expectedScript=[IO.Path]::GetFullPath((Join-Path $root 'scripts\windows\telegram-task.ps1'))
        $expectedPwsh=[IO.Path]::GetFullPath((Join-Path $env:ProgramFiles 'PowerShell\7\pwsh.exe'))
        # Compare the complete canonical invocation, not a substring that
        # could be embedded inside Node -e or another PowerShell script path.
        # The existing enrolled action uses the exact quote/argument order.
        $childPattern='(?i)^"?'+[regex]::Escape([IO.Path]::GetFullPath($node))+'"?\s+"?'+[regex]::Escape([IO.Path]::GetFullPath($cli))+'"?\s+telegram\s*$'
        $parentPattern='(?i)^"?'+[regex]::Escape($expectedPwsh)+'"?\s+(?:-WindowStyle\s+Hidden\s+)?-NoProfile\s+-NonInteractive\s+-File\s+"'+[regex]::Escape($expectedScript)+'"\s+-Action\s+Worker\s*$'
        if ([IO.Path]::GetFullPath([string]$worker.ExecutablePath) -ine [IO.Path]::GetFullPath($node) -or
            [IO.Path]::GetFullPath([string]$parent.ExecutablePath) -ine $expectedPwsh -or
            [string]$worker.CommandLine -notmatch $childPattern -or
            [string]$parent.CommandLine -notmatch $parentPattern) { return $null }
        $started=([datetime]$worker.CreationDate).ToUniversalTime()
        $parentStarted=([datetime]$parent.CreationDate).ToUniversalTime()
        if ($parentStarted -ge $started) { return $null }
        return [pscustomobject]@{ startedAt=$started.ToString('o');
            parentStartedAt=$parentStarted.ToString('o') }
    } catch { return $null }
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
    # Check the canonical *enrolled worker* path, never the maintainer's
    # temporary Upgrade bootstrap path. The latter must not replace or launch
    # the registered Worker or create a second poller.
    $expected = [IO.Path]::GetFullPath((Join-Path $root 'scripts\windows\telegram-task.ps1'))
    $legacyWorkerArgs = '-NoProfile -NonInteractive -File "' + $expected + '" -Action Worker'
    $workerArgs = '-WindowStyle Hidden ' + $legacyWorkerArgs
    $workerExe = [IO.Path]::GetFullPath((Join-Path $env:ProgramFiles 'PowerShell\7\pwsh.exe'))
    $actions = @($task.Actions)
    if ($actions.Count -ne 1 -or
        [string]$actions[0].Arguments -cnotin @($workerArgs,$legacyWorkerArgs) -or
        [IO.Path]::GetFullPath([string]$actions[0].Execute) -ine $workerExe -or
        [IO.Path]::GetFullPath([string]$actions[0].WorkingDirectory) -ine $root) {
        throw 'Existing task action, executable or workspace differs from the single enrolled Worker; refusing lifecycle changes'
    }
    if (-not $task.Principal.UserId -or
        [string]$task.Principal.LogonType -ne 'Interactive' -or
        [string]$task.Principal.RunLevel -ne 'Limited') {
        throw 'Scheduled Task must remain interactive-user and least-privilege; refusing lifecycle changes'
    }
    $taskSid = ([Security.Principal.NTAccount]::new([string]$task.Principal.UserId)).Translate([Security.Principal.SecurityIdentifier]).Value
    if ($taskSid -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) {
        throw 'Scheduled Task belongs to a different Windows account; do not run maintenance under an unrelated identity'
    }
    if ([string]$task.Settings.MultipleInstances -ne 'IgnoreNew') {
        throw 'Scheduled Task must remain single-instance (IgnoreNew); refusing lifecycle changes'
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

function Release-VerifiedChannelDrain([string]$drainId,[string]$sha,[int]$workerPid,
    [string]$attestedAt) {
    # Atomic SQLite admission checks the most recent transport probe, original
    # channel lease, target runtime SHA, empty request queue and exact token.
    # It cannot release maintenance based on an earlier healthy sample.
    if ($attestedAt -cnotmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$') {
        throw 'Final release requires a nonempty precise UTC Worker attestation'
    }
    # Use one explicit native argument vector: an accidentally dropped trailing
    # timestamp must never silently turn a verified admission into a raw release.
    $releaseArgs = @($cli,'channel-drain-release-verified','--id',$drainId,
        '--expected-sha',$sha,'--expected-pid',([string]$workerPid),
        '--expected-attested-at',$attestedAt)
    $null = & $node @releaseArgs
    if ($LASTEXITCODE -ne 0) {
        throw 'Final atomic Worker/source/transport verification refused maintenance release'
    }
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
        throw 'GMK checkout has local changes; source must be reconciled in operator-managed host before upgrade'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $root 'node_modules\typescript\bin\tsc') -PathType Leaf)) {
        throw 'Existing GMK TypeScript dependencies missing; do not run npm ci against live DLLs'
    }
    if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
        throw 'npm.cmd is unavailable; build prerequisites must be installed before a maintenance drain'
    }
}

function Assert-ReviewedBootstrapScript([string]$sha) {
    if (-not $BootstrapRoot) { return }
    # The temporary script MUST be byte-identical to the reviewed target
    # commit. PowerShell 7.4+ preserves native stdout bytes on file redirect.
    # A missing local target object fails before any drain or task action.
    $blob = Join-Path $env:TEMP ('mission-relay-reviewed-upgrade-' + [guid]::NewGuid().ToString('N') + '.ps1')
    try {
        & git -C $root show "${sha}:scripts/windows/telegram-task.ps1" > $blob
        if ($LASTEXITCODE -ne 0) { throw 'Reviewed bootstrap script is not present in the local Git object database' }
        $actual=(Get-FileHash -Algorithm SHA256 -LiteralPath $PSCommandPath).Hash
        $reviewed=(Get-FileHash -Algorithm SHA256 -LiteralPath $blob).Hash
        if ($actual -cne $reviewed) {
            throw 'Temporary bootstrap script does not match the exact reviewed GitHub commit'
        }
    } finally {
        if (Test-Path -LiteralPath $blob) {
            Remove-Item -LiteralPath $blob -Force -ErrorAction SilentlyContinue
        }
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

# The audit lives outside the pull-only checkout. Each append is synchronously
# flushed and hash-linked. This documents only NEW deployments; it never
# backfills older upgrades or exposes prompt text, tokens or ChatGPT URLs.
$script:upgradeAuditDir = ''
$script:upgradeAuditLog = ''
$script:upgradeAuditLastHash = ''
$script:upgradeAuditSequence = 0

function Hash-UpgradeEvidence([string]$text) {
    $sha=[Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($text))
    return [Convert]::ToHexString($sha).ToLowerInvariant()
}

function Write-UpgradeEvidence([string]$stage,[hashtable]$details=@{}) {
    if (-not $script:upgradeAuditLog) { throw 'Upgrade evidence journal was not initialized' }
    $payload=[ordered]@{sequence=++$script:upgradeAuditSequence;
        at=[DateTime]::UtcNow.ToString('o');stage=$stage;
        previousSha256=$script:upgradeAuditLastHash;details=$details}
    $canonical=$payload | ConvertTo-Json -Compress -Depth 8
    $hash=Hash-UpgradeEvidence $canonical
    $record=(@{payload=$canonical;sha256=$hash} | ConvertTo-Json -Compress) + "`n"
    $stream=[IO.FileStream]::new($script:upgradeAuditLog,
        [IO.FileMode]::Append,[IO.FileAccess]::Write,[IO.FileShare]::Read)
    try {
        $bytes=[Text.Encoding]::UTF8.GetBytes($record)
        $stream.Write($bytes,0,$bytes.Length)
        $stream.Flush($true)
    } finally { $stream.Dispose() }
    $script:upgradeAuditLastHash=$hash
}

function New-UpgradeEvidence([string]$fromSha,[string]$toSha,[int]$previousPid) {
    $folder=Join-Path $privateDir ('upgrade-audit-' + [guid]::NewGuid().ToString('D'))
    New-Item -ItemType Directory -Path $folder -ErrorAction Stop | Out-Null
    # The parent contains DPAPI owner credentials; an audit must not broaden
    # its ACL or be stored in the public checkout or temporary build tree.
    $acl=Get-Acl -LiteralPath $folder
    $acl.SetAccessRuleProtection($true,$false)
    foreach ($sid in @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544')) {
        $rule=[Security.AccessControl.FileSystemAccessRule]::new(
            [Security.Principal.SecurityIdentifier]::new($sid),'FullControl',
            'ContainerInherit,ObjectInherit','None','Allow')
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $folder -AclObject $acl
    $script:upgradeAuditDir=$folder
    $script:upgradeAuditLog=Join-Path $folder 'receipts.jsonl'
    $script:upgradeAuditSequence=0
    $script:upgradeAuditLastHash=''
    $bootstrapHash=if ($BootstrapRoot) {
        (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()
    } else { '' }
    Write-UpgradeEvidence 'intent' @{fromSha=$fromSha;toSha=$toSha;oldWorkerPid=$previousPid;
        taskName=$taskName;source='github-main-pull-only';
        legacyMigration=[bool]$LegacyMigration;historyReset=[bool]$HistoryReset;
        bootstrapScriptSha256=$bootstrapHash}
}

function Assert-AuditPreflight {
    $dbFile=Join-Path $env:LOCALAPPDATA 'MissionRelay\missions.sqlite'
    $out=(& $node (Join-Path $root 'scripts\windows\telegram-restart-check.mjs') $dbFile 2>&1 | Out-String).Trim()
    $exitCode=$LASTEXITCODE
    Write-UpgradeEvidence 'preflight' @{exitCode=$exitCode;message=$out;
        channel=(Get-ChannelStatus | Select-Object pollerPid,pollerPresent,transportHealth,
            pendingReplies,notificationsCursor,lastEventId)}
    if ($exitCode -ne 0) { throw 'Evidence preflight did not authorize maintenance' }
}

function Backup-FencedSQLite {
    if (-not (Get-ChannelStatus).drainRequested) {
        throw 'An SQLite recovery checkpoint requires the existing maintenance drain'
    }
    $dbFile=Join-Path $env:LOCALAPPDATA 'MissionRelay\missions.sqlite'
    $snapshot=Join-Path $script:upgradeAuditDir 'missions.sqlite'
    $code=@'
const {DatabaseSync,backup}=require('node:sqlite');
const {readFileSync}=require('node:fs');
const {createHash}=require('node:crypto');
(async()=>{
 const original=new DatabaseSync(process.argv[1],{readOnly:true});
 original.exec('PRAGMA query_only=ON');
 try{await backup(original,process.argv[2])}finally{original.close()}
 const db=new DatabaseSync(process.argv[2],{readOnly:true});
 db.exec('PRAGMA query_only=ON');
 const integrity=db.prepare('PRAGMA integrity_check').get().integrity_check;
 const events=db.prepare('SELECT count(*) AS count,max(id) AS maxId FROM events').get();
 const missions=db.prepare('SELECT count(*) AS count FROM missions').get().count;
 const reservations=db.prepare("SELECT count(*) AS count FROM meta WHERE key LIKE 'chatgpt.browser.active.%' AND json_extract(value,'$.status')='reserved'").get().count;
 db.close();
 if(integrity!=='ok'||reservations!==0)throw Error('Recovery snapshot failed idle integrity gates');
 console.log(JSON.stringify({sha256:createHash('sha256').update(readFileSync(process.argv[2])).digest('hex'),integrity,events,missions,reservations}));
})().catch(e=>{console.error('SQLite recovery checkpoint could not be verified');process.exitCode=2});
'@
    $raw=(& $node -e $code $dbFile $snapshot | Out-String)
    if ($LASTEXITCODE -ne 0) { throw 'Private drained SQLite snapshot failed' }
    $proof=$raw | ConvertFrom-Json
    if ($proof.sha256 -notmatch '^[a-f0-9]{64}$' -or $proof.integrity -ne 'ok') {
        throw 'Drained database backup proof invalid'
    }
    Write-UpgradeEvidence 'sqlite_backup' @{sha256=$proof.sha256;integrity=$proof.integrity;
        missions=$proof.missions;events=$proof.events;reserved=$proof.reservations}
}

# Prove that the drained backup actually restores to a distinct private
# SQLite file BEFORE Git checkout/build changes. Never restore into the live
# database, and never treat a checksum or synthetic test as a recovery drill.
function Verify-IsolatedSQLiteRestore {
    if (-not (Get-ChannelStatus).drainRequested) {
        throw 'Isolated SQLite recovery requires the original maintenance drain'
    }
    $snapshot=Join-Path $script:upgradeAuditDir 'missions.sqlite'
    $restored=Join-Path $script:upgradeAuditDir 'isolated-restore.sqlite'
    $code=@'
const {DatabaseSync,backup}=require('node:sqlite');
const {readFileSync}=require('node:fs');
const {createHash}=require('node:crypto');
const hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
const tables=db=>db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").all();
(async()=>{
 const source=new DatabaseSync(process.argv[1],{readOnly:true});
 source.exec('PRAGMA query_only=ON');
 try{await backup(source,process.argv[2])}finally{source.close()}
 const a=new DatabaseSync(process.argv[1],{readOnly:true});
 const b=new DatabaseSync(process.argv[2],{readOnly:true});
 try{
  for(const db of [a,b]){
   db.exec('PRAGMA query_only=ON');
   if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok'||
      db.prepare('PRAGMA foreign_key_check').all().length)throw Error('Recovery integrity invalid');
  }
  const original=tables(a),recovered=tables(b);
  if(JSON.stringify(original)!==JSON.stringify(recovered))throw Error('Recovery schema differs');
  for(const {name} of original){
   const table='"'+name.replaceAll('"','""')+'"';
   if(JSON.stringify(a.prepare('SELECT * FROM '+table).all())!==
      JSON.stringify(b.prepare('SELECT * FROM '+table).all()))
    throw Error('Recovery row continuity differs');
  }
 }finally{a.close();b.close()}
 console.log(JSON.stringify({backupSha256:hash(process.argv[1]),
  restoredSha256:hash(process.argv[2]),integrity:'ok',foreignKeyViolations:0}));
})().catch(()=>{console.error('Isolated SQLite backup recovery could not be verified');process.exitCode=2});
'@
    $raw=(& $node -e $code $snapshot $restored | Out-String)
    if ($LASTEXITCODE -ne 0) { throw 'Isolated production backup restoration failed; leave source unchanged' }
    $proof=$raw | ConvertFrom-Json
    $actual=(Get-FileHash -Algorithm SHA256 -LiteralPath $snapshot).Hash.ToLowerInvariant()
    if ($proof.backupSha256 -cne $actual -or $proof.restoredSha256 -notmatch '^[a-f0-9]{64}$' -or
        $proof.integrity -ne 'ok' -or $proof.foreignKeyViolations -ne 0) {
        throw 'Isolated SQLite restoration is not bound to the drained source snapshot'
    }
    Write-UpgradeEvidence 'sqlite_restore_verified' @{backupSha256=$proof.backupSha256;
        restoredSha256=$proof.restoredSha256;integrity=$proof.integrity;foreignKeyViolations=0}
}

# Before modifying the Git checkout, independently hash EVERY file in the
# rollback dist copy against the original Worker-verified compiled tree. The
# copied tree must be usable even if npm build partially overwrites dist.
function Assert-CompiledRollbackCopy([string]$source,[string]$copy,
    [string]$expectedSha,[string]$expectedTree,[string]$expectedManifestSha256='') {
    $original=Get-ChildItem -LiteralPath $source -Recurse -File -ErrorAction Stop |
        ForEach-Object { [pscustomobject]@{name=[IO.Path]::GetRelativePath($source,$_.FullName).Replace('\','/');
            hash=(Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLowerInvariant()} } |
        Sort-Object name
    $recovered=Get-ChildItem -LiteralPath $copy -Recurse -File -ErrorAction Stop |
        ForEach-Object { [pscustomobject]@{name=[IO.Path]::GetRelativePath($copy,$_.FullName).Replace('\','/');
            hash=(Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLowerInvariant()} } |
        Sort-Object name
    $manifest=Get-Content -LiteralPath (Join-Path $copy 'build-provenance.json') -Raw -Encoding utf8 | ConvertFrom-Json
    $manifestHash=(Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $copy 'build-provenance.json')).Hash.ToLowerInvariant()
    $originalJson=ConvertTo-Json -InputObject @($original) -Compress -Depth 4
    $copyJson=ConvertTo-Json -InputObject @($recovered) -Compress -Depth 4
    $js=@($recovered | Where-Object { $_.name.EndsWith('.js') })
    $treeText=(@($js | ForEach-Object { $_.name + [char]0 + $_.hash + "`n" }) -join '')
    $actualTree=Hash-UpgradeEvidence $treeText
    if (@($original).Count -lt 2 -or $originalJson -cne $copyJson -or
        $manifest.sourceSha -cne $expectedSha -or
        $manifest.treeSha256 -cne $expectedTree -or
        $actualTree -cne $expectedTree -or
        @($js).Count -ne $manifest.fileCount -or
        -not (@($js | Where-Object { $_.name -ceq 'cli.js' }).Count -eq 1) -or
        $manifest.cliSha256 -cne @($js | Where-Object { $_.name -ceq 'cli.js' })[0].hash -or
        ($expectedManifestSha256 -and $manifestHash -cne $expectedManifestSha256) -or
        $manifest.fileCount -lt 1) {
        throw 'Compiled rollback copy differs from original verified Worker bytes'
    }
    return @{verified=$true;previousSha=$expectedSha;
        compiledTreeSha256=$expectedTree;copiedBytesSha256=(Hash-UpgradeEvidence $copyJson);
        fileCount=@($recovered).Count}
}

# A prior Worker WITHOUT the fenced-startup implementation would immediately
# exit when restarted behind the held drain. Refuse that unsafe upgrade BEFORE
# requesting maintenance, rather than discover an unrecoverable rollback only
# after stopping the original production Worker. Byte-verify the entire old
# compiled image against its actual leased Worker identity first.
function Assert-RollbackStandbyCapability([string]$sha,$runtime) {
    $dist=Join-Path $root 'dist'
    $proof=Assert-CompiledRollbackCopy $dist $dist $sha `
        $runtime.compiledTreeSha256 $runtime.manifestSha256
    $module=Join-Path $dist 'plugins\telegram.js'
    if (-not (Test-Path -LiteralPath $module -PathType Leaf)) {
        throw 'Legacy rollback Worker lacks drain-fenced startup support; upgrade refused before maintenance'
    }
    $code=[IO.File]::ReadAllText($module)
    $canStartFenced=$code.Contains('probeFencedTelegramTransport') -and
        $code.Contains('startedInsideDrain')
    # Rollback restores the OLD compiled CLI before releasing the held drain.
    # It too must provide the same atomic SHA/PID/health admission command;
    # otherwise the rollback would strand a healthy Worker behind the fence.
    $oldCli=[IO.File]::ReadAllText((Join-Path $dist 'cli.js'))
    if ($canStartFenced -and $oldCli.Contains('channel-drain-release-verified')) {
        if ($LegacyMigration) {
            throw 'LegacyMigration was requested for a modern fenced Worker; refuse ambiguous migration before drain'
        }
        return @{previousSha=$sha;originalTreeSha256=$runtime.compiledTreeSha256;
            verified=$true;compiledFiles=$proof.fileCount;mode='fenced'}
    }
    # The actual deployed pre-fenced revision can only restart AFTER its
    # original drain is released. Constrain this exception to its independently
    # observed compiled bytes, source SHA, reviewed bootstrap and explicit
    # operator selection. No other old build inherits the exception.
    $legacySha='df3044eb2dc787236391918c2b7730b9b9407b8b'
    $legacyCli='6801cca587e12482fb638ee9b864493346e5b12d0c1b1bb8dee719bdd85e73b6'
    $legacyModule='520f4bba184a207853a6d4104754cb5930fe7ac4af5f6fad8d1a85a84967ebb5'
    $actualCli=(Get-FileHash -LiteralPath (Join-Path $dist 'cli.js') -Algorithm SHA256).Hash.ToLowerInvariant()
    $actualModule=(Get-FileHash -LiteralPath $module -Algorithm SHA256).Hash.ToLowerInvariant()
    if (-not $LegacyMigration -or -not $BootstrapRoot -or
        $sha -cne $legacySha -or $actualCli -cne $legacyCli -or
        $actualModule -cne $legacyModule -or $canStartFenced -or
        $code.Contains('startedInsideDrain') -or
        $code.Contains('probeFencedTelegramTransport') -or
        $oldCli.Contains('channel-drain-release-verified') -or
        -not $oldCli.Contains('channel-drain-release')) {
        throw 'Legacy rollback is not the explicitly authorized, byte-matched deployed version; upgrade refused before maintenance'
    }
    return @{previousSha=$sha;originalTreeSha256=$runtime.compiledTreeSha256;
        verified=$true;compiledFiles=$proof.fileCount;
        mode='legacy-release-before-start';legacyCliSha256=$actualCli;
        legacyModuleSha256=$actualModule}
}

function Verify-UpgradeSQLiteContinuity {
    $dbFile=Join-Path $env:LOCALAPPDATA 'MissionRelay\missions.sqlite'
    $snapshot=Join-Path $script:upgradeAuditDir 'missions.sqlite'
    $code=@'
const {DatabaseSync}=require('node:sqlite');
const {createHash}=require('node:crypto');
const prior=new DatabaseSync(process.argv[1],{readOnly:true});
const live=new DatabaseSync(process.argv[2],{readOnly:true});
prior.exec('PRAGMA query_only=ON');live.exec('PRAGMA query_only=ON');
try{
 const ceiling=prior.prepare('SELECT COALESCE(MAX(id),0) AS n FROM events').get().n;
 const oldEvents=prior.prepare('SELECT * FROM events ORDER BY id').all();
 const nowEvents=live.prepare('SELECT * FROM events WHERE id<=? ORDER BY id').all(ceiling);
 const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
 const oldMissionRows=prior.prepare('SELECT * FROM missions ORDER BY id').all();
 const liveMissionRows=live.prepare('SELECT * FROM missions ORDER BY id').all();
 const oldMissions=new Set(oldMissionRows.map(r=>r.id));
 const currentMissions=new Set(liveMissionRows.map(r=>r.id));
 const oldRequests=prior.prepare("SELECT key,value FROM meta WHERE key LIKE 'chatgpt.browser.active.%' ORDER BY key").all();
 const liveRequests=live.prepare("SELECT key,value FROM meta WHERE key LIKE 'chatgpt.browser.active.%' ORDER BY key").all();
 const integrity=live.prepare('PRAGMA integrity_check').get().integrity_check;
 const foreignKeyViolations=live.prepare('PRAGMA foreign_key_check').all().length;
 const matches=digest(oldEvents)===digest(nowEvents);
 const missionsUnchanged=digest(oldMissionRows)===digest(liveMissionRows);
 const requestsUnchanged=digest(oldRequests)===digest(liveRequests);
 const missing=[...oldMissions].filter(id=>!currentMissions.has(id)).length;
 if(!matches||missing||!missionsUnchanged||!requestsUnchanged||
    integrity!=='ok'||foreignKeyViolations)throw Error('SQLite event/Mission/request continuity failed');
 console.log(JSON.stringify({integrity,historicalEventRows:oldEvents.length,
   historicalEventSha256:digest(oldEvents),historicalRowsUnchanged:matches,
   historicalMissionIds:oldMissions.size,missingMissionIds:missing,
   missionRowsSha256:digest(oldMissionRows),missionsUnchanged,
   requestReceiptsSha256:digest(oldRequests),requestsUnchanged,foreignKeyViolations,
   newEventHighWater:live.prepare('SELECT COALESCE(MAX(id),0) AS n FROM events').get().n}));
}finally{prior.close();live.close()}
'@
    $raw=(& $node -e $code $snapshot $dbFile | Out-String)
    if ($LASTEXITCODE -ne 0) { throw 'Post-deployment SQLite historical continuity check failed' }
    $proof=$raw | ConvertFrom-Json
    if (-not $proof.historicalRowsUnchanged -or -not $proof.missionsUnchanged -or
        -not $proof.requestsUnchanged -or $proof.foreignKeyViolations -ne 0 -or
        $proof.missingMissionIds -ne 0 -or $proof.integrity -ne 'ok') {
        throw 'Post-deployment SQLite integrity and historical preservation not verified'
    }
    Write-UpgradeEvidence 'sqlite_continuity_verified' @{integrity=$proof.integrity;
        originalEvents=$proof.historicalEventRows;originalMissions=$proof.historicalMissionIds;
        eventsSha256=$proof.historicalEventSha256;newHighWater=$proof.newEventHighWater;
        missionRowsSha256=$proof.missionRowsSha256;
        requestsSha256=$proof.requestReceiptsSha256;foreignKeyViolations=0}
}

# Called while the ORIGINAL drain is held. The replacement is allowed to
# acquire the single SQLite lease and perform transport-only health polling,
# but cannot accept Telegram commands, PI work or any browser Send until the
# upgraded source, compiled tree, owner task and SQLite have been verified.
function Assert-FencedWorker([string]$expectedSha,[int]$previousPid) {
    $channel=Get-ChannelStatus
    $task=Assert-OurTask
    $head=(& git -C $root rev-parse HEAD | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $head -cne $expectedSha -or
        -not $channel.drainRequested -or -not $channel.pollerPresent -or
        $channel.pollerPid -eq $previousPid -or
        $channel.transportHealth -ne 'healthy' -or
        $channel.pendingReplies -ne 0 -or
        $channel.notificationsCursor -ne $channel.lastEventId -or
        $task.State -ne 'Running') {
        throw 'Fenced Worker identity, idle state or health could not be verified'
    }
    $manifest=Get-Content -LiteralPath (Join-Path $root 'dist\build-provenance.json') -Raw -Encoding utf8 | ConvertFrom-Json
    $actual= $channel.runtimeProvenance
    $manifestHash=(Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $root 'dist\build-provenance.json')).Hash.ToLowerInvariant()
    $cliHash=(Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $root 'dist\cli.js')).Hash.ToLowerInvariant()
    $mismatch = [System.Collections.Generic.List[string]]::new()
    if (-not $actual) { $mismatch.Add('runtime_provenance_missing') }
    else {
        if ($actual.pid -ne $channel.pollerPid) { $mismatch.Add('runtime_pid') }
        if ($actual.sourceSha -cne $expectedSha) { $mismatch.Add('runtime_source_sha') }
        if ($actual.compiledTreeSha256 -cne $manifest.treeSha256) { $mismatch.Add('runtime_tree_sha') }
        if ($actual.cliSha256 -cne $manifest.cliSha256) { $mismatch.Add('runtime_cli_sha') }
        if ($actual.cliSha256 -cne $cliHash) { $mismatch.Add('compiled_cli_file_sha') }
        if ($actual.manifestSha256 -cne $manifestHash) { $mismatch.Add('runtime_manifest_sha') }
        if ($actual.fileCount -ne $manifest.fileCount) { $mismatch.Add('runtime_file_count') }
    }
    if ($manifest.sourceSha -cne $expectedSha) { $mismatch.Add('manifest_source_sha') }
    if ($mismatch.Count -gt 0) {
        throw ('Fenced Worker loaded source or compiled bytes differ from the reviewed SHA: ' + ($mismatch -join ','))
    }
    return $channel
}

# The pinned legacy Worker cannot be started while the drain is held. Only
# the exceptional rollback path calls this AFTER releasing the original
# token, and only after restoring and verifying the complete old image and
# drained SQLite snapshot. Its result is never a fenced-startup receipt.
function Assert-LegacyRollbackWorker([string]$expectedSha,[int]$previousPid,
    [string]$expectedTree) {
    $channel=Get-ChannelStatus
    $task=Assert-OurTask
    $head=(& git -C $root rev-parse HEAD | Out-String).Trim()
    $manifest=Get-Content -LiteralPath (Join-Path $root 'dist\build-provenance.json') -Raw -Encoding utf8 | ConvertFrom-Json
    $compiled= $channel.runtimeProvenance
    if ($LASTEXITCODE -ne 0 -or $head -cne $expectedSha -or
        $manifest.sourceSha -cne $expectedSha -or
        $manifest.treeSha256 -cne $expectedTree -or
        -not $channel.pollerPresent -or $channel.drainRequested -or
        $channel.pollerPid -eq $previousPid -or
        $channel.pendingReplies -ne 0 -or
        $channel.transportHealth -ne 'healthy' -or
        $task.State -ne 'Running' -or
        -not $compiled -or $compiled.pid -ne $channel.pollerPid -or
        $compiled.sourceSha -cne $expectedSha -or
        $compiled.compiledTreeSha256 -cne $expectedTree -or
        $compiled.cliSha256 -cne $manifest.cliSha256) {
        throw 'Legacy post-release rollback Worker identity or health is not independently verified'
    }
    return $channel
}

function Test-UpgradeEvidence {
    $last=''
    $index=0
    foreach ($line in [IO.File]::ReadAllLines($script:upgradeAuditLog)) {
        $record=$line | ConvertFrom-Json
        $payload=$record.payload | ConvertFrom-Json
        $index++
        if ($payload.sequence -ne $index -or $payload.previousSha256 -cne $last -or
            $record.sha256 -cne (Hash-UpgradeEvidence $record.payload)) {
            throw 'Private upgrade evidence chain verification failed'
        }
        $last=$record.sha256
    }
    if ($index -ne $script:upgradeAuditSequence -or
        $last -cne $script:upgradeAuditLastHash) {
        throw 'Private upgrade evidence journal was truncated or replaced'
    }
}

switch ($Action) {
    'Compatibility' {
        # Source-only readback; safe even while a protected Mission is live.
        # A positive result is NOT a restart/preflight/drain authorization.
        Assert-Prerequisites
        $null=Assert-OurTask
        Assert-UpgradeTarget $ExpectedSha
        Assert-ReviewedBootstrapScript $ExpectedSha
        $oldSha=(& git -C $root rev-parse HEAD | Out-String).Trim()
        $status=Get-ChannelStatus
        $runtime=$status.runtimeProvenance
        if (-not $status.pollerPresent -or -not $runtime -or
            $runtime.pid -ne $status.pollerPid -or
            $runtime.sourceSha -cne $oldSha) {
            throw 'Read-only compatibility cannot identify the unique running original Worker'
        }
        $proof=Assert-RollbackStandbyCapability $oldSha $runtime
        [pscustomobject]@{result='COMPATIBLE_SOURCE_ONLY_NOT_MAINTENANCE';
            oldSha=$oldSha;candidateSha=$ExpectedSha;
            oldPid=$status.pollerPid;rollback=$proof} | ConvertTo-Json -Depth 5
    }
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
        $actionArgs = '-WindowStyle Hidden -NoProfile -NonInteractive -File "' + $PSCommandPath + '" -Action Worker'
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
        # Read-only identity validation is part of release evidence. Mere
        # existence of a similarly named task must never certify the Worker.
        $taskVerified = $false
        if ($task) { $null = Assert-OurTask; $taskVerified = $true }
        $channel = Get-ChannelStatus
        $workerProcess=if ($channel.pollerPresent -and $channel.pollerPid) {
            Get-WorkerProcessIdentity ([int]$channel.pollerPid)
        } else { $null }
        [pscustomobject]@{ installed=[bool]$task; taskState=if($task){[string]$task.State}else{'Absent'};
            taskVerified=$taskVerified;
            pollerPresent=$channel.pollerPresent; pollerPid=$channel.pollerPid;
            workerProcessVerified=[bool]$workerProcess;
            workerProcessStartedAt=if($workerProcess){$workerProcess.startedAt}else{$null};
            workerParentStartedAt=if($workerProcess){$workerProcess.parentStartedAt}else{$null};
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
    'HideWorker' {
        # Changing the registered action does not stop a running Worker.
        # A later operator-initiated, idle-gated Restart is required to hide
        # the *already open* console; future starts use the hidden action.
        Assert-Prerequisites
        $task=Assert-OurTask
        Assert-SafeRestart
        if ((Get-ChannelStatus).drainRequested) {
            throw 'Cannot change scheduled action during maintenance'
        }
        $before=Get-ChannelStatus
        $workerArgs='-WindowStyle Hidden -NoProfile -NonInteractive -File "' +
            [IO.Path]::GetFullPath((Join-Path $root 'scripts\windows\telegram-task.ps1')) + '" -Action Worker'
        if ([string]$task.Actions[0].Arguments -cne $workerArgs) {
            $exe=Join-Path $env:ProgramFiles 'PowerShell\7\pwsh.exe'
            $newAction=New-ScheduledTaskAction -Execute $exe -Argument $workerArgs -WorkingDirectory $root
            Set-ScheduledTask -TaskName $taskName -Action $newAction | Out-Null
        }
        $updated=Assert-OurTask
        if ([string]$updated.Actions[0].Arguments -cne $workerArgs) {
            throw 'Hidden worker startup action could not be independently read back'
        }
        $after=Get-ChannelStatus
        if ($before.pollerPresent -and
            (-not $after.pollerPresent -or $after.pollerPid -ne $before.pollerPid)) {
            throw 'Scheduled action update unexpectedly restarted the active Worker'
        }
        Write-Output 'Hidden Telegram Worker startup verified; perform a separately idle-gated Restart to close any existing console.'
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
        # settled. Never initiate this while Exit 3 blocks maintenance. The
        # maintenance CLI may run in Session 0: it NEVER launches Chrome,
        # and starts only the enrolled INTERACTIVE task whose Worker itself
        # rejects Session 0 before touching credentials or the browser.
        Assert-Prerequisites
        $null=Assert-OurTask
        Assert-UpgradeTarget $ExpectedSha
        Assert-ReviewedBootstrapScript $ExpectedSha
        # Only this maintenance process inherits the already-approved local
        # loopback proxy. Never change machine Git config, the checked-out
        # source or the running Worker. Remote fetch/pull otherwise fails on
        # GMK hosts whose GitHub access requires the local SOCKS listener.
        if (Test-Path -LiteralPath $settingsFile) {
            $settings=Get-Content -LiteralPath $settingsFile -Raw -Encoding utf8 | ConvertFrom-Json
            $localProxy=[string]($settings.PSObject.Properties['proxyUrl']?.Value)
            if ($localProxy) {
                Assert-LocalProxy $localProxy
                if ($env:GIT_CONFIG_COUNT) {
                    throw 'Existing process-scoped Git overrides must be inspected before upgrade'
                }
                $proxyPort=([Uri]$localProxy).Port
                $env:GIT_CONFIG_COUNT='1'
                $env:GIT_CONFIG_KEY_0='http.proxy'
                $env:GIT_CONFIG_VALUE_0='socks5h://127.0.0.1:'+$proxyPort
            }
        }
        Assert-SafeRestart
        if ((Get-ChannelStatus).drainRequested) {
            throw 'Another maintenance drain is active; refusing duplicate upgrade'
        }
        $oldSha=(& git -C $root rev-parse HEAD | Out-String).Trim()
        if ($LASTEXITCODE -ne 0 -or $oldSha -cnotmatch '^[0-9a-f]{40}$') {
            throw 'Cannot identify an exact rollback commit'
        }
        $oldChannel=Get-ChannelStatus
        $oldPid=$oldChannel.pollerPid
        $oldRuntime=$oldChannel.runtimeProvenance
        if (-not $oldRuntime -or $oldRuntime.sourceSha -cne $oldSha -or
            $oldRuntime.pid -ne $oldPid -or
            $oldRuntime.compiledTreeSha256 -notmatch '^[a-f0-9]{64}$') {
            throw 'Old Worker has no independently verified compiled rollback identity'
        }
        $oldRollbackCapability=Assert-RollbackStandbyCapability $oldSha $oldRuntime
        New-UpgradeEvidence $oldSha $ExpectedSha ([int]$oldPid)
        Write-UpgradeEvidence 'rollback_capability_verified' $oldRollbackCapability
        Assert-AuditPreflight
        $drainId=Request-ChannelDrain
        $actualDrain=(& $node $cli channel-drain-status | Out-String | ConvertFrom-Json)
        if ($LASTEXITCODE -ne 0 -or -not $actualDrain.requested -or
            [string]$actualDrain.drainId -cne $drainId) {
            throw 'Maintenance drain readback mismatched its original receipt; leave it fenced'
        }
        Write-UpgradeEvidence 'drain_acquired' @{drainIdSha256=(Hash-UpgradeEvidence $drainId);
            confirmedRequested=$true;oldWorkerPid=$oldPid}
        # Retain the byte-verified previous compiled runtime with this private
        # journal. The ReleaseProbe must independently inspect the REAL rollback
        # image; a deleted temporary folder is not rollback-ready evidence.
        $backup=Join-Path $script:upgradeAuditDir 'rollback'
        $changedHead=$false
        $workerStopped=$false
        $backupComplete=$false
        $buildStarted=$false
        $newWorkerStarted=$false
        try {
            Stop-FencedTelegramTask
            $workerStopped=$true
            Write-UpgradeEvidence 'worker_stopped' @{oldWorkerPid=$oldPid;pollerPresent=$false}
            Backup-FencedSQLite
            Verify-IsolatedSQLiteRestore
            New-Item -ItemType Directory -Path $backup -ErrorAction Stop | Out-Null
            Copy-Item -LiteralPath (Join-Path $root 'dist') -Destination (Join-Path $backup 'dist') -Recurse -ErrorAction Stop
            $rollbackReceipt=Assert-CompiledRollbackCopy (Join-Path $root 'dist') `
                (Join-Path $backup 'dist') $oldSha $oldRuntime.compiledTreeSha256 $oldRuntime.manifestSha256
            $backupComplete=$true
            Write-UpgradeEvidence 'compiled_rollback_saved' $rollbackReceipt
            & git -C $root fetch origin main
            if ($LASTEXITCODE -ne 0) { throw 'GitHub fetch failed; no pull allowed' }
            $remoteSha=(& git -C $root rev-parse refs/remotes/origin/main | Out-String).Trim()
            if ($LASTEXITCODE -ne 0 -or $remoteSha -cne $ExpectedSha) {
                throw 'Fetched GitHub main does not match the previously verified exact CI SHA'
            }
            Write-UpgradeEvidence 'source_verified' @{fetchedSha=$remoteSha;expectedSha=$ExpectedSha}
            if ($HistoryReset) {
                # Refuse arbitrary non-fast-forward updates. A root commit is
                # the only permitted new history, and its exact GitHub main
                # identity was checked above before modifying the checkout.
                $parentRecord=(& git -C $root rev-list --parents -n 1 $remoteSha | Out-String).Trim()
                if ($LASTEXITCODE -ne 0 -or $parentRecord -cne $remoteSha) {
                    throw 'HistoryReset requires the exact verified parentless release commit'
                }
                & git -C $root reset --hard $remoteSha
            } else {
                & git -C $root merge-base --is-ancestor $oldSha $remoteSha
                if ($LASTEXITCODE -ne 0) { throw 'GMK HEAD cannot fast-forward to reviewed GitHub main' }
                & git -C $root pull --ff-only origin main
            }
            $pullExit=$LASTEXITCODE
            $afterPull=(& git -C $root rev-parse HEAD | Out-String).Trim()
            $changedHead=$afterPull -cne $oldSha
            if ($pullExit -ne 0) { throw 'Fast-forward only GitHub pull failed' }
            if ((& git -C $root rev-parse HEAD | Out-String).Trim() -cne $ExpectedSha) {
                throw 'Post-pull commit does not equal the authorized SHA'
            }
            $checkoutMethod=if($HistoryReset){'verified-parentless-root-reset'}else{'pull --ff-only origin main'}
            Write-UpgradeEvidence 'checkout_updated' @{newSha=$ExpectedSha;previousSha=$oldSha;
                method=$checkoutMethod}
            Push-Location $root
            try {
                $buildStarted=$true
                & npm.cmd run build
                if ($LASTEXITCODE -ne 0) { throw 'GMK TypeScript build failed' }
            }
            finally { Pop-Location }
            Assert-UpgradeTarget $ExpectedSha
            $built=Get-Content -LiteralPath (Join-Path $root 'dist\build-provenance.json') -Raw -Encoding utf8 | ConvertFrom-Json
            if ($built.sourceSha -cne $ExpectedSha -or $built.treeSha256 -notmatch '^[0-9a-f]{64}$') {
                throw 'Built runtime manifest does not match reviewed Git SHA'
            }
            Write-UpgradeEvidence 'compiled' @{sourceSha=$built.sourceSha;
                compiledTreeSha256=$built.treeSha256;cliSha256=$built.cliSha256}
            # Task Scheduler's two-minute recovery trigger can restart the
            # ORIGINAL compiled Worker after worker_stopped but before this
            # fetch/build finishes. IgnoreNew would then discard our explicit
            # Start-ScheduledTask and the stale Worker would attest the old
            # source SHA under this drain (observed TaskScheduler 107/322).
            # Reap only the enrolled task while the original SQLite drain is
            # still held. A trigger after this point loads the NEW compiled
            # image, so it cannot recreate the stale-source race.
            $prelaunch=Get-ChannelStatus
            if ($prelaunch.pollerPresent -or (Get-Task).State -eq 'Running') {
                Stop-FencedTelegramTask
                Write-UpgradeEvidence 'prelaunch_recovery_worker_cleared' @{
                    previousPid=$prelaunch.pollerPid;drainHeld=$true}
            }
            # A Worker started behind the original drain may acquire only its
            # single channel lease and probe Telegram transport. It cannot
            # consume messages, resume PI, or send to Chrome until release.
            $newWorkerStarted=$true
            Start-ScheduledTask -TaskName $taskName
            Wait-ForChannel $true
            # A newly started fenced Worker can report healthy transport before
            # its initial runtime attestation is visible to a separate CLI.
            # Retry only a compiled/source readback mismatch for a strictly
            # bounded period; all other failed identity gates reject at once.
            $current=$null
            for ($readbackAttempt=0; $readbackAttempt -lt 3; $readbackAttempt++) {
                try {
                    $current=Assert-FencedWorker $ExpectedSha ([int]$oldPid)
                    break
                } catch {
                    if ($readbackAttempt -ge 2 -or
                        $_.Exception.Message -notlike 'Fenced Worker loaded source or compiled bytes differ*') {
                        throw
                    }
                    Start-Sleep -Milliseconds 750
                }
            }
            Write-UpgradeEvidence 'worker_healthy' @{pid=$current.pollerPid;
                transportHealth=$current.transportHealth;fenced=$true;
                notificationsCursor=$current.notificationsCursor;lastEventId=$current.lastEventId}
            Write-UpgradeEvidence 'runtime_verified' @{pid=$current.pollerPid;
                sourceSha=$current.runtimeProvenance.sourceSha;
                compiledTreeSha256=$current.runtimeProvenance.compiledTreeSha256;
                fenced=$true}
            Verify-UpgradeSQLiteContinuity
            if ($ResumeMissionId) {
                # An explicitly authorized pause may be resumed only after
                # the ORIGINAL Chrome binding is inspected under the drain.
                # A failed binding must roll back BEFORE PI can schedule work.
                $browser=(& $node $cli browser-binding-health $ResumeMissionId | Out-String | ConvertFrom-Json)
                if ($LASTEXITCODE -ne 0 -or $browser.binding -ne 'exact_connected' -or
                    $browser.matchingLinkedTabs -ne 1) {
                    throw 'Original PI Chrome tab is not independently verified before maintenance release'
                }
                Write-UpgradeEvidence 'chrome_binding_readback' @{missionId=$ResumeMissionId;
                    binding=$browser.binding;enabledChatTabs=$browser.enabledChatTabs;
                    matchingLinkedTabs=$browser.matchingLinkedTabs;fenced=$true}
            }
            Assert-SafeRestart
            Write-UpgradeEvidence 'fenced_acceptance_verified' @{sha=$ExpectedSha;
                pid=$current.pollerPid;drainHeld=$true;rollbackVerified=$rollbackReceipt.verified}
            Test-UpgradeEvidence
        } catch {
            $failure=$_.Exception.Message
            $rollbackDrainReleased=$false
            # Do not release the drain in a finally block: even a failed
            # startup, SHA or SQLite check must first restore verified bytes.
            # All recovery steps remain behind the SAME atomic fence.
            try {
                Write-UpgradeEvidence 'upgrade_failed' @{changedHead=$changedHead;
                    workerStopped=$workerStopped;buildStarted=$buildStarted;
                    newWorkerStarted=$newWorkerStarted}
                Stop-FencedTelegramTask
                if ($changedHead) {
                    $head=(& git -C $root rev-parse HEAD | Out-String).Trim()
                    if ($LASTEXITCODE -ne 0 -or $head -cne $ExpectedSha) {
                        throw 'Changed Git HEAD is not the expected candidate; refusing destructive rollback'
                    }
                    $unexpectedChanges=(& git -C $root status --porcelain=v1 --untracked-files=all | Out-String).Trim()
                    if ($LASTEXITCODE -ne 0 -or $unexpectedChanges) {
                        throw 'Unexpected GMK checkout changes; refusing destructive rollback'
                    }
                    & git -C $root reset --hard $oldSha
                    if ($LASTEXITCODE -ne 0) { throw 'Failed to restore the original Git HEAD' }
                }
                if ($buildStarted) {
                    if (-not $backupComplete) { throw 'Compiled rollback image was not verified' }
                    Remove-Item -LiteralPath (Join-Path $root 'dist') -Recurse -Force -ErrorAction Stop
                    Copy-Item -LiteralPath (Join-Path $backup 'dist') -Destination (Join-Path $root 'dist') -Recurse -ErrorAction Stop
                }
                $restoredSha=(& git -C $root rev-parse HEAD | Out-String).Trim()
                $restoredChanges=(& git -C $root status --porcelain=v1 --untracked-files=all | Out-String).Trim()
                if ($LASTEXITCODE -ne 0 -or $restoredSha -cne $oldSha -or $restoredChanges) {
                    throw 'Restored Git checkout does not equal clean original SHA'
                }
                $restoredDist=if($backupComplete){Join-Path $backup 'dist'}else{Join-Path $root 'dist'}
                $rollbackProof=Assert-CompiledRollbackCopy $restoredDist `
                    (Join-Path $root 'dist') $oldSha $oldRuntime.compiledTreeSha256 $oldRuntime.manifestSha256
                Verify-UpgradeSQLiteContinuity
                if ($oldRollbackCapability.mode -eq 'legacy-release-before-start') {
                    # Legacy startup inside the original drain is impossible.
                    # Verify all rollback bytes and SQLite history first. The
                    # enrolled single Worker then starts only AFTER the
                    # original legacy CLI atomically removes the drain token.
                    # This is not equivalent to verified fenced admission:
                    # record both phases separately and check actual health.
                    Assert-SafeRestart
                    $held=(& $node $cli channel-drain-status | Out-String | ConvertFrom-Json)
                    if ($LASTEXITCODE -ne 0 -or -not $held.requested -or
                        [string]$held.drainId -cne $drainId -or $held.pollerPresent) {
                        throw 'Legacy rollback cannot safely release the original drain'
                    }
                    Write-UpgradeEvidence 'legacy_rollback_pre_release_verified' @{
                        restoredSha=$oldSha;compiledTreeSha256=$rollbackProof.compiledTreeSha256;
                        copiedBytesSha256=$rollbackProof.copiedBytesSha256;
                        originalDrainHeld=$true;oldWorkerStopped=$true}
                    Test-UpgradeEvidence
                    Write-UpgradeEvidence 'legacy_rollback_release_requested' @{
                        drainIdSha256=(Hash-UpgradeEvidence $drainId);restoredSha=$oldSha}
                    Release-ChannelDrain $drainId
                    $rollbackDrainReleased=$true
                    Write-UpgradeEvidence 'legacy_rollback_drain_released' @{
                        confirmed=$true;restoredSha=$oldSha}
                    Start-ScheduledTask -TaskName $taskName
                    Wait-ForChannel $true
                    $restored=Assert-LegacyRollbackWorker $oldSha ([int]$oldPid) $rollbackProof.compiledTreeSha256
                    Verify-UpgradeSQLiteContinuity
                    Write-UpgradeEvidence 'rollback_verified' @{
                        restoredSha=$oldSha;restoredPid=$restored.pollerPid;
                        compiledTreeSha256=$rollbackProof.compiledTreeSha256;
                        copiedBytesSha256=$rollbackProof.copiedBytesSha256;
                        fenced=$false;legacyPostReleaseRestart=$true}
                    Test-UpgradeEvidence
                } else {
                    # Modern rollback is atomically verified under the drain.
                    Start-ScheduledTask -TaskName $taskName
                    Wait-ForChannel $true
                    $restored=Assert-FencedWorker $oldSha ([int]$oldPid)
                    Write-UpgradeEvidence 'rollback_verified' @{restoredSha=$oldSha;
                        restoredPid=$restored.pollerPid;compiledTreeSha256=$rollbackProof.compiledTreeSha256;
                        copiedBytesSha256=$rollbackProof.copiedBytesSha256;
                        fenced=$true}
                    Assert-SafeRestart
                    Test-UpgradeEvidence
                    Write-UpgradeEvidence 'drain_release_requested' @{drainIdSha256=(Hash-UpgradeEvidence $drainId);
                        restoredSha=$oldSha}
                    Release-VerifiedChannelDrain $drainId $oldSha ([int]$restored.pollerPid) (([datetime]$restored.runtimeProvenance.at).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ'))
                    $rollbackDrainReleased=$true
                    Write-UpgradeEvidence 'drain_released' @{confirmed=$true;restoredSha=$oldSha}
                    Test-UpgradeEvidence
                }
            } catch {
                # A failed rollback (including an unverified journal) must
                # NEVER remove a still-held fence or start an unverified Worker.
                # If the release itself succeeded, do not falsely claim that
                # maintenance remains held or interrupt newly admitted work.
                if ($rollbackDrainReleased) {
                    throw ('Drain was already released during rollback; Worker health or audit is not certified. ' +
                        'Do not interrupt new work or force-settle requests. '+$_.Exception.Message)
                }
                $status=Get-ChannelStatus
                if (-not $status.drainRequested) {
                    throw ('Rollback release outcome is uncertain; no safe automatic interruption is permitted. '+
                        $_.Exception.Message)
                }
                throw ('Upgrade failed; rollback not independently verified. Maintenance remains fenced. ' +
                    $_.Exception.Message)
            }
            throw ('Upgrade failed; original source, compiled Worker and SQLite restored and verified: '+$failure)
        }
        # The only remaining action allowed to admit new work is releasing
        # the original drain AFTER every mandatory startup, SHA and SQLite
        # check plus its hash-linked audit have passed under the fence.
        Write-UpgradeEvidence 'drain_release_requested' @{drainIdSha256=(Hash-UpgradeEvidence $drainId);
            sourceSha=$ExpectedSha}
        Test-UpgradeEvidence
        Release-VerifiedChannelDrain $drainId $ExpectedSha ([int]$current.pollerPid) (([datetime]$current.runtimeProvenance.at).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ'))
        Write-UpgradeEvidence 'drain_released' @{confirmed=$true;sourceSha=$ExpectedSha}
        Test-UpgradeEvidence
        if ($ResumeMissionId) {
            # This is a *previously owner-paused* exact observed PI checkpoint.
            # pi-resume has its own transactional SHA/owner/revision gates;
            # no browser Send occurs here. The running worker rechecks Chrome.
            $state=(& $node $cli show $ResumeMissionId | Out-String | ConvertFrom-Json)
            if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect owner-paused Mission for post-upgrade resume' }
            & $node $cli pi-resume $ResumeMissionId --revision ([string]$state.version) --acknowledge-side-effects | Out-Null
            if ($LASTEXITCODE -ne 0) { throw 'Upgrade is active but PI checkpoint did not pass its resume gate' }
            Write-UpgradeEvidence 'pi_resume_verified' @{missionId=$ResumeMissionId;result='released'}
        }
        Write-UpgradeEvidence 'complete' @{sha=$ExpectedSha;pid=$current.pollerPid;result='healthy'}
        Test-UpgradeEvidence
        Write-Output ('GMK pull-only upgrade verified at ' + $ExpectedSha + '; healthy single Telegram poller')
        Write-Output ('Private maintenance evidence: ' + $script:upgradeAuditDir)
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
