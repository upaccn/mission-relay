import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir,hostname} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/core/store.js';
import {inspectPiEvidence} from '../src/core/pi-evidence.js';

const SHA=(text:string)=>createHash('sha256').update(text).digest('hex');
const URL='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174000';
const DEST='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174001';
const SENT='The original submitted user prompt';
const ANSWER='Independently verified original answer\n[MISSION_RELAY:NEXT]';
const DEAD_PID=2147483647;

function fixture(newConversation=false) {
  const dir=mkdtempSync(join(tmpdir(),'mission-relay-orphan-'));
  const store=new Store(join(dir,'missions.sqlite'));
  const created=store.create({goal:'Recover an original reply without replay',
    acceptance:['Preserve original Send and audit'],workspace:'',sandbox:'read-only',
    mode:'supervised',maxTurns:4,checks:[],requestKey:'orphan'});
  const linked=store.linkChat(created.id,URL,created.version).mission;
  const bound=store.bindChatBrowser(linked.id,'install:Chrome:synthetic',linked.version).mission;
  store.setMeta(`pi.autopilot.enabled.${bound.id}`,'1');
  const mission=store.reserveChatBrowserTurn(bound.id,bound.version,'original-request',SHA(SENT),
    newConversation?{newConversation:true}:{});
  const dead=()=>store.db.prepare('UPDATE missions SET owner_pid=?,owner_host=? WHERE id=?')
    .run(DEAD_PID,hostname(),mission.id);
  const recover=(answer=ANSWER)=>store.recoverObservedBrowserTurn(mission.id,
    store.get(mission.id).version,{requestPromptSha256:SHA(SENT),
      assistantSha256:SHA(answer),summary:answer});
  return {dir,store,mission,dead,recover,cleanup:()=>{
    store.close();rmSync(dir,{force:true,recursive:true});
  }};
}

test('a live or foreign browser Send owner never qualifies for dead-owner recovery',()=>{
  const f=fixture();try{
    assert.equal(f.store.isAbandonedBrowserReservation(f.mission.id),false);
    assert.throws(()=>f.recover(),/Only an uncertain or independently inspected dead-owner/);
    f.store.db.prepare('UPDATE missions SET owner_pid=?,owner_host=? WHERE id=?')
      .run(DEAD_PID,'foreign-host',f.mission.id);
    assert.equal(f.store.isAbandonedBrowserReservation(f.mission.id),false);
    assert.throws(()=>f.recover(),/Only an uncertain or independently inspected dead-owner/);
    f.dead();
    assert.equal(f.store.isAbandonedBrowserReservation(f.mission.id),true);
    assert.equal(f.store.piHealth().missions.find(x=>x.id===f.mission.id)?.phase,
      'dead_owner_reserved_inspect_only_do_not_resend');
    assert.equal(f.store.get(f.mission.id).turnCount,0);
  }finally{f.cleanup();}
});

test('CLI refuses an active reserved browser Send before connecting to Playwriter or changing the ledger',()=>{
  const f=fixture();try{
    const before=f.store.events(f.mission.id).length;
    const run=spawnSync(process.execPath,
      ['--import','tsx','src/cli.ts','browser-recover-turn',f.mission.id,
        '--revision',String(f.mission.version),'--acknowledge-side-effects'],
      {cwd:process.cwd(),encoding:'utf8',timeout:12000,
        env:{...process.env,MISSION_RELAY_HOME:f.dir}});
    assert.notEqual(run.status,0);
    assert.match(run.stderr,/No eligible uncertain or dead-owner reserved existing-chat turn/);
    assert.doesNotMatch(run.stderr,/Playwriter extension connection failed/);
    assert.equal(f.store.events(f.mission.id).length,before);
    assert.equal(f.store.chatBrowserTurn(f.mission.id)?.status,'reserved');
  }finally{f.cleanup();}
});

test('dead-owner original same-chat reservation can be credited once with independent full answer and append-only receipt',()=>{
  const f=fixture();try{
    const original=f.store.events(f.mission.id);
    f.dead();
    const recovered=f.recover();
    assert.equal(recovered.state,'PAUSED');
    assert.equal(recovered.turnCount,1);
    assert.equal(f.store.chatBrowserTurn(recovered.id)?.status,'reconciled');
    assert.equal(f.store.hasVerifiedPiBrowserCheckpoint(recovered.id),true);
    const events=f.store.events(recovered.id);
    assert.deepEqual(events.slice(0,original.length),original);
    assert.equal(events.filter(e=>e.type==='chatgpt.browser_reserved').length,1);
    assert.equal(events.filter(e=>e.type==='chatgpt.browser_uncertain').length,0);
    assert.equal(events.filter(e=>e.type==='chatgpt.browser_observed').length,0);
    const recovery=events.filter(e=>e.type==='chatgpt.browser_turn_recovered');
    assert.equal(recovery.length,1);
    assert.deepEqual((recovery[0]!.payload as {recoverySource?:string,
      originalUncertainEventPreserved?:boolean,originalReservationPreserved?:boolean}),
      {requestKey:'original-request',round:1,assistantSha256:SHA(ANSWER),
        excerpt:ANSWER,independentlyInspected:true,
        originalUncertainEventPreserved:false,originalReservationPreserved:true,
        recoverySource:'dead-owner-reserved'});
    const ledger=inspectPiEvidence(f.store,recovered.id);
    assert.equal(ledger.ledgerConsistent,true);
    assert.deepEqual(ledger.pendingPiReviewRounds,[1]);
    assert.equal(ledger.observedTurns,1);
    f.store.commitPiPlan(recovered.id,SHA(ANSWER),[],{
      action:'NEXT',summary:'Original result reviewed without replay',nextPrompt:'Proceed with remaining work',
    });
    assert.equal(inspectPiEvidence(f.store,recovered.id).decisionsVerified,1);
    assert.throws(()=>f.recover(),/Only an uncertain or independently inspected dead-owner/);
    assert.throws(()=>f.store.reserveChatBrowserTurn(recovered.id,
      f.store.get(recovered.id).version,'original-request',SHA(SENT)),
      /already used/);
    const reopened=new Store(join(f.dir,'missions.sqlite'),{readOnly:true});
    try{
      assert.equal(reopened.get(recovered.id).turnCount,1);
      assert.equal(reopened.events(recovered.id).filter(e=>e.type==='chatgpt.browser_turn_recovered').length,1);
    }finally{reopened.close();}
  }finally{f.cleanup();}
});

test('dead-owner recovery rejects incomplete, unmarked, forged SHA, altered reservation and new-tab requests',()=>{
  const f=fixture();try{
    f.dead();
    assert.throws(()=>f.recover('No complete marker in answer'),/complete SHA-matched final-marked/);
    assert.throws(()=>f.store.recoverObservedBrowserTurn(f.mission.id,
      f.store.get(f.mission.id).version,{requestPromptSha256:SHA(SENT),
        assistantSha256:SHA('another'),summary:ANSWER}),/complete SHA-matched/);
    assert.throws(()=>f.store.recoverObservedBrowserTurn(f.mission.id,
      f.store.get(f.mission.id).version,{requestPromptSha256:SHA('wrong prompt'),
        assistantSha256:SHA(ANSWER),summary:ANSWER}),/cannot be linked/);
    assert.equal(f.store.get(f.mission.id).turnCount,0);
    assert.equal(f.store.chatBrowserTurn(f.mission.id)?.status,'reserved');
    const record=f.store.chatBrowserTurn(f.mission.id)!;
    f.store.db.prepare('UPDATE meta SET value=? WHERE key=?')
      .run(JSON.stringify({missionId:'another-mission',requestKey:record.requestKey}),
        `chatgpt.browser.url_lock.${record.urlHash}`);
    assert.throws(()=>f.recover(),/unique original reservation, chat lock or unspent evidence/);
    assert.equal(f.store.events(f.mission.id).filter(e=>e.type==='chatgpt.browser_turn_recovered').length,0);
  }finally{f.cleanup();}
  const rollover=fixture(true);try{
    rollover.dead();
    assert.equal(rollover.store.isAbandonedBrowserReservation(rollover.mission.id),false);
    assert.equal(rollover.store.isAbandonedBrowserRolloverReservation(rollover.mission.id),true);
    assert.throws(()=>rollover.recover(),/Only an uncertain or independently inspected dead-owner/);
  }finally{rollover.cleanup();}
});

test('dead-owner reserved first new Chat can be recovered once with exact destination and preserved original reservation',()=>{
  const f=fixture(true);try{
    const original=f.store.events(f.mission.id);
    const attempt=(answer=ANSWER,destination=DEST)=>f.store.recoverObservedBrowserRollover(
      f.mission.id,f.store.get(f.mission.id).version,{
        requestPromptSha256:SHA(SENT),newChatUrl:destination,
        assistantSha256:SHA(answer),summary:answer,
      });
    assert.equal(f.store.isAbandonedBrowserRolloverReservation(f.mission.id),false);
    assert.throws(()=>attempt(),/Only an uncertain or dead-owner reserved/);
    f.store.db.prepare('UPDATE missions SET owner_pid=?,owner_host=? WHERE id=?')
      .run(DEAD_PID,'foreign-host',f.mission.id);
    assert.equal(f.store.isAbandonedBrowserRolloverReservation(f.mission.id),false);
    assert.throws(()=>attempt(),/Only an uncertain or dead-owner reserved/);
    f.dead();
    assert.equal(f.store.piHealth().missions.find(x=>x.id===f.mission.id)?.phase,
      'dead_owner_new_chat_reserved_inspect_only_do_not_resend');
    assert.throws(()=>attempt('Incomplete response'),/complete SHA-matched final-marked/);
    assert.equal(f.store.chatLink(f.mission.id),URL);
    const recovered=attempt();
    assert.equal(recovered.turnCount,1);
    assert.equal(recovered.state,'PAUSED');
    assert.equal(f.store.chatLink(recovered.id),DEST);
    assert.equal(f.store.chatBrowserTurn(recovered.id)?.status,'reconciled');
    assert.deepEqual(f.store.events(recovered.id).slice(0,original.length),original);
    const events=f.store.events(recovered.id);
    assert.equal(events.filter(e=>e.type==='chatgpt.browser_reserved').length,1);
    assert.equal(events.filter(e=>e.type==='chatgpt.browser_uncertain').length,0);
    const receipt=events.filter(e=>e.type==='chatgpt.browser_rollover_recovered');
    assert.equal(receipt.length,1);
    assert.equal((receipt[0]!.payload as {recoverySource?:string}).recoverySource,
      'dead-owner-reserved');
    const inspected=inspectPiEvidence(f.store,recovered.id);
    assert.equal(inspected.ledgerConsistent,true,inspected.violations.join(','));
    assert.equal(inspected.observedTurns,1);
    assert.deepEqual(inspected.pendingPiReviewRounds,[1]);
    assert.equal(f.store.hasVerifiedPiBrowserCheckpoint(recovered.id),true);
    assert.throws(()=>attempt(),/Only an uncertain or dead-owner reserved/);
    const reopened=new Store(join(f.dir,'missions.sqlite'),{readOnly:true});
    try{
      assert.equal(reopened.chatLink(recovered.id),DEST);
      assert.equal(inspectPiEvidence(reopened,recovered.id).observedTurns,1);
    }finally{reopened.close();}
  }finally{f.cleanup();}
});

test('dead-owner new-chat recovery rejects forged response, duplicate reservation and audit failure without partial mutations',()=>{
  const f=fixture(true);try{
    f.dead();
    const valid={requestPromptSha256:SHA(SENT),newChatUrl:DEST,
      assistantSha256:SHA(ANSWER),summary:ANSWER};
    assert.throws(()=>f.store.recoverObservedBrowserRollover(f.mission.id,
      f.store.get(f.mission.id).version,{...valid,assistantSha256:SHA('forged')}),
      /complete SHA-matched/);
    assert.throws(()=>f.store.recoverObservedBrowserRollover(f.mission.id,
      f.store.get(f.mission.id).version,{...valid,requestPromptSha256:SHA('wrong')}),
      /request hash mismatch/);
    assert.throws(()=>f.store.recoverObservedBrowserRollover(f.mission.id,
      f.store.get(f.mission.id).version,{...valid,newChatUrl:URL}),
      /not a new conversation/);
    f.store.db.exec(`CREATE TRIGGER reject_rollover_recovery BEFORE INSERT ON events
      WHEN NEW.type='chatgpt.browser_rollover_recovered'
      BEGIN SELECT RAISE(ABORT,'injected rollover recovery failure'); END`);
    assert.throws(()=>f.store.recoverObservedBrowserRollover(f.mission.id,
      f.store.get(f.mission.id).version,valid),/injected rollover recovery failure/);
    assert.equal(f.store.get(f.mission.id).turnCount,0);
    assert.equal(f.store.chatLink(f.mission.id),URL);
    assert.equal(f.store.chatBrowserTurn(f.mission.id)?.status,'reserved');
    assert.equal(f.store.events(f.mission.id).filter(e=>e.type==='mission.reconciled').length,0);
    const original=f.store.events(f.mission.id).find(e=>e.type==='chatgpt.browser_reserved')!;
    f.store.db.prepare('INSERT INTO events(mission_id,created_at,type,payload_json) VALUES(?,?,?,?)')
      .run(f.mission.id,new Date().toISOString(),original.type,JSON.stringify(original.payload));
    assert.throws(()=>f.store.recoverObservedBrowserRollover(f.mission.id,
      f.store.get(f.mission.id).version,valid),/unique original reservation/);
    assert.equal(f.store.get(f.mission.id).turnCount,0);
  }finally{f.cleanup();}
});

test('CLI refuses live new-chat recovery before opening Playwriter or touching SQLite',()=>{
  const f=fixture(true);try{
    const before=f.store.events(f.mission.id).length;
    const run=spawnSync(process.execPath,
      ['--import','tsx','src/cli.ts','browser-recover-rollover',f.mission.id,
        '--revision',String(f.mission.version),'--new-url',DEST,
        '--acknowledge-side-effects'],
      {cwd:process.cwd(),encoding:'utf8',timeout:12000,
        env:{...process.env,MISSION_RELAY_HOME:f.dir}});
    assert.notEqual(run.status,0);
    assert.match(run.stderr,/No eligible uncertain or dead-owner reserved new-chat rollover/);
    assert.doesNotMatch(run.stderr,/Playwriter extension connection failed/);
    assert.equal(f.store.events(f.mission.id).length,before);
    assert.equal(f.store.chatBrowserTurn(f.mission.id)?.status,'reserved');
  }finally{f.cleanup();}
});

test('dead-owner recovery fails closed when the original assistant reply is merely re-rendered',()=>{
  const f=fixture();try{
    const first=f.store.finishChatBrowserTurn(f.mission.id,'original-request',{
      kind:'observed',assistantSha256:SHA(ANSWER),summary:ANSWER});
    f.store.commitPiPlan(first.id,SHA(ANSWER),[],{
      action:'NEXT',summary:'Original observed',nextPrompt:'Continue',
    });
    const second=f.store.reserveChatBrowserTurn(first.id,f.store.get(first.id).version,
      'second-request',SHA('Second different user prompt'));
    f.store.db.prepare('UPDATE missions SET owner_pid=?,owner_host=? WHERE id=?')
      .run(DEAD_PID,hostname(),second.id);
    assert.equal(f.store.isAbandonedBrowserReservation(second.id),true);
    assert.throws(()=>f.store.recoverObservedBrowserTurn(second.id,second.version,{
      requestPromptSha256:SHA('Second different user prompt'),
      assistantSha256:SHA(ANSWER),summary:ANSWER,
    }),/stale prior assistant re-render/);
    assert.equal(f.store.get(second.id).turnCount,1);
    assert.equal(f.store.chatBrowserTurn(second.id)?.status,'reserved');
  }finally{f.cleanup();}
});

test('failed dead-owner recovery audit insertion rolls back turn, active receipt and lock atomically',()=>{
  const f=fixture();try{
    f.dead();
    f.store.db.exec(`CREATE TRIGGER reject_dead_owner_recovery BEFORE INSERT ON events
      WHEN NEW.type='chatgpt.browser_turn_recovered'
      BEGIN SELECT RAISE(ABORT,'injected recovery event failure'); END`);
    assert.throws(()=>f.recover(),/injected recovery event failure/);
    assert.equal(f.store.get(f.mission.id).turnCount,0);
    assert.equal(f.store.get(f.mission.id).state,'RUNNING');
    const record=f.store.chatBrowserTurn(f.mission.id)!;
    assert.equal(record.status,'reserved');
    assert.ok(f.store.getMeta(`chatgpt.browser.url_lock.${record.urlHash}`));
    assert.equal(f.store.events(f.mission.id).filter(e=>e.type==='mission.reconciled').length,0);
  }finally{f.cleanup();}
});

test('owner emergency pause survives dead-owner and uncertain recovery; no automatic NEXT is unlocked',()=>{
  const dead=fixture();try{
    dead.dead();
    dead.store.update(dead.mission.id,dead.store.get(dead.mission.id).version,
      {stopRequested:true},'mission.pause_requested',{reason:'Synthetic owner pause'});
    const recovered=dead.recover();
    assert.equal(recovered.stopRequested,true);
    assert.equal(recovered.state,'PAUSED');
    assert.throws(()=>dead.store.reserveChatBrowserTurn(recovered.id,recovered.version,
      'next-after-owner-pause',SHA('new')),/pending pause request/);
  }finally{dead.cleanup();}
  const uncertain=fixture();try{
    uncertain.store.finishChatBrowserTurn(uncertain.mission.id,'original-request',
      {kind:'uncertain',error:'Original side effect ambiguous'});
    uncertain.store.update(uncertain.mission.id,uncertain.store.get(uncertain.mission.id).version,
      {stopRequested:true},'mission.pause_requested',{reason:'Synthetic owner pause'});
    const recovered=uncertain.recover();
    assert.equal(recovered.stopRequested,true);
    assert.equal(recovered.turnCount,1);
  }finally{uncertain.cleanup();}
  const rollover=fixture(true);try{
    rollover.store.finishChatBrowserTurn(rollover.mission.id,'original-request',
      {kind:'uncertain',error:'Original new-chat outcome ambiguous'});
    rollover.store.update(rollover.mission.id,rollover.store.get(rollover.mission.id).version,
      {stopRequested:true},'mission.pause_requested',{reason:'Synthetic owner pause'});
    const recovered=rollover.store.recoverObservedBrowserRollover(rollover.mission.id,
      rollover.store.get(rollover.mission.id).version,{
        requestPromptSha256:SHA(SENT),newChatUrl:DEST,
        assistantSha256:SHA(ANSWER),summary:ANSWER,
      });
    assert.equal(recovered.stopRequested,true);
    assert.equal(recovered.turnCount,1);
  }finally{rollover.cleanup();}
  const deadRollover=fixture(true);try{
    deadRollover.dead();
    deadRollover.store.update(deadRollover.mission.id,
      deadRollover.store.get(deadRollover.mission.id).version,
      {stopRequested:true},'mission.pause_requested',{reason:'Synthetic owner pause'});
    const recovered=deadRollover.store.recoverObservedBrowserRollover(deadRollover.mission.id,
      deadRollover.store.get(deadRollover.mission.id).version,{
        requestPromptSha256:SHA(SENT),newChatUrl:DEST,
        assistantSha256:SHA(ANSWER),summary:ANSWER,
      });
    assert.equal(recovered.stopRequested,true);
    assert.equal(recovered.state,'PAUSED');
    assert.equal(recovered.turnCount,1);
    assert.throws(()=>deadRollover.store.reserveChatBrowserTurn(recovered.id,recovered.version,
      'another-send',SHA('another request')),/pending pause request/);
  }finally{deadRollover.cleanup();}
});
