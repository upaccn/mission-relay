import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/core/store.js';
import {GoalLedger} from '../src/core/goal-store.js';
import {GoalReleaseGate} from '../src/core/goal-release.js';
import {inspectGoalChromeTenToElevenHistory} from '../src/core/goal-release-chrome-history.js';
import {inspectGoalReleaseMatrix} from '../src/core/goal-release-matrix.js';

const sha=(x:string)=>createHash('sha256').update(x).digest('hex');
const url=(n:number)=>`https://chatgpt.com/c/123e4567-e89b-42d3-a456-${String(n).padStart(12,'0')}`;
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'relay-ten-eleven-'));
  const store=new Store(join(dir,'missions.sqlite')),ledger=new GoalLedger(store);
  const goal=ledger.createGoal({requestKey:'fixture-goal',
    objective:'Private simulated Goal',priority:90});
  const plan=ledger.createPlan(goal.id,goal.version,{requestKey:'fixture-plan',
    summary:'Test browser ownership',items:[{key:'test',title:'Synthetic test',
      priority:90,acceptance:['All original requests remain attributable']}]});
  ledger.setPlanStatus(goal.id,plan.id,plan.version,'APPROVED','approve');
  ledger.setGoalStatus(goal.id,ledger.getGoal(goal.id).version,'ACTIVE','activate');
  const mission=store.create({goal:goal.objective,acceptance:['fixture'],
    workspace:'',sandbox:'read-only',mode:'supervised',maxTurns:0,checks:[],
    requestKey:'fixture-mission'});
  const linked=store.linkChat(mission.id,url(1),mission.version).mission;
  const bound=store.bindChatBrowser(mission.id,'fixture-browser',linked.version).mission;
  store.setMeta(`pi.autopilot.enabled.${bound.id}`,'1');
  ledger.bindPiMission(goal.id,bound.id,bound.version,'bind');
  const observe=(n:number,rotate=false)=>{
    const key=`request-${n}`,answer=`Private answer ${n}\n[MISSION_RELAY:NEXT]`;
    store.reserveChatBrowserTurn(bound.id,store.get(bound.id).version,key,sha(`Private prompt ${n}`),
      rotate?{newConversation:true}:{});
    store.finishChatBrowserTurn(bound.id,key,{kind:'observed',
      assistantSha256:sha(answer),summary:answer,
      ...(rotate?{newChatUrl:url(n+1),newChatTargetSha256:sha(`target-${n}`)}:{})});
    store.commitPiPlan(bound.id,sha(answer),[],{
      action:'NEXT',summary:'Continue',nextPrompt:'Continue synthetic fixture'});
  };
  const change=(type:string,round:number,fn:(p:Record<string,unknown>)=>Record<string,unknown>)=>{
    const e=store.events(bound.id).find(x=>x.type===type&&
      (type==='pi.decision'?
        (x.payload as {round?:number}).round===round:
        (x.payload as {requestKey?:string}).requestKey===`request-${round}`));
    assert.ok(e);
    store.db.prepare('UPDATE events SET payload_json=? WHERE id=?')
      .run(JSON.stringify(fn(e.payload as Record<string,unknown>)),e.id);
  };
  return {dir,store,goalId:goal.id,missionId:bound.id,observe,change,
    close:()=>{store.close();rmSync(dir,{recursive:true,force:true});}};
}

test('the 10→11 controller ledger is consistent, private, read-only and not an independent PASS',()=>{
  const f=fixture();try{
    for(let n=1;n<=21;n++)f.observe(n,n===1||n===11||n===21);
    const prior=f.store.maxEventId();
    const report=inspectGoalChromeTenToElevenHistory(f.store,f.goalId);
    assert.equal(report.historicalRotations,2);
    assert.equal(report.custodyConsistent,true,
      JSON.stringify(report.rotations.map(x=>x.violations)));
    assert.deepEqual(report.rotations.map(x=>[x.fromRound,x.toRound]),[[10,11],[20,21]]);
    assert.ok(report.rotations.every(x=>x.sourceTargetFingerprintRecorded&&
      x.destinationTargetFingerprintRecorded&&!x.independentlyVerifiedPhysicalTab));
    assert.equal(report.releaseGateState,'PENDING');
    const matrix=inspectGoalReleaseMatrix(f.store,f.goalId);
    assert.equal(matrix.chromeHistory.historicalRotations,2);
    assert.equal(matrix.chromeHistory.custodyConsistent,true);
    assert.equal(matrix.requirements.find(x=>x.requirement==='chrome-10-to-11')?.state,'PENDING');
    assert.equal(new GoalReleaseGate(f.store).report(f.goalId).target,null);
    assert.equal(f.store.maxEventId(),prior);
    assert.equal(inspectGoalChromeTenToElevenHistory(f.store,f.goalId).evidenceIndexSha256,
      report.evidenceIndexSha256);
    assert.doesNotMatch(JSON.stringify(report),/Private prompt|Private answer|fixture-browser|chatgpt.com/);
  }finally{f.close();}
});

test('changing the original request, answer, migration target or PI decision breaks 10→11 custody',()=>{
  const scenarios=[
    {type:'chatgpt.browser_reserved',change:(p:Record<string,unknown>)=>({...p,promptSha256:'bad'}),
      issue:'reserved_prompt_or_request_identity_invalid'},
    {type:'chatgpt.browser_observed',change:(p:Record<string,unknown>)=>({...p,assistantSha256:sha('stale')}),
      issue:'complete_answer_hash_or_pi_decision_chain_invalid'},
    {type:'chatgpt.browser_migrated',change:(p:Record<string,unknown>)=>({...p,newTabTargetSha256:'bad'}),
      issue:'physical_target_identity_not_proven_in_original_ledger'},
    {type:'pi.decision',change:(p:Record<string,unknown>)=>({...p,responseSha256:sha('fake')}),
      issue:'complete_answer_hash_or_pi_decision_chain_invalid'},
  ];
  for(const s of scenarios){
    const f=fixture();try{
      for(let n=1;n<=11;n++)f.observe(n,n===1||n===11);
      f.change(s.type,11,s.change);
      const report=inspectGoalChromeTenToElevenHistory(f.store,f.goalId);
      assert.equal(report.custodyConsistent,false,s.type);
      assert.ok(report.rotations[0]?.violations.includes(s.issue),
        `${s.type}: ${JSON.stringify(report.rotations.map(x=>x.violations))}`);
      assert.equal(report.releaseGateState,'PENDING');
    }finally{f.close();}
  }
});

test('valid explicit early Chat handoffs remain allowed without fabricating 10→11 boundaries',()=>{
  const f=fixture();try{
    for(let n=1;n<=6;n++)f.observe(n,n===1||n===6);
    const report=inspectGoalChromeTenToElevenHistory(f.store,f.goalId);
    assert.equal(report.historicalRotations,0);
    assert.equal(report.releaseGateState,'PENDING');
    assert.equal(f.store.get(f.missionId).turnCount,6);
  }finally{f.close();}
});
