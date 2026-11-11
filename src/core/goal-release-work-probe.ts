import {createHash} from 'node:crypto';
import {existsSync,lstatSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import type {Store} from './store.js';
import {GoalLedger} from './goal-store.js';
import {requireSettledReleaseCustody,InsufficientReleaseEvidenceError,
  type EvidenceReadback,type ReleaseProbe} from './goal-release.js';
import {inspectGoalRequestLedger} from './request-ledger.js';
import {inspectPiEvidence} from './pi-evidence.js';
import {approvedWorkTestPath,independentlyRunRemoteWorkTest,remoteReleaseCommand,
  type RemoteWorkTestResult} from './goal-release-remote.js';
import type {PictlRemoteConfig} from './pi-planner.js';

const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const SHA40=/^[0-9a-f]{40}$/;
const SHA64=/^[0-9a-f]{64}$/;
const UUID=/^[0-9a-f-]{36}$/i;
/** Operator-owned mapping under the private GMK evidence directory. A model
 * PASS or answer URL cannot generate this mapping or a verifier receipt. */
export interface IndependentWorkSpecification {
  version:1;goalId:string;sourceSha:string;criteria:Array<{
    acceptanceId:string;workItemId:string;criterionSha256:string;
    testFile:string;testName:string;answerSha256:string;
  }>;
}
export function loadIndependentWorkSpecification(file:string):{
  spec:IndependentWorkSpecification;sourceDigest:string
}{
  if(!existsSync(file))
    throw new InsufficientReleaseEvidenceError(
      'Missing independent operator-owned criterion verification mapping');
  if(!lstatSync(file).isFile()||lstatSync(file).size>65_536)
    throw new Error('Invalid independent operator-owned criterion verification mapping');
  const raw=readFileSync(file,'utf8');
  const spec=JSON.parse(raw) as IndependentWorkSpecification;
  if(!spec||spec.version!==1||!UUID.test(String(spec.goalId))||
    !SHA40.test(String(spec.sourceSha))||
    !Array.isArray(spec.criteria)||spec.criteria.length<1||spec.criteria.length>100)
    throw new Error('Invalid independent criterion verification mapping');
  const ids=new Set<string>();
  for(const rule of spec.criteria){
    if(!rule||!UUID.test(String(rule.acceptanceId))||
      !UUID.test(String(rule.workItemId))||
      !SHA64.test(String(rule.criterionSha256))||
      !SHA64.test(String(rule.answerSha256))||
      typeof rule.testFile!=='string'||typeof rule.testName!=='string'||
      !rule.testName.trim()||rule.testName.length>240||
      /[\r\n\u0000-\u001f]/.test(rule.testName)||
      ids.has(rule.acceptanceId))
      throw new Error('Criterion verification mapping is duplicated or not bounded');
    approvedWorkTestPath(rule.testFile);
    ids.add(rule.acceptanceId);
  }
  return {spec,sourceDigest:hash(raw)};
}
function verifyWorkClaim(store:Store,goalId:string,targetSha:string,
  requirement:string,spec:IndependentWorkSpecification):
    IndependentWorkSpecification['criteria'][number]&{
      workItemKey:string;answerOrigin:'direct-browser'|'independently-recovered';
      originalReservationEventId:number;originalObservationEventId:number;
      originalDecisionEventId:number;originalObservationSha256:string;
      recoveryReconciliationEventId:number|null;
    }{
  const id=requirement.startsWith('criterion:')?requirement.slice(10):'';
  if(!UUID.test(id)||spec.goalId!==goalId||spec.sourceSha!==targetSha||
    !SHA40.test(targetSha))
    throw new Error('Work proof source or Goal does not match release target');
  requireSettledReleaseCustody(store,goalId);
  const graph=new GoalLedger(store).graph(goalId),custody=inspectGoalRequestLedger(store,goalId);
  if(!custody.ledgerConsistent||custody.quarantineEventIds.length||
    custody.unattributedEventIds.length)
    throw new Error('Original work request custody is invalid');
  const criterion=graph.acceptance.find(x=>x.id===id),rule=spec.criteria.find(x=>x.acceptanceId===id);
  const item=criterion&&graph.items.find(x=>x.id===criterion.itemId);
  if(!criterion||!rule||!item||graph.goal.status!=='ACTIVE'||
    rule.workItemId!==item.id||hash(criterion.criterion)!==rule.criterionSha256||
    !graph.plans.some(p=>p.id===item.planId&&p.status==='APPROVED'))
    throw new Error('Criterion mapping lacks matching approved, PI-PASSED work and exact text');
  if(criterion.status!=='PASS'||item.status!=='PASSED')
    throw new InsufficientReleaseEvidenceError('PI work-item and acceptance have not passed');
  const credited=custody.requests.filter(r=>r.workItemId===item.id&&
    r.status==='observed'&&r.answerSha256===rule.answerSha256&&
    r.decisionEventId!==null&&
    criterion.evidenceRefs.includes('browser-sha256:'+r.answerSha256));
  if(credited.length!==1)
    throw new Error('Work claim not uniquely bound to a complete original browser answer');
  const original=credited[0]!;
  // A recovery also has status `observed` in the aggregate request ledger.
  // Do not allow its answer SHA to masquerade as a direct browser observation.
  // Independently reconstruct the immutable original request, observation,
  // reconciliation and PI decision before running any acceptance test.
  const report=inspectPiEvidence(store,original.missionId);
  const round=report.rounds.find(r=>r.round===original.round&&
    r.observedEventId===original.observationEventId);
  const events=store.events(original.missionId);
  const reservation=events.find(e=>e.id===original.reservationEventId&&
    e.type==='chatgpt.browser_reserved');
  const observed=events.find(e=>e.id===original.observationEventId);
  const decision=events.find(e=>e.id===original.decisionEventId);
  if(!report.ledgerConsistent||!round||!round.decisionShaMatches||
    round.reservedEventId!==original.reservationEventId||
    round.decisionEventId!==original.decisionEventId||
    round.answerSha256!==rule.answerSha256||
    !reservation||!observed||!decision||
    reservation.id>=observed.id||observed.id>=decision.id||
    (reservation.payload as {promptSha256?:string}).promptSha256!==original.promptSha256||
    (observed.payload as {requestKey?:string}).requestKey!==
      (reservation.payload as {requestKey?:string}).requestKey||
    (observed.payload as {assistantSha256?:string}).assistantSha256!==rule.answerSha256||
    (decision.payload as {responseSha256?:string}).responseSha256!==rule.answerSha256)
    throw new Error('Original browser observation and PI review provenance is inconsistent');
  const recovered=round.observation!=='normal';
  const reconciliation=events.filter(e=>e.type==='mission.reconciled'&&
    e.id>reservation.id&&e.id<observed.id);
  const uncertainty=events.filter(e=>e.type==='chatgpt.browser_uncertain'&&
    e.id>reservation.id&&e.id<observed.id&&
    (e.payload as {requestKey?:string}).requestKey===
      (reservation.payload as {requestKey?:string}).requestKey);
  let recoveryReconciliationEventId:number|null=null;
  if(recovered){
    const p=observed.payload as Record<string,unknown>;
    const deadOwner=p.recoverySource==='dead-owner-reserved';
    const expectedKind=round.observation==='recovered-turn'?
      deadOwner?'observed-dead-owner-reservation':'observed-browser-turn':
      deadOwner?'observed-dead-owner-rollover-reservation':'observed-browser-rollover';
    if(!round.independentlyRecovered||p.independentlyInspected!==true||
      p.originalReservationPreserved===false||
      reconciliation.length!==1||
      (reconciliation[0]!.payload as {kind?:string}).kind!==expectedKind||
      (deadOwner?uncertainty.length!==0:uncertainty.length!==1)||
      (round.observation==='recovered-turn'&&(
        p.originalReservationPreserved!==true||
        p.originalUncertainEventPreserved!==!deadOwner))||
      (round.observation==='recovered-new-chat'&&(
        p.previousUrlSha256!==original.sourceChatUrlSha256||
        p.newUrlSha256!==original.destinationChatUrlSha256))||
      !['chatgpt.browser_turn_recovered','chatgpt.browser_rollover_recovered']
        .includes(observed.type))
      throw new Error('Recovered answer lacks its unique original independently inspected request');
    recoveryReconciliationEventId=reconciliation[0]!.id;
  }else if(observed.type!=='chatgpt.browser_observed'||
    reconciliation.length||uncertainty.length)
    throw new Error('Direct browser answer was substituted with a recovery or uncertain Send');
  const reviewed=graph.events.filter(e=>e.type==='goal.pi_review'&&
    e.payload.itemId===item.id&&e.payload.verdict==='PASS'&&
    e.payload.answerSha256===original.answerSha256&&
    e.payload.missionId===original.missionId&&e.payload.round===original.round);
  if(reviewed.length!==1)
    throw new Error('Independent PI work approval does not match credited original request');
  return {...rule,workItemKey:item.key,
    answerOrigin:recovered?'independently-recovered':'direct-browser',
    originalReservationEventId:reservation.id,
    originalObservationEventId:observed.id,originalDecisionEventId:decision.id,
    originalObservationSha256:hash(JSON.stringify([
      observed.id,observed.type,observed.createdAt,observed.payload])),
    recoveryReconciliationEventId};
}
/** The named assertion must PASS in the selected tracked test file; a test
 * name mentioned in stdout, or SKIP/TODO, is not a verification. */
export function assessWorkTestOutput(stdout:string,exit:number,testName:string):string{
  if(exit!==0||!stdout.startsWith('TAP version 13\n')||
    stdout.length>30_000_000)
    throw new Error('Independent executable test failed or returned untrusted output');
  const lines=stdout.split(/\r?\n/);
  const successes=lines.filter(line=>/^\s*ok\s+\d+\s+-\s+/.test(line))
    .map(line=>line.trim().replace(/^ok\s+\d+\s+-\s+/,''));
  // A zero exit code and one matching `ok` line are not enough: truncated,
  // forged or contradictory TAP summaries must never certify a criterion.
  // Node's root plan counts top-level tests; nested subtests may contribute
  // additional assertions to the aggregate `# tests` count.
  const count=(pattern:RegExp):number|null=>{
    const values=lines.map(line=>pattern.exec(line)?.[1]).filter((x):x is string=>x!==undefined);
    return values.length===1?Number(values[0]):null;
  };
  const plan=count(/^1\.\.([1-9]\d*)$/);
  const tests=count(/^# tests ([1-9]\d*)$/);
  const pass=count(/^# pass ([1-9]\d*)$/);
  const fail=count(/^# fail (\d+)$/);
  const cancelled=count(/^# cancelled (\d+)$/);
  const skipped=count(/^# skipped (\d+)$/);
  const todo=count(/^# todo (\d+)$/);
  const topLevel=lines.filter(line=>/^ok [1-9]\d* - /.test(line)).length;
  if(successes.filter(name=>name===testName).length!==1||
    lines.some(line=>/^\s*not ok\s+\d+\s+-\s+/.test(line))||
    plan===null||plan!==topLevel||tests===null||
    tests!==successes.length||pass!==tests||
    fail!==0||cancelled!==0||skipped!==0||todo!==0)
    throw new Error('Required independently mapped test assertion did not pass exactly once');
  return hash(stdout);
}
/** The SSH command's one-time nonce is emitted by the authenticated remote
 * shell before Node starts. Retain original stderr and reject synthetic TAP
 * output without a matching execution identity. This is SSH-host provenance,
 * not hardware attestation and not permission to credit a model assertion. */
export function assessWorkTestExecution(test:RemoteWorkTestResult,
  targetSha:string,testFile:string):string {
  const e=test.execution;
  if(!e||e.executor!=='approved-operator-ssh'||e.sourceSha!==targetSha||
    e.testFile!==testFile||!SHA40.test(targetSha)||
    !/^[a-f0-9]{32}$/.test(String(e.sessionId))||
    !/^[a-zA-Z0-9._-]{1,255}$/.test(String(e.remoteHostname))||
    !/^[a-zA-Z0-9._-]{1,255}$/.test(String(e.remoteHostAlias))||
    !Number.isSafeInteger(e.shellPid)||e.shellPid<=0||
    !SHA64.test(String(e.commandSha256))||
    typeof test.stderr!=='string'||test.stderr.length>8_000_000)
    throw new Error('Independent test has no valid executor identity or source binding');
  const start=Date.parse(e.startedAt),finish=Date.parse(e.finishedAt);
  if(!Number.isFinite(start)||!Number.isFinite(finish)||start>finish||
    finish>Date.now()+60_000||Date.now()-finish>5*60_000||
    finish-start>10*60_000)
    throw new Error('Independent test execution timing is invalid');
  // The digest must correspond to the exact fixed SSH command, not just any
  // plausible 64-hex hash inserted into a fabricated receipt.
  const command=remoteReleaseCommand({sshHost:e.remoteHostAlias,
    project:e.remoteProject},'work-test',testFile,e.sessionId);
  if(hash(command)!==e.commandSha256)
    throw new Error('Independent executor command differs from approved tracked test');
  const markers=test.stderr.split(/\r?\n/).filter(line=>
    line.startsWith('MR_WORK_TEST_SESSION_V1\t'));
  const expected=`MR_WORK_TEST_SESSION_V1\t${e.sessionId}\t${e.remoteHostname}\t${e.shellPid}`;
  if(markers.length!==1||markers[0]!==expected)
    throw new Error('Independent test raw stderr lacks the matching executor session');
  return hash(test.stderr);
}
export async function inspectIndependentWorkCriterion(input:{
  store:Store;goalId:string;requirement:string;targetSha:string;
  privateDir:string;runTest:(sourceSha:string,testFile:string)=>
    Promise<RemoteWorkTestResult>|RemoteWorkTestResult;
}):Promise<EvidenceReadback>{
  const {store,goalId,requirement,targetSha}=input,dir=resolve(input.privateDir);
  const {spec,sourceDigest}=loadIndependentWorkSpecification(join(dir,'independent-work-map.json'));
  const rule=verifyWorkClaim(store,goalId,targetSha,requirement,spec);
  const beforeEvent=store.maxEventId();
  const test=await input.runTest(targetSha,rule.testFile);
  const stderrSha=assessWorkTestExecution(test,targetSha,rule.testFile);
  const testSha=assessWorkTestOutput(test.stdout,test.exit,rule.testName);
  const reread=loadIndependentWorkSpecification(join(dir,'independent-work-map.json'));
  if(reread.sourceDigest!==sourceDigest)
    throw new Error('Operator-owned independent acceptance mapping changed during test');
  const after=verifyWorkClaim(store,goalId,targetSha,requirement,reread.spec);
  if(JSON.stringify(after)!==JSON.stringify(rule))
    throw new Error('Approved work-item or original answer provenance changed during independent test');
  if(store.maxEventId()!==beforeEvent)
    throw new Error('Goal original event evidence changed during independent test');
  mkdirSync(dir,{recursive:true,mode:0o700});
  const testFile=join(dir,'work-test-'+testSha+'.tap');
  try{writeFileSync(testFile,test.stdout,{flag:'wx',mode:0o600});}
  catch(e){
    if((e as NodeJS.ErrnoException).code!=='EEXIST'||
      readFileSync(testFile,'utf8')!==test.stdout)throw e;
  }
  const stderrFile=join(dir,'work-stderr-'+stderrSha+'.log');
  try{writeFileSync(stderrFile,test.stderr,{flag:'wx',mode:0o600});}
  catch(e){
    if((e as NodeJS.ErrnoException).code!=='EEXIST'||
      readFileSync(stderrFile,'utf8')!==test.stderr)throw e;
  }
  const body=JSON.stringify({version:1,probeVersion:1,
    source:targetSha,targetSha,goalId,requirement,
    scenario:'original-pi-approved-criterion-executed-by-independent-operator-test',
    criterionSha256:rule.criterionSha256,workItemId:rule.workItemId,
    workItemKey:rule.workItemKey,
    answerSha256:rule.answerSha256,answerOrigin:rule.answerOrigin,
    originalReservationEventId:rule.originalReservationEventId,
    originalObservationEventId:rule.originalObservationEventId,
    originalDecisionEventId:rule.originalDecisionEventId,
    originalObservationSha256:rule.originalObservationSha256,
    recoveryReconciliationEventId:rule.recoveryReconciliationEventId,
    eventReferences:{originalReservationEventId:rule.originalReservationEventId,
      originalObservationEventId:rule.originalObservationEventId,
      originalDecisionEventId:rule.originalDecisionEventId,
      recoveryReconciliationEventId:rule.recoveryReconciliationEventId},
    testFile:rule.testFile,
    testName:rule.testName,testNameSha256:hash(rule.testName),
    testExitCode:test.exit,expectedOutcome:'PASS',observedOutcome:'PASS',
    evidenceProvenance:'authenticated-operator-ssh-tracked-test-and-original-pi-request',
    testLogSha256:testSha,
    testStderrSha256:stderrSha,executorSession:test.execution,
    independentMappingSha256:sourceDigest,observedAt:new Date().toISOString()});
  const proof=hash(body),file=join(dir,'work-receipt-'+proof+'.json');
  try{writeFileSync(file,body,{flag:'wx',mode:0o600});}
  catch(e){
    if((e as NodeJS.ErrnoException).code!=='EEXIST'||
      readFileSync(file,'utf8')!==body)throw e;
  }
  return {state:'PASS',reference:'independent-work://'+proof,
    proofSha256:proof,observedSha:targetSha};
}
export function independentWorkReleaseProbe(store:Store,goalId:string,
  privateDir:string,remote:PictlRemoteConfig):ReleaseProbe{
  return {source:'independent-work',inspect:async(requirement,targetSha)=>
    inspectIndependentWorkCriterion({store,goalId,requirement,targetSha,privateDir,
      runTest:(sha,file)=>independentlyRunRemoteWorkTest(remote,sha,file)})};
}
