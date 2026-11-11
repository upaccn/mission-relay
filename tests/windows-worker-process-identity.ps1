# Isolated PowerShell 7 behavior test. Never imports the lifecycle script's
# top-level enrollment/task actions or accesses a production process/database.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$source=Join-Path $root 'scripts\windows\telegram-task.ps1'
$node=Join-Path $env:USERPROFILE 'scoop\apps\nodejs-lts\current\node.exe'
$cli=Join-Path $root 'dist\cli.js'
$expectedScript=[IO.Path]::GetFullPath($source)
$expectedPwsh=[IO.Path]::GetFullPath((Join-Path $env:ProgramFiles 'PowerShell\7\pwsh.exe'))
$tokens=$null
$errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile($source,[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw "Invalid PowerShell syntax: $($errors|Out-String)" }
$fn=$ast.Find({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $n.Name -eq 'Get-WorkerProcessIdentity'},$true)
if (-not $fn) { throw 'Missing real Worker process identity function' }
Invoke-Expression $fn.Extent.Text

$script:worker=[pscustomobject]@{ ParentProcessId=40920;
    ExecutablePath=$node;
    CommandLine=('"'+$node+'" "'+$cli+'" telegram');
    CreationDate=[datetime]'2026-11-11T07:57:05.895257+08:00' }
$script:parent=[pscustomobject]@{ ExecutablePath=$expectedPwsh;
    CommandLine=('"'+$expectedPwsh+'" -NoProfile -NonInteractive -File "'+$expectedScript+'" -Action Worker');
    CreationDate=[datetime]'2026-11-11T07:57:05.306316+08:00' }

function Get-CimInstance {
    [CmdletBinding()]
    param([Parameter(Position=0)][string]$ClassName,[string]$Filter)
    if ($ClassName -ne 'Win32_Process') { throw 'Unexpected CIM class' }
    switch ($Filter) {
        'ProcessId = 12345' { return $script:worker }
        'ProcessId = 40920' { return $script:parent }
        default { throw 'Unexpected CIM query' }
    }
}
function Assert-Refused([string]$scenario) {
    if (Get-WorkerProcessIdentity 12345) { throw "Unsafe Worker identity accepted: $scenario" }
}
$proof=Get-WorkerProcessIdentity 12345
if (-not $proof -or -not $proof.startedAt -or -not $proof.parentStartedAt -or
    ([datetime]$proof.parentStartedAt) -gt ([datetime]$proof.startedAt)) {
    throw 'Legitimate canonical Worker process and parent were rejected'
}
$goodChild=$script:worker.CommandLine
$goodParent=$script:parent.CommandLine
$goodCreated=$script:worker.CreationDate
$script:worker.CommandLine='"'+$node+'" -e "console.log('+$cli+')" telegram'
Assert-Refused 'Node -e contains the expected CLI substring'
$script:worker.CommandLine='"'+$node+'" "'+$cli+'.evil" telegram'
Assert-Refused 'CLI substring collision'
$script:worker.CommandLine=$goodChild+' extra'
Assert-Refused 'unexpected trailing Node argument'
$script:worker.CommandLine=$goodChild
$script:parent.CommandLine=$goodParent.Replace($expectedScript,$expectedScript+'.evil')
Assert-Refused 'Worker script substring collision'
$script:parent.CommandLine=$goodParent+' extra'
Assert-Refused 'unexpected trailing PowerShell argument'
$script:parent.CommandLine=$goodParent
$script:worker.CreationDate=[datetime]'2026-11-11T07:57:04+08:00'
Assert-Refused 'task parent created after Node child'
$script:worker.CreationDate=$goodCreated
$script:parent=$null
Assert-Refused 'missing parent process metadata'
Write-Output 'PASS: real PowerShell Worker identity helper accepted exact launch and rejected six hostile/missing cases'
