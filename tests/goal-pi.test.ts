import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Page} from 'playwriter';
import {Store} from '../src/core/store.js';
import {GoalLedger} from '../src/core/goal-store.js';
import {parseGoalPlanProposal,parseGoalReview,goalPlanPrompt,goalReviewPrompt,
  reviewGoalPiRound,type GoalPlanContext,type GoalReviewContext} from '../src/core/goal-pi.js';
import {drivePiAutopilot} from '../src/core/pi-autopilot.js';
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
    checks:[],workspace:'',sandbox:'read-only',mode:'supervised',maxTurns:32,requestKey:'mission-one'});
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
      evidenceRefs:args.evidenceRefs??['git:1234','ci:5678']};
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
    assert.equal(work(f,'foundation').status,'BLOCKED');
    assert.equal(work(f,'replacement').status,'IN_PROGRESS');
    assert.ok(graph.events.some(x=>x.type==='goal.pi_review'&&x.payload.verdict==='REPLAN'));
    assert.equal(f.store.events(f.mission.id).filter(x=>x.type==='pi.decision').length,2);
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
    assert.equal(f.store.events(f.mission.id)
      .filter(x=>x.type==='pi.autopilot_finished').length,1);
    assert.equal(f.ledger.graph(f.goal.id).events.at(-1)?.type,'goal.status');
  }finally{f.close();}
});

test('a reported all-packages PASS still cannot declare owner Goal DONE',async()=>{
  const f=fixture();
  try{
    await review(f,1,'Plan',planner());
    await review(f,2,'Foundation done',planner());
    const pending=await review(f,3,'Controller done',planner());
    assert.equal(pending.action,'BLOCKED');
    assert.match(pending.summary,/independent release acceptance/i);
    assert.equal(f.ledger.graph(f.goal.id).items.every(x=>x.status==='PASSED'),true);
    assert.equal(f.ledger.getGoal(f.goal.id).status,'ACTIVE');
    assert.notEqual(f.store.piPlan(f.mission.id)?.action,'DONE');
  }finally{f.close();}
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

test('Goal binding follows the existing 32-turn Mission successor rather than creating a new Goal',()=>{
  const f=fixture();
  try{
    const initial=f.store.get(f.mission.id);
    const nearLimit=f.store.update(initial.id,initial.version,{state:'PAUSED',turnCount:31},
      'test.synthetic_prior_31_observed');
    const answer='Verified parent checkpoint at turn 32';
    const requestKey='goal-parent-last';
    f.store.reserveChatBrowserTurn(initial.id,nearLimit.version,requestKey,sha('last user prompt'));
    f.store.finishChatBrowserTurn(initial.id,requestKey,{
      kind:'observed',assistantSha256:sha(answer),summary:answer,
      telegramBatch:{terminal:true,flowSignal:'NEXT',piManaged:true},
    });
    f.store.commitPiPlan(initial.id,sha(answer),[],{
      action:'NEXT',summary:'One work item requires a successor Mission',
      nextPrompt:'Continue the selected work item'});
    const child=f.store.createPiSuccessor(initial.id);
    assert.ok(child);
    assert.equal(f.ledger.missionGoalId(child.id),f.goal.id);
    assert.equal(f.store.piChainParent(child.id),initial.id);
    assert.equal(f.store.getMeta(`goal.pi.binding.${child.id}`),null,
      'The existing reciprocal lineage is the authority; do not fork Goal bindings');
    assert.equal(f.ledger.graph(f.goal.id).goal.id,f.goal.id);
    assert.equal(f.ledger.listGoals().length,1);
    assert.equal(f.store.createPiSuccessor(initial.id)?.id,child.id,
      'Restart must reuse the existing successor, not create another Mission');
  }finally{f.close();}
});

test('Goal binding rejects foreign scope, active Send or a second Goal; legacy PI remains unaffected',()=>{
  const f=fixture();
  try{
    const other=f.ledger.createGoal({requestKey:'other-owner',objective:'different goal',priority:90});
    assert.throws(()=>f.ledger.bindPiMission(other.id,f.mission.id,f.mission.version,'wrong-scope'),
      /exact owner goal/);
    assert.equal(f.ledger.missionGoalId(f.mission.id),f.goal.id);
    const competing=f.store.create({goal:goalText,acceptance:['Same owner scope'],
      checks:[],workspace:'',sandbox:'read-only',mode:'supervised',maxTurns:2,
      requestKey:'competing-goal-pi'});
    f.store.setMeta(`pi.autopilot.enabled.${competing.id}`,'1');
    assert.throws(()=>f.ledger.bindPiMission(f.goal.id,competing.id,competing.version,
      'competing-goal'),/already has a live PI Mission root/);
    assert.equal(f.store.getMeta(`goal.pi.binding.${competing.id}`),null);
    const legacy=f.store.create({goal:'Read-only audit',acceptance:['Report'],
      checks:[],workspace:'',sandbox:'read-only',mode:'supervised',maxTurns:2,requestKey:'legacy-pi'});
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
  assert.match(goalPlanPrompt({objective:goalText,browserAnswer:'Untrusted answer',
    ownerAcceptance:['Independent release test'],
    responseSha256:sha('Untrusted answer'),ownerDirectives:[]}),/Untrusted prior browser/);
  const input={objective:goalText,browserAnswer:'Candidate',
    responseSha256:sha('Candidate'),ownerDirectives:[],
    ownerAcceptance:['Independent release test'],
    planSummary:'Plan',workItem:{id:'123',goalId:'1',planId:'2',key:'key',
      title:'Title',description:'Desc',priority:90,status:'IN_PROGRESS' as const,
      evidenceRefs:[],version:1,createdAt:'',updatedAt:''},acceptance:['Check']};
  assert.match(goalReviewPrompt(input),/independent evidence verification/);
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
