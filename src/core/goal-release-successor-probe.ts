import {createHash} from 'node:crypto';
import {existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import type {Page} from 'playwriter';
import type {Store} from './store.js';
import {InsufficientReleaseEvidenceError,type EvidenceReadback,type ReleaseProbe} from './goal-release.js';
import {requireSettledReleaseCustody} from './goal-release.js';
import {GoalLedger} from './goal-store.js';
import {inspectGoalRequestLedger} from './request-ledger.js';
import {inspectPiChainEvidence} from './pi-evidence.js';
import {stateHome} from './paths.js';
import {readReleaseWorkerIdentity,withStableReleaseWorkerIdentity,
  type ReleaseWorkerIdentity} from './goal-release-runtime.js';
import {observeTrustedChromeTab,type TrustedChromeTabObservation} from './goal-release-chrome-probes.js';

const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const SHA40=/^[a-f0-9]{40}$/;
const SHA64=/^[a-f0-9]{64}$/;
const UUID=/^[0-9a-f-]{36}$/i;
const CAPTURE_WINDOW_MS=20*60*1000;
type EventData={requestKey?:unknown;round?:unknown;parentId?:unknown;
  successorId?:unknown;parentAnswerSha256?:unknown;newTabTargetSha256?:unknown;
  previousUrlSha256?:unknown;newUrlSha256?:unknown;action?:unknown;responseSha256?:unknown};
const payload=(e:{payload:unknown}|undefined):EventData=>
  e?.payload&&typeof e.payload==='object'&&!Array.isArray(e.payload)?
    e.payload as EventData:{};
export interface SuccessorChromeWitness {
  kind:'mission-32-successor';version:1;goalId:string;parentId:string;childId:string;
  sourceSha:string;observedAt:string;planId:string;workItemId:string;
  limitEventId:number;successorEventId:number;startedEventId:number;
  parentObservationEventId:number;parentDecisionEventId:number;
  childReservationEventId:number;childMigrationEventId:number;childObservationEventId:number;
  parent:TrustedChromeTabObservation;child:TrustedChromeTabObservation;
}
function directory(root:string,goalId:string):string {
  if(!UUID.test(goalId))throw new Error('Invalid successor Goal identity');
  return join(resolve(root),'chrome-custody',goalId);
}
function assertPhysical(tab:TrustedChromeTabObservation):void {
  if(!tab||!['urlSha256','targetSha256','promptSha256','answerSha256'].every(key=>
    SHA64.test(String(tab[key as keyof TrustedChromeTabObservation])))||
    !Number.isSafeInteger(tab.userCount)||tab.userCount<1||
    !Number.isSafeInteger(tab.assistantCount)||tab.assistantCount<1||
    (tab.assistantTurnSha256!==null&&!SHA64.test(tab.assistantTurnSha256)))
    throw new Error('Incomplete physical successor tab evidence');
}
function assertCaptureTime(at:string,original:string):void {
  const a=Date.parse(at),o=Date.parse(original);
  if(!Number.isFinite(a)||!Number.isFinite(o)||a>Date.now()+30_000||
    a<o-30_000||a>o+CAPTURE_WINDOW_MS)
    throw new Error('Successor witness was not captured near the original full answer');
}
/** Revalidate original physical observation and append-only SQLite chain.
 * The child must be observed, but its PI decision is expected only AFTER
 * capture; the release inspection separately requires that decision. */
export function validateSuccessorWitness(store:Store,goalId:string,
  targetSha:string,w:SuccessorChromeWitness,requirePiReview=true):void {
  if(w.kind!=='mission-32-successor'||w.version!==1||w.goalId!==goalId||
    w.sourceSha!==targetSha||!SHA40.test(targetSha)||
    !UUID.test(w.parentId)||!UUID.test(w.childId)||w.parentId===w.childId)
    throw new Error('Successor evidence has invalid Goal, source revision or identity');
  assertPhysical(w.parent);assertPhysical(w.child);
  const ledger=new GoalLedger(store);
  const graph=ledger.graph(goalId);
  const custody=inspectGoalRequestLedger(store,goalId);
  const chain=inspectPiChainEvidence(store,w.parentId);
  const link=chain.links.find(l=>l.parentId===w.parentId&&l.childId===w.childId);
  const parentReport=chain.missions.find(m=>m.missionId===w.parentId);
  const childReport=chain.missions.find(m=>m.missionId===w.childId);
  const parent=store.get(w.parentId),child=store.get(w.childId);
  if(!custody.ledgerConsistent||custody.rootMissionIds.length!==1||
    custody.quarantineEventIds.length||custody.unattributedEventIds.length||
    !custody.missionIds.includes(w.parentId)||!custody.missionIds.includes(w.childId)||
    ledger.missionGoalId(w.childId)!==goalId||
    !chain.chainConsistent||!link||!link.scopeInherited||!link.parentAnswerShaMatches||
    link.parentPlanRound!==32||link.childStartsInNewChat!==true||
    !parentReport||parentReport.turnCount!==32||parentReport.maxTurns!==32||
    parentReport.observedTurns!==32||parentReport.decisionsVerified!==32||
    parentReport.maxObservedTurnsInOneChat>5||
    !childReport||childReport.rounds[0]?.round!==1||
    childReport.rounds[0]?.chatTurn!==1||
    !childReport.rounds[0]?.reservedEventId||
    link.limitEventId!==w.limitEventId||link.successorEventId!==w.successorEventId||
    link.startedEventId!==w.startedEventId||
    store.piChainSuccessor(w.parentId)!==w.childId||
    store.piChainParent(w.childId)!==w.parentId||
    parent.maxTurns!==32||parent.turnCount!==32||parent.stopRequested||parent.lastError||
    child.maxTurns!==32||child.stopRequested||child.goal!==parent.goal||
    child.workspace!==parent.workspace||child.sandbox!==parent.sandbox||
    child.mode!==parent.mode||JSON.stringify(child.checks)!==JSON.stringify(parent.checks)||
    JSON.stringify(child.acceptance)!==JSON.stringify(parent.acceptance)||
    graph.goal.objective!==parent.goal.trim())
    throw new Error('Unverified 32-turn parent, duplicate successor or altered Mission scope');
  if(!graph.plans.some(p=>p.id===w.planId&&p.status==='APPROVED')||
    !graph.items.some(i=>i.id===w.workItemId&&i.planId===w.planId)||
    !graph.acceptance.some(c=>c.itemId===w.workItemId))
    throw new Error('Successor is no longer linked to its approved Goal work item');
  const parentRequests=custody.requests.filter(r=>r.missionId===w.parentId);
  const childRequests=custody.requests.filter(r=>r.missionId===w.childId);
  const parentRequest=parentRequests.find(r=>r.round===32&&
    r.observationEventId===w.parentObservationEventId);
  const first=childRequests.find(r=>r.round===1&&
    r.observationEventId===w.childObservationEventId);
  const pe=store.events(w.parentId),ce=store.events(w.childId);
  const parentOrigin=pe.filter(e=>e.type==='chatgpt.browser_migrated'&&
    e.id<w.parentObservationEventId&&payload(e).newUrlSha256===w.parent.urlSha256).at(-1);
  const migration=ce.find(e=>e.id===w.childMigrationEventId&&
    e.type==='chatgpt.browser_migrated');
  const reservation=ce.find(e=>e.id===w.childReservationEventId&&
    e.type==='chatgpt.browser_reserved');
  const observed=ce.find(e=>e.id===w.childObservationEventId&&
    e.type==='chatgpt.browser_observed');
  const decision=ce.find(e=>e.id===first?.decisionEventId&&
    ['pi.decision','pi.decision_revised'].includes(e.type));
  const successorEvents=pe.filter(e=>e.type==='pi.chain_successor');
  const startedEvents=ce.filter(e=>e.type==='pi.chain_started');
  if(!parentRequest||!first||!parentOrigin||!migration||!reservation||!observed||
    successorEvents.length!==1||startedEvents.length!==1||
    successorEvents[0]!.id!==w.successorEventId||
    startedEvents[0]!.id!==w.startedEventId||
    payload(successorEvents[0]).successorId!==w.childId||
    payload(startedEvents[0]).parentId!==w.parentId||
    payload(startedEvents[0]).parentAnswerSha256!==w.parent.answerSha256||
    payload(successorEvents[0]).parentAnswerSha256!==w.parent.answerSha256||
    first.reservationEventId!==w.childReservationEventId||
    first.workItemId!==w.workItemId||first.planId!==w.planId||
    parentRequest.status!=='observed'||first.status!=='observed'||
    parentRequest.decisionEventId!==w.parentDecisionEventId||
    parentRequest.sourceChatUrlSha256!==w.parent.urlSha256||
    parentRequest.promptSha256!==w.parent.promptSha256||
    parentRequest.answerSha256!==w.parent.answerSha256||
    first.sourceChatUrlSha256!==w.parent.urlSha256||
    first.destinationChatUrlSha256!==w.child.urlSha256||
    first.promptSha256!==w.child.promptSha256||
    first.answerSha256!==w.child.answerSha256||
    payload(migration).requestKey!==payload(reservation).requestKey||
    payload(observed).requestKey!==payload(reservation).requestKey||
    payload(migration).previousUrlSha256!==w.parent.urlSha256||
    payload(migration).newUrlSha256!==w.child.urlSha256||
    payload(parentOrigin).newTabTargetSha256!==w.parent.targetSha256||
    payload(migration).newTabTargetSha256!==w.child.targetSha256||
    w.parent.urlSha256===w.child.urlSha256||
    w.parent.targetSha256===w.child.targetSha256||
    !(w.successorEventId<w.startedEventId&&w.startedEventId<w.childReservationEventId&&
      w.childReservationEventId<w.childMigrationEventId&&
      w.childMigrationEventId<w.childObservationEventId)||
    ce.some(e=>e.id<w.startedEventId&&
      ['chatgpt.browser_reserved','chatgpt.browser_observed','pi.decision'].includes(e.type))||
    ce.some(e=>e.type==='chatgpt.browser_reserved'&&e.id<w.childReservationEventId)||
    ce.some(e=>e.type==='chatgpt.browser_observed'&&e.id<w.childObservationEventId))
    throw new Error('Successor first Send, complete answer or physical Chat Target was substituted');
  assertCaptureTime(w.observedAt,observed.createdAt);
  if(requirePiReview&&(!decision||first.decisionEventId===null||
    childReport.rounds[0]?.decisionShaMatches!==true||
    payload(decision).responseSha256!==w.child.answerSha256||
    payload(decision).round!==1))
    throw new Error('First successor full answer has no matching independent PI decision');
}
export async function captureGoalSuccessorBoundary(input:{
  store:Store;goalId:string;parentId:string;childId:string;
  sourcePage:Page;destinationPage:Page;sourceUrl:string;destinationUrl:string;
  sourceSha:string;privateRoot?:string;
}):Promise<string> {
  const {store,goalId,parentId,childId}=input;
  if(input.sourcePage===input.destinationPage||
    store.piChainParent(childId)!==parentId||
    !SHA40.test(input.sourceSha))
    throw new Error('Successor physical pages or source identity are not independent');
  const custody=inspectGoalRequestLedger(store,goalId);
  const chain=inspectPiChainEvidence(store,parentId);
  const link=chain.links.find(l=>l.parentId===parentId&&l.childId===childId);
  const childRequests=custody.requests.filter(r=>r.missionId===childId);
  const child=store.get(childId),first=childRequests[0];
  const parentReq=custody.requests.find(r=>r.missionId===parentId&&r.round===32);
  const migration=store.events(childId).find(e=>e.type==='chatgpt.browser_migrated'&&
    payload(e).requestKey===payload(store.events(childId).find(x=>
      x.id===first?.reservationEventId)).requestKey);
  if(!custody.ledgerConsistent||!chain.chainConsistent||!link||
    !link.limitEventId||!link.successorEventId||!link.startedEventId||
    !parentReq||parentReq.status!=='observed'||parentReq.decisionEventId===null||
    !first||childRequests.length!==1||first.status!=='observed'||first.round!==1||
    first.decisionEventId!==null||!first.workItemId||!first.planId||
    child.turnCount!==1||child.state!=='PAUSED'||child.stopRequested||
    !first.observationEventId||!migration)
    throw new Error('Successor first response or original 32-turn custody is not ready');
  const [parent,childTab]=await Promise.all([
    observeTrustedChromeTab(input.sourcePage,input.sourceUrl),
    observeTrustedChromeTab(input.destinationPage,input.destinationUrl)]);
  const witness:SuccessorChromeWitness={
    kind:'mission-32-successor',version:1,goalId,parentId,childId,
    sourceSha:input.sourceSha,observedAt:new Date().toISOString(),
    planId:first.planId,workItemId:first.workItemId,
    limitEventId:link.limitEventId,successorEventId:link.successorEventId,
    startedEventId:link.startedEventId,
    parentObservationEventId:parentReq.observationEventId!,
    parentDecisionEventId:parentReq.decisionEventId,
    childReservationEventId:first.reservationEventId,
    childMigrationEventId:migration.id,
    childObservationEventId:first.observationEventId,parent,child:childTab,
  };
  validateSuccessorWitness(store,goalId,input.sourceSha,witness,false);
  const raw=JSON.stringify(witness),digest=hash(raw),dir=directory(input.privateRoot??stateHome(),goalId);
  mkdirSync(dir,{recursive:true,mode:0o700});
  const file=join(dir,'mission-32-successor-'+digest+'.json');
  try{writeFileSync(file,raw,{flag:'wx',mode:0o600});}
  catch(error){
    if((error as NodeJS.ErrnoException).code!=='EEXIST'||readFileSync(file,'utf8')!==raw)
      throw error;
  }
  return digest;
}
export function inspectStoredGoalSuccessorWitnesses(store:Store,goalId:string,
  root:string,targetSha:string,runtimeIdentity?:ReleaseWorkerIdentity):EvidenceReadback {
  if(!SHA40.test(targetSha))
    throw new Error('Successor release target is not an exact SHA');
  if(runtimeIdentity&&runtimeIdentity.source.sourceSha!==targetSha)
    throw new Error('Successor physical observations cannot attest a different Worker revision');
  requireSettledReleaseCustody(store,goalId);
  const dir=directory(root,goalId);
  if(!existsSync(dir))
    throw new InsufficientReleaseEvidenceError('No independently observed physical successor witnesses');
  const proofs:Array<{digest:string;witness:SuccessorChromeWitness}>=[];
  for(const filename of readdirSync(dir).filter(x=>x.startsWith('mission-32-successor-'))){
    if(!/^mission-32-successor-[a-f0-9]{64}\.json$/.test(filename))
      throw new Error('Unrecognized successor witness filename');
    const file=join(dir,filename);
    if(!lstatSync(file).isFile())throw new Error('Successor witness must be a regular private file');
    const raw=readFileSync(file,'utf8'),digest=hash(raw);
    if(raw.length>16_384||filename!=='mission-32-successor-'+digest+'.json')
      throw new Error('Tampered successor physical witness digest');
    const witness=JSON.parse(raw) as SuccessorChromeWitness;
    if(witness.sourceSha===targetSha)proofs.push({digest,witness});
  }
  const custody=inspectGoalRequestLedger(store,goalId);
  if(custody.rootMissionIds.length!==1)
    throw new Error('Exactly one Goal root Mission is required');
  const chain=inspectPiChainEvidence(store,custody.rootMissionIds[0]!);
  if(!chain.chainConsistent||proofs.length>chain.links.length)
    throw new Error('Successor chain or physical witness count is contradictory');
  if(!chain.links.length||proofs.length!==chain.links.length)
    throw new InsufficientReleaseEvidenceError(
      'Each 32-turn successor needs its own complete physical Chrome witness');
  const seen=new Set<string>();
  for(const {digest,witness} of proofs){
    if(seen.has(witness.childId)||!SHA64.test(digest)||
      !chain.links.some(l=>l.parentId===witness.parentId&&l.childId===witness.childId))
      throw new Error('Duplicated or foreign successor physical witness');
    seen.add(witness.childId);
    validateSuccessorWitness(store,goalId,targetSha,witness,true);
  }
  const eventReferences=proofs.map(({digest,witness})=>{
    const first=custody.requests.find(r=>r.missionId===witness.childId&&r.round===1&&
      r.observationEventId===witness.childObservationEventId);
    if(first?.decisionEventId===null||!first)
      throw new Error('Successor lacks an original reviewed first-turn event');
    return {witnessSha256:digest,parentId:witness.parentId,childId:witness.childId,
      limitEventId:witness.limitEventId,successorEventId:witness.successorEventId,
      startedEventId:witness.startedEventId,
      parentObservationEventId:witness.parentObservationEventId,
      parentDecisionEventId:witness.parentDecisionEventId,
      childReservationEventId:witness.childReservationEventId,
      childMigrationEventId:witness.childMigrationEventId,
      childObservationEventId:witness.childObservationEventId,
      childDecisionEventId:first.decisionEventId};
  }).sort((a,b)=>a.witnessSha256.localeCompare(b.witnessSha256));
  const raw=JSON.stringify({version:1,probeVersion:1,requirement:'mission-32-successor',
    scenario:'32-to-successor-first-observed-reply',goalId,targetSha,
    expectedOutcome:'PASS',observedOutcome:'PASS',
    evidenceProvenance:'physical-parent-child-chrome-and-original-sqlite-pi-chain',
    runtimeIdentity:runtimeIdentity??null,
    eventReferences,
    witnessDigests:proofs.map(p=>p.digest).sort(),
    custodyDigest:hash(JSON.stringify(custody)),
    chainDigest:hash(JSON.stringify(chain)),inspectedAt:new Date().toISOString()});
  const proofSha256=hash(raw),file=join(dir,'inspection-'+proofSha256+'.json');
  try{writeFileSync(file,raw,{flag:'wx',mode:0o600});}
  catch(error){
    if((error as NodeJS.ErrnoException).code!=='EEXIST'||readFileSync(file,'utf8')!==raw)
      throw error;
  }
  return {state:'PASS',reference:'chrome-readback://'+proofSha256,
    proofSha256,observedSha:targetSha} satisfies EvidenceReadback;
}
/** Actual production adapter validates the compiled, clean Worker source SHA.
 * Offline fixtures never promote production release state. */
export function trustedSuccessorReleaseProbe(store:Store,goalId:string,
  root=stateHome(),entry=process.argv[1]):ReleaseProbe {
  return {source:'chrome-readback',inspect:async(requirement,targetSha)=>{
    if(requirement!=='mission-32-successor')
      throw new Error('Unapproved successor ReleaseProbe requirement');
    return withStableReleaseWorkerIdentity(
      ()=>readReleaseWorkerIdentity(store,targetSha,entry),
      before=>inspectStoredGoalSuccessorWitnesses(store,goalId,root,targetSha,before));
  }};
}
