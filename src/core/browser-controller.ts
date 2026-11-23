import {createHash} from 'node:crypto';
import {withReadOnlyDeadline} from './read-only-deadline.js';
import type {Page} from 'playwriter';
import type {Store,GoalPromptBinding} from './store.js';
import {PreSendError,inspectChatPage,lastVisibleUserPromptSha256,matchesSubmittedUserPrompt,chatTabTargetSha256,submitChatTurn,submitNewChatTurn,MAX_BROWSER_TURN_TIMEOUT_MS,visibleConversationLengthLimit} from '../plugins/chatgpt-browser.js';
import {validateRemoteProjectPath} from './pi-planner.js';
import {missionRelayMarker} from './mission-marker.js';

// One Telegram message has a 4096-character limit; leave room for the command.
// This bounds the owner's full task, not PI's per-turn nextPrompt (1500).
export const MAX_FRESH_CHAT_TASK_CHARS=4000;
const MAX_BROWSER_PROMPT_CHARS=12000;

export interface BrowserTurnOutcome {
  missionId:string; requestKey:string; state:string; revision:number; turnCount:number;
  assistantSha256:string; assistantExcerpt:string; lastAssistant:string; observedAt:string;
}
export interface VersionedBrowserPrompt {
  promptSnapshot?:{format:'goal-work-v1';prompt:string};
  goalBinding?:GoalPromptBinding;
}

export async function executeBrowserTurn(input:{
  store:Store;missionId:string;revision:number;requestKey:string;
  page:Page;url:string;prompt:string;timeoutMs?:number;requireFinalMarker?:boolean;
  /** Revalidate the last observed exchange at the final read before reservation. */
  expectedSource?:{promptSha256:string;assistantSha256:string};
  consumedInstruction?:string|null;
  telegramBatch?:{lastAuthorizedTurn:boolean;piManaged?:boolean};
}&VersionedBrowserPrompt):Promise<BrowserTurnOutcome> {
  const {store,missionId,revision,requestKey,page,url,prompt}=input;
  // Reject deterministic input errors before reserving a possibly committed
  // browser side effect; after reservation, uncertain failures never retry.
  if(typeof prompt!=='string'||!prompt.trim()||prompt.length>MAX_BROWSER_PROMPT_CHARS)
    throw new Error('Browser prompt must contain 1–12000 characters; no message was reserved');
  if(input.timeoutMs!==undefined && (!Number.isInteger(input.timeoutMs)||
     input.timeoutMs<10000||input.timeoutMs>MAX_BROWSER_TURN_TIMEOUT_MS))
    throw new Error('Browser timeout must be between 10 seconds and 4 hours; no message was reserved');
  const before=await withReadOnlyDeadline(inspectChatPage(page,url));
  if(!before.composerReady||before.generating) throw new Error('ChatGPT tab is not ready for a new turn');
  if(await withReadOnlyDeadline(visibleConversationLengthLimit(page)))
    throw new Error('ChatGPT conversation already reached maximum length; no new request reserved');
  if(input.expectedSource&&(
    createHash('sha256').update(before.lastAssistant).digest('hex')!==input.expectedSource.assistantSha256||
    await withReadOnlyDeadline(lastVisibleUserPromptSha256(page))!==input.expectedSource.promptSha256))
    throw new Error('Source ChatGPT history changed before existing-chat Send reservation');
  const promptSha256=createHash('sha256').update(prompt.trim()).digest('hex');
  store.reserveChatBrowserTurn(missionId,revision,requestKey,promptSha256,{
    promptSnapshot:input.promptSnapshot,goalBinding:input.goalBinding});
  let observedCandidateSha:string|null=null;
  let deliveryRetryAttempt=0;
  try {
    const receipt=await submitChatTurn(page,url,prompt,input.timeoutMs,input.requireFinalMarker,
      input.expectedSource?{assistantSha256:input.expectedSource.assistantSha256,
        assistantTurnId:before.lastAssistantTurnId??null}:undefined,{
        claim:async(reason)=>{
          if(!matchesSubmittedUserPrompt(await lastVisibleUserPromptSha256(page),prompt))
            return false;
          if(!store.hasDeliveryRetryIntent(missionId,requestKey,promptSha256)){
            if(!store.claimDeliveryRetryIntent(missionId,requestKey,promptSha256,reason))
              return false;
            deliveryRetryAttempt=1;return true;
          }
          deliveryRetryAttempt=store.claimDeliveryRetryFollowupIntent(
            missionId,requestKey,promptSha256,reason)??0;
          return deliveryRetryAttempt>0;
        },
        clicked:()=>{
          if(deliveryRetryAttempt===1)
            store.recordDeliveryRetryClicked(missionId,requestKey,promptSha256);
          else store.recordDeliveryRetryFollowupClicked(
            missionId,requestKey,promptSha256,deliveryRetryAttempt);
        },
      });
    const assistantSha256=createHash('sha256').update(receipt.lastAssistant).digest('hex');
    observedCandidateSha=assistantSha256;
    const flow=browserDecision(receipt.lastAssistant);
    const terminal=input.telegramBatch?.lastAuthorizedTurn||
      !['NEXT','HANDOFF'].includes(flow);
    const mission=store.finishChatBrowserTurn(missionId,requestKey,{kind:'observed',
      assistantSha256,summary:receipt.lastAssistant.slice(-1000),
      consumedInstruction:input.consumedInstruction,
      ...(input.telegramBatch?{telegramBatch:{terminal,flowSignal:flow,
        piManaged:input.telegramBatch.piManaged}}:{})});
    return {missionId,requestKey,state:mission.state,revision:mission.version,
      turnCount:mission.turnCount,assistantSha256,
      assistantExcerpt:receipt.lastAssistant.slice(-1000),lastAssistant:receipt.lastAssistant,
      observedAt:receipt.observedAt};
  } catch(error) {
    const reason=error instanceof Error?error.message:'Unknown browser error';
    if(error instanceof PreSendError){
      store.abortUnsentBrowserTurn(missionId,requestKey,reason);
      throw new PreSendError(`Browser Send not attempted; will retry: ${reason}`);
    }
    if(observedCandidateSha)store.quarantineBrowserObservation(missionId,{
      requestKey,promptSha256,assistantSha256:observedCandidateSha,
      reason:'settlement-rejected'});
    try{store.finishChatBrowserTurn(missionId,requestKey,{kind:'uncertain',error:reason});}
    catch{/* A stale/corrupt reservation remains uncredited; quarantine survives. */}
    throw new Error(`Browser turn requires manual reconciliation: ${reason}`);
  }
}

export type BrowserDecision='NEXT'|'DONE'|'BLOCKED'|'HANDOFF'|'UNMARKED';

/** Only a proven Relay-created page may be retired; the caller owns the
 * Page it created. Never trust a SQLite URL alone for that.
 * Do not close the owner's original/attached tab, a navigated tab, or the
 * currently active destination. The new response and URL must already have
 * committed to SQLite before the caller invokes this best-effort cleanup. */
export async function retireSupersededRelayTab(ownedPage:Page|null,
  destination:Page,expectedOldUrl:string):Promise<boolean>{
  if(!ownedPage||ownedPage===destination)return false;
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
    if(ownedPage.isClosed()||ownedPage.url().replace(/\/$/,'')!==expectedOldUrl.replace(/\/$/,''))return false;
    await Promise.race([
      ownedPage.close(),
      new Promise<void>((_,reject)=>{
        timer=setTimeout(()=>reject(new Error('owned tab close timeout')),4000);
      }),
    ]);
    // An attempted close or an absent Playwriter tab is not a verified
    // close. Only the exact, Relay-owned Page confirming isClosed() may
    // produce a durable retirement receipt.
    return ownedPage.isClosed();
  }catch{
    // A cleanup issue after a durable response is not an ambiguous Send and
    // must not prevent PI from evaluating the already-committed destination.
    console.error('Relay-owned previous ChatGPT tab could not be closed; keeping the verified new conversation');
    return false;
  }finally{if(timer)clearTimeout(timer);}
}
/** Flow-control signal, not independent verification of a model's claims. */
export function browserDecision(answer:string):BrowserDecision {
  return missionRelayMarker(answer)??'UNMARKED';
}


const READ_ONLY_TASK_POLICY=[
  'Task scope: read-only. Research and analysis are allowed; modifying files,',
  'websites or accounts, sending external messages and spending money are not.',
  'Stop and identify any action that requires additional permission.',
];

/** Preserve the full owner goal for PI's orchestration and durable audit, but
 * omit explicitly labeled coordinator-only playbooks from executor prompts.
 * Unlabeled owner requirements remain intact. This projection is deterministic
 * so a reserved browser request can always be reconstructed byte-for-byte. */
export function executorTaskGoal(goal:string):string {
  const chunks=goal.split(/(?=^【[^\r\n】]{1,60}】)/m);
  const visible=chunks.filter(x=>!/^【执行与自治规则】/.test(x)).join('')
    .replace(/^[ \t]*这是所有者明确授权的[ \t]*workspace-write[ \t]*任务。?[ \t]*$/gm,'')
    .replace(/^[ \t]*The owner authorized real code implementation for this task\.[ \t]*$/gmi,'')
    .trim();
  return visible||goal.trim();
}

/** The first Send for an unplanned Goal is discovery, not execution. The
 * owner objective is context, not permission to bypass PI work-package
 * selection. A subsequent Send must use goalWorkPrompt with a persisted,
 * approved Plan and active Work Item. */
export function browserGoalPlanningPrompt(goal:string,acceptance:string[],
  writeWorkspace:string|null=null):string {
  if(!goal.trim()||goal.length>MAX_FRESH_CHAT_TASK_CHARS)
    throw new Error(`Goal planning objective must be 1–${MAX_FRESH_CHAT_TASK_CHARS} characters`);
  const prompt=[
    'This is the INITIAL READ-ONLY DISCOVERY turn for a PI-controlled Goal.',
    'Owner objective for analysis (NOT authorization to execute it in this turn):',
    executorTaskGoal(goal),
    'Owner acceptance conditions:',
    ...acceptance.map((criterion,i)=>`${i+1}. ${criterion}`),
    ...(writeWorkspace?[`Candidate implementation repository (reference only): ${validateRemoteProjectPath(writeWorkspace)}.`]:[]),
    ...READ_ONLY_TASK_POLICY,
    'Even if the objective asks for immediate execution, do not edit code or files, run tests or commands with side effects, commit, push, deploy, activate tasks, send browser requests or change account state.',
    'Inspect available read-only evidence; identify already implemented capabilities, independently verifiable gaps, risks and dependencies.',
    'Propose the smallest prioritized work packages, each with a narrow scope, concrete acceptance checks, and rollback or recovery requirements.',
    'The PI controller will independently approve a durable Goal Plan and select a single work package before authorizing any execution turn.',
    'Do not claim implementation, acceptance, release or Goal DONE in this planning turn.',
    'End with exactly one standalone [MISSION_RELAY:NEXT] for a feasible plan or [MISSION_RELAY:BLOCKED] for a specific missing prerequisite.',
  ].join('\n');
  if(prompt.length>MAX_BROWSER_PROMPT_CHARS)
    throw new Error('Goal planning prompt exceeds 12000 characters; no Send authorized');
  return prompt;
}

/** The exact prompt behind a reserved request: its immutable Goal work
 * snapshot, or the deterministic first planning Send. Never guessed; a
 * caller still checks the stored SHA and never re-sends it. */
export function reservedRequestPrompt(store:Store,missionId:string,requestKey:string):string {
  const snapshot=store.reservedBrowserPrompt(missionId,requestKey);
  if(snapshot)return snapshot.prompt;
  const m=store.get(missionId);
  const first=`${m.requestKey}-1`;
  if(m.turnCount===0&&(requestKey===first||(requestKey.startsWith(`${first}-a`)&&
    /^\d+$/.test(requestKey.slice(first.length+2)))))
    return browserGoalPlanningPrompt(m.goal,m.acceptance,
      m.sandbox==='workspace-write'?m.workspace:null);
  throw new Error('Reserved request has no reconstructable prompt; use recover --abandon');
}

/** New-tab rollover reserves the request BEFORE any tab creation or message Send.
 * Failure stays ambiguous and never resends. The newly visible conversation
 * URL and reply are committed to SQLite together, so no split link update. */
export async function executeBrowserRollover(input:{
  store:Store;missionId:string;revision:number;requestKey:string;
  sourcePage:Page;sourceUrl:string;prompt:string;timeoutMs?:number;
  consumedInstruction?:string|null;
  /** Recheck source exactly at the last pre-reservation browser read. */
  expectedSource?:{promptSha256:string;assistantSha256:string};
  telegramBatch?:{lastAuthorizedTurn:boolean;piManaged?:boolean};
}&VersionedBrowserPrompt):Promise<BrowserTurnOutcome&{page:Page;url:string}> {
  const {store,missionId,revision,requestKey,prompt}=input;
  if(!prompt.trim()||prompt.length>MAX_BROWSER_PROMPT_CHARS)throw new Error('Rollover prompt must contain 1–12000 characters');
  if(input.timeoutMs!==undefined&&(!Number.isInteger(input.timeoutMs)||
    input.timeoutMs<10000||input.timeoutMs>MAX_BROWSER_TURN_TIMEOUT_MS))
    throw new Error('Rollover timeout must be between 10 seconds and 4 hours');
  const current=await withReadOnlyDeadline(inspectChatPage(input.sourcePage,input.sourceUrl));
  if(!current.composerReady||current.generating)
    throw new Error('Source ChatGPT tab must be idle before a new conversation is opened');
  if(input.expectedSource&&(
    createHash('sha256').update(current.lastAssistant).digest('hex')!==input.expectedSource.assistantSha256||
    await withReadOnlyDeadline(lastVisibleUserPromptSha256(input.sourcePage))!==input.expectedSource.promptSha256))
    throw new Error('Source ChatGPT history changed before new-tab Send reservation');
  store.reserveChatBrowserTurn(missionId,revision,requestKey,
    createHash('sha256').update(prompt.trim()).digest('hex'),{
      newConversation:true,promptSnapshot:input.promptSnapshot,
      goalBinding:input.goalBinding});
  const promptSha256=createHash('sha256').update(prompt.trim()).digest('hex');
  let observedCandidateSha:string|null=null;
  let page:Page|null=null;
  try {
    page=await input.sourcePage.context().newPage().catch(error=>{
      throw new PreSendError(`Could not open a new tab: ${error instanceof Error?error.message:String(error)}`);
    });
    const tab=page;
    const {url,receipt}=await submitNewChatTurn(tab,prompt,input.timeoutMs,false,{
      claim:async(reason)=>matchesSubmittedUserPrompt(
        await lastVisibleUserPromptSha256(tab),prompt)
        &&store.claimDeliveryRetryIntent(missionId,requestKey,promptSha256,reason),
      clicked:()=>store.recordDeliveryRetryClicked(missionId,requestKey,promptSha256),
    });
    // Optional physical tab proof; failure cannot reclassify an already
    // observed external Send as uncertain or block its SQLite settlement.
    const newChatTargetSha256=await withReadOnlyDeadline(
      chatTabTargetSha256(tab),5000).catch(()=>null);
    const assistantSha256=createHash('sha256').update(receipt.lastAssistant).digest('hex');
    observedCandidateSha=assistantSha256;
    const flow=browserDecision(receipt.lastAssistant);
    const terminal=input.telegramBatch?.lastAuthorizedTurn||
      !['NEXT','HANDOFF'].includes(flow);
    const m=store.finishChatBrowserTurn(missionId,requestKey,{kind:'observed',
      assistantSha256,summary:receipt.lastAssistant.slice(-1000),
      consumedInstruction:input.consumedInstruction,newChatUrl:url,
      ...(newChatTargetSha256?{newChatTargetSha256}:{}),
      ...(input.telegramBatch?{telegramBatch:{terminal,flowSignal:flow,
        piManaged:input.telegramBatch.piManaged}}:{})});
    return {missionId,requestKey,state:m.state,revision:m.version,turnCount:m.turnCount,
      assistantSha256,assistantExcerpt:receipt.lastAssistant.slice(-1000),
      lastAssistant:receipt.lastAssistant,observedAt:receipt.observedAt,page:tab,url};
  } catch(error) {
    const reason=error instanceof Error?error.message:'Unknown browser rollover failure';
    if(error instanceof PreSendError){
      // The Relay-created tab never received a Send: close it and retry later.
      if(page)await page.close().catch(()=>undefined);
      store.abortUnsentBrowserTurn(missionId,requestKey,reason);
      throw new PreSendError(`New ChatGPT conversation not started; will retry: ${reason}`);
    }
    if(observedCandidateSha)store.quarantineBrowserObservation(missionId,{
      requestKey,promptSha256,assistantSha256:observedCandidateSha,
      reason:'settlement-rejected'});
    try{store.finishChatBrowserTurn(missionId,requestKey,{kind:'uncertain',error:reason});}
    catch{/* Preserve the original pending reservation, never replay Send. */}
    throw new Error(`New ChatGPT conversation requires manual reconciliation: ${reason}`);
  }
}
