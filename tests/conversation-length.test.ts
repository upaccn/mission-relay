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
import {MAX_CONVERSATION_LENGTH_ERROR} from '../src/core/chat-limits.js';
import {MAX_CONVERSATION_LENGTH_TEXT,visibleConversationLengthLimit,
  clickConversationLengthStartOnce,submitChatTurn} from '../src/plugins/chatgpt-browser.js';

const sha=(v:string)=>createHash('sha256').update(v).digest('hex');
const url='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174000';
const original='Second submitted work item';
const prior='First verified complete reply\n[MISSION_RELAY:NEXT]';
const timeout='ChatGPT response observation timed out; submission outcome is ambiguous';

function fixture(paused=true,error=MAX_CONVERSATION_LENGTH_ERROR){
  const dir=mkdtempSync(join(tmpdir(),'mr-length-'));
  const store=new Store(join(dir,'missions.sqlite'));
  const engine=new Engine(store,{
    execute:async()=>({status:'blocked' as const,summary:'unused',next_instruction:'',evidence:[]}),
    verify:async()=>({accepted:false,reason:'unused',evidence:[]}),
  });
  const m=engine.create({goal:'Inspect original task before further writes',
    acceptance:['Retain original request and no replay'],workspace:'',
    sandbox:'read-only',mode:'supervised',maxTurns:0,requestKey:'length-fixture'});
  const link=store.linkChat(m.id,url,m.version).mission;
  const bound=store.bindChatBrowser(m.id,'install:Chrome:fake',link.version).mission;
  store.setMeta(`pi.autopilot.enabled.${m.id}`,'1');
  store.reserveChatBrowserTurn(m.id,bound.version,'first',sha('First turn'));
  store.finishChatBrowserTurn(m.id,'first',{kind:'observed',
    assistantSha256:sha(prior),summary:prior});
  store.commitPiPlan(m.id,sha(prior),[],{
    action:'NEXT',summary:'Continue verified task',nextPrompt:original});
  store.reserveChatBrowserTurn(m.id,store.get(m.id).version,'second',sha(original));
  if(paused){
    const active=store.get(m.id);
    store.update(m.id,active.version,{stopRequested:true},'mission.pause_requested');
  }
  store.finishChatBrowserTurn(m.id,'second',{kind:'uncertain',error});
  return {store,engine,id:m.id,dir,cleanup:()=>{
    store.close();rmSync(dir,{recursive:true,force:true});
  }};
}

class LengthPage {
  group=`${MAX_CONVERSATION_LENGTH_TEXT}\nStart new chat`;
  button=true;
  clicks=0;
  sends=0;
  target=url;
  url(){return this.target;}
  getByRole(role:string,options:{name?:string|RegExp}){
    if(role==='button'&&options.name==='Start new chat')
      return {count:async()=>this.button?1:0,
        isVisible:async()=>this.button,isEnabled:async()=>this.button,
        locator:()=>({innerText:async()=>this.group}),
        click:async()=>{this.clicks++;this.button=false;}};
    if(role==='button'&&options.name instanceof RegExp&&
      options.name.test('Send prompt')){
      const loc={count:async()=>1,isEnabled:async()=>true,
        click:async()=>{this.sends++;this.button=true;}};
      return {count:async()=>1,first:()=>loc};
    }
    return {count:async()=>0,first:()=>({isVisible:async()=>false})};
  }
  getByText(_text:string){return {count:async()=>0};}
  locator(selector:string):any{
    if(selector.includes('data-message-author-role="assistant"'))
      return {count:async()=>1,last:()=>({innerText:async()=>prior,getAttribute:async()=>null})};
    if(selector.includes('data-message-author-role="user"'))
      return {count:async()=>1,last:()=>({innerText:async()=>original})};
    if(selector.includes('prompt-textarea'))
      return {count:async()=>1,isVisible:async()=>true,fill:async()=>{}};
    return {count:async()=>0,first:()=>({isVisible:async()=>false})};
  }
}

test('platform capacity reached after Send aborts the observer, not by faking a final reply or clicking',async()=>{
  const p=new LengthPage();p.button=false;
  await assert.rejects(
    submitChatTurn(p as unknown as Page,url,original,10_000,true),
    /maximum length; original submitted request has no verified final answer/);
  assert.equal(p.sends,1);
  assert.equal(p.clicks,0);
});

test('native length notice requires one exact visible enabled Start new chat UI group',async()=>{
  const p=new LengthPage();
  assert.equal(await visibleConversationLengthLimit(p as unknown as Page),true);
  p.group='Generated text contains '+MAX_CONVERSATION_LENGTH_TEXT+'\nStart new chat';
  assert.equal(await visibleConversationLengthLimit(p as unknown as Page),false);
  p.group=`${MAX_CONVERSATION_LENGTH_TEXT}\nStart new chat`;
  p.button=false;
  assert.equal(await visibleConversationLengthLimit(p as unknown as Page),false);
});

test('one native click requires original URL/prompt and persisted intent, never a composer Send',async()=>{
  const f=fixture(),p=new LengthPage();try{
    const m=f.store.get(f.id);
    let claimed=0;
    assert.equal(await clickConversationLengthStartOnce(p as unknown as Page,url,false,
      ()=>{claimed++;return true;}),false);
    assert.equal(claimed,0);
    assert.equal(await clickConversationLengthStartOnce(p as unknown as Page,url,true,
      ()=>f.store.claimConversationLengthStartIntent(f.id,m.version,'second',sha(original),true)),true);
    f.store.recordConversationLengthStartClicked(f.id,'second',sha(original));
    assert.equal(p.clicks,1);
    assert.equal(f.store.get(f.id).turnCount,1);
    assert.equal(f.store.get(f.id).state,'NEEDS_RECONCILIATION');
    assert.equal(f.store.chatBrowserTurn(f.id)?.status,'uncertain');
    assert.equal(f.store.chatLink(f.id),url);
    assert.equal(f.store.events(f.id).filter(e=>e.type==='chatgpt.browser_length_start_intent').length,1);
    assert.equal(f.store.events(f.id).filter(e=>e.type==='chatgpt.browser_length_start_clicked').length,1);
    assert.equal(f.store.events(f.id).filter(e=>e.type==='chatgpt.browser_reserved').length,2);
    assert.equal(f.store.events(f.id).filter(e=>e.type==='chatgpt.browser_observed').length,1);
    assert.equal(f.store.claimConversationLengthStartIntent(f.id,m.version,'second',sha(original),true),false,
      'A crash/restart cannot claim another button click');
    const reopened=new Store(join(f.dir,'missions.sqlite'),{readOnly:true});
    try{assert.equal(reopened.events(f.id).filter(e=>e.type==='chatgpt.browser_length_start_intent').length,1);}
    finally{reopened.close();}
  }finally{f.cleanup();}
});

test('the unpaused enrolled Worker claims one max-length UI click but leaves ambiguous work uncredited',async()=>{
  const f=fixture(false),p=new LengthPage();try{
    const bridge=new TelegramBridge(f.store,f.engine,{
      getUpdates:async()=>[],sendMessage:async()=>{},
    },1,2,undefined,async()=>({page:p as unknown as Page,close:async()=>{}}));
    await bridge.recoverUncertainDeliveryOnce();
    assert.equal(p.clicks,1);
    assert.equal(f.store.get(f.id).turnCount,1);
    assert.equal(f.store.get(f.id).state,'NEEDS_RECONCILIATION');
    (bridge as unknown as {lastDeliveryRetryRecoveryAt:number}).lastDeliveryRetryRecoveryAt=0;
    p.button=true;
    await bridge.recoverUncertainDeliveryOnce();
    assert.equal(p.clicks,1,'No click after one durable intent');
  }finally{f.cleanup();}
});

test('owner pause, unrelated errors and missing PI evidence fail closed',()=>{
  const f=fixture();try{
    assert.throws(()=>f.store.claimConversationLengthStartIntent(
      f.id,f.store.get(f.id).version,'second',sha(original)),/stopped/);
    assert.throws(()=>f.store.claimConversationLengthStartIntent(
      f.id,f.store.get(f.id).version,'second',sha('wrong'),true),/stopped/);
    assert.throws(()=>f.store.claimConversationLengthStartIntent(
      f.id,f.store.get(f.id).version-1,'second',sha(original),true),/stopped/);
    assert.equal(f.store.events(f.id).filter(e=>e.type==='chatgpt.browser_length_start_intent').length,0);
  }finally{f.cleanup();}
  const bad=fixture(true,'Unrelated browser error');try{
    assert.throws(()=>bad.store.claimConversationLengthStartIntent(
      bad.id,bad.store.get(bad.id).version,'second',sha(original),true),/stopped/);
  }finally{bad.cleanup();}
  const older=fixture(true,timeout);try{
    assert.equal(older.store.claimConversationLengthStartIntent(
      older.id,older.store.get(older.id).version,'second',sha(original),true),true,
    'Old installed observer only recorded generic timeout; exact UI diagnosis is made by the caller');
  }finally{older.cleanup();}
});
