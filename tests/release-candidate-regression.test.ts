import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/core/store.js';
import {GoalLedger} from '../src/core/goal-store.js';
import {GoalReleaseGate} from '../src/core/goal-release.js';
import {inspectPiEvidence,inspectPiChainEvidence} from '../src/core/pi-evidence.js';

const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const source='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174000';
const chat=(round:number)=>`https://chatgpt.com/c/123e4567-e89b-42d3-a456-${String(426614174000+round).padStart(12,'0')}`;

function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'relay-candidate-regression-'));
  const file=join(dir,'private.sqlite'),store=new Store(file);
  const ledger=new GoalLedger(store);
  const objective='Retain a single owner Goal across all verified PI work';
  const goal=ledger.createGoal({requestKey:'candidate-goal',objective,priority:95});
  const created=store.create({goal:objective,acceptance:['Exact bounded source evidence'],
    workspace:'',sandbox:'read-only',mode:'supervised',maxTurns:32,
    requestKey:'candidate-original',checks:[]});
  const linked=store.linkChat(created.id,source,created.version).mission;
  const bound=store.bindChatBrowser(created.id,'install:Chrome:candidate',linked.version).mission;
  store.setMeta(`pi.autopilot.enabled.${bound.id}`,'1');
  ledger.bindPiMission(goal.id,bound.id,bound.version,'candidate-binding');
  const plan=ledger.createPlan(goal.id,goal.version,{requestKey:'candidate-plan',
    summary:'Retain pending implementation work',items:[
      {key:'foundation',title:'Verify original settlement',priority:95,
        acceptance:['Original request observed once']},
      {key:'later',title:'Complete independent final acceptance',priority:80,
        dependsOn:['foundation'],acceptance:['Independent evidence and release proof']},
    ]});
  ledger.setPlanStatus(goal.id,plan.id,plan.version,'APPROVED','candidate-approve');
  ledger.setGoalStatus(goal.id,ledger.getGoal(goal.id).version,'ACTIVE','candidate-active');
  const work=ledger.graph(goal.id).items.find(x=>x.key==='foundation')!;
  const ready=ledger.setWorkStatus(goal.id,work.id,work.version,'READY',[],'candidate-ready');
  ledger.setWorkStatus(goal.id,work.id,ready.version,'IN_PROGRESS',[],'candidate-start');
  return {dir,file,store,ledger,goal,plan,bound,cleanup:()=>{
    store.close();rmSync(dir,{recursive:true,force:true});
  }};
}

function observed(store:Store,id:string,round:number,rollover=false){
  const key=`candidate-round-${round}`;
  const answer=`Complete synthetic browser answer ${round}\n[MISSION_RELAY:NEXT]`;
  const prompt=sha(`unique user prompt ${round}`);
  store.reserveChatBrowserTurn(id,store.get(id).version,key,prompt,
    rollover?{newConversation:true}:{});
  store.finishChatBrowserTurn(id,key,{kind:'observed',assistantSha256:sha(answer),
    summary:answer,...(rollover?{newChatUrl:chat(round)}:{})});
  store.commitPiPlan(id,sha(answer),[],{action:'NEXT',summary:`PI reviewed ${round}`,
    nextPrompt:`Continue the scoped unfinished work after round ${round}`});
}

test('crash during sixth new-Chat request preserves five-turn ceiling, exact reservation and pending PI review',()=>{
  const f=fixture();let restart:Store|undefined;
  try{
    for(let round=1;round<=5;round++)observed(f.store,f.bound.id,round);
    assert.throws(()=>f.store.reserveChatBrowserTurn(f.bound.id,
      f.store.get(f.bound.id).version,'illegal-sixth',sha('same old chat')),
      /five|new conversation/i);
    const before=f.store.events(f.bound.id);
    const key='sixth-original',prompt=sha('sixth new chat only');
    f.store.reserveChatBrowserTurn(f.bound.id,f.store.get(f.bound.id).version,
      key,prompt,{newConversation:true});
    f.store.finishChatBrowserTurn(f.bound.id,key,{kind:'uncertain',
      error:'Injected connection loss after sixth Send; do not replay'});
    restart=new Store(f.file);
    const answer='Recovered sixth original reply\n[MISSION_RELAY:NEXT]';
    assert.throws(()=>restart!.reserveChatBrowserTurn(f.bound.id,
      restart!.get(f.bound.id).version,'sixth-again',prompt,{newConversation:true}),
      /Cannot run|reconcile|State conflict/);
    assert.equal(restart.get(f.bound.id).turnCount,5);
    restart.recoverObservedBrowserRollover(f.bound.id,restart.get(f.bound.id).version,{
      requestPromptSha256:prompt,newChatUrl:chat(6),assistantSha256:sha(answer),summary:answer,
    });
    assert.deepEqual(restart.events(f.bound.id).slice(0,before.length),before);
    const awaiting=inspectPiEvidence(restart,f.bound.id);
    assert.equal(awaiting.ledgerConsistent,true,awaiting.violations.join(','));
    assert.deepEqual(awaiting.pendingPiReviewRounds,[6],
      'An observed recovered reply is not permission to skip PI review');
    assert.equal(awaiting.maxObservedTurnsInOneChat,5);
    assert.equal(awaiting.chatSegments,2);
    assert.equal(restart.events(f.bound.id).filter(e=>e.type==='chatgpt.browser_reserved').length,6);
    assert.equal(restart.events(f.bound.id).filter(e=>e.type==='chatgpt.browser_rollover_recovered').length,1);
    assert.throws(()=>restart!.recoverObservedBrowserRollover(f.bound.id,
      restart!.get(f.bound.id).version,{
        requestPromptSha256:prompt,newChatUrl:chat(6),assistantSha256:sha(answer),summary:answer,
      }),/Only an uncertain/);
    restart.commitPiPlan(f.bound.id,sha(answer),[],{
      action:'NEXT',summary:'Exactly one recovered sixth answer independently reviewed',
      nextPrompt:'Proceed only from the new Chat'});
    assert.deepEqual(inspectPiEvidence(restart,f.bound.id).pendingPiReviewRounds,[]);
    assert.equal(new GoalReleaseGate(restart).report(f.goal.id).complete,false);
  }finally{restart?.close();f.cleanup();}
});

test('32-round verified active Goal creates one zero-turn successor across competing SQLite handles and never advances work by itself',()=>{
  const f=fixture();let parallel:Store|undefined;
  try{
    for(let round=1;round<=32;round++)
      observed(f.store,f.bound.id,round,round>1&&(round-1)%5===0);
    const report=inspectPiEvidence(f.store,f.bound.id);
    assert.equal(report.ledgerConsistent,true,report.violations.join(','));
    assert.equal(report.observedTurns,32);
    assert.equal(report.decisionsVerified,32);
    assert.equal(report.maxObservedTurnsInOneChat,5);
    assert.equal(report.chatSegments,7);
    const beforeGraph=f.ledger.graph(f.goal.id);
    parallel=new Store(f.file);
    const a=f.store.createPiSuccessor(f.bound.id);
    const b=parallel.createPiSuccessor(f.bound.id);
    assert.ok(a);
    assert.equal(b?.id,a.id);
    assert.equal(a.turnCount,0);
    assert.equal(a.maxTurns,32);
    assert.equal(a.state,'READY');
    assert.equal(f.ledger.missionGoalId(a.id),f.goal.id);
    assert.deepEqual(f.ledger.graph(f.goal.id),beforeGraph);
    assert.equal(f.store.events(f.bound.id).filter(e=>e.type==='pi.chain_successor').length,1);
    assert.equal(f.store.events(a.id).filter(e=>e.type==='pi.chain_started').length,1);
    assert.equal(f.store.piPlan(a.id),null,'A child has no invented PI review');
    assert.equal(f.store.chatBrowserTurn(a.id),null,'Creating a child is not sending');
    assert.equal(new GoalReleaseGate(f.store).report(f.goal.id).complete,false);
    assert.equal(f.ledger.getGoal(f.goal.id).status,'ACTIVE');
    const lineage=inspectPiChainEvidence(f.store,f.bound.id);
    assert.equal(lineage.chainConsistent,true,JSON.stringify(lineage.violations));
  }finally{parallel?.close();f.cleanup();}
});
