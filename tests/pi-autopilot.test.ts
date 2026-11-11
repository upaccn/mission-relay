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
import {browserFreshTaskPrompt,browserNewChatPrompt,browserRolloverRecoveryPrompt,
  browserRolloverPiPlan} from '../src/core/browser-controller.js';
import {SshPiPlanner,type PiPlanner,type PiTurnContext} from '../src/core/pi-planner.js';

const SOURCE='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174000';
const DEST='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174001';
const DEST2='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174002';
const CHROME_SOURCE_TARGET_ID='1234567890ABCDEF1234567890ABCDEF';

test('initial and new-chat PI prompts admit all four completion/continuation markers',()=>{
  const first=browserFreshTaskPrompt('Perform a three-stage, read-only audit');
  const next=browserNewChatPrompt('Complete audit',['Check all stages'],'Prior evidence','Inspect next stage');
  for(const prompt of [first,next]) {
    for(const marker of ['NEXT','HANDOFF','DONE','BLOCKED'])
      assert.ok(prompt.includes(`[MISSION_RELAY:${marker}]`));
    assert.match(prompt,/read-only|without specific authorization/);
  }
});

function fixture(ownerLinkedUrl=SOURCE) {
  const dir=mkdtempSync(join(tmpdir(),'relay-pi-autopilot-'));
  const store=new Store(join(dir,'db.sqlite'));
  const created=store.create({goal:'Audit NetBox IP lookup',
    acceptance:['Explain source and evidence gaps'],workspace:'',
    sandbox:'read-only',mode:'supervised',maxTurns:3,checks:[],requestKey:'pi-fake'});
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

test('actual PI controller path persists default-model inference intent without model/provider/effort override',async()=>{
  const f=fixture();try{
    const planner=new SshPiPlanner({sshHost:'operator',
      project:'/srv/projects/mission-relay'});
    // Replace only the tool-free inference method in this offline fixture;
    // the controller must still recognize the real operator-managed host planner boundary.
    planner.decide=async()=>({action:'DONE',summary:'Synthetic PI acceptance',nextPrompt:''});
    await drivePiAutopilot({store:f.store,planner,missionId:f.mission.id,
      revision:f.mission.version,requestPrefix:'configured-default',
      page:f.anchor,url:SOURCE});
    const events=f.store.events(f.mission.id);
    const intent=events.filter(e=>e.type==='pi.default_model_invocation_intent');
    assert.equal(intent.length,1);
    const payload=intent[0]?.payload as Record<string,unknown>;
    assert.deepEqual([payload.modelOverride,payload.providerOverride,payload.thinkingOverride],
      [false,false,false]);
    assert.equal(payload.status,'intent_not_remote_result');
    assert.equal(payload.round,1);
    assert.match(String(payload.argvSha256),/^[a-f0-9]{64}$/);
    assert.equal(events.filter(e=>e.type==='chatgpt.browser_reserved').length,1);
    assert.equal(events.filter(e=>e.type==='chatgpt.browser_observed').length,1);
    assert.equal(events.filter(e=>e.type==='pi.decision').length,1);
    assert.ok(!JSON.stringify(intent).includes('First NetBox research answer'));
    assert.ok(!JSON.stringify(intent).includes('mission-relay'));
  }finally{f.cleanup();}
});

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
      'The first browser DONE must not end the Goal; no third Send after pending independent acceptance');
    assert.equal(f.store.get(f.mission.id).turnCount,2);
    assert.equal(f.store.piPlan(f.mission.id)?.action,'BLOCKED');
    assert.equal(ledger.graph(goal.id).items[0]?.status,'PASSED');
    assert.equal(ledger.getGoal(goal.id).status,'ACTIVE');
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

test('Goal-bound five-to-six browser rollover sends only the current work package in a fresh Chat',async()=>{
  const f=fixture();
  try{
    const created=f.store.create({goal:'Owner long-term five-chat goal, never repeat this to executor',
      acceptance:['Final independent business delivery'],workspace:'',
      sandbox:'read-only',mode:'supervised',maxTurns:6,checks:[],requestKey:'goal-six'});
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
    for(let n=1;n<=5;n++){
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
    assert.equal(f.store.piChatObservedTurns(created.id),5);
    let reviews=0;
    const planner:PiPlanner={
      decide:async()=>{throw new Error('Goal PI must not use legacy planning');},
      reviewGoalWork:async()=>{reviews++;return {verdict:'PASS',
        summary:'Claimed device-search evidence',nextPrompt:'',handoff:false,
        evidenceRefs:['test:device-search']};},
    };
    await drivePiAutopilot({store:f.store,planner,missionId:created.id,
      revision:f.store.get(created.id).version,requestPrefix:'goal-five',page:f.anchor,url:SOURCE});
    assert.equal(f.results().sends,1,'Only the sixth Send is real in this fixture');
    assert.equal(f.results().newPages,1);
    assert.equal(reviews,1);
    const snapshot=f.store.reservedBrowserPrompt(created.id,'goal-five-6');
    assert.equal(snapshot?.format,'goal-work-v1');
    assert.equal(snapshot?.prompt,f.results().latestPrompt);
    assert.match(snapshot!.prompt,/Start this work package in a new conversation/);
    assert.match(snapshot!.prompt,/Check concrete VRF evidence/);
    assert.ok(!snapshot!.prompt.includes(created.goal));
    assert.ok(!snapshot!.prompt.includes('PI still validating'));
    assert.equal(f.store.get(created.id).turnCount,6);
    assert.equal(f.store.events(created.id)
      .filter(e=>e.type==='chatgpt.browser_reserved').length,6);
    assert.equal(f.store.piPlan(created.id)?.action,'BLOCKED',
      'PI claimed PASS is not final owner Goal DONE');
  }finally{f.cleanup();}
});

test('Goal-bound 32-to-successor first Send inherits active work, not the full owner Goal',async()=>{
  const f=fixture();
  try{
    const created=f.store.create({goal:'Owner long-term multi-Mission goal, coordinator-only details',
      acceptance:['Independently verify release readiness'],workspace:'',
      sandbox:'read-only',mode:'supervised',maxTurns:32,checks:[],requestKey:'goal-chain-root'});
    const linked=f.store.linkChat(created.id,SOURCE,created.version).mission;
    const bound=f.store.bindChatBrowser(created.id,'install:Chrome:fake',linked.version).mission;
    f.store.setMeta(`pi.autopilot.enabled.${created.id}`,'1');
    const ledger=new GoalLedger(f.store);
    const goal=ledger.createGoal({requestKey:'goal-chain-key',objective:created.goal,priority:100});
    ledger.bindPiMission(goal.id,created.id,bound.version,'bind-goal-chain');
    const plan=ledger.createPlan(goal.id,1,{requestKey:'goal-chain-plan',
      summary:'Internal coordinator milestones',items:[{
        key:'chain-package',title:'Check device reservation logic',
        description:'Run bounded device ownership checks',priority:100,dependsOn:[],
        acceptance:['Validate distinct browser request identity'],
      }]});
    ledger.setPlanStatus(goal.id,plan.id,1,'APPROVED','approve-chain-plan');
    ledger.setGoalStatus(goal.id,ledger.getGoal(goal.id).version,'ACTIVE','activate-chain');
    const item=ledger.graph(goal.id).items[0]!;
    const ready=ledger.setWorkStatus(goal.id,item.id,item.version,'READY',[],'ready-chain');
    ledger.setWorkStatus(goal.id,item.id,ready.version,'IN_PROGRESS',[],'start-chain');
    const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
    const nearLimit=f.store.update(created.id,bound.version,{state:'PAUSED',turnCount:31},
      'test.simulated_prior_rounds');
    f.store.reserveChatBrowserTurn(created.id,nearLimit.version,'goal-chain-32',
      sha('Prior anchor user turn'));
    f.store.finishChatBrowserTurn(created.id,'goal-chain-32',{
      kind:'observed',assistantSha256:sha('Prior anchor response'),summary:'Prior anchor response',
      telegramBatch:{terminal:true,flowSignal:'NEXT',piManaged:true},
    });
    f.store.commitPiPlan(created.id,sha('Prior anchor response'),[],{
      action:'NEXT',summary:'Coordinator says more development remains',
      nextPrompt:'Perform the current device reservation verification',
    });
    const child=f.store.createPiSuccessor(created.id)!;
    assert.equal(ledger.missionGoalId(child.id),goal.id);
    let reviews=0,allowContinuation=false;
    const planner:PiPlanner={
      decide:async()=>allowContinuation
        ?{action:'NEXT',summary:'Owner note reviewed with current work still pending',
          nextPrompt:'Proceed with scoped device reservation verification'}
        :{action:'DONE',summary:'Premature owner-level completion claim',nextPrompt:''},
      reviewGoalWork:async x=>{
        reviews++;assert.equal(x.workItem.key,'chain-package');
        return {verdict:'PASS',summary:'Work evidence has been recorded',
          nextPrompt:'',evidenceRefs:['claimed:device-check'],handoff:false};
      },
    };
    f.store.queuePiOwnerDirective(child.id,'2998',
      'Owner note asks whether the goal is complete; do not skip independent acceptance');
    await assert.rejects(drivePiAutopilot({store:f.store,planner,missionId:child.id,
      revision:child.version,requestPrefix:child.requestKey,page:f.anchor,url:SOURCE}),
    /cannot declare terminal DONE\/BLOCKED/);
    assert.equal(f.results().sends,0);
    assert.equal(f.store.chatBrowserTurn(child.id),null);
    assert.equal(f.store.pendingPiOwnerDirectives(child.id).length,1);
    allowContinuation=true;
    await drivePiAutopilot({store:f.store,planner,missionId:child.id,
      revision:child.version,requestPrefix:child.requestKey,page:f.anchor,url:SOURCE});
    assert.equal(f.results().sends,1);
    assert.equal(f.results().newPages,1);
    assert.equal(reviews,1);
    assert.equal(f.store.piChainParent(child.id),created.id);
    const recovered=f.store.reservedBrowserPrompt(child.id,`${child.requestKey}-1`);
    assert.equal(recovered?.format,'goal-work-v1');
    assert.equal(recovered?.prompt,f.results().latestPrompt);
    assert.match(recovered!.prompt,/Start this work package in a new conversation/);
    assert.match(recovered!.prompt,/Validate distinct browser request identity/);
    assert.ok(!recovered!.prompt.includes(created.goal));
    assert.ok(!recovered!.prompt.includes('Coordinator says more development remains'));
    assert.equal(f.store.piPlan(child.id)?.action,'BLOCKED');
    assert.equal(ledger.getGoal(goal.id).status,'ACTIVE');
    assert.equal(f.store.events(child.id).filter(e=>e.type==='chatgpt.browser_reserved').length,1);
    assert.equal(f.store.events(created.id).filter(e=>e.type==='chatgpt.browser_reserved').length,1,
      'The prior Mission Send must not be repeated');
  }finally{f.cleanup();}
});

test('exhausted 32-turn PI NEXT creates one durable successor and continues in a fresh chat',async()=>{
  const f=fixture();try{
    const parent=f.store.create({goal:'Complete a multi-mission source audit',
      acceptance:['Verify every outstanding requirement'],workspace:'',
      sandbox:'read-only',mode:'supervised',maxTurns:32,checks:[],requestKey:'chain-root'});
    const linked=f.store.linkChat(parent.id,SOURCE,parent.version).mission;
    const bound=f.store.bindChatBrowser(parent.id,'install:Chrome:fake',linked.version).mission;
    f.store.setMeta(`pi.autopilot.enabled.${parent.id}`,'1');
    const nearLimit=f.store.update(parent.id,bound.version,{state:'PAUSED',turnCount:31},
      'test.prior_verified_rounds');
    const originalPrompt='Prior anchor user turn', originalAnswer='Prior anchor response';
    const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
    f.store.reserveChatBrowserTurn(parent.id,nearLimit.version,'chain-original-32',sha(originalPrompt));
    f.store.finishChatBrowserTurn(parent.id,'chain-original-32',{
      kind:'observed',assistantSha256:sha(originalAnswer),summary:originalAnswer,
      telegramBatch:{terminal:true,flowSignal:'NEXT',piManaged:true},
    });
    f.store.commitPiPlan(parent.id,sha(originalAnswer),[],{
      action:'NEXT',summary:'31 checks done; final requirement remains',
      nextPrompt:'Verify final requirement and report evidence',
    });
    assert.equal(f.store.events(parent.id).find(e=>e.type==='pi.autopilot_finished')?.payload &&
      (f.store.events(parent.id).find(e=>e.type==='pi.autopilot_finished')!.payload as {action:string}).action,'LIMIT');
    const child=f.store.createPiSuccessor(parent.id);
    assert.ok(child);
    assert.equal(f.store.createPiSuccessor(parent.id)?.id,child.id);
    assert.equal(f.store.piChainParent(child.id),parent.id);
    assert.equal(f.store.piChainSuccessor(parent.id),child.id);
    assert.equal(child.turnCount,0);
    assert.equal(child.state,'READY');
    assert.equal(f.store.chatLink(child.id),SOURCE);
    assert.equal(f.store.events(parent.id).filter(e=>e.type==='pi.chain_successor').length,1);
    const planner:PiPlanner={decide:async context=>{
      assert.equal(context.turnCount,1);
      assert.match(context.lastAssistant,/First NetBox research answer/);
      return {action:'DONE',summary:'Independently checked last requirement',nextPrompt:''};
    }};
    const changedSource={...f.anchor,locator:(selector:string)=>{
      const original=f.anchor.locator(selector);
      if(!selector.includes('data-message-author-role="user"'))return original;
      const fake:any={...original,innerText:async()=> 'Another user changed the parent conversation'};
      fake.last=()=>fake;fake.first=()=>fake;
      return fake;
    }} as unknown as Page;
    await assert.rejects(drivePiAutopilot({store:f.store,planner,missionId:child.id,
      revision:child.version,requestPrefix:child.requestKey,page:changedSource,url:SOURCE}),
    /parent ChatGPT conversation changed/);
    assert.equal(f.results().sends,0);
    assert.equal(f.store.chatBrowserTurn(child.id),null);
    await drivePiAutopilot({store:f.store,planner,missionId:child.id,
      revision:child.version,requestPrefix:child.requestKey,page:f.anchor,url:SOURCE});
    assert.equal(f.results().sends,1);
    assert.equal(f.results().newPages,1);
    assert.equal(f.store.get(child.id).turnCount,1);
    assert.equal(f.store.chatLink(child.id),DEST);
    assert.equal(f.anchorClosed(),false,
      'The original human-owned ChatGPT anchor must never be retired');
    assert.equal(f.store.piPlan(child.id)?.action,'DONE');
    assert.equal(f.store.events(child.id).filter(e=>e.type==='chatgpt.browser_reserved').length,1);
    assert.equal(f.store.events(child.id).filter(e=>e.type==='pi.autopilot_finished').length,1);
    assert.equal(f.store.createPiSuccessor(child.id),null);
  }finally{f.cleanup();}
});

function readySuccessor(f:ReturnType<typeof fixture>,key:string){
  const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
  const parent=f.store.create({goal:'Finish a 32-turn mission without ignoring owner updates',
    acceptance:['Complete the remaining verification'],workspace:'',sandbox:'read-only',
    mode:'supervised',maxTurns:32,checks:[],requestKey:key});
  const linked=f.store.linkChat(parent.id,SOURCE,parent.version).mission;
  const bound=f.store.bindChatBrowser(parent.id,'install:Chrome:fake',linked.version).mission;
  f.store.setMeta(`pi.autopilot.enabled.${parent.id}`,'1');
  const near=f.store.update(parent.id,bound.version,{state:'PAUSED',turnCount:31},'test.prior_rounds');
  f.store.reserveChatBrowserTurn(parent.id,near.version,`${key}-last`,sha('Prior anchor user turn'));
  f.store.finishChatBrowserTurn(parent.id,`${key}-last`,{kind:'observed',
    assistantSha256:sha('Prior anchor response'),summary:'Prior anchor response',
    telegramBatch:{terminal:true,flowSignal:'NEXT',piManaged:true}});
  f.store.commitPiPlan(parent.id,sha('Prior anchor response'),[],{
    action:'NEXT',summary:'Parent evidence verified; more work remains',nextPrompt:'Check the final stage'});
  const child=f.store.createPiSuccessor(parent.id);
  assert.ok(child);
  return {parent,child,sha};
}

test('SQLite requires a verified continuing parent and a fresh conversation on the first successor Send',()=>{
  const f=fixture();try{
    const {parent,child,sha}=readySuccessor(f,'successor-sqlite-gate');
    const request='successor-sqlite-first';
    const before=f.store.maxEventId();
    assert.throws(()=>f.store.reserveChatBrowserTurn(child.id,child.version,request,
      sha('Unchanged chat'),{}),/first Send must open a new ChatGPT conversation/);
    assert.equal(f.store.chatBrowserTurn(child.id),null);
    assert.equal(f.store.maxEventId(),before);
    f.store.pausePiChain(parent.id);
    assert.throws(()=>f.store.reserveChatBrowserTurn(child.id,f.store.get(child.id).version,
      request,sha('New chat after pause'),{newConversation:true}),
    /pause request|approved, verified continuation checkpoint/);
    assert.equal(f.store.chatBrowserTurn(child.id),null);
    assert.equal(f.store.events(child.id).filter(e=>e.type==='chatgpt.browser_reserved').length,0);
  }finally{f.cleanup();}
});

test('PI reviews changing owner notes before the first successor Send and persists one revised prompt',async()=>{
  const f=fixture();try{
    const {child,sha}=readySuccessor(f,'preflight-update');
    f.store.queuePiOwnerDirective(child.id,'1981','Also check rollback requirements');
    assert.throws(()=>f.store.reserveChatBrowserTurn(child.id,child.version,'unsafe-early',
      sha('should not send')),/owner notes/);
    assert.equal(f.store.chatBrowserTurn(child.id),null);
    let calls=0;
    const planner:PiPlanner={decide:async context=>{
      if(context.turnCount===0){
        calls++;
        assert.equal(context.responseSha256,sha('Prior anchor response'));
        assert.equal(context.lastAssistant,'Prior anchor response');
        if(calls===1){
          assert.equal(context.ownerDirectives.length,1);
          f.store.queuePiOwnerDirective(child.id,'1982','Also check Windows CI');
          return {action:'NEXT',summary:'First owner note only',nextPrompt:'Check rollback'};
        }
        assert.equal(context.ownerDirectives.length,2);
        return {action:'NEXT',summary:'Both owner notes accepted',
          nextPrompt:'Check rollback requirements and Windows CI before further work'};
      }
      assert.equal(context.turnCount,1);
      return {action:'DONE',summary:'Final stage verified',nextPrompt:''};
    }};
    await drivePiAutopilot({store:f.store,planner,missionId:child.id,
      revision:child.version,requestPrefix:child.requestKey,page:f.anchor,url:SOURCE});
    assert.equal(calls,2);
    assert.equal(f.results().sends,1);
    assert.match(f.results().latestPrompt,/Check rollback requirements and Windows CI/);
    assert.equal(f.store.pendingPiOwnerDirectives(child.id).length,0);
    assert.equal(f.store.events(child.id).filter(e=>e.type==='pi.chain_preflight_decision').length,1);
    assert.equal(f.store.events(child.id).filter(e=>e.type==='chatgpt.browser_reserved').length,1);
    assert.equal(f.store.piPlan(child.id)?.action,'DONE');
  }finally{f.cleanup();}
});

test('a late owner note racing the successor reservation is automatically re-planned without a duplicate Send',async()=>{
  const f=fixture();try{
    const {child}=readySuccessor(f,'preflight-reservation-race');
    const original=f.store.reserveChatBrowserTurn.bind(f.store);
    let injected=false,piPreflightCalls=0;
    f.store.reserveChatBrowserTurn=(id,revision,key,sha,options)=>{
      if(id===child.id&&!injected){
        injected=true;
        f.store.queuePiOwnerDirective(child.id,'1993','Add the final security regression');
      }
      return original(id,revision,key,sha,options);
};

test('verified 32-to-1 new Chat retires the predecessor Relay-created tab, never the human anchor',async()=>{
  // The fixture's independent owner-linked Mission is NOT in the source
  // conversation here. An unrelated binding to that conversation would
  // intentionally prevent cleanup, even if the predecessor had created it.
  const f=fixture(DEST2);try{
    const sha=(x:string)=>createHash('sha256').update(x).digest('hex');
    const created=f.store.create({goal:'Continue the exact 32-turn owner task',
      acceptance:['Verify the remaining work across Missions'],workspace:'',
      sandbox:'read-only',mode:'supervised',maxTurns:32,checks:[],
      requestKey:'owned-predecessor-32'});
    const linked=f.store.linkChat(created.id,DEST2,created.version).mission;
    const parent=f.store.bindChatBrowser(created.id,'install:Chrome:fake',linked.version).mission;
    f.store.setMeta(`pi.autopilot.enabled.${parent.id}`,'1');
    const rolloverRounds=new Set([1,6,11,16,21,26,31]);
    for(let round=1;round<=32;round++){
      const newConversation=rolloverRounds.has(round);
      const newChatUrl=round===31?SOURCE:
        `https://chatgpt.com/c/123e4567-e89b-42d3-a456-${426614175000+round}`;
      const key=`parent-owned-32-${round}`;
      f.store.reserveChatBrowserTurn(parent.id,f.store.get(parent.id).version,key,
        sha('Prior anchor user turn'),newConversation?{newConversation:true}:{});
      f.store.finishChatBrowserTurn(parent.id,key,{kind:'observed',
        assistantSha256:sha('Prior anchor response'),summary:'Prior anchor response',
        ...(newConversation?{newChatTargetSha256:sha(
          round===31?CHROME_SOURCE_TARGET_ID:`parent-target-${round}`)}:{}),
        ...(newConversation?{newChatUrl}:{})});
      f.store.commitPiPlan(parent.id,sha('Prior anchor response'),[],{
        action:'NEXT',summary:'Parent work still remains',
        nextPrompt:'Continue verifying outstanding requirements'});
    }
    const child=f.store.createPiSuccessor(parent.id)!;
    assert.ok(child);
    assert.equal(f.store.chatLink(child.id),SOURCE);
    assert.equal(f.store.canRetirePiChainSourceTab(child.id,SOURCE,DEST,sha(CHROME_SOURCE_TARGET_ID)),false,
      'A not-yet-completed child may not retire its source');
    const planner:PiPlanner={decide:async()=>({
      action:'DONE',summary:'Synthetic successor finished',nextPrompt:'',
    })};
    await drivePiAutopilot({store:f.store,planner,missionId:child.id,
      revision:child.version,requestPrefix:child.requestKey,page:f.anchor,url:SOURCE});
    assert.equal(f.results().sends,1);
    assert.equal(f.anchorClosed(),true,'Only the verified Relay-created parent tab closes');
    assert.equal(f.store.chatLink(child.id),DEST);
    assert.equal(f.store.get(child.id).turnCount,1);
    const events=f.store.events(child.id);
    assert.equal(events.filter(e=>e.type==='chatgpt.browser_tab_retired').length,1);
    const receipt=events.find(e=>e.type==='chatgpt.browser_tab_retired')!.payload as
      {parentId:string;retiredUrlSha256:string};
    assert.equal(receipt.parentId,parent.id);
    assert.equal(receipt.retiredUrlSha256,sha(SOURCE));
  }finally{f.cleanup();}
});
    const planner:PiPlanner={decide:async context=>{
      if(context.turnCount===0){
        piPreflightCalls++;
        assert.equal(context.ownerDirectives.length,1);
        return {action:'NEXT',summary:'Owner security request reviewed',
          nextPrompt:'Run the final security regression before completion'};
      }
      return {action:'DONE',summary:'Security regression confirmed',nextPrompt:''};
    }};
    await drivePiAutopilot({store:f.store,planner,missionId:child.id,
      revision:child.version,requestPrefix:child.requestKey,page:f.anchor,url:SOURCE});
    assert.equal(injected,true);
    assert.equal(piPreflightCalls,1);
    assert.equal(f.results().sends,1);
    assert.match(f.results().latestPrompt,/Run the final security regression/);
    assert.equal(f.store.events(child.id).filter(e=>e.type==='chatgpt.browser_reserved').length,1);
    assert.equal(f.store.events(child.id).filter(e=>e.type==='chatgpt.browser_uncertain').length,0);
    assert.equal(f.store.pendingPiOwnerDirectives(child.id).length,0);
  }finally{f.cleanup();}
});

test('successor rechecks its parent answer after PI inference and refuses a changed tab before reservation',async()=>{
  const f=fixture();try{
    const {child}=readySuccessor(f,'preflight-parent-change');
    f.store.queuePiOwnerDirective(child.id,'1994','Check an extra quality gate');
    let changed=false;
    const changedPage={...f.anchor,locator:(selector:string)=>{
      const original=f.anchor.locator(selector);
      if(!changed||!selector.includes('data-message-author-role="assistant"'))return original;
      const altered:any={...original,innerText:async()=> 'Another agent changed the parent reply'};
      altered.last=()=>altered;altered.first=()=>altered;
      return altered;
    }} as unknown as Page;
    const planner:PiPlanner={decide:async context=>{
      if(context.turnCount===0){
        changed=true; // Simulate a real browser change while PI is thinking.
        return {action:'NEXT',summary:'Owner note included',
          nextPrompt:'Verify the extra quality gate'};
      }
      return {action:'DONE',summary:'Gate checked',nextPrompt:''};
    }};
    await assert.rejects(drivePiAutopilot({store:f.store,planner,missionId:child.id,
      revision:child.version,requestPrefix:child.requestKey,page:changedPage,url:SOURCE}),
    /Source ChatGPT history changed before new-tab Send reservation/);
    assert.equal(f.results().sends,0);
    assert.equal(f.store.chatBrowserTurn(child.id),null);
    assert.equal(f.store.piPlan(child.id)?.round,0);
    changed=false;
    await drivePiAutopilot({store:f.store,planner,missionId:child.id,
      revision:child.version,requestPrefix:child.requestKey,page:f.anchor,url:SOURCE});
    assert.equal(f.results().sends,1);
    assert.equal(f.store.piPlan(child.id)?.action,'DONE');
  }finally{f.cleanup();}
});

test('PI may halt a successor after new owner notes without reserving a browser Send',async()=>{
  const f=fixture();try{
    const {child}=readySuccessor(f,'preflight-stop');
    f.store.queuePiOwnerDirective(child.id,'1991','Stop because a human check is required');
    const planner:PiPlanner={decide:async context=>{
      assert.equal(context.turnCount,0);
      assert.equal(context.ownerDirectives.length,1);
      return {action:'BLOCKED',summary:'Owner human checkpoint required',nextPrompt:''};
    }};
    await drivePiAutopilot({store:f.store,planner,missionId:child.id,
      revision:child.version,requestPrefix:child.requestKey,page:f.anchor,url:SOURCE});
    assert.equal(f.results().sends,0);
    assert.equal(f.store.chatBrowserTurn(child.id),null);
    assert.equal(f.store.get(child.id).state,'BLOCKED');
    assert.equal(f.store.piPlan(child.id)?.action,'BLOCKED');
    assert.equal(f.store.pendingPiOwnerDirectives(child.id).length,0);
    assert.equal(f.store.events(child.id).filter(e=>e.type==='pi.autopilot_finished').length,1);
  }finally{f.cleanup();}
});

test('uncertain successor first-Send recovery reconstructs the owner-revised PI prompt, never its stale parent prompt',()=>{
  const f=fixture();try{
    const {parent,child,sha}=readySuccessor(f,'preflight-recovery');
    f.store.queuePiOwnerDirective(child.id,'1992','Prioritize a Windows deployment gate');
    const directives=f.store.pendingPiOwnerDirectives(child.id);
    const revised={action:'NEXT' as const,summary:'Owner changed release priority',
      nextPrompt:'Verify the Windows deployment gate before changing any runtime process'};
    f.store.commitPiChainPreflight(child.id,sha('Prior anchor response'),
      directives.map(d=>d.id),revised);
    const selected=browserRolloverPiPlan(f.store,child.id);
    assert.equal(selected?.nextPrompt,revised.nextPrompt);
    const args={goal:child.goal,acceptance:child.acceptance,
      sandbox:child.sandbox,workspace:child.workspace,nextInstruction:null,
      turnCount:0,missionRequestKey:child.requestKey,
      reservedRequestKey:`${child.requestKey}-1`,sourceAnswer:'Prior anchor response',
      adopted:false,chainParent:true,piManaged:true};
    const submitted=browserNewChatPrompt(child.goal,child.acceptance,
      revised.summary,revised.nextPrompt,'Prior anchor response',null,
      {round:selected!.round,responseSha256:selected!.responseSha256});
    const recovered=browserRolloverRecoveryPrompt({...args,piPlan:selected});
    assert.equal(recovered,submitted);
    assert.notEqual(recovered,browserRolloverRecoveryPrompt({...args,
      piPlan:f.store.piPlan(parent.id)}));
    f.store.reserveChatBrowserTurn(child.id,child.version,args.reservedRequestKey,
      sha(submitted.trim()),{newConversation:true});
    f.store.finishChatBrowserTurn(child.id,args.reservedRequestKey,{kind:'uncertain',
      error:'Synthetic Chrome observer disconnect after an unconfirmed new-tab Send'});
    assert.equal(f.store.chatBrowserTurn(child.id)?.status,'uncertain');
    assert.equal(f.store.chatBrowserTurn(child.id)?.promptSha256,sha(recovered.trim()));
    assert.throws(()=>f.store.reserveChatBrowserTurn(child.id,f.store.get(child.id).version,
      `${child.requestKey}-2`,sha('different message')),/Cannot run browser turn|Previous browser turn/);
  }finally{f.cleanup();}
});

test('a PI NEXT after five observed sends starts exactly one fresh chat and preserves its Mission',async()=>{
  const f=fixture();try{
    const created=f.store.create({goal:'Long-running staged evidence audit',
      acceptance:['Gather nine independently checked rounds'],workspace:'',
      sandbox:'read-only',mode:'supervised',maxTurns:10,checks:[],requestKey:'pi-long'});
    const linked=f.store.linkChat(created.id,SOURCE,created.version).mission;
    const bound=f.store.bindChatBrowser(linked.id,'install:Chrome:fake',linked.version).mission;
    const planner:PiPlanner={decide:async input=>input.turnCount<9
      ?{action:'NEXT',summary:'Evidence still pending',nextPrompt:'Review another evidence item'}
      :{action:'DONE',summary:'Nine rounds checked',nextPrompt:''}};
    await drivePiAutopilot({store:f.store,planner,missionId:bound.id,
      revision:bound.version,requestPrefix:'pi-rotate',page:f.anchor,url:SOURCE});
    const m=f.store.get(bound.id);
    assert.equal(m.turnCount,9);
    assert.equal(f.results().sends,9);
    assert.equal(f.results().newPages,2);
    assert.equal(f.store.piChatObservedTurns(m.id),4);
    assert.equal(f.store.chatLink(m.id),DEST2);
    assert.equal(f.store.events(m.id).filter(x=>x.type==='chatgpt.browser_migrated').length,2);
    assert.equal(f.store.events(m.id).filter(x=>x.type==='chatgpt.browser_reserved').length,9);
    assert.equal(f.store.events(m.id).filter(x=>x.type==='pi.autopilot_finished').length,1);
  }finally{f.cleanup();}
});

test('five-to-six PI rollover rechecks the exact source after its initial DOM preflight and before reserving a Send',async()=>{
  const f=fixture();try{
    const m=f.store.create({goal:'Verify safe rollover at five turns',
      acceptance:['Never append a sixth Send to a changed conversation'],workspace:'',
      sandbox:'read-only',mode:'supervised',maxTurns:7,checks:[],requestKey:'pi-race-five'});
    const linked=f.store.linkChat(m.id,SOURCE,m.version).mission;
    const bound=f.store.bindChatBrowser(m.id,'install:Chrome:fake',linked.version).mission;
    f.store.setMeta(`pi.autopilot.enabled.${m.id}`,'1');
    const answer='First NetBox research answer\n[MISSION_RELAY:DONE]';
    const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
    for(let round=1;round<=5;round++){
      const request=`pi-race-five-${round}`;
      f.store.reserveChatBrowserTurn(m.id,f.store.get(m.id).version,
        request,sha('Previously submitted user prompt'),
        round===1?{newConversation:true}:{});
      f.store.finishChatBrowserTurn(m.id,request,{kind:'observed',
        assistantSha256:sha(answer),summary:answer,
        ...(round===1?{newChatUrl:DEST}:{})});
      f.store.commitPiPlan(m.id,sha(answer),[],{
        action:'NEXT',summary:`Verified stage ${round}`,
        nextPrompt:'Check the remaining evidence'});
    }
    assert.equal(f.store.piChatObservedTurns(m.id),5);
    f.primeRecovered();
    let assistantReads=0;
    const source={...f.fresh,locator:(selector:string)=>{
      const original=f.fresh.locator(selector);
      if(!selector.includes('data-message-author-role="assistant"'))return original;
      const changed:any={...original,innerText:async()=>
        ++assistantReads===1?answer:'An unrelated assistant response appeared'};
      changed.first=()=>changed;changed.last=()=>changed;
      return changed;
    }} as unknown as Page;
    await assert.rejects(()=>drivePiAutopilot({store:f.store,planner:{decide:async()=>{
      throw new Error('PI must not run before the changed source is rejected');
    }},missionId:m.id,revision:f.store.get(m.id).version,
      requestPrefix:'pi-race-five',page:source,url:DEST,
      recoveredAnswer:{responseSha256:sha(answer),lastAssistant:answer}}),
    /Source ChatGPT history changed before new-tab Send reservation/);
    assert.equal(assistantReads,2,'The rollover must inspect the source again');
    assert.equal(f.results().sends,0);
    assert.equal(f.results().newPages,0);
    assert.equal(f.store.get(m.id).turnCount,5);
    assert.equal(f.store.chatBrowserTurn(m.id)?.status,'observed');
    assert.equal(f.store.events(m.id).filter(e=>e.type==='chatgpt.browser_reserved').length,5);
  }finally{f.cleanup();}
});

test('ordinary PI NEXT rechecks the exact source at the second preflight without reserving a changed-chat Send',async()=>{
  const f=fixture();try{
    const created=f.store.create({goal:'Keep an ordinary PI continuation bound to the last answer',
      acceptance:['Reject a changed source without a second Send'],workspace:'',
      sandbox:'read-only',mode:'supervised',maxTurns:7,checks:[],requestKey:'pi-race-next'});
    const linked=f.store.linkChat(created.id,SOURCE,created.version).mission;
    const bound=f.store.bindChatBrowser(linked.id,'install:Chrome:fake',linked.version).mission;
    f.store.setMeta(`pi.autopilot.enabled.${bound.id}`,'1');
    const answer='First NetBox research answer\n[MISSION_RELAY:DONE]';
    const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
    f.store.reserveChatBrowserTurn(bound.id,bound.version,'pi-race-next-1',
      sha('Previously submitted user prompt'),{newConversation:true});
    f.store.finishChatBrowserTurn(bound.id,'pi-race-next-1',{
      kind:'observed',assistantSha256:sha(answer),summary:answer,newChatUrl:DEST});
    f.store.commitPiPlan(bound.id,sha(answer),[],{
      action:'NEXT',summary:'One verified turn',nextPrompt:'Proceed with the next test'});
    f.primeRecovered();
    let assistantReads=0;
    const source={...f.fresh,locator:(selector:string)=>{
      const original=f.fresh.locator(selector);
      if(!selector.includes('data-message-author-role="assistant"'))return original;
      const edited:any={...original,innerText:async()=>
        ++assistantReads===1?answer:'An intervening human changed the assistant response'};
      edited.first=()=>edited;edited.last=()=>edited;
      return edited;
    }} as unknown as Page;
    await assert.rejects(()=>drivePiAutopilot({store:f.store,planner:{decide:async()=>{
      throw new Error('No new PI decision should run before source rejection');
    }},missionId:bound.id,revision:f.store.get(bound.id).version,
    requestPrefix:'pi-race-next',page:source,url:DEST,
    recoveredAnswer:{responseSha256:sha(answer),lastAssistant:answer}}),
    /Source ChatGPT history changed before existing-chat Send reservation/);
    assert.equal(assistantReads,2,'Ordinary continuation must check source a second time');
    assert.equal(f.results().sends,0);
    assert.equal(f.results().newPages,0);
    assert.equal(f.store.get(bound.id).turnCount,1);
    assert.equal(f.store.chatBrowserTurn(bound.id)?.status,'observed');
    assert.equal(f.store.events(bound.id).filter(e=>e.type==='chatgpt.browser_reserved').length,1);
  }finally{f.cleanup();}
});

test('after a crash at five observed turns, PI recovers the exact checkpoint and sends the sixth only in a new chat',async()=>{
  const f=fixture();try{
    const created=f.store.create({goal:'Long-running recovery at the five-turn boundary',
      acceptance:['No old-chat sixth send or duplicate request'],workspace:'',
      sandbox:'read-only',mode:'supervised',maxTurns:7,checks:[],requestKey:'pi-five-crash'});
    const linked=f.store.linkChat(created.id,SOURCE,created.version).mission;
    const bound=f.store.bindChatBrowser(linked.id,'install:Chrome:fake',linked.version).mission;
    let interruptOnce=true;
    const planner:PiPlanner={decide:async context=>{
      if(context.turnCount===5&&interruptOnce){
        interruptOnce=false;
        throw new Error('Synthetic PI crash after the fifth observed answer');
      }
      return context.turnCount===6
        ?{action:'DONE',summary:'Sixth answer independently reviewed',nextPrompt:''}
        :{action:'NEXT',summary:'Checkpoint retained',nextPrompt:'Continue evidence check'};
    }};
    await assert.rejects(drivePiAutopilot({store:f.store,planner,missionId:bound.id,
      revision:bound.version,requestPrefix:'pi-five-crash',page:f.anchor,url:SOURCE}),
    /Synthetic PI crash/);
    assert.equal(f.store.get(bound.id).turnCount,5);
    assert.equal(f.store.chatBrowserTurn(bound.id)?.status,'observed');
    assert.equal(f.store.piChatObservedTurns(bound.id),5);
    assert.equal(f.results().sends,5);
    assert.equal(f.results().newPages,1);
    const previous=f.store.chatBrowserTurn(bound.id)!;
    const lastAssistant='NetBox research with VRF evidence, observed round 5\n[MISSION_RELAY:DONE]';
    assert.equal(createHash('sha256').update(lastAssistant).digest('hex'),previous.assistantSha256);
    await drivePiAutopilot({store:f.store,planner,missionId:bound.id,
      revision:f.store.get(bound.id).version,requestPrefix:'pi-five-crash',
      page:f.fresh,url:DEST,
      recoveredAnswer:{responseSha256:previous.assistantSha256!,lastAssistant}});
    assert.equal(f.store.get(bound.id).turnCount,6);
    assert.equal(f.store.piChatObservedTurns(bound.id),1);
    assert.equal(f.results().sends,6);
    assert.equal(f.results().newPages,2);
    assert.equal(f.store.events(bound.id).filter(e=>e.type==='chatgpt.browser_reserved').length,6);
    assert.equal(f.store.events(bound.id).filter(e=>e.type==='chatgpt.browser_migrated').length,2);
    assert.equal(f.store.piPlan(bound.id)?.action,'DONE');
  }finally{f.cleanup();}
});

test('PI independently keeps ChatGPT running after model DONE, reviews queued owner changes and emits one final result',async()=>{
  const f=fixture();try{
    const inputs:PiTurnContext[]=[];
    let call=0;
    const planner:PiPlanner={decide:async input=>{
      inputs.push(input);
      if(++call===1){
        assert.equal(input.turnCount,1);
        f.store.queuePiOwnerDirective(f.mission.id,'901','Need to check VRF too');
        return {action:'NEXT',summary:'More VRF evidence needed',nextPrompt:'Check VRF mapping'};
      }
      if(call===2){
        assert.equal(input.ownerDirectives.length,1);
        assert.equal(input.ownerDirectives[0]?.text,'Need to check VRF too');
        return {action:'NEXT',summary:'Review queued VRF instruction',nextPrompt:'Include VRF evidence'};
      }
      assert.equal(input.turnCount,2);
      return {action:'DONE',summary:'NetBox read-only research completed',nextPrompt:''};
    }};
    await drivePiAutopilot({store:f.store,planner,missionId:f.mission.id,
      revision:f.mission.version,requestPrefix:'pi-tst',page:f.anchor,url:SOURCE});
    const end=f.store.get(f.mission.id);
    assert.equal(end.state,'PAUSED');
    assert.equal(end.turnCount,2);
    assert.equal(f.results().sends,2);
    assert.equal(f.results().newPages,1);
    assert.match(f.results().latestPrompt,/Include VRF evidence/);
    for(const marker of ['NEXT','HANDOFF','DONE','BLOCKED'])
      assert.ok(f.results().latestPrompt.includes(`[MISSION_RELAY:${marker}]`));
    assert.equal(f.store.chatLink(end.id),DEST);
    assert.equal(f.store.pendingPiOwnerDirectives(end.id).length,0);
    assert.equal(f.store.piPlan(end.id)?.action,'DONE');
    const e=f.store.events(end.id);
    assert.equal(e.filter(x=>x.type==='chatgpt.browser_reserved').length,2);
    assert.equal(e.filter(x=>x.type==='chatgpt.browser_observed').length,2);
    assert.equal(e.filter(x=>x.type==='pi.decision').length,2);
    assert.equal(e.filter(x=>x.type==='pi.autopilot_finished').length,1);
    assert.equal(e.filter(x=>x.type==='chatgpt.browser_run_finished').length,0);
    assert.throws(()=>f.store.queuePiOwnerDirective(end.id,'902','A late instruction'),/terminal decision/);
    assert.equal(inputs.length,3); // Replanned on newly arrived owner message.
  }finally{f.cleanup();}
});

test('PI safely reviews a fully observed but not yet PI-reviewed turn after a crash without a duplicate browser Send',async()=>{
  const f=fixture();try{
    const answer='Recovered answer with concrete evidence';
    const sha=createHash('sha256').update(answer).digest('hex');
    const m=f.store.reserveChatBrowserTurn(f.mission.id,f.mission.version,
      'pi-recover-1','b'.repeat(64));
    f.store.finishChatBrowserTurn(m.id,'pi-recover-1',{kind:'observed',
      assistantSha256:sha,summary:'Previous answer',newChatUrl:DEST,
      telegramBatch:{terminal:false,flowSignal:'DONE',piManaged:true}});
    f.primeRecovered();
    const planner:PiPlanner={decide:async context=>{
      assert.equal(context.turnCount,1);
      assert.equal(context.lastAssistant,'Recovered answer with concrete evidence');
      return {action:'DONE',summary:'Earlier browser response is complete',nextPrompt:''};
    }};
    await drivePiAutopilot({store:f.store,planner,missionId:m.id,
      revision:f.store.get(m.id).version,requestPrefix:'pi-recover',
      page:f.fresh,url:DEST,recoveredAnswer:{
        responseSha256:sha,lastAssistant:answer,
      }});
    assert.equal(f.results().sends,0);
    assert.equal(f.store.piPlan(m.id)?.action,'DONE');
    assert.equal(f.store.events(m.id).filter(e=>e.type==='pi.autopilot_finished').length,1);
  }finally{f.cleanup();}
});

test('PI restarts from a separately corrected answer, re-reviews it once and never replays the original browser Send',async()=>{
  const f=fixture();try{
    f.store.setMeta(`pi.autopilot.enabled.${f.mission.id}`,'1');
    const old='Old, falsely attributed assistant text\n[MISSION_RELAY:NEXT]';
    const actual='Independently observed corrected answer\n[MISSION_RELAY:DONE]';
    const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
    const promptSha=sha('original submitted prompt');
    const reserved=f.store.reserveChatBrowserTurn(f.mission.id,f.mission.version,
      'corrected-pi-1',promptSha,{newConversation:true});
    f.store.finishChatBrowserTurn(reserved.id,'corrected-pi-1',{
      kind:'observed',assistantSha256:sha(old),summary:old,newChatUrl:DEST});
    f.store.commitPiPlan(reserved.id,sha(old),[],{
      action:'NEXT',summary:'Wrong plan based on stale bytes',nextPrompt:'Continue incorrectly',
    });
    f.store.correctPiBrowserAttribution(reserved.id,f.store.get(reserved.id).version,{
      requestPromptSha256:promptSha,assistantSha256:sha(actual),summary:actual,
    });
    f.primeRecovered();
    const planner:PiPlanner={decide:async input=>{
      assert.equal(input.turnCount,1);
      assert.equal(input.responseSha256,sha(actual));
      assert.equal(input.lastAssistant,actual);
      return {action:'DONE',summary:'Actual answer independently reviewed',nextPrompt:''};
    }};
    const args={store:f.store,planner,missionId:reserved.id,
      revision:f.store.get(reserved.id).version,requestPrefix:'corrected-pi',
      page:f.fresh,url:DEST};
    await assert.rejects(drivePiAutopilot(args),/corrected attribution requires exact/);
    assert.equal(f.results().sends,0);
    await drivePiAutopilot({...args,recoveredAnswer:{
      responseSha256:sha(actual),lastAssistant:actual,
    }});
    assert.equal(f.results().sends,0);
    assert.equal(f.store.get(reserved.id).turnCount,1);
    assert.equal(f.store.piPlan(reserved.id)?.responseSha256,sha(actual));
    assert.equal(f.store.piPlan(reserved.id)?.action,'DONE');
    assert.equal(f.store.events(reserved.id).filter(e=>e.type==='chatgpt.browser_reserved').length,1);
    assert.equal(f.store.events(reserved.id).filter(e=>e.type==='pi.decision').length,1);
    assert.equal(f.store.events(reserved.id).filter(e=>e.type==='pi.decision_attribution_corrected').length,1);
  }finally{f.cleanup();}
});

test('PI accepts an independently inspected recovered rollover, without replay or false completion',async()=>{
  const f=fixture();try{
    const answer='First NetBox research answer\n[MISSION_RELAY:DONE]';
    const promptSha='b'.repeat(64);
    const sha=createHash('sha256').update(answer).digest('hex');
    const reserved=f.store.reserveChatBrowserTurn(f.mission.id,f.mission.version,
      'pi-recovered-rollover-1',promptSha);
    f.store.finishChatBrowserTurn(reserved.id,'pi-recovered-rollover-1',{
      kind:'uncertain',error:'Observer lost the browser after Send',
    });
    f.store.recoverObservedBrowserRollover(reserved.id,
      f.store.get(reserved.id).version,{
        requestPromptSha256:promptSha,newChatUrl:DEST,
        assistantSha256:sha,summary:answer,
      });
    assert.equal(f.store.chatBrowserTurn(reserved.id)?.status,'reconciled');
    assert.equal(f.store.hasVerifiedPiBrowserCheckpoint(reserved.id),true);
    f.primeRecovered();
    const planner:PiPlanner={decide:async input=>{
      assert.equal(input.turnCount,1);
      assert.equal(input.lastAssistant,answer);
      return {action:'DONE',summary:'Recovered response reviewed',nextPrompt:''};
    }};
    await drivePiAutopilot({store:f.store,planner,missionId:reserved.id,
      revision:f.store.get(reserved.id).version,requestPrefix:'pi-recovered-rollover',
      page:f.fresh,url:DEST,recoveredAnswer:{responseSha256:sha,lastAssistant:answer},
    });
    assert.equal(f.results().sends,0);
    assert.equal(f.store.piPlan(reserved.id)?.action,'DONE');
    assert.equal(f.store.events(reserved.id).filter(x=>x.type==='chatgpt.browser_reserved').length,1);
    assert.equal(f.store.events(reserved.id).filter(x=>x.type==='pi.autopilot_finished').length,1);
  }finally{f.cleanup();}
});

test('PI rejects an operator-acknowledged ambiguous Send without independently recovered answer evidence',async()=>{
  const f=fixture();try{
    const promptSha='b'.repeat(64);
    const reserved=f.store.reserveChatBrowserTurn(f.mission.id,f.mission.version,
      'pi-manual-only-1',promptSha);
    f.store.finishChatBrowserTurn(reserved.id,'pi-manual-only-1',{
      kind:'uncertain',error:'Original outcome unknown',
    });
    f.store.reconcileChatBrowserTurn(reserved.id);
    assert.equal(f.store.chatBrowserTurn(reserved.id)?.status,'reconciled');
    assert.equal(f.store.hasVerifiedPiBrowserCheckpoint(reserved.id),false);
    assert.throws(()=>f.store.commitPiPlan(reserved.id,'a'.repeat(64),[],{
      action:'DONE',summary:'Unsupported conclusion',nextPrompt:'',
    }),/PI decision requires one matching/);
    const planner:PiPlanner={decide:async()=>{throw new Error('PI must not infer');}};
    await assert.rejects(drivePiAutopilot({store:f.store,planner,
      missionId:reserved.id,revision:f.store.get(reserved.id).version,
      requestPrefix:'pi-manual-only',page:f.fresh,url:DEST,
      recoveredAnswer:{responseSha256:'a'.repeat(64),lastAssistant:'Unverified'},
    }),/unstarted READY|fully observed browser checkpoint/);
    assert.equal(f.results().sends,0);
    assert.equal(f.store.events(reserved.id).filter(x=>x.type==='pi.decision').length,0);
  }finally{f.cleanup();}
});

test('PI refuses recovery when the latest observed receipt is missing or uncertain',async()=>{
  const f=fixture();try{
    const planner:PiPlanner={decide:async()=>({action:'NEXT',summary:'continue',nextPrompt:'Check VRF'})};
    const claimed=f.store.reserveChatBrowserTurn(f.mission.id,f.mission.version,
      'pi-uncertain-1','b'.repeat(64));
    f.store.finishChatBrowserTurn(claimed.id,'pi-uncertain-1',{
      kind:'uncertain',error:'Browser replied ambiguously'});
    f.primeRecovered();
    await assert.rejects(drivePiAutopilot({store:f.store,planner,missionId:claimed.id,
      revision:f.store.get(claimed.id).version,requestPrefix:'pi-uncertain',
      page:f.fresh,url:DEST,recoveredAnswer:{responseSha256:'a'.repeat(64),lastAssistant:'Invalid'},
    }),/unstarted READY|fully observed/);
    assert.equal(f.results().sends,0);
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

test('PI human-follow-up BLOCKED stops without a second browser send',async()=>{
  const f=fixture();try{
    const planner:PiPlanner={decide:async()=>({
      action:'BLOCKED',summary:'The owner must carry out the next physical Android test',nextPrompt:'',
    })};
    await drivePiAutopilot({store:f.store,planner,missionId:f.mission.id,
      revision:f.mission.version,requestPrefix:'pi-human',page:f.anchor,url:SOURCE});
    assert.equal(f.results().sends,1);
    const finish=f.store.events(f.mission.id).find(x=>x.type==='pi.autopilot_finished');
    assert.equal((finish?.payload as {action?:string}).action,'BLOCKED');
  }finally{f.cleanup();}
});

test('PI failure after a real observed answer fails closed without a second Send',async()=>{
  const f=fixture();try{
    const planner:PiPlanner={decide:async()=>{throw new Error('PI unreachable');}};
    await assert.rejects(drivePiAutopilot({store:f.store,planner,missionId:f.mission.id,
      revision:f.mission.version,requestPrefix:'pi-error',page:f.anchor,url:SOURCE}),/PI unreachable/);
    pauseFailedPiPlanning(f.store,f.mission.id,'PI unreachable');
    assert.equal(f.results().sends,1);
    assert.equal(f.store.get(f.mission.id).state,'PAUSED');
    assert.equal(f.store.events(f.mission.id).filter(x=>x.type==='pi.autopilot_interrupted').length,1);
    assert.equal(f.store.events(f.mission.id).filter(x=>x.type==='pi.autopilot_finished').length,0);
  }finally{f.cleanup();}
});

test('PI refuses to send into a ChatGPT conversation manually altered while PI was planning',async()=>{
  const f=fixture();try{
    const planner:PiPlanner={decide:async()=>{
      f.modifyVisibleUser('A human typed a different user turn during PI planning');
      return {action:'NEXT',summary:'Research could continue',nextPrompt:'Check VRF evidence'};
    }};
    await assert.rejects(drivePiAutopilot({
      store:f.store,planner,missionId:f.mission.id,
      revision:f.mission.version,requestPrefix:'pi-human-changed',
      page:f.anchor,url:SOURCE,
    }),/visible ChatGPT history differs/);
    assert.equal(f.results().sends,1);
    assert.equal(f.store.get(f.mission.id).turnCount,1);
    assert.equal(f.store.events(f.mission.id).filter(e=>e.type==='chatgpt.browser_reserved').length,1);
  }finally{f.cleanup();}
});
