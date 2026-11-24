import type {Page} from 'playwriter';
import {createHash} from 'node:crypto';
import type {Store,PiPlan} from './store.js';
import {PI_NEXT_SOURCE_PREFLIGHT_ERROR} from './store.js';
import {PiInferenceError,SshPiPlanner,type PiPlanner} from './pi-planner.js';
import {PreSendError,inspectChatPage,lastVisibleUserPromptSha256} from '../plugins/chatgpt-browser.js';
import {executeBrowserTurn,executeBrowserRollover,browserGoalPlanningPrompt,
  type BrowserTurnOutcome} from './browser-controller.js';
import {MAX_RELAY_CHAT_TURNS} from './chat-limits.js';
import {withReadOnlyDeadline} from './read-only-deadline.js';
import {GoalLedger} from './goal-store.js';
import {isApprovedBuildRepository} from './build-scopes.js';
import {reviewGoalPiRound} from './goal-pi.js';
import {goalWorkPrompt} from './goal-prompts.js';
import {retireOwnedRelayTab} from './relay-tabs.js';

const MAX_REPLANS=3;
/** At most this many observed Relay Sends per ChatGPT conversation. */
export const MAX_PI_CHAT_TURNS=MAX_RELAY_CHAT_TURNS;

export interface PiAutopilotArgs {
  store:Store;planner:PiPlanner;missionId:string;revision:number;
  requestPrefix:string;page:Page;url:string;
  /** Cooperative scheduler: return only AFTER the original Send is settled
   * and the PI decision is durably committed. Never preempt a browser turn. */
  yieldAtGoalCheckpoint?:boolean;
  /** Only supplied after an independent read-only browser hash comparison. */
  recoveredAnswer?:{responseSha256:string;lastAssistant:string};
}

/** One PI review of a fully observed answer for this Mission's Goal. Owner
 * notes that arrive during inference cause a fresh review, never a Send. */
async function reviewPiRound(store:Store,planner:PiPlanner,missionId:string,
  responseSha256:string,lastAssistant:string,turnCount:number,replaceExisting=false):Promise<PiPlan>{
  if(createHash('sha256').update(lastAssistant).digest('hex')!==responseSha256)
    throw new Error('PI review refused: full browser answer SHA does not match its durable receipt');
  if(planner instanceof SshPiPlanner)
    store.auditPiDefaultModelInvocation(missionId,turnCount,responseSha256,planner.invocationPolicy());
  for(let attempt=0;attempt<MAX_REPLANS;attempt++){
    if(store.get(missionId).stopRequested)
      throw new Error('Owner requested a pause before PI could authorize another turn');
    try{
      return await reviewGoalPiRound({store,planner,missionId,responseSha256,
        lastAssistant,round:turnCount,replaceExisting,
        ownerDirectives:store.pendingPiOwnerDirectives(missionId)});
    }catch(error){
      if(error instanceof Error&&error.message.includes('Owner updates changed during Goal planning'))continue;
      throw error;
    }
  }
  throw new Error('Owner messages changed repeatedly during PI planning; paused without a new Send');
}

/** The Goal loop on the single leased browser: Send one prompt, observe the
 * complete answer, let PI decide, repeat until PI returns DONE or BLOCKED,
 * the owner pauses, or another Goal is waiting at a settled checkpoint. A
 * missing/invalid PI decision never authorizes another Send. */
export async function drivePiAutopilot(input:PiAutopilotArgs):Promise<void> {
  const {store,planner,missionId,requestPrefix}=input;
  const origin=store.get(missionId);
  if(!new GoalLedger(store).missionGoalId(missionId))
    throw new Error('Mission Relay runs Goal-bound Missions only');
  if(origin.turnCount===0&&origin.state!=='READY')
    throw new Error('A new Goal Mission must be READY before its first Send');
  if(!store.chatBrowserBinding(missionId))
    throw new Error('PI autopilot requires an exact pinned ChatGPT Mission');
  const writeWorkspace=origin.sandbox==='workspace-write'?origin.workspace:null;
  if(writeWorkspace&&!isApprovedBuildRepository(store,writeWorkspace))
    throw new Error('PI write mode requires its original locally approved repository');
  if(origin.sandbox!=='read-only'&&!writeWorkspace)
    throw new Error('PI Mission has no approved execution scope');
  let page=input.page,url=input.url,revision=input.revision;
  let ownedPage:Page|null=null;
  let nextPlan:PiPlan|null=null;
  let latestBrowserAnswer=input.recoveredAnswer?.lastAssistant??null;
  if(origin.turnCount>0){
    const last=store.chatBrowserTurn(missionId),plan=store.piPlan(missionId);
    if(origin.state!=='PAUSED'||origin.stopRequested||!last||
      !store.hasVerifiedPiBrowserCheckpoint(missionId))
      throw new Error('PI recovery refused: no exact, fully observed browser checkpoint');
    if(plan?.round===origin.turnCount&&plan.responseSha256===last.assistantSha256){
      if(['DONE','BLOCKED'].includes(plan.action))return;
      if(!['NEXT','HANDOFF'].includes(plan.action))
        throw new Error('PI recovery refused: previous plan cannot authorize continuation');
      nextPlan=plan;
    }else{
      if(!input.recoveredAnswer||
        input.recoveredAnswer.responseSha256!==last.assistantSha256||
        createHash('sha256').update(input.recoveredAnswer.lastAssistant).digest('hex')!==last.assistantSha256)
        throw new Error('PI recovery refused: the pending unreviewed browser response was not independently re-observed');
      nextPlan=await reviewPiRound(store,planner,missionId,
        input.recoveredAnswer.responseSha256,input.recoveredAnswer.lastAssistant,origin.turnCount);
      if(['DONE','BLOCKED'].includes(nextPlan.action))return;
    }
  }
  for(let i=origin.turnCount;;i++){
    let exactSource:{promptSha256:string;assistantSha256:string}|undefined;
    if(store.get(missionId).stopRequested)return;
    if(writeWorkspace&&!isApprovedBuildRepository(store,writeWorkspace))
      throw new Error('Approved build project was revoked or changed; no further browser send');
    if(i>0){
      if(!nextPlan)throw new Error('PI cannot continue without a durable next-step decision');
      // Owner notes that arrived after PI's NEXT are reviewed before any Send.
      for(let attempt=0;attempt<MAX_REPLANS&&store.pendingPiOwnerDirectives(missionId).length;attempt++){
        if(!latestBrowserAnswer)throw new Error('PI re-plan refused: previous browser answer text unavailable');
        nextPlan=await reviewPiRound(store,planner,missionId,
          nextPlan.responseSha256,latestBrowserAnswer,nextPlan.round,true);
        if(['DONE','BLOCKED'].includes(nextPlan.action))return;
      }
      if(store.pendingPiOwnerDirectives(missionId).length)
        throw new Error('PI owner updates changed repeatedly; no browser Send is authorized');
      // PI WAIT: the selected package is waiting for a running process. Release
      // the browser at this settled checkpoint; the Worker resumes after it.
      if(store.piDispatchNotBefore(missionId)>Date.now())return;
      // Refuse to append to a conversation someone else changed meanwhile.
      const previous=store.chatBrowserTurn(missionId);
      const snapshot=await withReadOnlyDeadline(inspectChatPage(page,url));
      const userSha=await withReadOnlyDeadline(lastVisibleUserPromptSha256(page));
      if(!snapshot.composerReady||snapshot.generating||!previous||
        !store.hasVerifiedPiBrowserCheckpoint(missionId)||
        createHash('sha256').update(snapshot.lastAssistant).digest('hex')!==nextPlan.responseSha256||
        userSha!==previous.promptSha256)
        throw new Error(PI_NEXT_SOURCE_PREFLIGHT_ERROR);
      exactSource={promptSha256:previous.promptSha256,assistantSha256:previous.assistantSha256!};
    }
    const requestKey=store.nextRequestKey(missionId,`${requestPrefix}-${i+1}`);
    const payload={store,missionId,revision,requestKey,
      telegramBatch:{lastAuthorizedTurn:false,piManaged:true}};
    const rotateChat=nextPlan?.action==='HANDOFF'||
      store.piChatObservedTurns(missionId)>=MAX_PI_CHAT_TURNS;
    const work=i>0?goalWorkPrompt(store,missionId,nextPlan!,writeWorkspace,rotateChat):null;
    const snapshotOptions=work?{promptSnapshot:{format:work.format,prompt:work.prompt},
      goalBinding:work.binding}:{};
    const received:BrowserTurnOutcome|(BrowserTurnOutcome&{page:Page;url:string})=
      i===0?await executeBrowserRollover({...payload,sourcePage:page,sourceUrl:url,
        prompt:browserGoalPlanningPrompt(origin.goal,origin.acceptance,writeWorkspace)}):
      rotateChat?await executeBrowserRollover({...payload,...snapshotOptions,
        sourcePage:page,sourceUrl:url,prompt:work!.prompt,expectedSource:exactSource}):
      await executeBrowserTurn({...payload,...snapshotOptions,page,url,prompt:work!.prompt,
        requireFinalMarker:true,expectedSource:exactSource});
    if('page' in received){
      const rollover=received as BrowserTurnOutcome&{page:Page;url:string};
      const formerPage=page,formerUrl=url;
      page=rollover.page;url=rollover.url;
      // Close only the provably Relay-created source tab of a settled rollover.
      if(ownedPage&&store.canRetireOwnedChatTab(missionId,formerUrl,url))
        await retireOwnedRelayTab({store,missionId,sourcePage:ownedPage,
          destinationPage:page,sourceUrl:formerUrl,destinationUrl:url});
      ownedPage=page===formerPage?null:page;
    }
    revision=received.revision;
    latestBrowserAnswer=received.lastAssistant;
    if(store.get(missionId).stopRequested)return;
    nextPlan=await reviewPiRound(store,planner,missionId,
      received.assistantSha256,received.lastAssistant,received.turnCount);
    if(['DONE','BLOCKED'].includes(nextPlan.action))return;
    revision=store.get(missionId).version;
    // Other live Goals are durable, independent contenders. The controller
    // releases its one browser session only at this settled PI checkpoint.
    if(input.yieldAtGoalCheckpoint){
      const ledger=new GoalLedger(store),currentGoal=ledger.missionGoalId(missionId);
      const anotherRunnable=currentGoal&&store.list().some(other=>{
        if(other.id===missionId||other.stopRequested||other.lastError||
          store.getMeta(`pi.autopilot.enabled.${other.id}`)!=='1')return false;
        const otherGoal=ledger.missionGoalId(other.id);
        if(!otherGoal||otherGoal===currentGoal||!['DRAFT','ACTIVE'].includes(
          ledger.getGoal(otherGoal).status))return false;
        const receipt=store.chatBrowserTurn(other.id),pi=store.piPlan(other.id);
        if(receipt&&['reserved','uncertain'].includes(receipt.status))return false;
        if(other.state==='READY'&&other.turnCount===0)return true;
        if(store.piDispatchNotBefore(other.id)>Date.now())return false;
        return other.state==='PAUSED'&&receipt?.assistantSha256&&
          store.hasVerifiedPiBrowserCheckpoint(other.id)&&
          (pi?.round!==other.turnCount||['NEXT','HANDOFF'].includes(pi.action));
      });
      if(anotherRunnable)return;
    }
  }
}

/** Automatic retries of one settled checkpoint (backoff 1→15 min, ~75 min
 * total) before the owner is told. Everything retried here happens BEFORE a
 * Send — PI inference, plan validation, a pre-Send browser read — so a retry
 * can never duplicate an external side effect. */
export const MAX_CHECKPOINT_RETRIES=8;

/** A failure after a settled browser answer retries the same checkpoint
 * with durable backoff; only when retries are exhausted (or the checkpoint
 * is no longer verifiable) does it stop and become visible to the owner. */
export function pauseFailedPiPlanning(store:Store,id:string,reason:string|Error):void {
  const message=reason instanceof Error?reason.message:reason;
  // An unsent browser attempt was already released with its own backoff and
  // stop limit (Store.abortUnsentBrowserTurn); nothing more to record.
  if(reason instanceof PreSendError)return;
  const current=store.get(id);
  if(current.state==='PAUSED'&&!current.stopRequested &&
    !(store.piPlan(id)?.round===current.turnCount&&
      ['DONE','BLOCKED'].includes(store.piPlan(id)?.action??''))){
    // Only a failure of PI itself is retried; a browser integrity, permission
    // or changed-Chat failure needs the operator and stops visibly.
    if(reason instanceof PiInferenceError&&
      deferVerifiedPiCheckpointRetry(store,id,message,'pi.autopilot_retry_deferred'))return;
    store.update(id,current.version,{lastError:message.slice(0,500)},
      'pi.autopilot_interrupted',{reason:message.slice(0,500)});
  }
}

/** A read-only Playwriter reconnect failure has exactly the same durable
 * checkpoint restrictions as a PI inference retry. Never classify a changed
 * DOM answer, missing permission, terminal PI decision or in-flight Send as
 * a transient reconnect. A new Worker reads these keys before opening Chrome. */
export function deferTransientPiBrowserRecovery(store:Store,id:string,reason:string):boolean {
  return deferVerifiedPiCheckpointRetry(store,id,reason,'pi.browser_read_retry_deferred');
}

function deferVerifiedPiCheckpointRetry(store:Store,id:string,reason:string,
  event:'pi.autopilot_retry_deferred'|'pi.browser_read_retry_deferred'):boolean {
  const mission=store.get(id),receipt=store.chatBrowserTurn(id),plan=store.piPlan(id);
  if(mission.state!=='PAUSED'||mission.stopRequested||mission.lastError||
    plan?.round===mission.turnCount&&['DONE','BLOCKED'].includes(plan.action)||
    !receipt||!['observed','reconciled'].includes(receipt.status)||
    !receipt.assistantSha256||!store.hasVerifiedPiBrowserCheckpoint(id))return false;
  return store.atomic(()=>{
    // A matching answer text from a later round is still a distinct request.
    // Bind retry identity to the original request key as well as its SHA.
    const sameRequest=store.getMeta(`pi.retry.request.${id}`)===receipt.requestKey&&
      store.getMeta(`pi.retry.sha.${id}`)===receipt.assistantSha256;
    const count=sameRequest
      ?Math.min(30,Math.max(0,Number(store.getMeta(`pi.retry.count.${id}`)??'0')||0)):0;
    if(count>=MAX_CHECKPOINT_RETRIES)return false;
    const delay=Math.min(15*60_000,60_000*2**Math.min(count,4));
    const retryAfter=Date.now()+delay;
    store.setMeta(`pi.retry.request.${id}`,receipt.requestKey);
    store.setMeta(`pi.retry.sha.${id}`,receipt.assistantSha256!);
    store.setMeta(`pi.retry.count.${id}`,String(count+1));
    store.setMeta(`pi.retry.after.${id}`,String(retryAfter));
    store.update(id,mission.version,{},event,{
      reason:reason.slice(0,500),attempt:count+1,
      retryAfter:new Date(retryAfter).toISOString(),
      browserRequestKey:receipt.requestKey,assistantSha256:receipt.assistantSha256,
    });
    return true;
  });
}
