import {GoalLedger} from './goal-store.js';
import {GoalReleaseGate,RELEASE_GATES} from './goal-release.js';
import {inspectGoalRequestLedger} from './request-ledger.js';
import {inspectPiChainEvidence} from './pi-evidence.js';
import {inspectGoalChromeFiveToSixHistory} from './goal-release-chrome-history.js';
import type {Store} from './store.js';

/** An evidence INDEX, not an independent PASS assertion. A PI-reported
 * browser-sha256 link must resolve to the original Goal-bound request,
 * actual observed browser event and matching PI review before it can even
 * be listed as traceable. A linked claim still requires a separate trusted
 * release probe; this routine cannot set any release-check state. */
export function inspectGoalReleaseMatrix(store:Store,goalId:string){
  const graph=new GoalLedger(store).graph(goalId);
  const custody=inspectGoalRequestLedger(store,goalId);
  const chromeHistory=inspectGoalChromeFiveToSixHistory(store,goalId);
  const release=new GoalReleaseGate(store).report(goalId);
  const checked=new Map(release.checks.map(c=>[c.requirement,c]));
  // Historical plans and their acceptance rows remain in SQLite for audit,
  // but only the uniquely approved plan can contribute release requirements.
  // Including superseded plans makes the read-only matrix report obsolete
  // work as current blockers, unlike GoalReleaseGate's admission rules.
  const approved=graph.plans.filter(p=>p.status==='APPROVED');
  const currentItems=approved.length===1?
    graph.items.filter(item=>item.planId===approved[0]!.id):[];
  const currentItemIds=new Set(currentItems.map(item=>item.id));
  const channel=store.channelStatus('telegram');
  const lineage=custody.rootMissionIds.length===1?
    inspectPiChainEvidence(store,custody.rootMissionIds[0]!):null;
  const allGoalEvents=custody.missionIds.flatMap(id=>store.events(id));
  const eventIds=(types:string[])=>allGoalEvents.filter(e=>types.includes(e.type)).map(e=>e.id);
  const candidateEvents:Record<string,number[]>={
    'chrome-5-to-6':lineage?.missions.flatMap(m=>m.rounds
      .filter(r=>r.chatSegment>1&&r.chatTurn===1)
      .map(r=>r.observedEventId))??[],
    'mission-32-successor':lineage?.links.flatMap(l=>
      [l.limitEventId,l.successorEventId,l.startedEventId]
        .filter((id):id is number=>id!==null))??[],
    'maintenance-resume':eventIds([
      'mission.pause_requested','pi.pause_released',
      'pi.recovery_connection_drill_armed','pi.recovery_connection_drill_triggered',
      'pi.recovery_connection_drill_client_closed','pi.browser_read_retry_deferred']),
    'relay-tab-retirement':custody.verifiedTabRetirementEventIds,
  };
  const requirements=RELEASE_GATES.map(name=>({
    requirement:name,kind:'fixed' as const,
    candidateLedgerEventIds:candidateEvents[name]??[],
    state:checked.get(name)?.state??'PENDING',
    source:checked.get(name)?.source??null,
    evidenceReference:checked.get(name)?.reference??null,
    proofSha256:checked.get(name)?.proofSha256??null,
    requiresIndependentProbe:!['check','privacy-check','test','build',
      'ci-ubuntu','ci-macos','ci-windows'].includes(name),
  }));
  const claims=graph.acceptance.filter(a=>currentItemIds.has(a.itemId)).map(acceptance=>{
    const item=currentItems.find(w=>w.id===acceptance.itemId);
    if(!item)throw new Error('Goal acceptance refers to an unknown work item');
    const matched=custody.requests.filter(r=>r.workItemId===item.id&&
      r.answerSha256&&r.decisionEventId!==null&&
      acceptance.evidenceRefs.includes(`browser-sha256:${r.answerSha256}`));
    const requirement=`criterion:${acceptance.id}`,check=checked.get(requirement);
    return {
      requirement,kind:'business-criterion' as const,
      workItemKey:item.key,workItemState:item.status,
      criterion:acceptance.criterion,piClaimState:acceptance.status,
      attributedObservationEventIds:matched.map(r=>r.observationEventId),
      attributedDecisionEventIds:matched.map(r=>r.decisionEventId),
      observedAnswerDigests:matched.map(r=>r.answerSha256),
      piEvidenceRefs:acceptance.evidenceRefs,
      state:check?.state??'PENDING',source:check?.source??null,
      evidenceReference:check?.reference??null,
      proofSha256:check?.proofSha256??null,
      requiresIndependentProbe:true,
    };
  });
  return {
    goalId,goalState:graph.goal.status,goalVersion:graph.goal.version,
    targetSha:release.target?.targetSha??null,
    targetRevision:release.target?.revision??null,
    releaseReady:release.ready,releaseComplete:release.complete,
    releaseBlockers:release.blockers,
    workItems:currentItems.map(w=>({key:w.key,status:w.status,version:w.version})),
    runtime:{sourceSha:channel.runtimeProvenance?.sourceSha??null,
      transportHealth:channel.transportHealth,
      pollerPresent:channel.pollerPresent,
      note:'Worker-reported provenance is a candidate for independent GMK readback, not a verified release check'},
    lineage:{missionCount:lineage?.missionCount??0,
      chainConsistent:lineage?.chainConsistent??false,
      violations:lineage?.violations??['missing or multiple Goal root Missions']},
    requestCustody:{requests: custody.requests.length,
      unsettledReservationEventIds:custody.requests
        .filter(r=>r.status!=='observed')
        .map(r=>r.reservationEventId),
      violations:custody.violations,
      quarantineEventIds:custody.quarantineEventIds,
      unattributedEventIds:custody.unattributedEventIds},
    chromeHistory:{
      historicalRotations:chromeHistory.historicalRotations,
      custodyConsistent:chromeHistory.custodyConsistent,
      evidenceIndexSha256:chromeHistory.evidenceIndexSha256,
      releaseGateState:chromeHistory.releaseGateState,
      missingIndependentProof:chromeHistory.missingIndependentProof,
    },
    requirements:[...requirements,...claims],
    warning:'PI work PASS and a matching answer digest are claims/custody only. '+
      'They are not independent release verification. PENDING stays PENDING.',
  };
}
