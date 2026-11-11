import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/core/store.js';
import {GoalLedger} from '../src/core/goal-store.js';
import {GoalReleaseGate} from '../src/core/goal-release.js';
import {goalWorkPrompt} from '../src/core/goal-prompts.js';
import {approvedWorkTestPath,remoteReleaseCommand} from '../src/core/goal-release-remote.js';
import type {RemoteWorkTestResult} from '../src/core/goal-release-remote.js';
import {assessWorkTestOutput,assessWorkTestExecution,inspectIndependentWorkCriterion,
  type IndependentWorkSpecification} from '../src/core/goal-release-work-probe.js';

const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const target='c'.repeat(40);
const EXACT_HEAD=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const url='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174000';
const answer='Complete fictional work result\n[MISSION_RELAY:NEXT]';
const name='independently verifies the exact isolated owner criterion';
const passed='TAP version 13\n# Subtest: '+name+
  '\nok 1 - '+name+'\n1..1\n# tests 1\n# suites 0\n# pass 1\n# fail 0\n'+
  '# cancelled 0\n# skipped 0\n# todo 0\n';
function syntheticExecution(stdout:string,exit:number,sourceSha:string,
  testFile:string):RemoteWorkTestResult {
  // This test-only wrapper is deliberately synthetic; production must obtain
  // its unique session/host/PID from authenticated operator-managed host SSH stderr.
  const sessionId='a'.repeat(32),host='isolated-fixture',pid=4321;
  const config={sshHost:'fixture-operator',project:'/srv/projects/mission-relay'};
  const at=new Date().toISOString();
  return {stdout,exit,
    stderr:`MR_WORK_TEST_SESSION_V1\t${sessionId}\t${host}\t${pid}\n`,
    execution:{executor:'approved-operator-ssh',sessionId,remoteHostAlias:'fixture-operator',
      remoteProject:config.project,remoteHostname:host,shellPid:pid,
      commandSha256:sha(remoteReleaseCommand(config,'work-test',testFile,sessionId)),
      sourceSha,testFile,startedAt:at,finishedAt:at}};
}
function fixture(sourceSha=target,workObservation:'direct'|'recovered'='direct'){
  const home=mkdtempSync(join(tmpdir(),'relay-work-attestation-'));
  const store=new Store(join(home,'isolated.sqlite')),ledger=new GoalLedger(store);
  const goal=ledger.createGoal({requestKey:'fake-work-proof',objective:'Verify an isolated requested fix',
    priority:100});
  const plan=ledger.createPlan(goal.id,goal.version,{
    requestKey:'fake-approved-plan',summary:'Approved fixture proof scope',
    items:[{key:'verified-fix',title:'Execute synthetic test',priority:80,
      acceptance:['The original synthetic controller accepts only expected values']}]});
  ledger.setPlanStatus(goal.id,plan.id,plan.version,'APPROVED','approve');
  ledger.setGoalStatus(goal.id,ledger.getGoal(goal.id).version,'ACTIVE','activate');
  const work=ledger.graph(goal.id).items[0]!;
  const ready=ledger.setWorkStatus(goal.id,work.id,work.version,'READY',[],'ready');
  ledger.setWorkStatus(goal.id,work.id,ready.version,'IN_PROGRESS',[],'start');
  const m=store.create({goal:goal.objective,acceptance:['fixture'],workspace:'',
    sandbox:'read-only',mode:'supervised',maxTurns:32,checks:[],
    requestKey:'synthetic-work-mission'});
  const linked=store.linkChat(m.id,url,m.version).mission;
  const bound=store.bindChatBrowser(m.id,'fixture-physical-browser',linked.version).mission;
  store.setMeta('pi.autopilot.enabled.'+m.id,'1');
  ledger.bindPiMission(goal.id,m.id,bound.version,'mission-bind');
  store.reserveChatBrowserTurn(m.id,store.get(m.id).version,'planning',
    sha('synthetic initial goal planning'),{newConversation:true});
  store.finishChatBrowserTurn(m.id,'planning',{kind:'observed',
    assistantSha256:sha('Planning\n[MISSION_RELAY:NEXT]'),
    summary:'Planning\n[MISSION_RELAY:NEXT]',
    newChatUrl:'https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174001',
    newChatTargetSha256:sha('physical-chat')});
  store.commitPiPlan(m.id,sha('Planning\n[MISSION_RELAY:NEXT]'),[],{
    action:'NEXT',summary:'Plan approved',nextPrompt:'Do the one isolated test'});
  const boundPrompt=goalWorkPrompt(store,m.id,store.piPlan(m.id)!,null,false);
  store.reserveChatBrowserTurn(m.id,store.get(m.id).version,'work-answer',
    sha(boundPrompt.prompt.trim()),{
      promptSnapshot:{format:'goal-work-v1',prompt:boundPrompt.prompt},
      goalBinding:boundPrompt.binding});
  if(workObservation==='recovered'){
    store.finishChatBrowserTurn(m.id,'work-answer',{kind:'uncertain',
      error:'Synthetic observer lost the original reply after one Send'});
    store.recoverObservedBrowserTurn(m.id,store.get(m.id).version,{
      requestPromptSha256:sha(boundPrompt.prompt.trim()),
      assistantSha256:sha(answer),summary:answer});
  }else store.finishChatBrowserTurn(m.id,'work-answer',{kind:'observed',
    assistantSha256:sha(answer),summary:answer});
  store.commitPiPlan(m.id,sha(answer),[],{
    action:'DONE',summary:'Synthetic implementation done',nextPrompt:''});
  ledger.recordPiReview(goal.id,m.id,work.id,2,sha(answer),'PASS',
    ['browser-sha256:'+sha(answer)],'Observed synthetic verification','review');
  const review=ledger.setWorkStatus(goal.id,work.id,
    ledger.getWork(goal.id,work.id).version,'REVIEW',[],'work-in-review');
  const check=ledger.graph(goal.id).acceptance[0]!;
  ledger.recordAcceptance(goal.id,check.id,check.version,'PASS',
    ['browser-sha256:'+sha(answer)],'acceptance-pass');
  ledger.setWorkStatus(goal.id,work.id,review.version,'PASSED',
    ['browser-sha256:'+sha(answer)],'pass');
  const evidence=join(home,'private-evidence');
  const rule={acceptanceId:check.id,workItemId:work.id,
    criterionSha256:sha(check.criterion),testFile:'tests/request-ledger.test.ts',
    testName:name,answerSha256:sha(answer)};
  const spec:IndependentWorkSpecification={version:1,goalId:goal.id,
    sourceSha,criteria:[rule]};
  const save=()=>writeFileSync(join(evidence,'independent-work-map.json'),
    JSON.stringify(spec),{mode:0o600});
  mkdirSync(evidence,{recursive:true});
  save();
  const evaluate=(runTest:(sha:string,file:string)=>{stdout:string;exit:number}=
    ()=>({stdout:passed,exit:0}))=>inspectIndependentWorkCriterion({
    store,goalId:goal.id,requirement:'criterion:'+check.id,
    targetSha:sourceSha,privateDir:evidence,
    runTest:(sha,file)=>{
      const r=runTest(sha,file);
      return syntheticExecution(r.stdout,r.exit,sha,file);
    }});
  return {home,store,ledger,goal,work,check,spec,rule,evidence,save,evaluate,
    missionId:m.id,
    close:()=>{store.close();rmSync(home,{recursive:true,force:true});}};
}

test('operator-mapped criterion executes a uniquely passing test and retains source-SHA-bound private evidence',async()=>{
  const f=fixture();try{
    const read=await f.evaluate();
    assert.equal(read.state,'PASS');
    assert.equal(read.observedSha,target);
    const raw=readFileSync(join(f.evidence,'work-receipt-'+read.proofSha256+'.json'),'utf8');
    assert.equal(sha(raw),read.proofSha256);
    const receipt=JSON.parse(raw);
    assert.equal(receipt.workItemKey,'verified-fix');
    assert.equal(receipt.workItemId,f.work.id);
    assert.equal(receipt.source,target);
    assert.equal(receipt.probeVersion,1);
    assert.equal(receipt.targetSha,target);
    assert.equal(receipt.scenario,
      'original-pi-approved-criterion-executed-by-independent-operator-test');
    assert.equal(receipt.testFile,f.rule.testFile);
    assert.equal(receipt.testName,name);
    assert.equal(receipt.testExitCode,0);
    assert.equal(receipt.answerOrigin,'direct-browser');
    assert.equal(receipt.recoveryReconciliationEventId,null);
    assert.ok(receipt.originalReservationEventId<receipt.originalObservationEventId);
    assert.ok(receipt.originalObservationEventId<receipt.originalDecisionEventId);
    assert.deepEqual(receipt.eventReferences,{
      originalReservationEventId:receipt.originalReservationEventId,
      originalObservationEventId:receipt.originalObservationEventId,
      originalDecisionEventId:receipt.originalDecisionEventId,
      recoveryReconciliationEventId:null});
    assert.equal(receipt.observedOutcome,'PASS');
    assert.equal(receipt.expectedOutcome,'PASS');
    assert.equal(receipt.evidenceProvenance,
      'authenticated-operator-ssh-tracked-test-and-original-pi-request');
    assert.equal(receipt.testLogSha256,sha(passed));
    assert.equal(receipt.testStderrSha256,sha(`MR_WORK_TEST_SESSION_V1\t${'a'.repeat(32)}\tisolated-fixture\t4321\n`));
    assert.equal(receipt.executorSession.sourceSha,target);
    assert.equal(receipt.executorSession.testFile,f.rule.testFile);
    assert.equal(receipt.executorSession.sessionId,'a'.repeat(32));
    assert.equal(readFileSync(join(f.evidence,'work-stderr-'+receipt.testStderrSha256+'.log'),'utf8'),
      `MR_WORK_TEST_SESSION_V1\t${'a'.repeat(32)}\tisolated-fixture\t4321\n`);
    assert.equal(readFileSync(join(f.evidence,'work-test-'+sha(passed)+'.tap'),'utf8'),passed);
    const gate=new GoalReleaseGate(f.store);
    gate.begin(f.goal.id,target);
    const accepted=await gate.inspect(f.goal.id,'criterion:'+f.check.id,{
      source:'independent-work',inspect:async()=>f.evaluate()});
    assert.equal(accepted.checks.find(c=>c.requirement==='criterion:'+f.check.id)?.state,'PASS');
    assert.equal(accepted.ready,false);
  }finally{f.close();}
});

test('a recovered original answer is separately attributed, independently tested and never replayed',async t=>{
  const f=fixture(target,'recovered');
  try{
    const before=f.store.events(f.missionId);
    assert.equal(before.filter(e=>e.type==='chatgpt.browser_reserved').length,2);
    assert.equal(before.filter(e=>e.type==='chatgpt.browser_uncertain').length,1);
    assert.equal(before.filter(e=>e.type==='chatgpt.browser_turn_recovered').length,1);
    const read=await f.evaluate();
    const raw=readFileSync(join(f.evidence,'work-receipt-'+read.proofSha256+'.json'),'utf8');
    const receipt=JSON.parse(raw);
    assert.equal(read.state,'PASS');
    assert.equal(receipt.answerOrigin,'independently-recovered');
    assert.equal(receipt.originalObservationSha256.length,64);
    assert.equal(receipt.answerSha256,sha(answer));
    assert.ok(receipt.recoveryReconciliationEventId>receipt.originalReservationEventId);
    assert.ok(receipt.originalObservationEventId>receipt.recoveryReconciliationEventId);
    assert.deepEqual(f.store.events(f.missionId),before);
    assert.equal(f.store.get(f.missionId).turnCount,2);
    t.diagnostic('MR_PROBE_RECEIPT='+JSON.stringify({kind:'independent-recovered-answer',
      testedSha:target,fixture:'isolated SQLite',source:'original recovered turn event',
      originalReservationEventId:receipt.originalReservationEventId,
      recoveryEventId:receipt.originalObservationEventId,
      recoveryReconciliationEventId:receipt.recoveryReconciliationEventId,
      independentTestSha256:receipt.testLogSha256,receiptSha256:read.proofSha256,
      noAdditionalSend:true,originalEventsUnchanged:true}));
  }finally{f.close();}
});

test('an answer SHA and PI PASS cannot conceal forged recovery provenance',async()=>{
  const cases=[
    {name:'not independently inspected',type:'chatgpt.browser_turn_recovered',
      change:(p:Record<string,unknown>)=>({...p,independentlyInspected:false})},
    {name:'wrong original reservation custody',type:'chatgpt.browser_turn_recovered',
      change:(p:Record<string,unknown>)=>({...p,originalReservationPreserved:false})},
    {name:'fake old uncertainty',type:'chatgpt.browser_turn_recovered',
      change:(p:Record<string,unknown>)=>({...p,originalUncertainEventPreserved:false})},
    {name:'forged dead-owner branch',type:'chatgpt.browser_turn_recovered',
      change:(p:Record<string,unknown>)=>({...p,recoverySource:'dead-owner-reserved'})},
    {name:'wrong reconciliation kind',type:'mission.reconciled',
      change:(p:Record<string,unknown>)=>({...p,kind:'unknown-recovery'})},
  ];
  for(const c of cases){
    const f=fixture(target,'recovered');
    try{
      const e=f.store.events(f.missionId).find(x=>x.type===c.type)!;
      assert.ok(e,c.name);
      f.store.db.prepare('UPDATE events SET payload_json=? WHERE id=?')
        .run(JSON.stringify(c.change(e.payload as Record<string,unknown>)),e.id);
      let launches=0;
      await assert.rejects(f.evaluate(()=>{launches++;return {stdout:passed,exit:0};}),
        undefined,c.name);
      assert.equal(launches,0,c.name);
      assert.equal(f.store.get(f.missionId).turnCount,2,c.name);
      assert.equal(f.store.events(f.missionId)
        .filter(x=>x.type==='chatgpt.browser_reserved').length,2,c.name);
    }finally{f.close();}
  }
});

test('actual tracked test subprocess produces SHA-bound independent acceptance without another browser Send',async t=>{
  const f=fixture(EXACT_HEAD);
  try{
    // Unlike the TAP string used for parser fault-injection, this executes
    // the real tracked file in a separate Node process and reads its exit.
    f.rule.testName='parallel Store handles cannot reserve or settle the same request twice; restart never replays history';
    f.save();
    const originalReservations=f.store.events(f.store.db.prepare(
      'SELECT id FROM missions LIMIT 1').get()?.id as string)
      .filter(e=>e.type==='chatgpt.browser_reserved').length;
    const originalEventId=f.store.maxEventId();
    let launches=0,realProcessExit:number|null=null,realStdoutSha:string|null=null;
    const read=await f.evaluate((sourceSha,file)=>{
      assert.equal(sourceSha,EXACT_HEAD);
      assert.equal(file,approvedWorkTestPath('tests/request-ledger.test.ts'));
      launches++;
      // Node's test runner marks its worker with NODE_TEST_CONTEXT=child-v8.
      // A nested real process must have its own test-runner boundary.
      const childEnv={...process.env};delete childEnv.NODE_TEST_CONTEXT;
      const result=spawnSync(process.execPath,
        ['--import','tsx','--test','--test-reporter=tap',file],{
          cwd:process.cwd(),encoding:'utf8',env:childEnv,timeout:120_000,
          maxBuffer:16*1024*1024,shell:false});
      assert.equal(result.error,undefined);
      assert.equal(result.status,0,'Actual tracked test subprocess failed: '+
        String(result.stderr).slice(0,1200));
      realProcessExit=result.status;
      realStdoutSha=sha(result.stdout);
      return {stdout:result.stdout,exit:result.status??-1};
    });
    assert.equal(launches,1);
    assert.equal(realProcessExit,0);
    assert.equal(read.state,'PASS');
    assert.equal(read.observedSha,EXACT_HEAD);
    const raw=readFileSync(join(f.evidence,'work-receipt-'+read.proofSha256+'.json'),'utf8');
    assert.equal(sha(raw),read.proofSha256);
    const receipt=JSON.parse(raw);
    assert.equal(receipt.testFile,f.rule.testFile);
    assert.equal(receipt.testName,f.rule.testName);
    assert.equal(receipt.testExitCode,0);
    assert.equal(receipt.testLogSha256,realStdoutSha);
    assert.equal(receipt.source,EXACT_HEAD);
    assert.equal(receipt.observedOutcome,'PASS');
    assert.equal(f.store.maxEventId(),originalEventId);
    const afterReservations=f.store.events(f.store.db.prepare(
      'SELECT id FROM missions LIMIT 1').get()?.id as string)
      .filter(e=>e.type==='chatgpt.browser_reserved').length;
    assert.equal(afterReservations,originalReservations);
    assert.equal(new GoalReleaseGate(f.store).report(f.goal.id).complete,false);
    // A changed operator mapping must be rejected before any new test runs.
    f.spec.sourceSha='d'.repeat(40);f.save();
    await assert.rejects(f.evaluate(()=>{launches++;return {stdout:passed,exit:0};}),
      /Work proof source or Goal/);
    assert.equal(launches,1);
    t.diagnostic('MR_PROBE_RECEIPT='+JSON.stringify({kind:'independent-acceptance-real-test',
      sourceSha:EXACT_HEAD,fixture:'isolated-Goal-with-real-tracked-test',
      trackedTestFile:f.rule.testFile,trackedTestName:f.rule.testName,
      launches,childProcessExit:realProcessExit,rawTapSha256:realStdoutSha,
      receiptSha256:read.proofSha256,originalReservationsBefore:originalReservations,
      originalReservationsAfter:afterReservations,goalFinalized:false,
      modifiedMappingRejectedBeforeNewLaunch:true}));
  }finally{f.close();}
});

test('self-reported PASS is insufficient: a mapping cannot bypass source, approved criterion, original reply and PI review',async t=>{
  const variants=[
    (f:ReturnType<typeof fixture>)=>{f.spec.sourceSha='d'.repeat(40);f.save();},
    (f:ReturnType<typeof fixture>)=>{f.rule.answerSha256=sha('invented reply');f.save();},
    (f:ReturnType<typeof fixture>)=>{f.rule.criterionSha256=sha('different acceptance');f.save();},
    (f:ReturnType<typeof fixture>)=>{f.rule.workItemId='123e4567-e89b-42d3-a456-426614174999';f.save();},
    (f:ReturnType<typeof fixture>)=>{const row=f.ledger.graph(f.goal.id).events.find(e=>e.type==='goal.pi_review')!;
      f.store.db.prepare('INSERT INTO goal_events(goal_id,created_at,type,payload_json) VALUES(?,?,?,?)')
        .run(f.goal.id,new Date().toISOString(),row.type,JSON.stringify(row.payload));},
    (f:ReturnType<typeof fixture>)=>{f.store.db.prepare('UPDATE goal_acceptance SET status=? WHERE id=?')
      .run('PENDING',f.check.id);},
  ];
  let rejectedBeforeTest=0;
  for(const modify of variants){
    const f=fixture();try{modify(f);let ran=false;
      await assert.rejects(f.evaluate(()=>{ran=true;return {stdout:passed,exit:0};}));
      assert.equal(ran,false,'Invalid Goal/PI scope must reject before independent test execution');
      rejectedBeforeTest++;
    }finally{f.close();}
  }
  t.diagnostic('MR_PROBE_RECEIPT='+JSON.stringify({kind:'independent-acceptance-claim-refusals',
    sourceSha:EXACT_HEAD,fixture:'isolated-synthetic',rejectedBeforeTest,
    externalTestLaunches:0,untrustedPiClaimsPromoted:0}));
});

test('fake TAP, skipped assertion, missing named case and failed test never pass',t=>{
  assert.doesNotThrow(()=>assessWorkTestOutput(passed,0,name));
  const variants=[
    {log:passed,exit:1},
    {log:passed.replace('ok 1 - '+name,'not ok 1 - '+name),exit:0},
    {log:passed.replace('ok 1 - '+name,'ok 1 - '+name+' # SKIP'),exit:0},
    {log:passed.replace('ok 1 - '+name,'ok 1 - unrelated'),exit:0},
    {log:passed+'ok 2 - '+name+'\n',exit:0},
    {log:passed.replace('# fail 0','# fail 1'),exit:0},
    {log:'PASS: '+name,exit:0},
    {log:passed.replace('1..1','1..2'),exit:0},
    {log:passed.replace('# tests 1','# tests 2'),exit:0},
    {log:passed.replace('# pass 1','# pass 2'),exit:0},
    {log:passed.replace('# tests 1','# tests 2').replace('# pass 1','# pass 2'),exit:0},
    {log:passed.replace('# skipped 0','# skipped 1'),exit:0},
    {log:passed.replace('# cancelled 0','# cancelled 1'),exit:0},
    {log:passed.replace('# todo 0','# todo 1'),exit:0},
    {log:passed.replace('# fail 0',''),exit:0},
    {log:passed+'# pass 1\n',exit:0},
    {log:passed.replace('# tests 1',''),exit:0},
  ];
  for(const c of variants)assert.throws(()=>assessWorkTestOutput(c.log,c.exit,name));
  t.diagnostic('MR_PROBE_RECEIPT='+JSON.stringify({kind:'independent-acceptance-tap-refusals',
    sourceSha:EXACT_HEAD,fixture:'isolated-synthetic',malformedOutcomesRejected:variants.length,
    positiveSyntheticTapVerified:true}));
});

test('positive TAP never substitutes for missing, stale, mismatched or duplicated SSH execution evidence',()=>{
  const valid=syntheticExecution(passed,0,target,'tests/request-ledger.test.ts');
  assert.match(assessWorkTestExecution(valid,target,'tests/request-ledger.test.ts'),/^[a-f0-9]{64}$/);
  const bad=[
    {...valid,execution:undefined},
    {...valid,stderr:''},
    {...valid,stderr:valid.stderr+valid.stderr},
    {...valid,stderr:valid.stderr.replace('4321','9999')},
    {...valid,execution:{...valid.execution,sourceSha:'d'.repeat(40)}},
    {...valid,execution:{...valid.execution,testFile:'tests/other.test.ts'}},
    {...valid,execution:{...valid.execution,sessionId:'b'.repeat(32)}},
    {...valid,execution:{...valid.execution,remoteHostAlias:''}},
    {...valid,execution:{...valid.execution,commandSha256:'b'.repeat(64)}},
    {...valid,execution:{...valid.execution,remoteProject:'/srv/wrong/path'}},
    {...valid,execution:{...valid.execution,shellPid:0}},
    {...valid,execution:{...valid.execution,finishedAt:'2000-01-01T00:00:00.000Z'}},
    {...valid,execution:{...valid.execution,startedAt:'2000-01-01T00:00:00.000Z',
      finishedAt:'2000-01-01T00:01:00.000Z'}},
  ];
  for(const evidence of bad)
    assert.throws(()=>assessWorkTestExecution(evidence as RemoteWorkTestResult,
      target,'tests/request-ledger.test.ts'));
});

test('changed original Goal evidence while independently running a test fails closed',async()=>{
  const f=fixture();try{
    await assert.rejects(f.evaluate(()=>{
      f.store.db.prepare('INSERT INTO events(mission_id,created_at,type,payload_json) VALUES(?,?,?,?)')
        .run(f.store.db.prepare('SELECT id FROM missions LIMIT 1').get()?.id,
          new Date().toISOString(),'test.synthetic_race','{}');
      return {stdout:passed,exit:0};
    }),/event evidence changed/);
  }finally{f.close();}
});

test('operator mapping changed while the independent test runs cannot authorize PASS',async()=>{
  const f=fixture();try{
    await assert.rejects(f.evaluate(()=>{
      // The original test and PI event remain valid; only the private
      // operator-owned mapping has moved during the verifier process.
      f.spec.criteria[0]!.testName='substituted-acceptance';f.save();
      return {stdout:passed,exit:0};
    }),/mapping changed during test/);
    assert.equal(readdirSync(f.evidence).some(x=>x.startsWith('work-receipt-')),false);
    assert.equal(f.store.get(f.missionId).turnCount,2);
  }finally{f.close();}
});

test('work-item key changed during test cannot be certified by a stale independent receipt',async()=>{
  const f=fixture();try{
    await assert.rejects(f.evaluate(()=>{
      f.store.db.prepare('UPDATE goal_work_items SET item_key=? WHERE id=?')
        .run('substituted-work',f.work.id);
      return {stdout:passed,exit:0};
    }),/work-item or original answer provenance changed/);
    assert.equal(readdirSync(f.evidence).some(x=>x.startsWith('work-receipt-')),false);
  }finally{f.close();}
});

test('duplicate criterion mappings, command injection and untracked path references are refused',async()=>{
  const f=fixture();try{
    for(const bad of ['tests/../package.json','tests/a.test.ts;echo PASS',
      'src/cli.ts','tests/UPPER.test.ts','tests/../../evil']){
      assert.throws(()=>approvedWorkTestPath(bad));
    }
    assert.equal(approvedWorkTestPath('tests/request-ledger.test.ts'),
      'tests/request-ledger.test.ts');
    f.spec.criteria.push({...f.rule});
    f.save();
    await assert.rejects(f.evaluate(),/duplicated/);
  }finally{f.close();}
});

test('approved remote work command preserves fixed tracked source path and rejects shell injection',()=>{
  const config={sshHost:'approved-alias',project:'/srv/projects/mission-relay'};
  const command=remoteReleaseCommand(config,'work-test','tests/request-ledger.test.ts',
    'a'.repeat(32));
  assert.match(command,/git ls-files --error-unmatch tests\/request-ledger\.test\.ts/);
  assert.match(command,/--test-reporter=tap tests\/request-ledger\.test\.ts/);
  assert.match(command,/MR_WORK_TEST_SESSION_V1/);
  assert.match(command,/\$\$/);
  assert.throws(()=>remoteReleaseCommand(config,'work-test','tests/request-ledger.test.ts'));
  assert.throws(()=>remoteReleaseCommand(config,'work-test','tests/request-ledger.test.ts',
    'bogus-session'));
  assert.throws(()=>remoteReleaseCommand(config,'work-test','tests/x.test.ts && rm -rf /'));
});
