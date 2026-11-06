import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {Store} from '../src/core/store.js';
import {Engine} from '../src/core/engine.js';
import {inspectChatPage,withBrowserSession,observationDelayMs,isPendingNewChatUrl,
  tolerateRolloverNavigation,rolloverUrlClass,newChatBootstrapDelayMs,
  shouldReloadBlankNewChat,reloadBlankDirectNewChat,isFreshResponseLoadFailure,
  canonicalVisibleUserPrompt,matchesSubmittedUserPrompt,matchesReservedPromptHash,isNewAssistantReply,
  visibleLongTaskBanner,clickDeliveryRetryOnce,interruptedDeadline,
  CONNECTION_INTERRUPTED_TEXT,MESSAGE_DELIVERY_TIMEOUT_TEXT,
  INTERRUPTED_WAIT_GRACE_MS,MAX_INTERRUPTED_WAIT_MS,
  ACTIVE_REPLY_OBSERVATION_INTERVAL_MS,
  submitChatTurn,submitNewChatTurn,
  DEFAULT_BROWSER_TURN_TIMEOUT_MS,MAX_BROWSER_TURN_TIMEOUT_MS,type BrowserSession} from '../src/plugins/chatgpt-browser.js';
import {executeBrowserTurn,driveChatConversation,browserDecision,browserFreshTaskPrompt,
  browserNewChatPrompt,browserRolloverRecoveryPrompt,browserContinuationPrompt} from '../src/core/browser-controller.js';
import type {AgentAdapter} from '../src/core/types.js';
import type {Page} from 'playwriter';

const SHA=createHash('sha256').update('test browser prompt').digest('hex');

test('ChatGPT accessible user transcript decorations are excluded from prompt identity hashing',()=>{
  const submitted='Complete this read-only task.\nInclude two separate phases.';
  const decorated=`You said:\n${submitted}\n…\nShow more`;
  assert.equal(canonicalVisibleUserPrompt(decorated,true),submitted);
  assert.equal(createHash('sha256').update(canonicalVisibleUserPrompt(decorated,true)).digest('hex'),
    createHash('sha256').update(submitted).digest('hex'));
  assert.equal(canonicalVisibleUserPrompt(`${submitted}\n…\nShow more`,false),submitted);
  assert.equal(canonicalVisibleUserPrompt(`You said:\n${submitted}\nShow less`,true),submitted);
  assert.equal(canonicalVisibleUserPrompt(`${submitted}\nShow less`,false),submitted);
  assert.equal(createHash('sha256').update(canonicalVisibleUserPrompt(`${submitted}\nShow less`,true)).digest('hex'),
    createHash('sha256').update(submitted).digest('hex'));
  assert.notEqual(canonicalVisibleUserPrompt(`${submitted}\nShow less\nSubsequent human text`,true),submitted);
  assert.notEqual(canonicalVisibleUserPrompt(`You said:\n${submitted}\nAdditional human edit\n…\nShow more`,true),submitted);
  assert.notEqual(canonicalVisibleUserPrompt(`You said:\n${submitted}\nShow something else`,true),submitted);
});

test('A later PI prompt quoting the full original cannot satisfy earlier Send correlation',()=>{
  const original='Mission Relay acceptance: phase one only; do not begin phase two.';
  const later=[
    'Continue the same authorized Mission Relay task.',
    'Prior owner prompt:',original,
    'PI decision: NEXT; complete phase two now.',
  ].join('\n');
  const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
  assert.equal(later.includes(original),true,
    'The former substring predicate erroneously accepted this later user prompt');
  assert.equal(matchesSubmittedUserPrompt(hash(original),original),true);
  assert.equal(matchesSubmittedUserPrompt(hash(later),original),false);
  assert.equal(matchesSubmittedUserPrompt(null,original),false);
  assert.equal(matchesSubmittedUserPrompt(hash(original+' extra'),original),false);
});
test('Recovery binds the latest visible user to the durable PI-authored reservation hash',()=>{
  const piPrompt='Explicit PI request: execute phase two now.';
  const goal='Owner original goal: perform phase one only.';
  const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
  const reserved=hash(piPrompt);
  assert.notEqual(reserved,hash(goal),
    'Recovery must not attempt to reconstruct a PI-authored prompt from a goal');
  assert.equal(matchesReservedPromptHash(hash(piPrompt),reserved),true);
  assert.equal(matchesReservedPromptHash(hash(`Prior prompt: ${piPrompt}\nAnother request`),reserved),false);
  assert.equal(matchesReservedPromptHash(hash(goal),reserved),false);
  assert.equal(matchesReservedPromptHash(null,reserved),false);
});

test('A timed-out first PI /build new-chat Send is reconstructable without replay',()=>{
  const goal='Implement the next Mission Relay feature and test it';
  const workspace='/srv/ai/workspace/projects/mission-relay';
  const reserved='telegram-pi-123-1';
  const recovered=browserRolloverRecoveryPrompt({
    goal,acceptance:['Tests pass'],sandbox:'workspace-write',workspace,
    turnCount:0,nextInstruction:null,missionRequestKey:'telegram-pi-123',
    reservedRequestKey:reserved,sourceAnswer:'Unrelated anchor reply',
    adopted:false,chainParent:false,piManaged:true,piPlan:null,
  });
  assert.equal(recovered,browserFreshTaskPrompt(goal,workspace));
  assert.ok(recovered.includes('Approved canonical source repository'));
  assert.throws(()=>browserRolloverRecoveryPrompt({
    goal,acceptance:['Tests pass'],sandbox:'workspace-write',workspace,
    turnCount:0,nextInstruction:null,missionRequestKey:'telegram-pi-123',
    reservedRequestKey:'mismatched',sourceAnswer:'Unrelated anchor reply',
    adopted:false,chainParent:false,piManaged:true,piPlan:null,
  }),/exact verified previous plan/);
});

test('Recovery of a PI-controlled later new chat reconstructs the exact planned prompt',()=>{
  const answer='Verified prior source findings\n[MISSION_RELAY:NEXT]';
  const sha=createHash('sha256').update(answer).digest('hex');
  const plan={action:'NEXT' as const,summary:'Reviewed available evidence',
    nextPrompt:'Implement tests on the next stage',responseSha256:sha,round:8,
    reviewedDirectiveIds:[]};
  const input={goal:'Build Mission Relay',acceptance:['Ship source'],
    sandbox:'workspace-write' as const,workspace:'/srv/ai/workspace/projects/mission-relay',
    turnCount:8,nextInstruction:null,missionRequestKey:'pi-long',
    reservedRequestKey:'pi-long-9',sourceAnswer:answer,
    adopted:false,chainParent:false,piManaged:true,piPlan:plan};
  assert.equal(browserRolloverRecoveryPrompt(input),
    browserNewChatPrompt(input.goal,input.acceptance,plan.summary,
      plan.nextPrompt,answer,input.workspace));
  assert.throws(()=>browserRolloverRecoveryPrompt({...input,
    sourceAnswer:answer+'\nHuman changed the conversation'}),/exact verified previous plan/);
});
test('Same assistant text counts as a new response only with changed message identity',()=>{
  const old={url:'https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174000',
    assistantCount:2,userCount:2,composerReady:true,generating:false,
    lastAssistant:'PHASE_TWO_CONFIRM\n[MISSION_RELAY:DONE]',
    lastAssistantTurnId:'turn-002'};
  assert.equal(isNewAssistantReply(old,{...old,assistantCount:3,userCount:3}),false,
    'Changing counts or the latest user prompt cannot credit a prior assistant');
  assert.equal(isNewAssistantReply(old,{...old,assistantCount:1,userCount:3,
    lastAssistantTurnId:'turn-003'}),true,
    'Virtualized counts may fall even when a distinct assistant turn is present');
  assert.equal(isNewAssistantReply(old,{...old,userCount:3,
    lastAssistantTurnId:null}),false,'Missing identity must fail closed for identical text');
  assert.equal(isNewAssistantReply(old,{...old,userCount:3,
    lastAssistant:'An actually different answer'}),true);
});
const URL='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174000';
const never:AgentAdapter={
  async execute(){throw new Error('Codex must not run');},
  async verify(){throw new Error('Codex verifier must not run');},
};
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'relay-browser-turn-'));
  const store=new Store(join(dir,'state.sqlite'));
  const engine=new Engine(store,never);
  const base=store.create({goal:'Browser test',acceptance:['Assistant response observed'],
    sandbox:'read-only',mode:'supervised',maxTurns:3,workspace:'',requestKey:'test'});
  const linked=store.linkChat(base.id,URL,base.version).mission;
  return {dir,store,engine,linked,cleanup:()=>{store.close();rmSync(dir,{recursive:true,force:true});}};
}

test('Browser turn is durably reserved before any external interaction',()=>{
  const f=fixture();try{
    assert.throws(()=>f.store.reserveChatBrowserTurn(f.linked.id,0,'req-1',SHA),/State conflict/);
    const active=f.store.reserveChatBrowserTurn(f.linked.id,f.linked.version,'req-1',SHA);
    assert.equal(active.state,'RUNNING');
    assert.equal(active.turnCount,0);
    assert.equal(f.store.chatBrowserTurn(active.id)?.status,'reserved');
    assert.throws(()=>f.store.reserveChatBrowserTurn(active.id,active.version,'req-1',SHA),/Cannot run|already used/);
    assert.equal(f.store.events(active.id).filter(e=>e.type==='chatgpt.browser_reserved').length,1);
  }finally{f.cleanup();}
});

test('Long tasks use 60-second normal DOM polls and a separate quick final-stability check',()=>{
  assert.equal(DEFAULT_BROWSER_TURN_TIMEOUT_MS,60*60*1000);
  assert.equal(MAX_BROWSER_TURN_TIMEOUT_MS,4*60*60*1000);
  assert.equal(ACTIVE_REPLY_OBSERVATION_INTERVAL_MS,60000);
  for(const elapsed of [0,15000,120000,600000,1800000])
    assert.equal(observationDelayMs(elapsed,false),60000);
  assert.equal(observationDelayMs(1800000,true),3000);
  assert.equal(newChatBootstrapDelayMs(0,true,false),2000);
  assert.equal(newChatBootstrapDelayMs(15000,true,false),2000);
  assert.equal(newChatBootstrapDelayMs(25000,false,false),60000);
  assert.equal(newChatBootstrapDelayMs(120000,false,true),3000);
  assert.ok(DEFAULT_BROWSER_TURN_TIMEOUT_MS/60000<=60,
    'A default long task should need at most one DOM read per minute');
});

test('Connection interrupted extends the same long reply once, never past a bounded four hours',()=>{
  const start=1000,normal=start+DEFAULT_BROWSER_TURN_TIMEOUT_MS;
  const now=start+35*60_000;
  const extended=interruptedDeadline(start,normal,now,true);
  assert.equal(extended,now+INTERRUPTED_WAIT_GRACE_MS);
  assert.equal(interruptedDeadline(start,normal,now,false),normal,
    'An explicit caller deadline must not be silently overridden');
  assert.equal(interruptedDeadline(start,normal,start+3*60*60_000,true),
    start+MAX_INTERRUPTED_WAIT_MS,'The wait must remain bounded');
  assert.equal(interruptedDeadline(start,extended,now,true),extended,
    'The extension should not accumulate in a status polling loop');
});

test('A pre-existing ChatGPT response-load error is not mistaken for the newly submitted turn',()=>{
  const before={url:URL,userCount:1,assistantCount:1,composerReady:true,generating:false,
    lastAssistant:'This response couldn’t load\nReload response'};
  const stale={...before,userCount:2};
  assert.equal(isFreshResponseLoadFailure(before,stale,true),false,
    'The old assistant error must not fail a newly submitted research prompt');
  assert.equal(isFreshResponseLoadFailure(before,
    {...stale,lastAssistant:'This response couldn’t load'},true),false,
    'A re-rendered old error without a new assistant turn is still stale');
  assert.equal(isFreshResponseLoadFailure(before,
    {...stale,lastAssistant:'This response couldn’t load',assistantCount:2},true),true,
    'A distinct, newly visible assistant reply-load error can fail after confirmation');
  assert.equal(isFreshResponseLoadFailure(before,
    {...stale,lastAssistant:'This response couldn’t load',assistantCount:2},false),false,
    'A changed reply unrelated to the reserved request cannot fail this request');
  assert.equal(isFreshResponseLoadFailure(before,
    {...stale,lastAssistant:'Five NetBox field workflows\n[MISSION_RELAY:DONE]',assistantCount:2},true),false);
  assert.equal(isFreshResponseLoadFailure({...before,lastAssistant:'Prior successful answer'},
    {...stale,lastAssistant:'Unable to load response'},true),true);
});

test('Recover a confirmed complete existing-chat reply atomically with no duplicate browser send',()=>{
  const f=fixture();try{
    const competitor=f.store.create({goal:'Other mission',acceptance:['Single writer'],
      workspace:'',sandbox:'read-only',mode:'supervised',maxTurns:2,requestKey:'existing-recovery-other'});
    const second=f.store.linkChat(competitor.id,URL,competitor.version).mission;
    f.store.reserveChatBrowserTurn(f.linked.id,f.linked.version,'recover-existing',SHA);
    const uncertain=f.store.finishChatBrowserTurn(f.linked.id,'recover-existing',
      {kind:'uncertain',error:'Old ChatGPT reply-load error persisted during new Send'});
    assert.throws(()=>f.store.reserveChatBrowserTurn(second.id,second.version,'competing',SHA),
      /Another Mission owns/);
    assert.throws(()=>f.store.recoverObservedBrowserTurn(f.linked.id,uncertain.version,{
      requestPromptSha256:'f'.repeat(64),assistantSha256:'a'.repeat(64),summary:'Done'}),
      /cannot be linked/);
    const recovered=f.store.recoverObservedBrowserTurn(f.linked.id,uncertain.version,{
      requestPromptSha256:SHA,assistantSha256:'a'.repeat(64),
      summary:'Five verified findings\n[MISSION_RELAY:DONE]'});
    assert.equal(recovered.state,'PAUSED');
    assert.equal(recovered.turnCount,1);
    assert.equal(recovered.lastError,null);
    assert.equal(recovered.lastSummary,'Five verified findings\n[MISSION_RELAY:DONE]');
    assert.equal(f.store.chatBrowserTurn(f.linked.id)?.status,'reconciled');
    assert.equal(f.store.chatBrowserTurn(f.linked.id)?.assistantSha256,'a'.repeat(64));
    assert.equal(f.store.events(f.linked.id).filter(e=>e.type==='chatgpt.browser_uncertain').length,1);
    assert.equal(f.store.events(f.linked.id).filter(e=>e.type==='chatgpt.browser_turn_recovered').length,1);
    assert.throws(()=>f.store.recoverObservedBrowserTurn(f.linked.id,recovered.version,{
      requestPromptSha256:SHA,assistantSha256:'a'.repeat(64),summary:'Done'}),
      /Only an uncertain/);
    assert.throws(()=>f.store.reserveChatBrowserTurn(f.linked.id,recovered.version,'recover-existing',SHA),
      /already used/);
    assert.equal(f.store.reserveChatBrowserTurn(second.id,second.version,'competing',SHA).state,'RUNNING');
  }finally{f.cleanup();}
});

test('Failed recovered-response audit insert rolls back turn credit, lock and SHA',()=>{
  const f=fixture();try{
    f.store.reserveChatBrowserTurn(f.linked.id,f.linked.version,'recover-rollback',SHA);
    const m=f.store.finishChatBrowserTurn(f.linked.id,'recover-rollback',
      {kind:'uncertain',error:'Observer error'});
    f.store.db.exec(`CREATE TRIGGER reject_recovered_turn BEFORE INSERT ON events
      WHEN NEW.type='chatgpt.browser_turn_recovered'
      BEGIN SELECT RAISE(ABORT,'injected recovered receipt failure'); END`);
    assert.throws(()=>f.store.recoverObservedBrowserTurn(f.linked.id,m.version,{
      requestPromptSha256:SHA,assistantSha256:'a'.repeat(64),summary:'Done\n[MISSION_RELAY:DONE]'}),
      /injected recovered receipt failure/);
    assert.equal(f.store.get(f.linked.id).state,'NEEDS_RECONCILIATION');
    assert.equal(f.store.get(f.linked.id).turnCount,0);
    assert.equal(f.store.get(f.linked.id).version,m.version);
    assert.equal(f.store.chatBrowserTurn(f.linked.id)?.status,'uncertain');
    assert.equal(f.store.chatBrowserTurn(f.linked.id)?.assistantSha256,undefined);
    assert.equal(f.store.events(f.linked.id).filter(e=>e.type==='mission.reconciled').length,0);
    assert.equal(f.store.events(f.linked.id).filter(e=>e.type==='chatgpt.browser_turn_recovered').length,0);
    const competitor=f.store.create({goal:'Other',acceptance:['Single writer'],
      workspace:'',sandbox:'read-only',mode:'supervised',maxTurns:2,requestKey:'existing-recovery-blocked'});
    const linked=f.store.linkChat(competitor.id,URL,competitor.version).mission;
    assert.throws(()=>f.store.reserveChatBrowserTurn(linked.id,linked.version,'cannot-send',SHA),
      /Another Mission owns/);
  }finally{f.cleanup();}
});

test('Observed browser response pauses the mission, never declares completion',()=>{
  const f=fixture();try{
    f.store.reserveChatBrowserTurn(f.linked.id,f.linked.version,'req-1',SHA);
    const done=f.store.finishChatBrowserTurn(f.linked.id,'req-1',
      {kind:'observed',assistantSha256:SHA,summary:'Observed assistant response'});
    assert.equal(done.state,'PAUSED');
    assert.equal(done.turnCount,1);
    assert.equal(done.lastSummary,'Observed assistant response');
    assert.equal(f.store.chatBrowserTurn(done.id)?.status,'observed');
    assert.throws(()=>f.store.reserveChatBrowserTurn(done.id,done.version,'req-1',SHA),/already used/);
    const again=f.store.reserveChatBrowserTurn(done.id,done.version,'req-2',SHA);
    assert.equal(again.state,'RUNNING');
  }finally{f.cleanup();}
});

test('Interrupted browser send remains ambiguous across restart, and never auto-replays',()=>{
  const f=fixture();let closed=false;try{
    const active=f.store.reserveChatBrowserTurn(f.linked.id,f.linked.version,'req-1',SHA);
    assert.equal(active.state,'RUNNING');
    // Simulate the OS owner process having exited without another browser send.
    f.store.update(active.id,active.version,{ownerPid:999999},'test.simulate_dead_process');
    f.store.close();closed=true;
    const reopened=new Store(join(f.dir,'state.sqlite'));
    const engine=new Engine(reopened,never);
    assert.equal(reopened.chatBrowserTurn(active.id)?.status,'reserved');
    assert.throws(()=>reopened.reserveChatBrowserTurn(active.id,reopened.get(active.id).version,'req-1',SHA),/Cannot run|already used/);
    // An operator must inspect the real page, then deliberately reconcile the interrupted external send.
    const paused=engine.reconcile(active.id,true);
    assert.equal(paused.state,'PAUSED');
    // Crash-reserved records require explicit acknowledgement before another request.
    assert.throws(()=>reopened.reserveChatBrowserTurn(active.id,paused.version,'req-2',SHA),/may have been submitted/);
    reopened.reconcileChatBrowserTurn(active.id);
    assert.equal(reopened.chatBrowserTurn(active.id)?.status,'reconciled');
    reopened.close();
  }finally{if(!closed)f.store.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('An uncertain send can be reconciled manually, not retried with its request key',()=>{
  const f=fixture();try{
    f.store.reserveChatBrowserTurn(f.linked.id,f.linked.version,'req-1',SHA);
    const failed=f.store.finishChatBrowserTurn(f.linked.id,'req-1',
      {kind:'uncertain',error:'Connection lost after Send click'});
    assert.equal(failed.state,'NEEDS_RECONCILIATION');
    assert.equal(failed.turnCount,0);
    assert.throws(()=>f.engine.run(f.linked.id),/external ChatGPT conversation/);
    const paused=f.engine.reconcile(f.linked.id,true);
    assert.equal(paused.state,'PAUSED');
    assert.throws(()=>f.store.reserveChatBrowserTurn(paused.id,paused.version,'req-2',SHA),/may have been submitted/);
    const reconciled=f.store.reconcileChatBrowserTurn(paused.id);
    assert.throws(()=>f.store.reserveChatBrowserTurn(paused.id,reconciled.version,'req-1',SHA),/already used/);
    const next=f.store.reserveChatBrowserTurn(paused.id,reconciled.version,'req-2',SHA);
    assert.equal(next.state,'RUNNING');
  }finally{f.cleanup();}
});

test('Browser reconciliation atomically clears an uncertain Mission and conversation lock',()=>{
  const f=fixture();try {
    const competitor=f.store.create({goal:'Another browser Mission',acceptance:['No replay'],
      workspace:'',sandbox:'read-only',mode:'supervised',maxTurns:2,requestKey:'atomic-competitor'});
    const second=f.store.linkChat(competitor.id,URL,competitor.version).mission;
    f.store.reserveChatBrowserTurn(f.linked.id,f.linked.version,'atomic-first',SHA);
    const uncertain=f.store.finishChatBrowserTurn(f.linked.id,'atomic-first',
      {kind:'uncertain',error:'The browser relay disconnected after Send'});
    assert.throws(()=>f.store.reserveChatBrowserTurn(second.id,second.version,'second',SHA),
      /Another Mission owns/);
    const finished=f.store.reconcileChatBrowserTurn(f.linked.id);
    assert.equal(finished.state,'PAUSED');
    assert.equal(finished.version,uncertain.version+1);
    assert.equal(finished.turnCount,0);
    assert.equal(f.store.chatBrowserTurn(f.linked.id)?.status,'reconciled');
    const events=f.store.events(f.linked.id);
    assert.equal(events.filter(e=>e.type==='mission.reconciled').length,1);
    assert.equal(events.filter(e=>e.type==='chatgpt.browser_reconciled').length,1);
    assert.throws(()=>f.store.reconcileChatBrowserTurn(f.linked.id),/No interrupted browser turn/);
    assert.throws(()=>f.store.reserveChatBrowserTurn(f.linked.id,finished.version,'atomic-first',SHA),
      /already used/);
    assert.equal(f.store.reserveChatBrowserTurn(second.id,second.version,'second',SHA).state,'RUNNING');
  }finally{f.cleanup();}
});

test('A failed reconciliation audit insert rolls back state, both events and the conversation lock',()=>{
  const f=fixture();try {
    const competitor=f.store.create({goal:'Blocked competitor',acceptance:['Single writer'],
      workspace:'',sandbox:'read-only',mode:'supervised',maxTurns:2,requestKey:'rollback-competitor'});
    const second=f.store.linkChat(competitor.id,URL,competitor.version).mission;
    f.store.reserveChatBrowserTurn(f.linked.id,f.linked.version,'rollback-first',SHA);
    const uncertain=f.store.finishChatBrowserTurn(f.linked.id,'rollback-first',
      {kind:'uncertain',error:'Lost browser acknowledgement'});
    f.store.db.exec(`CREATE TRIGGER reject_browser_reconcile BEFORE INSERT ON events
      WHEN NEW.type='chatgpt.browser_reconciled' BEGIN SELECT RAISE(ABORT,'injected failure'); END`);
    assert.throws(()=>f.store.reconcileChatBrowserTurn(f.linked.id),/injected failure/);
    assert.equal(f.store.get(f.linked.id).state,'NEEDS_RECONCILIATION');
    assert.equal(f.store.get(f.linked.id).version,uncertain.version);
    assert.equal(f.store.chatBrowserTurn(f.linked.id)?.status,'uncertain');
    assert.equal(f.store.events(f.linked.id).filter(e=>e.type==='mission.reconciled').length,0);
    assert.equal(f.store.events(f.linked.id).filter(e=>e.type==='chatgpt.browser_reconciled').length,0);
    assert.throws(()=>f.store.reserveChatBrowserTurn(second.id,second.version,'blocked',SHA),
      /Another Mission owns/);
    f.store.db.exec('DROP TRIGGER reject_browser_reconcile');
    assert.equal(f.store.reconcileChatBrowserTurn(f.linked.id).state,'PAUSED');
    assert.equal(f.store.reserveChatBrowserTurn(second.id,second.version,'unblocked',SHA).state,'RUNNING');
  }finally{f.cleanup();}
});

test('Atomic reconciliation refuses an active owner and permits a crashed owner after inspection',()=>{
  const f=fixture();try {
    const active=f.store.reserveChatBrowserTurn(f.linked.id,f.linked.version,'crash-reservation',SHA);
    assert.throws(()=>f.store.reconcileChatBrowserTurn(active.id),/Execution may still be active/);
    const ownerExited=f.store.update(active.id,active.version,{ownerPid:999999},'test.simulate_dead_owner');
    const reconciled=f.store.reconcileChatBrowserTurn(active.id);
    assert.equal(reconciled.state,'PAUSED');
    assert.equal(reconciled.version,ownerExited.version+1);
    assert.equal(f.store.chatBrowserTurn(active.id)?.status,'reconciled');
    assert.equal(f.store.events(active.id).filter(e=>e.type==='mission.reconciled').length,1);
  }finally{f.cleanup();}
});

test('Only one Mission may write to the same ChatGPT conversation at a time',()=>{
  const f=fixture();try{
    const second=f.store.create({goal:'Second mission',acceptance:['More browser work'],
      workspace:'',sandbox:'read-only',mode:'supervised',maxTurns:3,requestKey:'second'});
    const linkedSecond=f.store.linkChat(second.id,URL,second.version).mission;
    f.store.reserveChatBrowserTurn(f.linked.id,f.linked.version,'first',SHA);
    assert.throws(()=>f.store.reserveChatBrowserTurn(linkedSecond.id,linkedSecond.version,'second',SHA),
      /Another Mission owns/);
    f.store.finishChatBrowserTurn(f.linked.id,'first',{kind:'observed',assistantSha256:SHA});
    const now=f.store.reserveChatBrowserTurn(linkedSecond.id,linkedSecond.version,'second',SHA);
    assert.equal(now.state,'RUNNING');
  }finally{f.cleanup();}
});

test('Uncertain browser send retains the conversation-wide lock until manual reconciliation',()=>{
  const f=fixture();try{
    const second=f.store.create({goal:'Competing mission',acceptance:['No duplicate ChatGPT send'],
      workspace:'',sandbox:'read-only',mode:'supervised',maxTurns:3,requestKey:'competitor'});
    const linkedSecond=f.store.linkChat(second.id,URL,second.version).mission;
    f.store.reserveChatBrowserTurn(f.linked.id,f.linked.version,'first',SHA);
    f.store.finishChatBrowserTurn(f.linked.id,'first',{kind:'uncertain',error:'Transport crashed'});
    assert.throws(()=>f.store.reserveChatBrowserTurn(linkedSecond.id,linkedSecond.version,'second',SHA),
      /Another Mission owns/);
    const paused=f.engine.reconcile(f.linked.id,true);
    assert.throws(()=>f.store.linkChat(paused.id,'https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174000',paused.version),
      /Reconcile previous browser dispatch/);
    f.store.reconcileChatBrowserTurn(paused.id);
    const active=f.store.reserveChatBrowserTurn(linkedSecond.id,linkedSecond.version,'second',SHA);
    assert.equal(active.state,'RUNNING');
  }finally{f.cleanup();}
});

test('Browser identity binding is revisioned, idempotent and immutable during uncertain sends',()=>{
  const f=fixture();try {
    const id='install:Chrome:synthetic-test-profile';
    const linked=f.store.bindChatBrowser(f.linked.id,id,f.linked.version);
    assert.equal(linked.mission.version,f.linked.version+1);
    assert.equal(f.store.chatBrowserBinding(f.linked.id),id);
    assert.equal(f.store.bindChatBrowser(f.linked.id,id,linked.mission.version).mission.version,linked.mission.version);
    assert.throws(()=>f.store.bindChatBrowser(f.linked.id,'install:Chrome:other',f.linked.version),/State conflict/);
    const active=f.store.reserveChatBrowserTurn(f.linked.id,linked.mission.version,'bound-first',SHA);
    assert.throws(()=>f.store.bindChatBrowser(f.linked.id,'install:Chrome:other',active.version),/inactive unfinished/);
    f.store.finishChatBrowserTurn(f.linked.id,'bound-first',{kind:'uncertain',error:'Unknown click outcome'});
    const paused=f.engine.reconcile(f.linked.id,true);
    assert.throws(()=>f.store.bindChatBrowser(f.linked.id,'install:Chrome:other',paused.version),
      /Reconcile the previous browser dispatch/);
    const reconciled=f.store.reconcileChatBrowserTurn(paused.id);
    const other=f.store.bindChatBrowser(f.linked.id,'install:Chrome:other',reconciled.version);
    assert.equal(other.browserId,'install:Chrome:other');
    assert.equal(f.store.events(other.mission.id).filter(e=>e.type==='chatgpt.browser_bound').length,2);
  }finally{f.cleanup();}
});

class SyntheticChatPage {
  sends=0;
  prompt='';
  reply='A synthetic verified observation.\n[MISSION_RELAY:DONE]';
  url(){return URL;}
  isClosed(){return false;}
  locator(selector:string):any {
    const self=this;
    let type='unknown';
    if(selector.includes('data-message-author-role="assistant"'))type='assistant';
    if(selector.includes('data-message-author-role="user"'))type='user';
    if(selector.includes('prompt-textarea'))type='composer';
    if(selector.includes('send-button'))type='send';
    if(selector.includes('stop-button'))type='stop';
    const locator:any={
      async count(){return type==='assistant'||type==='user'?1+self.sends:type==='composer'||type==='send'?1:0;},
      first(){return locator;},last(){return locator;},
      async isVisible(){return type!=='stop';},
      async isEnabled(){return type==='send'&&Boolean(self.prompt);},
      async innerText(){
        if(type==='user') return self.sends?self.prompt:'Previous prompt';
        return self.sends?self.reply:'Previous answer';
      },
      async fill(value:string){if(type!=='composer')throw new Error('Wrong editor');self.prompt=value;},
      async click(){if(type!=='send'||!self.prompt)throw new Error('Wrong send');self.sends++;},
    };
    return locator;
  }
  getByRole(_role:string,_options:unknown):any {return this.locator('role-not-present');}
}

class AccessibleChatPage extends SyntheticChatPage {
  override locator(selector:string):any {
    // The current ChatGPT UI has accessible headings and a named textbox,
    // not data-message-author-role or #prompt-textarea.
    if(selector.includes('data-message-author-role')||selector.includes('prompt-textarea')||
      selector.includes('send-button')||selector.includes('stop-button'))
      return super.locator('not-present');
    return super.locator(selector);
  }
  override getByRole(role:string,options:{name:string|RegExp}):any {
    if(role==='heading' && (options.name==='ChatGPT said:'||options.name==='You said:')) {
      const isAssistant=options.name==='ChatGPT said:';
      const target:any={
        count:async()=>1+this.sends,
        last:()=>target,
        locator:(_selector:string)=>({innerText:async()=>isAssistant
          ? 'ChatGPT said:\n'+(this.sends?this.reply:'Previous answer')
          : 'You said:\n'+this.prompt,
          getAttribute:async(name:string)=>isAssistant&&
            name==='data-content-search-unit-key'? 'assistant-turn-'+this.sends:null}),
      };
      return target;
    }
    if(role==='textbox' && options.name==='Ask ChatGPT') return super.locator('prompt-textarea');
    if(role==='button' && options.name instanceof RegExp && options.name.test('Send message'))
      return super.locator('send-button');
    return super.locator('not-present');
  }
}

class TransportBannerPage extends AccessibleChatPage {
  banner:'interrupted'|'delivery-timeout'|null='delivery-timeout';
  retryClicks=0;
  override getByRole(role:string,options:{name:string|RegExp}):any {
    if(role==='button'&&options.name==='Retry') {
      const self=this;
      return {
        count:async()=>self.banner==='delivery-timeout'&&self.sends>0?1:0,
        isVisible:async()=>self.banner==='delivery-timeout'&&self.sends>0,
        isEnabled:async()=>self.banner==='delivery-timeout'&&self.sends>0,
        click:async()=>{
          if(self.banner!=='delivery-timeout'||!self.sends)throw new Error('Retry unavailable');
          self.retryClicks++;
          self.banner=null;
          self.reply='Completed after transport Retry.\n[MISSION_RELAY:DONE]';
        },
      };
    }
    return super.getByRole(role,options);
  }
  getByText(text:string,options:{exact?:boolean}):any {
    const self=this;
    const requested=text===CONNECTION_INTERRUPTED_TEXT?'interrupted':
      text===MESSAGE_DELIVERY_TIMEOUT_TEXT?'delivery-timeout':null;
    const visible=()=>Boolean(options.exact&&self.sends>0&&self.banner===requested&&requested);
    const locator:any={count:async()=>visible()?1:0,isVisible:async()=>visible(),
      nth:(_index:number)=>locator};
    return locator;
  }
}

test('Long-task UI Retry targets only an exact visible delivery banner and bound conversation',async()=>{
  const page=new TransportBannerPage();page.sends=1;
  assert.equal(await visibleLongTaskBanner(page as unknown as Page,
    `An article discussing ${CONNECTION_INTERRUPTED_TEXT} is not a banner.`),'delivery-timeout',
    'Only the genuine delivery UI is visible; quoted prose cannot override it');
  assert.equal(await visibleLongTaskBanner(page as unknown as Page,page.reply),'delivery-timeout');
  assert.equal(await clickDeliveryRetryOnce(page as unknown as Page,URL,false,false),false);
  assert.equal(page.retryClicks,0,'A changed latest user prompt must not trigger Retry');
  await assert.rejects(()=>clickDeliveryRetryOnce(page as unknown as Page,
    'https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614179999',true,false),/URL changed/);
  assert.equal(await clickDeliveryRetryOnce(page as unknown as Page,URL,true,false),true);
  assert.equal(page.retryClicks,1);
  assert.equal(await clickDeliveryRetryOnce(page as unknown as Page,URL,true,true),false);
  assert.equal(await visibleLongTaskBanner(page as unknown as Page,page.reply),null);
  assert.equal(await visibleLongTaskBanner(page as unknown as Page,
    `A paragraph quoted: ${MESSAGE_DELIVERY_TIMEOUT_TEXT} but continued normally`),null);
});

test('Existing ChatGPT continuation clicks the delivery Retry once and observes the same Send',async()=>{
  const page=new TransportBannerPage();
  const result=await submitChatTurn(page as unknown as Page,URL,
    'Owner-authorized existing-message Retry test',12000,true);
  assert.equal(page.sends,1);
  assert.equal(page.retryClicks,1);
  assert.match(result.lastAssistant,/Completed after transport Retry/);
  assert.equal(result.submitted,true);
});

test('Connection interrupted is a waiting state, not a final reply or Retry trigger',async()=>{
  const page=new TransportBannerPage();page.banner='interrupted';
  page.reply='Response is not yet complete.\n[MISSION_RELAY:DONE]';
  assert.equal(await visibleLongTaskBanner(page as unknown as Page,page.reply),null,
    'Before Send a stale or hidden error should not be treated as active');
  await assert.rejects(()=>submitChatTurn(page as unknown as Page,URL,
    'Do not finalize while connection is interrupted',10000,true),/observation timed out/);
  assert.equal(page.sends,1);
  assert.equal(page.retryClicks,0);
  assert.equal(await visibleLongTaskBanner(page as unknown as Page,page.reply),'interrupted');
});

/** Rendered turn counts may shrink after ChatGPT virtualizes old messages. */
class VirtualizedChatPage extends AccessibleChatPage {
  override getByRole(role:string,options:{name:string|RegExp}):any {
    const locator=super.getByRole(role,options);
    if(role==='heading' && (options.name==='You said:'||options.name==='ChatGPT said:'))
      return {...locator,count:async()=>this.sends?3:5};
    return locator;
  }
}

class MismatchedChatPage extends AccessibleChatPage {
  override getByRole(role:string,options:{name:string|RegExp}):any {
    const locator=super.getByRole(role,options);
    if(role==='heading' && options.name==='You said:') {
      const mismatch:any={
        count:()=>locator.count(),
        last:()=>mismatch,
        locator:(_selector:string)=>({innerText:async()=>
          'You said:\nUnrelated later user message, not the authorized prompt'}),
      };
      return mismatch;
    }
    return locator;
  }
}

test('A second accessible assistant turn with identical text is observed once, not replayed',async()=>{
  const f=fixture();try {
    const fake=new AccessibleChatPage();
    fake.reply='Previous answer'; // Deliberately identical to the pre-Send text.
    const observed=await executeBrowserTurn({store:f.store,missionId:f.linked.id,
      revision:f.linked.version,requestKey:'identical-answer-1',
      page:fake as unknown as Page,url:URL,prompt:'Continue exact prior test',
      timeoutMs:10000});
    assert.equal(fake.sends,1);
    assert.equal(observed.turnCount,1);
    assert.equal(observed.assistantSha256,
      createHash('sha256').update('Previous answer').digest('hex'));
    assert.equal(f.store.chatBrowserTurn(f.linked.id)?.status,'observed');
    assert.equal(f.store.events(f.linked.id)
      .filter(event=>event.type==='chatgpt.browser_reserved').length,1);
  }finally{f.cleanup();}
});

const NEXT_CHAT_URL='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614179999';
class SyntheticNewChatPage extends SyntheticChatPage {
  currentUrl='about:blank';
  override url(){return this.currentUrl;}
  async goto(url:string){this.currentUrl=url;}
  async waitForLoadState(_state:string,_options:unknown){return;}
  override locator(selector:string):any {
    const locator=super.locator(selector);
    if(selector.includes('send-button')) {
      const wrapped:any={...locator,click:async()=>{await locator.click();this.currentUrl=NEXT_CHAT_URL;}};
      wrapped.first=()=>wrapped;
      return wrapped;
    }
    return locator;
  }
}
class TransportNewChatPage extends SyntheticNewChatPage {
  banner=true;
  retryClicks=0;
  getByText(text:string,options:{exact?:boolean}):any {
    const self=this;
    const visible=()=>self.sends>0&&self.banner&&options.exact===true&&
      text===MESSAGE_DELIVERY_TIMEOUT_TEXT;
    const locator:any={count:async()=>visible()?1:0,isVisible:async()=>visible(),
      nth:(_index:number)=>locator};
    return locator;
  }
  override getByRole(role:string,options:{name:string|RegExp}):any {
    if(role==='button'&&options.name==='Retry') {
      const self=this;
      return {count:async()=>self.banner&&self.sends>0?1:0,
        isVisible:async()=>self.banner&&self.sends>0,
        isEnabled:async()=>self.banner&&self.sends>0,
        click:async()=>{self.retryClicks++;self.banner=false;
          self.reply='New ChatGPT tab recovered.\n[MISSION_RELAY:DONE]';}};
    }
    return super.getByRole(role,options);
  }
}

test('New ChatGPT conversation retries only the delivery UI, never the original Send',async()=>{
  const page=new TransportNewChatPage();
  const result=await submitNewChatTurn(page as unknown as Page,
    'Authorized new-chat transport Retry test',12000);
  assert.equal(result.url,NEXT_CHAT_URL);
  assert.equal(page.sends,1);
  assert.equal(page.retryClicks,1);
  assert.match(result.receipt.lastAssistant,/New ChatGPT tab recovered/);
});
class TransientNewChatPage extends SyntheticNewChatPage {
  transientReads=0;
  override url(){
    if(this.sends>0&&this.transientReads++<2)return 'https://chatgpt.com/?model=auto';
    return super.url();
  }
}
class AlternateTransitNewChatPage extends SyntheticNewChatPage {
  transientReads=0;
  override url(){
    if(this.sends>0&&this.transientReads++<3)return 'about:blank';
    return super.url();
  }
}
class SourceWithNewTab extends SyntheticChatPage {
  created=0;
  rejectNewTab=false;
  destination=new SyntheticNewChatPage();
  context(){return {newPage:async()=>{
    if(this.rejectNewTab)throw new Error('Extension denied new-tab creation');
    this.created++;return this.destination;
  }};}
}

test('HANDOFF marker creates one new authorized tab, sends task context and atomically migrates the Mission',async()=>{
  const f=fixture();try {
    const source=new SourceWithNewTab();
    source.reply='Verified facts and last decision. Open a new context for the next step.\n[MISSION_RELAY:HANDOFF]';
    source.destination.reply='New conversation continuation acknowledged.\n[MISSION_RELAY:DONE]';
    assert.equal(browserDecision(source.reply),'HANDOFF');
    const done=await driveChatConversation({store:f.store,missionId:f.linked.id,
      revision:f.linked.version,requestPrefix:'rollover-success',turns:3,
      page:source as unknown as Page,url:URL,timeoutMs:12000});
    assert.equal(done.turnsObserved.length,2);
    assert.equal(done.turnsObserved[0]?.flowSignal,'HANDOFF');
    assert.equal(done.turnsObserved[1]?.flowSignal,'DONE');
    assert.equal(source.created,1);
    assert.equal(source.sends,1);
    assert.equal(source.destination.sends,1);
    assert.equal(source.url(),URL,'Original user tab must remain open and unchanged');
    assert.equal(f.store.chatLink(f.linked.id),NEXT_CHAT_URL);
    assert.equal(f.store.get(f.linked.id).state,'PAUSED');
    assert.equal(f.store.get(f.linked.id).turnCount,2);
    assert.ok(source.destination.prompt.includes('Verified facts and last decision'));
    assert.ok(source.destination.prompt.includes('Browser test'));
    assert.equal(f.store.events(f.linked.id).filter(x=>x.type==='chatgpt.browser_migrated').length,1);
    assert.equal(f.store.events(f.linked.id).filter(x=>x.type==='chatgpt.browser_observed').length,2);
    assert.throws(()=>f.store.reserveChatBrowserTurn(f.linked.id,
      f.store.get(f.linked.id).version,'rollover-success-2',SHA),/already used/);
  }finally{f.cleanup();}
});

test('separate manual browser-drive batches auto-handoff after five verified sends without a sixth old-chat Send',async()=>{
  const f=fixture();try{
    const base=f.store.create({goal:'Five-turn browser load bound',
      acceptance:['Keep long tasks in small chats'],workspace:'',
      sandbox:'read-only',mode:'supervised',maxTurns:8,checks:[],requestKey:'manual-five-limit'});
    const linked=f.store.linkChat(base.id,URL,base.version).mission;
    const page=new SourceWithNewTab();
    await assert.rejects(driveChatConversation({store:f.store,missionId:linked.id,
      revision:linked.version,requestPrefix:'manual-over-limit',turns:6,
      page:page as unknown as Page,url:URL,timeoutMs:12000}),
    /Drive turns must be 1–5/);
    assert.equal(page.sends,0);
    const originalLocator=page.locator.bind(page);
    page.locator=(selector:string)=>{
      const original=originalLocator(selector);
      if(!selector.includes('send-button'))return original;
      const changing:any={...original,click:async()=>{
        await original.click();
        page.reply=`Verified item ${page.sends}\n[MISSION_RELAY:NEXT]`;
      }};
      changing.first=()=>changing;
      return changing;
    };
    for(let i=1;i<=5;i++){
      const result=await driveChatConversation({store:f.store,missionId:linked.id,
        revision:f.store.get(linked.id).version,requestPrefix:`manual-five-${i}`,turns:1,
        page:page as unknown as Page,url:URL,timeoutMs:12000});
      assert.equal(result.turnsObserved.length,1);
      assert.equal(page.sends,i);
      assert.equal(page.created,0);
    }
    assert.equal(f.store.piChatObservedTurns(linked.id),5);
    page.reply='A human changed the old answer after the fifth verified Send';
    await assert.rejects(driveChatConversation({store:f.store,missionId:linked.id,
      revision:f.store.get(linked.id).version,requestPrefix:'manual-five-modified',turns:1,
      page:page as unknown as Page,url:URL,timeoutMs:12000}),
    /Five-turn rollover refused: last visible ChatGPT exchange changed/);
    assert.equal(page.sends,5);
    assert.equal(page.created,0);
    assert.equal(f.store.chatBrowserTurn(linked.id)?.status,'observed');
    page.reply='Verified item 5\n[MISSION_RELAY:NEXT]';
    page.destination.reply='Continued in the new chat with prior context.\n[MISSION_RELAY:DONE]';
    const next=await driveChatConversation({store:f.store,missionId:linked.id,
      revision:f.store.get(linked.id).version,requestPrefix:'manual-five-six',turns:1,
      page:page as unknown as Page,url:URL,timeoutMs:12000});
    assert.equal(next.turnsObserved.length,1);
    assert.equal(page.sends,5,'No sixth Send in the original long chat');
    assert.equal(page.created,1);
    assert.equal(page.destination.sends,1);
    assert.equal(f.store.chatLink(linked.id),NEXT_CHAT_URL);
    assert.equal(f.store.piChatObservedTurns(linked.id),1);
    assert.equal(f.store.events(linked.id).filter(e=>e.type==='chatgpt.browser_migrated').length,1);
    assert.match(page.destination.prompt,/Verified item 5/);
  }finally{f.cleanup();}
});

test('Telegram-scoped HANDOFF to a new chat creates only one terminal notification event',async()=>{
  const f=fixture();try {
    const source=new SourceWithNewTab();
    source.reply='Validated context for a new conversation.\n[MISSION_RELAY:HANDOFF]';
    source.destination.reply='Final verified acknowledgement.\n[MISSION_RELAY:DONE]';
    const result=await driveChatConversation({store:f.store,missionId:f.linked.id,
      revision:f.linked.version,requestPrefix:'telegram-200-1',turns:3,
      page:source as unknown as Page,url:URL,timeoutMs:12000,
      notificationMode:'telegram-final'});
    assert.equal(result.turnsObserved.length,2);
    assert.equal(result.turnsObserved[0]?.flowSignal,'HANDOFF');
    assert.equal(result.turnsObserved[1]?.flowSignal,'DONE');
    const events=f.store.events(f.linked.id);
    const observed=events.filter(e=>e.type==='chatgpt.browser_observed');
    const end=events.filter(e=>e.type==='chatgpt.browser_run_finished');
    assert.equal(observed.length,2);
    assert.equal(end.length,1);
    assert.equal((end[0]!.payload as {flowSignal:string}).flowSignal,'DONE');
    assert.equal((end[0]!.payload as {assistantSha256:string}).assistantSha256,
      result.turnsObserved[1]?.responseSha256);
    assert.equal(source.created,1);
    assert.equal(source.destination.sends,1);
    assert.equal(f.store.chatLink(f.linked.id),NEXT_CHAT_URL);
  }finally{f.cleanup();}
});

test('Telegram browser batch stops at Mission budget even if ChatGPT ends NEXT',async()=>{
  const f=fixture();try {
    const base=f.store.create({goal:'Budgeted one-turn ChatGPT run',
      acceptance:['One response; no further send'],workspace:'',sandbox:'read-only',
      mode:'supervised',maxTurns:1,requestKey:'one-turn-budget'});
    const linked=f.store.linkChat(base.id,URL,base.version).mission;
    const page=new SyntheticChatPage();
    page.reply='Only authorized one reply.\n[MISSION_RELAY:NEXT]';
    const result=await driveChatConversation({store:f.store,missionId:linked.id,
      revision:linked.version,requestPrefix:'telegram-budget-1',turns:3,
      page:page as unknown as Page,url:URL,timeoutMs:10000,
      notificationMode:'telegram-final'});
    assert.equal(result.turnsObserved.length,1);
    assert.equal(page.sends,1);
    assert.equal(f.store.get(linked.id).turnCount,1);
    assert.equal(f.store.get(linked.id).state,'PAUSED');
    const events=f.store.events(linked.id);
    assert.equal(events.filter(e=>e.type==='chatgpt.browser_reserved').length,1);
    assert.equal(events.filter(e=>e.type==='chatgpt.browser_run_finished').length,1);
    assert.equal((events.find(e=>e.type==='chatgpt.browser_run_finished')!.payload as
      {flowSignal:string}).flowSignal,'NEXT');
  }finally{f.cleanup();}
});

test('New ChatGPT first Send tolerates same-origin transitional URLs but refuses a different origin',async()=>{
  assert.equal(isPendingNewChatUrl('https://chatgpt.com/?model=auto'),true);
  assert.equal(isPendingNewChatUrl('https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174000?src=new'),true);
  assert.equal(isPendingNewChatUrl('https://example.com/'),false);
  assert.equal(isPendingNewChatUrl('https://chatgpt.com/eval'),false);
  assert.equal(isPendingNewChatUrl('https://chatgpt.com/#secret'),false);
  const page=new TransientNewChatPage();
  page.reply='New chat completed after URL transition.\n[MISSION_RELAY:DONE]';
  const done=await submitNewChatTurn(page as unknown as Page,'Authorized short handoff',12000);
  assert.equal(done.url,NEXT_CHAT_URL);
  assert.equal(page.sends,1);
  assert.ok(page.transientReads>=3);
});

test('Realistic about:blank transition after new-chat Send is observed without duplicate dispatch',async()=>{
  assert.equal(tolerateRolloverNavigation('about:blank',5000),true);
  assert.equal(tolerateRolloverNavigation('',5000),true);
  assert.equal(tolerateRolloverNavigation('data:,',5000),true);
  assert.equal(tolerateRolloverNavigation('chrome-error://chromewebdata/',5000),true);
  assert.equal(tolerateRolloverNavigation('chrome-extension://synthetic-id/boot.html',5000),true);
  assert.equal(tolerateRolloverNavigation('https://chatgpt.com/?temporary=1',5000),true);
  assert.equal(tolerateRolloverNavigation('about:blank',20000),false);
  assert.equal(tolerateRolloverNavigation('chrome-error://chromewebdata/',20000),false);
  assert.equal(tolerateRolloverNavigation('https://untrusted.example/other',5000),false);
  assert.equal(tolerateRolloverNavigation('file:///sensitive',5000),false);
  assert.equal(rolloverUrlClass('chrome-extension://secret-extension/boot.html'),'browser-internal');
  assert.equal(rolloverUrlClass('https://untrusted.example/private?a=b'),'other-origin');
  assert.equal(rolloverUrlClass(''),'empty');
  const page=new AlternateTransitNewChatPage();
  page.reply='Accepted after browser navigation settles.\n[MISSION_RELAY:DONE]';
  const result=await submitNewChatTurn(page as unknown as Page,'Authorized rollover prompt',12000);
  assert.equal(result.url,NEXT_CHAT_URL);
  assert.equal(page.sends,1);
  assert.ok(page.transientReads>3);
});

test('Read-only blank new-chat recovery is restricted to a single direct-URL refresh after two minutes',()=>{
  const snapshot={url:NEXT_CHAT_URL,assistantCount:0,userCount:1,
    composerReady:true,generating:false,lastAssistant:''};
  assert.equal(shouldReloadBlankNewChat(119999,snapshot,false),false);
  assert.equal(shouldReloadBlankNewChat(120000,snapshot,false),true);
  assert.equal(shouldReloadBlankNewChat(150000,snapshot,true),false);
  assert.equal(shouldReloadBlankNewChat(120000,{...snapshot,generating:true},false),false);
  assert.equal(shouldReloadBlankNewChat(120000,{...snapshot,lastAssistant:'partial result'},false),false);
  assert.equal(shouldReloadBlankNewChat(120000,{...snapshot,assistantCount:1},false),true);
});

test('A blank first new-chat viewport can refresh its exact URL without any repeated Send',async()=>{
  const page=new SyntheticNewChatPage();
  page.currentUrl=NEXT_CHAT_URL;
  page.sends=1;
  let reloads=0;
  (page as any).reload=async()=>{reloads++;};
  await reloadBlankDirectNewChat(page as unknown as Page,NEXT_CHAT_URL);
  assert.equal(reloads,1);
  assert.equal(page.sends,1);
  page.currentUrl='https://other.example/unapproved';
  await assert.rejects(()=>reloadBlankDirectNewChat(page as unknown as Page,NEXT_CHAT_URL),
    /direct https|refused|Provide a direct/);
  assert.equal(reloads,1);
  assert.equal(page.sends,1);
});

test('New ChatGPT reply-load error is surfaced as ambiguous without repeat Send',async()=>{
  const page=new SyntheticNewChatPage();
  page.reply='This response couldn’t load\nReload response';
  await assert.rejects(()=>submitNewChatTurn(page as unknown as Page,
    'Authorized handoff not to repeat',12000),/failed to load/);
  assert.equal(page.sends,1);
});

test('A failed new-tab handoff remains uncertain with original link and no replay',async()=>{
  const f=fixture();try {
    const source=new SourceWithNewTab();
    source.reply='Need a fresh conversation.\n[MISSION_RELAY:HANDOFF]';
    source.rejectNewTab=true;
    await assert.rejects(()=>driveChatConversation({store:f.store,missionId:f.linked.id,
      revision:f.linked.version,requestPrefix:'rollover-denied',turns:3,
      page:source as unknown as Page,url:URL,timeoutMs:10000}),/manual reconciliation/);
    assert.equal(source.sends,1);
    assert.equal(f.store.chatLink(f.linked.id),URL);
    assert.equal(f.store.get(f.linked.id).state,'NEEDS_RECONCILIATION');
    assert.equal(f.store.chatBrowserTurn(f.linked.id)?.status,'uncertain');
    assert.equal(f.store.events(f.linked.id).filter(x=>x.type==='chatgpt.browser_migrated').length,0);
    assert.equal(f.store.events(f.linked.id).filter(x=>x.type==='chatgpt.browser_reserved').length,2);
    assert.throws(()=>f.store.reserveChatBrowserTurn(f.linked.id,
      f.store.get(f.linked.id).version,'rollover-denied-2',SHA),/Cannot run|already used/);
  }finally{f.cleanup();}
});

test('Rollover destination and observed receipt share one rollback-safe SQLite transaction',()=>{
  const f=fixture();try {
    f.store.reserveChatBrowserTurn(f.linked.id,f.linked.version,'rollover-atomic',SHA);
    f.store.db.exec(`CREATE TRIGGER fail_chat_migration BEFORE INSERT ON events
      WHEN NEW.type='chatgpt.browser_migrated'
      BEGIN SELECT RAISE(ABORT,'injected rollover audit failure'); END`);
    assert.throws(()=>f.store.finishChatBrowserTurn(f.linked.id,'rollover-atomic',{
      kind:'observed',assistantSha256:SHA,newChatUrl:NEXT_CHAT_URL,summary:'New tab verified',
    }),/injected rollover audit failure/);
    assert.equal(f.store.chatLink(f.linked.id),URL);
    assert.equal(f.store.get(f.linked.id).state,'RUNNING');
    assert.equal(f.store.chatBrowserTurn(f.linked.id)?.status,'reserved');
    assert.equal(f.store.events(f.linked.id).filter(x=>x.type==='chatgpt.browser_observed').length,0);
    f.store.db.exec('DROP TRIGGER fail_chat_migration');
    const m=f.store.finishChatBrowserTurn(f.linked.id,'rollover-atomic',{
      kind:'observed',assistantSha256:SHA,newChatUrl:NEXT_CHAT_URL,summary:'New tab verified',
    });
    assert.equal(m.state,'PAUSED');
    assert.equal(f.store.chatLink(f.linked.id),NEXT_CHAT_URL);
    assert.equal(f.store.events(f.linked.id).filter(x=>x.type==='chatgpt.browser_migrated').length,1);
  }finally{f.cleanup();}
});

test('Operator-confirmed completed new-chat rollover restores the exact link without replay',()=>{
  const f=fixture();try {
    f.store.reserveChatBrowserTurn(f.linked.id,f.linked.version,'recover-new-chat',SHA);
    const uncertain=f.store.finishChatBrowserTurn(f.linked.id,'recover-new-chat',{
      kind:'uncertain',error:'Transient new-chat URL and no observed receipt'});
    assert.throws(()=>f.store.recoverObservedBrowserRollover(f.linked.id,uncertain.version,{
      requestPromptSha256:'0'.repeat(64),assistantSha256:SHA,
      newChatUrl:NEXT_CHAT_URL,summary:'Observed a complete reply',
    }),/hash mismatch/);
    assert.equal(f.store.chatLink(f.linked.id),URL);
    const done=f.store.recoverObservedBrowserRollover(f.linked.id,uncertain.version,{
      requestPromptSha256:SHA,assistantSha256:SHA,newChatUrl:NEXT_CHAT_URL,
      summary:'An independently inspected reply.\n[MISSION_RELAY:DONE]',
    });
    assert.equal(done.state,'PAUSED');
    assert.equal(done.turnCount,1);
    assert.equal(done.version,uncertain.version+1);
    assert.equal(f.store.chatLink(f.linked.id),NEXT_CHAT_URL);
    assert.equal(f.store.chatBrowserTurn(f.linked.id)?.status,'reconciled');
    assert.equal(f.store.events(f.linked.id).filter(x=>x.type==='chatgpt.browser_rollover_recovered').length,1);
    assert.throws(()=>f.store.recoverObservedBrowserRollover(f.linked.id,done.version,{
      requestPromptSha256:SHA,assistantSha256:SHA,newChatUrl:NEXT_CHAT_URL,summary:'Repeated',
    }),/Only an uncertain/);
    assert.throws(()=>f.store.reserveChatBrowserTurn(done.id,done.version,'recover-new-chat',SHA),/already used/);
  }finally{f.cleanup();}
});

test('Rollover recovery refuses to steal a destination owned by another active Mission',()=>{
  const f=fixture();try{
    f.store.reserveChatBrowserTurn(f.linked.id,f.linked.version,'recover-collision',SHA);
    const uncertain=f.store.finishChatBrowserTurn(f.linked.id,'recover-collision',{
      kind:'uncertain',error:'New-tab answer was not yet observed'});
    const other=f.store.create({goal:'Independent observed tab',acceptance:['Check evidence'],
      workspace:'',sandbox:'read-only',mode:'supervised',maxTurns:2,
      checks:[],requestKey:'different-mission'});
    f.store.linkChat(other.id,NEXT_CHAT_URL,other.version);
    const input={requestPromptSha256:SHA,assistantSha256:SHA,
      newChatUrl:NEXT_CHAT_URL,summary:'Validated answer [MISSION_RELAY:NEXT]'};
    assert.throws(()=>f.store.recoverObservedBrowserRollover(f.linked.id,
      uncertain.version,input),/belongs to another active Mission/);
    assert.equal(f.store.get(f.linked.id).state,'NEEDS_RECONCILIATION');
    assert.equal(f.store.chatLink(f.linked.id),URL);
    const cancelled=f.store.get(other.id);
    f.engine.cancel(other.id,cancelled.version);
    assert.equal(f.store.recoverObservedBrowserRollover(f.linked.id,
      uncertain.version,input).turnCount,1);
  }finally{f.cleanup();}
});

test('Recovery audit write failure rolls back URL migration, turn and session lock',()=>{
  const f=fixture();try {
    f.store.reserveChatBrowserTurn(f.linked.id,f.linked.version,'recover-audit',SHA);
    const uncertain=f.store.finishChatBrowserTurn(f.linked.id,'recover-audit',{
      kind:'uncertain',error:'Lost acknowledgement'});
    f.store.db.exec(`CREATE TRIGGER reject_recovery BEFORE INSERT ON events
      WHEN NEW.type='chatgpt.browser_rollover_recovered'
      BEGIN SELECT RAISE(ABORT,'synthetic recovery audit failure'); END`);
    const attempt=()=>f.store.recoverObservedBrowserRollover(f.linked.id,uncertain.version,{
      requestPromptSha256:SHA,assistantSha256:SHA,newChatUrl:NEXT_CHAT_URL,
      summary:'Verified new answer.\n[MISSION_RELAY:DONE]',
    });
    assert.throws(attempt,/synthetic recovery audit failure/);
    assert.equal(f.store.get(f.linked.id).state,'NEEDS_RECONCILIATION');
    assert.equal(f.store.get(f.linked.id).version,uncertain.version);
    assert.equal(f.store.chatLink(f.linked.id),URL);
    assert.equal(f.store.chatBrowserTurn(f.linked.id)?.status,'uncertain');
    f.store.db.exec('DROP TRIGGER reject_recovery');
    assert.equal(attempt().state,'PAUSED');
  }finally{f.cleanup();}
});

test('Handoff marker with no remaining turn budget does not create a tab or extend authority',async()=>{
  const f=fixture();try {
    const source=new SourceWithNewTab();
    source.reply='Handoff needed but no more turns authorized.\n[MISSION_RELAY:HANDOFF]';
    const done=await driveChatConversation({store:f.store,missionId:f.linked.id,
      revision:f.linked.version,requestPrefix:'one-turn-only',turns:1,
      page:source as unknown as Page,url:URL,timeoutMs:12000});
    assert.equal(done.turnsObserved.length,1);
    assert.equal(done.turnsObserved[0]?.flowSignal,'HANDOFF');
    assert.equal(source.created,0);
    assert.equal(f.store.chatLink(f.linked.id),URL);
  }finally{f.cleanup();}
});

test('Playwriter browser controller uses the exact linked chat, sends once and records a paused receipt',async()=>{
  const f=fixture();try{
    const fake=new SyntheticChatPage(),page=fake as unknown as Page;
    const observed=await inspectChatPage(page,URL);
    assert.equal(observed.composerReady,true);
    assert.equal(observed.assistantCount,1);
    const outcome=await driveChatConversation({store:f.store,missionId:f.linked.id,
      revision:f.linked.version,requestPrefix:'synthetic',turns:3,page,url:URL,timeoutMs:10000});
    assert.equal(outcome.turnsObserved.length,1);
    assert.equal(outcome.turnsObserved[0]?.flowSignal,'DONE');
    assert.equal(outcome.state,'PAUSED');
    assert.equal(fake.sends,1);
    assert.equal(f.store.get(f.linked.id).turnCount,1);
    assert.equal(f.store.events(f.linked.id).filter(x=>x.type==='chatgpt.browser_observed').length,1);
    await assert.rejects(()=>driveChatConversation({store:f.store,missionId:f.linked.id,
      revision:f.linked.version,requestPrefix:'synthetic',turns:1,page,url:URL,timeoutMs:10000}),/State conflict/);
    assert.equal(fake.sends,1);
  }finally{f.cleanup();}
});

test('Browser-drive includes the latest owner instruction and consumes it once after observed reply',async()=>{
  const f=fixture();try {
    const note='Only inspect the next acceptance item; do not change files.';
    const instructed=f.engine.instruct(f.linked.id,note,f.linked.version);
    const fake=new SyntheticChatPage(),page=fake as unknown as Page;
    const first=await driveChatConversation({store:f.store,missionId:f.linked.id,
      revision:instructed.version,requestPrefix:'note-once',turns:1,page,url:URL,timeoutMs:10000});
    assert.equal(first.turnsObserved.length,1);
    assert.ok(fake.prompt.includes(`Owner instruction for this turn: ${note}`));
    assert.equal(f.store.get(f.linked.id).nextInstruction,null);
    assert.equal(f.store.chatBrowserTurn(f.linked.id)?.status,'observed');
    assert.equal(f.store.events(f.linked.id).filter(x=>x.type==='chatgpt.browser_observed').length,1);
    assert.ok(!browserContinuationPrompt('Test',['criterion'],false).includes(note));
  }finally{f.cleanup();}
});

test('Long ChatGPT response receipts hash the complete answer, not its tail',async()=>{
  const f=fixture();try {
    const fake=new SyntheticChatPage(),page=fake as unknown as Page;
    fake.reply='Early verification details. '.repeat(240)+
      'Final observable result.\n[MISSION_RELAY:DONE]';
    assert.ok(fake.reply.length>4000);
    const result=await driveChatConversation({store:f.store,missionId:f.linked.id,
      revision:f.linked.version,requestPrefix:'long-answer-hash',turns:1,
      page,url:URL,timeoutMs:10000});
    const wholeHash=createHash('sha256').update(fake.reply).digest('hex');
    const tailHash=createHash('sha256').update(fake.reply.slice(-4000)).digest('hex');
    assert.notEqual(wholeHash,tailHash);
    assert.equal(result.turnsObserved[0]?.responseSha256,wholeHash);
    const observed=f.store.events(f.linked.id).find(x=>x.type==='chatgpt.browser_observed');
    assert.equal((observed?.payload as {assistantSha256?:string})?.assistantSha256,wholeHash);
    assert.equal(f.store.get(f.linked.id).lastSummary?.length,1000);
    assert.equal(result.turnsObserved[0]?.responseExcerpt.length,1000);
    assert.equal(fake.sends,1);
  }finally{f.cleanup();}
});

test('An owner instruction updated after browser reservation survives the observed turn',()=>{
  const f=fixture();try {
    const old=f.engine.instruct(f.linked.id,'Old browser note',f.linked.version);
    const active=f.store.reserveChatBrowserTurn(old.id,old.version,'note-during',SHA);
    const revised=f.engine.instruct(f.linked.id,'New browser note',active.version);
    const observed=f.store.finishChatBrowserTurn(f.linked.id,'note-during',{
      kind:'observed',assistantSha256:SHA,consumedInstruction:'Old browser note'});
    assert.equal(observed.version,revised.version+1);
    assert.equal(observed.nextInstruction,'New browser note');
    assert.equal(observed.turnCount,1);
    assert.ok(browserContinuationPrompt(observed.goal,observed.acceptance,false,
      observed.nextInstruction).includes('New browser note'));
  }finally{f.cleanup();}
});

test('Repeated identical owner note during an active browser send is not accidentally consumed',()=>{
  const f=fixture();try {
    const note='Same instruction deliberately repeated by the owner';
    const before=f.engine.instruct(f.linked.id,note,f.linked.version);
    const active=f.store.reserveChatBrowserTurn(before.id,before.version,'note-duplicate',SHA);
    f.engine.instruct(f.linked.id,note,active.version);
    const done=f.store.finishChatBrowserTurn(f.linked.id,'note-duplicate',{
      kind:'observed',assistantSha256:SHA,consumedInstruction:note});
    assert.equal(done.nextInstruction,note);
  }finally{f.cleanup();}
});

test('A failed or raw browser dispatch never consumes an unsent operator instruction',()=>{
  const f=fixture();try {
    const note='Review this later';
    const instructed=f.engine.instruct(f.linked.id,note,f.linked.version);
    f.store.reserveChatBrowserTurn(instructed.id,instructed.version,'raw-send',SHA);
    const done=f.store.finishChatBrowserTurn(instructed.id,'raw-send',{
      kind:'observed',assistantSha256:SHA});
    assert.equal(done.nextInstruction,note,'Manual browser-send did not inject this note');
    f.store.reserveChatBrowserTurn(done.id,done.version,'failed-followup',SHA);
    const failed=f.store.finishChatBrowserTurn(done.id,'failed-followup',{
      kind:'uncertain',error:'Lost relay',consumedInstruction:note});
    assert.equal(failed.nextInstruction,note,'Ambiguous send cannot consume notes');
    assert.equal(failed.state,'NEEDS_RECONCILIATION');
  }finally{f.cleanup();}
});

test('Oversized browser instruction fails before reserving a browser turn',async()=>{
  const f=fixture();try {
    const tooLong=f.engine.instruct(f.linked.id,'x'.repeat(1501),f.linked.version);
    const fake=new SyntheticChatPage();
    await assert.rejects(()=>driveChatConversation({store:f.store,missionId:f.linked.id,
      revision:tooLong.version,requestPrefix:'too-long-note',turns:1,
      page:fake as unknown as Page,url:URL,timeoutMs:10000}),/exceeds 1500/);
    assert.equal(fake.sends,0);
    assert.equal(f.store.chatBrowserTurn(f.linked.id),null);
    assert.equal(f.store.get(f.linked.id).state,'READY');
  }finally{f.cleanup();}
});

test('Oversized prompt or invalid timeout fails without reserving or sending',async()=>{
  const f=fixture();try {
    const fake=new SyntheticChatPage(),page=fake as unknown as Page;
    for(const input of [
      {prompt:'x'.repeat(12001),timeoutMs:10000},
      {prompt:'Valid tiny prompt',timeoutMs:9999},
    ]) {
      await assert.rejects(()=>executeBrowserTurn({store:f.store,missionId:f.linked.id,
        revision:f.linked.version,requestKey:'invalid-input',page,url:URL,
        ...input}),/no message was reserved/);
    }
    assert.equal(fake.sends,0);
    assert.equal(f.store.chatBrowserTurn(f.linked.id),null);
    assert.equal(f.store.get(f.linked.id).state,'READY');
    assert.equal(f.store.events(f.linked.id).filter(x=>x.type==='chatgpt.browser_reserved').length,0);
  }finally{f.cleanup();}
});

test('Current ChatGPT accessible headings and Ask ChatGPT textbox work without legacy message attributes',async()=>{
  const f=fixture();try{
    const fake=new AccessibleChatPage(),page=fake as unknown as Page;
    const before=await inspectChatPage(page,URL);
    assert.equal(before.assistantCount,1);
    assert.equal(before.userCount,1);
    assert.equal(before.composerReady,true);
    assert.equal(before.lastAssistant,'Previous answer');
    const done=await driveChatConversation({store:f.store,missionId:f.linked.id,
      revision:f.linked.version,requestPrefix:'accessible',turns:2,page,url:URL,timeoutMs:10000});
    assert.equal(fake.sends,1);
    assert.equal(done.state,'PAUSED');
    assert.equal(done.turnsObserved[0]?.flowSignal,'DONE');
    assert.equal(done.turnsObserved[0]?.turnCount,1);
  }finally{f.cleanup();}
});

test('Virtualized ChatGPT turn counts may decrease after send without losing the final receipt',async()=>{
  const f=fixture();try {
    const fake=new VirtualizedChatPage(),page=fake as unknown as Page;
    const before=await inspectChatPage(page,URL);
    assert.equal(before.userCount,5);
    assert.equal(before.assistantCount,5);
    const result=await driveChatConversation({store:f.store,missionId:f.linked.id,
      revision:f.linked.version,requestPrefix:'virtualized',turns:1,page,url:URL,timeoutMs:10000});
    const after=await inspectChatPage(page,URL);
    assert.equal(after.userCount,3);
    assert.equal(after.assistantCount,3);
    assert.equal(result.state,'PAUSED');
    assert.equal(result.turnsObserved[0]?.flowSignal,'DONE');
    assert.equal(fake.sends,1);
    assert.equal(f.store.events(f.linked.id).filter(e=>e.type==='chatgpt.browser_observed').length,1);
  }finally{f.cleanup();}
});

test('A changed assistant reply without the submitted latest user prompt cannot be acknowledged',async()=>{
  const f=fixture();try {
    const fake=new MismatchedChatPage(),page=fake as unknown as Page;
    await assert.rejects(()=>executeBrowserTurn({store:f.store,missionId:f.linked.id,
      revision:f.linked.version,requestKey:'mismatch',page,url:URL,
      prompt:browserContinuationPrompt('test',['evidence'],true),timeoutMs:10000,
      requireFinalMarker:true}),/manual reconciliation/);
    assert.equal(fake.sends,1);
    assert.equal(f.store.get(f.linked.id).state,'NEEDS_RECONCILIATION');
    assert.equal(f.store.events(f.linked.id).filter(e=>e.type==='chatgpt.browser_observed').length,0);
  }finally{f.cleanup();}
});

test('With a 60-second poll, a 12-second deadline during an incomplete stream fails closed without early receipt',async()=>{
  const f=fixture();try {
    const fake=new AccessibleChatPage(),page=fake as unknown as Page;
    fake.reply='Early partial response without a status marker';
    const started=Date.now();
    const markerArrival=setTimeout(()=>{fake.reply='Complete response after a long streaming pause.\n[MISSION_RELAY:DONE]';},4300);
    try {
      await assert.rejects(()=>driveChatConversation({store:f.store,missionId:f.linked.id,
        revision:f.linked.version,requestPrefix:'streaming',turns:1,page,url:URL,timeoutMs:12000}),
        /manual reconciliation/);
      assert.ok(Date.now()-started>=4300,'The controller must wait past the partial response');
      assert.equal(f.store.get(f.linked.id).state,'NEEDS_RECONCILIATION');
      assert.equal(f.store.events(f.linked.id).filter(x=>x.type==='chatgpt.browser_observed').length,0);
      assert.equal(fake.sends,1);
    } finally {clearTimeout(markerArrival);}
  }finally{f.cleanup();}
});

test('Missing final marker fails closed as an ambiguous send and cannot be replayed',async()=>{
  const f=fixture();try {
    const fake=new AccessibleChatPage(),page=fake as unknown as Page;
    fake.reply='An assistant reply was started but never reached its required final marker';
    await assert.rejects(()=>executeBrowserTurn({store:f.store,missionId:f.linked.id,
      revision:f.linked.version,requestKey:'no-final-marker',page,url:URL,
      prompt:browserContinuationPrompt('test',['evidence'],true),timeoutMs:10000,
      requireFinalMarker:true}),/manual reconciliation/);
    assert.equal(fake.sends,1);
    assert.equal(f.store.get(f.linked.id).state,'NEEDS_RECONCILIATION');
    assert.equal(f.store.chatBrowserTurn(f.linked.id)?.status,'uncertain');
    assert.equal(f.store.events(f.linked.id).filter(e=>e.type==='chatgpt.browser_observed').length,0);
    assert.throws(()=>f.store.reserveChatBrowserTurn(f.linked.id,f.store.get(f.linked.id).version,
      'no-final-marker',SHA),/Cannot run|already used/);
  }finally{f.cleanup();}
});

test('Observed browser receipt and at-most-once key survive reopening SQLite',()=>{
  const f=fixture();let closed=false;try {
    f.store.reserveChatBrowserTurn(f.linked.id,f.linked.version,'after-restart',SHA);
    const done=f.store.finishChatBrowserTurn(f.linked.id,'after-restart',
      {kind:'observed',assistantSha256:SHA,summary:'Full observed response'});
    f.store.close();closed=true;
    const reopened=new Store(join(f.dir,'state.sqlite'));
    try {
      assert.equal(reopened.get(done.id).state,'PAUSED');
      assert.equal(reopened.get(done.id).turnCount,1);
      assert.equal(reopened.chatBrowserTurn(done.id)?.status,'observed');
      assert.equal(reopened.chatBrowserTurn(done.id)?.assistantSha256,SHA);
      assert.equal(reopened.events(done.id).filter(e=>e.type==='chatgpt.browser_reserved').length,1);
      assert.equal(reopened.events(done.id).filter(e=>e.type==='chatgpt.browser_observed').length,1);
      assert.throws(()=>reopened.reserveChatBrowserTurn(done.id,done.version,'after-restart',SHA),
        /already used/);
    }finally{reopened.close();}
  }finally{if(!closed)f.store.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('Browser cleanup failure does not mask a dispatch error or invalidate an observed result',async()=>{
  let closes=0;
  const original=console.error;
  const warnings:string[]=[];
  console.error=(...messages:unknown[])=>{warnings.push(messages.map(String).join(' '));};
  const session={page:{} as Page,close:async()=>{closes++;throw new Error('fetch failed');}} as BrowserSession;
  try {
    await assert.rejects(()=>withBrowserSession(session,async()=>{
      throw new Error('Browser turn requires manual reconciliation: connection lost');
    }),/Browser turn requires manual reconciliation: connection lost/);
    const received=await withBrowserSession(session,async()=>({receipt:'observed'}));
    assert.equal(received.receipt,'observed');
    assert.equal(closes,2);
    assert.equal(warnings.length,2);
    assert.ok(warnings.every(x=>x.includes('cleanup warning')));
  } finally {console.error=original;}
});

test('Browser driver stops without blindly continuing unmarked or blocked model responses',()=>{
  assert.equal(browserDecision('No marker at all'),'UNMARKED');
  assert.equal(browserDecision('Need an approval\n[MISSION_RELAY:BLOCKED]'),'BLOCKED');
  assert.equal(browserDecision('Can continue\n[MISSION_RELAY:NEXT]'),'NEXT');
  assert.equal(browserDecision('All verified\n[MISSION_RELAY:DONE]'),'DONE');
  assert.match(browserContinuationPrompt('test',['evidence'],true),/acceptance criteria:/i);
});

test('Browser inspection refuses navigation to another conversation',async()=>{
  const page=new SyntheticChatPage() as unknown as Page;
  await assert.rejects(()=>inspectChatPage(page,'https://chatgpt.com/c/987e6543-e21b-42d3-b654-426614174000'),
    /navigated away/);
});
