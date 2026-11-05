import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import type {Page} from 'playwriter';
import {Store} from '../src/core/store.js';
import {Engine} from '../src/core/engine.js';
import {TelegramBridge,type TelegramUpdate,type TelegramTransport} from '../src/plugins/telegram.js';
import {pauseFailedPiPlanning} from '../src/core/pi-autopilot.js';
import type {PiPlanner,PiTurnContext} from '../src/core/pi-planner.js';
import type {AgentAdapter} from '../src/core/types.js';

const SRC='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174000';
const DEST='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174001';
const never:AgentAdapter={
  async execute(){throw new Error('Native agent must not execute PI ChatGPT Missions');},
  async verify(){throw new Error('Native verifier must not execute PI ChatGPT Missions');},
};
function rig(planner:PiPlanner){
  const dir=mkdtempSync(join(tmpdir(),'relay-telegram-pi-'));
  const store=new Store(join(dir,'missions.sqlite'));
  const engine=new Engine(store,never);
  const m=store.create({goal:'Approved original ChatGPT anchor',acceptance:['Anchor is available'],
    workspace:'',sandbox:'read-only',mode:'supervised',maxTurns:1,
    requestKey:'approved-anchor',checks:[]});
  const linked=store.linkChat(m.id,SRC,m.version).mission;
  store.bindChatBrowser(m.id,'install:Chrome:synthetic',linked.version);
  store.setMeta('telegram.chatgpt.anchorMissionId',m.id);
  let sends=0,newTabs=0,closed=false,entered='',location='about:blank';
  const roleLocator=(fresh:boolean)=>(selector:string)=>{
    const role=selector.includes('data-message-author-role="assistant"')?'assistant':
      selector.includes('data-message-author-role="user"')?'user':
      selector.includes('prompt-textarea')?'composer':
      selector.includes('send-button')?'send':'other';
    const obj:any={
      count:async()=>role==='other'?0:['composer','send'].includes(role)?1:
        fresh?(sends?1:0):1,
      first:()=>obj,last:()=>obj,isVisible:async()=>role!=='other',
      isEnabled:async()=>Boolean(entered),
      innerText:async()=>role==='user'?fresh?entered:'Anchor user message':
        fresh?(sends>=2?'Second synthetic complete answer\n[MISSION_RELAY:DONE]'
          :'Synthetic complete answer\n[MISSION_RELAY:DONE]'):'Anchor assistant message',
      fill:async(s:string)=>{entered=s;},
      click:async()=>{sends++;location=DEST;},
    };
    return obj;
  };
  const newPage={
    url:()=>location,isClosed:()=>false,
    goto:async(url:string)=>{location=url;},waitForLoadState:async()=>{},
    getByRole:()=>({count:async()=>0,first:()=>({isVisible:async()=>false})}),
    locator:roleLocator(true),
  } as unknown as Page;
  const anchor={
    url:()=>SRC,isClosed:()=>false,
    context:()=>({newPage:async()=>{newTabs++;return newPage;}}),
    getByRole:()=>({count:async()=>0,first:()=>({isVisible:async()=>false})}),
    locator:roleLocator(false),
  } as unknown as Page;
  const sent:string[]=[];
  let updates:TelegramUpdate[]=[];
  const transport:TelegramTransport={
    getUpdates:async offset=>updates.filter(u=>u.update_id>=offset),
    sendMessage:async(_chat,text)=>{sent.push(text);},
  };
  const bridge=new TelegramBridge(store,engine,transport,1001,2001,
    async()=>{throw new Error('Codex must not execute');},
    async(url,opts)=>{
      assert.ok([SRC,DEST].includes(url));
      assert.equal(opts?.browserId,'install:Chrome:synthetic');
      return {page:url===DEST?newPage:anchor,close:async()=>{closed=true;}};
    },planner);
  const message=(id:number,text:string):TelegramUpdate=>({
    update_id:id,message:{text,from:{id:1001},chat:{id:2001,type:'private'}},
  });
  return {store,engine,bridge,sent,message,
    primeRecovered:(prompt:string)=>{location=DEST;entered=prompt;sends=1;},
    setUpdates:(items:TelegramUpdate[])=>{updates=items;},
    state:()=>({sends,newTabs,closed}),
    cleanup:()=>{store.close();rmSync(dir,{recursive:true,force:true});}};
}

test('An unsubmitted PI-ready task prevents an idle Telegram maintenance drain',()=>{
  const f=rig({decide:async()=>({action:'BLOCKED',summary:'No Send',nextPrompt:''})});
  try{
    const m=f.engine.create({goal:'PI accepted but the first Send is not reserved',
      acceptance:['No lost command'],workspace:'',sandbox:'read-only',
      mode:'supervised',maxTurns:8,requestKey:'pi-ready-fence',checks:[]});
    f.store.setMeta(`pi.autopilot.enabled.${m.id}`,'1');
    assert.throws(()=>f.store.requestChannelDrain('telegram'),/Maintenance deferred/);
    assert.equal(f.store.channelDrainRequested('telegram'),false);
    f.store.setMeta(`pi.autopilot.enabled.${m.id}`,'');
    const drain=f.store.requestChannelDrain('telegram');
    assert.equal(f.store.releaseChannelDrain('telegram',drain),undefined);
  }finally{f.cleanup();}
});

test('Telegram PI task creation rolls back its Mission when Chrome binding fails',async()=>{
  const f=rig({decide:async()=>({action:'BLOCKED',summary:'No Send',nextPrompt:''})});
  try{
    const original=f.store.bindChatBrowser.bind(f.store);
    f.store.bindChatBrowser=(()=>{throw new Error('synthetic Chrome binding failure');}) as typeof original;
    f.setUpdates([f.message(968,'Read-only PI create must be atomic')]);
    await f.bridge.pollOnce(0);
    assert.equal(f.engine.list().length,1,'No orphan PI READY Mission may survive');
    assert.equal(f.state().sends,0);
    assert.ok(f.sent.some(x=>/synthetic Chrome binding failure/.test(x)));
  }finally{f.cleanup();}
});

test('Telegram default text starts PI autopilot and later owner text is queued until PI reviews the round',async()=>{
  let seen:PiTurnContext|null=null;
  const planner:PiPlanner={decide:async context=>{
    seen=context;
    return {action:'BLOCKED',summary:'Owner requested a manual test; stopped here',nextPrompt:''};
  }};
  const f=rig(planner);try{
    f.setUpdates([f.message(970,'Read-only NetBox field operations research')]);
    await f.bridge.pollOnce(0);
    assert.ok(f.sent.some(x=>/PI-coordinated ChatGPT Mission/.test(x)));
    const mission=f.engine.list().find(m=>m.goal==='Read-only NetBox field operations research');
    assert.ok(mission);
    assert.equal(mission.maxTurns,32);
    f.setUpdates([f.message(971,'后续我要手动测试 Android，请在当前轮结束后停下来')]);
    await f.bridge.pollOnce(0);
    assert.ok(f.sent.some(x=>/Owner instruction queued/.test(x)));
    assert.equal(f.store.pendingPiOwnerDirectives(mission.id).length,1);
    for(let i=0;i<100&&!f.state().closed;i++)await new Promise(r=>setTimeout(r,50));
    assert.equal(f.state().closed,true);
    assert.equal(f.state().sends,1);
    assert.equal(f.state().newTabs,1);
    assert.equal(f.store.pendingPiOwnerDirectives(mission.id).length,0);
    assert.ok(seen && seen.ownerDirectives[0]?.text.includes('手动测试 Android'));
    assert.equal(f.store.piPlan(mission.id)?.action,'BLOCKED');
    await f.bridge.pollOnce(0);
    assert.equal(f.sent.filter(x=>/PI BLOCKED/.test(x)).length,1);
    await f.bridge.pollOnce(0);
    assert.equal(f.sent.filter(x=>/PI BLOCKED/.test(x)).length,1);
    assert.equal(f.store.events(mission.id).filter(e=>e.type==='chatgpt.browser_reserved').length,1);
  }finally{f.cleanup();}
});

test('Telegram receives bounded PI progress after NEXT and only one PI final summary after DONE',async()=>{
  let call=0;
  const planner:PiPlanner={decide:async()=>{
    if(++call===1)return {action:'NEXT',summary:'First gap found; verify VRF behavior',
      nextPrompt:'Check the same IP across two VRFs'};
    return {action:'DONE',summary:'Both VRF scenarios reviewed',nextPrompt:''};
  }};
  const f=rig(planner);try{
    f.setUpdates([f.message(975,'Review one read-only NetBox VRF issue')]);
    await f.bridge.pollOnce(0);
    const mission=f.engine.list().find(m=>m.goal==='Review one read-only NetBox VRF issue');
    assert.ok(mission);
    for(let i=0;i<160&&!f.state().closed;i++)await new Promise(r=>setTimeout(r,50));
    assert.equal(f.state().closed,true);
    assert.equal(f.state().sends,2);
    await f.bridge.pollOnce(0);
    assert.equal(f.sent.filter(x=>/PI decision: NEXT/.test(x)).length,1);
    assert.equal(f.sent.filter(x=>/PI DONE/.test(x)).length,1);
    assert.equal(f.sent.filter(x=>/ChatGPT result \(model-provided/.test(x)).length,0);
    await f.bridge.pollOnce(0);
    assert.equal(f.sent.filter(x=>/PI decision: NEXT/.test(x)).length,1);
    assert.equal(f.sent.filter(x=>/PI DONE/.test(x)).length,1);
  }finally{f.cleanup();}
});

test('PI startup only resumes an exact observed NEXT checkpoint, with no replay of the first browser Send',async()=>{
  const planner:PiPlanner={decide:async()=>({
    action:'DONE',summary:'PI reviewed the second round after recovery',nextPrompt:'',
  })};
  const f=rig(planner);try{
    const prompt='Previous authorized browser prompt';
    const answer='Synthetic complete answer\n[MISSION_RELAY:DONE]';
    const m=f.store.create({goal:'Review NetBox with PI after a restart',
      acceptance:['Checked evidence'],workspace:'',sandbox:'read-only',
      mode:'supervised',maxTurns:3,requestKey:'pi-recovery-test',checks:[]});
    const linked=f.store.linkChat(m.id,SRC,m.version).mission;
    const bound=f.store.bindChatBrowser(m.id,'install:Chrome:synthetic',linked.version).mission;
    f.store.setMeta(`pi.autopilot.enabled.${m.id}`,'1');
    const claimed=f.store.reserveChatBrowserTurn(m.id,bound.version,
      'pi-recovery-test-1',createHash('sha256').update(prompt).digest('hex'));
    f.store.finishChatBrowserTurn(m.id,'pi-recovery-test-1',{
      kind:'observed',assistantSha256:createHash('sha256').update(answer).digest('hex'),
      summary:answer,newChatUrl:DEST,
      telegramBatch:{terminal:false,flowSignal:'DONE',piManaged:true},
    });
    f.store.commitPiPlan(m.id,createHash('sha256').update(answer).digest('hex'),[],{
      action:'NEXT',summary:'Still need a follow-up check',nextPrompt:'Check the remaining VRF question',
    });
    f.primeRecovered(prompt);
    await (f.bridge as unknown as {recoverObservedPiCheckpoint:()=>Promise<void>}).recoverObservedPiCheckpoint();
    for(let i=0;i<100&&!f.state().closed;i++)await new Promise(r=>setTimeout(r,50));
    assert.equal(f.state().closed,true);
    assert.equal(f.state().sends,2); // One original, one safe NEXT.
    assert.equal(f.store.get(m.id).turnCount,2);
    assert.equal(f.store.events(m.id).filter(x=>x.type==='chatgpt.browser_reserved').length,2);
    assert.equal(f.store.events(m.id).filter(x=>x.type==='pi.autopilot_finished').length,1);
  }finally{f.cleanup();}
});

test('Telegram PI startup reviews an independently recovered rollover with exact hashes and no duplicate Send',async()=>{
  const f=rig({decide:async()=>({action:'DONE',summary:'Recovered final answer reviewed',nextPrompt:''})});
  try{
    const prompt='Original PI-authored prompt';
    const answer='Synthetic complete answer\n[MISSION_RELAY:DONE]';
    const sha=createHash('sha256').update(answer).digest('hex');
    const promptSha=createHash('sha256').update(prompt).digest('hex');
    const m=f.store.create({goal:'Review an already recovered PI task',
      acceptance:['One verified answer'],workspace:'',sandbox:'read-only',
      mode:'supervised',maxTurns:3,requestKey:'pi-telegram-recovered',checks:[]});
    const linked=f.store.linkChat(m.id,SRC,m.version).mission;
    const bound=f.store.bindChatBrowser(m.id,'install:Chrome:synthetic',linked.version).mission;
    f.store.setMeta(`pi.autopilot.enabled.${m.id}`,'1');
    f.store.reserveChatBrowserTurn(m.id,bound.version,'pi-telegram-recovered-1',promptSha);
    f.store.finishChatBrowserTurn(m.id,'pi-telegram-recovered-1',{
      kind:'uncertain',error:'Browser observer interrupted after Send',
    });
    f.store.recoverObservedBrowserRollover(m.id,f.store.get(m.id).version,{
      requestPromptSha256:promptSha,newChatUrl:DEST,
      assistantSha256:sha,summary:answer,
    });
    f.primeRecovered(prompt);
    await (f.bridge as unknown as {recoverObservedPiCheckpoint:()=>Promise<void>}).recoverObservedPiCheckpoint();
    for(let i=0;i<100&&!f.state().closed;i++)await new Promise(r=>setTimeout(r,50));
    assert.equal(f.state().closed,true);
    assert.equal(f.state().sends,1); // Historical Send only; never replay it.
    assert.equal(f.store.piPlan(m.id)?.action,'DONE');
    assert.equal(f.store.get(m.id).lastError,null);
    assert.equal(f.store.events(m.id).filter(e=>e.type==='pi.autopilot_finished').length,1);
    assert.equal(f.store.events(m.id).filter(e=>e.type==='chatgpt.browser_reserved').length,1);
  }finally{f.cleanup();}
});

test('PI startup refuses a changed last visible user prompt and never submits another browser turn',async()=>{
  const planner:PiPlanner={decide:async()=>{throw new Error('PI must not be called');}};
  const f=rig(planner);try{
    const answer='Synthetic complete answer\n[MISSION_RELAY:DONE]';
    const m=f.store.create({goal:'Do not replay if a human changed the chat',
      acceptance:['No duplicate'],workspace:'',sandbox:'read-only',
      mode:'supervised',maxTurns:3,requestKey:'pi-no-replay-test',checks:[]});
    const linked=f.store.linkChat(m.id,SRC,m.version).mission;
    const bound=f.store.bindChatBrowser(m.id,'install:Chrome:synthetic',linked.version).mission;
    f.store.setMeta(`pi.autopilot.enabled.${m.id}`,'1');
    f.store.reserveChatBrowserTurn(m.id,bound.version,'pi-no-replay-test-1',
      createHash('sha256').update('Original user prompt').digest('hex'));
    f.store.finishChatBrowserTurn(m.id,'pi-no-replay-test-1',{
      kind:'observed',assistantSha256:createHash('sha256').update(answer).digest('hex'),
      summary:answer,newChatUrl:DEST,
      telegramBatch:{terminal:false,flowSignal:'DONE',piManaged:true},
    });
    f.store.commitPiPlan(m.id,createHash('sha256').update(answer).digest('hex'),[],{
      action:'NEXT',summary:'More work',nextPrompt:'Continue',
    });
    f.primeRecovered('Unexpected manual user prompt');
    await (f.bridge as unknown as {recoverObservedPiCheckpoint:()=>Promise<void>}).recoverObservedPiCheckpoint();
    assert.equal(f.state().sends,1);
    assert.equal(f.store.get(m.id).state,'PAUSED');
    assert.match(f.store.get(m.id).lastError??'',/differ from the last durable receipt/);
    assert.equal(f.store.events(m.id).filter(x=>x.type==='pi.autopilot_interrupted').length,1);
  }finally{f.cleanup();}
});

test('PI-owned missions fail closed rather than falling back to legacy /continue',async()=>{
  const planner:PiPlanner={decide:async()=>({action:'DONE',summary:'done',nextPrompt:''})};
  const f=rig(planner);try{
    f.setUpdates([f.message(981,'/auto Review the NetBox app')]);
    await f.bridge.pollOnce(0);
    const mission=f.engine.list().find(m=>m.goal==='Review the NetBox app');
    assert.ok(mission);
    f.setUpdates([f.message(982,`/continue ${mission.id} v${f.engine.get(mission.id).version}`)]);
    await f.bridge.pollOnce(0);
    assert.ok(f.sent.some(x=>/PI-owned Mission cannot be continued/.test(x)));
    assert.equal(f.store.events(mission.id).filter(e=>e.type==='chatgpt.browser_reserved').length,1);
    for(let i=0;i<100&&!f.state().closed;i++)await new Promise(r=>setTimeout(r,50));
    assert.equal(f.state().sends,1);
  }finally{f.cleanup();}
});

test('A durably interrupted old PI task does not block unrelated new owner work or replay its Send',async()=>{
  const f=rig({decide:async()=>({action:'DONE',summary:'New independent task reviewed',nextPrompt:''})});
  try{
    const oldUrl='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174008';
    const old=f.store.create({goal:'Old task with a failed PI checkpoint',
      acceptance:['Preserve checkpoint'],workspace:'',sandbox:'read-only',
      mode:'supervised',maxTurns:3,requestKey:'old-stopped-pi',checks:[]});
    const link=f.store.linkChat(old.id,oldUrl,old.version).mission;
    const bound=f.store.bindChatBrowser(old.id,'install:Chrome:synthetic',link.version).mission;
    f.store.setMeta(`pi.autopilot.enabled.${old.id}`,'1');
    f.store.reserveChatBrowserTurn(old.id,bound.version,'old-stopped-pi-1','b'.repeat(64));
    f.store.finishChatBrowserTurn(old.id,'old-stopped-pi-1',{
      kind:'observed',assistantSha256:'a'.repeat(64),summary:'Previous browser reply',
      telegramBatch:{terminal:false,flowSignal:'DONE',piManaged:true},
    });
    pauseFailedPiPlanning(f.store,old.id,'PI inference unavailable');
    const oldVersion=f.store.get(old.id).version;
    assert.equal(f.store.get(old.id).state,'PAUSED');
    f.setUpdates([f.message(991,'A new separate read-only task')]);
    await f.bridge.pollOnce(0);
    assert.ok(f.sent.some(text=>text.includes('PI-coordinated ChatGPT Mission')));
    for(let i=0;i<110&&!f.state().closed;i++)await new Promise(r=>setTimeout(r,50));
    assert.equal(f.state().sends,1); // Only the new task sent a new prompt.
    assert.equal(f.store.get(old.id).version,oldVersion);
    assert.equal(f.store.events(old.id).filter(e=>e.type==='chatgpt.browser_reserved').length,1);
    assert.match(f.store.get(old.id).lastError??'',/PI inference unavailable/);
    f.setUpdates([f.message(992,`/status ${old.id}`)]);
    await f.bridge.pollOnce(0);
    assert.ok(f.sent.some(text=>text.includes('Last controller error: PI inference unavailable')));
  }finally{f.cleanup();}
});

test('An uncertain old PI Send still prevents new work while its side effects are unresolved',async()=>{
  const f=rig({decide:async()=>{throw new Error('PI must not be invoked');}});
  try{
    const old=f.store.create({goal:'Uncertain old owner task',acceptance:['No duplicate'],
      workspace:'',sandbox:'read-only',mode:'supervised',maxTurns:3,
      requestKey:'old-uncertain-pi',checks:[]});
    const linked=f.store.linkChat(old.id,DEST,old.version).mission;
    const bound=f.store.bindChatBrowser(old.id,'install:Chrome:synthetic',linked.version).mission;
    f.store.setMeta(`pi.autopilot.enabled.${old.id}`,'1');
    f.store.reserveChatBrowserTurn(old.id,bound.version,'old-uncertain-pi-1','b'.repeat(64));
    f.store.finishChatBrowserTurn(old.id,'old-uncertain-pi-1',{
      kind:'uncertain',error:'Browser Send may have succeeded',
    });
    f.setUpdates([f.message(993,'New task must not bypass uncertain browser request')]);
    await f.bridge.pollOnce(0);
    assert.equal(f.state().sends,0);
    assert.ok(f.sent.some(text=>/earlier PI Mission.*not terminal/.test(text)));
    assert.equal(f.store.get(old.id).state,'NEEDS_RECONCILIATION');
  }finally{f.cleanup();}
});

test('A paused PI response awaiting its first decision is not mistaken for a terminal interruption',async()=>{
  const f=rig({decide:async()=>{throw new Error('PI must not be invoked');}});
  try{
    const old=f.store.create({goal:'Unreviewed PI checkpoint',acceptance:['Review first'],
      workspace:'',sandbox:'read-only',mode:'supervised',maxTurns:3,
      requestKey:'old-unreviewed-pi',checks:[]});
    const linked=f.store.linkChat(old.id,DEST,old.version).mission;
    const bound=f.store.bindChatBrowser(old.id,'install:Chrome:synthetic',linked.version).mission;
    f.store.setMeta(`pi.autopilot.enabled.${old.id}`,'1');
    f.store.reserveChatBrowserTurn(old.id,bound.version,'old-unreviewed-pi-1','b'.repeat(64));
    f.store.finishChatBrowserTurn(old.id,'old-unreviewed-pi-1',{
      kind:'observed',assistantSha256:'a'.repeat(64),summary:'Awaiting PI review',
      telegramBatch:{terminal:false,flowSignal:'DONE',piManaged:true},
    });
    f.setUpdates([f.message(994,'New task must wait for the unreviewed checkpoint')]);
    await f.bridge.pollOnce(0);
    assert.equal(f.state().sends,0);
    assert.ok(f.sent.some(text=>/earlier PI Mission.*not terminal/.test(text)));
    assert.equal(f.store.get(old.id).lastError,null);
  }finally{f.cleanup();}
});
