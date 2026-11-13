import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir,hostname} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import type {Page} from 'playwriter';
import {Store,PI_SUCCESSOR_CHECKPOINT_MISMATCH} from '../src/core/store.js';
import {armScopedPiConnectionDrill,consumeScopedPiConnectionDrill,
  scopedPiConnectionDrillStatus} from '../src/core/pi-connection-drill.js';
import {GoalLedger} from '../src/core/goal-store.js';
import {Engine} from '../src/core/engine.js';
import {TelegramBridge,type TelegramUpdate,type TelegramTransport} from '../src/plugins/telegram.js';
import {pauseFailedPiPlanning,deferTransientPiBrowserRecovery} from '../src/core/pi-autopilot.js';
import {RetryablePiError,type PiPlanner,type PiTurnContext} from '../src/core/pi-planner.js';
import type {AgentAdapter} from '../src/core/types.js';

const SRC='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174000';
const DEST='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174001';
const never:AgentAdapter={
  async execute(){throw new Error('Native agent must not execute PI ChatGPT Missions');},
  async verify(){throw new Error('Native verifier must not execute PI ChatGPT Missions');},
};
function rig(planner:PiPlanner,options:{failFirstRecoveryConnect?:boolean;
  recoveryConnectError?:string}={}){
  const dir=mkdtempSync(join(tmpdir(),'relay-telegram-pi-'));
  const store=new Store(join(dir,'missions.sqlite'));
  const engine=new Engine(store,never);
  const m=store.create({goal:'Approved original ChatGPT anchor',acceptance:['Anchor is available'],
    workspace:'',sandbox:'read-only',mode:'supervised',maxTurns:1,
    requestKey:'approved-anchor',checks:[]});
  const linked=store.linkChat(m.id,SRC,m.version).mission;
  store.bindChatBrowser(m.id,'install:Chrome:synthetic',linked.version);
  store.setMeta('telegram.chatgpt.anchorUrl',SRC);
  store.setMeta('telegram.chatgpt.browserId','install:Chrome:synthetic');
  let sends=0,newTabs=0,closed=false,entered='',location='about:blank';
  let connectorAttempts=0;
  const connectorOptions:Array<{browserId?:string;bootstrapMissingAnchor?:boolean}|undefined>=[];
  const sentPrompts:string[]=[];
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
        fresh?(sends>=3?'Third synthetic complete answer\n[MISSION_RELAY:DONE]':
          sends>=2?'Second synthetic complete answer\n[MISSION_RELAY:DONE]'
          :'Synthetic complete answer\n[MISSION_RELAY:DONE]'):'Anchor assistant message',
      fill:async(s:string)=>{entered=s;},
      click:async()=>{sentPrompts.push(entered);sends++;location=DEST;},
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
  const browserConnector=async(url:string,opts?:{browserId?:string;bootstrapMissingAnchor?:boolean})=>{
      connectorAttempts++;
      if((options.failFirstRecoveryConnect||options.recoveryConnectError)&&connectorAttempts===1)
        throw new Error(options.recoveryConnectError??'Playwriter relay reconnecting after Chrome restart');
      connectorOptions.push(opts);
      assert.ok([SRC,DEST].includes(url));
      assert.equal(opts?.browserId,'install:Chrome:synthetic');
      return {page:url===DEST?newPage:anchor,close:async()=>{closed=true;}};
    };
  const bridge=new TelegramBridge(store,engine,transport,1001,2001,
    async()=>{throw new Error('Codex must not execute');},
    browserConnector,planner);
  const message=(id:number,text:string):TelegramUpdate=>({
    update_id:id,message:{text,from:{id:1001},chat:{id:2001,type:'private'}},
  });
  return {store,engine,bridge,sent,message,dbFile:join(dir,'missions.sqlite'),
    primeRecovered:(prompt:string)=>{location=DEST;entered=prompt;sends=1;},
    setUpdates:(items:TelegramUpdate[])=>{updates=items;},
    state:()=>({sends,newTabs,closed,sentPrompts,connectorOptions,connectorAttempts}),
    restartedController:(reopened:Store)=>new TelegramBridge(reopened,new Engine(reopened,never),
      transport,1001,2001,async()=>{throw new Error('Codex must not execute');},
      browserConnector,planner),
    cleanup:()=>{store.close();rmSync(dir,{recursive:true,force:true});}};
}

const APPROVED_PROJECT='/srv/projects/mission-relay';

function goalPlanner():PiPlanner{
  return {
    decide:async()=>{throw new Error('Goal-bound PI must not use legacy DONE');},
    proposeGoalPlan:async()=>({
      summary:'Review the current project goal and implement the two scoped packages',
      items:[
        {key:'first',title:'Research the root issue',description:'Verify relevant evidence',
          priority:90,dependsOn:[],acceptance:['Concrete evidence for the root issue']},
        {key:'second',title:'Implement the scoped change',
          description:'Check code and tests',priority:75,dependsOn:['first'],
          acceptance:['Independently inspectable test result']},
      ],
    }),
    reviewGoalWork:async()=>({
      verdict:'BLOCKED',summary:'Owner needs an independent verification receipt',
      nextPrompt:'',handoff:false,evidenceRefs:['test:synthetic-approval-required'],
      blocker:{kind:'external_permission',evidence:'Synthetic test requires a separate owner approval',
        releaseCondition:'Owner grants the test fixture its missing authorization'},
    }),
  };
}

test('WP4 /goal creates durable Goal plus one PI Mission; PI persists a reviewed plan and blocks without Goal DONE',async()=>{
  const f=rig(goalPlanner());
  try{
    const objective='Long-term Goal: improve NetBox device ownership with auditable evidence';
    f.setUpdates([f.message(3101,`/goal ${objective}`)]);
    await f.bridge.pollOnce(0);
    const ledger=new GoalLedger(f.store),goals=ledger.listGoals();
    assert.equal(goals.length,1);
    assert.equal(goals[0]!.objective,objective);
    const task=f.engine.list().find(m=>m.goal===objective)!;
    assert.ok(task);
    assert.equal(task.sandbox,'read-only');
    assert.equal(ledger.missionGoalId(task.id),goals[0]!.id);
    assert.ok(f.sent.some(x=>x.includes('Long-term goal tracking is enabled.')));
    assert.ok(f.sent.every(x=>!x.includes(goals[0]!.id)));
    for(let i=0;i<160&&!f.state().closed;i++)await new Promise(r=>setTimeout(r,50));
    assert.equal(f.state().closed,true);
    const graph=ledger.graph(goals[0]!.id);
    assert.equal(graph.plans.length,1);
    assert.equal(graph.plans[0]?.status,'APPROVED');
    assert.equal(graph.items.find(x=>x.key==='first')?.status,'BLOCKED');
    assert.equal(graph.items.find(x=>x.key==='second')?.status,'PENDING');
    assert.equal(graph.goal.status,'BLOCKED');
    assert.equal(f.store.piPlan(task.id)?.action,'BLOCKED');
    assert.equal(f.state().sends,2);
    assert.ok(graph.events.some(e=>e.type==='goal.pi_plan_reviewed'));
    assert.ok(graph.events.some(e=>e.type==='goal.pi_review'));
    assert.equal(graph.events.filter(e=>e.type==='goal.pi_mission_bound').length,1);
    assert.equal(f.store.events(task.id).filter(e=>e.type==='chatgpt.browser_reserved').length,2);
    f.setUpdates([f.message(3101,`/goal ${objective}`),
      f.message(3102,`/goal-status ${graph.goal.id}`),
      f.message(3103,'/goals'),f.message(3104,`/status ${task.id}`)]);
    await f.bridge.pollOnce(0);
    assert.equal(ledger.listGoals().length,1);
    assert.ok(f.sent.some(x=>x.includes('Independent release checks: pending')));
    assert.ok(f.sent.some(x=>x.includes('Goals: Page 1/1')));
    assert.ok(f.sent.some(x=>x.includes('Work packages reviewed as passed')));
    assert.equal(f.store.events(task.id).filter(e=>e.type==='chatgpt.browser_reserved').length,2);
  }finally{f.cleanup();}
});

test('WP4 owner Goal drives PI PASS into its dependent next package, then BLOCKED without Goal DONE',async()=>{
  let reviews=0;
  const planner:PiPlanner={
    ...goalPlanner(),
    reviewGoalWork:async context=>{
      reviews++;
      if(reviews===1){
        assert.equal(context.workItem.key,'first');
        return {verdict:'PASS',summary:'First task evidence is recorded',
          nextPrompt:'',handoff:false,evidenceRefs:['git:synthetic-first']};
      }
      assert.equal(context.workItem.key,'second');
      return {verdict:'BLOCKED',summary:'Independent final verification is still pending',
        nextPrompt:'',handoff:false,evidenceRefs:['test:synthetic-independent-verification'],
        blocker:{kind:'external_dependency',evidence:'Independent verifier is not connected in the fixture',
          releaseCondition:'Attach an independently authorized verifier to the release gate'}};
    },
  };
  const f=rig(planner);
  try{
    const objective='Owner Goal: build tested device ownership with correct cross-VRF isolation';
    f.setUpdates([f.message(3151,`/goal ${objective}`)]);
    await f.bridge.pollOnce(0);
    for(let i=0;i<220&&!f.state().closed;i++)await new Promise(r=>setTimeout(r,50));
    assert.equal(f.state().closed,true);
    assert.equal(reviews,2);
    assert.equal(f.state().sends,3);
    const prompts=f.state().sentPrompts;
    assert.ok(prompts[0]?.includes(objective),
      'Only the initial owner planning turn retains full Goal context');
    assert.match(prompts[1]!,/Work package: first — Research the root issue/);
    assert.match(prompts[2]!,/Work package: second — Implement the scoped change/);
    assert.ok(!prompts[1]!.includes(objective));
    assert.ok(!prompts[2]!.includes(objective));
    const ledger=new GoalLedger(f.store),graph=ledger.graph(ledger.listGoals()[0]!.id);
    assert.equal(graph.items.find(x=>x.key==='first')?.status,'PASSED');
    assert.equal(graph.items.find(x=>x.key==='second')?.status,'BLOCKED');
    assert.deepEqual(graph.events.filter(e=>e.type==='goal.pi_review')
      .map(e=>e.payload.verdict),['PASS','BLOCKED']);
    assert.equal(graph.goal.status,'BLOCKED');
    const mission=f.engine.list().find(x=>x.goal===objective)!;
    assert.equal(f.store.piPlan(mission.id)?.action,'BLOCKED');
    assert.equal(f.store.events(mission.id).filter(e=>e.type==='chatgpt.browser_reserved').length,3);
  }finally{f.cleanup();}
});

test('WP4 /goal-build requires existing explicit local repository approval; failure leaves no Goal or Mission',async()=>{
  const f=rig(goalPlanner());
  try{
    const objective='Build the validated private product from a long-term owner goal';
    f.setUpdates([f.message(3201,`/goal-build ${objective}`)]);
    await f.bridge.pollOnce(0);
    assert.ok(f.sent.some(x=>/locally approved project/.test(x)));
    assert.equal(new GoalLedger(f.store).listGoals().length,0);
    assert.equal(f.engine.list().length,1,'The original ChatGPT anchor must be preserved');
    assert.equal(f.state().sends,0);
    f.store.setMeta('telegram.pi.project',APPROVED_PROJECT);
    f.store.setMeta('telegram.build.project',APPROVED_PROJECT);
    f.setUpdates([f.message(3202,`/goal-build ${objective}`)]);
    await f.bridge.pollOnce(0);
    const goal=new GoalLedger(f.store).listGoals()[0]!;
    assert.equal(goal.objective,objective);
    const mission=f.engine.list().find(x=>x.goal===objective)!;
    assert.equal(mission.sandbox,'workspace-write');
    assert.equal(mission.workspace,APPROVED_PROJECT);
    assert.ok(f.sent.some(x=>x.includes('Long-term goal tracking is enabled.')));
    for(let i=0;i<150&&!f.state().closed;i++)await new Promise(r=>setTimeout(r,50));
    assert.equal(f.state().closed,true);
    assert.ok(f.state().sentPrompts[0]?.includes(APPROVED_PROJECT));
    assert.equal(new GoalLedger(f.store).getGoal(goal.id).status,'BLOCKED');
  }finally{f.cleanup();}
});

test('WP4 Goal and PI Mission creation are one transaction: injected binding failure rolls back both',async()=>{
  const f=rig(goalPlanner());
  try{
    f.store.db.exec(`CREATE TRIGGER injected_goal_binding_failure
      BEFORE INSERT ON goal_events WHEN NEW.type='goal.pi_mission_bound'
      BEGIN SELECT RAISE(ABORT,'synthetic Goal binding failure'); END;`);
    f.setUpdates([f.message(3301,'/goal Do not create an orphan state')]);
    await f.bridge.pollOnce(0);
    assert.ok(f.sent.some(x=>x.includes('synthetic Goal binding failure')));
    assert.equal(new GoalLedger(f.store).listGoals().length,0);
    assert.equal(f.engine.list().length,1);
    assert.equal(f.state().sends,0);
    assert.equal(f.store.db.prepare(
      "SELECT COUNT(*) AS n FROM meta WHERE key LIKE 'goal.pi.binding.%'"
    ).get().n,0);
    f.store.db.exec('DROP TRIGGER injected_goal_binding_failure');
    f.setUpdates([f.message(3302,'/goal Do not create an orphan state')]);
    await f.bridge.pollOnce(0);
    assert.equal(new GoalLedger(f.store).listGoals().length,1);
    for(let i=0;i<180&&(f.bridge as unknown as {activeTask:Promise<void>|null}).activeTask;i++)
      await new Promise(r=>setTimeout(r,50));
    assert.equal((f.bridge as unknown as {activeTask:Promise<void>|null}).activeTask,null,
      'The second accepted PI run must settle before closing the test SQLite');
  }finally{f.cleanup();}
});

test('WP4 restart recovers an accepted READY Goal before its first Send, and never duplicates the event',async()=>{
  const f=rig(goalPlanner());
  try{
    const objective='Owner Goal: resume exactly one browser request after controller restart';
    const m=f.store.create({goal:objective,acceptance:['Check exact original browser reservation'],
      workspace:'',sandbox:'read-only',mode:'supervised',maxTurns:32,
      requestKey:'root-recovery',checks:[]});
    const linked=f.store.linkChat(m.id,SRC,m.version).mission;
    const bound=f.store.bindChatBrowser(m.id,'install:Chrome:synthetic',linked.version).mission;
    f.store.setMeta(`pi.autopilot.enabled.${m.id}`,'1');
    const ledger=new GoalLedger(f.store);
    const goal=ledger.createGoal({requestKey:'recover-owner-goal',objective,priority:50});
    ledger.bindPiMission(goal.id,m.id,bound.version,'bind-for-recovery');
    assert.equal(f.store.chatBrowserTurn(m.id),null);
    await (f.bridge as unknown as {recoverObservedPiCheckpoint:()=>Promise<void>})
      .recoverObservedPiCheckpoint();
    for(let i=0;i<150&&!f.state().closed;i++)await new Promise(r=>setTimeout(r,50));
    assert.equal(f.state().closed,true);
    assert.equal(f.state().sends,2);
    assert.equal(f.store.events(m.id).filter(e=>e.type==='chatgpt.browser_reserved').length,2);
    assert.equal(ledger.graph(goal.id).plans.length,1);
    const events=ledger.graph(goal.id).events.length;
    await (f.bridge as unknown as {recoverObservedPiCheckpoint:()=>Promise<void>})
      .recoverObservedPiCheckpoint();
    assert.equal(f.state().sends,2);
    assert.equal(ledger.graph(goal.id).events.length,events);
    const reopened=new Store(f.dbFile,{readOnly:true});
    try{
      assert.deepEqual(new GoalLedger(reopened).graph(goal.id),ledger.graph(goal.id));
      assert.equal(reopened.chatBrowserTurn(m.id)?.status,'observed');
      assert.equal(reopened.piPlan(m.id)?.action,'BLOCKED');
    }finally{reopened.close();}
  }finally{f.cleanup();}
});

test('WP4 READY Goal is NOT replayed when an original browser Send is already reserved',async()=>{
  const f=rig(goalPlanner());
  try{
    const objective='Owner Goal: never duplicate in-flight Chrome Send';
    const base=f.store.create({goal:objective,acceptance:['Preserve original reservation'],
      workspace:'',sandbox:'read-only',mode:'supervised',maxTurns:32,
      requestKey:'existing-reservation',checks:[]});
    const linked=f.store.linkChat(base.id,SRC,base.version).mission;
    const bound=f.store.bindChatBrowser(base.id,'install:Chrome:synthetic',linked.version).mission;
    f.store.setMeta(`pi.autopilot.enabled.${base.id}`,'1');
    const ledger=new GoalLedger(f.store);
    const goal=ledger.createGoal({requestKey:'goal-with-reservation',objective,priority:50});
    ledger.bindPiMission(goal.id,base.id,bound.version,'bind-reservation-test');
    const before=f.store.get(base.id);
    const originalSha=createHash('sha256').update('Original browser task').digest('hex');
    f.store.reserveChatBrowserTurn(base.id,before.version,'already-submitted',originalSha,
      {newConversation:true});
    await (f.bridge as unknown as {recoverObservedPiCheckpoint:()=>Promise<void>})
      .recoverObservedPiCheckpoint();
    assert.equal(f.state().sends,0);
    assert.equal(f.store.chatBrowserTurn(base.id)?.status,'reserved');
    assert.equal(f.store.chatBrowserTurn(base.id)?.promptSha256,originalSha);
    assert.equal(ledger.graph(goal.id).plans.length,0);
    assert.equal(f.store.events(base.id).filter(e=>e.type==='chatgpt.browser_reserved').length,1);
  }finally{f.cleanup();}
});

test('WP4 legacy plain-text and /auto PI Missions remain unbound to Goals',async()=>{
  const f=rig({decide:async()=>({action:'BLOCKED',summary:'Legacy behavior retained',nextPrompt:''})});
  try{
    f.setUpdates([f.message(3501,'/auto Preserve existing PI semantics')]);
    await f.bridge.pollOnce(0);
    const mission=f.engine.list().find(x=>x.goal==='Preserve existing PI semantics')!;
    assert.ok(mission);
    assert.equal(new GoalLedger(f.store).missionGoalId(mission.id),null);
    assert.equal(new GoalLedger(f.store).listGoals().length,0);
    for(let i=0;i<100&&!f.state().closed;i++)await new Promise(r=>setTimeout(r,50));
    assert.equal(f.store.piPlan(mission.id)?.action,'BLOCKED');
  }finally{f.cleanup();}
});

test('owner can amend an unsent READY PI successor after restart without starting another mission',async()=>{
  const f=rig({decide:async()=>({action:'DONE',summary:'Not invoked',nextPrompt:''})});
  try{
    const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
    const m=f.store.create({goal:'Finish pending code checks',
      acceptance:['Verify last release gate'],workspace:'',sandbox:'read-only',
      mode:'supervised',maxTurns:32,checks:[],requestKey:'owner-successor-root'});
    const linked=f.store.linkChat(m.id,SRC,m.version).mission;
    const bound=f.store.bindChatBrowser(m.id,'install:Chrome:synthetic',linked.version).mission;
    f.store.setMeta(`pi.autopilot.enabled.${m.id}`,'1');
    const near=f.store.update(m.id,bound.version,{state:'PAUSED',turnCount:31},'test.prior_rounds');
    f.store.reserveChatBrowserTurn(m.id,near.version,'owner-successor-last',sha('Anchor user message'));
    f.store.finishChatBrowserTurn(m.id,'owner-successor-last',{kind:'observed',
      assistantSha256:sha('Anchor assistant message'),summary:'Anchor assistant message',
      telegramBatch:{terminal:true,flowSignal:'NEXT',piManaged:true}});
    f.store.commitPiPlan(m.id,sha('Anchor assistant message'),[],{
      action:'NEXT',summary:'Continue after owner notes',nextPrompt:'Check remaining tests'});
    const child=f.store.createPiSuccessor(m.id);
    assert.ok(child);
    f.setUpdates([f.message(981,'Add a Windows deployment gate to the next step')]);
    await f.bridge.pollOnce(0);
    assert.equal(f.store.pendingPiOwnerDirectives(child.id).length,1);
    assert.match(f.sent.join('\n'),/Instruction saved/);
    f.setUpdates([f.message(982,`/instruct ${child.id} v${child.version} Verify failed CI recovery`)]);
    await f.bridge.pollOnce(0);
    assert.equal(f.store.pendingPiOwnerDirectives(child.id).length,2);
    f.setUpdates([f.message(983,'/build Should not upgrade this read-only child')]);
    await f.bridge.pollOnce(0);
    assert.match(f.sent.at(-1)??'',/cannot be upgraded/);
    assert.equal(f.store.pendingPiOwnerDirectives(child.id).length,2);
    assert.equal(f.store.get(child.id).state,'READY');
    assert.equal(f.state().sends,0);
    assert.equal(f.store.events(m.id).filter(e=>e.type==='pi.chain_successor').length,1);
  }finally{f.cleanup();}
});

test('revoking the exact approved PI build workspace rejects a raced browser reservation',()=>{
  const f=rig({decide:async()=>({action:'DONE',summary:'Not invoked',nextPrompt:''})});
  try{
    f.store.setMeta('telegram.build.project',APPROVED_PROJECT);
    f.store.setMeta('telegram.pi.project',APPROVED_PROJECT);
    const m=f.store.create({goal:'Owner-authorized code change',
      acceptance:['Verify source and CI'],workspace:APPROVED_PROJECT,
      sandbox:'workspace-write',mode:'supervised',maxTurns:32,
      checks:[],requestKey:'revoked-build-pre-send'});
    const linked=f.store.linkChat(m.id,SRC,m.version).mission;
    const bound=f.store.bindChatBrowser(m.id,'install:Chrome:synthetic',linked.version).mission;
    f.store.setMeta(`pi.autopilot.enabled.${m.id}`,'1');
    f.store.setMeta('telegram.build.project','');
    assert.throws(()=>f.store.reserveChatBrowserTurn(m.id,bound.version,'no-post-revoke-send',
      createHash('sha256').update('unsafe after revocation').digest('hex')),
    /revoked before Send/);
    assert.equal(f.store.chatBrowserTurn(m.id),null);
    assert.equal(f.store.get(m.id).state,'READY');
    assert.equal(f.state().sends,0);
  }finally{f.cleanup();}
});

test('Telegram restart poll materializes one missing PI successor and reports continuity without sending',async()=>{
  const f=rig({decide:async()=>({action:'DONE',summary:'Not invoked',nextPrompt:''})});
  try{
    const m=f.store.create({goal:'Continue an unfinished long task',
      acceptance:['Verify the final stage'],workspace:'',sandbox:'read-only',
      mode:'supervised',maxTurns:32,checks:[],requestKey:'telegram-prior-chain'});
    const linked=f.store.linkChat(m.id,SRC,m.version).mission;
    const bound=f.store.bindChatBrowser(m.id,'install:Chrome:synthetic',linked.version).mission;
    f.store.setMeta(`pi.autopilot.enabled.${m.id}`,'1');
    f.store.update(m.id,bound.version,{state:'PAUSED',turnCount:31},'test.prior_rounds');
    const current=f.store.get(m.id);
    const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
    f.store.reserveChatBrowserTurn(m.id,current.version,'prior-chain-32',sha('Anchor user message'));
    f.store.finishChatBrowserTurn(m.id,'prior-chain-32',{kind:'observed',
      assistantSha256:sha('Anchor assistant message'),summary:'Unfinished',
      telegramBatch:{terminal:true,flowSignal:'NEXT',piManaged:true}});
    f.store.commitPiPlan(m.id,sha('Anchor assistant message'),[],{
      action:'NEXT',summary:'One stage remains',nextPrompt:'Check final stage'});
    f.store.setMeta('telegram.notifications_cursor',String(f.store.maxEventId()-1));
    f.setUpdates([]);
    await f.bridge.pollOnce(0);
    const childId=f.store.piChainSuccessor(m.id);
    assert.ok(childId);
    assert.equal(f.store.get(childId).state,'READY');
    assert.equal(f.state().sends,0);
    assert.equal(f.store.events(m.id).filter(e=>e.type==='pi.chain_successor').length,1);
    assert.match(f.sent.join('\n'),/Continuing — Next stage/);
    assert.doesNotMatch(f.sent.join('\n'),new RegExp(childId));
    await f.bridge.pollOnce(0);
    assert.equal(f.store.piChainSuccessor(m.id),childId);
    assert.equal(f.store.events(m.id).filter(e=>e.type==='pi.chain_successor').length,1);
    assert.equal(f.state().sends,0);
    f.setUpdates([f.message(975,`/pause ${m.id}`)]);
    await f.bridge.pollOnce(0);
    assert.equal(f.store.get(m.id).stopRequested,true);
    assert.equal(f.store.get(childId).stopRequested,true);
    assert.equal(f.store.get(childId).state,'PAUSED');
    assert.equal(f.state().sends,0);
  }finally{f.cleanup();}
});

test('Telegram /build refuses unapproved repository mutation without a browser send',async()=>{
  const f=rig({decide:async()=>({action:'DONE',summary:'unused',nextPrompt:''})});
  try{
    f.setUpdates([f.message(960,'/build Implement source change and test it')]);
    await f.bridge.pollOnce(0);
    assert.equal(f.engine.list().length,1);
    assert.equal(f.state().sends,0);
    assert.match(f.sent.join('\n'),/telegram-build-project/);
  }finally{f.cleanup();}
});

test('Telegram /build accepts a real multi-paragraph owner request beyond the former 1500-char limit',async()=>{
  const f=rig({decide:async()=>({action:'DONE',summary:'Observed first turn',nextPrompt:''})});
  try{
    f.store.setMeta('telegram.pi.project',APPROVED_PROJECT);
    f.store.setMeta('telegram.build.project',APPROVED_PROJECT);
    const goal='Implement the approved project and verify changes.\n'+'验'.repeat(3100);
    f.setUpdates([f.message(996,`/build ${goal}`)]);
    await f.bridge.pollOnce(0);
    const mission=f.engine.list().find(m=>m.goal===goal);
    assert.ok(mission,'The longer request must be accepted as the exact owner goal');
    assert.equal(mission.sandbox,'workspace-write');
    for(let i=0;i<220&&!f.state().closed;i++)await new Promise(r=>setTimeout(r,50));
    assert.equal(f.state().sends,1);
    assert.equal(f.state().closed,true);
    assert.ok(f.state().sentPrompts[0]?.includes(goal));
    assert.equal(f.store.piPlan(mission.id)?.action,'DONE');
  }finally{f.cleanup();}
});

test('Telegram /build coordinates two actual authorized browser turns in a scoped development mission',async()=>{
  const contexts:PiTurnContext[]=[];
  const f=rig({decide:async input=>{
    contexts.push(input);
    return input.turnCount===1
      ?{action:'NEXT',summary:'Need tests',nextPrompt:'Run project checks and verify Git'}
      :{action:'DONE',summary:'Evidence reviewed',nextPrompt:''};
  }});
  try{
    f.store.setMeta('telegram.pi.project',APPROVED_PROJECT);
    f.store.setMeta('telegram.build.project',APPROVED_PROJECT);
    f.setUpdates([f.message(961,'/build Implement one repository improvement and verify it')]);
    await f.bridge.pollOnce(0);
    const mission=f.engine.list().find(m=>m.goal==='Implement one repository improvement and verify it');
    assert.ok(mission);
    assert.equal(mission.sandbox,'workspace-write');
    assert.equal(mission.workspace,APPROVED_PROJECT);
    assert.equal(f.state().connectorOptions[0]?.bootstrapMissingAnchor,true,
      'A fresh owner task must authorize an owned launch tab if the old anchor is gone');
    for(let i=0;i<220&&!f.state().closed;i++)await new Promise(r=>setTimeout(r,50));
    assert.equal(f.state().closed,true);
    assert.equal(f.state().sends,2);
    assert.equal(f.store.piPlan(mission.id)?.action,'DONE');
    assert.equal(contexts.length,2);
    assert.equal(contexts[1]?.sandbox,'workspace-write');
    assert.equal(contexts[1]?.workspace,APPROVED_PROJECT);
    for(const prompt of f.state().sentPrompts){
      assert.ok(prompt.includes(APPROVED_PROJECT));
      assert.doesNotMatch(prompt,/This is a bounded, read-only research/);
    }
  }finally{f.cleanup();}
});

test('A one-shot /new owner task may bootstrap a missing old launch tab',async()=>{
  const f=rig({decide:async()=>({action:'DONE',summary:'unused',nextPrompt:''})});
  try {
    f.setUpdates([f.message(997,'/new Perform one isolated read-only check')]);
    await f.bridge.pollOnce(0);
    assert.equal(f.state().connectorOptions[0]?.bootstrapMissingAnchor,true);
    for(let i=0;i<220&&!f.state().closed;i++)await new Promise(r=>setTimeout(r,50));
    assert.equal(f.state().sends,1);
  }finally{f.cleanup();}
});

test('Approving a build project leaves ordinary /auto read-only',async()=>{
  const f=rig({decide:async()=>({action:'DONE',summary:'Done',nextPrompt:''})});
  try{
    f.store.setMeta('telegram.pi.project',APPROVED_PROJECT);
    f.store.setMeta('telegram.build.project',APPROVED_PROJECT);
    f.setUpdates([f.message(962,'/auto Inspect the project read-only')]);
    await f.bridge.pollOnce(0);
    const m=f.engine.list().find(m=>m.goal==='Inspect the project read-only');
    assert.equal(m?.sandbox,'read-only');
    assert.equal(m?.workspace,'');
    for(let i=0;i<100&&!f.state().closed;i++)await new Promise(r=>setTimeout(r,50));
    assert.equal(f.state().closed,true);
  }finally{f.cleanup();}
});

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
    assert.ok(f.sent.some(x=>/Task started/.test(x)));
    const mission=f.engine.list().find(m=>m.goal==='Read-only NetBox field operations research');
    assert.ok(mission);
    assert.equal(mission.maxTurns,0,'new PI Missions have no turn ceiling');
    f.setUpdates([f.message(971,'后续我要手动测试 Android，请在当前轮结束后停下来')]);
    await f.bridge.pollOnce(0);
    assert.ok(f.sent.some(x=>/Instruction saved/.test(x)));
    assert.equal(f.store.pendingPiOwnerDirectives(mission.id).length,1);
    for(let i=0;i<100&&!f.state().closed;i++)await new Promise(r=>setTimeout(r,50));
    assert.equal(f.state().closed,true);
    assert.equal(f.state().sends,1);
    assert.equal(f.state().newTabs,1);
    assert.equal(f.store.pendingPiOwnerDirectives(mission.id).length,0);
    assert.ok(seen && seen.ownerDirectives[0]?.text.includes('手动测试 Android'));
    assert.equal(f.store.piPlan(mission.id)?.action,'BLOCKED');
    await f.bridge.pollOnce(0);
    assert.equal(f.sent.filter(x=>/Needs attention — Task paused/.test(x)).length,1);
    await f.bridge.pollOnce(0);
    assert.equal(f.sent.filter(x=>/Needs attention — Task paused/.test(x)).length,1);
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
    assert.equal(f.sent.filter(x=>/Progress — 1 rounds completed/.test(x)).length,1);
    assert.equal(f.sent.filter(x=>/All Done — Task finished/.test(x)).length,1);
    assert.equal(f.sent.filter(x=>/ChatGPT update/.test(x)).length,0);
    await f.bridge.pollOnce(0);
    assert.equal(f.sent.filter(x=>/Progress — 1 rounds completed/.test(x)).length,1);
    assert.equal(f.sent.filter(x=>/All Done — Task finished/.test(x)).length,1);
  }finally{f.cleanup();}
});

test('PI restart preserves a settled NEXT on transient Playwriter loss, retries without Send and resumes after reconnection',async()=>{
  const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
  const planner:PiPlanner={decide:async()=>({
    action:'DONE',summary:'Reconnected browser answer independently reviewed',nextPrompt:'',
  })};
  const f=rig(planner,{failFirstRecoveryConnect:true});try{
    const prompt='Original verified browser prompt';
    const answer='Synthetic complete answer\n[MISSION_RELAY:DONE]';
    const created=f.store.create({goal:'Resume after temporary Playwriter outage',
      acceptance:['No duplicate Send, keep durable PI checkpoint'],workspace:'',
      sandbox:'read-only',mode:'supervised',maxTurns:3,
      requestKey:'pi-connection-transient',checks:[]});
    const linked=f.store.linkChat(created.id,SRC,created.version).mission;
    const bound=f.store.bindChatBrowser(created.id,'install:Chrome:synthetic',linked.version).mission;
    f.store.setMeta(`pi.autopilot.enabled.${created.id}`,'1');
    f.store.reserveChatBrowserTurn(created.id,bound.version,'pi-connection-transient-1',sha(prompt));
    f.store.finishChatBrowserTurn(created.id,'pi-connection-transient-1',{
      kind:'observed',assistantSha256:sha(answer),summary:answer,newChatUrl:DEST,
      telegramBatch:{terminal:false,flowSignal:'NEXT',piManaged:true},
    });
    f.store.commitPiPlan(created.id,sha(answer),[],{
      action:'NEXT',summary:'One verified step remains',nextPrompt:'Complete next step',
    });
    const initialVersion=f.store.get(created.id).version;
    const initialEvents=f.store.maxEventId();
    f.primeRecovered(prompt);
    await (f.bridge as unknown as {recoverObservedPiCheckpoint:()=>Promise<void>}).recoverObservedPiCheckpoint();
    assert.equal(f.state().connectorAttempts,1);
    assert.equal(f.state().sends,1);
    assert.equal(f.store.get(created.id).version,initialVersion+1);
    assert.equal(f.store.maxEventId(),initialEvents+1);
    assert.equal(f.store.get(created.id).lastError,null);
    assert.equal(f.store.piPlan(created.id)?.action,'NEXT');
    assert.equal(f.store.piHealth().missions.find(x=>x.id===created.id)?.phase,
      'pi_browser_read_retry_deferred_no_send');
    const deferred=f.store.events(created.id).filter(e=>e.type==='pi.browser_read_retry_deferred');
    assert.equal(deferred.length,1);
    assert.equal((deferred[0]!.payload as {assistantSha256:string}).assistantSha256,sha(answer));
    const deferredUntil=Number(f.store.getMeta(`pi.retry.after.${created.id}`));
    assert.ok(deferredUntil>Date.now());
    // Simulate a fresh worker and a new SQLite connection: its in-memory
    // retry timer is zero but the persisted request-bound delay still wins.
    const reopened=new Store(f.dbFile);
    try{
      const restarted=f.restartedController(reopened);
      await (restarted as unknown as {recoverObservedPiCheckpoint:()=>Promise<void>}).recoverObservedPiCheckpoint();
      assert.equal(f.state().connectorAttempts,1,'Persistent backoff survives worker restart');
      assert.equal(reopened.getMeta(`pi.retry.request.${created.id}`),
        'pi-connection-transient-1');
      reopened.setMeta(`pi.retry.after.${created.id}`,String(Date.now()-1));
      await (restarted as unknown as {recoverObservedPiCheckpoint:()=>Promise<void>}).recoverObservedPiCheckpoint();
      for(let i=0;i<100&&!f.state().closed;i++)
        await new Promise(r=>setTimeout(r,50));
      assert.equal(f.state().closed,true);
    }finally{reopened.close();}
    assert.equal(f.state().connectorAttempts,2);
    assert.equal(f.state().sends,2,'Only one NEW Send after the original observed request');
    assert.equal(f.store.get(created.id).turnCount,2);
    assert.equal(f.store.piPlan(created.id)?.action,'DONE');
    assert.equal(f.store.events(created.id).filter(e=>e.type==='chatgpt.browser_reserved').length,2);
    assert.equal(f.store.events(created.id).filter(e=>e.type==='pi.browser_read_retry_deferred').length,1);
    assert.equal(f.store.events(created.id).filter(e=>e.type==='pi.autopilot_interrupted').length,0);
  }finally{f.cleanup();}
});

test('scoped one-shot connection drill closes only the selected recovery session and resumes after persisted backoff',async()=>{
  const digest=(x:string)=>createHash('sha256').update(x).digest('hex');
  const prompt='Previously observed user prompt';
  const answer='Synthetic complete answer\n[MISSION_RELAY:DONE]';
  const f=rig({decide:async()=>({action:'DONE',summary:'Recovered safely',nextPrompt:''})});
  try{
    const m=f.store.create({goal:'Recover the exact targeted session',
      acceptance:['Original Send never repeated'],workspace:'',sandbox:'read-only',
      mode:'supervised',maxTurns:3,requestKey:'drill-target',checks:[]});
    const linked=f.store.linkChat(m.id,SRC,m.version).mission;
    const bound=f.store.bindChatBrowser(m.id,'install:Chrome:synthetic',linked.version).mission;
    f.store.setMeta(`pi.autopilot.enabled.${m.id}`,'1');
    f.store.reserveChatBrowserTurn(m.id,bound.version,'drill-target-1',digest(prompt));
    f.store.finishChatBrowserTurn(m.id,'drill-target-1',{
      kind:'observed',assistantSha256:digest(answer),summary:answer,newChatUrl:DEST,
      telegramBatch:{terminal:false,flowSignal:'NEXT',piManaged:true},
    });
    f.store.commitPiPlan(m.id,digest(answer),[],{
      action:'NEXT',summary:'Review final work',nextPrompt:'Complete final work',
    });
    f.primeRecovered(prompt);
    const version=f.store.get(m.id).version;
    const before=f.store.events(m.id).filter(e=>e.type==='chatgpt.browser_reserved').length;
    const armed=armScopedPiConnectionDrill(f.store,m.id,version,90);
    assert.equal(armed.requestKey,'drill-target-1');
    assert.equal(scopedPiConnectionDrillStatus(f.store,m.id).armed,true);
    assert.throws(()=>armScopedPiConnectionDrill(f.store,m.id,version),/already armed/);
    await (f.bridge as unknown as {recoverObservedPiCheckpoint:()=>Promise<void>}).recoverObservedPiCheckpoint();
    assert.equal(f.state().connectorAttempts,1);
    assert.equal(f.state().closed,true,'The selected connector session is closed');
    assert.equal(f.state().sends,1,'The earlier Send was not replayed');
    assert.equal(scopedPiConnectionDrillStatus(f.store,m.id).armed,false);
    assert.equal(f.store.events(m.id).filter(e=>e.type==='pi.recovery_connection_drill_triggered').length,1);
    assert.equal(f.store.events(m.id).filter(e=>e.type==='pi.recovery_connection_drill_client_closed').length,1);
    assert.equal(f.store.events(m.id).filter(e=>e.type==='pi.browser_read_retry_deferred').length,1);
    assert.equal(f.store.events(m.id).filter(e=>e.type==='chatgpt.browser_reserved').length,before);
    const reopened=new Store(f.dbFile);
    try{
      const replacement=f.restartedController(reopened);
      await (replacement as unknown as {recoverObservedPiCheckpoint:()=>Promise<void>}).recoverObservedPiCheckpoint();
      assert.equal(f.state().connectorAttempts,1,'The new Worker honors original backoff');
      reopened.setMeta(`pi.retry.after.${m.id}`,String(Date.now()-1));
      await (replacement as unknown as {recoverObservedPiCheckpoint:()=>Promise<void>}).recoverObservedPiCheckpoint();
      for(let i=0;i<120&&reopened.get(m.id).turnCount<2;i++)
        await new Promise(r=>setTimeout(r,40));
      assert.equal(reopened.get(m.id).turnCount,2);
      assert.equal(reopened.piPlan(m.id)?.action,'DONE');
      assert.equal(reopened.events(m.id).filter(e=>e.type==='pi.recovery_connection_drill_triggered').length,1);
      assert.equal(reopened.events(m.id).filter(e=>e.type==='chatgpt.browser_reserved').length,before+1,
        'Exactly one new authorized NEXT, never another original Send');
    }finally{reopened.close();}
  }finally{f.cleanup();}
});

test('scoped connection drill expires independently and refuses owner pause or an in-flight Send',()=>{
  const digest=(x:string)=>createHash('sha256').update(x).digest('hex');
  const f=rig({decide:async()=>({action:'DONE',summary:'not used',nextPrompt:''})});
  try{
    const m=f.store.create({goal:'Expiry and pause fail closed',acceptance:['Keep pause'],
      workspace:'',sandbox:'read-only',mode:'supervised',maxTurns:3,
      requestKey:'drill-expiry',checks:[]});
    const linked=f.store.linkChat(m.id,SRC,m.version).mission;
    const bound=f.store.bindChatBrowser(m.id,'install:Chrome:synthetic',linked.version).mission;
    f.store.setMeta(`pi.autopilot.enabled.${m.id}`,'1');
    f.store.reserveChatBrowserTurn(m.id,bound.version,'drill-expiry-1',digest('prompt'));
    assert.throws(()=>armScopedPiConnectionDrill(f.store,m.id,f.store.get(m.id).version),
      /settled, eligible/);
    f.store.finishChatBrowserTurn(m.id,'drill-expiry-1',{
      kind:'observed',assistantSha256:digest('answer'),summary:'answer',newChatUrl:DEST,
      telegramBatch:{terminal:false,flowSignal:'NEXT',piManaged:true},
    });
    const t=Date.now();
    const revision=f.store.get(m.id).version;
    armScopedPiConnectionDrill(f.store,m.id,revision,5,t);
    assert.equal(consumeScopedPiConnectionDrill(f.store,m.id,t+5000),false);
    assert.equal(scopedPiConnectionDrillStatus(f.store,m.id,t+5000).armed,false);
    assert.equal(f.store.events(m.id).filter(e=>e.type==='pi.recovery_connection_drill_triggered').length,0);
    f.store.update(m.id,f.store.get(m.id).version,{stopRequested:true},
      'mission.pause_requested',{reason:'synthetic owner pause'});
    assert.equal(f.store.get(m.id).stopRequested,true);
    assert.throws(()=>armScopedPiConnectionDrill(f.store,m.id,f.store.get(m.id).version),
      /settled, eligible/);
    assert.equal(consumeScopedPiConnectionDrill(f.store,m.id),false);
  }finally{f.cleanup();}
});

test('a denied Playwriter permission fails closed, preserving the original PI answer and requiring operator repair',async()=>{
  const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
  const f=rig({decide:async()=>{throw new Error('PI must not run without browser verification');}},
    {recoveryConnectError:'Playwriter extension permission denied'});
  try{
    const prompt='Permission-gated source',answer='Observed original answer';
    const m=f.store.create({goal:'Do not bypass browser permissions',
      acceptance:['Preserve the original reply'],workspace:'',sandbox:'read-only',
      mode:'supervised',maxTurns:3,requestKey:'pi-denied-source',checks:[]});
    const linked=f.store.linkChat(m.id,SRC,m.version).mission;
    const bound=f.store.bindChatBrowser(m.id,'install:Chrome:synthetic',linked.version).mission;
    f.store.setMeta(`pi.autopilot.enabled.${m.id}`,'1');
    f.store.reserveChatBrowserTurn(m.id,bound.version,'pi-denied-source-1',sha(prompt));
    f.store.finishChatBrowserTurn(m.id,'pi-denied-source-1',{
      kind:'observed',assistantSha256:sha(answer),summary:answer,newChatUrl:DEST,
      telegramBatch:{terminal:false,flowSignal:'NEXT',piManaged:true},
    });
    f.store.commitPiPlan(m.id,sha(answer),[],{
      action:'NEXT',summary:'Continue only after a secure read',nextPrompt:'One authorized next step',
    });
    f.primeRecovered(prompt);
    await (f.bridge as unknown as {recoverObservedPiCheckpoint:()=>Promise<void>}).recoverObservedPiCheckpoint();
    assert.equal(f.state().connectorAttempts,1);
    assert.match(f.store.get(m.id).lastError??'',/permission denied/);
    assert.equal(f.store.events(m.id).filter(x=>x.type==='pi.autopilot_interrupted').length,1);
    assert.equal(f.store.events(m.id).filter(x=>x.type==='pi.browser_read_retry_deferred').length,0);
    await (f.bridge as unknown as {recoverObservedPiCheckpoint:()=>Promise<void>}).recoverObservedPiCheckpoint();
    assert.equal(f.state().connectorAttempts,1,'A permission denial must not silently self-resume');
    assert.equal(f.store.events(m.id).filter(x=>x.type==='chatgpt.browser_reserved').length,1);
    assert.equal(f.store.events(m.id).filter(x=>x.type==='chatgpt.browser_observed').length,1);
    assert.equal(f.state().sends,1,'The original browser Send was not replayed');
  }finally{f.cleanup();}
});

test('persisted retry attempts are request-scoped, while owner pause and an old PI BLOCKED stay terminal',async()=>{
  const f=rig({decide:async()=>{throw new Error('Never invoke PI for excluded tasks');}});
  const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
  try{
    const start=(requestKey:string)=>{
      const m=f.store.create({goal:'Preserve historical terminal and owner states',
        acceptance:['No duplicate browser Send'],workspace:'',sandbox:'read-only',
        mode:'supervised',maxTurns:3,requestKey,checks:[]});
      const linked=f.store.linkChat(m.id,DEST,m.version).mission;
      const bound=f.store.bindChatBrowser(m.id,'install:Chrome:synthetic',linked.version).mission;
      f.store.setMeta(`pi.autopilot.enabled.${m.id}`,'1');
      f.store.reserveChatBrowserTurn(m.id,bound.version,`${requestKey}-1`,sha('Original prompt'));
      return m.id;
    };
    const blockedId=start('historical-blocked');
    f.store.finishChatBrowserTurn(blockedId,'historical-blocked-1',{
      kind:'observed',assistantSha256:sha('Original answer'),summary:'Original answer',
      telegramBatch:{terminal:false,flowSignal:'BLOCKED',piManaged:true},
    });
    f.store.commitPiPlan(blockedId,sha('Original answer'),[],{
      action:'BLOCKED',summary:'Owner must restore the source permission',nextPrompt:'',
    });
    assert.equal(deferTransientPiBrowserRecovery(f.store,blockedId,'Offline'),false);
    const pausedId=start('human-paused');
    f.engine.pause(pausedId);
    f.store.finishChatBrowserTurn(pausedId,'human-paused-1',{
      kind:'observed',assistantSha256:sha('Original answer'),summary:'Original answer',
      telegramBatch:{terminal:false,flowSignal:'NEXT',piManaged:true},
    });
    assert.equal(f.store.get(pausedId).stopRequested,true);
    assert.equal(deferTransientPiBrowserRecovery(f.store,pausedId,'Offline'),false);
    const eventCount=f.store.maxEventId();
    await (f.bridge as unknown as {recoverObservedPiCheckpoint:()=>Promise<void>}).recoverObservedPiCheckpoint();
    assert.equal(f.state().connectorAttempts,0);
    assert.equal(f.state().sends,0);
    assert.equal(f.store.maxEventId(),eventCount);
    assert.equal(f.store.piPlan(blockedId)?.action,'BLOCKED');
    assert.equal(f.store.get(pausedId).stopRequested,true);
    assert.equal(f.store.events(blockedId).filter(x=>x.type==='pi.autopilot_retry_deferred').length,0);
  }finally{f.cleanup();}
});

test('worker exits after an original reserved Send: restart inspects but never re-sends or invents a receipt',async()=>{
  const f=rig({decide:async()=>{throw new Error('Unobserved Send must not be PI-reviewed');}});
  try{
    const m=f.store.create({goal:'Retain the original unacknowledged Send',
      acceptance:['No replay after worker failure'],workspace:'',sandbox:'read-only',
      mode:'supervised',maxTurns:3,requestKey:'worker-died-during-send',checks:[]});
    const linked=f.store.linkChat(m.id,DEST,m.version).mission;
    const bound=f.store.bindChatBrowser(m.id,'install:Chrome:synthetic',linked.version).mission;
    f.store.setMeta(`pi.autopilot.enabled.${m.id}`,'1');
    const reserved=f.store.reserveChatBrowserTurn(m.id,bound.version,
      'worker-died-during-send-1','a'.repeat(64));
    // Fault injection only in a disposable SQLite fixture. No browser state
    // is invented and the production worker is never touched.
    f.store.update(m.id,reserved.version,{ownerPid:999999,ownerHost:hostname()},
      'test.simulated_worker_exited');
    assert.equal(f.store.piHealth().missions.find(x=>x.id===m.id)?.phase,
      'dead_owner_reserved_inspect_only_do_not_resend');
    const before=f.store.events(m.id).length;
    const reopened=new Store(f.dbFile);
    try{
      const restarted=f.restartedController(reopened);
      await (restarted as unknown as {recoverObservedPiCheckpoint:()=>Promise<void>}).recoverObservedPiCheckpoint();
      assert.equal(reopened.events(m.id).length,before);
      assert.equal(reopened.chatBrowserTurn(m.id)?.status,'reserved');
      assert.equal(reopened.get(m.id).turnCount,0);
      assert.equal(reopened.events(m.id).filter(x=>x.type==='chatgpt.browser_observed').length,0);
      assert.equal(reopened.events(m.id).filter(x=>x.type==='chatgpt.browser_reserved').length,1);
    }finally{reopened.close();}
    assert.equal(f.state().sends,0);
    assert.equal(f.state().connectorAttempts,0);
  }finally{f.cleanup();}
});

test('repeated PI/browser outages double persistent backoff but identical text on a new request starts a new counter',()=>{
  const f=rig({decide:async()=>{throw new Error('No model call needed');}});
  const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
  try{
    const m=f.store.create({goal:'Preserve distinct request identity across retries',
      acceptance:['Do not replay Send'],workspace:'',sandbox:'read-only',
      mode:'supervised',maxTurns:3,requestKey:'retry-distinct-rounds',checks:[]});
    const linked=f.store.linkChat(m.id,DEST,m.version).mission;
    const bound=f.store.bindChatBrowser(m.id,'install:Chrome:synthetic',linked.version).mission;
    f.store.setMeta(`pi.autopilot.enabled.${m.id}`,'1');
    f.store.reserveChatBrowserTurn(m.id,bound.version,'retry-distinct-rounds-1',sha('Prompt 1'));
    f.store.finishChatBrowserTurn(m.id,'retry-distinct-rounds-1',{
      kind:'observed',assistantSha256:sha('Repeated output'),summary:'Repeated output',
      telegramBatch:{terminal:false,flowSignal:'NEXT',piManaged:true},
    });
    assert.equal(deferTransientPiBrowserRecovery(f.store,m.id,'Temporary Chrome disconnect'),true);
    const firstAfter=Number(f.store.getMeta(`pi.retry.after.${m.id}`));
    assert.equal(Number(f.store.getMeta(`pi.retry.count.${m.id}`)),1);
    pauseFailedPiPlanning(f.store,m.id,new RetryablePiError('PI Goal decision format invalid'));
    const secondAfter=Number(f.store.getMeta(`pi.retry.after.${m.id}`));
    assert.ok(secondAfter-firstAfter>50_000,'The second retry has a longer delay');
    assert.equal(Number(f.store.getMeta(`pi.retry.count.${m.id}`)),2);
    const reviewed=f.store.commitPiPlan(m.id,sha('Repeated output'),[],{
      action:'NEXT',summary:'Different original request follows',nextPrompt:'Proceed with the new request',
    });
    assert.equal(reviewed.round,1);
    const revision=f.store.get(m.id).version;
    f.store.reserveChatBrowserTurn(m.id,revision,'retry-distinct-rounds-2',sha('Prompt 2'));
    f.store.finishChatBrowserTurn(m.id,'retry-distinct-rounds-2',{
      kind:'observed',assistantSha256:sha('Repeated output'),summary:'Repeated output',
      telegramBatch:{terminal:false,flowSignal:'NEXT',piManaged:true},
    });
    assert.equal(deferTransientPiBrowserRecovery(f.store,m.id,'New request: temporary disconnect'),true);
    assert.equal(Number(f.store.getMeta(`pi.retry.count.${m.id}`)),1,
      'A repeated answer body from a different request must reset retry count');
    assert.equal(f.store.getMeta(`pi.retry.request.${m.id}`),'retry-distinct-rounds-2');
    assert.deepEqual(f.store.events(m.id).filter(e=>e.type==='pi.browser_read_retry_deferred')
      .map(e=>(e.payload as {attempt:number}).attempt),[1,1]);
    assert.equal(f.store.events(m.id).filter(e=>e.type==='chatgpt.browser_observed').length,2);
    assert.equal(f.state().sends,0);
  }finally{f.cleanup();}
});

test('Temporary PI inference outage defers the exact settled answer, survives controller rescan and retries without an old Send',async()=>{
  const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
  const prompt='Previously sent and durably observed PI prompt';
  const answer='Synthetic complete answer\n[MISSION_RELAY:DONE]';
  let decisions=0;
  const f=rig({decide:async context=>{
    decisions++;
    assert.equal(context.responseSha256,sha(answer));
    return {action:'DONE',summary:'The original answer was reviewed without a new Send',nextPrompt:''};
  }});
  try{
    const created=f.store.create({goal:'Safely re-review a settled reply',
      acceptance:['Never repeat the original Send'],workspace:'',sandbox:'read-only',
      mode:'supervised',maxTurns:3,requestKey:'pi-retry-exact-checkpoint',checks:[]});
    const linked=f.store.linkChat(created.id,SRC,created.version).mission;
    const bound=f.store.bindChatBrowser(created.id,'install:Chrome:synthetic',linked.version).mission;
    f.store.setMeta(`pi.autopilot.enabled.${created.id}`,'1');
    f.store.reserveChatBrowserTurn(created.id,bound.version,'pi-retry-exact-checkpoint-1',
      sha(prompt),{newConversation:true});
    f.store.finishChatBrowserTurn(created.id,'pi-retry-exact-checkpoint-1',{
      kind:'observed',assistantSha256:sha(answer),summary:answer,newChatUrl:DEST,
      telegramBatch:{terminal:false,flowSignal:'NEXT',piManaged:true},
    });
    pauseFailedPiPlanning(f.store,created.id,new RetryablePiError('Remote PI inference deadline exceeded'));
    const after=f.store.get(created.id);
    assert.equal(after.state,'PAUSED');
    assert.equal(after.lastError,null);
    assert.equal(f.store.piPlan(created.id),null);
    assert.equal(f.store.events(created.id).filter(x=>x.type==='pi.autopilot_retry_deferred').length,1);
    assert.equal(f.store.events(created.id).filter(x=>x.type==='pi.autopilot_interrupted').length,0);
    assert.equal(f.store.piHealth().missions.find(x=>x.id===created.id)?.phase,
      'pi_inference_retry_deferred_no_send');
    f.primeRecovered(prompt);
    await (f.bridge as unknown as {recoverObservedPiCheckpoint:()=>Promise<void>}).recoverObservedPiCheckpoint();
    assert.equal(f.state().connectorAttempts,0,'Persistent backoff must survive a controller scan');
    assert.equal(f.state().sends,1);
    f.store.setMeta(`pi.retry.after.${created.id}`,String(Date.now()-1));
    await (f.bridge as unknown as {recoverObservedPiCheckpoint:()=>Promise<void>}).recoverObservedPiCheckpoint();
    for(let i=0;i<100&&!f.store.piPlan(created.id);i++)
      await new Promise(r=>setTimeout(r,30));
    assert.equal(f.store.piPlan(created.id)?.action,'DONE');
    assert.equal(f.store.get(created.id).lastError,null);
    assert.equal(f.store.events(created.id).filter(x=>x.type==='chatgpt.browser_reserved').length,1);
    assert.equal(f.state().sends,1,'PI inference retry must not submit an additional browser Send');
    assert.equal(decisions,1,'Only the recovered answer should be reviewed by this controller');
  }finally{f.cleanup();}
});

test('An integrity mismatch does not become a retryable PI outage or re-enable old paused Missions',async()=>{
  const f=rig({decide:async()=>{throw new Error('Should not run');}});
  try{
    const created=f.store.create({goal:'Do not erase source changes',
      acceptance:['Fail closed'],workspace:'',sandbox:'read-only',mode:'supervised',
      maxTurns:3,requestKey:'pi-integrity-stop',checks:[]});
    const linked=f.store.linkChat(created.id,SRC,created.version).mission;
    const bound=f.store.bindChatBrowser(created.id,'install:Chrome:synthetic',linked.version).mission;
    f.store.setMeta(`pi.autopilot.enabled.${created.id}`,'1');
    f.store.reserveChatBrowserTurn(created.id,bound.version,'pi-integrity-stop-1',
      'b'.repeat(64));
    f.store.finishChatBrowserTurn(created.id,'pi-integrity-stop-1',{
      kind:'observed',assistantSha256:'a'.repeat(64),summary:'Old reply',
      telegramBatch:{terminal:false,flowSignal:'NEXT',piManaged:true},
    });
    pauseFailedPiPlanning(f.store,created.id,
      new Error('PI recovery refused: current Chrome user/assistant turns differ'));
    assert.match(f.store.get(created.id).lastError??'',/turns differ/);
    assert.equal(f.store.events(created.id).filter(x=>x.type==='pi.autopilot_retry_deferred').length,0);
    await (f.bridge as unknown as {recoverObservedPiCheckpoint:()=>Promise<void>}).recoverObservedPiCheckpoint();
    assert.equal(f.state().connectorAttempts,0);
    assert.equal(f.state().sends,0);
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

test('Telegram controller resumes only the corrected answer of an old falsely credited PI round',async()=>{
  const answer='Synthetic complete answer\n[MISSION_RELAY:DONE]';
  const old='Stale re-rendered assistant message\n[MISSION_RELAY:NEXT]';
  const prompt='Original submitted prompt';
  const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
  const f=rig({decide:async context=>{
    assert.equal(context.turnCount,1);
    assert.equal(context.responseSha256,sha(answer));
    assert.equal(context.lastAssistant,answer);
    return {action:'DONE',summary:'Corrected answer really reviewed',nextPrompt:''};
  }});try{
    const created=f.store.create({goal:'Repair an already observed wrong PI answer',
      acceptance:['Verify corrected evidence'],workspace:'',sandbox:'read-only',
      mode:'supervised',maxTurns:3,requestKey:'repair-telegram',checks:[]});
    const linked=f.store.linkChat(created.id,SRC,created.version).mission;
    const bound=f.store.bindChatBrowser(created.id,'install:Chrome:synthetic',linked.version).mission;
    f.store.setMeta(`pi.autopilot.enabled.${created.id}`,'1');
    f.store.reserveChatBrowserTurn(created.id,bound.version,'repair-1',sha(prompt),{newConversation:true});
    f.store.finishChatBrowserTurn(created.id,'repair-1',{
      kind:'observed',assistantSha256:sha(old),summary:old,newChatUrl:DEST,
    });
    f.store.commitPiPlan(created.id,sha(old),[],{
      action:'NEXT',summary:'Old bad decision',nextPrompt:'Wrong follow-up',
    });
    f.store.correctPiBrowserAttribution(created.id,f.store.get(created.id).version,{
      requestPromptSha256:sha(prompt),assistantSha256:sha(answer),summary:answer,
    });
    assert.equal(f.store.piHealth().missions.find(x=>x.id===created.id)?.phase,
      'corrected_answer_requires_pi_review');
    f.primeRecovered(prompt);
    await (f.bridge as unknown as {recoverObservedPiCheckpoint:()=>Promise<void>}).recoverObservedPiCheckpoint();
    for(let i=0;i<90&&!f.state().closed;i++)await new Promise(r=>setTimeout(r,50));
    assert.equal(f.state().closed,true);
    assert.equal(f.state().sends,1); // Fake historical Send only.
    assert.equal(f.store.get(created.id).turnCount,1);
    assert.equal(f.store.piPlan(created.id)?.action,'DONE');
    assert.equal(f.store.piPlan(created.id)?.responseSha256,sha(answer));
    assert.equal(f.store.get(created.id).lastError,null);
    assert.equal(f.store.events(created.id).filter(x=>x.type==='chatgpt.browser_reserved').length,1);
    assert.equal(f.store.events(created.id).filter(x=>x.type==='pi.decision_attribution_corrected').length,1);
  }finally{f.cleanup();}
});

test('controller resumes an owner-paused settled PI checkpoint after readback without replaying its first Send',async()=>{
  const prompt='Original PI browser prompt preserved through maintenance';
  const first='Synthetic complete answer\n[MISSION_RELAY:DONE]';
  const second='Second synthetic complete answer\n[MISSION_RELAY:DONE]';
  const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
  const reviewed:number[]=[];
  const f=rig({decide:async context=>{
    reviewed.push(context.turnCount);
    if(context.turnCount===1){
      assert.equal(context.responseSha256,hash(first));
      assert.equal(context.lastAssistant,first);
      return {action:'NEXT',summary:'First settled answer needs one further step',
        nextPrompt:'Complete the additional verified check'};
    }
    assert.equal(context.turnCount,2);
    assert.equal(context.responseSha256,hash(second));
    return {action:'DONE',summary:'All expected checks completed',nextPrompt:''};
  }});try{
    const created=f.store.create({goal:'Resume ongoing PI work after safe maintenance',
      acceptance:['Do not resend previous request'],workspace:'',
      sandbox:'read-only',mode:'supervised',maxTurns:4,checks:[],
      requestKey:'pi-maintenance-resume'});
    const linked=f.store.linkChat(created.id,SRC,created.version).mission;
    const bound=f.store.bindChatBrowser(created.id,'install:Chrome:synthetic',linked.version).mission;
    f.store.setMeta(`pi.autopilot.enabled.${created.id}`,'1');
    f.store.reserveChatBrowserTurn(created.id,bound.version,'pi-maintenance-resume-1',
      hash(prompt),{newConversation:true});
    const requested=f.engine.pause(created.id);
    assert.equal(requested.stopRequested,true);
    assert.equal(requested.state,'RUNNING');
    const settled=f.store.finishChatBrowserTurn(created.id,'pi-maintenance-resume-1',{
      kind:'observed',assistantSha256:hash(first),summary:first,newChatUrl:DEST,
      telegramBatch:{terminal:false,flowSignal:'DONE',piManaged:true},
    });
    assert.equal(settled.state,'PAUSED');
    assert.equal(settled.stopRequested,true);
    assert.equal(settled.turnCount,1);
    f.primeRecovered(prompt);
    const released=f.store.resumePausedPiCheckpoint(created.id,settled.version);
    assert.equal(released.state,'PAUSED');
    assert.equal(released.stopRequested,false);
    assert.equal(f.state().sends,1);
    await (f.bridge as unknown as {recoverObservedPiCheckpoint:()=>Promise<void>})
      .recoverObservedPiCheckpoint();
    for(let i=0;i<260&&!f.state().closed;i++)await new Promise(r=>setTimeout(r,50));
    assert.equal(f.state().closed,true);
    assert.equal(f.state().sends,2,'one new Send after independently recovered original');
    assert.deepEqual(reviewed,[1,2]);
    assert.equal(f.store.get(created.id).turnCount,2);
    assert.equal(f.store.piPlan(created.id)?.round,2);
    assert.equal(f.store.piPlan(created.id)?.action,'DONE');
    assert.equal(f.store.events(created.id).filter(e=>e.type==='chatgpt.browser_reserved').length,2);
    assert.equal(f.store.events(created.id).filter(e=>e.type==='chatgpt.browser_observed').length,2);
    assert.equal(f.store.events(created.id).filter(e=>e.type==='pi.pause_released').length,1);
  }finally{f.cleanup();}
});

test('after a 32-turn handoff, recovering the successor second turn uses its OWN receipt, not the parent final receipt',async()=>{
  const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
  const parentAnswer='Different original parent answer\n[MISSION_RELAY:NEXT]';
  const childAnswer='Synthetic complete answer\n[MISSION_RELAY:DONE]';
  const childPrompt='Original successor second prompt';
  const reviews:number[]=[];
  const f=rig({decide:async context=>{
    reviews.push(context.turnCount);
    assert.equal(context.turnCount,2);
    assert.equal(context.responseSha256,sha(childAnswer));
    assert.equal(context.lastAssistant,childAnswer);
    return {action:'DONE',summary:'Verified successor recovery from its own receipt',
      nextPrompt:''};
  }});try{
    const parent=f.store.create({goal:'Recover a continuing owner Goal across Mission boundary',
      acceptance:['No duplicate browser Send'],workspace:'',sandbox:'read-only',
      mode:'supervised',maxTurns:32,requestKey:'recovery-parent',checks:[]});
    const linked=f.store.linkChat(parent.id,SRC,parent.version).mission;
    const bound=f.store.bindChatBrowser(parent.id,'install:Chrome:synthetic',linked.version).mission;
    f.store.setMeta(`pi.autopilot.enabled.${parent.id}`,'1');
    const prior=f.store.update(parent.id,bound.version,{state:'PAUSED',turnCount:31},
      'test.synthetic_predecessor_rounds');
    f.store.reserveChatBrowserTurn(parent.id,prior.version,'parent-last',
      sha('Parent round 32 prompt'));
    f.store.finishChatBrowserTurn(parent.id,'parent-last',{
      kind:'observed',assistantSha256:sha(parentAnswer),summary:parentAnswer,
    });
    f.store.commitPiPlan(parent.id,sha(parentAnswer),[],{
      action:'NEXT',summary:'Continue owner Goal in the successor Mission',
      nextPrompt:'Review successor after rollover',
    });
    f.store.update(parent.id,f.store.get(parent.id).version,{},
      'pi.autopilot_finished',{action:'LIMIT'});
    const child=f.store.createPiSuccessor(parent.id);
    assert.ok(child,'Use the real reciprocal successor creation path');
    assert.equal(f.store.piChainParent(child.id),parent.id);
    assert.equal(f.store.piChainSuccessor(parent.id),child.id);
    f.store.reserveChatBrowserTurn(child.id,child.version,'child-first',
      sha('Child first prompt'),{newConversation:true});
    f.store.finishChatBrowserTurn(child.id,'child-first',{
      kind:'observed',assistantSha256:sha(childAnswer),summary:childAnswer,
      newChatUrl:DEST,
    });
    f.store.commitPiPlan(child.id,sha(childAnswer),[],{
      action:'NEXT',summary:'Second successor step required',nextPrompt:'Continue',
    });
    f.store.reserveChatBrowserTurn(child.id,f.store.get(child.id).version,'child-second',
      sha(childPrompt));
    f.store.finishChatBrowserTurn(child.id,'child-second',{
      kind:'observed',assistantSha256:sha(childAnswer),summary:childAnswer,
    });
    const interrupted=f.store.update(child.id,f.store.get(child.id).version,{
      lastError:PI_SUCCESSOR_CHECKPOINT_MISMATCH},
      'pi.autopilot_interrupted',{reason:PI_SUCCESSOR_CHECKPOINT_MISMATCH});
    assert.equal(f.store.get(child.id).turnCount,2);
    assert.throws(()=>f.store.clearVerifiedPiSuccessorMismatch(child.id,interrupted.version,{
      requestPromptSha256:sha(childPrompt),assistantSha256:sha(parentAnswer),
    }),/independently verified original checkpoint/,
    'The parent answer digest must never be accepted as the successor answer');
    const cleared=f.store.clearVerifiedPiSuccessorMismatch(child.id,interrupted.version,{
      requestPromptSha256:sha(childPrompt),assistantSha256:sha(childAnswer),
    });
    assert.equal(cleared.state,'PAUSED');
    assert.equal(cleared.lastError,null);
    assert.equal(cleared.stopRequested,false);
    assert.throws(()=>f.store.clearVerifiedPiSuccessorMismatch(child.id,cleared.version,{
      requestPromptSha256:sha(childPrompt),assistantSha256:sha(childAnswer),
    }),/independently verified original checkpoint/,'Interruption cannot be cleared twice');
    f.primeRecovered(childPrompt);
    await (f.bridge as unknown as {recoverObservedPiCheckpoint:()=>Promise<void>})
      .recoverObservedPiCheckpoint();
    for(let i=0;i<100&&!f.state().closed;i++)
      await new Promise(resolve=>setTimeout(resolve,50));
    assert.equal(f.state().closed,true);
    assert.deepEqual(reviews,[2]);
    assert.equal(f.store.piPlan(child.id)?.round,2);
    assert.equal(f.store.piPlan(child.id)?.action,'DONE');
    assert.equal(f.store.get(child.id).turnCount,2);
    assert.equal(f.store.get(child.id).lastError,null);
    assert.equal(f.state().sends,1,'Only synthetic historical Send exists; no duplicate Send');
    assert.equal(f.store.events(child.id).filter(x=>x.type==='chatgpt.browser_reserved').length,2);
    assert.equal(f.store.events(child.id).filter(x=>x.type==='pi.autopilot_checkpoint_revalidated').length,1);
    assert.equal(f.store.events(parent.id).filter(x=>x.type==='chatgpt.browser_reserved').length,1);
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
    // The foreground PI dispatch is async. Await the original reservation,
    // not an arbitrary scheduling turn; a busy concurrent test runner must
    // never make this assertion race the legitimate first Send.
    for(let i=0;i<100&&
      !f.store.events(mission.id).some(e=>e.type==='chatgpt.browser_reserved');i++)
      await new Promise(r=>setTimeout(r,20));
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
    assert.ok(f.sent.some(text=>text.includes('Task started')));
    for(let i=0;i<110&&!f.state().closed;i++)await new Promise(r=>setTimeout(r,50));
    assert.equal(f.state().sends,1); // Only the new task sent a new prompt.
    assert.equal(f.store.get(old.id).version,oldVersion);
    assert.equal(f.store.events(old.id).filter(e=>e.type==='chatgpt.browser_reserved').length,1);
    assert.match(f.store.get(old.id).lastError??'',/PI inference unavailable/);
    f.setUpdates([f.message(992,`/status ${old.id}`)]);
    await f.bridge.pollOnce(0);
    assert.ok(f.sent.some(text=>text.includes('Issue: PI inference unavailable')));
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

test('A new Goal is durably queued beside an owner-paused in-flight Send, but never dispatches until settlement',async()=>{
  const f=rig(goalPlanner());
  try{
    f.store.setMeta('telegram.pi.project',APPROVED_PROJECT);
    f.store.setMeta('telegram.build.project',APPROVED_PROJECT);
    const oldObjective='Earlier owner Goal must remain paused';
    const old=f.store.create({goal:oldObjective,acceptance:['Preserve original Send'],
      workspace:APPROVED_PROJECT,sandbox:'workspace-write',mode:'supervised',
      maxTurns:32,requestKey:'owner-paused-old-root',checks:[]});
    const oldUrl='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174008';
    const linked=f.store.linkChat(old.id,oldUrl,old.version).mission;
    const bound=f.store.bindChatBrowser(old.id,'install:Chrome:synthetic',linked.version).mission;
    f.store.setMeta(`pi.autopilot.enabled.${old.id}`,'1');
    const ledger=new GoalLedger(f.store);
    const oldGoal=ledger.createGoal({requestKey:'owner-paused-old-goal',
      objective:oldObjective,priority:50});
    ledger.bindPiMission(oldGoal.id,old.id,bound.version,'old-root-bind');
    f.store.reserveChatBrowserTurn(old.id,bound.version,'owner-paused-old-send','b'.repeat(64));
    f.engine.pause(old.id);
    const oldEventsWhileReserved=f.store.events(old.id);
    const objective='Fresh independently scoped Mission Relay Goal';
    f.setUpdates([f.message(3401,`/goal-build ${objective}`)]);
    await f.bridge.pollOnce(0);
    assert.equal(ledger.listGoals().length,2,'Goal intake must not be blocked by the old in-flight Send');
    assert.equal(f.state().sends,0);
    assert.ok(f.sent.some(x=>/Task accepted|Task queued/.test(x)));
    const newMission=f.engine.list().find(m=>m.goal===objective)!;
    assert.equal(newMission.state,'READY');
    assert.equal(f.store.chatBrowserTurn(newMission.id),null);
    await (f.bridge as unknown as {recoverObservedPiCheckpoint:()=>Promise<void>})
      .recoverObservedPiCheckpoint();
    assert.equal(f.state().sends,0,'An unsettled Send must block scheduler switching');
    assert.equal(f.store.chatBrowserTurn(old.id)?.status,'reserved');
    assert.equal(f.store.get(old.id).stopRequested,true);
    assert.deepEqual(f.store.events(old.id),oldEventsWhileReserved);

    f.store.finishChatBrowserTurn(old.id,'owner-paused-old-send',{
      kind:'observed',assistantSha256:'a'.repeat(64),summary:'Original Send settled',
      telegramBatch:{terminal:false,flowSignal:'NEXT',piManaged:true},
    });
    const settledOld=f.store.get(old.id);
    const settledEvents=f.store.events(old.id);
    const oldGraph=ledger.graph(oldGoal.id);
    assert.equal(settledOld.state,'PAUSED');
    assert.equal(settledOld.stopRequested,true);
    const newGoal=ledger.listGoals().find(g=>g.id!==oldGoal.id)!;
    assert.ok(newGoal);
    assert.notEqual(newGoal.id,oldGoal.id);
    assert.ok(newMission);
    assert.equal(ledger.missionGoalId(newMission.id),newGoal.id);
    assert.notEqual(newMission.id,old.id);
    await (f.bridge as unknown as {recoverObservedPiCheckpoint:()=>Promise<void>})
      .recoverObservedPiCheckpoint();
    for(let i=0;i<160&&!f.state().closed;i++)await new Promise(r=>setTimeout(r,50));
    assert.equal(f.state().closed,true);
    assert.ok(f.state().sentPrompts[0]?.includes(objective));
    assert.ok(!f.state().sentPrompts[0]?.includes(oldObjective));
    assert.equal(f.store.events(newMission.id).filter(e=>e.type==='chatgpt.browser_reserved').length,2);
    assert.equal(f.store.get(newMission.id).turnCount,2);
    assert.deepEqual(f.store.get(old.id),settledOld);
    assert.deepEqual(f.store.events(old.id),settledEvents);
    assert.deepEqual(ledger.graph(oldGoal.id),oldGraph);
  }finally{f.cleanup();}
});

test('A settled browser answer uses PAUSED as a PI review checkpoint, then NEXT reserves exactly one distinct Send',()=>{
  const f=rig({decide:async()=>{throw new Error('The controller must own PI inference');}});
  try{
    const m=f.store.create({goal:'Review and continue one verified answer',
      acceptance:['Preserve exactly one browser observation'],workspace:'',
      sandbox:'read-only',mode:'supervised',maxTurns:3,
      requestKey:'settled-pi-checkpoint',checks:[]});
    const linked=f.store.linkChat(m.id,DEST,m.version).mission;
    const bound=f.store.bindChatBrowser(m.id,'install:Chrome:synthetic',linked.version).mission;
    f.store.setMeta(`pi.autopilot.enabled.${m.id}`,'1');
    const firstPrompt='1'.repeat(64),firstAnswer='2'.repeat(64);
    const first=f.store.reserveChatBrowserTurn(m.id,bound.version,
      'settled-pi-checkpoint-1',firstPrompt);
    const settled=f.store.finishChatBrowserTurn(m.id,'settled-pi-checkpoint-1',{
      kind:'observed',assistantSha256:firstAnswer,summary:'Original answer complete',
      telegramBatch:{terminal:false,flowSignal:'NEXT',piManaged:true},
    });
    assert.equal(settled.state,'PAUSED');
    assert.equal(settled.stopRequested,false);
    assert.equal(settled.lastError,null);
    assert.equal(settled.turnCount,1);
    assert.equal(f.store.hasVerifiedPiBrowserCheckpoint(m.id),true);
    assert.throws(()=>f.store.commitPiPlan(m.id,'3'.repeat(64),[],{
      action:'NEXT',summary:'Wrong answer',nextPrompt:'Continue the review',
    }),/matching, fully observed/);
    const decision=f.store.commitPiPlan(m.id,firstAnswer,[],{
      action:'NEXT',summary:'Verified original answer',nextPrompt:'Continue the review',
    });
    assert.equal(decision.responseSha256,firstAnswer);
    assert.equal(decision.round,1);
    assert.throws(()=>f.store.commitPiPlan(m.id,firstAnswer,[],{
      action:'NEXT',summary:'Duplicate PI decision',nextPrompt:'Repeat',
    }),/already exists/);
    const next=f.store.reserveChatBrowserTurn(m.id,settled.version,
      'settled-pi-checkpoint-2','4'.repeat(64));
    assert.equal(next.state,'RUNNING');
    assert.equal(next.turnCount,1);
    assert.throws(()=>f.store.reserveChatBrowserTurn(m.id,next.version,
      'settled-pi-checkpoint-1',firstPrompt));
    const events=f.store.events(m.id);
    assert.equal(events.filter(e=>e.type==='chatgpt.browser_reserved').length,2);
    assert.equal(events.filter(e=>e.type==='chatgpt.browser_observed').length,1);
    assert.equal(events.filter(e=>e.type==='pi.decision').length,1);
    assert.equal(f.store.chatBrowserTurn(m.id)?.status,'reserved');
    assert.equal(f.state().sends,0); // Isolated Store test never opens Playwriter.
    assert.ok(first.version<settled.version);
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
