import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store,isPreSendNewChatOriginNavigationTimeout} from '../src/core/store.js';
import {inspectPiEvidence} from '../src/core/pi-evidence.js';

const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const URL='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174000';
const NEXT='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174001';
const navigationFailure='page.goto: Timeout 30000ms exceeded.\nCall log:\n'+
  '  - navigating to "https://chatgpt.com/", waiting until "domcontentloaded"\n';
const prompt='One original new-chat prompt that was NOT sent';
const originalAnswer='Previous verified answer\n[MISSION_RELAY:NEXT]';
const newAnswer='First actual new-chat response\n[MISSION_RELAY:NEXT]';

function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'relay-pre-send-'));
  const store=new Store(join(dir,'missions.sqlite'));
  const m=store.create({goal:'Continue goal after original navigation failure',
    acceptance:['No duplicated first Send'],workspace:'',sandbox:'read-only',
    mode:'supervised',maxTurns:32,checks:[],requestKey:'pre-send-test'});
  const linked=store.linkChat(m.id,URL,m.version).mission;
  const bound=store.bindChatBrowser(m.id,'install:Chrome:synthetic',linked.version).mission;
  store.setMeta(`pi.autopilot.enabled.${m.id}`,'1');
  for(let i=1;i<=5;i++){
    const question=`Prior question ${i}`,answer=i===5?originalAnswer:
      `Prior answer ${i}\n[MISSION_RELAY:NEXT]`;
    const key=`original-${i}`;
    store.reserveChatBrowserTurn(m.id,store.get(m.id).version,key,sha(question));
    store.finishChatBrowserTurn(m.id,key,{kind:'observed',assistantSha256:sha(answer),summary:answer});
    store.commitPiPlan(m.id,sha(answer),[],{
      action:'NEXT',summary:'Continue original Mission',nextPrompt:'Open the next chat',
    });
  }
  store.reserveChatBrowserTurn(m.id,store.get(m.id).version,'original-6',
    sha(prompt),{newConversation:true});
  store.finishChatBrowserTurn(m.id,'original-6',{
    kind:'uncertain',error:navigationFailure,
  });
  const revision=store.get(m.id).version;
  const input={originalPromptSha256:sha(prompt),
    sourcePromptSha256:sha('Prior question 5'),
    sourceAnswerSha256:sha(originalAnswer)};
  return {store,dir,id:m.id,revision,input,cleanup(){
    store.close();rmSync(dir,{recursive:true,force:true});
  }};
}

test('only the exact first origin goto timeout qualifies as provably pre-Send',()=>{
  assert.equal(isPreSendNewChatOriginNavigationTimeout(navigationFailure),true);
  for(const bad of [undefined,null,'', 'locator.click: Timeout 10000ms exceeded.',
    'page.goto: Timeout 30000ms exceeded.\nCall log:\n  - navigating to "https://chatgpt.com/c/other", waiting until "domcontentloaded"',
    'page.goto: Timeout 30000ms exceeded.\nCall log:\n  - navigating to "https://chatgpt.com/", waiting until "load"',
    'page.goto: Timeout 30000ms exceeded.\nCall log:\n  - navigating to "https://attacker.example/", waiting until "domcontentloaded"'])
    assert.equal(isPreSendNewChatOriginNavigationTimeout(bad),false);
});

test('one-shot authorization preserves uncertain original and permits exactly one real, independently credited later first Send',()=>{
  const f=fixture();try{
    const before=f.store.events(f.id);
    const m=f.store.get(f.id);
    assert.equal(m.state,'NEEDS_RECONCILIATION');
    assert.equal(m.turnCount,5);
    const result=f.store.authorizePreSendRolloverOnce(f.id,f.revision,f.input);
    assert.equal(result.revision,f.revision);
    assert.equal(f.store.get(f.id).state,'NEEDS_RECONCILIATION');
    assert.equal(f.store.get(f.id).turnCount,5);
    assert.equal(f.store.chatBrowserTurn(f.id)?.status,'uncertain');
    assert.deepEqual(f.store.events(f.id).slice(0,before.length),before);
    assert.equal(f.store.events(f.id).filter(e=>e.type==='chatgpt.browser_reserved').length,6);
    assert.equal(f.store.events(f.id).filter(e=>e.type==='chatgpt.browser_uncertain').length,1);
    assert.equal(f.store.events(f.id).filter(e=>
      e.type==='chatgpt.browser_pre_send_retry_intent').length,1);
    assert.throws(()=>f.store.authorizePreSendRolloverOnce(f.id,f.revision,f.input),
      /already been attempted/,'No second new-chat first Send may be authorized');
    const recovered=f.store.recoverObservedBrowserRollover(f.id,f.revision,{
      requestPromptSha256:f.input.originalPromptSha256,newChatUrl:NEXT,
      assistantSha256:sha(newAnswer),summary:newAnswer,
    });
    assert.equal(recovered.turnCount,6);
    assert.equal(recovered.state,'PAUSED');
    assert.equal(f.store.chatLink(f.id),NEXT);
    assert.equal(f.store.chatBrowserTurn(f.id)?.status,'reconciled');
    const proof=inspectPiEvidence(f.store,f.id);
    assert.equal(proof.ledgerConsistent,true,proof.violations.join(','));
    assert.deepEqual(proof.pendingPiReviewRounds,[6]);
    assert.equal(proof.observedTurns,6);
    assert.equal(proof.maxObservedTurnsInOneChat,5);
    assert.equal(f.store.events(f.id).filter(e=>
      e.type==='chatgpt.browser_reserved').length,6,'Original reserved key is reused, never reserved twice');
    assert.equal(f.store.events(f.id).filter(e=>
      e.type==='chatgpt.browser_rollover_recovered').length,1);
    assert.throws(()=>f.store.authorizePreSendRolloverOnce(f.id,recovered.version,f.input));
    const reopened=new Store(join(f.dir,'missions.sqlite'),{readOnly:true});
    try{
      assert.equal(reopened.chatBrowserTurn(f.id)?.status,'reconciled');
      assert.equal(reopened.events(f.id).filter(e=>
        e.type==='chatgpt.browser_pre_send_retry_intent').length,1);
    }finally{reopened.close();}
  }finally{f.cleanup();}
});

test('pre-Send recovery refuses wrong SHA, missing parent PI approval, changed error, owner pause, and stolen original lock',()=>{
  const f=fixture();try{
    const initial=f.store.events(f.id).length;
    assert.throws(()=>f.store.authorizePreSendRolloverOnce(f.id,f.revision,{
      ...f.input,sourceAnswerSha256:sha('not the old answer'),
    }),/unique prior source proof/);
    assert.throws(()=>f.store.authorizePreSendRolloverOnce(f.id,f.revision,{
      ...f.input,originalPromptSha256:sha('another user prompt'),
    }),/exact old navigation timeout/);
    assert.equal(f.store.events(f.id).length,initial);
    const receipt=f.store.chatBrowserTurn(f.id)!;
    f.store.db.prepare('UPDATE meta SET value=? WHERE key=?')
      .run(JSON.stringify({missionId:'foreign',requestKey:receipt.requestKey}),
        `chatgpt.browser.url_lock.${receipt.urlHash}`);
    assert.throws(()=>f.store.authorizePreSendRolloverOnce(f.id,f.revision,f.input),
      /unique original reservation, chat lock or unspent evidence/);
    f.store.db.prepare('UPDATE meta SET value=? WHERE key=?')
      .run(JSON.stringify({missionId:f.id,requestKey:receipt.requestKey}),
        `chatgpt.browser.url_lock.${receipt.urlHash}`);
    f.store.db.prepare('UPDATE missions SET stop_requested=1 WHERE id=?').run(f.id);
    assert.throws(()=>f.store.authorizePreSendRolloverOnce(f.id,f.revision,f.input),
      /exact old navigation timeout/);
    f.store.db.prepare('UPDATE missions SET stop_requested=0,last_error=? WHERE id=?')
      .run('ChatGPT response observation timed out',f.id);
    assert.throws(()=>f.store.authorizePreSendRolloverOnce(f.id,f.revision,f.input),
      /exact old navigation timeout/);
    assert.equal(f.store.events(f.id).length,initial);
    assert.equal(f.store.chatBrowserTurn(f.id)?.status,'uncertain');
  }finally{f.cleanup();}
});

test('one-shot operator CLI refuses missing acknowledgement and stale revisions before connecting to Chrome',()=>{
  const f=fixture();try{
    const original=f.store.events(f.id);
    const run=(args:string[])=>spawnSync(process.execPath,
      ['--import','tsx','src/cli.ts','browser-retry-pre-send-rollover',f.id,...args],{
        cwd:process.cwd(),encoding:'utf8',timeout:15000,
        env:{...process.env,MISSION_RELAY_HOME:f.dir},
      });
    const noAcknowledgement=run(['--revision',String(f.revision)]);
    assert.notEqual(noAcknowledgement.status,0);
    assert.match(noAcknowledgement.stderr,/Explicit acknowledgement/);
    const stale=run(['--revision',String(f.revision-1),'--acknowledge-side-effects']);
    assert.notEqual(stale.status,0);
    assert.match(stale.stderr,/No eligible original, uncertain new-chat request/);
    assert.deepEqual(f.store.events(f.id),original);
    assert.equal(f.store.chatBrowserTurn(f.id)?.status,'uncertain');
    assert.equal(f.store.get(f.id).turnCount,5);
  }finally{f.cleanup();}
});
