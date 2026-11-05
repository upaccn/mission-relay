import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Page} from 'playwriter';
import {Store} from '../src/core/store.js';
import {drivePiAutopilot} from '../src/core/pi-autopilot.js';
import {adoptConnectedConversation} from '../src/core/chat-adoption.js';
import type {PiPlanner} from '../src/core/pi-planner.js';

const URL='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174020';
const HUMAN='Owner started a real research conversation';
const ANSWER='Initial human ChatGPT research answer, without a Relay final marker';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');

function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'relay-adoption-'));
  const store=new Store(join(dir,'db.sqlite'));
  const m=store.create({goal:'Continue the human task',acceptance:['Evidence-based result'],
    workspace:'',sandbox:'read-only',mode:'supervised',maxTurns:3,
    requestKey:'adoption-test',checks:[]});
  const linked=store.linkChat(m.id,URL,m.version).mission;
  const bound=store.bindChatBrowser(m.id,'install:Chrome:test',linked.version).mission;
  let sent=0,prompt=HUMAN;
  const page={
    url:()=>URL,context:()=>({newPage:async()=>{throw new Error('An adopted chat must not open a new tab');}}),
    getByRole:()=>({count:async()=>0,first:()=>({isVisible:async()=>false})}),
    locator:(selector:string)=>{
      const role=selector.includes('data-message-author-role="assistant"')?'assistant':
        selector.includes('data-message-author-role="user"')?'user':
        selector.includes('prompt-textarea')?'composer':
        selector.includes('send-button')?'send':'other';
      const item:any={
        count:async()=>role==='other'?0:1,first:()=>item,last:()=>item,
        isVisible:async()=>role!=='other',isEnabled:async()=>Boolean(prompt),
        innerText:async()=>role==='user'?prompt:
          sent?'Managed follow-up with evidence\n[MISSION_RELAY:DONE]':ANSWER,
        fill:async(value:string)=>{prompt=value;},click:async()=>{sent++;},
      };
      return item;
    },
  } as unknown as Page;
  const adopted=store.recordChatAdoption(m.id,bound.version,{
    userSha256:hash(HUMAN),assistantSha256:hash(ANSWER),summary:ANSWER});
  return {dir,store,page,adopted,sends:()=>sent,
    cleanup:()=>{store.close();rmSync(dir,{recursive:true,force:true});}};
}

test('Human conversation adoption records no send and PI may decide DONE without any browser interaction',async()=>{
  const f=fixture();try{
    assert.equal(f.adopted.turnCount,0);
    assert.equal(f.store.events(f.adopted.id).filter(e=>e.type==='chatgpt.browser_reserved').length,0);
    assert.equal(f.store.chatBrowserTurn(f.adopted.id)?.requestKey,'initial-human-snapshot');
    const planner:PiPlanner={decide:async ctx=>{
      assert.equal(ctx.turnCount,0);assert.equal(ctx.lastAssistant,ANSWER);
      return {action:'DONE',summary:'The original human chat already answered this task',nextPrompt:''};
    }};
    await drivePiAutopilot({store:f.store,planner,missionId:f.adopted.id,
      revision:f.adopted.version,requestPrefix:'adopt-test',page:f.page,url:URL});
    assert.equal(f.store.get(f.adopted.id).turnCount,0);
    assert.equal(f.sends(),0);
    assert.equal(f.store.piPlan(f.adopted.id)?.action,'DONE');
  }finally{f.cleanup();}
});

test('PI NEXT continues in the exact adopted conversation and only credits its new send',async()=>{
  const f=fixture();try{
    let round=0;
    const planner:PiPlanner={decide:async ctx=>++round===1
      ?{action:'NEXT',summary:'One evidence gap remains',nextPrompt:'Verify the remaining gap'}
      :{action:'DONE',summary:'Evidence gap resolved',nextPrompt:''}};
    await drivePiAutopilot({store:f.store,planner,missionId:f.adopted.id,
      revision:f.adopted.version,requestPrefix:'adopt-next',page:f.page,url:URL});
    assert.equal(f.sends(),1);
    assert.equal(f.store.get(f.adopted.id).turnCount,1);
    assert.equal(f.store.chatLink(f.adopted.id),URL);
    const e=f.store.events(f.adopted.id);
    assert.equal(e.filter(x=>x.type==='chatgpt.browser_adopted').length,1);
    assert.equal(e.filter(x=>x.type==='chatgpt.browser_reserved').length,1);
    assert.equal(e.filter(x=>x.type==='chatgpt.browser_observed').length,1);
    assert.equal(f.store.piPlan(f.adopted.id)?.action,'DONE');
  }finally{f.cleanup();}
});

test('Adoption is restricted to READY unstarted missions and one active link per URL',()=>{
  const f=fixture();try{
    assert.throws(()=>f.store.recordChatAdoption(f.adopted.id,f.adopted.version,{
      userSha256:hash(HUMAN),assistantSha256:hash(ANSWER),summary:ANSWER}),/READY/);
    const other=f.store.create({goal:'Duplicate',acceptance:['Evidence'],workspace:'',
      sandbox:'read-only',mode:'supervised',maxTurns:2,requestKey:'duplicate',checks:[]});
    const linked=f.store.linkChat(other.id,URL,other.version).mission;
    const bound=f.store.bindChatBrowser(linked.id,'install:Chrome:test',linked.version).mission;
    assert.throws(()=>f.store.recordChatAdoption(bound.id,bound.version,{
      userSha256:hash(HUMAN),assistantSha256:hash(ANSWER),summary:ANSWER}),/already linked/);
  }finally{f.cleanup();}
});

test('Composed adoption rolls back Mission creation, URL bind and events after a conflict',()=>{
  const f=fixture();try{
    const previousCount=f.store.list().length;
    assert.throws(()=>f.store.adoptHumanChat({goal:'Conflicting new adoption',
      acceptance:['Evidence'],workspace:'',sandbox:'read-only',
      mode:'supervised',maxTurns:2,requestKey:'atomic-duplicate',checks:[]},
      URL,'install:Chrome:test',{userSha256:hash(HUMAN),
        assistantSha256:hash(ANSWER),summary:ANSWER}),/already linked/);
    assert.equal(f.store.list().length,previousCount);
    assert.equal(f.store.getMeta('chatgpt.browser.url_lock.'+hash(URL)),null);
    assert.equal(f.store.get(f.adopted.id).turnCount,0);
    assert.equal(f.store.chatBrowserTurn(f.adopted.id)?.requestKey,'initial-human-snapshot');
    // A failed compound action must not consume the key.
    const next=f.store.create({goal:'Safe later task',acceptance:['Evidence'],
      workspace:'',sandbox:'read-only',mode:'supervised',maxTurns:2,
      requestKey:'atomic-duplicate',checks:[]});
    assert.equal(next.state,'READY');
  }finally{f.cleanup();}
});

test('Watcher attribution failure rolls back human adoption and PI enablement atomically',async()=>{
  const f=fixture();
  try{
    const nextUrl='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174033';
    const prior=f.store.list().length;
    const page={
      ...f.page,url:()=>nextUrl,
    } as Page;
    await assert.rejects(adoptConnectedConversation(
      f.store,page,nextUrl,'install:Chrome:test',{
        piEnabled:true,onAdopted:()=>{throw new Error('Synthetic watcher checkpoint failure');},
      }),/Synthetic watcher checkpoint failure/);
    assert.equal(f.store.list().length,prior);
    assert.equal(f.store.getMeta('browser.watch.profile'),null);
    assert.equal(f.store.getMeta('chatgpt.browser.url_lock.'+hash(nextUrl)),null);
  }finally{f.cleanup();}
});
