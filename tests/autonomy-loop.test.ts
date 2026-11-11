import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/core/store.js';
import {GoalLedger} from '../src/core/goal-store.js';
import {GoalReleaseGate} from '../src/core/goal-release.js';
import {goalWorkPrompt} from '../src/core/goal-prompts.js';

const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const URL='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174000';
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'relay-autonomy-loop-'));
  const file=join(dir,'missions.sqlite'),store=new Store(file),ledger=new GoalLedger(store);
  const objective='Complete owner Goal across bounded Missions without losing work';
  const goal=ledger.createGoal({requestKey:'autonomy-goal',objective,priority:95});
  const created=store.create({goal:objective,acceptance:['Independent complete acceptance'],
    workspace:'',sandbox:'read-only',mode:'supervised',maxTurns:32,
    checks:[],requestKey:'autonomy-parent'});
  const linked=store.linkChat(created.id,URL,created.version).mission;
  const bound=store.bindChatBrowser(created.id,'install:Chrome:synthetic',linked.version).mission;
  store.setMeta(`pi.autopilot.enabled.${bound.id}`,'1');
  ledger.bindPiMission(goal.id,bound.id,bound.version,'goal-link');
  const plan=ledger.createPlan(goal.id,goal.version,{requestKey:'approved-plan',
    summary:'Two dependent work packages',items:[
      {key:'foundation',title:'Test original request receipt',priority:90,
        acceptance:['Original Send remains unique']},
      {key:'remaining',title:'Implement next package',priority:80,
        dependsOn:['foundation'],acceptance:['Verified result in fresh Mission']},
    ]});
  ledger.setPlanStatus(goal.id,plan.id,plan.version,'APPROVED','approve');
  ledger.setGoalStatus(goal.id,ledger.getGoal(goal.id).version,'ACTIVE','activate');
  const task=ledger.graph(goal.id).items.find(x=>x.key==='foundation')!;
  const ready=ledger.setWorkStatus(goal.id,task.id,task.version,'READY',[],'ready');
  ledger.setWorkStatus(goal.id,task.id,ready.version,'IN_PROGRESS',[],'start');
  const checkpoint=()=> {
    const near=store.update(bound.id,store.get(bound.id).version,
      {state:'PAUSED',turnCount:31},'test.synthetic_31_previous_turns');
    const parentAnswer='Last original browser answer with work still remaining';
    store.reserveChatBrowserTurn(bound.id,near.version,'parent-turn-32',
      sha('original user prompt'));
    store.finishChatBrowserTurn(bound.id,'parent-turn-32',{kind:'observed',
      assistantSha256:sha(parentAnswer),summary:parentAnswer});
    store.commitPiPlan(bound.id,sha(parentAnswer),[],{action:'NEXT',
      summary:'More approved package work remains; the original reply was reviewed',
      nextPrompt:'Continue the existing approved work with no new scope'});
    return parentAnswer;
  };
  return {dir,file,store,ledger,goal,plan,mission:bound,checkpoint,
    cleanup:()=>{store.close();rmSync(dir,{recursive:true,force:true});}};
}

test('at 32→1, a verified Goal successor keeps active work and routes a late owner note exactly once across restart',()=>{
  const f=fixture();let reopened:Store|undefined;
  try{
    const answer=f.checkpoint();
    const before=f.ledger.graph(f.goal.id);
    assert.equal(f.store.queuePiOwnerDirective(f.mission.id,'99012',
      'Check the original request once before new Chat creation'),true);
    const childId=f.store.piChainSuccessor(f.mission.id);
    assert.ok(childId);
    const child=f.store.get(childId);
    assert.equal(child.state,'READY');
    assert.equal(child.turnCount,0);
    assert.equal(child.maxTurns,32);
    assert.equal(f.ledger.missionGoalId(child.id),f.goal.id);
    assert.deepEqual(f.ledger.graph(f.goal.id),before,
      'The new Mission never mutates or marks the current work item as passed');
    assert.equal(f.store.pendingPiOwnerDirectives(f.mission.id).length,0);
    const pending=f.store.pendingPiOwnerDirectives(child.id);
    assert.equal(pending.length,1);
    assert.equal(pending[0]?.text,'Check the original request once before new Chat creation');
    reopened=new Store(f.file);
    assert.equal(reopened.queuePiOwnerDirective(f.mission.id,'99012',
      'Check the original request once before new Chat creation'),false,
      'Telegram repeated update must not manufacture a second note or child');
    assert.equal(reopened.createPiSuccessor(f.mission.id)?.id,child.id);
    assert.equal(reopened.events(f.mission.id).filter(e=>e.type==='pi.chain_successor').length,1);
    assert.equal(reopened.events(child.id).filter(e=>e.type==='pi.chain_started').length,1);
    reopened.commitPiChainPreflight(child.id,sha(answer),pending.map(x=>x.id),{
      action:'NEXT',summary:'Original owner note independently reviewed',
      nextPrompt:'Continue current approved work only'});
    const prompt=goalWorkPrompt(reopened,child.id,reopened.piPlan(child.id)!,null,true);
    reopened.reserveChatBrowserTurn(child.id,reopened.get(child.id).version,
      'child-first-original',sha(prompt.prompt),{
        newConversation:true,promptSnapshot:{format:prompt.format,prompt:prompt.prompt},
        goalBinding:prompt.binding});
    assert.equal(reopened.chatBrowserTurn(child.id)?.newConversation,true);
    assert.equal(reopened.get(child.id).turnCount,0,'Reservation is not a completed Send');
    assert.throws(()=>reopened!.reserveChatBrowserTurn(child.id,
      reopened!.get(child.id).version,'child-duplicate',sha(prompt.prompt),{
        newConversation:true}),/Cannot run|Previous browser|State conflict/);
    assert.equal(reopened.events(child.id).filter(e=>e.type==='chatgpt.browser_reserved').length,1);
    assert.equal(reopened.events(f.mission.id).filter(e=>e.type==='chatgpt.browser_reserved').length,1);
    assert.equal(reopened.pendingPiOwnerDirectives(child.id).length,0);
    assert.equal(new GoalReleaseGate(reopened).report(f.goal.id).complete,false);
    assert.equal(new GoalLedger(reopened).getGoal(f.goal.id).status,'ACTIVE');
  }finally{reopened?.close();f.cleanup();}
});

test('a 32-turn parent cannot resurrect a blocked/finished Goal or skip its approved work before creating a successor',()=>{
  const f=fixture();try{
    f.checkpoint();
    const active=f.ledger.graph(f.goal.id).items.find(x=>x.key==='foundation')!;
    const before=f.store.events(f.mission.id).length;
    f.ledger.setGoalStatus(f.goal.id,f.ledger.getGoal(f.goal.id).version,
      'BLOCKED','external-block');
    assert.equal(f.store.createPiSuccessor(f.mission.id),null);
    assert.throws(()=>f.store.queuePiOwnerDirective(f.mission.id,'99013',
      'Resume old historical Mission'),/turn budget/);
    assert.equal(f.store.piChainSuccessor(f.mission.id),null);
    assert.equal(f.ledger.getWork(f.goal.id,active.id).status,'IN_PROGRESS');
    assert.equal(f.store.events(f.mission.id).length,before);
    assert.throws(()=>f.ledger.setGoalStatus(f.goal.id,
      f.ledger.getGoal(f.goal.id).version,'DONE','unverified-goal-done'),
      /Invalid goal state transition/);
    assert.equal(new GoalReleaseGate(f.store).report(f.goal.id).complete,false);
  }finally{f.cleanup();}
});

test('human-paused exhausted Goal never creates a successor and original work is retained',()=>{
  const f=fixture();try{
    f.checkpoint();
    f.store.pausePiChain(f.mission.id);
    assert.equal(f.store.createPiSuccessor(f.mission.id),null);
    assert.equal(f.store.piChainSuccessor(f.mission.id),null);
    assert.equal(f.store.events(f.mission.id).filter(e=>e.type==='pi.chain_successor').length,0);
    assert.equal(f.ledger.graph(f.goal.id).items.find(x=>x.key==='foundation')?.status,'IN_PROGRESS');
  }finally{f.cleanup();}
});
