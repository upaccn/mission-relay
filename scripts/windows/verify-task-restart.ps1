# Owner-host acceptance test for Windows Task Scheduler automatic retries.
# Synthetic isolated task only: never touches the real Telegram task or secrets.
param(
    [int]$TimeoutSeconds = 115,
    [ValidateSet('Repeating','Scheduled','Manual')][string]$StartMode = 'Repeating'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Windows Task Scheduler acceptance requires Windows' }
if ($TimeoutSeconds -lt 70 -or $TimeoutSeconds -gt 180) { throw 'Timeout must be 70 to 180 seconds' }

$id = [Guid]::NewGuid().ToString('N').Substring(0,12)
$name = "MissionRelay-SchedulerProbe-$id"
$directory = Join-Path $env:TEMP $name
$worker = Join-Path $directory 'worker.ps1'
New-Item -ItemType Directory -Path $directory | Out-Null
$created = $false
try {
    @'
param([string]$Directory)
$first = Join-Path $Directory 'first'
$success = Join-Path $Directory 'restarted'
if (-not (Test-Path -LiteralPath $first)) {
    [DateTime]::UtcNow.ToString('o') | Set-Content -LiteralPath $first
    exit 23
}
[DateTime]::UtcNow.ToString('o') | Set-Content -LiteralPath $success
exit 0
'@ | Set-Content -LiteralPath $worker -Encoding utf8
    $pwsh = Join-Path $env:ProgramFiles 'PowerShell\7\pwsh.exe'
    $username = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $principal = New-ScheduledTaskPrincipal -UserId $username -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 2 `
        -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Minutes 4)
    # Test the actual scheduled trigger separately from Start-ScheduledTask:
    # Task Scheduler's retry policy can differ across these launch paths.
    $triggerTime = if($StartMode -ne 'Manual') {
        (Get-Date).AddSeconds(12)
    } else {
        (Get-Date).AddDays(1)
    }
    $trigger = if($StartMode -eq 'Repeating') {
        $daily=New-ScheduledTaskTrigger -Daily -At $triggerTime
        $template=New-ScheduledTaskTrigger -Once -At $triggerTime `
            -RepetitionInterval (New-TimeSpan -Minutes 1) `
            -RepetitionDuration (New-TimeSpan -Minutes 4)
        $daily.Repetition=$template.Repetition
        $daily
    } else { New-ScheduledTaskTrigger -Once -At $triggerTime }
    $arguments = '-NoProfile -NonInteractive -File "' + $worker + '" -Directory "' + $directory + '"'
    $action = New-ScheduledTaskAction -Execute $pwsh -Argument $arguments -WorkingDirectory $directory
    Register-ScheduledTask -TaskName $name -Principal $principal -Settings $settings `
        -Trigger $trigger -Action $action | Out-Null
    $created = $true
    if($StartMode -eq 'Manual') { Start-ScheduledTask -TaskName $name }
    $observedFailure = $false
    $recovered = $false
    for ($i=0; $i -lt $TimeoutSeconds; $i++) {
        if (Test-Path -LiteralPath (Join-Path $directory 'first')) { $observedFailure=$true }
        if (Test-Path -LiteralPath (Join-Path $directory 'restarted')) { $recovered=$true; break }
        Start-Sleep -Seconds 1
    }
    $taskInfo = Get-ScheduledTaskInfo -TaskName $name
    $result=[pscustomobject]@{
        isolatedTask=$true
        launchMode=$StartMode
        failedFirstAttempt=$observedFailure
        scheduledRetryObserved=$recovered
        firstResult=if ($observedFailure) {23} else {$null}
        secondResult=if ($recovered) {0} else {$null}
        schedulerLastResult=$taskInfo.LastTaskResult
        timeoutSeconds=$TimeoutSeconds
    }
    $result | ConvertTo-Json -Compress
    if (-not $observedFailure -or -not $recovered) { throw 'Isolated Windows Scheduler restart behavior did not pass' }
} finally {
    if ($created) {
        Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $directory -Recurse -Force -ErrorAction SilentlyContinue
}
