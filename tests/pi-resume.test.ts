import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/core/store.js';
import {revokeBuildRepository} from '../src/core/build-scopes.js';

const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const URL='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174000';
const NEXT_URL='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174001';
const answer='Complete paused in-flight response\n[MISSION_RELAY:NEXT]';
function fixture(write=false,newConversation=false){
  const dir=mkdtempSync(join(tmpdir(),'relay-pi-resume-'));
  const workspace=write?'/srv/projects/mission-relay':'';
  const store=new Store(join(dir,'missions.sqlite'));
  const initial=store.create({goal:'Continue after cooperative maintenance',
    acceptance:['Preserve the original Send'],sandbox:write?'workspace-write':'read-only',
    workspace,mode:'supervised',checks:[],requestKey:'pi-resume-test'});
  const linked=store.linkChat(initial.id,URL,initial.version).mission;
  const bound=store.bindChatBrowser(initial.id,'install:Chrome:synthetic',linked.version).mission;
  store.setMeta(`pi.autopilot.enabled.${bound.id}`,'1');
  if(write){
    store.setMeta('telegram.build.project',workspace);
    store.setMeta('telegram.pi.project',workspace);
  }
  store.reserveChatBrowserTurn(bound.id,bound.version,'original-1',
    sha('Original submitted prompt'),{newConversation});
  return {dir,store,id:bound.id,workspace,
    pause:()=>store.pauseGoalMission(bound.id),
    finish:()=>store.finishChatBrowserTurn(bound.id,'original-1',{
      kind:'observed',assistantSha256:sha(answer),summary:answer,
      ...(newConversation?{newChatUrl:NEXT_URL}:{}),
      telegramBatch:{terminal:false,flowSignal:'NEXT',piManaged:true},
    }),
    cleanup:()=>{store.close();rmSync(dir,{force:true,recursive:true});}};
}

test('cooperative maintenance pause settles existing original Send then resumes only its PAUSED PI checkpoint',()=>{
  const f=fixture();try{
    const paused=f.pause();
    assert.equal(paused.state,'RUNNING');
    assert.equal(paused.stopRequested,true);
    assert.equal(f.store.chatBrowserTurn(f.id)?.status,'reserved');
    assert.throws(()=>f.store.resumePausedPiCheckpoint(f.id,paused.version),
      /owner-paused, settled, nonterminal/, 'in-flight Send must not be resumed');
    const settled=f.finish();
    assert.equal(settled.state,'PAUSED');
    assert.equal(settled.turnCount,1);
    assert.equal(settled.stopRequested,true);
    assert.equal(f.store.chatBrowserTurn(f.id)?.status,'observed');
    const original=f.store.events(f.id);
    const resumed=f.store.resumePausedPiCheckpoint(f.id,settled.version);
    assert.equal(resumed.state,'PAUSED','must never become generic READY');
    assert.equal(resumed.turnCount,1);
    assert.equal(resumed.stopRequested,false);
    assert.equal(f.store.piPlan(f.id),null,'new PI decision must follow independent browser readback');
    const events=f.store.events(f.id);
    assert.deepEqual(events.slice(0,original.length),original);
    assert.equal(events.filter(x=>x.type==='chatgpt.browser_reserved').length,1);
    assert.equal(events.filter(x=>x.type==='chatgpt.browser_observed').length,1);
    assert.equal(events.filter(x=>x.type==='pi.pause_released').length,1);
    assert.equal((events.at(-1)!.payload as {requiresIndependentBrowserReadback?:boolean})
      .requiresIndependentBrowserReadback,true);
    assert.throws(()=>f.store.resumePausedPiCheckpoint(f.id,resumed.version),
      /owner-paused, settled, nonterminal/, 'one pause must produce at most one release');
    assert.throws(()=>f.store.resumePausedPiCheckpoint(f.id,settled.version),
      /State conflict/,'stale revision must not mutate state');
    assert.equal(f.store.events(f.id).length,original.length+1);
  }finally{f.cleanup();}
});

test('pause during a new-chat Send preserves its unique migration and can only resume after the answer is observed',()=>{
  const f=fixture(false,true);try{
    const pending=f.store.chatBrowserTurn(f.id);
    assert.equal(pending?.status,'reserved');
    assert.equal(pending?.newConversation,true);
    const paused=f.pause();
    assert.equal(paused.stopRequested,true);
    assert.equal(f.store.chatLink(f.id),URL,'the reservation alone must not replace the pinned URL');
    assert.throws(()=>f.store.resumePausedPiCheckpoint(f.id,paused.version),
      /owner-paused, settled, nonterminal/);
    const settled=f.finish();
    assert.equal(settled.state,'PAUSED');
    assert.equal(settled.stopRequested,true);
    assert.equal(f.store.chatLink(f.id),NEXT_URL);
    assert.equal(f.store.chatBrowserTurn(f.id)?.assistantSha256,sha(answer));
    const before=f.store.events(f.id);
    assert.equal(before.filter(e=>e.type==='chatgpt.browser_reserved').length,1);
    assert.equal(before.filter(e=>e.type==='chatgpt.browser_migrated').length,1);
    assert.equal(before.filter(e=>e.type==='chatgpt.browser_observed').length,1);
    const resumed=f.store.resumePausedPiCheckpoint(f.id,settled.version);
    assert.equal(resumed.state,'PAUSED');
    assert.equal(resumed.stopRequested,false);
    assert.equal(f.store.chatLink(f.id),NEXT_URL);
    assert.deepEqual(f.store.events(f.id).slice(0,before.length),before);
    assert.equal(f.store.events(f.id).filter(e=>e.type==='chatgpt.browser_reserved').length,1,
      'a maintenance resume must not reserve or resend the original new-chat prompt');
  }finally{f.cleanup();}
});

test('PI resume refuses unpaused, terminal, erroneous or revoked-write checkpoints',()=>{
  const normal=fixture();try{
    normal.pause();
    const settled=normal.finish();
    normal.store.update(normal.id,settled.version,{lastError:'Unresolved prior error'},
      'test.source_error');
    assert.throws(()=>normal.store.resumePausedPiCheckpoint(normal.id,
      normal.store.get(normal.id).version),/owner-paused, settled, nonterminal/);
    assert.equal(normal.store.get(normal.id).stopRequested,true);
  }finally{normal.cleanup();}
  const write=fixture(true);try{
    write.pause();
    write.finish();
    revokeBuildRepository(write.store,write.workspace);
    assert.throws(()=>write.store.resumePausedPiCheckpoint(write.id,
      write.store.get(write.id).version),/approval was revoked/);
    assert.equal(write.store.get(write.id).stopRequested,true);
    assert.equal(write.store.events(write.id).filter(e=>e.type==='pi.pause_released').length,0);
  }finally{write.cleanup();}
  const terminal=fixture();try{
    terminal.finish();
    terminal.store.commitPiPlan(terminal.id,sha(answer),[],{
      action:'DONE',summary:'Verified complete',nextPrompt:'',
    });
    terminal.store.update(terminal.id,terminal.store.get(terminal.id).version,
      {stopRequested:true},'mission.pause_requested');
    assert.throws(()=>terminal.store.resumePausedPiCheckpoint(terminal.id,
      terminal.store.get(terminal.id).version),/owner-paused, settled, nonterminal/);
  }finally{terminal.cleanup();}
});

test('manual acknowledgement of a paused ambiguous Send preserves the owner stop and never invents a credited reply',()=>{
  const f=fixture();try{
    const requested=f.pause();
    assert.equal(requested.stopRequested,true);
    const ambiguous=f.store.finishChatBrowserTurn(f.id,'original-1',{
      kind:'uncertain',error:'Synthetic browser observer lost the original outcome',
    });
    assert.equal(ambiguous.state,'NEEDS_RECONCILIATION');
    assert.equal(ambiguous.stopRequested,true);
    assert.equal(ambiguous.turnCount,0);
    const acknowledged=f.store.reconcileChatBrowserTurn(f.id);
    assert.equal(acknowledged.state,'PAUSED');
    assert.equal(acknowledged.stopRequested,true);
    assert.equal(acknowledged.turnCount,0);
    assert.equal(f.store.chatBrowserTurn(f.id)?.status,'reconciled');
    assert.equal(f.store.hasVerifiedPiBrowserCheckpoint(f.id),false);
    assert.throws(()=>f.store.resumePausedPiCheckpoint(f.id,acknowledged.version),
      /owner-paused, settled, nonterminal/);
    assert.equal(f.store.events(f.id).filter(e=>e.type==='chatgpt.browser_reserved').length,1);
    assert.equal(f.store.events(f.id).filter(e=>e.type==='chatgpt.browser_uncertain').length,1);
    assert.equal(f.store.events(f.id).filter(e=>e.type==='chatgpt.browser_observed').length,0);
  }finally{f.cleanup();}
});

test('recover --retry clears only an error at a settled, verified checkpoint and never sends',()=>{
  const f=fixture(true);try{
    const settled=f.finish();
    const receipt=f.store.chatBrowserTurn(f.id)!;
    const match={requestPromptSha256:receipt.promptSha256,assistantSha256:receipt.assistantSha256!};
    assert.throws(()=>f.store.clearSettledPiInterruption(f.id,settled.version,match),
      /settled, verified checkpoint/,'no error means nothing to retry');
    const errored=f.store.update(f.id,settled.version,{lastError:'PI inference timed out'},'test.error');
    assert.throws(()=>f.store.clearSettledPiInterruption(f.id,errored.version,
      {...match,assistantSha256:sha('different visible answer')}),/settled, verified checkpoint/);
    assert.throws(()=>f.store.clearSettledPiInterruption(f.id,errored.version-1,match),
      /settled, verified checkpoint/);
    revokeBuildRepository(f.store,f.workspace);
    assert.throws(()=>f.store.clearSettledPiInterruption(f.id,errored.version,match),
      /settled, verified checkpoint/,'revoked repository grant blocks retry');
    assert.equal(f.store.get(f.id).lastError,'PI inference timed out');
  }finally{f.cleanup();}
  const g=fixture();try{
    const settled=g.finish();
    const receipt=g.store.chatBrowserTurn(g.id)!;
    const errored=g.store.update(g.id,settled.version,{lastError:'PI inference timed out'},'test.error');
    const reservedBefore=g.store.events(g.id).filter(e=>e.type==='chatgpt.browser_reserved').length;
    const cleared=g.store.clearSettledPiInterruption(g.id,errored.version,{
      requestPromptSha256:receipt.promptSha256,assistantSha256:receipt.assistantSha256!});
    assert.equal(cleared.lastError,null);
    assert.equal(cleared.state,'PAUSED');
    assert.equal(cleared.turnCount,1);
    assert.equal(g.store.piPlan(g.id),null,'PI must still review the re-read answer');
    assert.equal(g.store.events(g.id).filter(e=>e.type==='chatgpt.browser_reserved').length,reservedBefore);
    assert.equal(g.store.events(g.id).filter(e=>e.type==='pi.interruption_cleared').length,1);
  }finally{g.cleanup();}
});
