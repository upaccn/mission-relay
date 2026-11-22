import type {Store} from './store.js';
import type {MissionEvent} from './types.js';
import {MAX_RELAY_CHAT_TURNS} from './chat-limits.js';

type EvidencePayload = {requestKey?:unknown;round?:unknown;assistantSha256?:unknown;
  responseSha256?:unknown;action?:unknown;independentlyInspected?:unknown;
  previousUrlSha256?:unknown;newUrlSha256?:unknown;promptSha256?:unknown;
  observedEventId?:unknown;retiredUrlSha256?:unknown;activeUrlSha256?:unknown;
  migrationEventId?:unknown;newTabTargetSha256?:unknown};
export interface PiRoundEvidence {
  round:number;observedEventId:number;observedAt:string;
  observation:'normal'|'recovered-turn'|'recovered-new-chat';
  answerSha256:string;chatSegment:number;chatTurn:number;
  decisionEventId:number|null;decisionAction:string|null;
  decisionShaMatches:boolean|null;
  reservedEventId:number|null;independentlyRecovered:boolean;
}
export interface PiEvidenceReport {
  missionId:string;state:string;turnCount:number;
  currentChatObservedTurns:number;observedTurns:number;
  chatSegments:number;maxObservedTurnsInOneChat:number;
  decisionsVerified:number;pendingPiReviewRounds:number[];
  pendingBrowserRequest:boolean;
  /** Content-free attribution for the ONE active unobserved request. This is
   * reservation evidence, never evidence of an external Send or final answer. */
  activeRequestEvidence:{
    reservationEventId:number;round:number;promptSha256:string;
    status:'reserved'|'uncertain';newConversationIntent:boolean;
  }|null;
  /** Intent in the current SQLite reservation; no browser migration is credited. */
  pendingNewChatReservation:boolean;
  violations:string[];ledgerConsistent:boolean;
  rounds:PiRoundEvidence[];
  /** Controller-reported isClosed() receipts, correlated with source creation,
   * new-chat migration and final answer. This independent LEDGER audit cannot
   * independently query Chrome or prove a vanished tab is physically closed. */
  tabRetirementReceipts:Array<{
    eventId:number;migrationEventId:number;observationEventId:number;
    retiredUrlSha256:string;activeUrlSha256:string;
  }>;
  /** Rejected candidates are never turn credit. Their immutable event IDs
   * remain available for operator inspection without revealing content. */
  quarantinedObservationEventIds:number[];
  /** Same response bytes on distinct rounds is suspicious, not proof of error. */
  repeatedAnswerCandidates:number[];
  /** This is a ledger-integrity report, NOT business acceptance or v1.0 qualification. */
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
  const tabRetirementReceipts:PiEvidenceReport['tabRetirementReceipts']=[];
  const quarantinedObservationEventIds:number[]=[];
  let chatSegment=0,chatTurn=0,maxPerChat=0,verified=0;
  let pendingMigration:string|null=null;
  // Consecutive migrations must form one continuous conversation lineage.
  // The initial source chat is the owner-linked anchor tab, so its hash
  // is unknown until the first independently recorded destination. Do not
  // count a later migration from an unrelated source as a valid reset of
  // the per-Chat Send ceiling merely because its two URL hashes differ.
  let lastDestinationUrlSha256:string|null=null;
  const observations:PiRoundEvidence[]=[];
  const warn=(issue:string)=>{if(!violations.includes(issue))violations.push(issue);};
  for(const e of events){
    const p=payload(e);
    if(e.type==='chatgpt.browser_observation_quarantined'){
      quarantinedObservationEventIds.push(e.id);
      if(!SHA.test(String((p as {fingerprint?:unknown}).fingerprint))||
        !SHA.test(String(p.promptSha256))||!SHA.test(String(p.assistantSha256))||
        (p as {status?:unknown}).status!=='UNATTRIBUTED_NO_CREDIT')
        warn('invalid_browser_observation_quarantine');
      warn('unresolved_browser_observation_quarantine');
    }
    if(e.type==='chatgpt.browser_reserved'){
      if(typeof p.requestKey!=='string'||!p.requestKey.trim())warn('invalid_browser_reservation');
      else if(reserved.has(p.requestKey))warn('duplicate_browser_reservation_key');
      else {
        reserved.set(p.requestKey,e.id);
        if((p as EvidencePayload&{perChatLimit?:unknown}).perChatLimit!==MAX_RELAY_CHAT_TURNS)
          warn('invalid_versioned_chat_send_limit');
      }
    }
    if(e.type==='chatgpt.browser_migrated'){
      // An arbitrary migration marker must not reset the per-Chat Send counter.
      // Normal rollover commits this event immediately before the matching
      // observed response; recovered rollovers use their own observation type.
      if(pendingMigration!==null)warn('multiple_migrations_without_observation');
      if(typeof p.requestKey!=='string'||!reserved.has(p.requestKey)||used.has(p.requestKey))
        warn('migration_without_matching_reservation');
      if(typeof p.previousUrlSha256!=='string'||!SHA.test(p.previousUrlSha256)||
        typeof p.newUrlSha256!=='string'||!SHA.test(p.newUrlSha256)||
        p.previousUrlSha256===p.newUrlSha256)
        warn('invalid_migration_url_sha256');
      if(p.newTabTargetSha256!==undefined&&!SHA.test(String(p.newTabTargetSha256)))
        warn('invalid_migration_target_sha256');
      if(lastDestinationUrlSha256&&p.previousUrlSha256!==lastDestinationUrlSha256)
        warn('migration_source_url_discontinuity');
      if(typeof p.newUrlSha256==='string'&&SHA.test(p.newUrlSha256))
        lastDestinationUrlSha256=p.newUrlSha256;
      pendingMigration=typeof p.requestKey==='string'?p.requestKey:'';
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
    if(e.type==='chatgpt.browser_tab_retired'){
      const earlier=events.filter(x=>x.id<e.id);
      const migration=earlier.filter(x=>x.type==='chatgpt.browser_migrated').at(-1);
      const source=earlier.some(x=>x.id<(migration?.id??0)&&
        x.type==='chatgpt.browser_migrated'&&
        payload(x).newUrlSha256===p.retiredUrlSha256);
      const reply=earlier.find(x=>x.id>=(migration?.id??Number.MAX_SAFE_INTEGER)&&
        x.type==='chatgpt.browser_observed'&&
        payload(x).requestKey===payload(migration!).requestKey);
      if(!SHA.test(String(p.retiredUrlSha256))||!SHA.test(String(p.activeUrlSha256))||
        p.retiredUrlSha256===p.activeUrlSha256||!migration||!source||!reply||
        p.migrationEventId!==migration.id||p.observedEventId!==reply.id||
        payload(migration).previousUrlSha256!==p.retiredUrlSha256||
        payload(migration).newUrlSha256!==p.activeUrlSha256||
        tabRetirementReceipts.some(x=>x.retiredUrlSha256===p.retiredUrlSha256))
        warn('invalid_browser_tab_retirement');
      else tabRetirementReceipts.push({
        eventId:e.id,migrationEventId:migration.id,observationEventId:reply.id,
        retiredUrlSha256:p.retiredUrlSha256 as string,
        activeUrlSha256:p.activeUrlSha256 as string,
      });
    }
    if(!hasOwn(observationTypes,e.type))continue;
    const kind=observationTypes[e.type as ObservationType];
    const round=p.round,sha=p.assistantSha256,key=p.requestKey;
    if(pendingMigration!==null){
      if(kind!=='normal'||key!==pendingMigration)
        warn('migration_request_mismatch');
      pendingMigration=null;
    }
    if(typeof round!=='number'||!Number.isInteger(round)||round<1){
      warn('invalid_browser_observation_round');continue;
    }
    if(typeof sha!=='string'||!SHA.test(sha))warn('invalid_answer_sha256');
    if(typeof key!=='string'||!reserved.has(key))warn('observed_without_matching_reservation');
    else if(used.has(key))warn('duplicate_observed_request_key');
    else used.add(key);
    if(kind==='recovered-new-chat'){chatSegment++;chatTurn=0;}
    if(chatSegment===0)chatSegment=1; // The anchor Chat is segment one.
    chatTurn++;
    maxPerChat=Math.max(maxPerChat,chatTurn);
    if(chatTurn>MAX_RELAY_CHAT_TURNS)warn('chat_send_limit_exceeded');
    if(round!==observations.length+1)warn('nonsequential_observed_round');
    if(kind!=='normal'&&p.independentlyInspected!==true)
      warn('recovery_lacks_independent_inspection');
    if(kind==='recovered-new-chat'&&(
      typeof p.previousUrlSha256!=='string'||!SHA.test(p.previousUrlSha256)||
      typeof p.newUrlSha256!=='string'||!SHA.test(p.newUrlSha256)||
      p.previousUrlSha256===p.newUrlSha256))
      warn('invalid_recovered_migration_url_sha256');
    if(kind==='recovered-new-chat'){
      if(lastDestinationUrlSha256&&p.previousUrlSha256!==lastDestinationUrlSha256)
        warn('migration_source_url_discontinuity');
      if(typeof p.newUrlSha256==='string'&&SHA.test(p.newUrlSha256))
        lastDestinationUrlSha256=p.newUrlSha256;
    }
    observations.push({round,observedEventId:e.id,observedAt:e.createdAt,
      observation:kind,answerSha256:typeof sha==='string'?sha:'',
      chatSegment,chatTurn,decisionEventId:null,decisionAction:null,
      decisionShaMatches:null,
      reservedEventId:typeof key==='string'?reserved.get(key)??null:null,
      independentlyRecovered:kind!=='normal'&&p.independentlyInspected===true});
  }
  if(pendingMigration!==null)warn('migration_without_observed_response');
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
    else {
      warn('pi_decision_answer_sha_mismatch');
      pending.push(o.round);
    }
    if(allDecisions.get(o.round)?.some(d=>payload(d).responseSha256!==o.answerSha256))
      warn('historical_pi_decision_answer_sha_mismatch');
    if(decision.id<=o.observedEventId)warn('pi_decision_precedes_browser_observation');
  }
  if(observations.length!==mission.turnCount)warn('turn_counter_differs_from_observed_ledger');
  for(const decision of decisions.keys())if(decision>0&&
    !observations.some(o=>o.round===decision))warn('pi_decision_without_observed_round');
  const current=store.chatBrowserTurn(id);
  const latest=observations.at(-1);
  let activeRequestEvidence:PiEvidenceReport['activeRequestEvidence']=null;
  if(current&&['reserved','uncertain'].includes(current.status)){
    const candidates=events.filter(e=>e.type==='chatgpt.browser_reserved'&&
      payload(e).requestKey===current.requestKey);
    const currentReservation=candidates[0];
    const lastReservation=events.filter(e=>e.type==='chatgpt.browser_reserved').at(-1);
    const linked=candidates.length===1&&currentReservation===lastReservation&&
      payload(currentReservation!).promptSha256===current.promptSha256&&
      SHA.test(current.promptSha256)&&!used.has(current.requestKey)&&
      !current.assistantSha256&&
      (latest===undefined||currentReservation!.id>(decisions.get(latest.round)?.id??latest.observedEventId));
    if(!linked)warn('active_request_reservation_unlinked');
    else activeRequestEvidence={reservationEventId:currentReservation!.id,
      round:mission.turnCount+1,promptSha256:current.promptSha256,
      status:current.status as 'reserved'|'uncertain',
      newConversationIntent:current.newConversation===true};
  }
  // This highlights the real production failure signature without falsely
  // claiming that two intentional identical ChatGPT answers are impossible.
  const repeatedAnswerCandidates=observations.filter((o,i)=>i>0&&
    o.answerSha256===observations[i-1]?.answerSha256).map(o=>o.round);
  return {
    missionId:id,state:mission.state,turnCount:mission.turnCount,
    currentChatObservedTurns:store.piChatObservedTurns(id),
    observedTurns:observations.length,chatSegments:chatSegment,
    maxObservedTurnsInOneChat:maxPerChat,decisionsVerified:verified,
    pendingPiReviewRounds:pending,
    pendingBrowserRequest:current?.status==='reserved',
    activeRequestEvidence,
    pendingNewChatReservation:current?.status==='reserved'&&current.newConversation===true,
    violations,ledgerConsistent:violations.length===0,rounds:observations,
    tabRetirementReceipts,
    quarantinedObservationEventIds,
    repeatedAnswerCandidates,
    businessAcceptanceVerified:false,
  };
}
