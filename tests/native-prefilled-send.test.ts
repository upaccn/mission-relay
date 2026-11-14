import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {Page} from 'playwriter';
import {Store} from '../src/core/store.js';
import {Engine} from '../src/core/engine.js';
import {TelegramBridge} from '../src/plugins/telegram.js';
import {nativePrefilledDraftSha256,clickNativePrefilledSendOnce}
  from '../src/plugins/chatgpt-browser.js';

const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const source='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174000';
const target='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174001';
const prompt='Approved work item with its exact complete text';
const previous='Previous verified answer\n[MISSION_RELAY:NEXT]';
const answer='Distinct completed native new Chat reply\n[MISSION_RELAY:NEXT]';
const timeout='ChatGPT response observation timed out; submission outcome is ambiguous';

function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'relay-native-draft-'));
  const store=new Store(join(dir,'missions.sqlite'));
  const engine=new Engine(store,{
    execute:async()=>({status:'blocked' as const,summary:'unused',
      next_instruction:'',evidence:[]}),
    verify:async()=>({accepted:false,reason:'unused',evidence:[]}),
  });
  const m=engine.create({goal:'Continue original Mission only after exact browser proof',
    acceptance:['No duplicate Send'],workspace:'',sandbox:'read-only',
    mode:'supervised',maxTurns:0,requestKey:'native-draft-fixture'});
  const linked=store.linkChat(m.id,source,m.version).mission;
  const bound=store.bindChatBrowser(m.id,'install:Chrome:native-draft',linked.version).mission;
  store.setMeta(`pi.autopilot.enabled.${m.id}`,'1');
  store.reserveChatBrowserTurn(m.id,bound.version,'first',sha('First exact prompt'));
  store.finishChatBrowserTurn(m.id,'first',{kind:'observed',
    assistantSha256:sha(previous),summary:previous});
  store.commitPiPlan(m.id,sha(previous),[],{
    action:'NEXT',summary:'Continue authorized task',nextPrompt:prompt});
  store.reserveChatBrowserTurn(m.id,store.get(m.id).version,'second',sha(prompt));
  // Synthetic durable prompt snapshot: production versions write this in
  // the same transaction as a bound Goal reservation. No DOM is trusted
  // as a replacement for this hash-checked immutable original prompt.
  store.setMeta(`chatgpt.browser.prompt.${m.id}.second`,
    JSON.stringify({format:'goal-work-v1',prompt}));
  const inflight=store.get(m.id);
  store.update(m.id,inflight.version,{stopRequested:true},'mission.pause_requested');
  store.finishChatBrowserTurn(m.id,'second',{kind:'uncertain',error:timeout});
  const stopped=store.get(m.id);
  assert.equal(store.claimConversationLengthStartIntent(
    m.id,stopped.version,'second',sha(prompt),true),true);
  store.recordConversationLengthStartClicked(m.id,'second',sha(prompt));
  return {store,engine,id:m.id,dir,close:()=>{
    store.close();rmSync(dir,{recursive:true,force:true});
  }};
}

const empty={count:async()=>0,first:()=>({isVisible:async()=>false})};
class DraftPage{
  currentUrl='https://chatgpt.com/';
  text=prompt;
  sends=0;
  url(){return this.currentUrl;}
  locator(_s:string){return empty;}
  getByRole(role:string,opt:{name?:string|RegExp}){
    if(role==='textbox'&&opt.name==='Ask ChatGPT')
      return {count:async()=>1,isVisible:async()=>true,
        innerText:async()=>this.text};
    if(role==='button'&&opt.name instanceof RegExp&&opt.name.test('Send prompt')){
      const button={count:async()=>1,isVisible:async()=>true,
        isEnabled:async()=>true,click:async()=>{this.sends++;}};
      return {count:async()=>1,first:()=>button};
    }
    return empty;
  }
}
class ReplyPage{
  currentUrl=target;
  text=answer;
  user=prompt;
  url(){return this.currentUrl;}
  getByRole(_role:string,_opt?:unknown){return empty;}
  getByText(_s:string){return {count:async()=>0};}
  locator(selector:string):any{
    if(selector.includes('data-message-author-role="assistant"'))
      return {count:async()=>1,last:()=>({
        innerText:async()=>this.text,getAttribute:async()=>null})};
    if(selector.includes('data-message-author-role="user"'))
      return {count:async()=>1,last:()=>({innerText:async()=>this.user})};
    if(selector.includes('prompt-textarea'))
      return {count:async()=>1,isVisible:async()=>true};
    return empty;
  }
}

test('native copied draft hashes the exact unsent textbox, not visible model prose',async()=>{
  const p=new DraftPage();
  assert.equal(await nativePrefilledDraftSha256(p as unknown as Page),sha(prompt));
  p.text=prompt+' another instruction';
  assert.notEqual(await nativePrefilledDraftSha256(p as unknown as Page),sha(prompt));
  p.text=prompt;p.currentUrl=target;
  assert.equal(await nativePrefilledDraftSha256(p as unknown as Page),null);
});

test('one original SQLite authorization permits exactly one native draft Send',async()=>{
  const f=fixture(),p=new DraftPage();try{
    const m=f.store.get(f.id);
    assert.equal(await clickNativePrefilledSendOnce(p as unknown as Page,sha('wrong'),
      ()=>{throw new Error('must not claim');},()=>{}),false);
    assert.equal(p.sends,0);
    const click=()=>clickNativePrefilledSendOnce(p as unknown as Page,sha(prompt),
      ()=>f.store.claimNativePrefilledSendIntent(f.id,m.version,'second',sha(prompt)),
      ()=>f.store.recordNativePrefilledSendClicked(f.id,'second',sha(prompt)));
    assert.equal(await click(),true);
    assert.equal(await click(),false);
    assert.equal(p.sends,1);
    assert.equal(f.store.get(f.id).turnCount,1);
    assert.equal(f.store.get(f.id).state,'NEEDS_RECONCILIATION');
    assert.equal(f.store.chatLink(f.id),source);
    assert.equal(f.store.chatBrowserTurn(f.id)?.status,'uncertain');
    const events=f.store.events(f.id);
    assert.equal(events.filter(e=>e.type==='chatgpt.browser_reserved').length,2);
    assert.equal(events.filter(e=>e.type==='chatgpt.browser_native_prefilled_send_intent').length,1);
    assert.equal(events.filter(e=>e.type==='chatgpt.browser_native_prefilled_send_clicked').length,1);
    const readonly=new Store(join(f.dir,'missions.sqlite'),{readOnly:true});
    try{
      assert.equal(readonly.events(f.id).filter(e=>
        e.type==='chatgpt.browser_native_prefilled_send_intent').length,1);
    }finally{readonly.close();}
  }finally{f.close();}
});

test('fresh native Send denied without Start-new-chat proof or with corrupted original snapshot',()=>{
  const f=fixture();try{
    const m=f.store.get(f.id);
    assert.throws(()=>f.store.claimNativePrefilledSendIntent(
      f.id,m.version-1,'second',sha(prompt)),/requires owner-paused/);
    assert.throws(()=>f.store.claimNativePrefilledSendIntent(
      f.id,m.version,'second',sha('different')),/requires owner-paused/);
    f.store.setMeta(`chatgpt.browser.prompt.${f.id}.second`,
      JSON.stringify({format:'goal-work-v1',prompt:'changed original'}));
    assert.throws(()=>f.store.claimNativePrefilledSendIntent(
      f.id,m.version,'second',sha(prompt)),/snapshot/);
    assert.equal(f.store.events(f.id).filter(e=>
      e.type==='chatgpt.browser_native_prefilled_send_intent').length,0);
  }finally{f.close();}
});

test('worker only credits fully observed direct new-chat reply, then PI may continue',async()=>{
  const f=fixture(),p=new ReplyPage();try{
    const m=f.store.get(f.id);
    assert.equal(f.store.claimNativePrefilledSendIntent(
      f.id,m.version,'second',sha(prompt)),true);
    f.store.recordNativePrefilledSendClicked(f.id,'second',sha(prompt));
    const bridge=new TelegramBridge(f.store,f.engine,{
      getUpdates:async()=>[],sendMessage:async()=>{},
    },1,2,undefined,async(u)=>{
      assert.equal(u,target);
      return {page:p as unknown as Page,close:async()=>{}};
    },undefined,async()=>[{url:target,urlSha256:sha(target),
      lastUserSha256:sha(prompt),duplicate:false}]);
    p.text='Incomplete work (no marker)';
    await bridge.recoverNativePrefilledReplyOnce();
    assert.equal(f.store.get(f.id).turnCount,1);
    p.text=answer;
    await bridge.recoverNativePrefilledReplyOnce();
    assert.equal(f.store.get(f.id).turnCount,2);
    assert.equal(f.store.chatLink(f.id),target);
    assert.equal(f.store.chatBrowserTurn(f.id)?.status,'reconciled');
    assert.equal(f.store.get(f.id).stopRequested,false);
    assert.equal(f.store.events(f.id).filter(e=>
      e.type==='chatgpt.browser_rollover_recovered').length,1);
    await bridge.recoverNativePrefilledReplyOnce();
    assert.equal(f.store.get(f.id).turnCount,2,'Repeated scans never duplicate credit');
  }finally{f.close();}
});

test('native recovery refuses changed new-chat user, missing and duplicate tabs',async()=>{
  for(const [wrong,dup] of [[true,false],[false,true]]){
    const f=fixture(),p=new ReplyPage();try{
      const m=f.store.get(f.id);
      f.store.claimNativePrefilledSendIntent(f.id,m.version,'second',sha(prompt));
      f.store.recordNativePrefilledSendClicked(f.id,'second',sha(prompt));
      const bridge=new TelegramBridge(f.store,f.engine,{
        getUpdates:async()=>[],sendMessage:async()=>{},
      },1,2,undefined,async()=>({page:p as unknown as Page,close:async()=>{}}),
      undefined,async()=>[{url:target,urlSha256:sha(target),
        lastUserSha256:wrong?sha('changed'):sha(prompt),duplicate:dup}]);
      await bridge.recoverNativePrefilledReplyOnce();
      assert.equal(f.store.get(f.id).turnCount,1);
      assert.equal(f.store.get(f.id).stopRequested,true);
      assert.equal(f.store.chatLink(f.id),source);
    }finally{f.close();}
  }
});

test('unpaused Worker automatically submits native copied draft once, while an owner pause blocks Send',async()=>{
  const f=fixture(),p=new DraftPage();try{
    const bridge=new TelegramBridge(f.store,f.engine,{
      getUpdates:async()=>[],sendMessage:async()=>{},
    },1,2,undefined,undefined,undefined,undefined,null,
    async(browserId,digest)=>{
      assert.equal(browserId,'install:Chrome:native-draft');
      assert.equal(digest,sha(prompt));
      return {page:p as unknown as Page,close:async()=>{}};
    });
    await bridge.recoverNativePrefilledDraftOnce();
    assert.equal(p.sends,0,'Original owner pause always denies background Send');
    f.store.update(f.id,f.store.get(f.id).version,{
      stopRequested:false},'test.explicit_unpaused_fixture');
    await bridge.recoverNativePrefilledDraftOnce();
    assert.equal(p.sends,1);
    await bridge.recoverNativePrefilledDraftOnce();
    assert.equal(p.sends,1,'Spent native Send intent is never replayed');
    assert.equal(f.store.events(f.id).filter(e=>
      e.type==='chatgpt.browser_native_prefilled_send_intent').length,1);
    assert.equal(f.store.get(f.id).state,'NEEDS_RECONCILIATION');
    assert.equal(f.store.chatLink(f.id),source);
  }finally{f.close();}
});
