import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Page} from 'playwriter';
import {Store} from '../src/core/store.js';
import {Engine} from '../src/core/engine.js';
import {TelegramBridge} from '../src/plugins/telegram.js';

const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const url='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174000';
const prompt='Original submitted request';
const reply='Fresh, completed original answer\n[MISSION_RELAY:NEXT]';
const timeout='ChatGPT response observation timed out; submission outcome is ambiguous';

function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'mr-delivery-retry-'));
  const store=new Store(join(dir,'missions.sqlite'));
  const agent={
    execute:async()=>({status:'blocked' as const,summary:'unused',
      next_instruction:'',evidence:[]}),
    verify:async()=>({accepted:false,reason:'unused',evidence:[]}),
  };
  const engine=new Engine(store,agent);
  const m=engine.create({goal:'Retry original UI message',acceptance:['no Send replay'],
    workspace:'',sandbox:'read-only',mode:'supervised',maxTurns:0,requestKey:'r'});
  const link=store.linkChat(m.id,url,m.version).mission;
  const bound=store.bindChatBrowser(m.id,'install:Chrome:retry',link.version).mission;
  store.setMeta(`pi.autopilot.enabled.${m.id}`,'1');
  store.reserveChatBrowserTurn(m.id,bound.version,'original',hash(prompt));
  return {dir,store,engine,id:m.id,cleanup:()=>{
    store.close();rmSync(dir,{recursive:true,force:true});
  }};
}

class RetryPage {
  banner=true;
  clicks=0;
  user=prompt;
  assistant='Previous assistant response\n[MISSION_RELAY:NEXT]';
  url(){return url;}
  getByText(s:string){
    const shown=()=>this.banner&&s==='Message delivery timed out. Please try again.';
    const locator={count:async()=>shown()?1:0,isVisible:async()=>shown(),
      nth:(_i:number)=>locator};
    return locator;
  }
  getByRole(role:string,options:{name?:string|RegExp}){
    if(role==='button'&&options.name==='Retry'){
      return {count:async()=>this.banner?1:0,
        isVisible:async()=>this.banner,isEnabled:async()=>this.banner,
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
    const bridge=new TelegramBridge(f.store,f.engine,{
      getUpdates:async()=>[],sendMessage:async()=>{},
    },1,2,undefined,async()=>({page:page as unknown as Page,close:async()=>{}}));
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

test('changed last user prompt blocks automatic Retry without consuming its intent',async()=>{
  const f=fixture();try{
    f.store.finishChatBrowserTurn(f.id,'original',{kind:'uncertain',error:timeout});
    const page=new RetryPage();page.user='another human request';
    const bridge=new TelegramBridge(f.store,f.engine,{
      getUpdates:async()=>[],sendMessage:async()=>{},
    },1,2,undefined,async()=>({page:page as unknown as Page,close:async()=>{}}));
    await bridge.recoverUncertainDeliveryOnce();
    assert.equal(page.clicks,0);
    assert.equal(f.store.hasDeliveryRetryIntent(f.id,'original',hash(prompt)),false);
    assert.equal(f.store.get(f.id).state,'NEEDS_RECONCILIATION');
  }finally{f.cleanup();}
});
