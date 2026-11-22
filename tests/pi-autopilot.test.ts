import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import type {Page} from 'playwriter';
import {Store} from '../src/core/store.js';
import {GoalLedger} from '../src/core/goal-store.js';
import {drivePiAutopilot,pauseFailedPiPlanning} from '../src/core/pi-autopilot.js';
import {SshPiPlanner,type PiPlanner,type PiTurnContext} from '../src/core/pi-planner.js';

const SOURCE='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174000';
const DEST='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174001';
const DEST2='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174002';
const CHROME_SOURCE_TARGET_ID='1234567890ABCDEF1234567890ABCDEF';

function fixture(ownerLinkedUrl=SOURCE) {
  const dir=mkdtempSync(join(tmpdir(),'relay-pi-autopilot-'));
  const store=new Store(join(dir,'db.sqlite'));
  const created=store.create({goal:'Audit NetBox IP lookup',
    acceptance:['Explain source and evidence gaps'],workspace:'',
    sandbox:'read-only',mode:'supervised',checks:[],requestKey:'pi-fake'});
  const linked=store.linkChat(created.id,ownerLinkedUrl,created.version).mission;
  const mission=store.bindChatBrowser(linked.id,'install:Chrome:fake',linked.version).mission;
  let currentUrl='about:blank',sends=0,newPages=0,latestPrompt='',baseTurns=0;
  const fresh={
    url:()=>currentUrl,isClosed:()=>false,
    context:()=>({newPage:async()=>{newPages++;return fresh;}}),
    goto:async(url:string)=>{currentUrl=url;},
    waitForLoadState:async()=>{},
    getByRole:()=>({count:async()=>0,first:()=>({isVisible:async()=>false})}),
    locator:(selector:string)=>{
      let role='other';
      if(selector.includes('data-message-author-role="assistant"'))role='assistant';
      if(selector.includes('data-message-author-role="user"'))role='user';
      if(selector.includes('prompt-textarea'))role='composer';
      if(selector.includes('send-button'))role='send';
      const obj:any={
        // A genuinely blank new-chat origin has no user/assistant turns,
        // even when this synthetic object also represents a prior Chat.
        count:async()=>['composer','send'].includes(role)?1:
          currentUrl==='https://chatgpt.com/'?0:baseTurns+sends>0?1:0,
        first:()=>obj,last:()=>obj,isVisible:async()=>role!=='other',
        isEnabled:async()=>Boolean(latestPrompt),
        innerText:async()=>role==='user'?latestPrompt:
          baseTurns+sends===1?'First NetBox research answer\n[MISSION_RELAY:DONE]':
            `NetBox research with VRF evidence, observed round ${baseTurns+sends}\n[MISSION_RELAY:DONE]`,
        fill:async(value:string)=>{latestPrompt=value;},
        click:async()=>{sends++;currentUrl=newPages>1?DEST2:DEST;},
      };
      return obj;
    },
  } as unknown as Page;
  let anchorClosed=false;
  const anchor={
    url:()=>SOURCE,isClosed:()=>anchorClosed,
    close:async()=>{anchorClosed=true;},
    context:()=>({
      newPage:async()=>{newPages++;return fresh;},
      newCDPSession:async()=>({
        send:async()=>({targetInfo:{targetId:CHROME_SOURCE_TARGET_ID}}),
        detach:async()=>{},
      }),
    }),
    getByRole:()=>({count:async()=>0,first:()=>({isVisible:async()=>false})}),
    locator:(selector:string)=>{
      const role=selector.includes('prompt-textarea')?'composer':
        selector.includes('data-message-author-role="assistant"')?'assistant':
          selector.includes('data-message-author-role="user"')?'user':'other';
      const obj:any={
        count:async()=>role==='other'?0:1,
        first:()=>obj,last:()=>obj,isVisible:async()=>role!=='other',
        innerText:async()=>role==='assistant'?'Prior anchor response':'Prior anchor user turn',
      };
      return obj;
    },
  } as unknown as Page;
  return {dir,store,mission,anchor,fresh,anchorClosed:()=>anchorClosed,
    primeRecovered:()=>{currentUrl=DEST;baseTurns=1;latestPrompt='Previously submitted user prompt';},
    modifyVisibleUser:(value:string)=>{latestPrompt=value;},
    results:()=>({sends,newPages,latestPrompt}),
    cleanup:()=>{store.close();rmSync(dir,{recursive:true,force:true});}};
}

test('opt-in Goal PI uses the real existing browser controller and does not trust the browser DONE marker',async()=>{
  const f=fixture();
  try{
    const ledger=new GoalLedger(f.store);
    const goal=ledger.createGoal({requestKey:'pi-goal-browser-integration',
      objective:f.mission.goal,priority:90});
    f.store.setMeta(`pi.autopilot.enabled.${f.mission.id}`,'1');
    ledger.bindPiMission(goal.id,f.mission.id,f.mission.version,'bind-goal-controller');
    let planCalls=0,reviewCalls=0;
    let initialPlanningPrompt='';
    const pi:PiPlanner={
      decide:async()=>{throw new Error('Goal-bound Mission may not use the legacy fallback');},
      proposeGoalPlan:async()=>{
        planCalls++;
        initialPlanningPrompt=f.results().latestPrompt;
        return {summary:'Execute scoped NetBox check',items:[
          {key:'netbox',title:'Verify NetBox lookup',description:'Check VRF ambiguity',
            priority:90,dependsOn:[],acceptance:['Evidence supports VRF lookup']},
        ]};
      },
      reviewGoalWork:async x=>{
        reviewCalls++;
        assert.equal(x.workItem.key,'netbox');
        return {verdict:'PASS',summary:'PI reviewed the browser answer',
          nextPrompt:'',handoff:false,evidenceRefs:['claimed:test:netbox']};
      },
    };
    await drivePiAutopilot({store:f.store,planner:pi,missionId:f.mission.id,
      revision:f.mission.version,requestPrefix:'goal-controller',page:f.anchor,url:SOURCE});
    assert.equal(planCalls,1);
    assert.equal(reviewCalls,1);
    assert.match(initialPlanningPrompt,/INITIAL READ-ONLY DISCOVERY/);
    assert.match(initialPlanningPrompt,/Owner objective for analysis/);
    assert.match(initialPlanningPrompt,/Task scope: read-only/);
    assert.match(initialPlanningPrompt,/do not edit code or files/);
    assert.match(initialPlanningPrompt,/PI controller will independently approve/);
    assert.ok(!initialPlanningPrompt.includes('Task scope: implement and test code'));
    assert.ok(!initialPlanningPrompt.includes('Use available tools to inspect and edit'));
    assert.equal(f.results().sends,2,
      'The first browser DONE marker must not end the Goal; PI passing the final package does');
    assert.equal(f.store.get(f.mission.id).turnCount,2);
    assert.equal(f.store.piPlan(f.mission.id)?.action,'DONE');
    assert.equal(ledger.graph(goal.id).items[0]?.status,'PASSED');
    assert.equal(ledger.getGoal(goal.id).status,'DONE');
    assert.equal(f.store.events(f.mission.id).filter(e=>e.type==='chatgpt.browser_reserved').length,2);
    const sent=f.results().latestPrompt;
    assert.match(sent,/Work package: netbox — Verify NetBox lookup/);
    assert.match(sent,/Evidence supports VRF lookup/);
    for(const legacyOnly of ['Task goal: Audit NetBox IP lookup','Progress checkpoint',
      'PI reviewed the browser answer','Observed browser turn:','32 turns',
      'Previous ChatGPT answer evidence excerpt'])
      assert.ok(!sent.includes(legacyOnly),`Goal browser prompt leaked: ${legacyOnly}`);
    assert.equal(f.store.reservedBrowserPrompt(f.mission.id,'goal-controller-2')?.prompt,sent,
      'Actual browser Send must use the exact snapshot committed with its reservation');
  }finally{f.cleanup();}
});

test('Goal-bound eight-to-nine browser rollover sends only the current work package in a fresh Chat',async()=>{
  const f=fixture();
  try{
    const created=f.store.create({goal:'Owner long-term five-chat goal, never repeat this to executor',
      acceptance:['Final independent business delivery'],workspace:'',
      sandbox:'read-only',mode:'supervised',checks:[],requestKey:'goal-six'});
    const linked=f.store.linkChat(created.id,SOURCE,created.version).mission;
    const bound=f.store.bindChatBrowser(created.id,'install:Chrome:fake',linked.version).mission;
    f.store.setMeta(`pi.autopilot.enabled.${created.id}`,'1');
    const ledger=new GoalLedger(f.store);
    const goal=ledger.createGoal({requestKey:'goal-five-to-six',objective:created.goal,priority:100});
    ledger.bindPiMission(goal.id,created.id,bound.version,'bind-goal-five');
    const plan=ledger.createPlan(goal.id,1,{requestKey:'goal-five-plan',summary:'PI planning only',
      items:[{key:'specific-task',title:'Validate device search',description:'Handle VRF ambiguity',
        priority:100,dependsOn:[],acceptance:['Check concrete VRF evidence']}]});
    ledger.setPlanStatus(goal.id,plan.id,1,'APPROVED','approved-goal-five');
    ledger.setGoalStatus(goal.id,ledger.getGoal(goal.id).version,'ACTIVE','activate-goal-five');
    const first=ledger.graph(goal.id).items[0]!;
    const ready=ledger.setWorkStatus(goal.id,first.id,first.version,'READY',[],'ready-goal-five');
    ledger.setWorkStatus(goal.id,first.id,ready.version,'IN_PROGRESS',[],'start-goal-five');
    const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
    for(let n=1;n<=8;n++){
      f.store.reserveChatBrowserTurn(created.id,f.store.get(created.id).version,
        `simulated-verified-${n}`,sha('Prior anchor user turn'));
      f.store.finishChatBrowserTurn(created.id,`simulated-verified-${n}`,{
        kind:'observed',assistantSha256:sha('Prior anchor response'),
        summary:'Prior anchor response',
        telegramBatch:{terminal:true,flowSignal:'NEXT',piManaged:true}});
      f.store.commitPiPlan(created.id,sha('Prior anchor response'),[],{
        action:'NEXT',summary:'PI still validating the active work',
        nextPrompt:'Validate the specific device-search work package'});
    }
    assert.equal(f.store.piChatObservedTurns(created.id),8);
    let reviews=0;
    const planner:PiPlanner={
      decide:async()=>{throw new Error('Goal PI must not use legacy planning');},
      reviewGoalWork:async()=>{reviews++;return {verdict:'PASS',
        summary:'Claimed device-search evidence',nextPrompt:'',handoff:false,
        evidenceRefs:['test:device-search']};},
    };
    await drivePiAutopilot({store:f.store,planner,missionId:created.id,
      revision:f.store.get(created.id).version,requestPrefix:'goal-five',page:f.anchor,url:SOURCE});
    assert.equal(f.results().sends,1,'Only the ninth Send is real in this fixture');
    assert.equal(f.results().newPages,1);
    assert.equal(reviews,1);
    const snapshot=f.store.reservedBrowserPrompt(created.id,'goal-five-9');
    assert.equal(snapshot?.format,'goal-work-v1');
    assert.equal(snapshot?.prompt,f.results().latestPrompt);
    assert.match(snapshot!.prompt,/Start this work package in a new conversation/);
    assert.match(snapshot!.prompt,/Check concrete VRF evidence/);
    assert.ok(!snapshot!.prompt.includes(created.goal));
    assert.ok(!snapshot!.prompt.includes('PI still validating'));
    assert.equal(f.store.get(created.id).turnCount,9);
    assert.equal(f.store.events(created.id)
      .filter(e=>e.type==='chatgpt.browser_reserved').length,9);
    assert.equal(f.store.piPlan(created.id)?.action,'DONE',
      'PI PASS of the final package completes the Goal');
  }finally{f.cleanup();}
});

test('PI decision transaction never consumes owner instructions on stale SHA or queue mismatch',()=>{
  const f=fixture();try{
    const m=f.store.reserveChatBrowserTurn(f.mission.id,f.mission.version,'pi-rollback-1',
      'b'.repeat(64));
    f.store.finishChatBrowserTurn(m.id,'pi-rollback-1',{kind:'observed',
      assistantSha256:'a'.repeat(64),summary:'A completed read-only browser reply',
      telegramBatch:{terminal:false,flowSignal:'DONE',piManaged:true}});
    f.store.queuePiOwnerDirective(m.id,'108','Please check VRF before finishing');
    const done={action:'DONE' as const,summary:'Answer reviewed',nextPrompt:''};
    assert.throws(()=>f.store.commitPiPlan(m.id,'b'.repeat(64),[1],done),/fully observed/);
    assert.throws(()=>f.store.commitPiPlan(m.id,'a'.repeat(64),[],done),/instructions changed/);
    assert.equal(f.store.pendingPiOwnerDirectives(m.id).length,1);
    assert.equal(f.store.events(m.id).filter(e=>e.type==='pi.decision').length,0);
    const ids=f.store.pendingPiOwnerDirectives(m.id).map(x=>x.id);
    f.store.commitPiPlan(m.id,'a'.repeat(64),ids,done);
    assert.equal(f.store.pendingPiOwnerDirectives(m.id).length,0);
    assert.equal(f.store.events(m.id).filter(e=>e.type==='pi.decision').length,1);
  }finally{f.cleanup();}
});

test('PI may revise a NEXT decision when a new Telegram instruction arrives after checkpoint, without duplicating a browser turn',()=>{
  const f=fixture();try{
    const m=f.store.reserveChatBrowserTurn(f.mission.id,f.mission.version,
      'pi-replan-1','b'.repeat(64));
    f.store.finishChatBrowserTurn(m.id,'pi-replan-1',{kind:'observed',
      assistantSha256:'a'.repeat(64),summary:'First browser reply',
      telegramBatch:{terminal:false,flowSignal:'DONE',piManaged:true}});
    f.store.commitPiPlan(m.id,'a'.repeat(64),[],{
      action:'NEXT',summary:'Check interface',nextPrompt:'Inspect interface',
    });
    f.store.queuePiOwnerDirective(m.id,'119','Please stop after this review for manual testing');
    const ids=f.store.pendingPiOwnerDirectives(m.id).map(x=>x.id);
    const final=f.store.commitPiPlan(m.id,'a'.repeat(64),ids,{
      action:'BLOCKED',summary:'Owner will test Android manually',nextPrompt:'',
    },true);
    assert.equal(final.action,'BLOCKED');
    assert.equal(f.store.pendingPiOwnerDirectives(m.id).length,0);
    assert.equal(f.store.events(m.id).filter(e=>e.type==='pi.decision_revised').length,1);
    assert.equal(f.store.events(m.id).filter(e=>e.type==='pi.autopilot_finished').length,1);
    assert.equal(f.store.events(m.id).filter(e=>e.type==='chatgpt.browser_reserved').length,1);
  }finally{f.cleanup();}
});


function bindGoal(f:ReturnType<typeof fixture>,key:string){
  const ledger=new GoalLedger(f.store);
  const goal=ledger.createGoal({requestKey:key,objective:f.mission.goal,priority:90});
  f.store.setMeta(`pi.autopilot.enabled.${f.mission.id}`,'1');
  ledger.bindPiMission(goal.id,f.mission.id,f.mission.version,`bind-${key}`);
  return {ledger,goal,revision:f.store.get(f.mission.id).version};
}
const onePackage={summary:'Execute scoped NetBox check',items:[
  {key:'netbox',title:'Verify NetBox lookup',description:'Check VRF ambiguity',
    priority:90,dependsOn:[],acceptance:['Evidence supports VRF lookup']}]};
const noLegacy=async():Promise<never>=>{throw new Error('Goal-bound Mission may not use the legacy fallback');};

test('Goal PI inference inherits the configured default model without override',async()=>{
  const f=fixture();try{
    const {revision}=bindGoal(f,'default-model');
    const planner=new SshPiPlanner({sshHost:'operator',project:'/srv/projects/mission-relay'});
    planner.proposeGoalPlan=async()=>onePackage;
    planner.reviewGoalWork=async()=>({verdict:'PASS',summary:'Verified',nextPrompt:'',
      handoff:false,evidenceRefs:['claimed:test:netbox']});
    await drivePiAutopilot({store:f.store,planner,missionId:f.mission.id,revision,
      requestPrefix:'configured-default',page:f.anchor,url:SOURCE});
    const intent=f.store.events(f.mission.id).filter(e=>e.type==='pi.default_model_invocation_intent');
    assert.ok(intent.length>=1);
    for(const e of intent){
      const p=e.payload as Record<string,unknown>;
      assert.deepEqual([p.modelOverride,p.providerOverride,p.thinkingOverride],[false,false,false]);
      assert.ok(!JSON.stringify(p).includes('First NetBox research answer'));
    }
  }finally{f.cleanup();}
});

test('Goal PI BLOCKED with an external blocker stops without another browser Send',async()=>{
  const f=fixture();try{
    const {revision,ledger,goal}=bindGoal(f,'blocked');
    const planner:PiPlanner={decide:noLegacy,proposeGoalPlan:async()=>onePackage,
      reviewGoalWork:async()=>({verdict:'BLOCKED',summary:'Owner must run the physical Android test',
        nextPrompt:'',handoff:false,evidenceRefs:['claimed:test:android'],
        blocker:{kind:'external_permission',evidence:'Needs a physical device in the owner\'s hand',
          releaseCondition:'Owner reports the Android test result'}})};
    await drivePiAutopilot({store:f.store,planner,missionId:f.mission.id,revision,
      requestPrefix:'pi-human',page:f.anchor,url:SOURCE});
    assert.equal(f.results().sends,2,'planning Send plus one work Send, nothing after BLOCKED');
    assert.notEqual(ledger.getGoal(goal.id).status,'DONE');
    const finish=f.store.events(f.mission.id).find(x=>x.type==='pi.autopilot_finished');
    assert.equal((finish?.payload as {action?:string}).action,'BLOCKED');
  }finally{f.cleanup();}
});

test('Goal PI failure after a real observed answer fails closed without a second Send',async()=>{
  const f=fixture();try{
    const {revision}=bindGoal(f,'pi-error');
    const planner:PiPlanner={decide:noLegacy,
      proposeGoalPlan:async()=>{throw new Error('PI unreachable');},
      reviewGoalWork:noLegacy};
    await assert.rejects(drivePiAutopilot({store:f.store,planner,missionId:f.mission.id,revision,
      requestPrefix:'pi-error',page:f.anchor,url:SOURCE}),/PI unreachable/);
    pauseFailedPiPlanning(f.store,f.mission.id,'PI unreachable');
    assert.equal(f.results().sends,1);
    assert.equal(f.store.get(f.mission.id).state,'PAUSED');
    assert.equal(f.store.events(f.mission.id).filter(x=>x.type==='pi.autopilot_interrupted').length,1);
    assert.equal(f.store.events(f.mission.id).filter(x=>x.type==='pi.autopilot_finished').length,0);
  }finally{f.cleanup();}
});

test('Goal PI refuses to send into a ChatGPT conversation changed while PI was planning',async()=>{
  const f=fixture();try{
    const {revision}=bindGoal(f,'pi-human-changed');
    const planner:PiPlanner={decide:noLegacy,reviewGoalWork:noLegacy,
      proposeGoalPlan:async()=>{
        f.modifyVisibleUser('A human typed a different user turn during PI planning');
        return onePackage;
      }};
    await assert.rejects(drivePiAutopilot({store:f.store,planner,missionId:f.mission.id,revision,
      requestPrefix:'pi-human-changed',page:f.anchor,url:SOURCE}),/visible ChatGPT history differs|history changed/);
    assert.equal(f.results().sends,1);
    assert.equal(f.store.get(f.mission.id).turnCount,1);
    assert.equal(f.store.events(f.mission.id).filter(e=>e.type==='chatgpt.browser_reserved').length,1);
  }finally{f.cleanup();}
});
