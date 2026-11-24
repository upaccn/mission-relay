import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {hostname} from 'node:os';
import {join} from 'node:path';
import type {Page} from 'playwriter';
import {Store} from '../src/core/store.js';
import {GoalLedger} from '../src/core/goal-store.js';
import {parseGoalPlanProposal,parseGoalReview,goalPlanPrompt,goalReviewPrompt,
  reviewGoalPiRound,type GoalPlanContext,type GoalReviewContext} from '../src/core/goal-pi.js';
import {drivePiAutopilot} from '../src/core/pi-autopilot.js';
import {goalWorkPrompt} from '../src/core/goal-prompts.js';
import type {PiPlanner} from '../src/core/pi-planner.js';

const goalText='Implement Goal-driven project operations with independently verified delivery';
const URL='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174000';
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const proposed={
  summary:'Validate the data layer and then the controller integration',
  items:[
    {key:'foundation',title:'Check persisted schema',priority:100,description:'Verify migration',
      dependsOn:[],acceptance:['Schema survives restart']},
    {key:'controller',title:'Wire existing controller',priority:90,description:'Reuse existing PI loop',
      dependsOn:['foundation'],acceptance:['No duplicate Send']},
  ],
};
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'relay-goal-pi-'));
  const file=join(dir,'relay.sqlite'),store=new Store(file),ledger=new GoalLedger(store);
  const owner=ledger.createGoal({requestKey:'owner-one',objective:goalText,priority:100});
  const mission=store.create({goal:goalText,acceptance:['Independent release test'],
    checks:[],workspace:'',sandbox:'read-only',mode:'supervised',requestKey:'mission-one'});
  const linked=store.linkChat(mission.id,URL,mission.version).mission;
  const bound=store.bindChatBrowser(mission.id,'install:Chrome:fake',linked.version).mission;
  store.setMeta(`pi.autopilot.enabled.${bound.id}`,'1');
  ledger.bindPiMission(owner.id,bound.id,bound.version,'bind-goal-1');
  const observe=(n:number,answer:string)=>{
    const existing=store.get(bound.id);
    store.reserveChatBrowserTurn(bound.id,existing.version,`goal-turn-${n}`,
      sha(`Exact user prompt ${n}`));
    store.finishChatBrowserTurn(bound.id,`goal-turn-${n}`,{
      kind:'observed',assistantSha256:sha(answer),summary:answer,
      telegramBatch:{terminal:true,flowSignal:'NEXT',piManaged:true},
    });
    return {responseSha256:sha(answer),lastAssistant:answer,round:n,
      missionId:bound.id,store,replaceExisting:false,ownerDirectives:[]};
  };
  const close=()=>{store.close();rmSync(dir,{recursive:true,force:true});};
  return {dir,file,store,ledger,goal:owner,mission:bound,observe,close};
}
const planner=(args:{
  plan?:typeof proposed;verdict?:'PASS'|'PARTIAL'|'FAIL'|'REPLAN'|'BLOCKED';
  evidenceRefs?:string[];nextPrompt?:string;onReview?:(context:GoalReviewContext)=>void;
  onPlan?:(context:GoalPlanContext)=>void;
}={}):PiPlanner=>({
  decide:async()=>{throw new Error('Legacy PI decide must not run for Goal-bound Missions');},
  proposeGoalPlan:async x=>{args.onPlan?.(x);return args.plan??proposed;},
  reviewGoalWork:async x=>{
    args.onReview?.(x);
    return {verdict:args.verdict??'PASS',summary:'PI reviewed cited execution evidence',
      nextPrompt:args.nextPrompt??(args.verdict==='FAIL'||args.verdict==='PARTIAL'?
        'Repair the current package and run the required checks':''),handoff:false,
      evidenceRefs:args.evidenceRefs??['git:1234','ci:5678'],
      ...(args.verdict==='BLOCKED'?{blocker:{
        kind:'external_permission' as const,evidence:'The owner-scoped role is denied access',
        releaseCondition:'Owner grants the existing role the required access',
      }}:{})};
  },
});
function work(f:ReturnType<typeof fixture>,key:string){
  return f.ledger.graph(f.goal.id).items.find(x=>x.key===key)!;
}
function review(f:ReturnType<typeof fixture>,n:number,answer:string,pi:PiPlanner){
  return reviewGoalPiRound({...f.observe(n,answer),planner:pi});
}

test('PI first-round review approves a durable plan, chooses eligible priority work, reuses existing NEXT',async()=>{
  const f=fixture();
  try{
    const start=f.store.get(f.mission.id);
    assert.equal(f.ledger.missionGoalId(start.id),f.goal.id);
    assert.equal(start.turnCount,0);
    let proposals=0;
    const pi=planner({onPlan:input=>{
      proposals++;
      assert.equal(input.objective,goalText);
      assert.deepEqual(input.ownerAcceptance,['Independent release test']);
      assert.equal(input.responseSha256,sha('Initial implementation analysis'));
    }});
    const decision=await review(f,1,'Initial implementation analysis',pi);
    assert.equal(proposals,1);
    assert.equal(decision.action,'NEXT');
    assert.match(decision.nextPrompt,/foundation|persisted schema/i);
    assert.equal(f.store.piPlan(f.mission.id)?.action,'NEXT');
    assert.equal(f.store.events(f.mission.id).filter(e=>e.type==='pi.decision').length,1);
    assert.equal(f.ledger.getGoal(f.goal.id).status,'ACTIVE');
    const graph=f.ledger.graph(f.goal.id);
    assert.equal(graph.plans.length,1);
    assert.equal(graph.plans[0]?.status,'APPROVED');
    assert.equal(work(f,'foundation').status,'IN_PROGRESS');
    assert.equal(work(f,'controller').status,'PENDING');
    assert.ok(graph.events.find(x=>x.type==='goal.pi_mission_bound'));
    assert.ok(graph.events.find(x=>x.type==='goal.plan_created'));
    const provenance=graph.events.find(x=>x.type==='goal.pi_plan_reviewed')!;
    assert.equal(provenance.payload.answerSha256,sha('Initial implementation analysis'));
    assert.equal(provenance.payload.planVersion,2);
    assert.equal(provenance.payload.missionId,f.mission.id);
    assert.throws(()=>f.ledger.setWorkStatus(f.goal.id,work(f,'controller').id,1,
      'READY',[],'skip-dependency'),/dependencies/);
    assert.equal(f.ledger.getGoal(f.goal.id).version,3);
    assert.equal(f.store.get(f.mission.id).turnCount,1);
  }finally{f.close();}
});

test('Goal PI sees fresh verified dead-owner settlement instead of treating the stale browser BLOCKED report as current',async()=>{
  const f=fixture();
  try{
    await review(f,1,'Initial approved plan',planner());
    const m=f.store.get(f.mission.id);
    const pending=f.store.reserveChatBrowserTurn(m.id,m.version,'goal-turn-2',
      sha('Second submitted user prompt'));
    // Simulate a previous Windows worker exiting between Send and its receipt.
    f.store.db.prepare('UPDATE missions SET owner_pid=?, owner_host=? WHERE id=?')
      .run(2147483647,hostname(),m.id);
    const stale='Earlier browser snapshot: the second Send is reserved and maintenance is blocked.\n[MISSION_RELAY:BLOCKED]';
    const recovered=f.store.recoverObservedBrowserTurn(m.id,pending.version,{
      requestPromptSha256:sha('Second submitted user prompt'),
      assistantSha256:sha(stale),summary:stale,
    });
    assert.equal(recovered.state,'PAUSED');
    assert.equal(f.store.hasVerifiedPiBrowserCheckpoint(m.id),true);
    let reviewed=false;
    const pi=planner({verdict:'PARTIAL',nextPrompt:'Verify the newly settled original request',
      onReview:input=>{
        reviewed=true;
        const cp=input.controllerCheckpoint!;
        assert.equal(cp.round,2);
        assert.equal(cp.missionState,'PAUSED');
        assert.equal(cp.stopRequested,false);
        assert.equal(cp.receiptStatus,'reconciled');
        assert.equal(cp.independentlyRecovered,true);
        assert.equal(cp.answerSha256,sha(stale));
        assert.ok(cp.observationEventId>cp.reservationEventId);
        const prompt=goalReviewPrompt(input);
        assert.match(prompt,/CURRENT AUTHORITATIVE CONTROLLER CHECKPOINT/);
        assert.match(prompt,/This specific round is durably settled/);
        assert.match(prompt,/Do not treat those historical statements/);
        assert.ok(prompt.indexOf('CURRENT AUTHORITATIVE CONTROLLER CHECKPOINT')>
          prompt.indexOf('Untrusted browser response:'));
      }});
    const decision=await reviewGoalPiRound({store:f.store,planner:pi,
      missionId:m.id,round:2,responseSha256:sha(stale),lastAssistant:stale,
      replaceExisting:false,ownerDirectives:[]});
    assert.equal(reviewed,true);
    assert.equal(decision.action,'NEXT');
    assert.equal(f.store.events(m.id).filter(e=>e.type==='chatgpt.browser_reserved').length,2);
    assert.equal(f.store.events(m.id).filter(e=>e.type==='chatgpt.browser_turn_recovered').length,1);
  }finally{f.close();}
});

test('PI PASS persists answer-correlated audit/criteria and selects dependency successor without Goal DONE',async()=>{
  const f=fixture();
  try{
    await review(f,1,'Analysis result',planner());
    const controllerId=work(f,'controller').id;
    const source='Implemented schema, tests passed, recorded a Git hash';
    const pi=planner({onReview:context=>{
      assert.equal(context.workItem.key,'foundation');
      assert.equal(context.responseSha256,sha(source));
      assert.deepEqual(context.acceptance,['Schema survives restart']);
    }});
    const plan=await review(f,2,source,pi);
    assert.equal(plan.action,'NEXT');
    assert.match(plan.nextPrompt,/controller/i);
    assert.equal(work(f,'foundation').status,'PASSED');
    assert.equal(work(f,'controller').status,'IN_PROGRESS');
    const accepted=f.ledger.graph(f.goal.id).acceptance.find(a=>a.itemId===work(f,'foundation').id)!;
    assert.equal(accepted.status,'PASS');
    assert.deepEqual(accepted.evidenceRefs,[`browser-sha256:${sha(source)}`]);
    const recorded=f.ledger.graph(f.goal.id).events.find(e=>e.type==='goal.pi_review')!;
    assert.equal(recorded.payload.answerSha256,sha(source));
    assert.equal(recorded.payload.missionId,f.mission.id);
    assert.equal(recorded.payload.verdict,'PASS');
    assert.equal(recorded.payload.itemId,work(f,'foundation').id);
    assert.equal(controllerId,work(f,'controller').id);
    assert.equal(f.ledger.getGoal(f.goal.id).status,'ACTIVE');
    assert.throws(()=>f.ledger.setWorkStatus(f.goal.id,controllerId,work(f,'controller').version,
      'PASSED',[], 'skip-acceptance'),/lifecycle|acceptance/);
    const eventsBefore=f.ledger.graph(f.goal.id).events.length;
    await assert.rejects(reviewGoalPiRound({
      ...f.observe(3,'Later observed answer'),planner:pi,
      responseSha256:sha('not the durable answer'),
    }),/full observed browser SHA/);
    assert.equal(f.ledger.graph(f.goal.id).events.length,eventsBefore);
  }finally{f.close();}
});

test('PI PARTIAL and FAIL preserve retry scope, and second review can later PASS',async()=>{
  const f=fixture();
  try{
    await review(f,1,'Analysis',planner());
    const partial=await review(f,2,'Work in progress',planner({verdict:'PARTIAL'}));
    assert.equal(partial.action,'NEXT');
    assert.match(partial.nextPrompt,/Repair/);
    assert.equal(work(f,'foundation').status,'IN_PROGRESS');
    const failed=await review(f,3,'Failed check result',planner({verdict:'FAIL'}));
    assert.equal(failed.action,'NEXT');
    assert.equal(work(f,'foundation').status,'IN_PROGRESS');
    const events=f.ledger.graph(f.goal.id).events;
    assert.deepEqual(events.filter(e=>e.type==='goal.pi_review')
      .map(e=>e.payload.verdict),['PARTIAL','FAIL']);
    assert.ok(events.some(e=>e.type==='goal.work_status'&&e.payload.to==='FAILED'));
    assert.equal((await review(f,4,'Repaired result',planner())).action,'NEXT');
    assert.equal(work(f,'controller').status,'IN_PROGRESS');
  }finally{f.close();}
});

test('PI receives durable review history and must decide on the merits after two non-pass reviews',async()=>{
  const f=fixture();
  try{
    await review(f,1,'Initial proposal',planner());
    await review(f,2,'Unverified draft 1',planner({verdict:'PARTIAL'}));
    await review(f,3,'Unverified draft 2',planner({verdict:'PARTIAL'}));
    let observed:GoalReviewContext|null=null;
    // No controller budget: a third PARTIAL is a normal PI decision, not a throw.
    const third=await review(f,4,'Draft 3 with the named fix',planner({verdict:'PARTIAL',
      nextPrompt:'Add the missing restart test for the schema',onReview:context=>{observed=context;}}));
    assert.equal(third.action,'NEXT');
    assert.deepEqual(observed?.priorWorkReviews?.map(x=>`${x.round}:${x.verdict}`),
      ['2:PARTIAL','3:PARTIAL']);
    const prompt=goalReviewPrompt(observed!);
    assert.match(prompt,/round 2: PARTIAL/);
    assert.match(prompt,/round 3: PARTIAL/);
    assert.match(prompt,/Decide on the merits now/);
    assert.match(prompt,/EVIDENCE STANDARD/);
    assert.doesNotMatch(prompt,/NON-CONVERGENCE/);
    assert.equal(work(f,'foundation').status,'IN_PROGRESS');
    assert.equal(f.ledger.graph(f.goal.id).plans.length,1);
  }finally{f.close();}
});

test('REPLAN keeps item keys: the revised active item continues with its review history',async()=>{
  const f=fixture();
  try{
    await review(f,1,'Initial proposal',planner());
    await review(f,2,'Partial result',planner({verdict:'PARTIAL'}));
    let planContext:GoalPlanContext|undefined;
    const revised={summary:'Same items, corrected prerequisite',items:[
      {key:'foundation',title:'Check persisted schema with migration fixture',priority:100,
        description:'Verify migration against a real fixture',dependsOn:[],
        acceptance:['Schema survives restart']},
      {key:'controller',title:'Wire existing controller',priority:90,
        description:'Reuse existing PI loop',dependsOn:['foundation'],acceptance:['No duplicate Send']},
    ]};
    const pi:PiPlanner={...planner({verdict:'REPLAN'}),proposeGoalPlan:async x=>{
      planContext=x;return revised;}};
    await review(f,3,'The plan missed a fixture',pi);
    assert.deepEqual(planContext?.currentPlan?.map(x=>x.key),['foundation','controller']);
    assert.match(goalPlanPrompt(planContext!),/Keep the exact key/);
    assert.ok(!planContext?.priorWorkOutcomes?.some(x=>x.status==='BLOCKED'),
      'a REPLAN never reports its own superseded item as externally blocked');
    let seen:GoalReviewContext|null=null;
    await review(f,4,'Fixture added',planner({verdict:'PASS',onReview:x=>{seen=x;}}));
    assert.deepEqual(seen?.priorWorkReviews?.map(x=>x.verdict),['PARTIAL','REPLAN'],
      'review history follows the key across plans');
  }finally{f.close();}
});

test('PI plan keys are normalized and dependencies are remapped',()=>{
  const plan=parseGoalPlanProposal(JSON.stringify({summary:'Keys',items:[
    {key:'Pro Paywall / Product!',title:'A',description:'a',priority:10,dependsOn:[],acceptance:['x']},
    {key:'pro paywall product',title:'B',description:'b',priority:9,
      dependsOn:['Pro Paywall / Product!','missing','pro paywall product'],acceptance:['y']},
  ]}));
  assert.deepEqual(plan.items.map(x=>x.key),['pro-paywall-product','pro-paywall-product-2']);
  assert.deepEqual(plan.items[1]!.dependsOn,['pro-paywall-product']);
});

test('PI REPLAN supersedes old version, preserves audit, and chooses the new approved package',async()=>{
  const f=fixture();
  try{
    await review(f,1,'Initial proposal',planner());
    let proposedCount=0;
    const newPlan={summary:'New scope from evidence',items:[
      {key:'replacement',title:'Repair design',description:'Improve tests',priority:80,
        dependsOn:[],acceptance:['New test evidence']},
    ]};
    const pi:PiPlanner={...planner({verdict:'REPLAN'}),proposeGoalPlan:async()=>{
      proposedCount++;return newPlan;
    }};
    const result=await review(f,2,'Architecture changed',pi);
    assert.equal(proposedCount,1);
    assert.equal(result.action,'NEXT');
    assert.match(result.nextPrompt,/replacement/i);
    const graph=f.ledger.graph(f.goal.id);
    assert.equal(graph.plans.length,2);
    assert.deepEqual(graph.plans.map(x=>x.status),['SUPERSEDED','APPROVED']);
    assert.equal(work(f,'foundation').status,'FAILED');
    assert.equal(work(f,'replacement').status,'IN_PROGRESS');
    assert.ok(graph.events.some(x=>x.type==='goal.pi_review'&&x.payload.verdict==='REPLAN'));
    assert.equal(f.store.events(f.mission.id).filter(x=>x.type==='pi.decision').length,2);
  }finally{f.close();}
});

test('REPLAN carries earlier PASSED work forward instead of re-executing it',async()=>{
  const f=fixture();
  try{
    await review(f,1,'Initial proposal',planner());
    await review(f,2,'Foundation implemented',planner({verdict:'PASS'}));
    assert.equal(work(f,'foundation').status,'PASSED');
    let seen:GoalPlanContext|undefined;
    const newPlan={summary:'Rescoped after controller evidence',items:[
      {key:'foundation',title:'Re-check persisted schema',description:'Baseline again',
        priority:100,dependsOn:[],acceptance:['Schema survives restart']},
      {key:'renamed-baseline',title:'Readback',description:'Same obligation, new name',
        priority:95,dependsOn:[],acceptance:['  schema SURVIVES   restart ']},
      {key:'integration',title:'Wire controller differently',description:'New design',
        priority:90,dependsOn:['foundation','renamed-baseline'],acceptance:['Controller test passes']},
    ]};
    const pi:PiPlanner={...planner({verdict:'REPLAN'}),proposeGoalPlan:async x=>{
      seen=x;return newPlan;}};
    const result=await review(f,3,'Controller design must change',pi);
    assert.deepEqual(seen?.priorWorkOutcomes?.map(x=>`${x.status}:${x.key}`),['PASSED:foundation']);
    assert.equal(result.action,'NEXT');
    assert.match(result.nextPrompt,/integration/);
    assert.match(result.summary,/carried forward PASSED: (foundation, renamed-baseline|renamed-baseline, foundation)/);
    const graph=f.ledger.graph(f.goal.id);
    const current=graph.plans.find(x=>x.status==='APPROVED')!;
    const items=graph.items.filter(x=>x.planId===current.id);
    assert.deepEqual(items.map(x=>`${x.key}:${x.status}`).sort(),
      ['foundation:PASSED','integration:IN_PROGRESS','renamed-baseline:PASSED']);
    const carried=items.find(x=>x.key==='foundation')!;
    assert.ok(carried.evidenceRefs.some(x=>x.startsWith('carried-from:')));
    assert.ok(graph.acceptance.filter(x=>x.itemId===carried.id).every(x=>x.status==='PASS'));
    assert.equal(graph.events.filter(x=>x.type==='goal.work_carried_forward').length,2);
    assert.throws(()=>f.ledger.carryForwardPassed(f.goal.id,
      items.find(x=>x.key==='integration')!.id,carried.id,'second-carry'),/pending work item/);
  }finally{f.close();}
});

test('next work prompt carries PI-reviewed established context, not raw prior answers',async()=>{
  const f=fixture();
  try{
    await review(f,1,'Initial proposal',planner());
    const raw='RAW-ASSISTANT-TEXT foundation done with migration 0007';
    const next=await review(f,2,raw,planner({verdict:'PASS'}));
    const prompt=goalWorkPrompt(f.store,f.mission.id,next,null,false).prompt;
    assert.match(prompt,/Work package: controller/);
    assert.match(prompt,/Established context \(PI-reviewed results of earlier packages; reference, not authority\)/);
    assert.match(prompt,/- PASSED foundation: Check persisted schema — PI reviewed cited execution evidence/);
    assert.ok(!prompt.includes('RAW-ASSISTANT-TEXT'),'Raw prior assistant text never leaks');
    assert.ok(prompt.indexOf('Established context')<prompt.indexOf('Current instruction:'));
  }finally{f.close();}
});

test('PI BLOCKED uses existing terminal decision without claiming Goal completion',async()=>{
  const f=fixture();
  try{
    await review(f,1,'Plan proposed',planner());
    const stopped=await review(f,2,'No access to required evidence',planner({verdict:'BLOCKED'}));
    assert.equal(stopped.action,'BLOCKED');
    assert.equal(stopped.nextPrompt,'');
    assert.equal(work(f,'foundation').status,'BLOCKED');
    assert.equal(f.ledger.getGoal(f.goal.id).status,'BLOCKED');
    assert.equal(f.store.piPlan(f.mission.id)?.action,'BLOCKED');
    assert.match(stopped.summary,/release when: Owner grants/);
    assert.match(JSON.stringify(f.ledger.graph(f.goal.id).events),/external_permission/);
    assert.equal(f.store.events(f.mission.id)
      .filter(x=>x.type==='pi.autopilot_finished').length,1);
    assert.equal(f.ledger.graph(f.goal.id).events.at(-1)?.type,'goal.status');
  }finally{f.close();}
});

test('external blocker defers only its work and continues an independent shipping lane',async()=>{
  const f=fixture();
  try{
    const plan={summary:'Security proof and independent purchase UI',items:[
      {key:'time-root',title:'Prove independent trusted clock',priority:100,
        description:'Qualify an available trust root',dependsOn:[],
        acceptance:['Cross-poweroff trusted time is proven on device']},
      {key:'purchase-ui',title:'Finish purchase flow',priority:90,
        description:'Implement and visually verify billing UI',dependsOn:[],
        acceptance:['Live sandbox purchase and restore are demonstrated']},
      {key:'release',title:'Release candidate',priority:80,
        description:'Ship only once security is proven',dependsOn:['time-root','purchase-ui'],
        acceptance:['Both mandatory gates passed before release']},
    ]};
    await review(f,1,'Initial delivery plan',planner({plan}));
    assert.equal(work(f,'time-root').status,'IN_PROGRESS');
    const next=await review(f,2,'Trust source not available on supported platform',
      planner({verdict:'BLOCKED'}));
    assert.equal(next.action,'NEXT');
    assert.match(next.nextPrompt,/purchase-ui/);
    assert.match(next.summary,/Deferred blocked time-root/);
    assert.equal(work(f,'time-root').status,'BLOCKED');
    assert.equal(work(f,'purchase-ui').status,'IN_PROGRESS');
    assert.equal(work(f,'release').status,'PENDING');
    assert.equal(f.ledger.getGoal(f.goal.id).status,'ACTIVE');
    assert.equal(f.store.events(f.mission.id).filter(e=>e.type==='chatgpt.browser_reserved').length,2,
      'The controller selects a next work package but never resends the observed turn');
    const outcomes:GoalReviewContext['priorWorkOutcomes']=[];
    const pi=planner({onReview:x=>outcomes.push(...x.priorWorkOutcomes??[])});
    const done=await review(f,3,'Purchase UI built and sandbox verified',pi);
    assert.equal(done.action,'BLOCKED','Release may not proceed through blocked security');
    assert.ok(outcomes.some(x=>x.key==='time-root'&&x.status==='BLOCKED'));
    assert.equal(work(f,'purchase-ui').status,'PASSED');
    assert.equal(work(f,'release').status,'PENDING');
    assert.equal(f.ledger.getGoal(f.goal.id).status,'BLOCKED');
  }finally{f.close();}
});

test('PI planning and review explicitly reject report churn while retaining release constraints',()=>{
  const planPrompt=goalPlanPrompt({objective:goalText,ownerAcceptance:['Trusted 72h'],
    browserAnswer:'Repeated old probe',responseSha256:sha('Repeated old probe'),
    ownerDirectives:[],priorWorkOutcomes:[{key:'time-root',title:'Trusted clock',status:'BLOCKED'}]});
  assert.match(planPrompt,/independent, authorized deliverables/);
  assert.match(planPrompt,/BLOCKED: time-root/);
  assert.match(planPrompt,/do not repeat BLOCKED capability searches/i);
  const reviewPrompt=goalReviewPrompt({objective:goalText,ownerAcceptance:['Trusted 72h'],
    browserAnswer:'Old report',responseSha256:sha('Old report'),ownerDirectives:[],
    planSummary:'Delivery',workItem:{id:'id',goalId:'goal',planId:'plan',
      key:'ui',title:'Implement purchase UI',description:'Ship functional UI',priority:90,
      status:'IN_PROGRESS',evidenceRefs:[],version:1,createdAt:'',updatedAt:''},
    acceptance:['Real purchase works'],priorWorkReviews:[]});
  assert.match(reviewPrompt,/Never ask to re-document, re-summarize, re-run unchanged tests/);
  assert.match(reviewPrompt,/it is not a way to restart or rename the current item/);
  assert.match(reviewPrompt,/transient outages are never BLOCKED/);
});

test('a claimed permanent blocker without an external cause and release condition cannot terminate the Goal',async()=>{
  const f=fixture();
  try{
    await review(f,1,'Plan proposed',planner());
    const invalid:PiPlanner={
      ...planner(),reviewGoalWork:async()=>({
        verdict:'BLOCKED',summary:'A normal unit test failed; nothing else was tried',
        nextPrompt:'',evidenceRefs:[],handoff:false,
      }),
    };
    await assert.rejects(review(f,2,'A failing test can be repaired',invalid),
      /PI BLOCKED lacks a specific external barrier/);
    assert.equal(f.ledger.getGoal(f.goal.id).status,'ACTIVE');
    assert.equal(work(f,'foundation').status,'IN_PROGRESS');
    assert.equal(f.store.piPlan(f.mission.id)?.round,1);
    assert.equal(f.store.events(f.mission.id).filter(e=>e.type==='chatgpt.browser_reserved').length,2);
    assert.equal(f.store.events(f.mission.id).filter(e=>e.type==='pi.decision').length,1);
    assert.equal(f.ledger.graph(f.goal.id).events.filter(e=>e.type==='goal.pi_review').length,0);
  }finally{f.close();}
});

test('PI PASS of the final package completes the Goal; afterwards no Goal write or Send is possible',async()=>{
  const f=fixture();
  try{
    await review(f,1,'Plan',planner());
    const finalFlags:boolean[]=[];
    const pi=planner({onReview:x=>finalFlags.push(Boolean(x.finalWorkItem))});
    await review(f,2,'Foundation done',pi);
    const done=await review(f,3,'Controller done',pi);
    assert.deepEqual(finalFlags,[false,true],'PI is told when it reviews the final package');
    assert.equal(done.action,'DONE');
    assert.match(done.summary,/Goal complete: all 2 planned work packages passed/);
    assert.equal(f.ledger.getGoal(f.goal.id).status,'DONE');
    assert.match(f.ledger.goalCompletion(f.goal.id)?.summary??'',/Final review: PI reviewed/);
    assert.equal(f.store.piPlan(f.mission.id)?.action,'DONE');
    assert.ok(f.ledger.graph(f.goal.id).events.some(e=>e.type==='goal.completed'));
    assert.throws(()=>f.ledger.completeGoal(f.goal.id,f.mission.id,sha('x'),'again'),/already completed/);
    assert.throws(()=>f.ledger.setGoalStatus(f.goal.id,f.ledger.getGoal(f.goal.id).version,
      'ACTIVE','reopen-done'),/Completed Goal is immutable|did not change/);
    const m=f.store.get(f.mission.id);
    assert.throws(()=>f.store.reserveChatBrowserTurn(f.mission.id,m.version,'after-done',sha('p')),
      /Goal completed/);
  }finally{f.close();}
});

test('the final-package review prompt states that PASS completes the Goal and REPLAN adds missing work',()=>{
  const graphItem={id:'i',goalId:'g',planId:'p',key:'last',title:'Last',description:'',priority:1,
    status:'IN_PROGRESS' as const,evidenceRefs:[],version:1,createdAt:'',updatedAt:''};
  const base={objective:'Ship it',ownerAcceptance:['Works'],browserAnswer:'done',
    responseSha256:sha('done'),ownerDirectives:[],planSummary:'p',workItem:graphItem,acceptance:['ok']};
  assert.match(goalReviewPrompt({...base,finalWorkItem:true}),/PASS here COMPLETES the owner Goal[\s\S]*choose REPLAN/);
  assert.doesNotMatch(goalReviewPrompt(base),/COMPLETES the owner Goal/);
});

test('a commitPiPlan conflict rolls back ALL Goal status and PI work review writes',async()=>{
  const f=fixture();
  try{
    const queued=f.observe(1,'Plan candidate');
    // This original PI decision deliberately occupies the same round.
    f.store.commitPiPlan(f.mission.id,queued.responseSha256,[],
      {action:'NEXT',summary:'Legacy already-reviewed checkpoint',nextPrompt:'Do not duplicate it'});
    const before=f.ledger.graph(f.goal.id);
    await assert.rejects(reviewGoalPiRound({...queued,planner:planner()}),
      /PI decision already exists/);
    assert.deepEqual(f.ledger.graph(f.goal.id),before,
      'The approved plan and current item cannot commit without the PI decision');
    assert.equal(f.store.events(f.mission.id).filter(x=>x.type==='pi.decision').length,1);
  }finally{f.close();}
});

test('planner failure, changed Mission ownership and conflicting owner notes never write a plan or Send',async()=>{
  const f=fixture();
  try{
    const turn=f.observe(1,'First response');
    const before=f.ledger.graph(f.goal.id);
    const unavailable:PiPlanner={decide:async()=>({action:'NEXT',summary:'fallback',nextPrompt:'go'})};
    await assert.rejects(reviewGoalPiRound({...turn,planner:unavailable}),/lacks Goal plan-review/);
    await assert.rejects(reviewGoalPiRound({...turn,planner:planner(),
      responseSha256:sha('wrong')}),/full observed browser SHA/);
    assert.deepEqual(f.ledger.graph(f.goal.id),before);
    const changes:PiPlanner=planner({onPlan:()=>{
      f.store.queuePiOwnerDirective(f.mission.id,'123','Pause until owner reviews new scope');
    }});
    await assert.rejects(reviewGoalPiRound({...turn,planner:changes}),/Owner updates changed/);
    assert.deepEqual(f.ledger.graph(f.goal.id),before);
    assert.equal(f.store.chatBrowserTurn(f.mission.id)?.status,'observed');
    assert.equal(f.store.events(f.mission.id).filter(e=>e.type==='chatgpt.browser_reserved').length,1);
  }finally{f.close();}
});

test('owner notes after plan selection revise PI NEXT without treating old answer as work PASS',async()=>{
  const f=fixture();
  try{
    const first=f.observe(1,'First analysis, not actual implementation');
    await reviewGoalPiRound({...first,planner:planner()});
    const initial=f.ledger.graph(f.goal.id);
    const queued=f.store.queuePiOwnerDirective(f.mission.id,'2401',
      'Prioritize the documented security checks within the selected item');
    assert.equal(queued,true);
    let reviews=0,decides=0;
    const revisedPlanner:PiPlanner={
      ...planner({onReview:()=>reviews++}),
      decide:async context=>{
        decides++;
        assert.equal(context.ownerDirectives.length,1);
        assert.deepEqual(context.acceptance,['Schema survives restart']);
        return {action:'NEXT',summary:'Owner priority included',
          nextPrompt:'Continue foundation work with explicit security checks'};
      },
    };
    const changed=await reviewGoalPiRound({...first,planner:revisedPlanner,
      replaceExisting:true,ownerDirectives:f.store.pendingPiOwnerDirectives(f.mission.id)});
    assert.equal(changed.action,'NEXT');
    assert.equal(decides,1);
    assert.equal(reviews,0);
    assert.equal(work(f,'foundation').status,'IN_PROGRESS');
    assert.equal(f.ledger.graph(f.goal.id).acceptance[0]?.status,'PENDING');
    assert.deepEqual(f.ledger.graph(f.goal.id),initial);
    assert.equal(f.store.pendingPiOwnerDirectives(f.mission.id).length,0);
    assert.equal(f.store.events(f.mission.id).filter(e=>e.type==='pi.decision_revised').length,1);
    assert.equal(f.store.events(f.mission.id).filter(e=>e.type==='chatgpt.browser_reserved').length,1);
  }finally{f.close();}
});

test('owner revision rejects a premature Goal DONE and preserves queued notes and PI selection',async()=>{
  const f=fixture();
  try{
    const first=f.observe(1,'Initial analysis');
    await reviewGoalPiRound({...first,planner:planner()});
    f.store.queuePiOwnerDirective(f.mission.id,'2402','Please review before continuing');
    const previous=f.ledger.graph(f.goal.id),existing=f.store.piPlan(f.mission.id);
    await assert.rejects(reviewGoalPiRound({...first,replaceExisting:true,
      ownerDirectives:f.store.pendingPiOwnerDirectives(f.mission.id),
      planner:{...planner(),decide:async()=>({action:'DONE',summary:'Unverified',nextPrompt:''})}}),
    /cannot turn a pending work package into Goal DONE/);
    assert.deepEqual(f.ledger.graph(f.goal.id),previous);
    assert.deepEqual(f.store.piPlan(f.mission.id),existing);
    assert.equal(f.store.pendingPiOwnerDirectives(f.mission.id).length,1);
  }finally{f.close();}
});

test('restart reuses persisted PI decision and Goal review without duplicate planning',async()=>{
  const f=fixture();
  let reopened:Store|undefined;
  try{
    await review(f,1,'First plan',planner());
    const first=f.ledger.graph(f.goal.id);
    reopened=new Store(f.file);
    const ledger=new GoalLedger(reopened);
    assert.deepEqual(ledger.graph(f.goal.id),first);
    assert.equal(ledger.missionGoalId(f.mission.id),f.goal.id);
    assert.equal(reopened.piPlan(f.mission.id)?.action,'NEXT');
    assert.equal(reopened.get(f.mission.id).turnCount,1);
    assert.deepEqual(reopened.events(f.mission.id),f.store.events(f.mission.id));
    const before=ledger.graph(f.goal.id).events.length;
    assert.deepEqual(ledger.bindPiMission(f.goal.id,f.mission.id,f.mission.version,'bind-goal-1'),f.goal.id);
    assert.equal(ledger.graph(f.goal.id).events.length,before);
  }finally{reopened?.close();f.close();}
});

test('Goal binding rejects foreign scope, active Send or a second Goal; legacy PI remains unaffected',()=>{
  const f=fixture();
  try{
    const other=f.ledger.createGoal({requestKey:'other-owner',objective:'different goal',priority:90});
    assert.throws(()=>f.ledger.bindPiMission(other.id,f.mission.id,f.mission.version,'wrong-scope'),
      /exact owner goal/);
    assert.equal(f.ledger.missionGoalId(f.mission.id),f.goal.id);
    const competing=f.store.create({goal:goalText,acceptance:['Same owner scope'],
      checks:[],workspace:'',sandbox:'read-only',mode:'supervised',
      requestKey:'competing-goal-pi'});
    f.store.setMeta(`pi.autopilot.enabled.${competing.id}`,'1');
    assert.throws(()=>f.ledger.bindPiMission(f.goal.id,competing.id,competing.version,
      'competing-goal'),/already has a live PI Mission root/);
    assert.equal(f.store.getMeta(`goal.pi.binding.${competing.id}`),null);
    const legacy=f.store.create({goal:'Read-only audit',acceptance:['Report'],
      checks:[],workspace:'',sandbox:'read-only',mode:'supervised',requestKey:'legacy-pi'});
    assert.equal(f.ledger.missionGoalId(legacy.id),null);
    assert.throws(()=>f.ledger.bindPiMission(f.goal.id,legacy.id,legacy.version,'other-bind'),
      /unstarted PI Mission/);
    assert.equal(f.store.getMeta(`goal.pi.binding.${legacy.id}`),null);
  }finally{f.close();}
});

test('strict Goal PI JSON rejects non-JSON, ungrounded PASS and bad response shapes',()=>{
  assert.throws(()=>parseGoalPlanProposal('OK'),/strict JSON/);
  assert.throws(()=>parseGoalPlanProposal(JSON.stringify({summary:'invalid',items:[]})),/Invalid PI Goal plan/);
  assert.deepEqual(parseGoalPlanProposal(JSON.stringify(proposed)),proposed);
  assert.throws(()=>parseGoalReview(JSON.stringify({verdict:'DONE',summary:'done',
    nextPrompt:'',evidenceRefs:[],handoff:false})),/Invalid PI work review/);
  assert.throws(()=>parseGoalReview(JSON.stringify({verdict:'PASS',summary:'done',
    nextPrompt:'',evidenceRefs:[],handoff:false})),/Invalid PI work review/);
  const result=parseGoalReview(JSON.stringify({verdict:'FAIL',summary:'broken',
    nextPrompt:'Fix failing test',evidenceRefs:['ci:broken'],handoff:true}));
  assert.equal(result.verdict,'FAIL');
  assert.throws(()=>parseGoalReview(JSON.stringify({verdict:'BLOCKED',summary:'external',
    nextPrompt:'',evidenceRefs:[],handoff:false})),/PI BLOCKED requires/);
  const blocked=parseGoalReview(JSON.stringify({verdict:'BLOCKED',summary:'access denied',
    nextPrompt:'',evidenceRefs:['ops:denied'],handoff:false,
    blocker:{kind:'external_permission',evidence:'SSH access denied',
      releaseCondition:'Owner grants read-only SSH source access'}}));
  assert.equal(blocked.blocker?.releaseCondition,'Owner grants read-only SSH source access');
  assert.throws(()=>parseGoalReview(JSON.stringify({verdict:'PARTIAL',summary:'code test failed',
    nextPrompt:'Fix the test',evidenceRefs:[],handoff:false,
    blocker:{kind:'external_dependency',evidence:'none',releaseCondition:'later'}})),
  /Nonterminal PI verdict/);
  assert.match(goalPlanPrompt({objective:goalText,browserAnswer:'Untrusted answer',
    ownerAcceptance:['Independent release test'],
    responseSha256:sha('Untrusted answer'),ownerDirectives:[]}),/Untrusted prior browser/);
  assert.doesNotMatch(goalPlanPrompt({objective:goalText,browserAnswer:'Initial intake',
    ownerAcceptance:[],responseSha256:sha('Initial intake'),ownerDirectives:[]}),
    /CURRENT CONTROLLER FACT/);
  const input={objective:goalText,browserAnswer:'Candidate',
    responseSha256:sha('Candidate'),ownerDirectives:[],
    ownerAcceptance:['Independent release test'],
    planSummary:'Plan',workItem:{id:'123',goalId:'1',planId:'2',key:'key',
      title:'Title',description:'Desc',priority:90,status:'IN_PROGRESS' as const,
      evidenceRefs:[],version:1,createdAt:'',updatedAt:''},acceptance:['Check']};
  assert.match(goalReviewPrompt(input),/EVIDENCE STANDARD/);
  assert.match(goalReviewPrompt(input),/code, test, build or CI failures and transient outages are never BLOCKED/);
});

test('failure to make a safe work prompt atomically rolls back first approval and PI decision',async()=>{
  const f=fixture();
  try{
    const answer=f.observe(1,'First plan needs long description');
    const huge={summary:'Impossible package',items:[
      {key:'huge',title:'Large package',description:'A'.repeat(2000),
        priority:99,dependsOn:[],acceptance:['Check the result']},
    ]};
    await assert.rejects(reviewGoalPiRound({...answer,planner:planner({plan:huge})}),
      /1500-character executor directive/);
    assert.deepEqual(f.ledger.graph(f.goal.id).plans,[]);
    assert.equal(f.ledger.getGoal(f.goal.id).version,1);
    assert.equal(f.store.piPlan(f.mission.id),null);
    assert.equal(f.store.events(f.mission.id)
      .filter(x=>x.type==='chatgpt.browser_reserved').length,1);
    assert.equal(f.store.chatBrowserTurn(f.mission.id)?.status,'observed');
  }finally{f.close();}
});

// The Worker gates on wall time, so WAIT tests are anchored to it.
const T0=Math.floor(Date.now()/1000)*1000,DUE=T0+2*60*60_000;
const iso=(ms:number)=>new Date(ms).toISOString();
const waitPlanner=(resumeAt:string,onReview?:(x:GoalReviewContext)=>void):PiPlanner=>({
  ...planner(),
  reviewGoalWork:async x=>{onReview?.(x);return {verdict:'WAIT',
    summary:'The 2 h device run is still recording; its result is due at 23:55 UTC',
    nextPrompt:'Collect the terminal record of the running 720p session; do not restart it',
    evidenceRefs:[],handoff:false,resumeAt};},
});
const lanes={summary:'Long device run and an independent store lane',items:[
  {key:'endurance',title:'Two-hour device run',priority:100,description:'Run the long session',
    dependsOn:[],acceptance:['Receiver decodes 7200 s']},
  {key:'store',title:'Store listing',priority:90,description:'Save listing text',
    dependsOn:[],acceptance:['Listing saved and read back']},
]};

test('PI WAIT for a running process runs independent work now and never re-sends the waiting package early',async()=>{
  const f=fixture();
  try{
    await reviewGoalPiRound({...f.observe(1,'Plan'),planner:planner({plan:lanes}),now:()=>T0});
    assert.equal(work(f,'endurance').status,'IN_PROGRESS');
    const seen:string[]=[];
    const waited=await reviewGoalPiRound({...f.observe(2,'Run started, 1363/7200 s so far'),
      planner:waitPlanner(iso(DUE),x=>seen.push(x.controllerTime??'')),now:()=>T0});
    assert.equal(seen[0],new Date(T0).toISOString(),'PI is told the controller clock');
    assert.equal(waited.action,'NEXT');
    assert.equal(waited.summary.startsWith(`PI WAIT for endurance until ${iso(DUE)}; PI selected store`),true);
    assert.match(waited.nextPrompt,/store/);
    assert.equal(work(f,'endurance').status,'READY');
    assert.equal(work(f,'store').status,'IN_PROGRESS');
    assert.equal(f.store.piDispatchNotBefore(f.mission.id),0,'independent work is not fenced');
    assert.equal(f.ledger.graph(f.goal.id).plans.length,1,'WAIT is not a REPLAN');
    // Independent work passes before the run ends: only the waiting package
    // remains, so it is selected with its resume instruction behind a fence.
    const t1=T0+10*60_000;
    const fenced=await reviewGoalPiRound({...f.observe(3,'Listing saved'),planner:planner(),now:()=>t1});
    assert.equal(fenced.action,'NEXT');
    assert.equal(fenced.summary,`PI WAIT: no other eligible work; endurance resumes after ${iso(DUE)}`);
    assert.equal(fenced.nextPrompt,'Collect the terminal record of the running 720p session; do not restart it');
    assert.equal(work(f,'endurance').status,'IN_PROGRESS');
    assert.equal(f.store.piDispatchNotBefore(f.mission.id),DUE);
    assert.match(goalWorkPrompt(f.store,f.mission.id,fenced,null,false).prompt,
      /Current instruction:\nCollect the terminal record/);
    assert.equal(f.store.events(f.mission.id).filter(e=>e.type==='chatgpt.browser_reserved').length,3);
    // The resumed answer is reviewed normally; PASS consumes the deferral.
    const history:GoalReviewContext['priorWorkReviews']=[];
    const done=await reviewGoalPiRound({...f.observe(4,'7204 s decoded, normal stop'),
      planner:planner({onReview:x=>history.push(...x.priorWorkReviews??[])}),
      now:()=>DUE+60_000});
    assert.ok(history.some(x=>x.verdict==='WAIT'),'PI sees its earlier WAIT');
    assert.equal(done.action,'DONE');
    assert.equal(f.store.piDispatchNotBefore(f.mission.id),0);
  }finally{f.close();}
});

test('PI WAIT is clamped to its window and a fenced checkpoint releases the browser without a Send',async()=>{
  const f=fixture();
  try{
    await reviewGoalPiRound({...f.observe(1,'Plan'),planner:planner(),now:()=>T0});
    const soon=await reviewGoalPiRound({...f.observe(2,'Still running'),
      planner:waitPlanner(iso(T0+30_000)),now:()=>T0});
    assert.equal(soon.action,'NEXT');
    assert.equal(work(f,'foundation').status,'IN_PROGRESS');
    assert.equal(f.store.piDispatchNotBefore(f.mission.id),T0+5*60_000,'no 30-second polling');
    await reviewGoalPiRound({...f.observe(3,'Still running, second sample'),
      planner:waitPlanner(iso(T0+30*24*60*60_000)),now:()=>T0});
    assert.equal(f.store.piDispatchNotBefore(f.mission.id),T0+12*60*60_000,'no indefinite parking');
    assert.equal(f.store.piHealth(T0).missions[0]?.phase,'pi_wait_scheduled_no_send');
    const untouched=new Proxy({},{get(){throw new Error('browser must not be touched while fenced');}}) as Page;
    await drivePiAutopilot({store:f.store,planner:planner(),missionId:f.mission.id,
      revision:f.store.get(f.mission.id).version,requestPrefix:'mission-one',
      page:untouched,url:URL,yieldAtGoalCheckpoint:true});
    assert.equal(f.store.events(f.mission.id).filter(e=>e.type==='chatgpt.browser_reserved').length,3);
    // An owner note means "act now": PI revises the decision and the fence lifts.
    f.store.queuePiOwnerDirective(f.mission.id,'2402','The run ended early, check it now');
    const revised:PiPlanner={...planner(),decide:async()=>({action:'NEXT',
      summary:'Owner says the run ended',nextPrompt:'Collect the terminal record now'})};
    await reviewGoalPiRound({store:f.store,planner:revised,missionId:f.mission.id,
      responseSha256:sha('Still running, second sample'),lastAssistant:'Still running, second sample',round:3,
      replaceExisting:true,ownerDirectives:f.store.pendingPiOwnerDirectives(f.mission.id)});
    assert.equal(f.store.piDispatchNotBefore(f.mission.id),0);
  }finally{f.close();}
});

test('strict PI WAIT requires an offset resume time and an instruction; other verdicts cannot carry one',()=>{
  const base={verdict:'WAIT',summary:'Run in progress',nextPrompt:'Collect the result',
    evidenceRefs:[],handoff:false};
  assert.equal(parseGoalReview(JSON.stringify({...base,resumeAt:'2026-11-24T07:55:32+08:00'})).resumeAt,
    '2026-11-24T07:55:32+08:00');
  assert.throws(()=>parseGoalReview(JSON.stringify({...base,resumeAt:'2026-11-24 07:55'})),/PI WAIT requires resumeAt/);
  assert.throws(()=>parseGoalReview(JSON.stringify({...base,resumeAt:'2026-11-24T07:55:32'})),/PI WAIT requires resumeAt/);
  assert.throws(()=>parseGoalReview(JSON.stringify(base)),/PI WAIT requires resumeAt/);
  assert.throws(()=>parseGoalReview(JSON.stringify({...base,nextPrompt:'',
    resumeAt:'2026-11-24T07:55:32Z'})),/Invalid PI work review/);
  assert.throws(()=>parseGoalReview(JSON.stringify({...base,verdict:'PARTIAL',
    resumeAt:'2026-11-24T07:55:32Z'})),/Only a PI WAIT/);
  assert.equal(parseGoalReview(JSON.stringify({...base,verdict:'PARTIAL',resumeAt:null})).verdict,'PARTIAL');
  const input={objective:goalText,browserAnswer:'Candidate',responseSha256:sha('Candidate'),
    ownerDirectives:[],ownerAcceptance:[],planSummary:'Plan',acceptance:['Check'],
    controllerTime:'2026-11-23T21:40:00.000Z',
    workItem:{id:'1',goalId:'1',planId:'2',key:'k',title:'T',description:'D',priority:90,
      status:'IN_PROGRESS' as const,evidenceRefs:[],version:1,createdAt:'',updatedAt:''}};
  assert.match(goalReviewPrompt(input),/Never use REPLAN or PARTIAL to wait or poll/);
  assert.match(goalReviewPrompt(input),/Current controller time \(UTC\): 2026-11-23T21:40:00.000Z/);
});
