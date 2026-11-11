import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/core/store.js';
import {GoalLedger} from '../src/core/goal-store.js';
import {inspectGoalRequestLedger} from '../src/core/request-ledger.js';
import {inspectPiEvidence} from '../src/core/pi-evidence.js';

const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const source='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174000';
const dest='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174001';
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'relay-request-custody-'));
  const file=join(dir,'missions.sqlite'),store=new Store(file),ledger=new GoalLedger(store);
  const objective='Validate one original browser Send with Goal custody';
  const goal=ledger.createGoal({requestKey:'owner-custody',objective,priority:90});
  const created=store.create({goal:objective,acceptance:['At most one Send'],
    workspace:'',sandbox:'read-only',mode:'supervised',maxTurns:32,
    requestKey:'mission-custody',checks:[]});
  const linked=store.linkChat(created.id,source,created.version).mission;
  const bound=store.bindChatBrowser(created.id,'install:Chrome:fixture',linked.version).mission;
  store.setMeta(`pi.autopilot.enabled.${bound.id}`,'1');
  ledger.bindPiMission(goal.id,bound.id,bound.version,'binding-1');
  return {dir,file,store,ledger,goal,missionId:bound.id,cleanup:()=>{
    store.close();rmSync(dir,{recursive:true,force:true});
  }};
}
function settle(store:Store,id:string,key:string,answer:string,newChatUrl?:string){
  return store.finishChatBrowserTurn(id,key,{
    kind:'observed',assistantSha256:sha(answer),summary:answer,
    ...(newChatUrl?{newChatUrl}:{})});
}
test('parallel Store handles cannot reserve or settle the same request twice; restart never replays history',()=>{
  const f=fixture();let second:Store|undefined;
  try{
    second=new Store(f.file);
    const version=f.store.get(f.missionId).version;
    f.store.reserveChatBrowserTurn(f.missionId,version,'original-once',sha('prompt'));
    assert.throws(()=>second!.reserveChatBrowserTurn(f.missionId,version,'original-once',sha('prompt')),
      /State conflict|Cannot run|already used/);
    assert.throws(()=>second!.reserveChatBrowserTurn(f.missionId,version,'other-key',sha('prompt')),
      /State conflict|Cannot run/);
    const answer='Actual browser answer\n[MISSION_RELAY:NEXT]';
    settle(second,f.missionId,'original-once',answer);
    assert.throws(()=>f.store.finishChatBrowserTurn(f.missionId,'original-once',{
      kind:'observed',assistantSha256:sha(answer),summary:answer}),/No matching active/);
    assert.throws(()=>f.store.reserveChatBrowserTurn(f.missionId,
      f.store.get(f.missionId).version,'original-once',sha('prompt')),/already used/);
    assert.equal(f.store.events(f.missionId).filter(e=>e.type==='chatgpt.browser_reserved').length,1);
    assert.equal(f.store.events(f.missionId).filter(e=>e.type==='chatgpt.browser_observed').length,1);
    assert.equal(f.store.get(f.missionId).turnCount,1);
    second.close();second=new Store(f.file);
    assert.equal(second.chatBrowserTurn(f.missionId)?.assistantSha256,sha(answer));
    assert.equal(inspectGoalRequestLedger(second,f.goal.id).requests[0]?.observationEventId,
      f.store.events(f.missionId).find(e=>e.type==='chatgpt.browser_observed')?.id);
  }finally{second?.close();f.cleanup();}
});

test('paused original Send remains unsettled across restart; one exact observation preserves custody without PI acceptance',()=>{
  const f=fixture();let reopened:Store|undefined;
  try{
    const requestKey='owner-paused-original-send';
    const originalPrompt='Exact original request before owner pause';
    const answer='Synthetic complete answer for original Send\n[MISSION_RELAY:NEXT]';
    const summary='Original answer received after the owner paused';
    const reserved=f.store.reserveChatBrowserTurn(f.missionId,
      f.store.get(f.missionId).version,requestKey,sha(originalPrompt));
    f.store.update(f.missionId,reserved.version,{stopRequested:true},
      'mission.pause_requested',{reason:'Synthetic owner pause'});
    const initialEvents=f.store.events(f.missionId);

    reopened=new Store(f.file);
    const pending=inspectGoalRequestLedger(reopened,f.goal.id);
    assert.equal(pending.ledgerConsistent,true);
    assert.equal(pending.requests.length,1);
    assert.equal(pending.requests[0]?.status,'pending');
    assert.equal(pending.requests[0]?.observationEventId,null);
    assert.equal(pending.requests[0]?.promptSha256,sha(originalPrompt));
    assert.equal(pending.businessAcceptanceVerified,false);
    assert.equal(reopened.chatBrowserTurn(f.missionId)?.status,'reserved');
    assert.equal(reopened.get(f.missionId).stopRequested,true);
    assert.throws(()=>reopened!.reserveChatBrowserTurn(f.missionId,
      reopened!.get(f.missionId).version,'accidental-repeat-send',sha('different prompt')),
      /Cannot run browser turn in state RUNNING|pending pause request/);
    assert.deepEqual(reopened.events(f.missionId),initialEvents);

    const settled=reopened.finishChatBrowserTurn(f.missionId,requestKey,{
      kind:'observed',assistantSha256:sha(answer),summary,
    });
    assert.equal(settled.state,'PAUSED');
    assert.equal(settled.stopRequested,true);
    assert.equal(settled.turnCount,1);
    reopened.close();reopened=new Store(f.file);
    const settledEvents=reopened.events(f.missionId);
    assert.deepEqual(settledEvents.slice(0,initialEvents.length),initialEvents);
    assert.equal(settledEvents.filter(e=>e.type==='chatgpt.browser_reserved').length,1);
    assert.equal(settledEvents.filter(e=>e.type==='chatgpt.browser_observed').length,1);
    assert.equal(settledEvents.filter(e=>e.type==='pi.decision').length,0);
    assert.equal(reopened.chatBrowserTurn(f.missionId)?.assistantSha256,sha(answer));
    assert.equal(reopened.get(f.missionId).lastSummary,summary);
    assert.equal(reopened.get(f.missionId).stopRequested,true);
    const observed=inspectGoalRequestLedger(reopened,f.goal.id);
    assert.equal(observed.requests[0]?.status,'observed');
    assert.equal(observed.requests[0]?.answerSha256,sha(answer));
    assert.equal(observed.requests[0]?.decisionEventId,null);
    assert.equal(observed.ledgerConsistent,true);
    assert.equal(observed.businessAcceptanceVerified,false);
    assert.throws(()=>reopened!.finishChatBrowserTurn(f.missionId,requestKey,{
      kind:'observed',assistantSha256:sha(answer),summary,
    }),/No matching active browser dispatch/);
    assert.deepEqual(reopened.events(f.missionId),settledEvents);
  }finally{reopened?.close();f.cleanup();}
});

test('crash after durable reservation and uncertain Send stays locked, uncredited and traceable after restart',()=>{
  const f=fixture();let reopened:Store|undefined;
  try{
    f.store.reserveChatBrowserTurn(f.missionId,f.store.get(f.missionId).version,
      'crash-after-reserve',sha('user prompt'));
    f.store.finishChatBrowserTurn(f.missionId,'crash-after-reserve',{
      kind:'uncertain',error:'Browser disconnected immediately after submit'});
    reopened=new Store(f.file);
    const trace=inspectGoalRequestLedger(reopened,f.goal.id);
    assert.equal(trace.requests.length,1);
    assert.equal(trace.requests[0]?.status,'uncertain');
    assert.equal(trace.requests[0]?.observationEventId,null);
    assert.equal(trace.requests[0]?.sourceChatUrlSha256,sha(source));
    assert.throws(()=>reopened!.reserveChatBrowserTurn(f.missionId,
      reopened!.get(f.missionId).version,'another-send',sha('new')),
      /Cannot run|reconcile|may have been submitted/);
    assert.equal(reopened.get(f.missionId).turnCount,0);
  }finally{reopened?.close();f.cleanup();}
});

test('independently inspected uncertain answer recovers once without changing the original reservation',()=>{
  const f=fixture();try{
    const key='inspect-only',prompt=sha('submitted original user request');
    const answer='Browser answer verified without re-Send\n[MISSION_RELAY:NEXT]';
    f.store.reserveChatBrowserTurn(f.missionId,f.store.get(f.missionId).version,key,prompt);
    f.store.finishChatBrowserTurn(f.missionId,key,{kind:'uncertain',
      error:'Observer crashed after Send'});
    const original=f.store.events(f.missionId);
    f.store.recoverObservedBrowserTurn(f.missionId,f.store.get(f.missionId).version,{
      requestPromptSha256:prompt,assistantSha256:sha(answer),summary:answer});
    assert.deepEqual(f.store.events(f.missionId).slice(0,original.length),original);
    assert.equal(f.store.events(f.missionId).filter(e=>e.type==='chatgpt.browser_reserved').length,1);
    assert.equal(f.store.events(f.missionId).filter(e=>e.type==='chatgpt.browser_turn_recovered').length,1);
    assert.equal(f.store.events(f.missionId).filter(e=>e.type==='chatgpt.browser_uncertain').length,1);
    assert.throws(()=>f.store.recoverObservedBrowserTurn(f.missionId,
      f.store.get(f.missionId).version,{
        requestPromptSha256:prompt,assistantSha256:sha(answer),summary:answer}),
      /Only an uncertain or independently inspected/);
    const trace=inspectGoalRequestLedger(f.store,f.goal.id);
    assert.equal(trace.requests.length,1);
    assert.equal(trace.requests[0]?.status,'observed');
    assert.equal(trace.requests[0]?.answerSha256,sha(answer));
    assert.equal(trace.ledgerConsistent,true);
  }finally{f.cleanup();}
});

test('uncertain new-tab recovery cannot credit a duplicate or unlinked original reservation',()=>{
  const f=fixture();try{
    const key='first-new-chat',prompt=sha('original new chat message');
    f.store.reserveChatBrowserTurn(f.missionId,f.store.get(f.missionId).version,
      key,prompt,{newConversation:true});
    f.store.finishChatBrowserTurn(f.missionId,key,{kind:'uncertain',
      error:'Lost response after direct new tab'});
    const original=f.store.events(f.missionId).find(e=>e.type==='chatgpt.browser_reserved')!;
    f.store.db.prepare('INSERT INTO events(mission_id,created_at,type,payload_json) VALUES(?,?,?,?)')
      .run(f.missionId,new Date().toISOString(),original.type,JSON.stringify(original.payload));
    assert.throws(()=>f.store.recoverObservedBrowserRollover(
      f.missionId,f.store.get(f.missionId).version,{
        requestPromptSha256:prompt,newChatUrl:dest,
        assistantSha256:sha('Verified answer'),summary:'Verified answer'}),
      /unique original reservation/);
    assert.equal(f.store.get(f.missionId).turnCount,0);
    assert.equal(f.store.chatBrowserTurn(f.missionId)?.status,'uncertain');
    assert.equal(f.store.events(f.missionId).filter(e=>e.type==='chatgpt.browser_rollover_recovered').length,0);
    assert.equal(f.store.chatLink(f.missionId),source);
  }finally{f.cleanup();}
});

test('tampered duplicate reservation rejects settlement, records one quarantined observation and preserves history',()=>{
  const f=fixture();try{
    const key='original-browser-request',promptSha256=sha('same exact prompt');
    f.store.reserveChatBrowserTurn(f.missionId,f.store.get(f.missionId).version,
      key,promptSha256);
    const original=f.store.events(f.missionId);
    const reservation=original.find(e=>e.type==='chatgpt.browser_reserved')!;
    f.store.db.prepare('INSERT INTO events(mission_id,created_at,type,payload_json) VALUES (?,?,?,?)')
      .run(f.missionId,new Date().toISOString(),reservation.type,JSON.stringify(reservation.payload));
    assert.throws(()=>settle(f.store,f.missionId,key,'Evidence without unique reservation'),
      /unique original reservation/);
    const id=f.store.quarantineBrowserObservation(f.missionId,{
      requestKey:key,promptSha256,assistantSha256:sha('Evidence without unique reservation'),
      reason:'settlement-rejected'});
    assert.equal(f.store.quarantineBrowserObservation(f.missionId,{
      requestKey:key,promptSha256,assistantSha256:sha('Evidence without unique reservation'),
      reason:'settlement-rejected'}),id);
    assert.deepEqual(f.store.events(f.missionId).slice(0,original.length),original);
    assert.equal(f.store.get(f.missionId).turnCount,0);
    assert.equal(f.store.chatBrowserTurn(f.missionId)?.status,'reserved');
    const diagnostic=inspectGoalRequestLedger(f.store,f.goal.id);
    assert.deepEqual(diagnostic.quarantineEventIds,[id]);
    assert.equal(diagnostic.ledgerConsistent,false);
    assert.ok(inspectPiEvidence(f.store,f.missionId).violations.includes(
      'unresolved_browser_observation_quarantine'));
    assert.ok(!JSON.stringify(diagnostic).includes('original-browser-request'));
  }finally{f.cleanup();}
});

test('Goal→Mission→Chat→Work→request→answer read-only custody retains exact provenance and flags forged orphan',()=>{
  const f=fixture();try{
    const first='PI planned scope\n[MISSION_RELAY:NEXT]';
    f.store.reserveChatBrowserTurn(f.missionId,f.store.get(f.missionId).version,
      'planning-turn',sha('plan instructions'),{newConversation:true});
    settle(f.store,f.missionId,'planning-turn',first,dest);
    f.store.commitPiPlan(f.missionId,sha(first),[],{
      action:'NEXT',summary:'Planning ready',nextPrompt:'Implement work package'});
    const plan=f.ledger.createPlan(f.goal.id,f.ledger.getGoal(f.goal.id).version,{
      requestKey:'plan-1',summary:'One piece',items:[{
        key:'custody',title:'Verify request custody',priority:90,
        acceptance:['One settle'],description:'Test exact event hashes',
      }]});
    f.ledger.setPlanStatus(f.goal.id,plan.id,plan.version,'APPROVED','approve-plan');
    f.ledger.setGoalStatus(f.goal.id,f.ledger.getGoal(f.goal.id).version,'ACTIVE','activate');
    const initial=f.ledger.graph(f.goal.id).items[0]!;
    const ready=f.ledger.setWorkStatus(f.goal.id,initial.id,initial.version,'READY',[],'ready');
    const running=f.ledger.setWorkStatus(f.goal.id,initial.id,ready.version,'IN_PROGRESS',[],'running');
    const pi=f.store.piPlan(f.missionId)!;
    const prompt='Execute only custody, verify source and tests';
    const workBinding={goalId:f.goal.id,planId:plan.id,itemId:running.id,
      itemVersion:running.version,piResponseSha256:pi.responseSha256,
      piPlanSha256:sha(JSON.stringify(pi))};
    f.store.reserveChatBrowserTurn(f.missionId,f.store.get(f.missionId).version,
      'work-request',sha(prompt),{
        promptSnapshot:{format:'goal-work-v1',prompt},goalBinding:workBinding});
    const answer='Work passed local tests\n[MISSION_RELAY:NEXT]';
    settle(f.store,f.missionId,'work-request',answer);
    const before=f.store.maxEventId();
    const report=inspectGoalRequestLedger(f.store,f.goal.id);
    assert.equal(report.ledgerConsistent,true,report.violations.join(','));
    assert.equal(report.requests.length,2);
    assert.equal(report.requests[1]?.goalId,f.goal.id);
    assert.equal(report.requests[1]?.workItemId,running.id);
    assert.equal(report.requests[1]?.planId,plan.id);
    assert.equal(report.requests[1]?.sourceChatUrlSha256,sha(dest));
    assert.equal(report.requests[1]?.promptSha256,sha(prompt));
    assert.equal(report.requests[1]?.answerSha256,sha(answer));
    assert.equal(report.requests[0]?.destinationChatUrlSha256,sha(dest));
    assert.equal(f.store.maxEventId(),before);
    const cli=JSON.parse(execFileSync(process.execPath,
      ['--import','tsx','src/cli.ts','goal-request-ledger',f.goal.id],{
        cwd:process.cwd(),env:{...process.env,MISSION_RELAY_HOME:f.dir},
        timeout:12000,encoding:'utf8'})) as typeof report;
    assert.deepEqual(cli.requests,report.requests);
    for(const privateText of [prompt,source,dest,'work-request','planning-turn',answer]){
      assert.ok(!JSON.stringify(cli).includes(privateText));
    }
    f.store.db.prepare('INSERT INTO events(mission_id,created_at,type,payload_json) VALUES (?,?,?,?)')
      .run(f.missionId,new Date().toISOString(),'chatgpt.browser_observed',
        JSON.stringify({requestKey:'unknown-orphan',assistantSha256:sha('unknown'),round:3}));
    const corrupted=inspectGoalRequestLedger(f.store,f.goal.id);
    assert.ok(corrupted.unattributedEventIds.length>0);
    assert.equal(corrupted.ledgerConsistent,false);
  }finally{f.cleanup();}
});
