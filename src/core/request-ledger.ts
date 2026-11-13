import {createHash} from 'node:crypto';
import {GoalLedger} from './goal-store.js';
import {inspectPiEvidence} from './pi-evidence.js';
import type {Store} from './store.js';
import type {MissionEvent} from './types.js';

const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const SHA=/^[0-9a-f]{64}$/;
const observedTypes=new Set(['chatgpt.browser_observed',
  'chatgpt.browser_turn_recovered','chatgpt.browser_rollover_recovered']);
const obj=(e:MissionEvent)=>e.payload as Record<string,unknown>;

export interface RequestCustody {
  missionId:string;parentMissionId:string|null;goalId:string;
  requestSha256:string;reservationEventId:number;promptSha256:string;
  sourceChatUrlSha256:string|null;destinationChatUrlSha256:string|null;
  round:number;workItemId:string|null;planId:string|null;
  observationEventId:number|null;answerSha256:string|null;
  decisionEventId:number|null;status:'observed'|'pending'|'uncertain'|'reconciled';
}

/** No live browser, PI or credentials. The immutable event IDs form a path
 * from Goal -> Mission/Chat -> Work -> request -> original browser receipt.
 * A legacy/uncertain Send remains visible without inventing observation.
 * Unknown events are reported as quarantined/unattributed, never credited. */
export function inspectGoalRequestLedger(store:Store,goalId:string){
  const graph=new GoalLedger(store).graph(goalId);
  const violations:string[]=[],requests:RequestCustody[]=[];
  const unattributedEventIds:number[]=[],quarantineEventIds:number[]=[];
  const verifiedTabRetirementEventIds:number[]=[];
  const warn=(s:string)=>{if(!violations.includes(s))violations.push(s);};
  const roots=graph.events.filter(e=>e.type==='goal.pi_mission_bound')
    .map(e=>e.payload.missionId).filter((v):v is string=>typeof v==='string');
  const visited=new Set<string>();
  for(const root of roots){
    if(store.getMeta(`goal.pi.binding.${root}`)!==goalId)
      warn('goal_root_binding_mismatch');
    let missionId:string|null=root;
    while(missionId){
      if(visited.has(missionId)){
        warn('goal_mission_chain_cycle_or_duplicate');break;
      }
      visited.add(missionId);
      const parentMissionId=store.piChainParent(missionId);
      const mission=store.get(missionId);
      if(mission.goal.trim()!==graph.goal.objective||!store.chatBrowserBinding(missionId))
        warn('mission_goal_scope_or_browser_binding_mismatch');
      const report=inspectPiEvidence(store,missionId);
      if(!report.ledgerConsistent)warn('mission_request_ledger_inconsistent');
      verifiedTabRetirementEventIds.push(...report.tabRetirementReceipts.map(r=>r.eventId));
      const events=store.events(missionId);
      const reservations=events.filter(e=>e.type==='chatgpt.browser_reserved');
      const observations=events.filter(e=>observedTypes.has(e.type));
      // Reconstruct conversation identity AT EACH original reservation, not
      // from the current mutable chat link. A later owner rebind, Chat
      // migration or 32→child must not rewrite historical source identity.
      const sources=new Map<number,string|null>();
      let chatHash:string|null=null;
      for(const e of events){
        const p=obj(e);
        if(e.type==='chatgpt.handoff_linked'&&typeof p.url==='string')
          chatHash=sha(p.url);
        if(e.type==='chatgpt.browser_reserved')sources.set(e.id,chatHash);
        if(['chatgpt.browser_migrated','chatgpt.browser_rollover_recovered'].includes(e.type)&&
          typeof p.newUrlSha256==='string'&&SHA.test(p.newUrlSha256))
          chatHash=p.newUrlSha256;
      }
      const requestUsed=new Set<string>();
      for(const reserve of reservations){
        const p=obj(reserve),key=p.requestKey;
        const sourceHash=sources.get(reserve.id)??null;
        if(typeof key!=='string'||!key||requestUsed.has(key)||
          typeof p.promptSha256!=='string'||!SHA.test(p.promptSha256)){
          warn('invalid_or_duplicate_reservation');continue;
        }
        requestUsed.add(key);
        const matches=observations.filter(o=>obj(o).requestKey===key);
        const migration=events.find(e=>e.type==='chatgpt.browser_migrated'&&
          e.id>reserve.id&&obj(e).requestKey===key);
        const reply=matches[0];
        if(matches.length>1||matches.some(o=>o.id<=reserve.id)){
          warn('duplicate_or_early_browser_settlement');
          unattributedEventIds.push(...matches.slice(1).map(e=>e.id));
        }
        if(migration&&migration.id<reserve.id)warn('migration_before_reservation');
        if(migration&&obj(migration).previousUrlSha256!==sourceHash)
          warn('browser_chat_url_lineage_mismatch');
        const destination=migration&&typeof obj(migration).newUrlSha256==='string'
          ?obj(migration).newUrlSha256 as string
          :reply?.type==='chatgpt.browser_rollover_recovered'&&
              typeof obj(reply).newUrlSha256==='string'
            ?obj(reply).newUrlSha256 as string:null;
        if(destination&&!SHA.test(destination))warn('invalid_destination_chat_sha');
        const answerSha256=reply?obj(reply).assistantSha256:null;
        if(reply&&(!SHA.test(String(answerSha256))||
          typeof obj(reply).round!=='number'))
          warn('invalid_original_browser_observation');
        const decision=reply?events.find(e=>e.id>reply.id&&
          ['pi.decision','pi.decision_revised','pi.decision_attribution_corrected'].includes(e.type)&&
          obj(e).round===obj(reply).round&&obj(e).responseSha256===answerSha256):undefined;
        const workItemId=typeof p.workItemId==='string'?p.workItemId:null;
        const planId=typeof p.planId==='string'?p.planId:null;
        if(p.promptFormat==='goal-work-v1'&&(
          p.goalId!==goalId||!planId||!workItemId||
          !graph.items.some(w=>w.id===workItemId&&w.goalId===goalId&&w.planId===planId)||
          !graph.plans.some(pl=>pl.id===planId&&pl.goalId===goalId)||
          !SHA.test(String(p.piResponseSha256))||!SHA.test(String(p.piPlanSha256))))
          warn('invalid_goal_work_request_binding');
        if(p.promptFormat==='goal-work-v1'){
          const saved=store.getMeta(`chatgpt.browser.prompt.${missionId}.${key}`);
          let validSnapshot=false;
          try{
            const parsed=JSON.parse(saved??'null') as {format?:string;prompt?:string}|null;
            validSnapshot=parsed?.format==='goal-work-v1'&&
              typeof parsed.prompt==='string'&&sha(parsed.prompt.trim())===p.promptSha256;
          }catch{/* Missing/corrupt original snapshot cannot establish custody. */}
          if(!validSnapshot)warn('goal_work_prompt_snapshot_missing_or_changed');
          const piSha=p.piResponseSha256;
          const inMission=events.some(e=>e.id<reserve.id&&
            ['pi.decision','pi.decision_revised','pi.decision_attribution_corrected'].includes(e.type)&&
            obj(e).responseSha256===piSha);
          const parent=parentMissionId?store.events(parentMissionId).some(e=>
            ['pi.decision','pi.decision_revised','pi.decision_attribution_corrected'].includes(e.type)&&
            obj(e).responseSha256===piSha):false;
          if(!inMission&&!parent)warn('goal_work_pi_checkpoint_not_in_audit');
        }
        if(p.promptFormat!==undefined&&p.promptFormat!=='goal-work-v1')
          warn('unknown_goal_prompt_format');
        const uncertain=events.some(e=>e.type==='chatgpt.browser_uncertain'&&
          obj(e).requestKey===key);
        const reconciled=events.some(e=>e.type==='chatgpt.browser_reconciled'&&
          obj(e).requestKey===key);
        requests.push({goalId,missionId,parentMissionId,
          requestSha256:sha(key),reservationEventId:reserve.id,
          promptSha256:p.promptSha256 as string,
          sourceChatUrlSha256:sourceHash,destinationChatUrlSha256:destination,
          round:reply?obj(reply).round as number:0,workItemId,planId,
          observationEventId:reply?.id??null,
          answerSha256:typeof answerSha256==='string'?answerSha256:null,
          decisionEventId:decision?.id??null,
          status:reply?'observed':reconciled?'reconciled':uncertain?'uncertain':'pending'});
      }
      for(const o of observations){
        if(!reservations.some(r=>obj(r).requestKey===obj(o).requestKey)){
          unattributedEventIds.push(o.id);
          warn('unattributed_historical_browser_observation');
        }
      }
      for(const q of events.filter(e=>e.type==='chatgpt.browser_observation_quarantined')){
        quarantineEventIds.push(q.id);
        warn('unresolved_browser_observation_quarantine');
      }
      missionId=store.piChainSuccessor(missionId);
    }
  }
  return {goalId,rootMissionIds:roots,missionIds:[...visited],requests,
    quarantineEventIds,unattributedEventIds,verifiedTabRetirementEventIds,violations,
    ledgerConsistent:violations.length===0,businessAcceptanceVerified:false as const};
}
