import {createHash} from 'node:crypto';
import {inspectGoalReleaseMatrix} from './goal-release-matrix.js';
import {inspectGoalRequestLedger} from './request-ledger.js';
import {approvedReleaseEvidenceSource} from './goal-release.js';
import type {Store} from './store.js';

const SHA40=/^[0-9a-f]{40}$/;
const sourceGates=new Set(['check','privacy-check','test','build']);
const ciGates=new Set(['ci-ubuntu','ci-macos','ci-windows']);

type CandidateClass='none'|'model-claim'|'controller-ledger'|'runtime-reported'|
  'independent-release-receipt';

/** A bounded, read-only evidence coverage report. It is NOT a ReleaseProbe:
 * an event, answer hash, CI claim, or matching Worker version cannot write
 * GoalReleaseGate PASS. Only the existing trusted inspectors can do that. */
export function inspectGoalReleaseCoverage(store:Store,goalId:string,candidateSha:string){
  if(!SHA40.test(candidateSha))throw new Error('Coverage requires an exact lowercase candidate SHA');
  const matrix=inspectGoalReleaseMatrix(store,goalId);
  const originalRequests=inspectGoalRequestLedger(store,goalId).requests;
  const targetIsCandidate=matrix.targetSha===candidateSha;
  const reservations=matrix.requestCustody.unsettledReservationEventIds;
  const blockers=[
    ...(!targetIsCandidate?['missing_or_different_immutable_release_target']:[]),
    ...(matrix.workItems.some(item=>item.status!=='PASSED')?
      ['pi_work_items_not_all_passed']:[]),
    ...(reservations.length?['unsettled_original_browser_requests']:[]),
    ...(matrix.requestCustody.violations.length||
      matrix.requestCustody.quarantineEventIds.length||
      matrix.requestCustody.unattributedEventIds.length?
        ['invalid_or_unattributed_original_request_evidence']:[]),
    ...(!matrix.lineage.chainConsistent?['mission_chain_ledger_inconsistent']:[]),
  ];
  const healthyWorker=matrix.runtime.sourceSha===candidateSha&&
    matrix.runtime.pollerPresent&&matrix.runtime.transportHealth==='healthy';
  const releaseGates=matrix.requirements.map(row=>{
    const isBusiness=row.kind==='business-criterion';
    const candidateEventIds=isBusiness?
      [...row.attributedObservationEventIds,...row.attributedDecisionEventIds]:
      row.candidateLedgerEventIds;
    const evidenceEventIds=[...new Set(candidateEventIds.filter(
      (id):id is number=>typeof id==='number'&&Number.isSafeInteger(id)&&id>0))]
      .sort((a,b)=>a-b);
    const hasPIClaim=isBusiness&&row.piClaimState==='PASS'&&
      row.attributedObservationEventIds.length>0&&
      row.attributedDecisionEventIds.length>0;
    const originalRequestCustody=row.kind==='business-criterion'?
      originalRequests.filter(request=>request.observationEventId!==null&&
        row.attributedObservationEventIds.includes(request.observationEventId)&&
        request.decisionEventId!==null&&
        row.attributedDecisionEventIds.includes(request.decisionEventId)&&
        request.answerSha256!==null&&
        row.observedAnswerDigests.includes(request.answerSha256))
        .map(request=>({reservationEventId:request.reservationEventId,
          observationEventId:request.observationEventId,
          decisionEventId:request.decisionEventId,
          requestSha256:request.requestSha256,promptSha256:request.promptSha256,
          answerSha256:request.answerSha256})):[];
    let candidateClass:CandidateClass='none';
    if(isBusiness&&hasPIClaim)candidateClass='model-claim';
    else if(!isBusiness&&evidenceEventIds.length)candidateClass='controller-ledger';
    else if(!isBusiness&&row.requirement==='gmk-production-readback'&&healthyWorker)
      candidateClass='runtime-reported';

    const missing:string[]=[];
    if(sourceGates.has(row.requirement)){
      missing.push('exact_sha_trusted_source_check_receipt');
    }else if(ciGates.has(row.requirement)){
      missing.push('exact_sha_authenticated_push_main_ci_receipt');
    }else if(row.requirement==='chrome-10-to-11'){
      if(!evidenceEventIds.length)missing.push('goal_bound_observed_tenth_to_eleventh_turn');
      missing.push('independent_original_request_and_physical_chrome_handoff_attestation');
    }else if(row.requirement==='mission-32-successor'){
      if(!matrix.lineage.chainConsistent||matrix.lineage.missionCount<2||
        !evidenceEventIds.length)
        missing.push('goal_bound_32_turn_parent_and_observed_successor');
      missing.push('independent_child_first_reply_and_new_chat_attestation');
    }else if(row.requirement==='maintenance-resume'){
      if(!evidenceEventIds.length)missing.push('goal_bound_settled_maintenance_checkpoint');
      missing.push('original_drained_snapshot_worker_restart_and_authorized_resume_audit');
    }else if(row.requirement==='relay-tab-retirement'){
      if(!evidenceEventIds.length)missing.push('provenance_linked_controller_tab_retirement');
      missing.push('independent_physical_tab_custody_and_owner_tab_preservation');
    }else if(row.requirement==='gmk-production-readback'){
      if(!healthyWorker)missing.push('matching_healthy_actual_worker_source_sha');
      missing.push('trusted_quiescent_worker_sqlite_task_and_stable_chrome_readback');
    }else if(isBusiness){
      if(row.workItemState!=='PASSED'||row.piClaimState!=='PASS')
        missing.push('authoritative_pi_approved_criterion');
      if(!hasPIClaim)missing.push('original_observation_and_matching_pi_decision');
      missing.push('requirement_specific_independent_work_probe');
    }else{
      missing.push('unrecognized_release_requirement');
    }
    // Even a known positive check is not reusable across release revisions.
    // A recorded source/proof cannot be mistaken for a receipt for this SHA.
    const recordedForCandidate=targetIsCandidate&&row.state==='PASS'&&
      !matrix.releaseBlockers.includes(row.requirement)&&
      typeof row.proofSha256==='string'&&/^[0-9a-f]{64}$/.test(row.proofSha256)&&
      typeof row.evidenceReference==='string'&&row.evidenceReference.length>0&&
      approvedReleaseEvidenceSource(row.requirement,row.source);
    if(recordedForCandidate){
      candidateClass='independent-release-receipt';
      missing.length=0;
    }
    return {
      requirement:row.requirement,kind:row.kind,
      ...(isBusiness?{workItemKey:row.workItemKey}:{}),
      existingTargetState:row.state,
      candidateState:!targetIsCandidate?'NOT_TARGET' as const:
        row.state==='PASS'&&!recordedForCandidate?'UNVERIFIED' as const:row.state,
      candidateClass,
      originalEventIds:evidenceEventIds,
      originalRequestCustody,
      ...(recordedForCandidate?{
        receiptSource:row.source,
        receiptReferenceSha256:createHash('sha256')
          .update(row.evidenceReference as string).digest('hex'),
        receiptSha256:row.proofSha256}:{}),
      missing,
    };
  });
  const snapshot={version:1,goalId,candidateSha,
    releaseTargetSha:matrix.targetSha,releaseTargetMatchesCandidate:targetIsCandidate,
    existingTargetReady:matrix.releaseReady,
    existingTargetComplete:matrix.releaseComplete,
    candidateReady:targetIsCandidate&&matrix.releaseReady,
    candidateComplete:targetIsCandidate&&matrix.releaseComplete,
    blockers,
    workItems:matrix.workItems.map(w=>({key:w.key,status:w.status})),
    requestCustody:{unsettledReservationEventIds:reservations,
      violations:matrix.requestCustody.violations,
      quarantineEventIds:matrix.requestCustody.quarantineEventIds,
      unattributedEventIds:matrix.requestCustody.unattributedEventIds},
    lineage:matrix.lineage,
    chromeHistory:matrix.chromeHistory,
    worker:{reportedSourceSha:matrix.runtime.sourceSha,
      reportedHealthy:healthyWorker},
    requirements:releaseGates,
  };
  const indexSha256=createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  return {...snapshot,indexSha256,summary:{
    total:releaseGates.length,
    recordedPass:releaseGates.filter(x=>x.candidateClass==='independent-release-receipt').length,
    unverified:releaseGates.filter(x=>x.missing.length>0).length,
    ledgerOrModelCandidates:releaseGates.filter(x=>
      x.candidateClass==='controller-ledger'||x.candidateClass==='model-claim').length,
  },warning:'Read-only coverage and index SHA are not independent browser, business or '+
    'Release Gate PASS receipts. Missing items must not be filled with model claims.'};
}
