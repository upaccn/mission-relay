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
      else decisions.set(p.round,e);
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
