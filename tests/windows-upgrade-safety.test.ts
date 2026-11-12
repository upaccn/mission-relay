import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';

const path=resolve('scripts/windows/telegram-task.ps1');
const script=readFileSync(path,'utf8');

test('two-minute Windows recovery schedule never stops a live Mission at the daily repetition boundary',()=>{
  const triggers=script.slice(script.indexOf('function New-RecoveryTriggers {'),
    script.indexOf('function Assert-OurTask {'));
  assert.match(triggers,/-RepetitionInterval \(New-TimeSpan -Minutes 2\)/);
  assert.match(triggers,/-RepetitionDuration \(New-TimeSpan -Days 1\)/);
  assert.match(triggers,/\$daily\.Repetition\.StopAtDurationEnd=\$false/,
    'Windows defaults to true, which killed the enrolled Worker at 00:04 on consecutive days');
  const migrate=script.slice(script.indexOf("    'UpgradeSchedule' {"),
    script.indexOf("    'HideWorker' {"));
  assert.match(migrate,/Assert-OurTask/);
  assert.match(migrate,/\$task\.Triggers[\s\S]*?StopAtDurationEnd -eq \$false/,
    'A legacy task with the two-minute trigger but StopAtDurationEnd=true MUST be updated');
  assert.match(migrate,/Set-ScheduledTask -TaskName \$taskName -Trigger @\(New-RecoveryTriggers\)/);
  assert.match(migrate,/\$updated\.Triggers[\s\S]*?StopAtDurationEnd -eq \$false/,
    'Do not claim schedule migration without reading back the corrected stop policy');
  assert.match(migrate,/\$after\.pollerPid -ne \$before\.pollerPid/,
    'Changing the trigger must not claim success if the active Worker was interrupted');
  assert.doesNotMatch(migrate,/Stop-ScheduledTask|Start-ScheduledTask|Remove-ScheduledTask|git\s|npm\s/);
  const status=script.slice(script.indexOf("    'Status' {"),
    script.indexOf("    'UpgradeSchedule' {"));
  assert.match(status,/StopAtDurationEnd -eq \$false/,
    'Status must report a dangerous legacy schedule as unhealthy');
});

test('Windows lifecycle PowerShell parses without errors before production enrollment',
  {skip:process.platform!=='win32'},()=>{
    const quote=(s:string)=>`'${s.replaceAll("'","''")}'`;
    const code=`$tokens=$null;$errors=$null;[System.Management.Automation.Language.Parser]::ParseFile(${quote(path)},[ref]$tokens,[ref]$errors)|Out-Null;if($errors.Count -gt 0){$errors|ForEach-Object{Write-Error $_.Message};exit 2};Write-Output 'PARSER_OK'`;
    const result=spawnSync('pwsh',['-NoProfile','-NonInteractive','-Command',code],
      {encoding:'utf8',timeout:15000});
    assert.equal(result.status,0,result.stderr+' '+result.stdout);
    assert.match(result.stdout,/PARSER_OK/);
  });

test('project-history reset is explicit, fenced, backup-first and cannot silently re-enroll',
  ()=>{
    const start=script.indexOf("    'ResetProjects' {");
    const end=script.indexOf("    'Compatibility' {",start);
    assert.ok(start>0&&end>start,'ResetProjects must be an isolated owner action');
    const reset=script.slice(start,end);
    assert.match(reset,/\$ConfirmResetProjects/);
    assert.match(reset,/Assert-SafeRestart/);
    assert.match(reset,/Request-ChannelDrain/);
    assert.match(reset,/Stop-FencedTelegramTask/);
    assert.match(reset,/Disable-ScheduledTask/);
    assert.match(reset,/Backup-FencedSQLite/);
    assert.match(reset,/Verify-IsolatedSQLiteRestore/);
    assert.match(reset,/--reset \$dbFile \$drainId/);
    assert.match(reset,/--verify \$dbFile \$drainId/);
    assert.match(reset,/Assert-FencedWorker/);
    assert.match(reset,/Release-VerifiedChannelDrain/);
    assert.match(reset,/Copy-Item -LiteralPath \$snapshot -Destination \$dbFile -Force/);
    assert.ok(reset.indexOf('Backup-FencedSQLite')<reset.indexOf('--reset $dbFile'),
      'Destructive reset must occur only after a verified backup');
    assert.ok(reset.indexOf('Assert-FencedWorker')<reset.indexOf('Release-VerifiedChannelDrain'),
      'A healthy attested replacement must precede maintenance admission');
    assert.doesNotMatch(reset,/git -C \$root reset|Register-ScheduledTask|browser-send/);
  });

test('copied rollback bytes must match original compiled JS and manifest before upgrade',
  {skip:process.platform!=='win32'},()=>{
    const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
    const old='a'.repeat(40),fixture=mkdtempSync(join(tmpdir(),'mr-rollback-'));
    try{
      const source=join(fixture,'source'),copy=join(fixture,'copy');
      mkdirSync(source);mkdirSync(copy);
      const js='console.log("synthetic rollback fixture");\n';
      const tree=sha('cli.js\0'+sha(js)+'\n');
      const manifest=JSON.stringify({format:1,sourceSha:old,treeSha256:tree,
        cliSha256:sha(js),fileCount:1})+'\n';
      for(const dir of [source,copy]){
        writeFileSync(join(dir,'cli.js'),js);
        writeFileSync(join(dir,'build-provenance.json'),manifest);
      }
      const start=script.indexOf('function Hash-UpgradeEvidence(');
      const end=script.indexOf('\nfunction Write-UpgradeEvidence',start);
      const helper=script.indexOf('function Assert-CompiledRollbackCopy(');
      const helperEnd=script.indexOf('\nfunction Verify-UpgradeSQLiteContinuity',helper);
      assert.ok(start>0&&end>start&&helper>end&&helperEnd>helper);
      const quote=(s:string)=>`'${s.replaceAll("'","''")}'`;
      const commands=[script.slice(start,end),script.slice(helper,helperEnd),
        `$proof=Assert-CompiledRollbackCopy ${quote(source)} ${quote(copy)} '${old}' '${tree}'`,
        `if(-not $proof.verified -or $proof.fileCount -ne 2){throw 'Rollback copy not verified'}`,
        `Set-Content -LiteralPath ${quote(join(copy,'cli.js'))} -Value 'modified'`,
        `try { $null=Assert-CompiledRollbackCopy ${quote(source)} ${quote(copy)} '${old}' '${tree}'; throw 'Corrupt copy accepted' }`,
        `catch { if ($_.Exception.Message -notlike '*rollback copy differs*'){throw} }`,
        "Write-Output 'verified-rollback-fixture-pass'",
      ].join('\n');
      const run=spawnSync('pwsh',['-NoProfile','-NonInteractive','-Command',commands],
        {encoding:'utf8',timeout:15000});
      assert.equal(run.status,0,run.stderr+' '+run.stdout);
      assert.match(run.stdout,/verified-rollback-fixture-pass/);
    }finally{rmSync(fixture,{recursive:true,force:true});}
  });

test('legacy compiled Worker is refused before maintenance while standby-capable rollback verifies',
  {skip:process.platform!=='win32'},()=>{
    const fixture=mkdtempSync(join(tmpdir(),'mr-legacy-rollover-'));
    try{
      const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
      const old='a'.repeat(40);
      const create=(name:string,standby:boolean,atomic=standby)=>{
        const root=join(fixture,name),dist=join(root,'dist');
        mkdirSync(join(dist,'plugins'),{recursive:true});
        const js=[{name:'cli.js',text:atomic?
          '// offline fixture channel-drain-release-verified\n':'// offline legacy fixture\n'},
          {name:'plugins/telegram.js',text:standby?
            'function probeFencedTelegramTransport() {}\nconst startedInsideDrain = true;\n':
            'export function ordinaryWorker() {}\n'}];
        for(const file of js)writeFileSync(join(dist,file.name),file.text);
        const tree=sha(js.map(file=>file.name+'\0'+sha(file.text)+'\n').join(''));
        const manifest=JSON.stringify({format:1,sourceSha:old,treeSha256:tree,
          cliSha256:sha(js[0]!.text),fileCount:js.length});
        writeFileSync(join(dist,'build-provenance.json'),manifest);
        return {root,runtime:{compiledTreeSha256:tree,manifestSha256:sha(manifest)}};
      };
      const legacy=create('legacy',false),supported=create('supported',true);
      const withoutAtomic=create('without-atomic',true,false);
      const start=script.indexOf('function Hash-UpgradeEvidence(');
      const end=script.indexOf('\nfunction Write-UpgradeEvidence',start);
      const copy=script.indexOf('function Assert-CompiledRollbackCopy(');
      const copyEnd=script.indexOf('\nfunction Verify-UpgradeSQLiteContinuity',copy);
      assert.ok(start>0&&end>start&&copy>0&&copyEnd>copy);
      const q=(s:string)=>`'${s.replaceAll("'","''")}'`;
      const code=[
        '$ErrorActionPreference="Stop"',
        script.slice(start,end),script.slice(copy,copyEnd),
        '$root='+q(legacy.root),
        '$runtime='+q(JSON.stringify(legacy.runtime))+' | ConvertFrom-Json',
        `try {$null=Assert-RollbackStandbyCapability '${old}' $runtime; throw 'Legacy accepted'} `+
          "catch {if ($_.Exception.Message -notlike '*explicitly authorized, byte-matched deployed version*'){throw}}",
        '$root='+q(withoutAtomic.root),
        '$runtime='+q(JSON.stringify(withoutAtomic.runtime))+' | ConvertFrom-Json',
        `try {$null=Assert-RollbackStandbyCapability '${old}' $runtime; throw 'Old CLI accepted'} `+
          "catch {if ($_.Exception.Message -notlike '*explicitly authorized, byte-matched deployed version*'){throw}}",
        '$root='+q(supported.root),
        '$runtime='+q(JSON.stringify(supported.runtime))+' | ConvertFrom-Json',
        `$cap=Assert-RollbackStandbyCapability '${old}' $runtime`,
        'if (-not $cap.verified -or $cap.compiledFiles -ne 3) {throw "Fenced rollback rejected"}',
        "Write-Output 'standby-compatibility-pass'",
      ].join('\n');
      const result=spawnSync('pwsh',['-NoProfile','-NonInteractive','-Command',code],
        {encoding:'utf8',timeout:15000});
      assert.equal(result.status,0,`${result.stderr}\n${result.stdout}`);
      assert.match(result.stdout,/standby-compatibility-pass/);
    }finally{rmSync(fixture,{recursive:true,force:true});}
  });

test('verified drain release binds the actual Worker PID without overwriting PowerShell automatic PID',
  {skip:process.platform!=='win32'},()=>{
    const start=script.indexOf('function Release-VerifiedChannelDrain(');
    const end=script.indexOf('\nfunction Assert-UpgradeTarget(',start);
    assert.ok(start>0&&end>start);
    const source=script.slice(start,end);
    assert.doesNotMatch(source,/\[int\]\$pid\b/i,
      'PowerShell $PID is read-only and cannot be used as a function parameter');
    const cmd=[
      '$ErrorActionPreference="Stop"',
      '$node="FakeNode"; $cli="fixture-only"',
      'function FakeNode {param([Parameter(ValueFromRemainingArguments=$true)][object[]]$items);'+
        '$script:received=@($items); $global:LASTEXITCODE=0}',
      source,
      "Release-VerifiedChannelDrain 'original-drain' ('a'*40) 4242 '2026-11-11T08:07:36.263Z'",
      'if ($script:received -notcontains "--expected-pid" -or '+
        '$script:received -notcontains "4242" -or '+
        '$script:received -notcontains "--expected-sha" -or '+
        '$script:received -notcontains "--expected-attested-at" -or '+
        '$script:received -notcontains "2026-11-11T08:07:36.263Z") {throw "Worker release arguments missing"}',
      "Write-Output 'verified-worker-pid-pass'",
    ].join('\n');
    const result=spawnSync('pwsh',['-NoProfile','-NonInteractive','-Command',cmd],
      {encoding:'utf8',timeout:15000});
    assert.equal(result.status,0,result.stderr+'\n'+result.stdout);
    assert.match(result.stdout,/verified-worker-pid-pass/);
  });

test('GMK pull-only upgrade is ordered behind the SQLite drain and never installs dependencies',()=>{
  const start=script.indexOf("    'Upgrade' {");
  const end=script.indexOf("    'Remove' {",start);
  assert.ok(start>0&&end>start,'Separate optional Upgrade action must exist');
  const upgrade=script.slice(start,end);
  const steps=[
    'Assert-Prerequisites',
    '$null=Assert-OurTask',
    'Assert-UpgradeTarget $ExpectedSha',
    'Assert-SafeRestart',
    '$oldRollbackCapability=Assert-RollbackStandbyCapability $oldSha $oldRuntime',
    '$drainId=Request-ChannelDrain',
    'Stop-FencedTelegramTask',
    'Backup-FencedSQLite',
    'Verify-IsolatedSQLiteRestore',
    'git -C $root fetch origin main',
    'git -C $root merge-base --is-ancestor $oldSha $remoteSha',
    'git -C $root pull --ff-only origin main',
    'npm.cmd run build',
    'Start-ScheduledTask -TaskName $taskName',
    'Wait-ForChannel $true',
    '$current=Assert-FencedWorker $ExpectedSha',
    "Write-UpgradeEvidence 'runtime_verified'",
    'Verify-UpgradeSQLiteContinuity',
    "Write-UpgradeEvidence 'fenced_acceptance_verified'",
    'Release-VerifiedChannelDrain $drainId $ExpectedSha',
    'pi-resume $ResumeMissionId',
  ];
  let previous=-1;
  for(const step of steps){
    const position=upgrade.indexOf(step);
    assert.ok(position>previous,`Required safe upgrade ordering: ${step}`);
    previous=position;
  }
  assert.match(upgrade,/\$remoteSha -cne \$ExpectedSha/);
  assert.match(upgrade,/Assert-LocalProxy \$localProxy/);
  assert.match(upgrade,/\$env:GIT_CONFIG_VALUE_0='socks5h:\/\/127\.0\.0\.1:'\+\$proxyPort/,
    'A locally approved loopback proxy is scoped to this maintenance process');
  assert.doesNotMatch(upgrade,/git config --(?:global|local)|setx\s|netsh\s/i);
  assert.match(script,/function Assert-OurTask \{[\s\S]*?Principal\.LogonType -ne 'Interactive'[\s\S]*?Principal\.RunLevel -ne 'Limited'/);
  assert.match(script,/\[string\]\$BootstrapRoot = ''/);
  assert.match(script,/if \(\$BootstrapRoot -and \$Action -notin @\('Upgrade','Compatibility'\)\)/,
    'A temporary bootstrap must not operate on task enrollment or generic restarts');
  assert.match(script,/if \(\$LegacyMigration -and \(\$Action -notin @\('Upgrade','Compatibility'\)/,
    'A legacy migration needs explicit selection and the reviewed bootstrap');
  assert.match(script,/\$expected = \[IO\.Path\]::GetFullPath\(\(Join-Path \$root 'scripts\\windows\\telegram-task\.ps1'\)\)/,
    'Foreign temporary scripts must validate the actual registered worker action');
  assert.match(script,/\$actions\.Count -ne 1/);
  assert.match(script,/\$actions\[0\]\.Arguments -cnotin @\(\$workerArgs,\$legacyWorkerArgs\)/);
  assert.match(script,/-WindowStyle Hidden -NoProfile -NonInteractive -File/,
    'Newly enrolled Telegram tasks must start without a visible console');
  assert.match(script,/function Get-WorkerProcessIdentity\([\s\S]*?-WindowStyle\\s\+Hidden/,
    'Worker provenance must recognize the hidden PowerShell parent');
  assert.match(script,/'HideWorker' \{[\s\S]*?Assert-SafeRestart[\s\S]*?Set-ScheduledTask -TaskName \$taskName -Action \$newAction/,
    'Existing enrolled tasks migrate to hidden launch only after idle preflight');
  assert.match(script,/\$taskSid -ne \[Security\.Principal\.WindowsIdentity\]::GetCurrent\(\)\.User\.Value/);
  assert.match(script,/\$task\.Settings\.MultipleInstances -ne 'IgnoreNew'/);
  assert.match(script,/function Assert-ReviewedBootstrapScript\(\[string\]\$sha\)/);
  assert.match(script,/Get-FileHash -Algorithm SHA256 -LiteralPath \$PSCommandPath/);
  assert.match(script,/Get-FileHash -Algorithm SHA256 -LiteralPath \$blob/);
  assert.match(upgrade,/Assert-ReviewedBootstrapScript \$ExpectedSha[\s\S]*Assert-SafeRestart/,
    'A modified bootstrap must be rejected before the idle maintenance gate or drain');
  assert.match(script,/'Worker'\s*\{\s*Assert-Prerequisites\s+Assert-InteractiveSession/);
  assert.doesNotMatch(upgrade,/Assert-InteractiveSession\s*$/m,
    'Session 0 may coordinate a known interactive task but must never run a Chrome Worker itself');
  assert.match(script,/function Assert-FencedWorker\([\s\S]*?\$channel\.pollerPid -eq \$previousPid/);
  assert.match(script,/function Assert-RollbackStandbyCapability\([\s\S]*?probeFencedTelegramTransport[\s\S]*?startedInsideDrain/);
  assert.match(script,/Legacy rollback is not the explicitly authorized, byte-matched deployed version/);
  assert.match(script,/if \(\$LegacyMigration\) \{\s*throw 'LegacyMigration was requested for a modern fenced Worker/);
  assert.match(upgrade,/Assert-RollbackStandbyCapability[\s\S]*Request-ChannelDrain/,
    'Unrecognized legacy rollback bytes must be rejected before any maintenance drain');
  assert.match(upgrade,/Release-VerifiedChannelDrain \$drainId \$oldSha/,
    'Rollback may release only after fresh atomic attestation of the restored original Worker');
  const preReleaseChrome=upgrade.indexOf('browser-binding-health $ResumeMissionId');
  const releaseProof=upgrade.indexOf("Write-UpgradeEvidence 'fenced_acceptance_verified'");
  assert.ok(preReleaseChrome>0&&preReleaseChrome<releaseProof,
    'Original browser binding must be read back under drain before optional PI resume');
  assert.ok(upgrade.indexOf('pi-resume $ResumeMissionId')>releaseProof,
    'PI resume is permitted only after the fenced acceptance stage');
  assert.match(script,/function Release-VerifiedChannelDrain[\s\S]*channel-drain-release-verified/);
  assert.match(upgrade,/if \(\$LASTEXITCODE -ne 0 -or \$head -cne \$ExpectedSha\)/);
  assert.match(upgrade,/git -C \$root reset --hard \$oldSha/);
  assert.match(upgrade,/Copy-Item -LiteralPath \(Join-Path \$backup 'dist'\)/);
  assert.match(upgrade,/\$backupComplete=\$true/);
  assert.match(script,/function Verify-IsolatedSQLiteRestore \{[\s\S]*?\.drainRequested[\s\S]*?isolated-restore\.sqlite[\s\S]*?sqlite_restore_verified/);
  assert.match(script,/function Assert-CompiledRollbackCopy\([\s\S]*?Get-FileHash[\s\S]*?compiled rollback copy differs/i);
  assert.match(upgrade,/Assert-CompiledRollbackCopy[\s\S]*?\$backupComplete=\$true[\s\S]*?compiled_rollback_saved/);
  assert.match(script,/\[switch\]\$HistoryReset[\s\S]*?\$HistoryReset -and \$Action -ne 'Upgrade'/);
  assert.match(upgrade,/if \(\$HistoryReset\)[\s\S]*?rev-list --parents -n 1 \$remoteSha[\s\S]*?reset --hard \$remoteSha[\s\S]*?else \{[\s\S]*?pull --ff-only origin main/,
    'Non-fast-forward history cutover must be explicit, parentless and retain normal default fast-forward');
  assert.match(upgrade,/Write-UpgradeEvidence 'compiled'[\s\S]*?Stop-FencedTelegramTask[\s\S]*?Start-ScheduledTask -TaskName \$taskName/,
    'A scheduled recovery Worker from before compilation must be stopped under drain before starting the candidate');
  assert.match(upgrade,/if \(\$buildStarted\) \{/);
  assert.match(upgrade,/if \(-not \$backupComplete\) \{ throw 'Compiled rollback image was not verified' \}/);
  assert.match(upgrade,/\$rollbackProof=Assert-CompiledRollbackCopy \$restoredDist/);
  assert.match(upgrade,/\$restored=Assert-FencedWorker \$oldSha/);
  assert.match(upgrade,/legacy_rollback_pre_release_verified[\s\S]*Release-ChannelDrain \$drainId[\s\S]*Start-ScheduledTask -TaskName \$taskName[\s\S]*Assert-LegacyRollbackWorker/);
  assert.match(upgrade,/Maintenance remains fenced/);
  assert.doesNotMatch(upgrade,/\} finally \{\s*if \(\$rollbackSafe\)/);
  assert.doesNotMatch(upgrade,/npm\s+(?:ci|install)|Stop-Process|taskkill|chrome\.exe/i);
});

test('PowerShell parses guarded Upgrade script and its exact-SHA guard fails before Git access',
  {skip:process.platform!=='win32'},()=>{
    const quoted=path.replaceAll("'","''");
    const parse=`$tokens=$null; $errors=$null; `+
      `[System.Management.Automation.Language.Parser]::ParseFile('${quoted}',`+
      `[ref]$tokens,[ref]$errors) | Out-Null; `+
      `if ($errors.Count -ne 0) { $errors | ForEach-Object { Write-Error $_ }; exit 2 }; `+
      `Write-Output 'upgrade-syntax-pass'`;
    const checked=spawnSync('pwsh',['-NoProfile','-NonInteractive','-Command',parse],
      {encoding:'utf8',timeout:12000});
    assert.equal(checked.status,0,`${checked.stderr} ${checked.stdout}`);
    assert.match(checked.stdout,/upgrade-syntax-pass/);

    const unauthorizedBootstrap=spawnSync('pwsh',[
      '-NoProfile','-NonInteractive','-File',path,
      '-Action','Status','-BootstrapRoot',resolve('.')],
      {encoding:'utf8',timeout:12000});
    assert.notEqual(unauthorizedBootstrap.status,0,
      'A bootstrap checkout override cannot be used with Status or any non-Upgrade task action');
    assert.match(unauthorizedBootstrap.stderr,/BootstrapRoot is permitted only/);

    const start=script.indexOf('function Assert-UpgradeTarget(');
    const end=script.indexOf('\nfunction Stop-FencedTelegramTask',start);
    assert.ok(start>0&&end>start);
    const reject=`${script.slice(start,end)}\n`+
      `try { Assert-UpgradeTarget -sha 'not-an-exact-sha'; throw 'Invalid SHA accepted' } `+
      `catch { if ($_.Exception.Message -notlike '*exact lowercase 40-character*') { throw } }; `+
      `Write-Output 'upgrade-hash-rejection-pass'`;
    const refused=spawnSync('pwsh',['-NoProfile','-NonInteractive','-Command',reject],
      {encoding:'utf8',timeout:12000});
    assert.equal(refused.status,0,`${refused.stderr} ${refused.stdout}`);
    assert.match(refused.stdout,/upgrade-hash-rejection-pass/);

    // Prove a foreign/non-task writer cannot be stopped by this action. The
    // extracted helper runs against in-memory stubs only; no real scheduled
    // task, browser, Git checkout, SQLite or Telegram token is touched.
    const stopStart=script.indexOf('function Stop-FencedTelegramTask {');
    const stopEnd=script.indexOf('\nswitch ($Action)',stopStart);
    assert.ok(stopStart>0&&stopEnd>stopStart);
    const rejectForeign=`${script.slice(stopStart,stopEnd)}\n`+
      `function Get-Task { return [pscustomobject]@{ State='Ready' } }; `+
      `function Get-ChannelStatus { return [pscustomobject]@{ pollerPresent=$true } }; `+
      `function Stop-ScheduledTask { throw 'Foreign task was stopped' }; `+
      `try { Stop-FencedTelegramTask; throw 'Foreign writer was allowed' } `+
      `catch { if ($_.Exception.Message -notlike '*Non-task Telegram poller*') { throw } }; `+
      `Write-Output 'foreign-owner-rejection-pass'`;
    const foreign=spawnSync('pwsh',['-NoProfile','-NonInteractive','-Command',rejectForeign],
      {encoding:'utf8',timeout:12000});
    assert.equal(foreign.status,0,`${foreign.stderr} ${foreign.stdout}`);
    assert.match(foreign.stdout,/foreign-owner-rejection-pass/);
  });

test('isolated fenced Worker validation rejects missing drain, wrong SHA, fake PID, bad compiled bytes and pending events',
  {skip:process.platform!=='win32'},()=>{
    const fixture=mkdtempSync(join(tmpdir(),'mr-upgrade-fenced-worker-'));
    try{
      const dist=join(fixture,'dist');mkdirSync(dist);
      const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
      const target='a'.repeat(40),tree='b'.repeat(64);
      const cli='// isolated worker fixture\n';
      const cliSha=sha(cli);
      const manifest={format:1,sourceSha:target,treeSha256:tree,cliSha256:cliSha,fileCount:1};
      const manifestText=JSON.stringify(manifest);
      writeFileSync(join(dist,'cli.js'),cli);
      writeFileSync(join(dist,'build-provenance.json'),manifestText);
      const channel={source:'telegram',drainRequested:true,pollerPresent:true,
        pollerPid:200,transportHealth:'healthy',pendingReplies:0,
        notificationsCursor:10,lastEventId:10,
        runtimeProvenance:{pid:200,sourceSha:target,compiledTreeSha256:tree,
          cliSha256:cliSha,manifestSha256:sha(manifestText),fileCount:1}};
      const start=script.indexOf('function Assert-FencedWorker(');
      const end=script.indexOf('\nfunction Test-UpgradeEvidence',start);
      assert.ok(start>0&&end>start);
      const q=(s:string)=>`'${s.replaceAll("'","''")}'`;
      const code=[
        '$ErrorActionPreference="Stop"',
        '$root='+q(fixture),
        '$taskName="fixture-only"',
        '$script:sample='+q(JSON.stringify(channel))+' | ConvertFrom-Json',
        'function Get-ChannelStatus { return $script:sample }',
        "function Assert-OurTask {return [pscustomobject]@{State='Running'}}",
        `function git { $global:LASTEXITCODE=0; return '${target}' }`,
        script.slice(start,end),
        `$null=Assert-FencedWorker '${target}' 180`,
        'function Refuse([string]$scenario){try{$null=Assert-FencedWorker '+q(target)+
          ' 180;throw "Accepted unsafe $scenario"}catch{if($_.Exception.Message -like "Accepted unsafe*"){throw}}}',
        '$script:sample.drainRequested=$false;Refuse "released drain"; $script:sample.drainRequested=$true',
        '$script:sample.pollerPid=180;Refuse "old owner"; $script:sample.pollerPid=200',
        '$script:sample.notificationsCursor=9;Refuse "unscanned notification"; $script:sample.notificationsCursor=10',
        "$script:sample.runtimeProvenance.sourceSha='c'*40;Refuse 'foreign SHA';$script:sample.runtimeProvenance.sourceSha='a'*40",
        "$script:sample.runtimeProvenance.manifestSha256='d'*64;Refuse 'altered manifest hash'",
        "Write-Output 'fenced-worker-refusal-pass'",
      ].join('\n');
      const result=spawnSync('pwsh',['-NoProfile','-NonInteractive','-Command',code],
        {encoding:'utf8',timeout:15000});
      assert.equal(result.status,0,`${result.stderr}\n${result.stdout}`);
      assert.match(result.stdout,/fenced-worker-refusal-pass/);
    }finally{rmSync(fixture,{recursive:true,force:true});}
  });

test('PowerShell rejects altered task action, parallel workers and a foreign account without touching Scheduler',
  {skip:process.platform!=='win32'},()=>{
    const begin=script.indexOf('function Assert-OurTask {');
    const end=script.indexOf('\nfunction Assert-SafeRestart',begin);
    assert.ok(begin>0&&end>begin);
    const isolated=[
      '$root=(Get-Location).Path',
      script.slice(begin,end),
      'function Get-Task { return $script:sample }',
      "$workerPath=[IO.Path]::GetFullPath((Join-Path $root 'scripts\\windows\\telegram-task.ps1'))",
      "$workerExe=[IO.Path]::GetFullPath((Join-Path $env:ProgramFiles 'PowerShell\\7\\pwsh.exe'))",
      "$workerArgs='-NoProfile -NonInteractive -File ' + [char]34 + $workerPath + [char]34 + ' -Action Worker'",
      "$script:sample=[pscustomobject]@{Actions=@([pscustomobject]@{Execute=$workerExe;Arguments=$workerArgs;WorkingDirectory=$root});Principal=[pscustomobject]@{UserId=[Security.Principal.WindowsIdentity]::GetCurrent().Name;LogonType='Interactive';RunLevel='Limited'};Settings=[pscustomobject]@{MultipleInstances='IgnoreNew'}}",
      '$null=Assert-OurTask',
      "function Assert-Refusal([string]$reason) { try { $null=Assert-OurTask; throw 'Unexpectedly accepted' } catch { if ($_.Exception.Message -notlike ('*'+$reason+'*')) { throw } } }",
      "$script:sample.Settings.MultipleInstances='Parallel'",
      "Assert-Refusal 'single-instance'",
      "$script:sample.Settings.MultipleInstances='IgnoreNew'",
      "$script:sample.Actions[0].Arguments += ' -UnexpectedFlag'",
      "Assert-Refusal 'single enrolled Worker'",
      "$script:sample.Actions[0].Arguments=$workerArgs",
      "$script:sample.Principal.UserId='NT AUTHORITY\\SYSTEM'",
      "Assert-Refusal 'different Windows account'",
      "Write-Output 'task-identity-fail-closed-pass'",
    ].join('\n');
    const result=spawnSync('pwsh',['-NoProfile','-NonInteractive','-Command',isolated],
      {encoding:'utf8',timeout:15000});
    assert.equal(result.status,0,result.stderr+' '+result.stdout);
    assert.match(result.stdout,/task-identity-fail-closed-pass/);
  });

test('private upgrade journal is durable, chained, and rejects tampering without a production task',
  {skip:process.platform!=='win32'},()=>{
    const start=script.indexOf('# The audit lives outside the pull-only checkout.');
    const end=script.indexOf('\nswitch ($Action)',start);
    assert.ok(start>0&&end>start,'New audit helper must precede the task dispatcher');
    const fixture=mkdtempSync(join(tmpdir(),'mr-upgrade-proof-'));
    try{
      const local=join(fixture,'local');
      const dbDir=join(local,'MissionRelay');
      mkdirSync(dbDir,{recursive:true});
      const db=new DatabaseSync(join(dbDir,'missions.sqlite'));
      try{
        db.exec("CREATE TABLE missions(id TEXT, state TEXT); CREATE TABLE events(id INTEGER PRIMARY KEY); CREATE TABLE meta(key TEXT,value TEXT); INSERT INTO missions VALUES('fixture','PAUSED'); INSERT INTO events(id) VALUES(1),(2)");
      }finally{db.close();}
      const source=[
        '$ErrorActionPreference="Stop"',
        '$privateDir=Join-Path $env:MR_AUDIT_FIXTURE_HOME "private"',
        'New-Item -ItemType Directory -Path $privateDir -Force | Out-Null',
        '$node=$env:MR_NODE_EXE',
        "$taskName='MissionRelay-Telegram'",
        script.slice(start,end),
        "New-UpgradeEvidence ('a'*40) ('b'*40) 1234",
        "Write-UpgradeEvidence 'preflight' @{exitCode=0;activeMissions=0;reserved=0}",
        "Write-UpgradeEvidence 'drain_acquired' @{drainIdSha256=(Hash-UpgradeEvidence 'synthetic-id')}",
        'Test-UpgradeEvidence',
        'function Get-ChannelStatus { return [pscustomobject]@{drainRequested=$script:testDrain} }',
        '$script:testDrain=$false',
        "try{Backup-FencedSQLite;throw 'Unfenced snapshot accepted'}catch{if($_.Exception.Message -notlike '*maintenance drain*'){throw}}",
        '$script:testDrain=$true',
        'Backup-FencedSQLite',
        'Verify-IsolatedSQLiteRestore',
        '$snapshot=Join-Path $script:upgradeAuditDir "missions.sqlite"',
        'if(-not (Test-Path $snapshot)){throw "Snapshot missing"}',
        '$restored=Join-Path $script:upgradeAuditDir "isolated-restore.sqlite"',
        'if(-not (Test-Path $restored)){throw "Isolated restore missing"}',
        '$dbFile=Join-Path $env:LOCALAPPDATA "MissionRelay/missions.sqlite"',
        'Test-UpgradeEvidence',
        '$lines=[IO.File]::ReadAllLines($script:upgradeAuditLog)',
        'if($lines.Count -ne 5){throw "Missing journal stages"}',
        '$entry=$lines[1] | ConvertFrom-Json',
        '$entry.sha256="0"*64',
        '$lines[1]=($entry|ConvertTo-Json -Compress)',
        '[IO.File]::WriteAllLines($script:upgradeAuditLog,$lines)',
        'try{Test-UpgradeEvidence;throw "Tamper accepted"}catch{',
        'if($_.Exception.Message -notlike "*chain verification failed*"){throw}}',
        'Write-Output "durable-upgrade-chain-pass"',
      ].join('\n');
      const result=spawnSync('pwsh',['-NoProfile','-NonInteractive','-Command',source],{
        encoding:'utf8',timeout:25000,env:{...process.env,
          MR_AUDIT_FIXTURE_HOME:fixture,MR_NODE_EXE:process.execPath,LOCALAPPDATA:local},
      });
      assert.equal(result.status,0,result.stdout+' '+result.stderr);
      assert.match(result.stdout,/durable-upgrade-chain-pass/);
    }finally{rmSync(fixture,{recursive:true,force:true});}
  });
