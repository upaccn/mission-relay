import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Page} from 'playwriter';
import {Store} from '../src/core/store.js';
import {Engine} from '../src/core/engine.js';
import {GoalLedger} from '../src/core/goal-store.js';
import {approveBuildRepository,isApprovedBuildRepository,revokeBuildRepository,
  approvedBuildRepositories} from '../src/core/build-scopes.js';
import {TelegramBridge,type TelegramUpdate,type TelegramTransport} from '../src/plugins/telegram.js';
import type {PiPlanner} from '../src/core/pi-planner.js';
import type {AgentAdapter} from '../src/core/types.js';

const ORIGIN='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174000';
const REPO_A='/srv/projects/first-product';
const REPO_B='/srv/projects/second-product';
const browserId='install:Chrome:synthetic';
const never:AgentAdapter={
  async execute(){throw new Error('No native executor may run');},
  async verify(){throw new Error('No native verifier may run');},
};

function multiRig(){
  const dir=mkdtempSync(join(tmpdir(),'relay-multi-goal-'));
  const file=join(dir,'missions.sqlite');
  const store=new Store(file),engine=new Engine(store,never);
  store.setMeta('telegram.pi.project',REPO_A);
  store.setMeta('telegram.build.project',REPO_A);
  store.setMeta('telegram.pi.sshHost','configured-test-route');
  approveBuildRepository(store,REPO_B);
  store.setMeta('telegram.chatgpt.anchorUrl',ORIGIN);
  store.setMeta('telegram.chatgpt.browserId',browserId);
  const anchorMission=store.create({goal:'Preapproved browser launch source',
    acceptance:['Browser launches'],workspace:'',sandbox:'read-only',
    mode:'supervised',maxTurns:1,requestKey:'anchor',checks:[]});
  const linked=store.linkChat(anchorMission.id,ORIGIN,anchorMission.version).mission;
  store.bindChatBrowser(anchorMission.id,browserId,linked.version);

  let nextTab=0;
  const sessions:Array<{url:()=>string;page:Page;sentPrompts:string[]}>=[],
    sends:Array<{chat:string;prompt:string}>=[];
  function makePage(tag:number,anchor=false):Page{
    let url=anchor?ORIGIN:'about:blank',entered='',sent=0;
    const roleLocator=(selector:string)=>{
      const role=selector.includes('data-message-author-role="assistant"')?'assistant':
        selector.includes('data-message-author-role="user"')?'user':
        selector.includes('prompt-textarea')?'composer':
        selector.includes('send-button')?'send':'other';
      const loc:any={
        count:async()=>role==='other'?0:role==='send'||role==='composer'?1:
          anchor||sent>0?1:0,
        first:()=>loc,last:()=>loc,isVisible:async()=>role!=='other',
        isEnabled:async()=>Boolean(entered),
        innerText:async()=>role==='user'?(anchor?'Existing anchor user':entered):
          anchor?'Existing anchor answer':
            `Synthetic independently bounded reply: tab ${tag} turn ${sent}\n[MISSION_RELAY:NEXT]`,
        fill:async(text:string)=>{entered=text;},
        click:async()=>{
          sent++;
          if(!anchor&&sent===1)
            url=`https://chatgpt.com/c/123e4567-e89b-42d3-a456-42661417${String(tag).padStart(4,'0')}`;
          sends.push({chat:url,prompt:entered});
        },
      };
      return loc;
    };
    const page:any={
      url:()=>url,isClosed:()=>false,
      goto:async(next:string)=>{url=next;},
      waitForLoadState:async()=>{},
      getByRole:()=>({count:async()=>0,first:()=>({isVisible:async()=>false})}),
      locator:roleLocator,
      context:()=>({newPage:async()=>{
        const tab=makePage(++nextTab);
        sessions.push({url:()=>tab.url(),page:tab,sentPrompts:[]});
        return tab;
      }}),
    };
    return page as Page;
  }
  const anchor=makePage(0,true);
  const planner:PiPlanner={
    decide:async()=>{throw new Error('Goal must not use legacy PI decision');},
    proposeGoalPlan:async()=>({
      summary:'One bounded implementation package',
      items:[{key:'implementation',title:'Implement and verify isolated repository',
        description:'Use only the individually approved repository',priority:90,
        dependsOn:[],acceptance:['Check exact repository evidence']}],
    }),
    reviewGoalWork:async()=>({
      verdict:'BLOCKED',summary:'Independent release evidence is not available in fixture',
      nextPrompt:'',handoff:false,evidenceRefs:['synthetic:no-real-release'],
      blocker:{kind:'external_dependency',evidence:'Fixture has no real GitHub release',
        releaseCondition:'Independent real-world verification required'},
    }),
  };
  let updates:TelegramUpdate[]=[],replies:string[]=[];
  const transport:TelegramTransport={
    getUpdates:async offset=>updates.filter(u=>u.update_id>=offset),
    sendMessage:async(_id,message)=>{replies.push(message);},
  };
  const connect=async(url:string,options?:{browserId?:string;bootstrapMissingAnchor?:boolean})=>{
      assert.equal(options?.browserId,browserId);
      const page=url===ORIGIN?anchor:sessions.find(x=>x.url()===url)?.page;
      if(!page)throw new Error('Unknown independently bound ChatGPT tab');
      return {page,close:async()=>{}};
    };
  const newController=()=>new TelegramBridge(store,new Engine(store,never),transport,1001,2001,
    async()=>{throw new Error('No native executor');},connect,planner);
  const bridge=newController();
  const message=(id:number,value:string):TelegramUpdate=>({
    update_id:id,message:{text:value,from:{id:1001},chat:{id:2001,type:'private'}},
  });
  const idle=async()=>{
    const start=Date.now();
    while((bridge as unknown as {activeTask:Promise<void>|null}).activeTask){
      if(Date.now()-start>16000)throw new Error('Synthetic browser checkpoint did not settle');
      await new Promise(resolve=>setTimeout(resolve,30));
    }
  };
  return {store,file,engine,bridge,newController,replies,sends,sessions,message,idle,
    setUpdates:(items:TelegramUpdate[])=>{updates=items;},
    close:()=>{store.close();rmSync(dir,{recursive:true,force:true});}};
}

test('two durable write Goals rotate A→B→A→B on one Worker with separate repos and Chat URLs',async()=>{
  const r=multiRig();
  try{
    r.setUpdates([r.message(701,`/goal-build Goal A: add source checks`)]);
    await r.bridge.pollOnce(0);
    assert.ok((r.bridge as unknown as {activeTask:Promise<void>|null}).activeTask);
    r.setUpdates([r.message(702,`/goal-build --repo ${REPO_B} Goal B: repair second product`)]);
    await r.bridge.pollOnce(0);
    const ledger=new GoalLedger(r.store),goals=ledger.listGoals();
    assert.equal(goals.length,2);
    const a=r.engine.list().find(m=>m.goal.startsWith('Goal A:'))!;
    const b=r.engine.list().find(m=>m.goal.startsWith('Goal B:'))!;
    assert.notEqual(a.id,b.id);
    assert.equal(a.workspace,REPO_A);
    assert.equal(b.workspace,REPO_B);
    assert.notEqual(ledger.missionGoalId(a.id),ledger.missionGoalId(b.id));
    assert.equal(b.state,'READY');
    assert.equal(r.store.chatBrowserTurn(b.id),null,'B has no browser Send while A is active');
    assert.ok(r.replies.some(msg=>msg.includes('Task queued')));
    await r.idle();
    assert.equal(r.store.get(a.id).turnCount,1);
    assert.equal(r.store.piPlan(a.id)?.action,'NEXT');
    assert.equal(r.store.get(b.id).turnCount,0);
    const restart=r.newController();
    const switchOnce=async()=>{
      await (restart as unknown as {recoverObservedPiCheckpoint:()=>Promise<void>})
        .recoverObservedPiCheckpoint();
      const start=Date.now();
      while((restart as unknown as {activeTask:Promise<void>|null}).activeTask){
        if(Date.now()-start>16000)throw new Error('Restarted single worker did not settle');
        await new Promise(resolve=>setTimeout(resolve,30));
      }
    };
    const freshReadOnly=new Store(r.file,{readOnly:true});
    try{
      assert.equal(freshReadOnly.get(a.id).turnCount,1);
      assert.equal(freshReadOnly.get(b.id).turnCount,0);
      assert.equal(freshReadOnly.getMeta('pi.scheduler.lastMission'),a.id);
    }finally{freshReadOnly.close();}
    await switchOnce();
    assert.equal(r.store.get(b.id).turnCount,1);
    await switchOnce();
    assert.equal(r.store.get(a.id).turnCount,2);
    await switchOnce();
    assert.equal(r.store.get(b.id).turnCount,2);
    assert.equal(r.sends.length,4);
    const [a1,b1,a2,b2]=r.sends;
    assert.equal(a1?.chat,a2?.chat);
    assert.equal(b1?.chat,b2?.chat);
    assert.notEqual(a1?.chat,b1?.chat);
    assert.match(a1!.prompt,new RegExp(REPO_A));
    assert.match(b1!.prompt,new RegExp(REPO_B));
    assert.match(a2!.prompt,new RegExp(REPO_A));
    assert.match(b2!.prompt,new RegExp(REPO_B));
    assert.equal(r.store.chatLink(a.id),a1?.chat);
    assert.equal(r.store.chatLink(b.id),b1?.chat);
    assert.equal(r.store.piPlan(a.id)?.action,'BLOCKED');
    assert.equal(r.store.piPlan(b.id)?.action,'BLOCKED');
    assert.equal(r.store.events(a.id).filter(e=>e.type==='chatgpt.browser_reserved').length,2);
    assert.equal(r.store.events(b.id).filter(e=>e.type==='chatgpt.browser_reserved').length,2);
    r.setUpdates([r.message(703,'/list'),r.message(704,'/goals'),r.message(705,'/status 1')]);
    await r.bridge.pollOnce(0);
    assert.ok(r.replies.some(msg=>msg.includes('Goal A:')&&msg.includes('Goal B:')));
    assert.ok(r.replies.some(msg=>msg.includes('Goals:')));
  }finally{await r.idle();r.close();}
});

test('per-repository authorization survives a SQLite reopen and explicit revocation rejects new Sends',()=>{
  const r=multiRig();
  try{
    assert.deepEqual(approvedBuildRepositories(r.store),[REPO_A,REPO_B]);
    const reopened=new Store(r.file,{readOnly:true});
    try{
      assert.equal(isApprovedBuildRepository(reopened,REPO_B),true);
    }finally{reopened.close();}
    revokeBuildRepository(r.store,REPO_B);
    assert.equal(isApprovedBuildRepository(r.store,REPO_B),false);
    assert.equal(isApprovedBuildRepository(r.store,REPO_A),true);
    assert.deepEqual(approvedBuildRepositories(r.store),[REPO_A]);
    const m=r.store.create({goal:'Write only to second product',acceptance:['Protected write'],
      workspace:REPO_B,sandbox:'workspace-write',mode:'supervised',
      maxTurns:2,requestKey:'revocation-check',checks:[]});
    const linked=r.store.linkChat(m.id,ORIGIN,m.version).mission;
    const bound=r.store.bindChatBrowser(m.id,browserId,linked.version).mission;
    r.store.setMeta(`pi.autopilot.enabled.${m.id}`,'1');
    assert.throws(()=>r.store.reserveChatBrowserTurn(m.id,bound.version,
      'revoked-write','a'.repeat(64)),/Approved PI build workspace/);
    assert.equal(r.store.chatBrowserTurn(m.id),null);
    assert.throws(()=>approveBuildRepository(r.store,'/srv/projects/../escape'),/safe absolute path/);
  }finally{r.close();}
});

test('duplicate Goal intake cannot relink the original conversation or mutate repository permissions',()=>{
  const r=multiRig();
  try{
    const api=r.bridge as unknown as {enqueueGoal:(task:string,key:string,write:boolean)=>string};
    const task=`--repo ${REPO_B} A uniquely authorized second repository Goal`;
    api.enqueueGoal(task,'duplicate-500',true);
    const m=r.engine.list().find(x=>x.requestKey==='telegram-goal-duplicate-500')!;
    const destination='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174555';
    r.store.linkChat(m.id,destination,m.version);
    const unchanged=r.store.get(m.id),binding=r.store.chatLink(m.id);
    api.enqueueGoal(task,'duplicate-500',true);
    assert.deepEqual(r.store.get(m.id),unchanged);
    assert.equal(r.store.chatLink(m.id),binding);
    assert.equal(new GoalLedger(r.store).listGoals().length,1);
    assert.throws(()=>api.enqueueGoal(`--repo ${REPO_A} Different Goal`,
      'duplicate-500',true),/idempotency key/);
  }finally{r.close();}
});

test('owner pause survives SQLite restart and only explicit checkpoint resume clears it',()=>{
  const r=multiRig();
  try{
    const m=r.store.create({goal:'Pause this queued owner Goal',
      acceptance:['Resume only when owner requests'],workspace:REPO_A,
      sandbox:'workspace-write',mode:'supervised',maxTurns:0,
      requestKey:'pause-restart-owner',checks:[]});
    r.store.setMeta(`pi.autopilot.enabled.${m.id}`,'1');
    r.store.pausePiChain(m.id);
    assert.equal(r.store.get(m.id).stopRequested,true);
    const reopened=new Store(r.file,{readOnly:true});
    try{
      assert.equal(reopened.get(m.id).stopRequested,true);
      assert.equal(reopened.get(m.id).state,'PAUSED');
    }finally{reopened.close();}
    const resumed=r.store.resumePiChain(m.id);
    assert.equal(resumed.stopRequested,false);
    assert.equal(resumed.state,'READY');
    assert.equal(r.store.chatBrowserTurn(m.id),null);
    assert.throws(()=>r.store.resumePiChain(m.id),/owner-paused/);
  }finally{r.close();}
});
