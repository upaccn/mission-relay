import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/core/store.js';
import {assessGmkReadback,assertStableGmkChannel,gmkProductionReleaseProbe,
  assessReleaseWorkerIdentity,assertStableReleaseWorkerIdentity,
  withStableReleaseWorkerIdentity,
  matchesOriginalReviewedRequest,
  type GmkReadback} from '../src/core/goal-release-runtime.js';
import type {RequestCustody} from '../src/core/request-ledger.js';
import type {ChatBrowserTurn} from '../src/core/store.js';

const target='a'.repeat(40),prompt='b'.repeat(64),answer='c'.repeat(64);
function original():GmkReadback{
  const source={sourceSha:target,compiledTreeSha256:'d'.repeat(64),
    cliSha256:'e'.repeat(64),manifestSha256:'f'.repeat(64),fileCount:32};
  return {
    source,channel:{source:'telegram',inboxCursor:42,notificationsCursor:70,lastEventId:70,
      pollerPresent:true,pollerPid:12345,transportHealth:'healthy',
      drainRequested:false,pendingReplies:0,runtimeProvenance:{...source,pid:12345,
        at:'2026-11-08T00:00:00.000Z'}},
    task:{installed:true,taskVerified:true,taskState:'Running',
      recoverySchedule:true,pollerPresent:true,pollerPid:12345,
      transportHealth:'healthy',workerProcessVerified:true,
      workerProcessStartedAt:'2026-11-07T23:59:59.000Z',
      workerParentStartedAt:'2026-11-07T23:59:58.000Z'},
    sqliteIntegrity:'ok',foreignKeyViolations:0,
    chrome:{exactUrl:true,promptSha256:prompt,answerSha256:answer,
      stable:true,composerReady:true,generating:false},
    expectedPromptSha256:prompt,expectedAnswerSha256:answer,
  };
}

test('G1: exact GMK Worker, compiled bytes, enrolled task, SQLite and stable Chrome all required',()=>{
  assert.doesNotThrow(()=>assessGmkReadback(target,original()));
  const bad: Array<[string,(r:GmkReadback)=>void]>= [
    ['wrong installed SHA',r=>{r.source.sourceSha='0'.repeat(40);}],
    ['wrong Worker SHA',r=>{r.channel.runtimeProvenance!.sourceSha='0'.repeat(40);}],
    ['wrong compiled tree',r=>{r.channel.runtimeProvenance!.compiledTreeSha256='0'.repeat(64);}],
    ['wrong compiled entrypoint',r=>{r.channel.runtimeProvenance!.cliSha256='0'.repeat(64);}],
    ['wrong manifest',r=>{r.channel.runtimeProvenance!.manifestSha256='0'.repeat(64);}],
    ['missing Worker lease attestation',r=>{r.channel.runtimeProvenance!.at='';}],
    ['malformed Worker lease attestation',r=>{r.channel.runtimeProvenance!.at='invalid';}],
    ['non-string Worker lease attestation',r=>{
      r.channel.runtimeProvenance!.at=123 as unknown as string;
    }],
    ['future Worker lease attestation',r=>{
      r.channel.runtimeProvenance!.at='2999-01-01T00:00:00.000Z';
    }],
    ['missing Worker lease',r=>{r.channel.pollerPresent=false;}],
    ['stale transport',r=>{r.channel.transportHealth='stale';}],
    ['mismatched PID',r=>{r.channel.pollerPid=4;}],
    ['maintenance drain',r=>{r.channel.drainRequested=true;}],
    ['unacknowledged reply',r=>{r.channel.pendingReplies=1;}],
    ['undelivered event notification',r=>{r.channel.notificationsCursor=69;}],
    ['impossible event cursor',r=>{r.channel.notificationsCursor=71;}],
    ['invalid inbound cursor',r=>{r.channel.inboxCursor=NaN;}],
    ['wrong channel',r=>{r.channel.source='other';}],
    ['unverified scheduled task',r=>{r.task.taskVerified=false;}],
    ['wrong task state',r=>{r.task.taskState='Ready';}],
    ['wrong task account/identity evidence',r=>{r.task.installed=false;}],
    ['missing recovery trigger',r=>{r.task.recoverySchedule=false;}],
    ['task PID mismatch',r=>{r.task.pollerPid=999;}],
    ['broken SQLite integrity',r=>{r.sqliteIntegrity='corrupt';}],
    ['broken SQLite foreign keys',r=>{r.foreignKeyViolations=1;}],
    ['nonunique or moved Chrome tab',r=>{r.chrome.exactUrl=false;}],
    ['unstable browser DOM',r=>{r.chrome.stable=false;}],
    ['browser still generating',r=>{r.chrome.generating=true;}],
    ['browser not authenticated',r=>{r.chrome.composerReady=false;}],
    ['different last user prompt',r=>{r.chrome.promptSha256='0'.repeat(64);}],
    ['different full answer',r=>{r.chrome.answerSha256='0'.repeat(64);}],
    ['unobserved assistant answer',r=>{r.chrome.answerSha256=null;}],
  ];
  for(const [name,mutate] of bad){
    const fixture=original();
    mutate(fixture);
    assert.throws(()=>assessGmkReadback(target,fixture),/GMK/,name);
  }
});

test('G1: a maintenance drain, pending notification, or Worker replacement AFTER Chrome readback fails closed',()=>{
  const before=original().channel;
  assert.doesNotThrow(()=>assertStableGmkChannel(before,{...before}));
  for(const change of [
    {drainRequested:true},{pendingReplies:1},
    {inboxCursor:43},{notificationsCursor:71},{lastEventId:71},
    {pollerPid:9999},{pollerPresent:false},
    {transportHealth:'stale'},
    {runtimeProvenance:{...before.runtimeProvenance!,pid:9999}},
    {runtimeProvenance:null},
  ]){
    assert.throws(()=>assertStableGmkChannel(before,{...before,...change}),
      /unsafe during read-only Chrome inspection/,
      JSON.stringify(change));
  }
});

test('trusted runtime probes require an enrolled, exact-SHA leased Worker before and after physical inspection',()=>{
  const now=Date.parse('2026-11-08T00:00:10.000Z');
  const good=original();
  const before=assessReleaseWorkerIdentity(target,good.source,good.channel,good.task,now);
  assert.deepEqual(before,{source:good.source,workerPid:12345,inboxCursor:42,
    workerAttestedAt:'2026-11-08T00:00:00.000Z',
    workerProcessStartedAt:'2026-11-07T23:59:59.000Z',
    workerParentStartedAt:'2026-11-07T23:59:58.000Z',
    notificationsCursor:70,lastEventId:70,enrolledTaskVerified:true});
  assert.doesNotThrow(()=>assertStableReleaseWorkerIdentity(before,{...before}));
  const skewed=original();
  skewed.channel.runtimeProvenance!.at='2026-11-08T00:00:40.000Z';
  assert.doesNotThrow(()=>assessReleaseWorkerIdentity(target,skewed.source,
    skewed.channel,skewed.task,now),'30 seconds of host clock skew is tolerated');
  skewed.channel.runtimeProvenance!.at='2026-11-08T00:00:40.001Z';
  assert.throws(()=>assessReleaseWorkerIdentity(target,skewed.source,
    skewed.channel,skewed.task,now),/enrolled, healthy exact-SHA Worker identity/);
  const bad:Array<[string,(r:GmkReadback)=>void]>=[
    ['offline checkout',r=>{r.channel.pollerPresent=false;}],
    ['wrong source commit',r=>{r.source.sourceSha='0'.repeat(40);}],
    ['wrong compiled tree',r=>{r.channel.runtimeProvenance!.compiledTreeSha256='0'.repeat(64);}],
    ['wrong compiled CLI',r=>{r.channel.runtimeProvenance!.cliSha256='0'.repeat(64);}],
    ['wrong manifest',r=>{r.channel.runtimeProvenance!.manifestSha256='0'.repeat(64);}],
    ['missing lease attestation',r=>{r.channel.runtimeProvenance!.at='';}],
    ['null lease attestation',r=>{r.channel.runtimeProvenance!.at=null as unknown as string;}],
    ['undefined lease attestation',r=>{r.channel.runtimeProvenance!.at=undefined as unknown as string;}],
    ['non-string lease attestation',r=>{r.channel.runtimeProvenance!.at=17 as unknown as string;}],
    ['malformed lease attestation',r=>{r.channel.runtimeProvenance!.at='not-a-date';}],
    ['future lease attestation',r=>{r.channel.runtimeProvenance!.at='2999-01-01T00:00:00Z';}],
    ['wrong Worker PID',r=>{r.channel.pollerPid=999;}],
    ['unverified enrolled task',r=>{r.task.taskVerified=false;}],
    ['unverified actual task child',r=>{r.task.workerProcessVerified=false;}],
    ['missing process creation time',r=>{r.task.workerProcessStartedAt=null;}],
    ['malformed process creation time',r=>{r.task.workerProcessStartedAt='bad';}],
    ['non-string process creation time',r=>{
      r.task.workerProcessStartedAt=123 as unknown as string;
    }],
    ['ambiguous equal-millisecond parent creation',r=>{
      r.task.workerParentStartedAt=r.task.workerProcessStartedAt;
    }],
    ['reused PID born after retained lease attestation',r=>{
      r.task.workerProcessStartedAt='2026-11-08T00:00:00.001Z';
    }],
    ['ambiguous PID birth in same millisecond as original attestation',r=>{
      r.task.workerProcessStartedAt='2026-11-08T00:00:00.000Z';
    }],
    ['new task parent born after original child',r=>{
      r.task.workerParentStartedAt='2026-11-08T00:00:00.001Z';
    }],
    ['second task PID',r=>{r.task.pollerPid=999;}],
    ['maintenance drain',r=>{r.channel.drainRequested=true;}],
    ['pending request reply',r=>{r.channel.pendingReplies=1;}],
    ['unscanned notification',r=>{r.channel.notificationsCursor=69;}],
    ['stale Telegram transport',r=>{r.channel.transportHealth='stale';}],
  ];
  for(const [name,change] of bad){
    const r=original();change(r);
    assert.throws(()=>assessReleaseWorkerIdentity(target,r.source,r.channel,r.task,now),
      /enrolled, healthy exact-SHA Worker identity/,name);
  }
  assert.throws(()=>assessReleaseWorkerIdentity(target,good.source,good.channel,
    good.task,Number.NaN),/enrolled, healthy exact-SHA Worker identity/,
  'A non-finite injected test clock cannot bypass the attestation check');
  assert.throws(()=>assertStableReleaseWorkerIdentity(before,
    {...before,workerPid:999}),/changed during evidence inspection/);
  assert.throws(()=>assertStableReleaseWorkerIdentity(before,
    {...before,notificationsCursor:71}),/changed during evidence inspection/);
  assert.throws(()=>assertStableReleaseWorkerIdentity(before,
    {...before,workerAttestedAt:'2026-11-08T00:00:00.001Z'}),
  /changed during evidence inspection/,
  'Same-PID Worker re-attestation cannot reuse a previous successful inspection');
  assert.throws(()=>assertStableReleaseWorkerIdentity(before,
    {...before,workerProcessStartedAt:'2026-11-07T23:59:59.001Z'}),
  /changed during evidence inspection/,
  'Same-PID process replacement during readback cannot reuse a prior PASS');
  assert.throws(()=>assertStableReleaseWorkerIdentity(before,
    {...before,source:{...before.source,sourceSha:'0'.repeat(40)}}),
  /changed during evidence inspection/);
});

test('enrolled Windows Worker identity script parses with the actual PowerShell 7 parser',
  {skip:process.platform!=='win32'},()=>{
    const script=join(process.cwd(),'scripts','windows','telegram-task.ps1')
      .replaceAll("'","''");
    const command=`$tokens=$null;$errors=$null;`+
      `[System.Management.Automation.Language.Parser]::ParseFile('${script}',`+
      `[ref]$tokens,[ref]$errors)|Out-Null;`+
      `if($errors.Count -gt 0){$errors|Out-String|Write-Error;exit 2}`;
    const parsed=spawnSync('pwsh',['-NoProfile','-NonInteractive','-Command',command],{
      encoding:'utf8',timeout:20_000,windowsHide:true,shell:false,
    });
    assert.equal(parsed.status,0,`Windows PowerShell parse failed: ${parsed.stderr}`);
  });

test('actual Windows task identity helper rejects PID-reuse command substitutions',
  {skip:process.platform!=='win32'},()=>{
    const result=spawnSync('pwsh',['-NoProfile','-NonInteractive','-File',
      join(process.cwd(),'tests','windows-worker-process-identity.ps1')],{
      encoding:'utf8',timeout:20_000,windowsHide:true,shell:false,
    });
    assert.equal(result.status,0,`PowerShell identity helper failed: ${result.stderr}`);
    assert.match(result.stdout,/PASS: real PowerShell Worker identity helper/);
  });

test('independent CLI accepts a distinct verified Worker PID but never returns a stale inspector PASS',async()=>{
  const observed=original();
  const worker=assessReleaseWorkerIdentity(target,observed.source,
    observed.channel,observed.task,Date.parse('2026-11-08T00:00:10.000Z'));
  assert.notEqual(worker.workerPid,process.pid,
    'The enrolled Worker is intentionally distinct from this independent test/CLI process');
  let reads=0,inspections=0;
  const read=()=>{reads++;return {...worker};};
  const good=await withStableReleaseWorkerIdentity(read,identity=>{
    inspections++;assert.equal(identity.workerPid,12345);
    return {state:'PASS',observedSha:target};
  });
  assert.deepEqual(good,{state:'PASS',observedSha:target});
  assert.equal(reads,2);assert.equal(inspections,1);
  reads=0;inspections=0;
  await assert.rejects(withStableReleaseWorkerIdentity(()=>{
    const r=original();
    if(++reads===2)r.task.taskVerified=false;
    return assessReleaseWorkerIdentity(target,r.source,r.channel,r.task,
      Date.parse('2026-11-08T00:00:10.000Z'));
  },async()=>{inspections++;return {state:'PASS',observedSha:target};}),
  /enrolled, healthy exact-SHA Worker identity/,
  'A Scheduled Task replacement during physical Chrome readback cannot certify GMK');
  assert.equal(reads,2);assert.equal(inspections,1);
  reads=0;inspections=0;
  await assert.rejects(withStableReleaseWorkerIdentity(()=>{
    if(++reads===1)return worker;
    return {...worker,workerPid:999};
  },async()=>{
    inspections++;return {state:'PASS',observedSha:target};
  }),/changed during evidence inspection/);
  assert.equal(reads,2);assert.equal(inspections,1,
    'A successful earlier observation is not returned after lease replacement');
  reads=0;inspections=0;
  await assert.rejects(withStableReleaseWorkerIdentity(()=>{
    const r=original();
    if(++reads===2)
      r.channel.runtimeProvenance!.at='2026-11-08T00:00:00.001Z';
    return assessReleaseWorkerIdentity(target,r.source,r.channel,r.task,
      Date.parse('2026-11-08T00:00:10.000Z'));
  },async()=>{inspections++;return {state:'PASS',observedSha:target};}),
  /changed during evidence inspection/,
  'Same-PID and same-cursor re-attestation must invalidate the full inspection');
  assert.equal(reads,2);assert.equal(inspections,1);
  inspections=0;
  await assert.rejects(withStableReleaseWorkerIdentity(()=>{
    throw new Error('No trusted enrolled Worker');
  },()=>{inspections++;return {state:'PASS'};}),/No trusted enrolled Worker/);
  assert.equal(inspections,0,'An offline CLI never invokes the physical inspector');
});

test('G1: request identity must be bound to original key, not interchangeable reply text',()=>{
  const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
  const originalKey='request-A',differentKey='request-B';
  const ledger={status:'observed',requestSha256:hash(originalKey),
    promptSha256:prompt,answerSha256:answer,observationEventId:12,
    decisionEventId:13} as RequestCustody;
  const receipt={requestKey:originalKey,promptSha256:prompt,
    assistantSha256:answer} as ChatBrowserTurn;
  assert.equal(matchesOriginalReviewedRequest(ledger,receipt),true);
  assert.equal(matchesOriginalReviewedRequest(ledger,
    {...receipt,status:'reconciled'}),true,
    'Independently recovered replies can be source-linked after their separate recovery audit');
  assert.equal(matchesOriginalReviewedRequest(ledger,
    {...receipt,requestKey:differentKey}),false,'Identical content must not cross-credit another Send');
  assert.equal(matchesOriginalReviewedRequest({...ledger,decisionEventId:null},receipt),false);
  assert.equal(matchesOriginalReviewedRequest({...ledger,observationEventId:null},receipt),false);
  assert.equal(matchesOriginalReviewedRequest({...ledger,status:'pending'},receipt),false);
  assert.equal(matchesOriginalReviewedRequest({...ledger,promptSha256:'0'.repeat(64)},receipt),false);
  assert.equal(matchesOriginalReviewedRequest({...ledger,answerSha256:'0'.repeat(64)},receipt),false);
});

test('G1: trusted GMK probe is requirement-scoped, platform-scoped and never sends',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'mr-gmk-release-'));
  const store=new Store(join(dir,'missions.sqlite'));
  try {
    const probe=gmkProductionReleaseProbe(store,'123e4567-e89b-42d3-a456-426614174000',
      join(dir,'private-proof'));
    const eventCountBefore=store.maxEventId();
    const metaCountBefore=(store.db.prepare('SELECT COUNT(*) AS n FROM meta').get() as {n:number}).n;
    assert.equal(probe.source,'gmk-readback');
    await assert.rejects(probe.inspect('ci-windows',target),/cannot certify other release gates/);
    if(process.platform!=='win32')
      await assert.rejects(probe.inspect('gmk-production-readback',target),
        /only on the enrolled Windows host/);
    assert.equal(store.maxEventId(),eventCountBefore,'No Mission or Goal events were added');
    assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM meta').get() as {n:number}).n,
      metaCountBefore,'No SQLite metadata was written');
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('G1: Windows Status task attestation reuses the existing read-only identity fence',()=>{
  const source=readFileSync('scripts/windows/telegram-task.ps1','utf8');
  const status=source.slice(source.indexOf("    'Status' {"),source.indexOf("    'UpgradeSchedule' {"));
  assert.match(status, /if \(\$task\) \{ \$null = Assert-OurTask; \$taskVerified = \$true \}/);
  assert.match(status,/taskVerified=\$taskVerified/);
  assert.doesNotMatch(status,/Start-ScheduledTask|Stop-ScheduledTask|Set-ScheduledTask|Register-ScheduledTask/);
});
