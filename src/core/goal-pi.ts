import {createHash} from 'node:crypto';
import type {Store,PiPlan,PiOwnerDirective} from './store.js';
import {GoalLedger,activeWorkItem,openWorkDeferrals,type GoalGraph,type GoalWorkItem,
  type CreateGoalPlan,type PlannedWork} from './goal-store.js';
import {PiInferenceError,inferPi,type PiPlanner} from './pi-planner.js';
import {CI_PI_POLICY} from './ci-policy.js';

/** The existing PI controller remains the only browser Send authority.
 * This module supplies its opt-in, transactionally committed Goal decisions;
 * it never opens a tab, reserves a Send, or claims business verification. */
export interface GoalPlanProposal {summary:string;items:PlannedWork[]}
export interface GoalBlocker {
  kind:'external_permission'|'unrecoverable_evidence'|'external_dependency';
  evidence:string;releaseCondition:string;
}
export interface GoalReview {
  verdict:'PASS'|'PARTIAL'|'FAIL'|'REPLAN'|'BLOCKED'|'WAIT';
  summary:string;nextPrompt:string;evidenceRefs:string[];handoff:boolean;
  /** WAIT only: ISO-8601 time (with offset) before which the package must not
   * be dispatched again. The controller clamps it to its WAIT window. */
  resumeAt?:string;
  /** Required only for a terminal BLOCKED verdict. PI claims do not attest
   * that the cited external condition was independently checked. */
  blocker?:GoalBlocker;
}
export interface GoalPlanContext {
  objective:string;ownerAcceptance:string[];browserAnswer:string;responseSha256:string;
  ownerDirectives:PiOwnerDirective[];
  /** Durable Goal history, not a claim that the underlying external barrier was verified. */
  priorWorkOutcomes?:Array<{key:string;title:string;status:'PASSED'|'BLOCKED'}>;
  /** The plan being revised (REPLAN only): keys are stable identities across plans. */
  currentPlan?:Array<{key:string;title:string;status:string;acceptance:string[]}>;
  /** Trusted local SQLite state sampled after the browser reply, NOT a Git/CI or deployment attestation. */
  controllerCheckpoint?:GoalControllerCheckpoint;
}
export interface GoalControllerCheckpoint {
  round:number;missionState:string;stopRequested:boolean;
  receiptStatus:'observed'|'reconciled';reservationEventId:number;observationEventId:number;
  answerSha256:string;independentlyRecovered:boolean;
}
export interface GoalReviewContext extends GoalPlanContext {
  planSummary:string;workItem:GoalWorkItem;acceptance:string[];
  /** Earlier PI reviews of this work item key (any plan), oldest first. */
  priorWorkReviews?:Array<{round:number;verdict:GoalReview['verdict'];summary?:string}>;
  /** True when every other package of the approved plan already PASSED. */
  finalWorkItem?:boolean;
  /** Controller wall clock (UTC ISO) when the review prompt was built. */
  controllerTime?:string;
}
/** A PI WAIT defers re-dispatch of its package by at least this long and at
 * most this long; anything else is clamped, so WAIT can neither spin nor
 * park a Goal indefinitely (it is reviewed again when the window ends). */
export const MIN_WORK_WAIT_MS=5*60_000,MAX_WORK_WAIT_MS=12*60*60_000;
/** Durable per-Mission dispatch fence (read by Store.piDispatchNotBefore). */
const piDispatchAfterKey=(missionId:string)=>`pi.dispatch.after.${missionId}`;
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const limitAnswer=(answer:string)=>answer.length<=100_000?answer:
  answer.slice(0,50_000)+'\n[MIDDLE OMITTED: not verified]\n'+answer.slice(-50_000);
function controllerCheckpointPrompt(checkpoint:GoalControllerCheckpoint|undefined):string[]{
  if(!checkpoint)return [];
  return [
    'CURRENT AUTHORITATIVE CONTROLLER CHECKPOINT (local SQLite; sampled after the assistant answer):',
    `Mission state: ${checkpoint.missionState}; pause requested: ${checkpoint.stopRequested}; observed round: ${checkpoint.round}.`,
    `Exact original browser reservation event: #${checkpoint.reservationEventId}; settled observation event: #${checkpoint.observationEventId}.`,
    `Browser receipt: ${checkpoint.receiptStatus}; answer SHA-256: ${checkpoint.answerSha256}; independently recovered: ${checkpoint.independentlyRecovered}.`,
    'This specific round is durably settled. The preceding browser answer may describe an OLDER',
    'RUNNING/reserved/paused/maintenance-blocked state. Do not treat those historical statements',
    'as current blockers or declare BLOCKED solely because they were true when the answer was written.',
    'This checkpoint does NOT verify current maintenance gate, worker binary, Git/CI, deployment,',
    'other Missions, or business acceptance. Those require separate current independent evidence.',
  ];
}
function verifiedControllerCheckpoint(store:Store,missionId:string,round:number,
  responseSha256:string):GoalControllerCheckpoint {
  const mission=store.get(missionId),receipt=store.chatBrowserTurn(missionId);
  if(mission.turnCount!==round||!receipt||
     !['observed','reconciled'].includes(receipt.status)||
     receipt.assistantSha256!==responseSha256||
     !store.hasVerifiedPiBrowserCheckpoint(missionId))
    throw new Error('PI controller checkpoint is not a verified settled browser round');
  const events=store.events(missionId);
  const reservation=events.filter(e=>e.type==='chatgpt.browser_reserved'&&
    (e.payload as {requestKey?:string}).requestKey===receipt.requestKey&&
    (e.payload as {promptSha256?:string}).promptSha256===receipt.promptSha256).at(-1);
  const observation=events.filter(e=>
    ['chatgpt.browser_observed','chatgpt.browser_turn_recovered',
      'chatgpt.browser_rollover_recovered'].includes(e.type)&&
    (e.payload as {requestKey?:string}).requestKey===receipt.requestKey&&
    (e.payload as {assistantSha256?:string}).assistantSha256===responseSha256&&
    (e.payload as {round?:number}).round===round).at(-1);
  if(!reservation||!observation||observation.id<=reservation.id)
    throw new Error('PI controller checkpoint lacks matching immutable reservation/observation events');
  return {round,missionState:mission.state,stopRequested:mission.stopRequested,
    receiptStatus:receipt.status as 'observed'|'reconciled',
    reservationEventId:reservation.id,observationEventId:observation.id,
    answerSha256:responseSha256,independentlyRecovered:receipt.status==='reconciled'};
}
function jsonObject(source:string):Record<string,unknown>{
  const normalized=source.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
  let raw:unknown;
  try{raw=JSON.parse(normalized);}catch{throw new Error('PI Goal decision must be strict JSON');}
  if(!raw||typeof raw!=='object'||Array.isArray(raw))
    throw new Error('PI Goal decision must be an object');
  return raw as Record<string,unknown>;
}
/** Work-item keys are identities, so the controller owns their grammar: a
 * model's key is normalized rather than rejected (a rejected key used to
 * interrupt the whole Goal). Dependencies follow the same mapping. */
export function normalizeWorkKey(value:string,fallback:string):string{
  const key=value.toLowerCase().replace(/[^a-z0-9._:-]+/g,'-').replace(/-{2,}/g,'-')
    .replace(/^[^a-z0-9]+/,'').slice(0,64).replace(/[-.:]+$/,'');
  return key||fallback;
}
export function parseGoalPlanProposal(source:string):GoalPlanProposal{
  const raw=jsonObject(source);
  if(typeof raw.summary!=='string'||!raw.summary.trim()||raw.summary.length>5000||
    !Array.isArray(raw.items)||raw.items.length<1||raw.items.length>50)
    throw new Error('Invalid PI Goal plan');
  const items=raw.items.map((input:unknown)=>{
    if(!input||typeof input!=='object'||Array.isArray(input))
      throw new Error('Invalid PI work item');
    const item=input as Record<string,unknown>;
    if(typeof item.key!=='string'||typeof item.title!=='string'||
      typeof item.priority!=='number'||!Number.isInteger(item.priority)||
      item.priority<0||item.priority>100||
      typeof item.description!=='string'||!Array.isArray(item.acceptance)||
      item.acceptance.some(x=>typeof x!=='string')||
      !Array.isArray(item.dependsOn)||item.dependsOn.some(x=>typeof x!=='string'))
      throw new Error('Invalid PI work item fields');
    return {key:item.key,title:item.title,description:item.description,
      priority:item.priority,acceptance:item.acceptance as string[],
      dependsOn:item.dependsOn as string[]} satisfies PlannedWork;
  });
  const mapped=new Map<string,string>(),used=new Set<string>();
  for(const [i,item] of items.entries()){
    let key=normalizeWorkKey(item.key,`item-${i+1}`);
    for(let n=2;used.has(key);n++)key=`${normalizeWorkKey(item.key,`item-${i+1}`).slice(0,60)}-${n}`;
    used.add(key);if(!mapped.has(item.key))mapped.set(item.key,key);item.key=key;
  }
  // A dependency on a key the plan does not define cannot be scheduled; drop
  // it instead of failing the whole plan (the ledger still rejects cycles).
  for(const item of items)item.dependsOn=[...new Set(item.dependsOn.map(dep=>
    mapped.get(dep)??normalizeWorkKey(dep,'')))].filter(dep=>dep!==item.key&&used.has(dep));
  return {summary:raw.summary.trim(),items};
}
export function parseGoalReview(source:string):GoalReview{
  const raw=jsonObject(source);
  if(!['PASS','PARTIAL','FAIL','REPLAN','BLOCKED','WAIT'].includes(String(raw.verdict))||
    typeof raw.summary!=='string'||!raw.summary.trim()||raw.summary.length>1000||
    typeof raw.nextPrompt!=='string'||raw.nextPrompt.length>1500||
    typeof raw.handoff!=='boolean'||!Array.isArray(raw.evidenceRefs)||
    raw.evidenceRefs.length>30||
    raw.evidenceRefs.some(x=>typeof x!=='string'||!x.trim()||x.length>512)||
    (raw.verdict==='PASS'&&raw.evidenceRefs.length===0)||
    (['PARTIAL','FAIL','WAIT'].includes(String(raw.verdict))&&!raw.nextPrompt.trim())||
    (['REPLAN','BLOCKED'].includes(String(raw.verdict))&&raw.nextPrompt.trim()))
    throw new Error('Invalid PI work review');
  const resumeAt=raw.resumeAt;
  if(raw.verdict==='WAIT'&&(typeof resumeAt!=='string'||resumeAt.length>40||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(resumeAt)||
    !Number.isFinite(Date.parse(resumeAt))))
    throw new Error('PI WAIT requires resumeAt as an ISO-8601 time with a UTC offset');
  if(raw.verdict!=='WAIT'&&resumeAt!==undefined&&resumeAt!==null)
    throw new Error('Only a PI WAIT may declare resumeAt');
  const blocker=raw.blocker;
  if(raw.verdict==='BLOCKED'&&!validGoalBlocker(blocker))
    throw new Error('PI BLOCKED requires a concrete external barrier, evidence and release condition');
  if(raw.verdict!=='BLOCKED'&&blocker!==undefined&&blocker!==null)
    throw new Error('Nonterminal PI verdict must not declare an external blocker');
  return {verdict:raw.verdict as GoalReview['verdict'],summary:raw.summary.trim(),
    nextPrompt:raw.nextPrompt.trim(),evidenceRefs:raw.evidenceRefs as string[],
    handoff:raw.handoff,
    ...(raw.verdict==='BLOCKED'?{blocker:blocker as GoalBlocker}:{}),
    ...(raw.verdict==='WAIT'?{resumeAt:resumeAt as string}:{})};
}
function validGoalBlocker(value:unknown):value is GoalBlocker {
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const blocker=value as Record<string,unknown>;
  return ['external_permission','unrecoverable_evidence','external_dependency']
    .includes(String(blocker.kind))&&
    typeof blocker.evidence==='string'&&!!blocker.evidence.trim()&&blocker.evidence.length<=240&&
    typeof blocker.releaseCondition==='string'&&
    !!blocker.releaseCondition.trim()&&blocker.releaseCondition.length<=240;
}
export function goalPlanPrompt(input:GoalPlanContext):string{
  return [
    'You are PI, the project manager, not the browser executor. Return strict JSON only.',
    'The owner Goal is authoritative. Build a bounded, implementable plan with work-item keys,',
    'priority (0-100), dependencies (within this plan), concrete acceptance criteria and scope.',
    'Optimize for a shipped, independently verifiable product rather than number of browser turns.',
    'Prefer direct implementation, targeted source-delta tests, native device UX and real purchase',
    'verification over repeated baseline audits, feasibility memos or new documentation files.',
    'Treat genuinely external blocked capabilities as explicit dependencies, not invitations to',
    'rename and repeat identical probes. Schedule independent, authorized deliverables in parallel',
    'work lanes (one browser Send at a time), even if final publication is still gated.',
    'Never silently relax the owner acceptance contract or mark an unverified blocker as solved.',
    'The executor answer is a report, not proof: plan from its concrete facts, never from a DONE marker.',
    'You have no tools; never invent evidence or results.',
    'Return {"summary":"...","items":[{"key":"stable-key","title":"...","description":"...",',
    '"priority":80,"dependsOn":["prior-key"],"acceptance":["checkable criterion"]}]}',
    'Require at least one item, at most 50, and an acyclic dependency graph.',
    'Keep each item description and acceptance compact enough for one 1500-character work prompt.',
    ...CI_PI_POLICY,
    `Owner Goal: ${input.objective}`,
    'Original owner acceptance requirements:',...input.ownerAcceptance,
    `Observed complete assistant SHA-256: ${input.responseSha256}`,
    'Authenticated pending owner directives:',
    ...input.ownerDirectives.map(x=>x.text),
    'Previous controller-recorded work outcomes (not external verification):',
    ...(input.priorWorkOutcomes?.length?input.priorWorkOutcomes.map(x=>
      `${x.status}: ${x.key} — ${x.title}`):['none']),
    'Do not recreate PASSED work; do not repeat BLOCKED capability searches without new concrete',
    'deployable evidence or an owner-approved changed requirement. Advance independent work.',
    'Any item reusing a PASSED key, or an identical acceptance obligation, is recorded as already',
    'PASSED automatically. Reuse an exact key only for the same obligation; plan no re-verification',
    'of baselines, cost gates or features that already passed.',
    ...(input.currentPlan?.length?[
      'REVISION OF THE CURRENT PLAN. Change only what the latest result requires.',
      'Keep the exact key of every item whose obligation continues (including the unfinished',
      'active item); a key is its identity across plans. Never rename an item to restart it.',
      'Add new keys only for genuinely new work; drop items that are no longer needed.',
      'Current plan (key — status — title — acceptance):',
      ...input.currentPlan.map(x=>`- ${x.key} — ${x.status} — ${x.title} — ${x.acceptance.join('; ')}`.slice(0,600)),
    ]:[]),
    'Untrusted prior browser response:',
    limitAnswer(input.browserAnswer),
    ...controllerCheckpointPrompt(input.controllerCheckpoint),
  ].join('\n');
}
export function goalReviewPrompt(input:GoalReviewContext):string{
  const prior=input.priorWorkReviews??[];
  const nonPass=prior.filter(review=>review.verdict==='PARTIAL'||review.verdict==='FAIL').length;
  return [
    'You are PI, the project manager and acceptance reviewer, not the executor.',
    'Review the ONE active work item against its acceptance criteria and the executor report.',
    ...CI_PI_POLICY,
    'Return strict JSON: {"verdict":"PASS|PARTIAL|FAIL|REPLAN|BLOCKED|WAIT",',
    '"summary":"...","nextPrompt":"...","evidenceRefs":["reported reference"],"handoff":false,',
    '"blocker":null}. For BLOCKED only, replace blocker with',
    '{"kind":"external_permission|unrecoverable_evidence|external_dependency",',
    '"evidence":"concrete observed fact or citation","releaseCondition":"specific prerequisite"}.',
    'For WAIT only, add "resumeAt":"<ISO-8601 time with UTC offset>".',
    'EVIDENCE STANDARD. You have no tools, so the executor report is the evidence available.',
    'Accept a criterion as met when the report gives concrete, specific, mutually consistent facts',
    'for it (commit SHA, file or command, test counts, device and build identity, observed result)',
    'and nothing in it contradicts them. Reject vague, contradictory or missing claims.',
    'Independent production verification is the owner\'s separate final release step; do not',
    'withhold PASS to demand proof of work that is already concretely reported.',
    'PASS when every acceptance criterion is met by that standard; cite the references used.',
    'PARTIAL only for a NAMED unmet criterion, with ONE concrete action that changes the product',
    'or produces that missing fact. Never ask to re-document, re-summarize, re-run unchanged tests',
    'or re-prove something already concretely reported; a remaining nicety is not a blocker.',
    'FAIL when the report shows a real defect against a criterion; nextPrompt names the fix.',
    'REPLAN only when the plan itself is wrong (missing prerequisite, wrong scope). It keeps every',
    'key and its history; it is not a way to restart or rename the current item.',
    'BLOCKED only for a concrete external or authorization barrier the approved tools cannot',
    'resolve; code, test, build or CI failures and transient outages are never BLOCKED.',
    'WAIT when the remaining evidence is being produced by an already running, time-bound process',
    '(a long device run, a scheduled job, a store review) and checking earlier cannot change it.',
    'resumeAt is when that result is expected (5 minutes to 12 hours ahead); no Send for this item',
    'happens before then, independent eligible work runs meanwhile. nextPrompt is the instruction',
    'to collect the result at that time. Never use REPLAN or PARTIAL to wait or poll.',
    'For PARTIAL/FAIL/WAIT, nextPrompt is the one instruction. For PASS/REPLAN/BLOCKED, nextPrompt is empty.',
    'Review history of this work item (PI verdicts, oldest first):',
    ...(prior.length?prior.map(review=>`round ${review.round}: ${review.verdict}${review.summary?` — ${review.summary.slice(0,240)}`:''}`):['none']),
    ...(nonPass>=2?[
      `This item already received ${nonPass} PARTIAL/FAIL reviews. Decide on the merits now:`,
      'PASS if the criteria are substantively met; FAIL only with a specific defect; BLOCKED only',
      'with an external barrier. Another PARTIAL must name a criterion not raised before.',
    ]:[]),
    ...(input.finalWorkItem?[
      'FINAL PACKAGE: every other planned package already passed. PASS here COMPLETES the owner Goal.',
      'Choose PASS only if the owner Goal and its acceptance requirements are achieved as a whole;',
      'if anything required is still missing, choose REPLAN so the missing work is planned (passed work is kept).',
    ]:[]),
    ...(input.controllerTime?[`Current controller time (UTC): ${input.controllerTime}`]:[]),
    `Owner Goal: ${input.objective}`,
    'Original owner acceptance requirements:',...input.ownerAcceptance,
    `Approved plan: ${input.planSummary}`,
    `Active work: ${input.workItem.key} ${input.workItem.title}\n${input.workItem.description}`,
    'Acceptance criteria:',...input.acceptance,
    `Observed complete assistant SHA-256: ${input.responseSha256}`,
    'Authenticated pending owner directives:',...input.ownerDirectives.map(x=>x.text),
    'Previous controller-recorded work outcomes:',
    ...(input.priorWorkOutcomes?.length?input.priorWorkOutcomes.map(x=>
      `${x.status}: ${x.key} — ${x.title}`):['none']),
    'Executor report:',limitAnswer(input.browserAnswer),
    ...controllerCheckpointPrompt(input.controllerCheckpoint),
  ].join('\n');
}
function workPrompt(graph:GoalGraph,item:GoalWorkItem):string{
  const criteria=graph.acceptance.filter(x=>x.itemId===item.id).map(x=>'- '+x.criterion);
  const prompt=[
    `Execute only work package ${item.key}: ${item.title}.`,
    item.description,
    'Acceptance (return independently checkable evidence):',...criteria,
  ].filter(Boolean).join('\n');
  if(prompt.length>1500)throw new Error('Planned work package exceeds the 1500-character executor directive limit');
  return prompt;
}
/** Stable acceptance obligation across a REPLAN which only renames the work
 * item. Exact normalized criterion text is the conservative identity; an
 * actually changed acceptance contract is handled through its new Plan. */
function criteriaObligationKey(criteria:readonly string[]):string{
  const normalized=criteria.map(x=>x.trim().replace(/\s+/g,' ').toLowerCase()).sort();
  return sha(JSON.stringify(normalized));
}
function workObligationKey(graph:GoalGraph,item:GoalWorkItem):string{
  const criteria=graph.acceptance.filter(x=>x.itemId===item.id)
    .map(x=>x.criterion);
  return criteriaObligationKey(criteria);
}
interface WorkSelection {
  action:'NEXT'|'BLOCKED'|'DONE';nextPrompt:string;summary:string;
  /** Set when only PI-WAIT-deferred work remains: no Send before this time. */
  notBefore?:number;
}
function selectNextWork(ledger:GoalLedger,goalId:string,planId:string,source:string,
  nowMs:number):WorkSelection{
  const graph=ledger.graph(goalId);
  const active=activeWorkItem(graph);
  if(active)throw new Error('Cannot select another work package while one is active');
  const plan=graph.plans.find(x=>x.id===planId);
  if(plan?.status!=='APPROVED'||graph.goal.status!=='ACTIVE')
    throw new Error('Goal selection requires an active Goal and approved plan');
  const items=graph.items.filter(x=>x.planId===planId);
  const available=items.filter(x=>x.status==='PENDING'||x.status==='READY')
    .filter(x=>graph.dependencies.filter(d=>d.itemId===x.id)
      .every(dep=>graph.items.find(w=>w.id===dep.dependsOnId)?.status==='PASSED'))
    .sort((a,b)=>b.priority-a.priority||a.key.localeCompare(b.key));
  // A PI WAIT keeps its package out of rotation until its time; independent
  // eligible work goes first, otherwise the earliest waiting package is
  // selected with a dispatch fence instead of being re-sent at once.
  const deferrals=openWorkDeferrals(graph);
  const waiting=(x:GoalWorkItem)=>(deferrals.get(x.key)?.notBefore??0)>nowMs;
  const ready=available.filter(x=>!waiting(x));
  const deferred=available.filter(waiting)
    .sort((a,b)=>deferrals.get(a.key)!.notBefore-deferrals.get(b.key)!.notBefore);
  const pick=ready[0]??deferred[0];
  if(!pick){
    // Every package of the approved plan passed PI review, and the final
    // review was told that PASS completes the Goal: the Goal is DONE.
    if(items.every(x=>x.status==='PASSED'))
      return {action:'DONE',nextPrompt:'',
        summary:`Goal complete: all ${items.length} planned work packages passed PI review`};
    return {action:'BLOCKED',nextPrompt:'',
      summary:'No eligible work item: unresolved dependencies, blocked work or unapproved planning'};
  }
  const item=pick;
  const resume=deferrals.get(item.key)?.resumePrompt;
  const prompt=resume||workPrompt(graph,item);
  const prefix=`pi:${source.slice(0,36)}:${item.id.slice(0,24)}`;
  let current=item;
  if(current.status==='PENDING')
    current=ledger.setWorkStatus(goalId,item.id,current.version,'READY',[],`${prefix}:ready`);
  ledger.setWorkStatus(goalId,item.id,current.version,'IN_PROGRESS',[],`${prefix}:start`);
  if(!ready.length){
    const notBefore=deferrals.get(item.key)!.notBefore;
    return {action:'NEXT',nextPrompt:prompt,notBefore,
      summary:`PI WAIT: no other eligible work; ${item.key} resumes after ${new Date(notBefore).toISOString()}`};
  }
  return {action:'NEXT',nextPrompt:prompt,summary:`PI selected ${item.key}; ${items.length} planned work items`};
}
/** A REPLAN produces a fresh PENDING graph. Without this step every
 * superseded PASS (baseline checks, cost gates, finished features) is
 * re-executed in the next browser Send. Match an earlier PASSED item of the
 * same Goal by its stable key or its exact acceptance obligation, in
 * dependency order, so prerequisites stay honest. Returns carried keys. */
function carryForwardPassedWork(ledger:GoalLedger,goalId:string,planId:string,
  source:string):string[]{
  const carried:string[]=[];
  for(let progressed=true;progressed;){
    progressed=false;
    const graph=ledger.graph(goalId);
    const earlier=graph.items.filter(x=>x.planId!==planId&&x.status==='PASSED');
    if(!earlier.length)return carried;
    for(const item of graph.items.filter(x=>x.planId===planId&&x.status==='PENDING')){
      const deps=graph.dependencies.filter(d=>d.itemId===item.id);
      if(!deps.every(d=>graph.items.find(w=>w.id===d.dependsOnId)?.status==='PASSED'))continue;
      const obligation=workObligationKey(graph,item);
      const match=earlier.filter(x=>x.key===item.key||workObligationKey(graph,x)===obligation)
        .sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0];
      if(!match)continue;
      ledger.carryForwardPassed(goalId,item.id,match.id,
        `pi:${source.slice(0,36)}:${item.id.slice(0,24)}:carry`);
      carried.push(item.key);progressed=true;break;
    }
  }
  return carried;
}
/** Latest status per stable key across every plan of this Goal, so PI sees
 * what already passed even after many REPLANs (not only the last 20 rows). */
function priorOutcomes(graph:GoalGraph):{key:string;title:string;status:'PASSED'|'BLOCKED'}[]{
  // BLOCKED means PI found an external barrier, not "stopped by a REPLAN":
  // a superseded item must never read as a blocker the next plan avoids.
  const piBlocked=new Set(graph.events.filter(e=>e.type==='goal.pi_review'&&
    e.payload.verdict==='BLOCKED').map(e=>String(e.payload.itemId)));
  const latest=new Map<string,GoalWorkItem>();
  for(const item of [...graph.items].sort((a,b)=>a.updatedAt.localeCompare(b.updatedAt)))
    if(item.status==='PASSED'||(item.status==='BLOCKED'&&piBlocked.has(item.id))){
      const prior=latest.get(item.key);
      if(prior?.status!=='PASSED'||item.status==='PASSED')latest.set(item.key,item);
    }
  return [...latest.values()].slice(-40).map(item=>({key:item.key,title:item.title,
    status:item.status as 'PASSED'|'BLOCKED'}));
}

/** A Goal-bound PI round is a single existing Mission PI checkpoint.
 * All Goal writes and the authoritative PI NEXT/HANDOFF/BLOCKED commit share
 * ONE SQLite transaction. Restart after a committed decision cannot re-plan
 * or dispatch a duplicated request. No browser operation occurs here. */
export async function reviewGoalPiRound(input:{
  store:Store;planner:PiPlanner;missionId:string;responseSha256:string;
  lastAssistant:string;round:number;replaceExisting:boolean;
  ownerDirectives:PiOwnerDirective[];
  /** Injectable clock for tests; production uses wall time. */
  now?:()=>number;
}):Promise<PiPlan>{
  const {store,planner,missionId,responseSha256,round,ownerDirectives}=input;
  const clock=input.now??Date.now;
  if(sha(input.lastAssistant)!==responseSha256)
    throw new Error('Goal PI review must match the full observed browser SHA');
  const ledger=new GoalLedger(store),goalId=ledger.missionGoalId(missionId);
  if(!goalId)throw new Error('Goal-bound PI mission has no Goal record');
  const baseline=ledger.graph(goalId);
  const approved=baseline.plans.find(x=>x.status==='APPROVED');
  const active=activeWorkItem(baseline);
  if(active && active.planId!==approved?.id)throw new Error('Active work belongs to an unapproved plan');
  if(!approved && active)throw new Error('Unapproved Goal cannot have active work');
  const prior=store.piPlan(missionId);
  // Owner notes can arrive after PI selected a package but before its browser
  // Send. The old reply is PLAN evidence, NOT execution of that package. Do
  // not accidentally PASS it by re-reviewing the same already-credited round.
  if(input.replaceExisting && prior?.round===round &&
    prior.responseSha256===responseSha256){
    if(!active||!approved||!ownerDirectives.length||
      !['NEXT','HANDOFF'].includes(prior.action))
      throw new Error('Goal PI revision requires an active selected work item and new owner notes');
    const mission=store.get(missionId);
    const change=await inferPi(()=>planner.decide({
      goal:baseline.goal.objective,
      acceptance:baseline.acceptance.filter(x=>x.itemId===active.id).map(x=>x.criterion),
      turnCount:round,
      responseSha256,lastAssistant:input.lastAssistant,
      ownerDirectives,sandbox:mission.sandbox,workspace:mission.workspace,
      priorPiSummary:prior.summary,
    }));
    if(change.action==='DONE')
      throw new Error('Owner note cannot turn a pending work package into Goal DONE');
    return store.atomic(()=>{
      const current=ledger.graph(goalId),observed=store.chatBrowserTurn(missionId);
      if(JSON.stringify(current)!==JSON.stringify(baseline)||
        observed?.assistantSha256!==responseSha256)
        throw new Error('Goal or observed browser checkpoint changed during owner revision');
      // An owner note is an explicit request to act now: it lifts a PI WAIT fence.
      store.setMeta(piDispatchAfterKey(missionId),JSON.stringify({round,responseSha256,notBefore:0}));
      return store.commitPiPlan(missionId,responseSha256,ownerDirectives.map(x=>x.id),
        change,true);
    });
  }
  if(!approved && !planner.proposeGoalPlan)
    throw new Error('PI planner lacks Goal plan-review support');
  if(approved && active && !planner.reviewGoalWork)
    throw new Error('PI planner lacks Goal work-review support');
  const checkpoint=verifiedControllerCheckpoint(store,missionId,round,responseSha256);
  const context={objective:baseline.goal.objective,
    ownerAcceptance:store.get(missionId).acceptance,browserAnswer:input.lastAssistant,
    responseSha256,ownerDirectives,controllerCheckpoint:checkpoint,
    priorWorkOutcomes:priorOutcomes(baseline)};
  const proposed=!approved?await inferPi(()=>planner.proposeGoalPlan!(context)):null;
  // A work item's identity is its key, across every plan of this Goal.
  const sameKey=new Set(active?baseline.items.filter(item=>item.key===active.key)
    .map(item=>item.id):[]);
  const previousReviews=baseline.events.filter(event=>
    event.type==='goal.pi_review'&&sameKey.has(String(event.payload.itemId))&&
    typeof event.payload.round==='number'&&
    ['PASS','PARTIAL','FAIL','REPLAN','BLOCKED','WAIT'].includes(String(event.payload.verdict)))
    .map(event=>({round:event.payload.round as number,
      verdict:event.payload.verdict as GoalReview['verdict'],
      summary:String(event.payload.summary??'')})).slice(-6);
  const reviewed=approved&&active?await inferPi(()=>planner.reviewGoalWork!({
    ...context,planSummary:approved.summary,workItem:active,
    acceptance:baseline.acceptance.filter(x=>x.itemId===active.id).map(x=>x.criterion),
    priorWorkReviews:previousReviews,controllerTime:new Date(clock()).toISOString(),
    finalWorkItem:baseline.items.filter(x=>x.planId===approved.id&&x.id!==active.id)
      .every(x=>x.status==='PASSED'),
  })):null;
  if(reviewed?.verdict==='BLOCKED'&&!validGoalBlocker(reviewed.blocker))
    throw new PiInferenceError('PI BLOCKED lacks a specific external barrier, evidence and release condition');
  let replanned:GoalPlanProposal|null=null;
  if(reviewed?.verdict==='REPLAN'){
    if(!planner.proposeGoalPlan)throw new Error('PI cannot REPLAN without its planning interface');
    // A REPLAN revises the current plan; keys stay the identities of work.
    replanned=await inferPi(()=>planner.proposeGoalPlan!({...context,
      currentPlan:baseline.items.filter(x=>x.planId===approved!.id).map(x=>({
        key:x.key,title:x.title,status:x.id===active!.id?'ACTIVE':x.status,
        acceptance:baseline.acceptance.filter(a=>a.itemId===x.id).map(a=>a.criterion)}))}));
  }
  return store.atomic(()=>{
    const mission=store.get(missionId);
    if(mission.state!=='PAUSED'||mission.turnCount!==round||mission.stopRequested||
      !store.hasVerifiedPiBrowserCheckpoint(missionId)||
      store.chatBrowserTurn(missionId)?.assistantSha256!==responseSha256)
      throw new Error('Goal PI checkpoint changed during planning; no Send authorized');
    const refreshed=verifiedControllerCheckpoint(store,missionId,round,responseSha256);
    if(JSON.stringify(refreshed)!==JSON.stringify(checkpoint))
      throw new Error('Controller evidence changed during PI review; no stale decision committed');
    if(JSON.stringify(store.pendingPiOwnerDirectives(missionId).map(x=>x.id))!==
       JSON.stringify(ownerDirectives.map(x=>x.id)))
      throw new Error('Owner updates changed during Goal planning; retry before Send');
    if(ledger.missionGoalId(missionId)!==goalId)
      throw new Error('Goal/Mission binding changed during PI planning');
    const graph=ledger.graph(goalId);
    if(graph.goal.version!==baseline.goal.version||
      JSON.stringify(graph.plans)!==JSON.stringify(baseline.plans)||
      JSON.stringify(graph.items)!==JSON.stringify(baseline.items)||
      JSON.stringify(graph.acceptance)!==JSON.stringify(baseline.acceptance))
      throw new Error('Goal graph changed during PI inference; no Send authorized');
    let chosen=approved;
    const nowMs=clock();
    let next:WorkSelection|undefined;
    if(proposed){
      const plan=ledger.createPlan(goalId,graph.goal.version,{
        requestKey:`pi-${responseSha256.slice(0,45)}`,...proposed,
      } satisfies CreateGoalPlan);
      ledger.setPlanStatus(goalId,plan.id,plan.version,'APPROVED',`pi:${responseSha256}:approve`);
      ledger.recordPiPlanReview(goalId,missionId,plan.id,round,responseSha256,
        `pi:${responseSha256.slice(0,48)}:plan-review`);
      const goal=ledger.getGoal(goalId);
      ledger.setGoalStatus(goalId,goal.version,'ACTIVE',`pi:${responseSha256}:activate`);
      chosen=ledger.getPlan(goalId,plan.id);
      carryForwardPassedWork(ledger,goalId,plan.id,responseSha256);
      next=selectNextWork(ledger,goalId,plan.id,responseSha256,nowMs);
    }else if(reviewed&&active&&approved){
      const eventKey=`pi:${missionId.slice(0,18)}:${round}:${responseSha256.slice(0,26)}`;
      const blockedDetail=reviewed.verdict==='BLOCKED'
        ?`PI BLOCKED: ${reviewed.summary.slice(0,220)}; kind: ${reviewed.blocker!.kind}; evidence (PI-reported): ${reviewed.blocker!.evidence}; release when: ${reviewed.blocker!.releaseCondition}`.slice(0,1000)
        :reviewed.summary;
      ledger.recordPiReview(goalId,missionId,active.id,round,responseSha256,
        reviewed.verdict,reviewed.evidenceRefs,blockedDetail,`${eventKey}:review`);
      const evidenceRef=`browser-sha256:${responseSha256}`;
      if(reviewed.verdict==='PASS'){
        const inReview=active.status==='REVIEW'?active:
          ledger.setWorkStatus(goalId,active.id,active.version,'REVIEW',[],`${eventKey}:in-review`);
        const checks=ledger.graph(goalId).acceptance.filter(x=>x.itemId===active.id);
        for(const check of checks)ledger.recordAcceptance(goalId,check.id,check.version,
          'PASS',[evidenceRef],`${eventKey}:criterion:${check.id}`);
        ledger.setWorkStatus(goalId,active.id,inReview.version,'PASSED',[evidenceRef],
          `${eventKey}:passed`);
        next=selectNextWork(ledger,goalId,approved.id,responseSha256,nowMs);
        if(next.action==='BLOCKED'&&ledger.graph(goalId).items.some(item=>
          item.planId===approved.id&&item.status==='BLOCKED')){
          const goal=ledger.getGoal(goalId);
          ledger.setGoalStatus(goalId,goal.version,'BLOCKED',`${eventKey}:remaining-blocked`);
        }
      }else if(reviewed.verdict==='PARTIAL'||reviewed.verdict==='FAIL'){
        if(reviewed.verdict==='FAIL'){
          const failed=ledger.setWorkStatus(goalId,active.id,active.version,'FAILED',
            [evidenceRef],`${eventKey}:failed`);
          const ready=ledger.setWorkStatus(goalId,active.id,failed.version,'READY',[],
            `${eventKey}:retry-ready`);
          ledger.setWorkStatus(goalId,active.id,ready.version,'IN_PROGRESS',[],
            `${eventKey}:retry-start`);
        }
        next={action:'NEXT',nextPrompt:reviewed.nextPrompt,
          summary:`PI ${reviewed.verdict} for ${active.key}: ${reviewed.summary}`};
      }else if(reviewed.verdict==='WAIT'){
        // Waiting for a running process is not a defect, a new plan or a
        // blocker: keep the item and its history, free the active slot, and
        // fence its re-dispatch until the clamped resume time.
        const asked=Date.parse(reviewed.resumeAt!);
        const notBefore=Math.min(nowMs+MAX_WORK_WAIT_MS,Math.max(nowMs+MIN_WORK_WAIT_MS,asked));
        ledger.deferWork(goalId,active.id,active.version,new Date(notBefore).toISOString(),
          reviewed.nextPrompt,round,`${eventKey}:wait`);
        const continuation=selectNextWork(ledger,goalId,approved.id,responseSha256,nowMs);
        next={...continuation,summary:(continuation.notBefore!==undefined
          ?`PI WAIT for ${active.key} until ${new Date(notBefore).toISOString()}: ${reviewed.summary}`
          :`PI WAIT for ${active.key} until ${new Date(notBefore).toISOString()}; ${continuation.summary}`).slice(0,1000)};
      }else if(reviewed.verdict==='REPLAN'){
        // Superseded, not blocked: the new plan continues this key's obligation.
        const was=ledger.setWorkStatus(goalId,active.id,active.version,'FAILED',[],
          `${eventKey}:replan-stop`);
        if(was.status!=='FAILED')throw new Error('REPLAN failed to stop the old work');
        ledger.setPlanStatus(goalId,approved.id,approved.version,'SUPERSEDED',
          `${eventKey}:supersede`);
        const goal=ledger.getGoal(goalId);
        const newPlan=ledger.createPlan(goalId,goal.version,{
          requestKey:`replan-${responseSha256.slice(0,44)}`,...replanned!,
        });
        ledger.setPlanStatus(goalId,newPlan.id,newPlan.version,'APPROVED',
          `${eventKey}:approve-new`);
        ledger.recordPiPlanReview(goalId,missionId,newPlan.id,round,responseSha256,
          `${eventKey}:plan-review`);
        chosen=ledger.getPlan(goalId,newPlan.id);
        const carried=carryForwardPassedWork(ledger,goalId,newPlan.id,responseSha256);
        next=selectNextWork(ledger,goalId,newPlan.id,responseSha256,nowMs);
        if(carried.length)next={...next,
          summary:`${next.summary}; carried forward PASSED: ${carried.join(', ')}`.slice(0,1000)};
      }else{
        ledger.setWorkStatus(goalId,active.id,active.version,'BLOCKED',[],
          `${eventKey}:blocked`);
        // A failed external dependency is a blocked work item, not a license to
        // abandon unrelated implementation, device QA or commercial work.
        // Keep the blocked obligation in SQLite and advance only truly eligible
        // independent items. The Goal remains unshippable until it is resolved.
        const continuation=selectNextWork(ledger,goalId,approved.id,responseSha256,nowMs);
        if(continuation.action==='NEXT'){
          next={...continuation,
            summary:`Deferred blocked ${active.key}: ${blockedDetail}; ${continuation.summary}`.slice(0,1000)};
        }else{
          const goal=ledger.getGoal(goalId);
          ledger.setGoalStatus(goalId,goal.version,'BLOCKED',`${eventKey}:goal-blocked`);
          next={action:'BLOCKED',nextPrompt:'',summary:blockedDetail};
        }
      }
    }else if(approved&&!active){
      next=selectNextWork(ledger,goalId,approved.id,responseSha256,nowMs);
    }
    if(!next||!chosen)throw new Error('PI Goal planning did not produce an eligible work decision');
    // Goal DONE comes only from the controller: every approved package passed
    // PI review. A ChatGPT DONE marker alone never completes a Goal.
    if(next.action==='DONE'){
      const lastPass=reviewed?.verdict==='PASS'?reviewed.summary:'';
      ledger.completeGoal(goalId,missionId,responseSha256,
        `${next.summary}${lastPass?`. Final review: ${lastPass}`:''}`.slice(0,1000));
    }
    const result=store.commitPiPlan(missionId,responseSha256,ownerDirectives.map(x=>x.id),
      {action:reviewed?.handoff&&next.action==='NEXT'?'HANDOFF':next.action,
        nextPrompt:next.nextPrompt,summary:next.summary},input.replaceExisting);
    // Bound to this exact round and answer, so a later decision is never fenced.
    store.setMeta(piDispatchAfterKey(missionId),JSON.stringify({round,responseSha256,
      notBefore:next.action==='NEXT'&&next.notBefore&&next.notBefore>nowMs?next.notBefore:0}));
    return result;
  });
}
