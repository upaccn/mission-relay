import type {Page} from 'playwriter';
import {createHash} from 'node:crypto';
import type {Store,PiPlan} from './store.js';
import {SshPiPlanner,RetryablePiError,type PiPlanner} from './pi-planner.js';
import {inspectChatPage,lastVisibleUserPromptSha256,chatTabTargetSha256} from '../plugins/chatgpt-browser.js';
import {executeBrowserTurn,executeBrowserRollover,retireSupersededRelayTab,browserFreshTaskPrompt,browserGoalPlanningPrompt,
  browserNewChatPrompt,browserTaskPolicy,executorTaskGoal,type BrowserTurnOutcome} from './browser-controller.js';
import {MAX_RELAY_CHAT_TURNS} from './chat-limits.js';
import {missionTurnLimitReached,missionTurnsRemaining} from './mission-turns.js';
import {withReadOnlyDeadline} from './read-only-deadline.js';
import {GoalLedger} from './goal-store.js';
import {isApprovedBuildRepository} from './build-scopes.js';
import {reviewGoalPiRound} from './goal-pi.js';
import {goalWorkPrompt} from './goal-prompts.js';
import {captureGoalChromeBoundary,retireGoalOwnedTab} from './goal-release-chrome-probes.js';
import {inspectPiEvidence} from './pi-evidence.js';
import {verifiedRuntimeProvenance} from './runtime-provenance.js';
import {captureGoalSuccessorBoundary} from './goal-release-successor-probe.js';

const MAX_REPLANS=3;
/** Independent of the Mission's total budget, avoid overlong ChatGPT chats. */
export const MAX_PI_CHAT_TURNS=MAX_RELAY_CHAT_TURNS;

function nextPiBrowserPrompt(goal:string,plan:PiPlan,writeWorkspace:string|null):string {
  return [
    'Continue this task in the current conversation.',
    `Task goal: ${executorTaskGoal(goal)}`,
    `Progress checkpoint (verify any unsubstantiated claims): ${plan.summary}`,
    'Next action:',
    plan.nextPrompt,
    ...browserTaskPolicy(writeWorkspace),
    'Provide checkable evidence and distinguish facts from assumptions.',
    'Finish with a concise summary and exactly one standalone marker:',
    '[MISSION_RELAY:NEXT] if more authorized work remains,',
    '[MISSION_RELAY:HANDOFF] when the chat genuinely needs a new context,',
    '[MISSION_RELAY:DONE] only if the exact owner goal is fully answered, or',
    '[MISSION_RELAY:BLOCKED] for missing authorization, evidence or human input.',
    'Return concrete outputs and verifiable evidence, not instructions for a separate coordinator.',
  ].join('\n');
}

export interface PiAutopilotArgs {
  store:Store;planner:PiPlanner;missionId:string;revision:number;
  requestPrefix:string;page:Page;url:string;
  /** Cooperative scheduler: return only AFTER the original Send is settled
   * and the PI decision is durably committed. Never preempt a browser turn. */
  yieldAtGoalCheckpoint?:boolean;
  /** Only supplied after an independent read-only browser hash comparison. */
  recoveredAnswer?:{responseSha256:string;lastAssistant:string};
}
async function reviewPiRound(
  store:Store,planner:PiPlanner,missionId:string,
  responseSha256:string,lastAssistant:string,turnCount:number,
  replaceExisting=false,
):Promise<PiPlan>{
  const mission=store.get(missionId);
  if(createHash('sha256').update(lastAssistant).digest('hex')!==responseSha256)
    throw new Error('PI review refused: full browser answer SHA does not match its durable receipt');
  if(planner instanceof SshPiPlanner)
    store.auditPiDefaultModelInvocation(missionId,turnCount,responseSha256,
      planner.invocationPolicy());
  for(let attempt=0;attempt<MAX_REPLANS;attempt++){
    if(store.get(missionId).stopRequested)
      throw new Error('Owner requested a pause before PI could authorize another turn');
    const queued=store.pendingPiOwnerDirectives(missionId);
    // An explicitly bound Goal delegates the SAME PI checkpoint to the
    // project-manager review. No parallel dispatch loop or new Send authority.
    if(new GoalLedger(store).missionGoalId(missionId)){
      try{
        return await reviewGoalPiRound({store,planner,missionId,responseSha256,
          lastAssistant,round:turnCount,replaceExisting,ownerDirectives:queued});
      }catch(error){
        if(error instanceof Error&&error.message.includes('Owner updates changed during Goal planning'))
          continue;
        throw error;
      }
    }
    const plan=await planner.decide({
      goal:mission.goal,acceptance:mission.acceptance,
      turnCount,maxTurns:mission.maxTurns,
      responseSha256,lastAssistant,ownerDirectives:queued,
      sandbox:mission.sandbox,workspace:mission.workspace,
      priorPiSummary:store.piPlan(missionId)?.summary,
    });
    const ids=queued.map(x=>x.id);
    if(JSON.stringify(ids)!==JSON.stringify(
      store.pendingPiOwnerDirectives(missionId).map(x=>x.id)))continue;
    return store.commitPiPlan(missionId,responseSha256,ids,plan,replaceExisting);
  }
  throw new Error('Owner messages changed repeatedly during PI planning; paused without a new Send');
}
/** Re-plan the zero-turn successor from the verified LAST parent answer, not
 * from a fabricated child reply. Pending owner notes are checked atomically
 * with the persisted PI decision before a new-tab Send is ever reserved. */
async function reviewPiChainPreflight(store:Store,planner:PiPlanner,id:string,
  parentAnswerSha256:string,parentAnswer:string,parentPlan:PiPlan):Promise<PiPlan>{
  let current=store.piPlan(id)??parentPlan;
  if(current.responseSha256!==parentAnswerSha256||
    createHash('sha256').update(parentAnswer).digest('hex')!==parentAnswerSha256)
    throw new Error('PI chain preflight parent answer changed');
  for(let attempt=0;attempt<MAX_REPLANS;attempt++){
    if(store.get(id).stopRequested)
      throw new Error('Owner stopped the PI successor before its first Send');
    const queued=store.pendingPiOwnerDirectives(id);
    if(!queued.length)return current;
    const m=store.get(id);
    if(planner instanceof SshPiPlanner)
      store.auditPiDefaultModelInvocation(id,0,parentAnswerSha256,
        planner.invocationPolicy());
    const decision=await planner.decide({
      goal:m.goal,acceptance:m.acceptance,turnCount:0,maxTurns:m.maxTurns,
      responseSha256:parentAnswerSha256,lastAssistant:parentAnswer,
      ownerDirectives:queued,sandbox:m.sandbox,workspace:m.workspace,
      priorPiSummary:current.summary,
    });
    if(['DONE','BLOCKED'].includes(decision.action)&&
      new GoalLedger(store).missionGoalId(id))
      throw new Error('Goal-bound PI successor cannot declare terminal DONE/BLOCKED from owner-note preflight without independent acceptance');
    const ids=queued.map(x=>x.id);
    if(JSON.stringify(ids)!==JSON.stringify(
      store.pendingPiOwnerDirectives(id).map(x=>x.id)))continue;
    current=store.commitPiChainPreflight(id,parentAnswerSha256,ids,decision);
    if(['DONE','BLOCKED'].includes(current.action))return current;
  }
  throw new Error('Owner notes changed repeatedly during PI successor preflight; no Send');
}
/** Retrying a failed LOCAL reservation is safe only when no Playwriter Send
 * was reserved. An owner update arriving during asynchronous DOM inspection
 * must be PI-reviewed before any new chat is created. */
async function dispatchPiChainFirstTurn(input:{
  store:Store;planner:PiPlanner;missionId:string;revision:number;
  requestKey:string;sourcePage:Page;sourceUrl:string;
  goal:string;acceptance:string[];writeWorkspace:string|null;
  parentAnswer:string;
}):Promise<(BrowserTurnOutcome&{page:Page;url:string})|null>{
  const {store,planner,missionId}=input;
  const parentId=store.piChainParent(missionId);
  const parentPlan=parentId?store.piPlan(parentId):null;
  const parentReceipt=parentId?store.chatBrowserTurn(parentId):null;
  if(!parentPlan||!parentId)
    throw new Error('PI successor is missing its verified parent plan');
  if(!parentReceipt?.assistantSha256||parentReceipt.assistantSha256!==parentPlan.responseSha256)
    throw new Error('PI successor is missing its matching parent browser receipt');
  for(let attempt=0;attempt<MAX_REPLANS;attempt++){
    const plan=await reviewPiChainPreflight(store,planner,missionId,
      parentPlan.responseSha256,input.parentAnswer,parentPlan);
    if(['DONE','BLOCKED'].includes(plan.action))return null;
    const goalWork=new GoalLedger(store).missionGoalId(missionId)
      ?goalWorkPrompt(store,missionId,plan,input.writeWorkspace,true):null;
    const prompt=goalWork?.prompt??browserNewChatPrompt(input.goal,input.acceptance,
      plan.summary,plan.nextPrompt,input.parentAnswer,input.writeWorkspace,
      {round:plan.round,responseSha256:plan.responseSha256});
    try {
      return await executeBrowserRollover({store,missionId,revision:input.revision,
        requestKey:input.requestKey,sourcePage:input.sourcePage,sourceUrl:input.sourceUrl,
        prompt,telegramBatch:{lastAuthorizedTurn:false,piManaged:true},
        ...(goalWork?{promptSnapshot:{format:goalWork.format,prompt:goalWork.prompt},
          goalBinding:goalWork.binding}:{}),
        expectedSource:{promptSha256:parentReceipt.promptSha256,
          assistantSha256:parentReceipt.assistantSha256}});
    }catch(error){
      if(!(error instanceof Error)||
        !error.message.includes('PI successor has new owner notes')||
        store.chatBrowserTurn(missionId))throw error;
      // The rejected SQLite reservation had no external side effect.
    }
  }
  throw new Error('PI successor owner messages kept changing; no new chat was submitted');
}
/** A successor's old page was opened by the *previous* Mission, not by this
 * control loop. It is eligible only when SQLite proves exact Relay-created
 * custody AND both original user/assistant messages are still unchanged.
 * This is best-effort housekeeping after the first child answer is committed:
 * any mismatch leaves both audit and Chrome untouched. */
export async function retireVerifiedPiChainSource(input:{
  store:Store;childId:string;sourcePage:Page;newPage:Page;
  sourceUrl:string;newUrl:string;
}):Promise<boolean>{
  const {store,childId,sourcePage,newPage,sourceUrl,newUrl}=input;
  const sourceTargetSha256=await withReadOnlyDeadline(
    chatTabTargetSha256(sourcePage),5000).catch(()=>null);
  if(!store.canRetirePiChainSourceTab(childId,sourceUrl,newUrl,sourceTargetSha256))return false;
  try{
    const parentId=store.piChainParent(childId);
    if(!parentId)return false;
    const previous=store.chatBrowserTurn(parentId);
    if(previous?.status!=='observed'||!previous.assistantSha256)return false;
    const first=await withReadOnlyDeadline(inspectChatPage(sourcePage,sourceUrl));
    const firstUser=await withReadOnlyDeadline(lastVisibleUserPromptSha256(sourcePage));
    if(first.generating||!first.composerReady||
      firstUser!==previous.promptSha256||
      createHash('sha256').update(first.lastAssistant).digest('hex')!==previous.assistantSha256)
      return false;
    await new Promise(resolve=>setTimeout(resolve,1500));
    const second=await withReadOnlyDeadline(inspectChatPage(sourcePage,sourceUrl));
    const secondUser=await withReadOnlyDeadline(lastVisibleUserPromptSha256(sourcePage));
    if(second.generating||!second.composerReady||
      second.lastAssistant!==first.lastAssistant||
      secondUser!==firstUser||
      !store.canRetirePiChainSourceTab(childId,sourceUrl,newUrl,sourceTargetSha256))return false;
    if(!await retireSupersededRelayTab(sourcePage,newPage,sourceUrl))return false;
    try{store.recordPiChainSourceTabRetired(childId,sourceUrl,newUrl,sourceTargetSha256);}
    catch{console.error('Verified predecessor tab closed, but cross-Mission audit could not be committed');}
    return true;
  }catch{
    console.error('PI chain old-tab cleanup skipped: source provenance or stable page readback unavailable');
    return false;
  }
}
/** A bounded, supervised-by-PI loop over the ALREADY approved ChatGPT browser.
 * Browser observations and owner input are durable. A missing/invalid PI
 * decision never authorizes another browser Send. */
export async function drivePiAutopilot(input:PiAutopilotArgs):Promise<void> {
  const {store,planner,missionId,requestPrefix}=input;
  const origin=store.get(missionId);
  const adopted=store.chatAdoption(missionId);
  const chainParentId=store.piChainParent(missionId);
  if(origin.turnCount===0&&origin.state!==(adopted?'PAUSED':'READY'))
    throw new Error('New PI autopilot requires an unstarted READY or adopted PAUSED Mission');
  if(!store.chatBrowserBinding(missionId))
    throw new Error('PI autopilot requires an exact pinned ChatGPT Mission');
  const writeWorkspace=origin.sandbox==='workspace-write'?origin.workspace:null;
  if(writeWorkspace && (adopted||!isApprovedBuildRepository(store,writeWorkspace)))
    throw new Error('PI write mode requires its original locally approved project and a fresh Telegram owner command');
  if(origin.sandbox!=='read-only'&&!writeWorkspace)
    throw new Error('PI Mission has no approved execution scope');
  let page=input.page,url=input.url,revision=input.revision;
  let ownedPage:Page|null=null;
  let nextPlan:PiPlan|null=null;
  let latestBrowserAnswer=input.recoveredAnswer?.lastAssistant??null;
  if(chainParentId&&origin.turnCount===0){
    const parent=store.get(chainParentId),plan=store.piPlan(chainParentId);
    const receipt=store.chatBrowserTurn(chainParentId);
    if((parent.maxTurns===0||parent.turnCount!==parent.maxTurns)||parent.stopRequested||parent.lastError||
      plan?.round!==parent.maxTurns||!['NEXT','HANDOFF'].includes(plan.action)||
      !receipt||!store.hasVerifiedPiBrowserCheckpoint(chainParentId)||
      receipt.assistantSha256!==plan.responseSha256||
      store.piChainSuccessor(chainParentId)!==missionId)
      throw new Error('PI chain source is not a verified legacy bounded-Mission checkpoint');
    const first=await withReadOnlyDeadline(inspectChatPage(page,url));
    if(first.generating||!first.composerReady||
      await withReadOnlyDeadline(lastVisibleUserPromptSha256(page))!==receipt.promptSha256||
      createHash('sha256').update(first.lastAssistant).digest('hex')!==receipt.assistantSha256)
      throw new Error('PI chain refused: parent ChatGPT conversation changed');
    await new Promise(resolve=>setTimeout(resolve,3000));
    const second=await withReadOnlyDeadline(inspectChatPage(page,url));
    if(second.generating||second.lastAssistant!==first.lastAssistant||
      await withReadOnlyDeadline(lastVisibleUserPromptSha256(page))!==receipt.promptSha256)
      throw new Error('PI chain refused: parent browser evidence did not remain stable');
    latestBrowserAnswer=second.lastAssistant;
    nextPlan=store.piPlan(missionId)??plan;
    if(nextPlan.responseSha256!==plan.responseSha256||
      !['NEXT','HANDOFF','DONE','BLOCKED'].includes(nextPlan.action))
      throw new Error('PI chain preflight decision differs from its verified parent');
  }
  if(adopted&&origin.turnCount===0){
    // This is a real *human* ChatGPT reply, not a dispatched Relay turn.
    // Verify both last visible messages, including a stability read, before
    // letting PI infer next actions from this existing conversation.
    const first=await withReadOnlyDeadline(inspectChatPage(page,url));
    const userSha=await withReadOnlyDeadline(lastVisibleUserPromptSha256(page));
    if(first.generating||!first.composerReady||!first.lastAssistant.trim()||
       userSha!==adopted.userSha256||
       createHash('sha256').update(first.lastAssistant).digest('hex')!==adopted.assistantSha256)
      throw new Error('Adopted ChatGPT tab changed since its recorded initial snapshot');
    await new Promise(resolve=>setTimeout(resolve,3000));
    const second=await withReadOnlyDeadline(inspectChatPage(page,url));
    if(second.generating||second.lastAssistant!==first.lastAssistant||
       await withReadOnlyDeadline(lastVisibleUserPromptSha256(page))!==adopted.userSha256)
      throw new Error('Adopted ChatGPT reply did not remain stable');
    latestBrowserAnswer=second.lastAssistant;
    nextPlan=store.piPlan(missionId);
    if(!nextPlan){
      nextPlan=await reviewPiRound(store,planner,missionId,
        adopted.assistantSha256,second.lastAssistant,0);
    }
    if(['DONE','BLOCKED'].includes(nextPlan.action))return;
  }
  if(origin.turnCount>0){
    const last=store.chatBrowserTurn(missionId);
    const plan=store.piPlan(missionId);
    if(origin.state!=='PAUSED'||origin.stopRequested||!last||
      !store.hasVerifiedPiBrowserCheckpoint(missionId))
      throw new Error('PI recovery refused: no exact, fully observed browser checkpoint');
    // Only recover a future new Send, never a reserved/uncertain old Send.
    if(plan?.round===origin.turnCount) {
      if(last.assistantSha256!==plan.responseSha256){
        // The immutable original PI decision was based on a wrongly attributed
        // answer. A separately verified, append-only correction permits ONLY
        // a new PI review of the corrected bytes, never replay of the Send.
        if(!input.recoveredAnswer||
          input.recoveredAnswer.responseSha256!==last.assistantSha256||
          createHash('sha256').update(input.recoveredAnswer.lastAssistant).digest('hex')!==last.assistantSha256||
          !store.events(missionId).some(e=>e.type==='chatgpt.browser_attribution_corrected'&&
            (e.payload as {round?:number;assistantSha256?:string}).round===origin.turnCount&&
            (e.payload as {assistantSha256?:string}).assistantSha256===last.assistantSha256))
          throw new Error('PI recovery refused: corrected attribution requires exact independently re-observed answer');
        nextPlan=await reviewPiRound(store,planner,missionId,
          last.assistantSha256,input.recoveredAnswer.lastAssistant,origin.turnCount,true);
        revision=store.get(missionId).version;
        if(['DONE','BLOCKED'].includes(nextPlan.action)||missionTurnLimitReached(origin.maxTurns,origin.turnCount))return;
      }else{
        if(['DONE','BLOCKED'].includes(plan.action))return;
        if(!['NEXT','HANDOFF'].includes(plan.action))
          throw new Error('PI recovery refused: previous plan cannot authorize continuation');
        nextPlan=plan;
      }
    } else {
      if(!input.recoveredAnswer ||
        input.recoveredAnswer.responseSha256!==last.assistantSha256||
        createHash('sha256').update(input.recoveredAnswer.lastAssistant).digest('hex')!==last.assistantSha256)
        throw new Error('PI recovery refused: the pending unreviewed browser response was not independently re-observed');
      nextPlan=await reviewPiRound(store,planner,missionId,
        input.recoveredAnswer.responseSha256,input.recoveredAnswer.lastAssistant,origin.turnCount);
      if(['DONE','BLOCKED'].includes(nextPlan.action)||missionTurnLimitReached(origin.maxTurns,origin.turnCount))return;
    }
  }
  for(let i=origin.turnCount;missionTurnsRemaining(origin.maxTurns,i);i++){
    const before=store.get(missionId);
    let exactSource:{promptSha256:string;assistantSha256:string}|undefined;
    if(before.stopRequested) return;
    if(writeWorkspace&&!isApprovedBuildRepository(store,writeWorkspace))
      throw new Error('Approved build project was revoked or changed; no further browser send');
    if((i>0||adopted||chainParentId)&&!nextPlan)throw new Error('PI cannot continue without a durable next-step decision');
    if(i>0||adopted){
      // If a new Telegram note arrived AFTER PI committed its last NEXT plan
      // but BEFORE browser dispatch, PI must review it before any new Send.
      // This also protects a recovered checkpoint after a foreground restart.
      for(let revisionAttempt=0;revisionAttempt<MAX_REPLANS &&
        store.pendingPiOwnerDirectives(missionId).length;revisionAttempt++){
        if(!latestBrowserAnswer)
          throw new Error('PI re-plan refused: previous browser answer text unavailable');
        nextPlan=await reviewPiRound(store,planner,missionId,
          nextPlan!.responseSha256,latestBrowserAnswer,
          nextPlan!.round,true);
        if(['DONE','BLOCKED'].includes(nextPlan.action))return;
      }
      if(store.pendingPiOwnerDirectives(missionId).length)
        throw new Error('PI owner updates changed repeatedly; no browser Send is authorized');
      // Another human, browser session, or agent may have interacted with the
      // page while PI was planning. Refuse to append to a changed conversation.
      const previous=store.chatBrowserTurn(missionId);
      const snapshot=await withReadOnlyDeadline(inspectChatPage(page,url));
      const userSha=await withReadOnlyDeadline(lastVisibleUserPromptSha256(page));
      if(!snapshot.composerReady||snapshot.generating||!previous||
        !store.hasVerifiedPiBrowserCheckpoint(missionId)||
        createHash('sha256').update(snapshot.lastAssistant).digest('hex')!==nextPlan!.responseSha256||
        userSha!==previous.promptSha256)
        throw new Error('PI next browser Send refused: visible ChatGPT history differs from the last observed receipt');
      // The source can change AGAIN after this read, while the rollover
      // prompt is being constructed. Recheck both exact hashes at the final
      // pre-reservation boundary, including for automatic 10→11 rotation.
      exactSource={promptSha256:previous.promptSha256,
        assistantSha256:previous.assistantSha256!};
    }
    const requestKey=`${requestPrefix}-${i+1}`;
    const payload={store,missionId,revision,requestKey,
      telegramBatch:{lastAuthorizedTurn:false,piManaged:true}};
    const rotateChat=nextPlan?.action==='HANDOFF'||
      ((i>0||adopted)&&store.piChatObservedTurns(missionId)>=MAX_PI_CHAT_TURNS);
    const goalWork=(i>0||adopted)&&nextPlan&&
      new GoalLedger(store).missionGoalId(missionId)
      ?goalWorkPrompt(store,missionId,nextPlan,writeWorkspace,Boolean(rotateChat)):null;
    const goalOptions=goalWork?{
      promptSnapshot:{format:goalWork.format,prompt:goalWork.prompt},
      goalBinding:goalWork.binding,
    }:{};
    const received:(BrowserTurnOutcome|(BrowserTurnOutcome&{page:Page;url:string}))|null=
      i===0&&chainParentId?await dispatchPiChainFirstTurn({
        store,planner,missionId,revision,requestKey,
        sourcePage:page,sourceUrl:url,goal:origin.goal,
        acceptance:origin.acceptance,writeWorkspace,
        parentAnswer:latestBrowserAnswer!,
      }):i===0&&!adopted?await executeBrowserRollover({
        ...payload,sourcePage:page,sourceUrl:url,
        prompt:new GoalLedger(store).missionGoalId(missionId)
          ?browserGoalPlanningPrompt(origin.goal,origin.acceptance,writeWorkspace)
          :browserFreshTaskPrompt(origin.goal,writeWorkspace),
      }):rotateChat?await executeBrowserRollover({
        ...payload,sourcePage:page,sourceUrl:url,
        ...goalOptions,prompt:goalWork?.prompt??browserNewChatPrompt(origin.goal,origin.acceptance,
          nextPlan!.summary,nextPlan!.nextPrompt,latestBrowserAnswer,writeWorkspace,
          {round:nextPlan!.round,responseSha256:nextPlan!.responseSha256}),
        expectedSource:exactSource,
      }):await executeBrowserTurn({
        ...payload,...goalOptions,page,url,
        prompt:goalWork?.prompt??nextPiBrowserPrompt(origin.goal,nextPlan!,writeWorkspace),
        requireFinalMarker:true,expectedSource:exactSource,
      });
    if(!received)return; // PI stopped a successor before its first Send.
    if('page' in received){
      const rollover=received as BrowserTurnOutcome&{page:Page;url:string};
      const formerPage=page,formerUrl=url;
      page=rollover.page;url=rollover.url;
      const goalId=new GoalLedger(store).missionGoalId(missionId);
      let boundaryWitnessMissing=false;
      const priorChatTurns=goalId&&ownedPage
        ?inspectPiEvidence(store,missionId).rounds.at(-2)?.chatTurn:undefined;
      if(goalId&&ownedPage&&priorChatTurns===MAX_PI_CHAT_TURNS){
        // Independent physical observation must precede best-effort cleanup.
        // The new Chat's first-turn PI review is pending; only a later ReleaseProbe
        // can correlate this witness with the final committed PI decision.
        try {
          const sourceSha=verifiedRuntimeProvenance().sourceSha;
          await captureGoalChromeBoundary({store,goalId,missionId,
            sourcePage:ownedPage,destinationPage:page,
            sourceUrl:formerUrl,destinationUrl:url,sourceSha});
        }catch{
          boundaryWitnessMissing=true;
          console.error('Goal Chrome boundary witness unavailable; preserving old tab for recovery');
        }
      }
      // Never destroy the only physical source when an original Chat rollover
      // boundary was not independently witnessed. The new answer is already
      // settled; this cleanup decision never authorizes another Send.
      if(goalId&&ownedPage&&!boundaryWitnessMissing&&
        store.canRetireOwnedChatTab(missionId,formerUrl,url)){
        try{
          const sourceSha=verifiedRuntimeProvenance().sourceSha;
          await retireGoalOwnedTab({store,goalId,missionId,
            sourcePage:ownedPage,destinationPage:page,
            sourceUrl:formerUrl,destinationUrl:url,sourceSha});
        }catch{console.error('Goal-owned tab custody could not be certified; old tab preserved');}
      }else if(!goalId&&store.canRetireOwnedChatTab(missionId,formerUrl,url)&&
        await retireSupersededRelayTab(ownedPage,page,formerUrl)){
        try{store.recordOwnedChatTabRetired(missionId,formerUrl,url);}
        catch{console.error('Verified old tab closed, but retirement audit could not be committed');}
      }
      if(chainParentId&&i===0){
        if(goalId){
          // The child's original first answer is settled, but its PI review
          // is pending. Witness physical source/destination BEFORE cleanup.
          // Retain Goal parent tabs rather than creating unverifiable
          // cross-Mission physical retirement receipts.
          try{
            const sourceSha=verifiedRuntimeProvenance().sourceSha;
            await captureGoalSuccessorBoundary({store,goalId,
              parentId:chainParentId,childId:missionId,
              sourcePage:formerPage,destinationPage:page,
              sourceUrl:formerUrl,destinationUrl:url,sourceSha});
          }catch{
            console.error('Goal successor physical witness unavailable; parent tab preserved and Release Gate pending');
          }
        }else{
          await retireVerifiedPiChainSource({store,childId:missionId,
            sourcePage:formerPage,newPage:page,sourceUrl:formerUrl,newUrl:url});
        }
      }
      ownedPage=page===formerPage?null:page;
    }
    revision=received.revision;
    const lastAssistant=received.lastAssistant;
    latestBrowserAnswer=lastAssistant;
    if(store.get(missionId).stopRequested)return;
    nextPlan=await reviewPiRound(store,planner,missionId,
      received.assistantSha256,lastAssistant,received.turnCount);
    if(['DONE','BLOCKED'].includes(nextPlan!.action)||missionTurnLimitReached(origin.maxTurns,received.turnCount))
      return;
    revision=store.get(missionId).version;
    // Other live Goals are durable, independent contenders. The controller
    // releases its one browser session only at this settled PI checkpoint.
    // Existing single-Goal operation retains its normal continuous behavior.
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
        return other.state==='PAUSED'&&receipt?.assistantSha256&&
          store.hasVerifiedPiBrowserCheckpoint(other.id)&&
          (pi?.round!==other.turnCount||['NEXT','HANDOFF'].includes(pi.action));
      });
      if(anotherRunnable)return;
    }
  }
}

/** A planner failure after a finished browser answer must be visible to
 * Telegram. Do not equate that failure with an uncertain browser Send. */
export function pauseFailedPiPlanning(store:Store,id:string,reason:string|Error):void {
  const message=reason instanceof Error?reason.message:reason;
  const current=store.get(id);
  if(current.state==='READY'&&store.piChainParent(id)&&!current.stopRequested){
    // A new chained Mission has not reserved a Send. Never silently retry a
    // changed/unavailable parent tab or repeatedly launch child conversations.
    store.update(id,current.version,{state:'BLOCKED',lastError:message.slice(0,500)},
      'pi.autopilot_interrupted',{reason:message.slice(0,500)});
    return;
  }
  if(current.state==='PAUSED'&&!current.stopRequested &&
    !(store.piPlan(id)?.round===current.turnCount&&
      ['DONE','BLOCKED'].includes(store.piPlan(id)?.action??''))){
    if(reason instanceof RetryablePiError &&
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
  store.atomic(()=>{
    // A matching answer text from a later round is still a distinct request.
    // Bind retry identity to the original request key as well as its SHA.
    const sameRequest=store.getMeta(`pi.retry.request.${id}`)===receipt.requestKey&&
      store.getMeta(`pi.retry.sha.${id}`)===receipt.assistantSha256;
    const count=sameRequest
      ?Math.min(30,Math.max(0,Number(store.getMeta(`pi.retry.count.${id}`)??'0')||0)):0;
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
  });
  return true;
}
