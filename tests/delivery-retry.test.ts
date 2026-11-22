import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Page} from 'playwriter';
import {Store} from '../src/core/store.js';
import {TelegramBridge} from '../src/plugins/telegram.js';

const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const url='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174000';
const prompt='Original submitted request';
const reply='Fresh, completed original answer\n[MISSION_RELAY:NEXT]';
const timeout='ChatGPT response observation timed out; submission outcome is ambiguous';
const newChatTimeout='New ChatGPT reply observation timed out; creation outcome is ambiguous';
const destination='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174001';

function fixture(newConversation=false){
  const dir=mkdtempSync(join(tmpdir(),'mr-delivery-retry-'));
  const store=new Store(join(dir,'missions.sqlite'));
  const agent={
    execute:async()=>({status:'blocked' as const,summary:'unused',
      next_instruction:'',evidence:[]}),
    verify:async()=>({accepted:false,reason:'unused',evidence:[]}),
  };
  const m=store.create({goal:'Retry original UI message',acceptance:['no Send replay'],
    workspace:'',sandbox:'read-only',mode:'supervised',requestKey:'r'});
  const link=store.linkChat(m.id,url,m.version).mission;
  const bound=store.bindChatBrowser(m.id,'install:Chrome:retry',link.version).mission;
  store.setMeta(`pi.autopilot.enabled.${m.id}`,'1');
  store.reserveChatBrowserTurn(m.id,bound.version,'original',hash(prompt),
    newConversation?{newConversation:true}:{});
  return {dir,store,id:m.id,cleanup:()=>{
    store.close();rmSync(dir,{recursive:true,force:true});
  }};
}

class RetryPage {
  targetUrl=url;
  banner=true;
  error:'delivery-timeout'|'stream-error'='delivery-timeout';
  clicks=0;
  user=prompt;
  assistant='Previous assistant response\n[MISSION_RELAY:NEXT]';
  url(){return this.targetUrl;}
  getByText(s:string){
    const shown=()=>this.banner&&this.error==='delivery-timeout'&&
      s==='Message delivery timed out. Please try again.';
    const locator={count:async()=>shown()?1:0,isVisible:async()=>shown(),
      nth:(_i:number)=>locator};
    return locator;
  }
  getByRole(role:string,options:{name?:string|RegExp}){
    if(role==='button'&&options.name==='Retry'){
      return {count:async()=>this.banner?1:0,
        isVisible:async()=>this.banner,isEnabled:async()=>this.banner,
        locator:(_xpath:string)=>({innerText:async()=>this.error==='stream-error'
          ?'Error in message stream\nRetry':'Retry'}),
        click:async()=>{this.clicks++;this.banner=false;this.assistant=reply;}};
    }
    return {count:async()=>0,first:()=>({isVisible:async()=>false})};
  }
  locator(selector:string):any{
    if(selector.includes('data-message-author-role="assistant"')){
      const node={count:async()=>1,last:()=>({innerText:async()=>this.assistant,
        getAttribute:async()=>null})};
      return node;
    }
    if(selector.includes('data-message-author-role="user"')){
      return {count:async()=>1,last:()=>({innerText:async()=>this.user})};
    }
    if(selector.includes('prompt-textarea')){
      return {count:async()=>1,isVisible:async()=>true};
    }
    return {count:async()=>0,first:()=>({isVisible:async()=>false})};
  }
}

test('uncertain new-chat recovery refuses wrong, duplicate or missing destination without consuming Retry',async()=>{
  for(const [seenSha,duplicate] of [[hash('unrelated human prompt'),false],
    [hash(prompt),true]] as const){
    const f=fixture(true);try{
      f.store.finishChatBrowserTurn(f.id,'original',{kind:'uncertain',error:newChatTimeout});
      const page=new RetryPage();page.targetUrl=destination;
      const candidates=async()=>[{url:destination,urlSha256:hash(destination),
        lastUserSha256:seenSha,duplicate}];
      const bridge=new TelegramBridge(f.store,{
        getUpdates:async()=>[],sendMessage:async()=>{},
      },1,2,async()=>({page:page as unknown as Page,close:async()=>{}}),
      undefined,candidates);
      await bridge.recoverUncertainDeliveryOnce();
      assert.equal(page.clicks,0);
      assert.equal(f.store.get(f.id).turnCount,0);
      assert.equal(f.store.hasDeliveryRetryIntent(f.id,'original',hash(prompt)),false);
    }finally{f.cleanup();}
  }
});

test('one durable Retry intent survives reopening and never submits a second request',()=>{
  const f=fixture();try{
    assert.equal(f.store.claimDeliveryRetryIntent(f.id,'original',hash(prompt)),true);
    assert.equal(f.store.claimDeliveryRetryIntent(f.id,'original',hash(prompt)),false);
    f.store.recordDeliveryRetryClicked(f.id,'original',hash(prompt));
    f.store.recordDeliveryRetryClicked(f.id,'original',hash(prompt));
    assert.equal(f.store.events(f.id).filter(e=>
      e.type==='chatgpt.browser_delivery_retry_intent').length,1);
    assert.equal(f.store.events(f.id).filter(e=>
      e.type==='chatgpt.browser_delivery_retry_clicked').length,1);
    assert.equal(f.store.events(f.id).filter(e=>
      e.type==='chatgpt.browser_reserved').length,1);
    const reopened=new Store(join(f.dir,'missions.sqlite'),{readOnly:true});
    try{assert.equal(reopened.hasDeliveryRetryIntent(f.id,'original',hash(prompt)),true);}
    finally{reopened.close();}
    assert.throws(()=>f.store.claimDeliveryRetryIntent(f.id,'wrong',hash(prompt)),
      /original active or timed-out/);
  }finally{f.cleanup();}
});

test('timed-out original message gets one UI Retry, then independently recovers original answer',async()=>{
  const f=fixture();try{
    f.store.finishChatBrowserTurn(f.id,'original',{kind:'uncertain',error:timeout});
    const page=new RetryPage();
    const bridge=new TelegramBridge(f.store,{
      getUpdates:async()=>[],sendMessage:async()=>{},
    },1,2,async()=>({page:page as unknown as Page,close:async()=>{}}));
    await bridge.recoverUncertainDeliveryOnce();
    assert.equal(page.clicks,1);
    assert.equal(f.store.get(f.id).state,'NEEDS_RECONCILIATION');
    assert.equal(f.store.hasDeliveryRetryIntent(f.id,'original',hash(prompt)),true);
    (bridge as unknown as {lastDeliveryRetryRecoveryAt:number}).lastDeliveryRetryRecoveryAt=0;
    await bridge.recoverUncertainDeliveryOnce();
    assert.equal(page.clicks,1);
    assert.equal(f.store.get(f.id).turnCount,1);
    assert.equal(f.store.get(f.id).state,'PAUSED');
    assert.equal(f.store.events(f.id).filter(e=>
      e.type==='chatgpt.browser_turn_recovered').length,1);
    assert.equal(f.store.events(f.id).filter(e=>
      e.type==='chatgpt.browser_reserved').length,1);
    (bridge as unknown as {lastDeliveryRetryRecoveryAt:number}).lastDeliveryRetryRecoveryAt=0;
    await bridge.recoverUncertainDeliveryOnce();
    assert.equal(page.clicks,1);
    assert.equal(f.store.get(f.id).turnCount,1);
  }finally{f.cleanup();}
});

test('original continuation completed after timeout recovers without a Retry click or intent',async()=>{
  const f=fixture();try{
    const prior='Verified previous answer\n[MISSION_RELAY:NEXT]';
    f.store.finishChatBrowserTurn(f.id,'original',{
      kind:'observed',assistantSha256:hash(prior),summary:prior,
    });
    f.store.commitPiPlan(f.id,hash(prior),[],{
      action:'NEXT',summary:'Continue the same chat',nextPrompt:prompt,
    });
    f.store.reserveChatBrowserTurn(f.id,f.store.get(f.id).version,'continuation',hash(prompt));
    f.store.finishChatBrowserTurn(f.id,'continuation',{kind:'uncertain',error:timeout});
    const page=new RetryPage();page.banner=false;
    page.assistant=prior;
    const bridge=new TelegramBridge(f.store,{
      getUpdates:async()=>[],sendMessage:async()=>{},
    },1,2,async()=>({page:page as unknown as Page,close:async()=>{}}));

    // A re-render of the previous response is not the next reply.
    await bridge.recoverUncertainDeliveryOnce();
    assert.equal(f.store.get(f.id).state,'NEEDS_RECONCILIATION');
    assert.equal(f.store.get(f.id).turnCount,1);
    page.assistant=reply;
    (bridge as unknown as {lastDeliveryRetryRecoveryAt:number}).lastDeliveryRetryRecoveryAt=0;
    await bridge.recoverUncertainDeliveryOnce();
    assert.equal(f.store.get(f.id).state,'PAUSED');
    assert.equal(f.store.get(f.id).turnCount,2);
    assert.equal(page.clicks,0);
    assert.equal(f.store.hasDeliveryRetryIntent(f.id,'continuation',hash(prompt)),false);
    assert.equal(f.store.events(f.id).filter(e=>
      e.type==='chatgpt.browser_turn_recovered').length,1);
    assert.equal(f.store.events(f.id).filter(e=>
      e.type==='chatgpt.browser_reserved').length,2);
    (bridge as unknown as {lastDeliveryRetryRecoveryAt:number}).lastDeliveryRetryRecoveryAt=0;
    await bridge.recoverUncertainDeliveryOnce();
    assert.equal(f.store.get(f.id).turnCount,2);
  }finally{f.cleanup();}
});

test('unretried timeout does not auto-credit a first-turn response without prior PI custody',async()=>{
  const f=fixture();try{
    f.store.finishChatBrowserTurn(f.id,'original',{kind:'uncertain',error:timeout});
    const page=new RetryPage();page.banner=false;page.assistant=reply;
    const bridge=new TelegramBridge(f.store,{
      getUpdates:async()=>[],sendMessage:async()=>{},
    },1,2,async()=>({page:page as unknown as Page,close:async()=>{}}));
    await bridge.recoverUncertainDeliveryOnce();
    assert.equal(f.store.get(f.id).state,'NEEDS_RECONCILIATION');
    assert.equal(f.store.get(f.id).turnCount,0);
    assert.equal(page.clicks,0);
  }finally{f.cleanup();}
});

test('timed-out stream error retries once and survives a different subsequent Retry banner',async()=>{
  const f=fixture();try{
    f.store.finishChatBrowserTurn(f.id,'original',{kind:'uncertain',error:timeout});
    const page=new RetryPage();page.error='stream-error';
    const bridge=new TelegramBridge(f.store,{
      getUpdates:async()=>[],sendMessage:async()=>{},
    },1,2,async()=>({page:page as unknown as Page,close:async()=>{}}));
    await bridge.recoverUncertainDeliveryOnce();
    assert.equal(page.clicks,1);
    assert.equal(f.store.get(f.id).state,'NEEDS_RECONCILIATION');
    const intent=f.store.events(f.id).find(e=>e.type==='chatgpt.browser_delivery_retry_intent')!;
    assert.equal((intent.payload as {reason:string}).reason,'stream-error');
    // A second kind of Retry control cannot reset the one-request budget.
    page.error='delivery-timeout';page.banner=true;
    (bridge as unknown as {lastDeliveryRetryRecoveryAt:number}).lastDeliveryRetryRecoveryAt=0;
    await bridge.recoverUncertainDeliveryOnce();
    assert.equal(page.clicks,1);
    assert.equal(f.store.events(f.id).filter(e=>
      e.type==='chatgpt.browser_delivery_retry_intent').length,1);
    page.banner=false;
    (bridge as unknown as {lastDeliveryRetryRecoveryAt:number}).lastDeliveryRetryRecoveryAt=0;
    await bridge.recoverUncertainDeliveryOnce();
    assert.equal(page.clicks,1);
    assert.equal(f.store.get(f.id).turnCount,1);
    assert.equal(f.store.get(f.id).state,'PAUSED');
  }finally{f.cleanup();}
});

test('in-flight new-chat request may claim exactly one UI Retry but cannot auto-reconcile its unknown tab',()=>{
  const f=fixture(true);try{
    const r=f.store.chatBrowserTurn(f.id)!;
    assert.equal(r.status,'reserved');
    assert.equal(f.store.claimDeliveryRetryIntent(f.id,'original',hash(prompt),'stream-error'),true);
    assert.equal(f.store.claimDeliveryRetryIntent(f.id,'original',hash(prompt),'delivery-timeout'),false);
    f.store.finishChatBrowserTurn(f.id,'original',{kind:'uncertain',error:timeout});
    assert.equal(f.store.get(f.id).state,'NEEDS_RECONCILIATION');
    assert.equal(f.store.get(f.id).turnCount,0);
    assert.throws(()=>f.store.claimDeliveryRetryIntent(f.id,'original',hash(prompt),'stream-error'),
      /original active or timed-out/);
    assert.equal(f.store.events(f.id).filter(e=>e.type==='chatgpt.browser_reserved').length,1);
  }finally{f.cleanup();}
});

test('changed last user prompt blocks automatic Retry without consuming its intent',async()=>{
  const f=fixture();try{
    f.store.finishChatBrowserTurn(f.id,'original',{kind:'uncertain',error:timeout});
    const page=new RetryPage();page.user='another human request';
    const bridge=new TelegramBridge(f.store,{
      getUpdates:async()=>[],sendMessage:async()=>{},
    },1,2,async()=>({page:page as unknown as Page,close:async()=>{}}));
    await bridge.recoverUncertainDeliveryOnce();
    assert.equal(page.clicks,0);
    assert.equal(f.store.hasDeliveryRetryIntent(f.id,'original',hash(prompt)),false);
    assert.equal(f.store.get(f.id).state,'NEEDS_RECONCILIATION');
  }finally{f.cleanup();}
});

test('repeated exact delivery failures get two bounded follow-up UI clicks without a second composer Send',async()=>{
  const f=fixture();const now=Date.now;try{
    f.store.finishChatBrowserTurn(f.id,'original',{kind:'uncertain',error:timeout});
    const page=new RetryPage();
    const bridge=new TelegramBridge(f.store,{
      getUpdates:async()=>[],sendMessage:async()=>{},
    },1,2,async()=>({page:page as unknown as Page,close:async()=>{}}));
    await bridge.recoverUncertainDeliveryOnce();
    assert.equal(page.clicks,1);
    const initial=now();
    for(const [offset,clicks] of [[40_000,1],[121_000,2],[160_000,2],
      [243_000,3],[370_000,3]] as const){
      page.banner=true;page.assistant='Previous assistant response\n[MISSION_RELAY:NEXT]';
      Date.now=()=>initial+offset;
      (bridge as unknown as {lastDeliveryRetryRecoveryAt:number}).lastDeliveryRetryRecoveryAt=0;
      await bridge.recoverUncertainDeliveryOnce();
      assert.equal(page.clicks,clicks,`unexpected Retry at offset ${offset}`);
    }
    assert.equal(f.store.get(f.id).state,'NEEDS_RECONCILIATION');
    assert.equal(f.store.get(f.id).turnCount,0);
    assert.equal(f.store.events(f.id).filter(e=>e.type==='chatgpt.browser_reserved').length,1);
    assert.deepEqual(f.store.events(f.id)
      .filter(e=>e.type==='chatgpt.browser_delivery_retry_followup_intent')
      .map(e=>(e.payload as {attempt:number}).attempt),[2,3]);
    assert.equal(f.store.events(f.id)
      .filter(e=>e.type==='chatgpt.browser_delivery_retry_followup_clicked').length,2);
    assert.equal(f.store.events(f.id)
      .filter(e=>e.type==='chatgpt.browser_delivery_retry_exhausted').length,1);
    // A completed SHA-distinct answer may be credited even after all Retry
    // allowances are exhausted; the old uncertainty remains in audit history.
    page.banner=false;page.assistant=reply;
    (bridge as unknown as {lastDeliveryRetryRecoveryAt:number}).lastDeliveryRetryRecoveryAt=0;
    await bridge.recoverUncertainDeliveryOnce();
    assert.equal(f.store.get(f.id).state,'PAUSED');
    assert.equal(f.store.get(f.id).turnCount,1);
  }finally{Date.now=now;f.cleanup();}
});

test('follow-up Retry refuses unclicked prior intent, owner pause and wrong original request',()=>{
  const f=fixture();try{
    f.store.finishChatBrowserTurn(f.id,'original',{kind:'uncertain',error:timeout});
    const old=Date.now()-130_000;
    assert.equal(f.store.claimDeliveryRetryFollowupIntent(f.id,'original',hash(prompt),
      'delivery-timeout',old),null);
    assert.equal(f.store.claimDeliveryRetryIntent(f.id,'original',hash(prompt)),true);
    assert.equal(f.store.claimDeliveryRetryFollowupIntent(f.id,'original',hash(prompt),
      'delivery-timeout',old),null);
    f.store.recordDeliveryRetryClicked(f.id,'original',hash(prompt));
    assert.equal(f.store.claimDeliveryRetryFollowupIntent(f.id,'wrong',hash(prompt),
      'delivery-timeout',Date.now()+200_000),null);
    f.store.update(f.id,f.store.get(f.id).version,{stopRequested:true},
      'mission.pause_requested');
    assert.equal(f.store.claimDeliveryRetryFollowupIntent(f.id,'original',hash(prompt),
      'delivery-timeout',Date.now()+200_000),null);
    f.store.update(f.id,f.store.get(f.id).version,{stopRequested:false},
      'test.resume_after_pause');
    const attempt=f.store.claimDeliveryRetryFollowupIntent(f.id,'original',hash(prompt),
      'delivery-timeout',Date.now()+200_000);
    assert.equal(attempt,2);
    assert.equal(f.store.claimDeliveryRetryFollowupIntent(f.id,'original',hash(prompt),
      'delivery-timeout',Date.now()+400_000),null,
      'An unconfirmed second click cannot consume or authorize the third');
    const reopened=new Store(join(f.dir,'missions.sqlite'),{readOnly:true});
    try{assert.equal(reopened.hasDeliveryRetryIntent(f.id,'original',hash(prompt)),true);}
    finally{reopened.close();}
    assert.equal(f.store.events(f.id)
      .filter(e=>e.type==='chatgpt.browser_delivery_retry_followup_intent').length,1);
    assert.equal(f.store.events(f.id)
      .filter(e=>e.type==='chatgpt.browser_delivery_retry_followup_clicked').length,0);
  }finally{f.cleanup();}
});

test('completed existing-chat response after first UI Retry is independently recovered',async()=>{
  const f=fixture();try{
    const prior='Previously authenticated assistant reply\n[MISSION_RELAY:NEXT]';
    f.store.finishChatBrowserTurn(f.id,'original',{
      kind:'observed',assistantSha256:hash(prior),summary:prior});
    f.store.commitPiPlan(f.id,hash(prior),[],{
      action:'NEXT',summary:'Continue authorized goal',nextPrompt:prompt});
    f.store.reserveChatBrowserTurn(f.id,f.store.get(f.id).version,'next',hash(prompt));
    assert.equal(f.store.claimDeliveryRetryIntent(f.id,'next',hash(prompt)),true);
    f.store.recordDeliveryRetryClicked(f.id,'next',hash(prompt));
    f.store.finishChatBrowserTurn(f.id,'next',{kind:'uncertain',error:timeout});
    const page=new RetryPage();page.banner=false;page.assistant=reply;
    const bridge=new TelegramBridge(f.store,{
      getUpdates:async()=>[],sendMessage:async()=>{},
    },1,2,async()=>({page:page as unknown as Page,close:async()=>{}}));
    await bridge.recoverUncertainDeliveryOnce();
    assert.equal(f.store.get(f.id).state,'PAUSED');
    assert.equal(f.store.get(f.id).turnCount,2);
    assert.equal(page.clicks,0);
    assert.equal(f.store.events(f.id).filter(e=>e.type==='chatgpt.browser_reserved').length,2);
  }finally{f.cleanup();}
});

test('active original browser observation may retry again after a durable prior click and cooldown',()=>{
  const f=fixture();try{
    const initial=Date.now();
    assert.equal(f.store.claimDeliveryRetryIntent(f.id,'original',hash(prompt)),true);
    f.store.recordDeliveryRetryClicked(f.id,'original',hash(prompt));
    assert.equal(f.store.claimDeliveryRetryFollowupIntent(f.id,'original',hash(prompt),
      'delivery-timeout',initial+60_000),null);
    assert.equal(f.store.claimDeliveryRetryFollowupIntent(f.id,'original',hash(prompt),
      'delivery-timeout',initial+121_000),2);
    f.store.recordDeliveryRetryFollowupClicked(f.id,'original',hash(prompt),2);
    assert.equal(f.store.get(f.id).state,'RUNNING');
    assert.equal(f.store.chatBrowserTurn(f.id)?.status,'reserved');
    assert.equal(f.store.claimDeliveryRetryFollowupIntent(f.id,'original',hash(prompt),
      'delivery-timeout',initial+242_000),3);
    f.store.recordDeliveryRetryFollowupClicked(f.id,'original',hash(prompt),3);
    assert.equal(f.store.claimDeliveryRetryFollowupIntent(f.id,'original',hash(prompt),
      'delivery-timeout',initial+364_000),null);
    assert.equal(f.store.events(f.id).filter(e=>
      e.type==='chatgpt.browser_delivery_retry_exhausted').length,1);
    assert.equal(f.store.events(f.id).filter(e=>
      e.type==='chatgpt.browser_reserved').length,1);
    assert.equal(f.store.get(f.id).turnCount,0);
  }finally{f.cleanup();}
});
