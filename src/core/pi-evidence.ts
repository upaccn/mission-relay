import type {Store} from './store.js';
import type {MissionEvent} from './types.js';

type EvidencePayload = {requestKey?:unknown;round?:unknown;assistantSha256?:unknown;
  responseSha256?:unknown;action?:unknown;independentlyInspected?:unknown};
export interface PiRoundEvidence {
  round:number;observedEventId:number;observedAt:string;
  observation:'normal'|'recovered-turn'|'recovered-new-chat';
  answerSha256:string;chatSegment:number;chatTurn:number;
  decisionEventId:number|null;decisionAction:string|null;
  decisionShaMatches:boolean|null;
  reservedEventId:number|null;independentlyRecovered:boolean;
}
export interface PiEvidenceReport {
  missionId:string;state:string;turnCount:number;maxTurns:number;
  currentChatObservedTurns:number;observedTurns:number;
  chatSegments:number;maxObservedTurnsInOneChat:number;
  decisionsVerified:number;pendingPiReviewRounds:number[];
  pendingBrowserRequest:boolean;
  successorId:string|null;parentId:string|null;
  violations:string[];ledgerConsistent:boolean;
  rounds:PiRoundEvidence[];
  /** This is a ledger-integrity report, NOT business acceptance or v1.0 qualification. */
  businessAcceptanceVerified:false;
}
export interface PiChainEvidenceReport {
  rootMissionId:string;
  inspectedFromMissionId:string;
  missionCount:number;
  chainConsistent:boolean;
  violations:string[];
  links:Array<{
    parentId:string;childId:string;
    limitEventId:number|null;successorEventId:number|null;startedEventId:number|null;
    parentPlanRound:number|null;parentAnswerShaMatches:boolean;
    scopeInherited:boolean;childStartsInNewChat:boolean|null;
  }>;
  missions:PiEvidenceReport[];
  /** Append-only consistency alone never proves business completion. */
  businessAcceptanceVerified:false;
}
const SHA=/^[0-9a-f]{64}$/;
const observationTypes={
  'chatgpt.browser_observed':'normal',
  'chatgpt.browser_turn_recovered':'recovered-turn',
  'chatgpt.browser_rollover_recovered':'recovered-new-chat',
} as const;
type ObservationType=keyof typeof observationTypes;
const hasOwn=(o:object,k:string)=>Object.prototype.hasOwnProperty.call(o,k);
const payload=(event:MissionEvent):EvidencePayload=>
  event.payload&&typeof event.payload==='object'&&!Array.isArray(event.payload)
    ?event.payload as EvidencePayload:{};

/** An append-only, content-free consistency audit over the ACTUAL Mission
 * event ledger. No browser access or model inference. An observed answer SHA
 * paired to a PI plan proves answer attribution, not that the model actually
 * ran its claimed tests or achieved the owner's business goal. */
export function inspectPiEvidence(store:Store,id:string):PiEvidenceReport {
  const mission=store.get(id);
  if(store.getMeta(`pi.autopilot.enabled.${id}`)!=='1')
    throw new Error('PI evidence audit requires a PI-enabled Mission');
  const events=store.events(id);
  const reserved=new Map<string,number>(),used=new Set<string>();
  const decisions=new Map<number,MissionEvent>();
  const allDecisions=new Map<number,MissionEvent[]>();
  const violations:string[]=[];
  let chatSegment=0,chatTurn=0,maxPerChat=0,verified=0;
  const observations:PiRoundEvidence[]=[];
  const warn=(issue:string)=>{if(!violations.includes(issue))violations.push(issue);};
  for(const e of events){
    const p=payload(e);
    if(e.type==='chatgpt.browser_reserved'){
      if(typeof p.requestKey!=='string'||!p.requestKey.trim())warn('invalid_browser_reservation');
      else if(reserved.has(p.requestKey))warn('duplicate_browser_reservation_key');
      else reserved.set(p.requestKey,e.id);
    }
    if(e.type==='chatgpt.browser_migrated'){
      chatSegment++;chatTurn=0;
    }
    if(e.type==='pi.decision'||e.type==='pi.decision_revised'){
      if(typeof p.round!=='number'||!Number.isInteger(p.round)||p.round<0)
        warn('invalid_pi_round');
      else {
        const prior=allDecisions.get(p.round)??[];
        if(e.type==='pi.decision'&&prior.length)
          warn('duplicate_base_pi_decision');
        if(e.type==='pi.decision_revised'&&!prior.length)
          warn('pi_decision_revision_without_base');
        prior.push(e);
        allDecisions.set(p.round,prior);
        decisions.set(p.round,e);
      }
    }
    if(!hasOwn(observationTypes,e.type))continue;
    const kind=observationTypes[e.type as ObservationType];
    const round=p.round,sha=p.assistantSha256,key=p.requestKey;
    if(typeof round!=='number'||!Number.isInteger(round)||round<1){
      warn('invalid_browser_observation_round');continue;
    }
    if(typeof sha!=='string'||!SHA.test(sha))warn('invalid_answer_sha256');
    if(typeof key!=='string'||!reserved.has(key))warn('observed_without_matching_reservation');
    else if(used.has(key))warn('duplicate_observed_request_key');
    else used.add(key);
    if(kind==='recovered-new-chat'){chatSegment++;chatTurn=0;}
    if(chatSegment===0)chatSegment=1; // An adopted human chat is segment one.
    chatTurn++;
    maxPerChat=Math.max(maxPerChat,chatTurn);
    if(chatTurn>8)warn('more_than_eight_sends_in_chat');
    if(round!==observations.length+1)warn('nonsequential_observed_round');
    if(kind!=='normal'&&p.independentlyInspected!==true)
      warn('recovery_lacks_independent_inspection');
    observations.push({round,observedEventId:e.id,observedAt:e.createdAt,
      observation:kind,answerSha256:typeof sha==='string'?sha:'',
      chatSegment,chatTurn,decisionEventId:null,decisionAction:null,
      decisionShaMatches:null,
      reservedEventId:typeof key==='string'?reserved.get(key)??null:null,
      independentlyRecovered:kind!=='normal'&&p.independentlyInspected===true});
  }
  const pending:number[]=[];
  for(const o of observations){
    const decision=decisions.get(o.round);
    if(!decision){pending.push(o.round);continue;}
    const p=payload(decision);
    const matches=p.responseSha256===o.answerSha256&&SHA.test(o.answerSha256);
    o.decisionEventId=decision.id;
    o.decisionAction=typeof p.action==='string'?p.action:null;
    o.decisionShaMatches=matches;
    if(matches)verified++;
    else warn('pi_decision_answer_sha_mismatch');
    if(allDecisions.get(o.round)?.some(d=>payload(d).responseSha256!==o.answerSha256))
      warn('historical_pi_decision_answer_sha_mismatch');
    if(decision.id<=o.observedEventId)warn('pi_decision_precedes_browser_observation');
  }
  if(observations.length!==mission.turnCount)warn('turn_counter_differs_from_observed_ledger');
  for(const decision of decisions.keys())if(decision>0&&
    !observations.some(o=>o.round===decision))warn('pi_decision_without_observed_round');
  const current=store.chatBrowserTurn(id);
  return {
    missionId:id,state:mission.state,turnCount:mission.turnCount,maxTurns:mission.maxTurns,
    currentChatObservedTurns:store.piChatObservedTurns(id),
    observedTurns:observations.length,chatSegments:chatSegment,
    maxObservedTurnsInOneChat:maxPerChat,decisionsVerified:verified,
    pendingPiReviewRounds:pending,
    pendingBrowserRequest:current?.status==='reserved',
    successorId:store.piChainSuccessor(id),parentId:store.piChainParent(id),
    violations,ledgerConsistent:violations.length===0,rounds:observations,
    businessAcceptanceVerified:false,
  };
}

/** Verify the 32->1 continuation lineage without contacting PI or Chrome.
 * This checks durable intent, reciprocal parent/child links, source answer
 * evidence, and invariant owner scope. Even a perfect chain is not evidence
 * that the underlying model really changed code or passed release checks. */
export function inspectPiChainEvidence(store:Store,id:string):PiChainEvidenceReport {
  const violations:string[]=[];
  const warn=(s:string)=>{if(!violations.includes(s))violations.push(s);};
  const visited=new Set<string>();
  let root=id;
  while(true){
    if(visited.has(root)||visited.size>=64)
      throw new Error('PI chain parent lineage is cyclic or exceeds 64 Missions');
    visited.add(root);
    const parent=store.piChainParent(root);
    if(!parent)break;
    root=parent;
  }
  visited.clear();
  const missions:PiEvidenceReport[]=[],links:PiChainEvidenceReport['links']=[];
  let cursor:string|null=root;
  while(cursor){
    if(visited.has(cursor)||visited.size>=64)
      throw new Error('PI chain successor lineage is cyclic or exceeds 64 Missions');
    visited.add(cursor);
    const report=inspectPiEvidence(store,cursor);
    missions.push(report);
    if(!report.ledgerConsistent)warn('mission_event_ledger_inconsistent');
    const childId=store.piChainSuccessor(cursor);
    if(childId){
      const parent=store.get(cursor),child=store.get(childId);
      const plan=store.piPlan(cursor),receipt=store.chatBrowserTurn(cursor);
      const parentEvents=store.events(cursor),childEvents=store.events(childId);
      const limit=parentEvents.find(e=>e.type==='pi.autopilot_finished'&&
        payload(e).action==='LIMIT'&&payload(e).round===parent.maxTurns);
      const successors=parentEvents.filter(e=>e.type==='pi.chain_successor');
      const starts=childEvents.filter(e=>e.type==='pi.chain_started');
      const successor=successors.find(e=>{
        const p=e.payload as {successorId?:unknown;parentAnswerSha256?:unknown}|null;
        return p?.successorId===childId&&p.parentAnswerSha256===plan?.responseSha256;
      });
      const started=starts.find(e=>{
        const p=e.payload as {parentId?:unknown;parentAnswerSha256?:unknown}|null;
        return p?.parentId===cursor&&p.parentAnswerSha256===plan?.responseSha256;
      });
      const parentBrowser=store.chatBrowserBinding(cursor);
      const scopeInherited=parent.goal===child.goal&&
        JSON.stringify(parent.acceptance)===JSON.stringify(child.acceptance)&&
        JSON.stringify(parent.checks)===JSON.stringify(child.checks)&&
        parent.workspace===child.workspace&&parent.sandbox===child.sandbox&&
        parent.mode===child.mode&&parent.maxTurns===child.maxTurns&&
        !!parentBrowser&&parentBrowser===store.chatBrowserBinding(childId)&&
        child.requestKey===`pi-chain-${cursor}`;
      const parentAnswerShaMatches=!!plan&&!!receipt&&
        /^[0-9a-f]{64}$/.test(plan.responseSha256)&&
        receipt.assistantSha256===plan.responseSha256&&
        store.hasVerifiedPiBrowserCheckpoint(cursor);
      // A migration on round TWO must not disguise an invalid first Send in
      // the inherited parent conversation. The new-tab migration must
      // precede the child's *first* observed answer, or that answer itself
      // must be an independently recovered new-tab rollover.
      const firstObserved=childEvents.find(e=>hasOwn(observationTypes,e.type));
      const migrated=!!firstObserved&&(
        firstObserved.type==='chatgpt.browser_rollover_recovered'||
        childEvents.some(e=>e.type==='chatgpt.browser_migrated'&&
          e.id<firstObserved.id&&
          payload(e).requestKey===payload(firstObserved).requestKey));
      const childStartsInNewChat=child.turnCount===0?null:migrated;
      links.push({parentId:cursor,childId,
        limitEventId:limit?.id??null,
        successorEventId:successor?.id??null,
        startedEventId:started?.id??null,
        parentPlanRound:plan?.round??null,parentAnswerShaMatches,
        scopeInherited,childStartsInNewChat});
      if(store.piChainParent(childId)!==cursor)warn('nonreciprocal_pi_chain');
      if(successors.length!==1||starts.length!==1||!successor||!started)
        warn('pi_chain_link_event_missing_or_duplicated');
      if(parent.turnCount!==parent.maxTurns||parent.maxTurns!==32||
        plan?.round!==parent.maxTurns||!['NEXT','HANDOFF'].includes(plan?.action??'')||!limit)
        warn('pi_chain_parent_limit_not_verified');
      if(!parentAnswerShaMatches)warn('pi_chain_parent_answer_not_verified');
      if(!scopeInherited)warn('pi_chain_scope_not_preserved');
      if(childStartsInNewChat===false)warn('pi_chain_child_first_send_not_new_chat');
    }
    cursor=childId;
  }
  return {rootMissionId:root,inspectedFromMissionId:id,
    missionCount:missions.length,chainConsistent:violations.length===0,
    violations,links,missions,businessAcceptanceVerified:false};
}
