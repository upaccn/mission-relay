import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import type {Page} from 'playwriter';
import {Store} from '../src/core/store.js';
import {Engine} from '../src/core/engine.js';
import {TelegramBridge} from '../src/plugins/telegram.js';
import type {ConnectedChatCandidate} from '../src/core/browser-watch.js';
import {enableBrowserWatch,disableBrowserWatch,watchedBrowser,
  nextBrowserWatchCandidate,acknowledgeBrowserWatchCandidate,
  orderedBrowserWatchCandidates,recordBrowserWatchAttempt} from '../src/core/browser-watch.js';
import type {AgentAdapter} from '../src/core/types.js';

const browserId='install:Chrome:test-profile';
const urlA='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174020';
const urlB='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174021';
const hash=(input:string)=>createHash('sha256').update(input).digest('hex');
function candidate(url:string,user:string|null,duplicate=false):ConnectedChatCandidate{
  return {url,urlSha256:hash(url),lastUserSha256:user?hash(user):null,duplicate};
}
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'mission-browser-watch-'));
  const store=new Store(join(dir,'missions.sqlite'));
  return {dir,store,close:()=>{store.close();rmSync(dir,{recursive:true,force:true});}};
}

test('A pinned whole-profile watch baselines existing tabs without adopting; changed chats are detected',()=>{
  const f=fixture();
  try{
    const original=candidate(urlA,'Already finished task');
    assert.deepEqual(enableBrowserWatch(f.store,browserId,[original]),{browserId,baseline:1});
    assert.equal(watchedBrowser(f.store),browserId);
    assert.equal(nextBrowserWatchCandidate(f.store,browserId,[original]),null);
    const changed=candidate(urlA,'A new task');
    assert.equal(nextBrowserWatchCandidate(f.store,browserId,[changed])?.url,urlA);
    acknowledgeBrowserWatchCandidate(f.store,browserId,changed);
    assert.equal(nextBrowserWatchCandidate(f.store,browserId,[changed]),null);
    assert.equal(nextBrowserWatchCandidate(f.store,browserId,[candidate(urlB,'New',true)]),null,
      'Two controllable tabs with the same URL must never be selected silently');
    assert.equal(nextBrowserWatchCandidate(f.store,'install:Chrome:wrong',[candidate(urlB,'New')]),null);
    assert.throws(()=>enableBrowserWatch(f.store,'install:Chrome:wrong',[]),/different profile/);
    disableBrowserWatch(f.store);
    assert.equal(nextBrowserWatchCandidate(f.store,browserId,[candidate(urlB,'New')]),null);
    assert.throws(()=>acknowledgeBrowserWatchCandidate(f.store,browserId,changed),/revoked/);
  }finally{f.close();}
});

test('A permanently incomplete earlier conversation does not starve later ready tabs',()=>{
  const f=fixture();
  try {
    const pending=candidate(urlA,'Unfinished earlier request');
    const ready=candidate(urlB,'Ready newer request');
    enableBrowserWatch(f.store,browserId,[]);
    const inventory=[pending,ready];
    const first=nextBrowserWatchCandidate(f.store,browserId,
      orderedBrowserWatchCandidates(f.store,browserId,inventory));
    assert.equal(first?.url,urlA);
    recordBrowserWatchAttempt(f.store,browserId,first!);
    // The first page remains unfinished, hence unacknowledged.
    const next=nextBrowserWatchCandidate(f.store,browserId,
      orderedBrowserWatchCandidates(f.store,browserId,inventory));
    assert.equal(next?.url,urlB);
    recordBrowserWatchAttempt(f.store,browserId,next!);
    acknowledgeBrowserWatchCandidate(f.store,browserId,next!);
    assert.equal(nextBrowserWatchCandidate(f.store,browserId,
      orderedBrowserWatchCandidates(f.store,browserId,inventory))?.url,urlA);
  }finally{f.close();}
});

test('An uncertain PI new-chat Send prevents the watcher from adopting its orphan as read-only',async()=>{
  const f=fixture();try{
    const m=f.store.create({goal:'Owner-approved source development',acceptance:['Real code'],
      workspace:'/srv/projects/mission-relay',sandbox:'workspace-write',
      mode:'supervised',maxTurns:32,requestKey:'telegram-pi-test',checks:[]});
    const linked=f.store.linkChat(m.id,urlA,m.version).mission;
    const bound=f.store.bindChatBrowser(linked.id,browserId,linked.version).mission;
    f.store.setMeta(`pi.autopilot.enabled.${m.id}`,'1');
    f.store.setMeta('telegram.pi.project',m.workspace);
    f.store.setMeta('telegram.build.project',m.workspace);
    f.store.reserveChatBrowserTurn(m.id,bound.version,'telegram-pi-test-1',hash('Exact prompt'));
    f.store.finishChatBrowserTurn(m.id,'telegram-pi-test-1',{
      kind:'uncertain',error:'Observed new ChatGPT tab but reply did not match prompt hash'});
    enableBrowserWatch(f.store,browserId,[]);
    let enumerated=0;
    const noAgent:AgentAdapter={async execute(){throw new Error('Never execute');},
      async verify(){throw new Error('Never verify');}};
    const bridge=new TelegramBridge(f.store,new Engine(f.store,noAgent),{
      getUpdates:async()=>[],sendMessage:async()=>{},
    },1001,2001,async()=>({ok:true,source:'test',message:'ready'}),
    async()=>{throw new Error('Do not adopt uncertain browser response');},
    {decide:async()=>({action:'DONE',summary:'unused',nextPrompt:''})},
    async()=>{enumerated++;return [candidate(urlB,'Orphaned PI new-chat request')];});
    assert.equal(await bridge.scanBrowserWatchOnce(),null);
    assert.equal(enumerated,0);
    assert.equal(f.store.list().length,1);
    assert.equal(f.store.get(m.id).state,'NEEDS_RECONCILIATION');
  }finally{f.close();}
});

test('Telegram watcher records one stable human-origin Mission, no Playwriter Send, no native agent',async()=>{
  const f=fixture();
  try{
    const never:AgentAdapter={
      async execute(){throw new Error('Native executor must not be invoked');},
      async verify(){throw new Error('Native verifier must not be invoked');},
    };
    let target=urlA,user='Initial request',answer='A completed initial answer';
    let clicks=0;
    const locator=(selector:string)=>{
      const kind=selector.includes('data-message-author-role="assistant"')?'assistant':
        selector.includes('data-message-author-role="user"')?'user':
        selector.includes('prompt-textarea')?'composer':
        selector.includes('send-button')?'send':'other';
      const item:any={count:async()=>kind==='other'?0:1,
        first:()=>item,last:()=>item,
        isVisible:async()=>kind!=='other',isEnabled:async()=>true,
        innerText:async()=>kind==='user'?user:kind==='assistant'?answer:'',
        click:async()=>{clicks++;},fill:async()=>{throw new Error('No automatic Send permitted during adoption');}};
      return item;
    };
    const page={url:()=>target,locator,getByRole:()=>({
      count:async()=>0,first:()=>({isVisible:async()=>false}),
    })} as unknown as Page;
    const existing=f.store.create({goal:'An earlier owned conversation',acceptance:['Existing'],
      workspace:'',sandbox:'read-only',mode:'supervised',maxTurns:1,
      requestKey:'existing-browser-watch',checks:[]});
    const linked=f.store.linkChat(existing.id,urlA,existing.version).mission;
    f.store.bindChatBrowser(existing.id,browserId,linked.version);
    let inventory=[candidate(urlA,user)];
    enableBrowserWatch(f.store,browserId,inventory);
    const bridge=new TelegramBridge(f.store,new Engine(f.store,never),{
      getUpdates:async()=>[],sendMessage:async()=>{},
    },1001,2001,async()=>({ok:true,source:'test',message:'ready'}),
    async(url,options)=>{
      assert.equal(url,target);assert.equal(options?.browserId,browserId);
      return {page,close:async()=>{}};
    },{decide:async()=>({action:'DONE',summary:'done',nextPrompt:''})},
    async()=>inventory);
    assert.equal(await bridge.scanBrowserWatchOnce(),null);
    target=urlB;user='New user-started research question';
    answer='Research findings from an existing human conversation';
    inventory=[candidate(urlA,'An unrelated new human turn in the already linked chat'),
      candidate(urlB,user)];
    const id=await bridge.scanBrowserWatchOnce();
    assert.ok(id);
    assert.equal(f.store.chatLink(id),urlB);
    assert.equal(f.store.chatBrowserBinding(id),browserId);
    assert.equal(f.store.get(id).turnCount,0);
    assert.equal(f.store.getMeta(`pi.autopilot.enabled.${id}`),'1');
    assert.equal(f.store.getMeta(`browser.watch.mission.${id}`),browserId);
    assert.equal(f.store.events(id).filter(e=>e.type==='chatgpt.browser_adopted').length,1);
    assert.equal(f.store.events(id).filter(e=>e.type==='chatgpt.browser_reserved').length,0);
    assert.equal(clicks,0);
    assert.equal(await bridge.scanBrowserWatchOnce(),null);
    assert.equal(f.store.list().length,2);
    disableBrowserWatch(f.store);
    inventory.push(candidate('https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174022','Other new task'));
    assert.equal(await bridge.scanBrowserWatchOnce(),null);
    assert.equal(f.store.list().length,2);
  }finally{f.close();}
});

test('Local watch revocation atomically requests a stop on pending watched Missions',()=>{
  const f=fixture();
  try{
    const prior=candidate(urlA,'Owner prompt');
    enableBrowserWatch(f.store,browserId,[prior]);
    const m=f.store.create({goal:'Previously adopted owner task',acceptance:['Evidence'],
      workspace:'',sandbox:'read-only',mode:'supervised',maxTurns:3,
      requestKey:'watch-revoke',checks:[]});
    const linked=f.store.linkChat(m.id,urlA,m.version).mission;
    const bound=f.store.bindChatBrowser(m.id,browserId,linked.version).mission;
    const adopted=f.store.recordChatAdoption(m.id,bound.version,{
      userSha256:hash('Owner prompt'),assistantSha256:hash('Existing reply'),summary:'Existing reply'});
    f.store.setMeta(`pi.autopilot.enabled.${adopted.id}`,'1');
    f.store.setMeta(`browser.watch.mission.${adopted.id}`,browserId);
    const response=execFileSync(process.execPath,
      ['--import','tsx','src/cli.ts','browser-watch','--clear'],{
        cwd:process.cwd(),env:{...process.env,MISSION_RELAY_HOME:f.dir},encoding:'utf8',
      });
    assert.equal(JSON.parse(response).enabled,false);
    assert.equal(JSON.parse(response).paused,1);
    assert.equal(watchedBrowser(f.store),null);
    assert.equal(f.store.get(adopted.id).stopRequested,true);
    assert.equal(f.store.events(adopted.id).filter(x=>x.type==='mission.pause_requested').length,1);
  }finally{f.close();}
});
