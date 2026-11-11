import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/core/store.js';
import {GoalLedger} from '../src/core/goal-store.js';
import {GoalReleaseGate} from '../src/core/goal-release.js';
import {inspectGoalChromeFiveToSixHistory} from '../src/core/goal-release-chrome-history.js';
import {inspectGoalReleaseMatrix} from '../src/core/goal-release-matrix.js';

const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const url=(n:number)=>`https://chatgpt.com/c/123e4567-e89b-42d3-a456-${String(n).padStart(12,'0')}`;
const navigationFailure='page.goto: Timeout 30000ms exceeded.\nCall log:\n'+
  '  - navigating to "https://chatgpt.com/", waiting until "domcontentloaded"\n';

function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'relay-chrome-history-'));
  const store=new Store(join(dir,'missions.sqlite'));
  const goalStore=new GoalLedger(store);
  const goal=goalStore.createGoal({requestKey:'synthetic-private-owner',
    objective:'Synthetic Goal: history attestation without Chrome',priority:100});
  const plan=goalStore.createPlan(goal.id,goal.version,{
    requestKey:'synthetic-plan',summary:'Never use production history in tests',
    items:[{key:'synthetic-attest',title:'Audit',priority:80,acceptance:['Synthetic evidence']}],
  });
  goalStore.setPlanStatus(goal.id,plan.id,plan.version,'APPROVED','synthetic-plan-approve');
  goalStore.setGoalStatus(goal.id,goalStore.getGoal(goal.id).version,'ACTIVE','synthetic-goal-activate');
  const mission=store.create({goal:goalStore.getGoal(goal.id).objective,acceptance:['Test'],
    workspace:'',sandbox:'read-only',mode:'supervised',maxTurns:32,
    checks:[],requestKey:'synthetic-mission'});
  const linked=store.linkChat(mission.id,url(1),mission.version).mission;
  const bound=store.bindChatBrowser(mission.id,'synthetic-physical-browser',
    linked.version).mission;
  store.setMeta(`pi.autopilot.enabled.${bound.id}`,'1');
  goalStore.bindPiMission(goal.id,bound.id,bound.version,'synthetic');
  const observe=(round:number,newConversation=false,overrideTarget?:string)=>{
    const key=`secret-key-${round}`,answer=`Complete synthetic response ${round}\n[MISSION_RELAY:NEXT]`;
    store.reserveChatBrowserTurn(bound.id,store.get(bound.id).version,
      key,hash(`original private prompt ${round}`),
      newConversation?{newConversation:true}:{});
    store.finishChatBrowserTurn(bound.id,key,{kind:'observed',
      assistantSha256:hash(answer),summary:answer,
      ...(newConversation?{newChatUrl:url(round+1),
        newChatTargetSha256:overrideTarget??hash(`target ${round}`)}:{})});
    store.commitPiPlan(bound.id,hash(answer),[],{
      action:'NEXT',summary:`PI reviewed ${round}`,nextPrompt:'Continue'});
  };
  return {dir,store,goalId:goal.id,missionId:bound.id,observe,close:()=>{
    store.close();rmSync(dir,{force:true,recursive:true});}};
}

function mutate(f:ReturnType<typeof fixture>,type:string,round:number,
  change:(p:Record<string,unknown>)=>Record<string,unknown>){
  const event=f.store.events(f.missionId).find(e=>e.type===type&&
    (['chatgpt.browser_migrated','chatgpt.browser_reserved',
      'chatgpt.browser_pre_send_retry_intent'].includes(type)?
      (e.payload as {requestKey?:string}).requestKey===`secret-key-${round}`:
      type==='mission.reconciled'||(e.payload as {round?:number}).round===round));
  assert.ok(event,`Fixture event ${type} for round ${round}`);
  f.store.db.prepare('UPDATE events SET payload_json=? WHERE id=?')
    .run(JSON.stringify(change(event.payload as Record<string,unknown>)),event.id);
}

/** Same isolated recovery shape as round 31: 30 normal observations, an
 * original uncertain new-chat reservation, a one-shot pre-Send intent, an
 * original-request rollover recovery, and an independent PI NEXT. */
function recoveredRound31(f:ReturnType<typeof fixture>){
  const ledger=new GoalLedger(f.store);
  const item=ledger.graph(f.goalId).items[0]!;
  const ready=ledger.setWorkStatus(f.goalId,item.id,item.version,'READY',[],'synthetic-ready');
  ledger.setWorkStatus(f.goalId,item.id,ready.version,'IN_PROGRESS',[],'synthetic-start');
  for(let i=1;i<=30;i++)f.observe(i,i%5===1);
  const key='secret-key-31',prompt='original private prompt 31';
  const answer='Recovered synthetic response 31\n[MISSION_RELAY:NEXT]';
  f.store.reserveChatBrowserTurn(f.missionId,f.store.get(f.missionId).version,
    key,hash(prompt),{newConversation:true});
  f.store.finishChatBrowserTurn(f.missionId,key,{kind:'uncertain',error:navigationFailure});
  const revision=f.store.get(f.missionId).version;
  f.store.authorizePreSendRolloverOnce(f.missionId,revision,{
    originalPromptSha256:hash(prompt),
    sourcePromptSha256:hash('original private prompt 30'),
    sourceAnswerSha256:hash('Complete synthetic response 30\n[MISSION_RELAY:NEXT]'),
  });
  f.store.recoverObservedBrowserRollover(f.missionId,revision,{
    requestPromptSha256:hash(prompt),newChatUrl:url(32),
    assistantSha256:hash(answer),summary:answer,
  });
  f.store.commitPiPlan(f.missionId,hash(answer),[],{
    action:'NEXT',summary:'PI independently reviewed recovered 31',
    nextPrompt:'Pending further authorized Mission scheduling',
  });
}

test('isolated round-31 one-shot recovery is traceable custody, not historic physical Chrome attestation',()=>{
  const f=fixture();try{
    recoveredRound31(f);
    const before=f.store.maxEventId();
    const history=inspectGoalChromeFiveToSixHistory(f.store,f.goalId);
    assert.equal(history.historicalRotations,6);
    assert.equal(history.custodyConsistent,true,JSON.stringify(history.rotations.at(-1)?.violations));
    const r=history.rotations.at(-1)!;
    assert.deepEqual([r.fromRound,r.toRound],[30,31]);
    assert.equal(r.migrationEventId,null,'Recovered rollovers have no separate migration event');
    assert.equal(r.observationEventId,f.store.events(f.missionId)
      .find(e=>e.type==='chatgpt.browser_rollover_recovered')?.id);
    assert.equal(r.sourceTargetFingerprintRecorded,true);
    assert.equal(r.destinationTargetFingerprintRecorded,false,
      'The historical recovery never recorded the destination physical target');
    assert.equal(r.independentlyVerifiedCompleteAnswer,false);
    assert.equal(r.independentlyVerifiedPhysicalTab,false);
    assert.equal(history.releaseGateState,'PENDING');
    assert.ok(history.missingIndependentProof.includes('historical_physical_target_independent_attestation'));
    const matrix=inspectGoalReleaseMatrix(f.store,f.goalId);
    assert.equal(matrix.chromeHistory.custodyConsistent,true);
    assert.equal(matrix.requirements.find(x=>x.requirement==='chrome-5-to-6')?.state,'PENDING');
    assert.equal(new GoalReleaseGate(f.store).report(f.goalId).target,null);
    assert.equal(f.store.maxEventId(),before,'History and matrix must not change the audit');
    assert.equal(inspectGoalChromeFiveToSixHistory(f.store,f.goalId).evidenceIndexSha256,
      history.evidenceIndexSha256);
  }finally{f.close();}
});

test('recovered round-31 custody rejects tampered original request, URLs, answer, inspection and PI review',()=>{
  const scenarios:Array<{name:string;type:string;edit:(p:Record<string,unknown>)=>Record<string,unknown>;issue:string}>=[
    {name:'wrong request',type:'chatgpt.browser_rollover_recovered',
      edit:p=>({...p,requestKey:'foreign-key'}),issue:'reserved_prompt_or_request_identity_invalid'},
    {name:'wrong source URL',type:'chatgpt.browser_rollover_recovered',
      edit:p=>({...p,previousUrlSha256:hash('unrelated-chat')}),issue:'original_chat_migration_invalid'},
    {name:'wrong destination URL',type:'chatgpt.browser_rollover_recovered',
      edit:p=>({...p,newUrlSha256:hash('unrelated-chat')}),issue:'original_chat_migration_invalid'},
    {name:'wrong response',type:'chatgpt.browser_rollover_recovered',
      edit:p=>({...p,assistantSha256:hash('stale-response')}),issue:'complete_answer_hash_or_pi_decision_chain_invalid'},
    {name:'not independently inspected',type:'chatgpt.browser_rollover_recovered',
      edit:p=>({...p,independentlyInspected:false}),issue:'recovered_rollover_provenance_invalid'},
    {name:'reconciliation was not an observed rollover',type:'mission.reconciled',
      edit:p=>({...p,kind:'unrelated-reconciliation'}),issue:'recovered_rollover_provenance_invalid'},
    {name:'one-shot intent lost original reservation',type:'chatgpt.browser_pre_send_retry_intent',
      edit:p=>({...p,originalPromptSha256:hash('different') }),issue:'recovered_rollover_provenance_invalid'},
    {name:'one-shot intent falsely says it can resend',type:'chatgpt.browser_pre_send_retry_intent',
      edit:p=>({...p,noExistingSendClicked:false}),issue:'recovered_rollover_provenance_invalid'},
    {name:'PI did not review original answer',type:'pi.decision',
      edit:p=>({...p,responseSha256:hash('not-reviewed')}),issue:'complete_answer_hash_or_pi_decision_chain_invalid'},
    {name:'original reserved prompt invalid',type:'chatgpt.browser_reserved',
      edit:p=>({...p,promptSha256:'invalid'}),issue:'reserved_prompt_or_request_identity_invalid'},
  ];
  for(const scenario of scenarios){
    const f=fixture();try{
      recoveredRound31(f);
      mutate(f,scenario.type,31,scenario.edit);
      const history=inspectGoalChromeFiveToSixHistory(f.store,f.goalId);
      assert.equal(history.custodyConsistent,false,scenario.name);
      assert.ok(history.rotations.at(-1)?.violations.includes(scenario.issue),
        `${scenario.name}: ${JSON.stringify(history.rotations.at(-1)?.violations)}`);
      assert.equal(history.releaseGateState,'PENDING');
    }finally{f.close();}
  }
});

test('isolated 5->6 and 10->11 original custody, answers, PI and physical TARGETs remain historical only',()=>{
  const f=fixture();
  try{
    for(let i=1;i<=11;i++)f.observe(i,[1,6,11].includes(i));
    const before=f.store.maxEventId();
    const history=inspectGoalChromeFiveToSixHistory(f.store,f.goalId);
    assert.equal(history.custodyConsistent,true);
    assert.equal(history.historicalRotations,2);
    assert.deepEqual(history.rotations.map(x=>[x.fromRound,x.toRound]),[[5,6],[10,11]]);
    for(const r of history.rotations){
      assert.equal(r.custodyConsistent,true,JSON.stringify(r.violations));
      assert.deepEqual(r.violations,[]);
      assert.equal(r.sourceTargetFingerprintRecorded,true);
      assert.equal(r.destinationTargetFingerprintRecorded,true);
      assert.equal(r.independentlyVerifiedCompleteAnswer,false);
      assert.equal(r.independentlyVerifiedPhysicalTab,false);
      assert.match(r.originalEvidenceSha256,/^[0-9a-f]{64}$/);
      assert.ok(r.sourceObservationEventId<r.sourceDecisionEventId!);
      assert.ok(r.sourceDecisionEventId!<r.reservationEventId!);
      assert.ok(r.reservationEventId!<r.migrationEventId!);
      assert.ok(r.migrationEventId!<r.observationEventId);
      assert.ok(r.observationEventId<r.decisionEventId!);
    }
    const matrix=inspectGoalReleaseMatrix(f.store,f.goalId);
    assert.equal(matrix.chromeHistory.historicalRotations,2);
    assert.equal(matrix.chromeHistory.custodyConsistent,true);
    assert.equal(matrix.requirements.find(x=>x.requirement==='chrome-5-to-6')?.state,'PENDING');
    assert.equal(new GoalReleaseGate(f.store).report(f.goalId).target,null);
    assert.equal(f.store.maxEventId(),before,'Read-only history/matrix cannot append audit events');
    const printed=JSON.stringify(history);
    for(const secret of ['Complete synthetic response','original private prompt',
      'secret-key','chatgpt.com','synthetic-physical-browser'])
      assert.ok(!printed.includes(secret));
    assert.equal(inspectGoalChromeFiveToSixHistory(f.store,f.goalId).evidenceIndexSha256,
      history.evidenceIndexSha256);
  }finally{f.close();}
});

test('unsettled sixth request cannot be promoted to settled history or Gate PASS',()=>{
  const f=fixture();try{
    for(let i=1;i<=5;i++)f.observe(i,i===1);
    f.store.reserveChatBrowserTurn(f.missionId,f.store.get(f.missionId).version,
      'secret-pending',hash('pending prompt'),{newConversation:true});
    const result=inspectGoalChromeFiveToSixHistory(f.store,f.goalId);
    assert.equal(result.historicalRotations,0);
    assert.equal(result.custodyConsistent,false);
    assert.equal(result.pendingOriginalRequestsExcluded.length,1);
    assert.equal(result.releaseGateState,'PENDING');
  }finally{f.close();}
});

test('isolated negative paths reject wrong request, reply SHA, PI review, target, URL and target reuse',()=>{
  const scenarios:Array<{
    name:string;edit:(f:ReturnType<typeof fixture>)=>void;issue:string;
  }>=[
    {name:'wrong original request key',
      edit:f=>mutate(f,'chatgpt.browser_observed',6,p=>({...p,requestKey:'wrong-key'})),
      issue:'original_request_attribution_invalid'},
    {name:'stale or truncated answer hash',
      edit:f=>mutate(f,'chatgpt.browser_observed',6,p=>({...p,assistantSha256:hash('stale')})),
      issue:'complete_answer_hash_or_pi_decision_chain_invalid'},
    {name:'forged PI review',
      edit:f=>mutate(f,'pi.decision',6,p=>({...p,responseSha256:hash('other')})),
      issue:'complete_answer_hash_or_pi_decision_chain_invalid'},
    {name:'fifth-turn PI did not authorize NEXT or HANDOFF',
      edit:f=>mutate(f,'pi.decision',5,p=>({...p,action:'DONE'})),
      issue:'complete_answer_hash_or_pi_decision_chain_invalid'},
    {name:'invalid reserved sixth-turn prompt digest format',
      edit:f=>mutate(f,'chatgpt.browser_reserved',6,p=>({
        ...p,promptSha256:'not-a-sha256'})),
      issue:'reserved_prompt_or_request_identity_invalid'},
    {name:'missing physical target identity',
      edit:f=>mutate(f,'chatgpt.browser_migrated',6,p=>{
        const {newTabTargetSha256:_unused,...rest}=p;return rest;}),
      issue:'physical_target_identity_not_proven_in_original_ledger'},
    {name:'new Chat claims to reuse the source physical tab',
      edit:f=>mutate(f,'chatgpt.browser_migrated',6,p=>({
        ...p,newTabTargetSha256:hash('target 1')})),
      issue:'physical_target_identity_not_proven_in_original_ledger'},
    {name:'mismatched original source URL',
      edit:f=>mutate(f,'chatgpt.browser_migrated',6,p=>({...p,previousUrlSha256:hash('other url')})),
      issue:'original_chat_migration_invalid'},
    {name:'same physical TARGET claimed for another Chat',
      edit:f=>mutate(f,'chatgpt.browser_migrated',11,p=>({...p,newTabTargetSha256:hash('target 6')})),
      issue:'physical_target_reused_for_distinct_chat'},
  ];
  for(const scenario of scenarios){
    const f=fixture();
    try{
      for(let i=1;i<=11;i++)f.observe(i,[1,6,11].includes(i));
      scenario.edit(f);
      const report=inspectGoalChromeFiveToSixHistory(f.store,f.goalId);
      assert.equal(report.custodyConsistent,false,scenario.name);
      assert.ok(report.rotations.some(row=>row.violations.includes(scenario.issue)),
        `${scenario.name}: ${JSON.stringify(report.rotations.map(x=>x.violations))}`);
      assert.equal(report.releaseGateState,'PENDING');
    }finally{f.close();}
  }
});

test('self-consistent forged original prompt SHA remains UNVERIFIED without independent prompt readback',()=>{
  const f=fixture();try{
    for(let i=1;i<=6;i++)f.observe(i,[1,6].includes(i));
    // A syntactically valid change to the original reservation becomes the
    // ledger-derived expected value. This is NOT cryptographic proof of
    // what the historical Chrome textbox contained; do not grant PASS.
    mutate(f,'chatgpt.browser_reserved',6,p=>({
      ...p,promptSha256:hash('different invented original prompt')}));
    const history=inspectGoalChromeFiveToSixHistory(f.store,f.goalId);
    assert.equal(history.historicalRotations,1);
    assert.equal(history.custodyConsistent,true,
      'Controller self-consistency cannot independently authenticate prompt bytes');
    assert.equal(history.rotations[0]?.independentlyVerifiedCompleteAnswer,false);
    assert.equal(history.rotations[0]?.independentlyVerifiedPhysicalTab,false);
    assert.equal(history.releaseGateState,'PENDING');
    assert.equal(new GoalReleaseGate(f.store).report(f.goalId).target,null);
  }finally{f.close();}
});

test('synthetic owned-tab retirement is only a controller receipt, never an independent physical Chrome witness',()=>{
  const f=fixture();try{
    for(let i=1;i<=6;i++)f.observe(i,[1,6].includes(i));
    const migration=inspectGoalChromeFiveToSixHistory(f.store,f.goalId);
    assert.equal(migration.historicalRotations,1);
    assert.equal(migration.custodyConsistent,true);
    assert.equal(migration.rotations[0]?.independentlyVerifiedPhysicalTab,false);
    assert.equal(migration.rotations[0]?.independentlyVerifiedCompleteAnswer,false);
    const originalEventId=f.store.maxEventId();
    assert.equal(f.store.canRetireOwnedChatTab(f.missionId,url(2),url(7)),true);
    f.store.recordOwnedChatTabRetired(f.missionId,url(2),url(7));
    assert.equal(f.store.maxEventId(),originalEventId+1,
      'Only isolated test SQLite receives this synthetic retirement record');
    const event=f.store.events(f.missionId).at(-1);
    assert.equal(event?.type,'chatgpt.browser_tab_retired');
    const after=inspectGoalChromeFiveToSixHistory(f.store,f.goalId);
    assert.equal(after.custodyConsistent,true);
    assert.equal(after.rotations[0]?.independentlyVerifiedPhysicalTab,false,
      'Even an authentic controller close receipt cannot prove physical closure');
    assert.equal(after.rotations[0]?.independentlyVerifiedCompleteAnswer,false);
    assert.equal(after.releaseGateState,'PENDING');
    const matrix=inspectGoalReleaseMatrix(f.store,f.goalId);
    assert.equal(matrix.requirements.find(x=>x.requirement==='chrome-5-to-6')?.state,
      'PENDING');
    assert.equal(matrix.requirements.find(x=>x.requirement==='relay-tab-retirement')?.state,
      'PENDING');
    assert.equal(new GoalReleaseGate(f.store).report(f.goalId).target,null);
  }finally{f.close();}
});

test('history CLI uses read-only SQLite and cannot create a missing production-like DB',()=>{
  const f=fixture();try{
    for(let i=1;i<=6;i++)f.observe(i,[1,6].includes(i));
    const count=f.store.maxEventId();
    const run=(home:string)=>spawnSync(process.execPath,
      ['--import','tsx','src/cli.ts','goal-chrome-5-to-6-history',f.goalId],{
        encoding:'utf8',cwd:process.cwd(),timeout:14000,
        env:{...process.env,MISSION_RELAY_HOME:home}});
    const valid=run(f.dir);
    assert.equal(valid.status,0,valid.stderr);
    const report=JSON.parse(valid.stdout) as ReturnType<typeof inspectGoalChromeFiveToSixHistory>;
    assert.equal(report.historicalRotations,1);
    assert.equal(report.releaseGateState,'PENDING');
    assert.equal(f.store.maxEventId(),count);
    const missing=mkdtempSync(join(tmpdir(),'relay-chrome-missing-'));
    try{
      const denied=run(missing);
      assert.notEqual(denied.status,0);
      assert.match(denied.stderr,/not found|does not exist|unable to open/i);
    }finally{rmSync(missing,{recursive:true,force:true});}
  }finally{f.close();}
});
