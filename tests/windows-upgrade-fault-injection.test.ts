import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';

/** Execute the REAL Windows Upgrade action with OS-facing helper calls shadowed
 * by test doubles and a disposable checkout. The real PowerShell helpers and
 * complete script syntax are tested separately in windows-upgrade-safety.test;
 * SQLite and ReleaseProbe validation in goal-release-maintenance-probe.test.
 * This validates Upgrade state-machine wiring, not helper correctness.
 * No production task, browser profile, database path or credentials are passed
 * to this fixture. The cooperative fake-call trace is not an OS sandbox. */
const original=readFileSync(resolve('scripts/windows/telegram-task.ps1'),'utf8');
const upgradeStart=original.indexOf("    'Upgrade' {");
const upgradeEnd=original.indexOf("    'Remove' {",upgradeStart);
assert.ok(upgradeStart>0&&upgradeEnd>upgradeStart);
const upgrade=original.slice(upgradeStart,upgradeEnd);
const SHA_OLD='a'.repeat(40),SHA_NEW='b'.repeat(40);
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const quote=(s:string)=>`'${s.replaceAll("'","''")}'`;

type Receipt={scenario:string;outcome:'success'|'error';reason:string;
  head:string;drain:boolean;worker:boolean;workerPid:number;
  workerHighWater:number;releases:number;resumes:number;
  stages:string[];failpoints:string[];calls:string[];sqliteSha256:string};

function exercise(scenario:string):Receipt {
  const fixture=mkdtempSync(join(tmpdir(),'mr-upgrade-isolated-'));
  try{
    const dist=join(fixture,'dist'),audit=join(fixture,'audit');
    mkdirSync(dist);mkdirSync(audit);
    const oldCli='// synthetic old compiled Worker and CLI; no executable code\n';
    const oldTree=hash('old tree'),newTree=hash('new tree');
    writeFileSync(join(dist,'cli.js'),oldCli);
    writeFileSync(join(dist,'build-provenance.json'),JSON.stringify({
      sourceSha:SHA_OLD,treeSha256:oldTree,cliSha256:hash(oldCli),fileCount:1,
    }));
    const dbFile=join(fixture,'isolated.sqlite');
    const db=new DatabaseSync(dbFile);
    try{
      db.exec(`CREATE TABLE missions(id TEXT PRIMARY KEY,state TEXT,turn_count INTEGER,
        stop_requested INTEGER); CREATE TABLE requests(id TEXT PRIMARY KEY,status TEXT);
        INSERT INTO missions VALUES('synthetic-paused','PAUSED',10,1);
        INSERT INTO requests VALUES('original-spent-request','reconciled');`);
    }finally{db.close();}
    const sqliteDigest=createHash('sha256').update(readFileSync(dbFile)).digest('hex');
    const ps=[
      '$ErrorActionPreference="Stop"',
      '$Action="Upgrade"',
      '$HistoryReset='+(['history_reset','history_reset_has_parent'].includes(scenario)?'$true':'$false'),
      '$ProxyUrl=""',
      '$ExpectedSha='+quote(SHA_NEW),
      '$ResumeMissionId='+quote(scenario==='browser_binding_failure'?'synthetic-paused':''),
      '$root='+quote(fixture),
      '$privateDir='+quote(fixture),
      '$settingsFile=Join-Path $root "not-enrolled-owner.json"',
      '$cli=Join-Path $root "synthetic-cli.js"',
      '$node="IsolatedNode"',
      '$taskName="Isolated-MissionRelay-Fixture-Only"',
      '$script:fault='+quote(scenario),
      '$script:head='+quote(SHA_OLD),
      '$script:oldSha='+quote(SHA_OLD),
      '$script:target='+quote(SHA_NEW),
      '$script:oldTree='+quote(oldTree),
      '$script:newTree='+quote(newTree),
      '$script:database='+quote(dbFile),
      '$script:databaseDigest='+quote(sqliteDigest),
      '$script:workerRunning=$true; $script:workerPid=101',
      '$script:workerSource=$script:oldSha',
      '$script:attestedAt=[DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")',
      '$script:workerHighWater=1; $script:nextPid=101',
      '$script:drain=$false; $script:releases=0; $script:resumes=0',
      '$script:rollbackStarted=$false',
      '$script:stages=[System.Collections.Generic.List[string]]::new()',
      '$script:failpoints=[System.Collections.Generic.List[string]]::new()',
      '$script:calls=[System.Collections.Generic.List[string]]::new()',
      '$script:upgradeAuditDir='+quote(audit),
      'function Assert-Prerequisites {}',
      'function Assert-OurTask { return [pscustomobject]@{State=if($script:workerRunning){"Running"}else{"Ready"}} }',
      'function Get-Task { return (Assert-OurTask) }',
      'function Assert-UpgradeTarget([string]$sha) {if($sha -cne $script:target){throw "Wrong candidate SHA"}}',
      'function Assert-ReviewedBootstrapScript([string]$sha) {}',
      'function Assert-LocalProxy([string]$url) {}',
      'function Assert-SafeRestart {if($script:fault -eq "pre_admission_unsettled" -and '+
        '$script:head -ceq $script:target){$script:failpoints.Add("pre_admission_unsettled");'+
        'throw "Simulated unsettled SQLite request"}}',
      'function Get-ChannelStatus {return [pscustomobject]@{'+
        'drainRequested=$script:drain; pollerPresent=$script:workerRunning;'+
        'pollerPid=$script:workerPid;transportHealth="healthy";pendingReplies=0;'+
        'notificationsCursor=0;lastEventId=0;runtimeProvenance=[pscustomobject]@{'+
        'sourceSha=$script:head;pid=$script:workerPid;compiledTreeSha256=$script:oldTree;'+
        'manifestSha256=("1"*64);cliSha256=("2"*64);fileCount=1;'+
        'at=$script:attestedAt}} }',
      'function Assert-RollbackStandbyCapability([string]$sha,$runtime) {'+
        'return @{verified=$true;previousSha=$sha;originalTreeSha256=$runtime.compiledTreeSha256;compiledFiles=2}}',
      'function New-UpgradeEvidence([string]$from,[string]$to,[int]$previousPid) {'+
        '$script:stages.Add("intent")}',
      'function Hash-UpgradeEvidence([string]$value) {return "3"*64}',
      'function Write-UpgradeEvidence([string]$stage,[hashtable]$details=@{}) {'+
        '$script:stages.Add($stage);'+
        'if($script:fault -eq "journal_failure" -and $stage -eq "fenced_acceptance_verified") {'+
        '$script:failpoints.Add("journal_failure");throw "Synthetic audit write failure"};'+
        'if($stage -eq "drain_released" -and '+
        '(($script:fault -eq "post_release_success_audit" -and $script:head -ceq $script:target) -or '+
        '($script:fault -eq "post_release_rollback_audit" -and $script:head -ceq $script:oldSha))) {'+
        '$script:failpoints.Add($script:fault);throw "Synthetic post-release audit failure"}}',
      'function Test-UpgradeEvidence {}',
      'function Assert-AuditPreflight {}',
      'function Request-ChannelDrain {if($script:drain){throw "duplicate drain"};'+
        '$script:drain=$true;return "11111111-1111-4111-8111-111111111111"}',
      'function Stop-FencedTelegramTask {$script:calls.Add("stop-worker");'+
        '$script:workerRunning=$false;$script:workerPid=0}',
      'function Backup-FencedSQLite {'+
        'if($script:fault -eq "snapshot_backup_failure") {'+
        '$script:failpoints.Add("snapshot_backup_failure");throw "Backup failed"};'+
        'Copy-Item -LiteralPath $script:database -Destination (Join-Path $script:upgradeAuditDir "missions.sqlite")}',
      'function Verify-IsolatedSQLiteRestore {'+
        'if($script:fault -eq "restore_failure") {$script:failpoints.Add("restore_failure");'+
        'throw "Synthetic isolated restore failure"};'+
        '$backup=Join-Path $script:upgradeAuditDir "missions.sqlite";'+
        '$restore=Join-Path $script:upgradeAuditDir "isolated-restore.sqlite";'+
        'Copy-Item -LiteralPath $backup -Destination $restore;'+
        'if((Get-FileHash $backup -Algorithm SHA256).Hash -cne '+
        '(Get-FileHash $restore -Algorithm SHA256).Hash){throw "Restore digest mismatch"}}',
      'function Assert-CompiledRollbackCopy([string]$source,[string]$copy,'+
        '[string]$expectedSha,[string]$expectedTree,[string]$expectedManifest="") {'+
        '$manifest=Get-Content -LiteralPath (Join-Path $copy "build-provenance.json") -Raw | ConvertFrom-Json;'+
        '$cliHash=(Get-FileHash -LiteralPath (Join-Path $copy "cli.js") -Algorithm SHA256).Hash.ToLowerInvariant();'+
        'if($manifest.sourceSha -cne $expectedSha -or $manifest.treeSha256 -cne $expectedTree -or '+
        '$manifest.cliSha256 -cne $cliHash){throw "Compiled restore differs"};'+
        'return @{verified=$true;previousSha=$expectedSha;compiledTreeSha256=$expectedTree;'+
        'copiedBytesSha256=("4"*64);fileCount=2}}',
      'function Verify-UpgradeSQLiteContinuity {'+
        'if($script:fault -eq "sqlite_after_upgrade" -and $script:head -ceq $script:target) {'+
        '$script:failpoints.Add("sqlite_after_upgrade");throw "Simulated SQLite continuity failure"};'+
        'if($script:fault -eq "sqlite_damaged_during_upgrade" -and $script:head -ceq $script:target) {'+
        '$script:failpoints.Add("sqlite_damaged_during_upgrade");'+
        'Set-Content -LiteralPath $script:database -Value "SQLite damaged";throw "SQLite integrity failed"};'+
        '$actual=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData('+
        '[IO.File]::ReadAllBytes($script:database))).ToLowerInvariant();'+
        'if($actual -cne $script:expectedDatabaseSha256){throw "SQLite bytes changed"}}',
      'function Start-ScheduledTask([string]$TaskName) {'+
        '$script:calls.Add("start-worker");'+
        'if($script:workerRunning){throw "Second Worker forbidden"};'+
        'if($script:fault -eq "rollback_start_failure" -and $script:rollbackStarted){'+
        '$script:failpoints.Add("rollback_start_failure");'+
        'throw "Simulated original Worker restart failure"};'+
        '$script:nextPid++;$script:workerPid=$script:nextPid;$script:workerRunning=$true;'+
        '$script:workerSource=$script:head;'+
        '$script:workerHighWater=[Math]::Max($script:workerHighWater,1)}',
      'function Wait-ForChannel([bool]$expected) {'+
        'if($script:fault -eq "worker_start_timeout" -and $expected -and '+
        '$script:head -ceq $script:target){'+
        '$script:failpoints.Add("worker_start_timeout");throw "Worker startup timeout"};'+
        'if($script:workerRunning -ne $expected){throw "Worker startup timeout"}}',
      'function Assert-FencedWorker([string]$expectedSha,[int]$previousPid) {'+
        'if($script:fault -eq "damaged_rollback_image" -and $expectedSha -ceq $script:target){'+
        '$script:failpoints.Add("damaged_rollback_image");'+
        'Set-Content -LiteralPath (Join-Path $script:upgradeAuditDir "rollback/dist/cli.js") '+
        '-Value "damaged SAVED rollback bytes";throw "Backup damaged after snapshot"};'+
        'if($script:fault -in @("health_after_upgrade","rollback_start_failure",'+
        '"release_after_rollback","post_release_rollback_audit") -and '+
        '$expectedSha -ceq $script:target){'+
        'if($script:fault -eq "health_after_upgrade") {'+
        '$script:failpoints.Add("health_after_upgrade")};'+
        'throw "Simulated failed transport health"};'+
        'if($script:fault -eq "version_after_upgrade" -and $expectedSha -ceq $script:target){'+
        '$script:failpoints.Add("version_after_upgrade");throw "Simulated Worker source mismatch"};'+
        'if(-not $script:drain -or -not $script:workerRunning -or '+
        '$script:workerPid -eq $previousPid -or $script:head -cne $expectedSha -or '+
        '$script:workerSource -cne $expectedSha) {'+
        'throw "Fenced runtime identity refused"};'+
        '$manifest=Get-Content -LiteralPath (Join-Path $root "dist/build-provenance.json") -Raw | ConvertFrom-Json;'+
        '$sha=(Get-FileHash -LiteralPath (Join-Path $root "dist/cli.js") -Algorithm SHA256).Hash.ToLowerInvariant();'+
        'if($manifest.sourceSha -cne $expectedSha -or $manifest.cliSha256 -cne $sha){'+
        'throw "Fenced compiled artifact invalid"};'+
        'return [pscustomobject]@{pollerPid=$script:workerPid;transportHealth="healthy";'+
        'notificationsCursor=0;lastEventId=0;runtimeProvenance=[pscustomobject]@{'+
        'sourceSha=$expectedSha;compiledTreeSha256=$manifest.treeSha256;'+
        'at=$script:attestedAt}}}',
      'function Release-VerifiedChannelDrain([string]$id,[string]$sha,[int]$workerPid,'+
        '[string]$attestedAt) {'+
        'if($attestedAt -cne $script:attestedAt){throw "Worker attestation changed"};'+
        'if($script:fault -eq "release_after_upgrade" -and $sha -ceq $script:target){'+
        '$script:failpoints.Add("release_after_upgrade");throw "Simulated atomic release refusal"};'+
        'if($script:fault -eq "release_after_rollback" -and $sha -ceq $script:oldSha){'+
        '$script:failpoints.Add("release_after_rollback");throw "Simulated rollback release refusal"};'+
        'if(-not $script:drain -or -not $script:workerRunning -or '+
        '$sha -cne $script:head -or $workerPid -ne $script:workerPid){'+
        'throw "Atomic release invariants failed"};'+
        '$script:calls.Add("atomic-release");$script:drain=$false;$script:releases++}',
      'function IsolatedNode {'+
        '$global:LASTEXITCODE=0;'+
        '$script:calls.Add("fake-cli:"+[string]$args[1]);'+
        'switch([string]$args[1]) {'+
        '"channel-drain-status" {'+
        '$drainId=if($script:fault -eq "drain_receipt_mismatch") {'+
        '$script:failpoints.Add("drain_receipt_mismatch");'+
        '"22222222-2222-4222-8222-222222222222"}else{' +
        '"11111111-1111-4111-8111-111111111111"};'+
        'return (@{requested=$script:drain;drainId=$drainId}|ConvertTo-Json -Compress)};'+
        '"browser-binding-health" {return (@{binding=if($script:fault -eq "browser_binding_failure") {'+
        '$script:failpoints.Add("browser_binding_failure");'+
        '"not_connected"}else{"exact_connected"};matchingLinkedTabs=1;enabledChatTabs=1}|ConvertTo-Json -Compress)};'+
        '"show" {return (@{version=1}|ConvertTo-Json -Compress)};'+
        '"pi-resume" {$script:resumes++;return ""};'+
        'default {throw "Unexpected isolated CLI access"}}}',
      'function git {'+
        '$command=(@($args)|ForEach-Object{[string]$_}) -join " ";'+
        '$script:calls.Add("fake-git:"+$command);'+
        '$global:LASTEXITCODE=0;'+
        'if($command -match "rev-parse refs/remotes/origin/main"){return $script:target};'+
        'if($command -match "rev-parse HEAD"){return $script:head};'+
        'if($command -match "rev-list --parents -n 1"){'+
        'if($script:fault -eq "history_reset_has_parent") {'+
        '$script:failpoints.Add("history_reset_has_parent");'+
        'return ($script:target+" "+$script:oldSha)};return $script:target};'+
        'if($command -match "reset --hard"){'+
        'if($command.Contains($script:target)) {$script:head=$script:target;'+
        'return "verified root reset"};'+
        '$script:head=$script:oldSha;$script:rollbackStarted=$true;'+
        'return "restore original synthetic fixture"};'+
        'if($command -match "pull --ff-only"){ $script:head=$script:target;'+
        'if($script:fault -eq "git_pull_failure") {'+
        '$script:failpoints.Add("git_pull_failure");$global:LASTEXITCODE=2};'+
        'return "pulled synthetic fixture"};'+
        'if($command -match "status --porcelain"){return};'+
        'if($command -match "fetch origin main" -and $script:fault -eq "git_fetch_failure") {'+
        '$script:failpoints.Add("git_fetch_failure");$global:LASTEXITCODE=2;return};'+
        'if($command -match "fetch origin main|merge-base --is-ancestor"){return};'+
        'throw "Unmocked Git access: $command"}',
      'function npm.cmd {'+
        '$script:calls.Add("fake-build");'+
        '$global:LASTEXITCODE=0;'+
        '$body="// synthetic NEW compiled code";'+
        '[IO.File]::WriteAllText((Join-Path $root "dist/cli.js"),$body);'+
        '$source=if($script:fault -eq "damaged_build_manifest") {'+
        '$script:failpoints.Add("damaged_build_manifest");"e"*40}else{$script:target};'+
        '$cliSha=if($script:fault -eq "damaged_build_cli"){"0"*64}else{'+
        '[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData('+
        '[Text.Encoding]::UTF8.GetBytes($body))).ToLowerInvariant()};'+
        '$manifest=@{sourceSha=$source;treeSha256=$script:newTree;'+
        'cliSha256=$cliSha;fileCount=1}|ConvertTo-Json -Compress;'+
        'if($script:fault -eq "damaged_build_cli") {$script:failpoints.Add("damaged_build_cli")};'+
        '[IO.File]::WriteAllText((Join-Path $root "dist/build-provenance.json"),$manifest);'+
        'if($script:fault -eq "recovery_trigger_race") {'+
        '$script:calls.Add("scheduled-trigger-old-worker");'+
        'if($script:workerRunning){throw "Scheduled trigger overlapped an existing Worker"};'+
        '$script:nextPid++;$script:workerPid=$script:nextPid;'+
        '$script:workerSource=$script:oldSha;$script:workerRunning=$true};'+
        'if($script:fault -eq "npm_build_failure") {'+
        '$script:failpoints.Add("npm_build_failure");$global:LASTEXITCODE=2}}',
      '$script:expectedDatabaseSha256=[Convert]::ToHexString('+
        '[Security.Cryptography.SHA256]::HashData([IO.File]::ReadAllBytes($script:database))).ToLowerInvariant()',
      'try {',
      'switch ($Action) {',upgrade,'}',
      '$script:outcome="success";$script:reason=""',
      '}catch { $script:outcome="error";$script:reason=$_.Exception.Message }',
      '$receipt=@{scenario=$script:fault;outcome=$script:outcome;reason=$script:reason;'+
        'head=$script:head;drain=$script:drain;worker=$script:workerRunning;'+
        'workerPid=$script:workerPid;workerHighWater=$script:workerHighWater;'+
        'releases=$script:releases;resumes=$script:resumes;'+
        'stages=@($script:stages);failpoints=@($script:failpoints);calls=@($script:calls);'+
        'sqliteSha256=[Convert]::ToHexString('+
        '[Security.Cryptography.SHA256]::HashData([IO.File]::ReadAllBytes($script:database))).ToLowerInvariant()}',
      'Write-Output ("MR_FAULT_RECEIPT="+($receipt|ConvertTo-Json -Compress -Depth 8))',
    ].join('\n');
    const file=join(fixture,'isolated-upgrade.ps1');
    writeFileSync(file,ps);
    const result=spawnSync('pwsh',['-NoProfile','-NonInteractive','-File',file],{
      encoding:'utf8',timeout:20_000,maxBuffer:2*1024*1024,
      // In particular: do not pass provider tokens, connected account env,
      // production DB paths or browser session variables into PowerShell.
      env:{PATH:process.env.PATH??process.env.Path??'',
        SystemRoot:process.env.SystemRoot??'',
        PSModulePath:process.env.PSModulePath??'',
        USERPROFILE:process.env.USERPROFILE??'',
        APPDATA:process.env.APPDATA??'',LOCALAPPDATA:process.env.LOCALAPPDATA??'',
        HOMEDRIVE:process.env.HOMEDRIVE??'',HOMEPATH:process.env.HOMEPATH??'',
        ComSpec:process.env.ComSpec??'',
        TEMP:fixture,TMP:fixture,MR_ISOLATED_FAULT_SCENARIO:scenario},
    });
    assert.equal(result.status,0,`${scenario} PowerShell execution failed:\n${result.stderr}\n${result.stdout}`);
    const line=result.stdout.split(/\r?\n/).find(x=>x.startsWith('MR_FAULT_RECEIPT='));
    assert.ok(line,`${scenario}: missing actual PowerShell scenario receipt: ${result.stdout} ${result.stderr}`);
    const receipt=JSON.parse(line.slice('MR_FAULT_RECEIPT='.length)) as Receipt;
    assert.equal(receipt.scenario,scenario);
    assert.deepEqual(receipt.failpoints,
      ['success','recovery_trigger_race','history_reset'].includes(scenario)?[]:[scenario],
      `${scenario}: the named fault must be executed, not an unrelated exception`);
    assert.ok(receipt.workerHighWater<=1,'never launch a second Worker');
    assert.ok(receipt.calls.every(c=>c==='stop-worker'||c==='start-worker'||
      c==='scheduled-trigger-old-worker'||
      c==='atomic-release'||c==='fake-build'||c.startsWith('fake-git:')||
      ['fake-cli:channel-drain-status','fake-cli:browser-binding-health',
        'fake-cli:show','fake-cli:pi-resume'].includes(c)),
    'the cooperative mock trace must contain only recognized fake operations');
    if(scenario==='damaged_rollback_image'){
      assert.ok(receipt.stages.includes('compiled_rollback_saved'),
        'saved backup first passed original byte validation');
      assert.ok(!receipt.stages.includes('rollback_verified'),
        'physically changed saved backup must not become verified rollback');
      assert.match(receipt.reason,/Maintenance remains fenced/);
    }
    if(scenario==='recovery_trigger_race'){
      const triggerAt=receipt.calls.indexOf('scheduled-trigger-old-worker');
      assert.ok(triggerAt>0,'exercise the recurring Task Scheduler launch during compilation');
      assert.ok(receipt.calls.slice(triggerAt+1).indexOf('stop-worker')>=0,
        'reap the old compiled Worker under the original drain before candidate Start');
      assert.ok(receipt.calls.indexOf('start-worker',triggerAt+1)>
        receipt.calls.indexOf('stop-worker',triggerAt+1),
      'candidate must start after the trigger-owned original Worker exits');
      assert.ok(receipt.stages.includes('prelaunch_recovery_worker_cleared'));
    }
    if(scenario==='history_reset'){
      assert.ok(receipt.calls.some(c=>c.includes('rev-list --parents -n 1')));
      assert.ok(receipt.calls.some(c=>c.includes('reset --hard '+SHA_NEW)));
      assert.ok(!receipt.calls.some(c=>c.includes('pull --ff-only')),
        'The parentless root cannot be fast-forwarded; never silently attempt a pull');
    }
    if(scenario==='sqlite_damaged_during_upgrade'){
      assert.notEqual(receipt.sqliteSha256,sqliteDigest,
        'deliberately damaged SQLite must never be mistaken for restored source');
      assert.equal(receipt.drain,true,'damaged live data must retain the maintenance fence');
    }else{
      assert.equal(receipt.sqliteSha256,sqliteDigest,
        `${scenario}: original SQLite bytes must remain unchanged`);
      const readback=new DatabaseSync(dbFile,{readOnly:true});
      try{
        assert.equal(readback.prepare('PRAGMA integrity_check').get()?.integrity_check,'ok');
        const mission=readback.prepare('SELECT state,turn_count,stop_requested FROM missions')
          .get() as {state:string;turn_count:number;stop_requested:number};
        assert.equal(mission.state,'PAUSED');
        assert.equal(mission.turn_count,10);
        assert.equal(mission.stop_requested,1);
        assert.equal(readback.prepare('SELECT status FROM requests').get()?.status,'reconciled');
      }finally{readback.close();}
    }
    return receipt;
  }finally{rmSync(fixture,{recursive:true,force:true});}
}

test('actual Windows Upgrade branch resists injected health, version, SQLite, build, restore, rollback and release failures',
  {skip:process.platform!=='win32'},t=>{
    const scenarios=[
      {name:'success',outcome:'success',head:SHA_NEW,drain:false,worker:true,releases:1},
      {name:'recovery_trigger_race',outcome:'success',head:SHA_NEW,
        drain:false,worker:true,releases:1},
      {name:'history_reset',outcome:'success',head:SHA_NEW,
        drain:false,worker:true,releases:1},
      ...['history_reset_has_parent','health_after_upgrade','version_after_upgrade','sqlite_after_upgrade',
        'damaged_build_manifest','damaged_build_cli','pre_admission_unsettled',
        'journal_failure','restore_failure','browser_binding_failure',
        'git_fetch_failure','git_pull_failure','npm_build_failure',
        'worker_start_timeout','snapshot_backup_failure']
        .map(name=>({name,outcome:'error',head:SHA_OLD,drain:false,worker:true,releases:1})),
      ...['sqlite_damaged_during_upgrade','damaged_rollback_image',
        'rollback_start_failure']
        .map(name=>({name,outcome:'error',head:SHA_OLD,drain:true,worker:false,releases:0})),
      {name:'release_after_rollback',outcome:'error',head:SHA_OLD,
        drain:true,worker:true,releases:0},
      {name:'release_after_upgrade',outcome:'error',head:SHA_NEW,drain:true,worker:true,releases:0},
      {name:'drain_receipt_mismatch',outcome:'error',head:SHA_OLD,
        drain:true,worker:true,releases:0},
      {name:'post_release_success_audit',outcome:'error',head:SHA_NEW,
        drain:false,worker:true,releases:1},
      {name:'post_release_rollback_audit',outcome:'error',head:SHA_OLD,
        drain:false,worker:true,releases:1},
    ] as const;
    for(const expected of scenarios){
      const receipt=exercise(expected.name);
      assert.equal(receipt.outcome,expected.outcome,`${expected.name}: ${receipt.reason}`);
      assert.equal(receipt.head,expected.head,expected.name);
      assert.equal(receipt.drain,expected.drain,expected.name);
      assert.equal(receipt.worker,expected.worker,expected.name);
      assert.equal(receipt.releases,expected.releases,expected.name);
      if(expected.name.startsWith('post_release_')){
        const releaseAt=receipt.calls.lastIndexOf('atomic-release');
        assert.ok(releaseAt>=0);
        assert.ok(!receipt.calls.slice(releaseAt+1).includes('stop-worker'),
          'post-release audit failure must never interrupt newly admitted work');
        assert.match(receipt.reason,/post-release audit|Synthetic post-release audit/i);
      }
      assert.equal(receipt.resumes,0,'no authorized Mission was resumed');
      if(expected.name!=='drain_receipt_mismatch')
        assert.ok(receipt.stages.includes('drain_acquired'));
      else assert.ok(!receipt.stages.includes('worker_stopped'),
        'a mismatched original drain receipt must not stop the previous Worker');
      if(expected.outcome==='success')assert.ok(receipt.stages.includes('complete'));
      else assert.ok(!receipt.stages.includes('complete'));
      t.diagnostic('MR_UPGRADE_FAULT_RECEIPT='+JSON.stringify({
        ...receipt,stages:receipt.stages.filter(s=>[
          'drain_acquired','compiled','worker_healthy','fenced_acceptance_verified',
          'upgrade_failed','rollback_verified','rollback_unverified','drain_released','complete'
        ].includes(s)),
      }));
    }
  });
