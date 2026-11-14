import {createHash} from 'node:crypto';
import {inspectGoalRequestLedger} from './request-ledger.js';
import {inspectPiEvidence} from './pi-evidence.js';
import {MAX_RELAY_CHAT_TURNS,LEGACY_RELAY_CHAT_TURNS} from './chat-limits.js';
import type {Store} from './store.js';
import type {MissionEvent} from './types.js';

const SHA=/^[a-f0-9]{64}$/;
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const data=(event:MissionEvent|undefined):Record<string,unknown>=>
  event?.payload&&typeof event.payload==='object'&&!Array.isArray(event.payload)
    ?event.payload as Record<string,unknown>:{};

/** Read-only index of already-settled, Goal-bound current 8->9 and legacy
 * 10->11 boundaries. The exported name remains compatible with historical
 * release-evidence clients; new writes never gain a 10-Send allowance.
 * This reconstructs controller request/answer/PI/URL custody, with physical
 * Target fingerprints only where the original event actually recorded them.
 * It NEVER claims independent Chrome DOM/Target proof or a Gate PASS. */
export function inspectGoalChromeTenToElevenHistory(store:Store,goalId:string){
  const custody=inspectGoalRequestLedger(store,goalId);
  const rotations:Array<{
    missionOrdinal:number;fromRound:number;toRound:number;
    sourceObservationEventId:number;sourceDecisionEventId:number|null;
    reservationEventId:number|null;migrationEventId:number|null;
    observationEventId:number;decisionEventId:number|null;
    transitionKind:'observed-migration'|'recovered-rollover';
    sourceTargetFingerprintRecorded:boolean;
    destinationTargetFingerprintRecorded:boolean;
    originalEvidenceSha256:string;
    custodyConsistent:boolean;violations:string[];
    independentlyVerifiedCompleteAnswer:false;
    independentlyVerifiedPhysicalTab:false;
  }>=[];
  for(const [missionOrdinal,missionId] of custody.missionIds.entries()){
    const report=inspectPiEvidence(store,missionId);
    const events=store.events(missionId);
    const eventById=new Map(events.map(e=>[e.id,e]));
    const migrations=events.filter(e=>e.type==='chatgpt.browser_migrated');
    const missionRequests=custody.requests.filter(r=>r.missionId===missionId);
    for(let i=1;i<report.rounds.length;i++){
      const previous=report.rounds[i-1]!,current=report.rounds[i]!;
      if(![MAX_RELAY_CHAT_TURNS,LEGACY_RELAY_CHAT_TURNS].includes(previous.chatTurn)||
        current.chatTurn!==1)continue;
      const violations:string[]=[];
      const fail=(issue:string)=>{if(!violations.includes(issue))violations.push(issue);};
      const prior=missionRequests.find(r=>r.observationEventId===previous.observedEventId);
      const next=missionRequests.find(r=>r.observationEventId===current.observedEventId);
      const source=eventById.get(previous.observedEventId);
      const sourceDecision=previous.decisionEventId===null?undefined:
        eventById.get(previous.decisionEventId);
      const reservation=current.reservedEventId===null?undefined:
        eventById.get(current.reservedEventId);
      const reply=eventById.get(current.observedEventId);
      const recovered=reply?.type==='chatgpt.browser_rollover_recovered';
      const decision=current.decisionEventId===null?undefined:
        eventById.get(current.decisionEventId);
      const requestKey=data(reservation).requestKey;
      const candidates=migrations.filter(e=>e.id>(reservation?.id??Infinity)&&
        e.id<current.observedEventId&&data(e).requestKey===requestKey);
      const migration=candidates.length===1?candidates[0]:undefined;
      // Rollover recovery atomically records the original-request reply and
      // URL change in ONE event. It has no separate browser_migrated event
      // or trustworthy physical destination Target fingerprint.
      const mp=data(recovered?reply:migration);
      const priorMigration=migrations.filter(e=>e.id<previous.observedEventId&&
        data(e).newUrlSha256===prior?.sourceChatUrlSha256).at(-1);
      const priorTarget=data(priorMigration).newTabTargetSha256;
      const target=data(migration).newTabTargetSha256;
      const reconciliations=events.filter(e=>e.type==='mission.reconciled'&&
        e.id>(reservation?.id??Infinity)&&e.id<(reply?.id??-1));
      const reconciliation=reconciliations.length===1?reconciliations[0]:undefined;
      const uncertainEvents=events.filter(e=>e.type==='chatgpt.browser_uncertain'&&
        e.id>(reservation?.id??Infinity)&&e.id<(reply?.id??-1)&&
        data(e).requestKey===requestKey);
      const oneShotIntents=events.filter(e=>e.type==='chatgpt.browser_pre_send_retry_intent'&&
        e.id>(reservation?.id??Infinity)&&e.id<(reply?.id??-1)&&
        data(e).requestKey===requestKey);
      if(!report.ledgerConsistent||!custody.ledgerConsistent)
        fail('original_goal_or_mission_ledger_inconsistent');
      if(![MAX_RELAY_CHAT_TURNS,LEGACY_RELAY_CHAT_TURNS].includes(previous.chatTurn)||
        current.chatTurn!==1||
        current.chatSegment!==previous.chatSegment+1||
        current.round!==previous.round+1)
        fail('chat_rollover_turn_boundary_invalid');
      if(!prior||!next||prior.status!=='observed'||next.status!=='observed'||
        prior.round!==previous.round||next.round!==current.round||
        prior.reservationEventId!==previous.reservedEventId||
        next.reservationEventId!==current.reservedEventId||
        prior.observationEventId!==previous.observedEventId||
        next.observationEventId!==current.observedEventId||
        prior.decisionEventId!==previous.decisionEventId||
        next.decisionEventId!==current.decisionEventId)
        fail('original_request_attribution_invalid');
      if(!source||!sourceDecision||!reply||!decision||
        source.type!=='chatgpt.browser_observed'||
        !['chatgpt.browser_observed','chatgpt.browser_rollover_recovered'].includes(reply.type)||
        !['pi.decision','pi.decision_revised'].includes(sourceDecision.type)||
        !['pi.decision','pi.decision_revised'].includes(decision.type)||
        previous.decisionShaMatches!==true||current.decisionShaMatches!==true||
        data(source).assistantSha256!==previous.answerSha256||
        data(sourceDecision).responseSha256!==previous.answerSha256||
        !['NEXT','HANDOFF'].includes(String(data(sourceDecision).action))||
        data(reply).assistantSha256!==current.answerSha256||
        data(decision).responseSha256!==current.answerSha256||
        data(decision).round!==current.round||
        !SHA.test(current.answerSha256)||!SHA.test(previous.answerSha256)||
        source.id>=sourceDecision.id||sourceDecision.id>=(reservation?.id??-1)||
        (reservation?.id??Infinity)>=reply.id||reply.id>=decision.id)
        fail('complete_answer_hash_or_pi_decision_chain_invalid');
      if(!reservation||reservation.type!=='chatgpt.browser_reserved'||
        !SHA.test(String(data(reservation).promptSha256))||
        next?.promptSha256!==data(reservation).promptSha256||
        next?.requestSha256!==hash(String(requestKey))||
        data(reply).requestKey!==requestKey||
        (!recovered&&data(migration).requestKey!==requestKey))
        fail('reserved_prompt_or_request_identity_invalid');
      if((recovered?candidates.length!==0:!migration||candidates.length!==1)||
        !SHA.test(String(mp.previousUrlSha256))||
        !SHA.test(String(mp.newUrlSha256))||
        mp.previousUrlSha256===mp.newUrlSha256||
        prior?.sourceChatUrlSha256!==mp.previousUrlSha256||
        next?.sourceChatUrlSha256!==mp.previousUrlSha256||
        next?.destinationChatUrlSha256!==mp.newUrlSha256)
        fail('original_chat_migration_invalid');
      // The newest recovered destination also has a separate persisted
      // current Chat link. Do not let a fabricated digest validate itself
      // through request-ledger, which derives its destination from the event.
      if(recovered&&!events.some(e=>e.id>reply.id&&
        ['chatgpt.browser_migrated','chatgpt.browser_rollover_recovered'].includes(e.type))&&
        hash(store.chatLink(missionId)??'')!==mp.newUrlSha256)
        fail('original_chat_migration_invalid');
      if(recovered){
        const rp=data(reply),reconciled=data(reconciliation);
        const deadOwner=reconciled.kind==='observed-dead-owner-rollover-reservation';
        const priorUncertain=uncertainEvents[0];
        if(!reconciliation||reconciliations.length!==1||
          !['observed-browser-rollover','observed-dead-owner-rollover-reservation']
            .includes(String(reconciled.kind))||
          rp.independentlyInspected!==true||
          (deadOwner?(uncertainEvents.length!==0||rp.recoverySource!=='dead-owner-reserved'||
            rp.originalReservationPreserved!==true||
            rp.originalUncertainEventPreserved!==false):
            uncertainEvents.length!==1||rp.recoverySource==='dead-owner-reserved')||
          oneShotIntents.length>1||
          (oneShotIntents.length===1&&(
            deadOwner||!priorUncertain||oneShotIntents[0]!.id<=priorUncertain.id||
            oneShotIntents[0]!.id>=reconciliation.id||
            data(oneShotIntents[0]).originalPromptSha256!==data(reservation).promptSha256||
            data(oneShotIntents[0]).priorReservationEventId!==previous.reservedEventId||
            data(oneShotIntents[0]).priorObservationEventId!==previous.observedEventId||
            data(oneShotIntents[0]).priorAssistantSha256!==previous.answerSha256||
            data(oneShotIntents[0]).noExistingSendClicked!==true||
            data(oneShotIntents[0]).maxAttempts!==1)))
          fail('recovered_rollover_provenance_invalid');
      }
      // A recovered rollover did not persist the new physical Chrome Target.
      // The index may validate its *logical* URL custody but can never assert
      // that the historical destination tab was independently observed.
      if(!priorMigration||!SHA.test(String(priorTarget))||
        (!recovered&&(!SHA.test(String(target))||priorTarget===target)))
        fail('physical_target_identity_not_proven_in_original_ledger');
      if(!recovered&&SHA.test(String(target))){
        // Include the source tab created before this rollover, not only
        // targets encountered in the current boundary rows.
        if(migrations.some(e=>e.id!==migration?.id&&
          data(e).newTabTargetSha256===target&&
          data(e).newUrlSha256!==mp.newUrlSha256))
          fail('physical_target_reused_for_distinct_chat');
      }
      const original=[source,sourceDecision,reservation,...(recovered?
        [...uncertainEvents,...oneShotIntents,reconciliation]:[migration]),reply,decision]
        .filter((e):e is MissionEvent=>Boolean(e))
        .map(e=>[e.id,e.createdAt,e.type,e.payload]);
      rotations.push({missionOrdinal:missionOrdinal+1,
        fromRound:previous.round,toRound:current.round,
        sourceObservationEventId:previous.observedEventId,
        sourceDecisionEventId:previous.decisionEventId,
        reservationEventId:current.reservedEventId,
        migrationEventId:migration?.id??null,
        observationEventId:current.observedEventId,
        decisionEventId:current.decisionEventId,
        transitionKind:recovered?'recovered-rollover':'observed-migration',
        sourceTargetFingerprintRecorded:SHA.test(String(priorTarget)),
        destinationTargetFingerprintRecorded:!recovered&&SHA.test(String(target)),
        originalEvidenceSha256:hash(JSON.stringify(original)),
        custodyConsistent:violations.length===0,violations,
        independentlyVerifiedCompleteAnswer:false,
        independentlyVerifiedPhysicalTab:false});
    }
  }
  const report={version:2,goalMissionCount:custody.missionIds.length,
    historicalRotations:rotations.length,
    custodyConsistent:custody.ledgerConsistent&&rotations.length>0&&
      rotations.every(x=>x.custodyConsistent),
    pendingOriginalRequestsExcluded:custody.requests
      .filter(r=>r.status!=='observed').map(r=>r.reservationEventId),
    rotations,
    releaseGateState:'PENDING' as const,
    missingIndependentProof:[
      'historical_full_answer_direct_chrome_attestation',
      'historical_physical_target_independent_attestation',
      'immutable_sha_bound_release_target_and_authoritative_pi_review',
    ],
    warning:'Original controller hashes and tab fingerprints are historical custody evidence, not independent Chrome verification or a Release Gate PASS.',
  };
  return {...report,evidenceIndexSha256:hash(JSON.stringify(report))};
}
