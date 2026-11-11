import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import type {Store,ChatBrowserTurn} from './store.js';
import {goalReleaseCustodyBlockers,requireSettledReleaseCustody,
  InsufficientReleaseEvidenceError,type ReleaseProbe} from './goal-release.js';
import {inspectGoalRequestLedger,type RequestCustody} from './request-ledger.js';
import {verifiedRuntimeProvenance,type RuntimeProvenance} from './runtime-provenance.js';
import {withReadOnlyDeadline} from './read-only-deadline.js';
import {connectChatPage,inspectChatPage,lastVisibleUserPromptSha256,
  withBrowserSession} from '../plugins/chatgpt-browser.js';

const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const sha40=/^[0-9a-f]{40}$/;
interface TaskStatus {
  installed:boolean;taskVerified:boolean;taskState:string;recoverySchedule:boolean;
  pollerPresent:boolean;pollerPid:number;transportHealth:string;
  workerProcessVerified?:boolean;
  workerProcessStartedAt?:string|null;
  workerParentStartedAt?:string|null;
}
interface ChannelProof {
  source:string;inboxCursor:number;notificationsCursor:number;lastEventId:number;
  pollerPresent:boolean;pollerPid:number|null;transportHealth:string;
  drainRequested:boolean;pendingReplies:number;
  runtimeProvenance:(RuntimeProvenance&{pid:number;at:string})|null;
}
/** The independent read-only operator CLI must attest the separately running,
 * enrolled Worker lease; the CLI PID itself is deliberately NOT the Worker
 * PID. A matching compiled checkout without that live Worker is insufficient.
 * This is local process/SQLite evidence, not hardware attestation. */
export interface ReleaseWorkerIdentity {
  source:RuntimeProvenance;
  workerPid:number;
  workerAttestedAt:string;
  workerProcessStartedAt:string;
  workerParentStartedAt:string;
  inboxCursor:number;
  notificationsCursor:number;
  lastEventId:number;
  enrolledTaskVerified:true;
}
export function assessReleaseWorkerIdentity(targetSha:string,source:RuntimeProvenance,
  channel:ChannelProof,task:TaskStatus,now=Date.now()):ReleaseWorkerIdentity {
  const w=channel.runtimeProvenance;
  // The enrolled Windows task independently samples the process birth time
  // and verifies the exact Node child / PowerShell Worker parent. A reused
  // numeric PID has a later birth time than the original lease attestation.
  const processBorn=Date.parse(task.workerProcessStartedAt??'');
  const parentBorn=Date.parse(task.workerParentStartedAt??'');
  const attested=Date.parse(w?.at??'');
  if(!sha40.test(targetSha)||source.sourceSha!==targetSha||
    !w||w.sourceSha!==source.sourceSha||
    w.compiledTreeSha256!==source.compiledTreeSha256||
    w.cliSha256!==source.cliSha256||
    w.manifestSha256!==source.manifestSha256||
    w.fileCount!==source.fileCount||
    !Number.isSafeInteger(w.pid)||w.pid<=0||
    typeof w.at!=='string'||!Number.isFinite(now)||
    !Number.isFinite(attested)||attested>now+30_000||
    task.workerProcessVerified!==true||
    typeof task.workerProcessStartedAt!=='string'||
    typeof task.workerParentStartedAt!=='string'||
    !Number.isFinite(processBorn)||
    !Number.isFinite(parentBorn)||parentBorn>=processBorn||
    processBorn>=attested||processBorn>now+30_000||
    w.pid!==channel.pollerPid||!channel.pollerPresent||
    channel.source!=='telegram'||channel.transportHealth!=='healthy'||
    channel.drainRequested||channel.pendingReplies!==0||
    ![channel.inboxCursor,channel.notificationsCursor,channel.lastEventId]
      .every(n=>Number.isSafeInteger(n)&&n>=0)||
    channel.notificationsCursor!==channel.lastEventId||
    !task.installed||!task.taskVerified||task.taskState!=='Running'||
    !task.recoverySchedule||!task.pollerPresent||
    task.pollerPid!==w.pid||task.transportHealth!=='healthy')
    throw new Error('Trusted ReleaseProbe lacks the enrolled, healthy exact-SHA Worker identity');
  return {source,workerPid:w.pid,workerAttestedAt:w.at,
    workerProcessStartedAt:task.workerProcessStartedAt!,
    workerParentStartedAt:task.workerParentStartedAt!,
    inboxCursor:channel.inboxCursor,
    notificationsCursor:channel.notificationsCursor,lastEventId:channel.lastEventId,
    enrolledTaskVerified:true};
}
/** Read-only production binding; permits the independent operator CLI while
 * refusing an absent, old or replaced enrolled Worker. */
export function readReleaseWorkerIdentity(store:Store,targetSha:string,
  entry=process.argv[1]):ReleaseWorkerIdentity {
  if(process.platform!=='win32'||!entry)
    throw new Error('Trusted ReleaseProbe requires the enrolled Windows Worker');
  return assessReleaseWorkerIdentity(targetSha,verifiedRuntimeProvenance(entry),
    store.channelStatus('telegram'),enrolledTaskStatus(entry));
}
export function assertStableReleaseWorkerIdentity(before:ReleaseWorkerIdentity,
  after:ReleaseWorkerIdentity):void {
  if(JSON.stringify(before)!==JSON.stringify(after))
    throw new Error('Trusted ReleaseProbe Worker identity changed during evidence inspection');
}
/** Do not return even a formerly successful physical inspector's PASS after
 * the Worker lease/task/cursor changes during a long read. Both adapters
 * delegate their before/after guards here; tests inject only isolated reads. */
export async function withStableReleaseWorkerIdentity<T>(
  read:()=>ReleaseWorkerIdentity,inspect:(identity:ReleaseWorkerIdentity)=>Promise<T>|T,
):Promise<T>{
  const before=read();
  const result=await inspect(before);
  assertStableReleaseWorkerIdentity(before,read());
  return result;
}
export interface GmkReadback {
  source:RuntimeProvenance;channel:ChannelProof;task:TaskStatus;
  sqliteIntegrity:string;foreignKeyViolations:number;
  chrome:{exactUrl:boolean;promptSha256:string|null;answerSha256:string|null;
    stable:boolean;composerReady:boolean;generating:boolean};
  expectedPromptSha256:string;expectedAnswerSha256:string;
}

/** Pure, strict verdict over independently acquired readbacks. A disconnected
 * browser, forged task, stale lease or mismatched compiled tree is never PASS.
 * This gate checks GMK health, not the separate 5/32, tab or business gates. */
export function assessGmkReadback(targetSha:string,readback:GmkReadback):void {
  const {source,channel,task,chrome}=readback;
  // Use the same exact-SHA Worker proof as the Chrome, successor and
  // maintenance probes. A matching PID and source tree with missing or
  // malformed lease attestation is not a production Release Gate PASS.
  try{assessReleaseWorkerIdentity(targetSha,source,channel,task);}
  catch{throw new Error('GMK runtime lease, exact source SHA or compiled Worker proof is not healthy');}
  if(readback.sqliteIntegrity!=='ok'||readback.foreignKeyViolations!==0)
    throw new Error('GMK SQLite integrity or foreign key verification failed');
  if(!chrome.exactUrl||!chrome.stable||!chrome.composerReady||chrome.generating||
    !/^[0-9a-f]{64}$/.test(readback.expectedPromptSha256)||
    !/^[0-9a-f]{64}$/.test(readback.expectedAnswerSha256)||
    chrome.promptSha256!==readback.expectedPromptSha256||
    chrome.answerSha256!==readback.expectedAnswerSha256)
    throw new Error('GMK exact pinned Chrome conversation or complete answer readback is unverified');
}

/** A browser inspection may span a Worker restart or maintenance drain.
 * Compare the AFTER state before persisting proof, not merely an initial
 * healthy sample. No second Send, notification or maintenance action. */
export function assertStableGmkChannel(before:ChannelProof,after:ChannelProof):void {
  if(after.source!==before.source||
    after.inboxCursor!==before.inboxCursor||
    after.notificationsCursor!==before.notificationsCursor||
    after.lastEventId!==before.lastEventId||
    !after.pollerPresent||after.pollerPid!==before.pollerPid||
    after.transportHealth!=='healthy'||after.drainRequested||
    after.pendingReplies!==0||!after.runtimeProvenance||
    JSON.stringify(after.runtimeProvenance)!==
      JSON.stringify(before.runtimeProvenance))
    throw new Error('GMK channel changed or became unsafe during read-only Chrome inspection');
}

/** Multiple historical requests may have identical prompt and answer text.
 * Require the actual original immutable request key in addition to content
 * hashes and the separately observed, PI-reviewed event identity. */
export function matchesOriginalReviewedRequest(
  original:RequestCustody,receipt:ChatBrowserTurn):boolean {
  return original.status==='observed'&&
    original.requestSha256===hash(receipt.requestKey)&&
    original.observationEventId!==null&&original.decisionEventId!==null&&
    original.promptSha256===receipt.promptSha256&&
    original.answerSha256===receipt.assistantSha256;
}

/** Only fixed, read-only action of the already-enrolled lifecycle script.
 * No arbitrary PowerShell command, task name or model-supplied path. The
 * Status action calls Assert-OurTask and emits taskVerified only if every
 * identity, account, privilege, action and IgnoreNew check succeeded. */
export function enrolledTaskStatus(entry:string):TaskStatus{
  const script=join(dirname(dirname(resolve(entry))),'scripts','windows','telegram-task.ps1');
  const literal=script.replaceAll("'","''");
  const result=spawnSync('pwsh',['-NoProfile','-NonInteractive','-Command',
    `& '${literal}' -Action Status | ConvertTo-Json -Compress -Depth 4`],{
    encoding:'utf8',timeout:20_000,maxBuffer:64*1024,windowsHide:true,shell:false,
  });
  if(result.error||result.status!==0||!result.stdout)
    throw new Error('Enrolled GMK Scheduled Task read-only identity probe unavailable');
  let read:unknown;
  try{read=JSON.parse(result.stdout);}catch{
    throw new Error('Enrolled GMK Scheduled Task returned invalid readback');
  }
  if(!read||typeof read!=='object'||Array.isArray(read))
    throw new Error('Enrolled GMK Scheduled Task returned invalid status');
  return read as TaskStatus;
}

/** A first-party, read-only production ReleaseProbe. The CLI binds its Store,
 * compiled entrypoint and browser profile; no caller can pass a PASS flag or
 * untrusted PI explanation. Only redacted original observations are logged
 * under the private state directory. The release ledger itself is written
 * later by the existing atomic GoalReleaseGate after this probe succeeds. */
export function gmkProductionReleaseProbe(store:Store,goalId:string,
  privateEvidenceDirectory:string,entry=process.argv[1]):ReleaseProbe {
  return {source:'gmk-readback',inspect:async(requirement,targetSha)=>{
    if(requirement!=='gmk-production-readback')
      throw new Error('GMK runtime probe cannot certify other release gates');
    if(process.platform!=='win32'||!entry)
      throw new Error('GMK production probe runs only on the enrolled Windows host');
    requireSettledReleaseCustody(store,goalId);
    const custody=inspectGoalRequestLedger(store,goalId);
    const missionId=custody.missionIds.at(-1);
    if(!missionId)
      throw new InsufficientReleaseEvidenceError('Release has no Goal-bound Mission');
    const mission=store.get(missionId),receipt=store.chatBrowserTurn(missionId);
    const latest=custody.requests.filter(r=>r.missionId===missionId).at(-1);
    const linked=store.chatLink(missionId),browserId=store.chatBrowserBinding(missionId);
    if(mission.state!=='PAUSED'||mission.stopRequested||mission.lastError||
      !receipt||!['observed','reconciled'].includes(receipt.status)||
      !store.hasVerifiedPiBrowserCheckpoint(missionId)||!receipt.assistantSha256||
      !latest||!matchesOriginalReviewedRequest(latest,receipt)||!linked||!browserId)
      throw new InsufficientReleaseEvidenceError(
        'GMK production probe lacks the latest PI-reviewed original browser checkpoint');
    const oldEventId=store.maxEventId(),oldVersion=mission.version;
    const source=verifiedRuntimeProvenance(entry);
    const channel=store.channelStatus('telegram');
    const task=enrolledTaskStatus(entry);
    const workerBefore=assessReleaseWorkerIdentity(targetSha,source,channel,task);
    const integrity=store.db.prepare('PRAGMA integrity_check').all() as
      Array<{integrity_check:string}>;
    const foreignKeys=store.db.prepare('PRAGMA foreign_key_check').all();
    const session=await withReadOnlyDeadline(connectChatPage(linked,{browserId}),30_000,
      late=>late.close());
    const chrome=await withBrowserSession(session,async page=>{
      const first=await withReadOnlyDeadline(inspectChatPage(page,linked));
      const firstPrompt=await withReadOnlyDeadline(lastVisibleUserPromptSha256(page));
      const second=await withReadOnlyDeadline(inspectChatPage(page,linked));
      const secondPrompt=await withReadOnlyDeadline(lastVisibleUserPromptSha256(page));
      return {
        exactUrl:first.url===linked&&second.url===linked,
        promptSha256:secondPrompt,
        answerSha256:hash(second.lastAssistant),
        stable:firstPrompt===secondPrompt&&first.lastAssistant===second.lastAssistant&&
          first.assistantCount===second.assistantCount&&
          first.userCount===second.userCount,
        composerReady:first.composerReady&&second.composerReady,
        generating:first.generating||second.generating,
      };
    });
    const readback:GmkReadback={source,channel,task,chrome,
      sqliteIntegrity:integrity.length===1?integrity[0]!.integrity_check:'invalid',
      foreignKeyViolations:foreignKeys.length,
      expectedPromptSha256:receipt.promptSha256,
      expectedAnswerSha256:receipt.assistantSha256};
    assessGmkReadback(targetSha,readback);
    const after=store.channelStatus('telegram'),latestMission=store.get(missionId);
    assertStableGmkChannel(channel,after);
    // Re-attest the actual Windows task as well as SQLite lease/cursors:
    // a task replaced while Chrome was being read must invalidate this PASS.
    assertStableReleaseWorkerIdentity(workerBefore,
      assessReleaseWorkerIdentity(targetSha,verifiedRuntimeProvenance(entry),
        after,enrolledTaskStatus(entry)));
    if(store.maxEventId()!==oldEventId||latestMission.version!==oldVersion||
      latestMission.stopRequested||store.chatBrowserTurn(missionId)?.requestKey!==receipt.requestKey||
      JSON.stringify(verifiedRuntimeProvenance(entry))!==JSON.stringify(source)||
      goalReleaseCustodyBlockers(store,goalId).length)
      throw new Error('GMK Worker, original request or Goal evidence changed during readback');
    const original=JSON.stringify({version:1,probeVersion:1,
      requirement:'gmk-production-readback',
      scenario:'enrolled-worker-and-current-physical-chrome-checkpoint',
      goalId,missionId,targetSha,
      expectedOutcome:'PASS',observedOutcome:'PASS',
      evidenceProvenance:'enrolled-windows-worker-live-chrome-and-sqlite',
      eventReferences:{originalReservationEventId:latest.reservationEventId,
        originalObservationEventId:latest.observationEventId,
        originalDecisionEventId:latest.decisionEventId,
        latestSQLiteEventId:oldEventId},
      source,channel,task:{installed:task.installed,taskVerified:task.taskVerified,
        taskState:task.taskState,recoverySchedule:task.recoverySchedule,
        pollerPid:task.pollerPid,workerProcessVerified:task.workerProcessVerified,
        workerProcessStartedAt:task.workerProcessStartedAt,
        workerParentStartedAt:task.workerParentStartedAt},chrome,
      sqliteIntegrity:readback.sqliteIntegrity,
      foreignKeyViolations:readback.foreignKeyViolations,
      expectedPromptSha256:receipt.promptSha256,
      expectedAnswerSha256:receipt.assistantSha256,
      observedAt:new Date().toISOString()});
    const proofSha256=hash(original),dir=resolve(privateEvidenceDirectory);
    mkdirSync(dir,{recursive:true,mode:0o700});
    const file=join(dir,`${proofSha256}.json`);
    try{writeFileSync(file,original,{flag:'wx',mode:0o600});}
    catch(error){
      if((error as NodeJS.ErrnoException).code!=='EEXIST'||
        readFileSync(file,'utf8')!==original)throw error;
    }
    return {state:'PASS',reference:`gmk-readback://${proofSha256}`,
      proofSha256,observedSha:source.sourceSha};
  }};
}
