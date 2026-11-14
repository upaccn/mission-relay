import {CI_EXECUTOR_POLICY} from './ci-policy.js';
import {MAX_RELAY_CHAT_TURNS} from './chat-limits.js';
import {missionTurnLimitReached} from './mission-turns.js';
import {createHash} from 'node:crypto';
import {withReadOnlyDeadline} from './read-only-deadline.js';
import type {Page} from 'playwriter';
import type {Store,PiPlan,GoalPromptBinding} from './store.js';
import {inspectChatPage,lastVisibleUserPromptSha256,matchesSubmittedUserPrompt,chatTabTargetSha256,submitChatTurn,submitNewChatTurn,MAX_BROWSER_TURN_TIMEOUT_MS,visibleConversationLengthLimit} from '../plugins/chatgpt-browser.js';
import {validateRemoteProjectPath} from './pi-planner.js';

// One Telegram message has a 4096-character limit; leave room for "/build ".
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
  try {
    const receipt=await submitChatTurn(page,url,prompt,input.timeoutMs,input.requireFinalMarker,
      input.expectedSource?{assistantSha256:input.expectedSource.assistantSha256,
        assistantTurnId:before.lastAssistantTurnId??null}:undefined,{
        claim:async(reason)=>matchesSubmittedUserPrompt(
          await lastVisibleUserPromptSha256(page),prompt)
          &&store.claimDeliveryRetryIntent(missionId,requestKey,promptSha256,reason),
        clicked:()=>store.recordDeliveryRetryClicked(missionId,requestKey,promptSha256),
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
    if(observedCandidateSha)store.quarantineBrowserObservation(missionId,{
      requestKey,promptSha256,assistantSha256:observedCandidateSha,
      reason:'settlement-rejected'});
    try{store.finishChatBrowserTurn(missionId,requestKey,{kind:'uncertain',error:reason});}
    catch{/* A stale/corrupt reservation remains uncredited; quarantine survives. */}
    throw new Error(`Browser turn requires manual reconciliation: ${reason}`);
  }
}

export type BrowserDecision='NEXT'|'DONE'|'BLOCKED'|'HANDOFF'|'UNMARKED';

/** Only a proven Relay-created page may be retired. The normal same-loop
 * caller retains its own Page; PI chain cleanup separately verifies the
 * predecessor Mission's original creation and unchanged source DOM BEFORE
 * calling this bounded close. Never trust a SQLite URL alone for that.
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
  const ending=answer.trim().slice(-300);
  const match=ending.match(/(?:^|\n)\[MISSION_RELAY:(NEXT|DONE|BLOCKED|HANDOFF)\]\s*$/);
  return match?.[1] as BrowserDecision || 'UNMARKED';
}

export function browserContinuationPrompt(goal:string,acceptance:string[],first:boolean,
  operatorInstruction:string|null=null):string {
  if(operatorInstruction!==null && operatorInstruction.length>1500)
    throw new Error('Browser operator instruction exceeds 1500 characters; shorten it before dispatch');
  return [
    first?'Continue this existing ChatGPT conversation.':'Continue the same mission from the last verified checkpoint.',
    `Goal: ${executorTaskGoal(goal)}`,
    'Acceptance criteria:',...acceptance.map((x,i)=>`${i+1}. ${x}`),
    ...(operatorInstruction?.trim()?[
      `Owner instruction for this turn: ${operatorInstruction.trim()}`,
      'Honor this latest owner instruction within the authorized mission and acceptance criteria.',
    ]:[]),
    'Inspect available task context and perform the next smallest meaningful, verifiable action.',
    'Do not assert an action succeeded without checking its outcome. Do not infer permission for destructive or high-risk changes.',
    'Do not repeat completed steps. If the next action needs human authorization, stop and specify the blocker.',
    'At the end include a Telegram-ready summary of up to 8 brief lines: progress, evidence, blocker if any, and the precise next action. Place it immediately before the final marker; do not include secrets.',
    'If the existing chat has become too long to continue accurately OR the owner explicitly requests a safe context migration, prepare a concise context handoff containing verified facts, decisions, evidence, unresolved work, limits, and the exact next step. End with [MISSION_RELAY:HANDOFF] to request a new browser tab. Otherwise continue in this chat.',
    'End the final answer with exactly one standalone marker:',
    '[MISSION_RELAY:NEXT] if an independently actionable next step remains,',
    '[MISSION_RELAY:BLOCKED] if you need human input or authorization,',
    '[MISSION_RELAY:HANDOFF] only when this chat truly needs a new conversation and the preceding text is a self-contained evidence-aware handoff,',
    '[MISSION_RELAY:DONE] only if all criteria are supported by concrete inspectable evidence.',
  ].join('\n');
}

/** A new owner-requested chat needs no old-conversation handoff or verbose
 * continuation history. Keep the user's actual instruction intact. */
export function browserTaskPolicy(writeWorkspace:string|null=null,includeCiPolicy=true):string[] {
  if(!writeWorkspace)return [
    'Task scope: read-only. Research and analysis are allowed; modifying files,',
    'websites or accounts, sending external messages and spending money are not.',
    'Stop and identify any action that requires additional permission.',
  ];
  const project=validateRemoteProjectPath(writeWorkspace);
  return [
    `Task scope: implement and test code in ${project}.`,
    'Use available tools to inspect and edit this repository, run tests, commit and push its own GitHub repository and verify requested deployments.',
    ...(includeCiPolicy?CI_EXECUTOR_POLICY:[]),
    'Deliver tested changes, not only plans. Keep the canonical source and pull-only runtime separate.',
    'Do not make unrelated project changes, financial operations, credential changes or privilege changes.',
    'If necessary tools are unavailable, report the specific blocker rather than claiming completion.',
  ];
}

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

export function browserFreshTaskPrompt(goal:string,writeWorkspace:string|null=null):string {
  if(!goal.trim()||goal.length>MAX_FRESH_CHAT_TASK_CHARS)
    throw new Error(`Fresh ChatGPT task must be 1–${MAX_FRESH_CHAT_TASK_CHARS} characters`);
  return [
    'Complete the following task:',
    executorTaskGoal(goal),
    ...browserTaskPolicy(writeWorkspace),
    'Separate verifiable evidence from inference, and state what was not checked.',
    'Finish with a Telegram-ready summary of up to six concise lines, then exactly one standalone marker:',
    '[MISSION_RELAY:NEXT] if the owner goal has another concrete authorized stage to perform,',
    '[MISSION_RELAY:HANDOFF] if a new conversation is necessary with a self-contained evidence handoff,',
    '[MISSION_RELAY:DONE] only if the exact task and its acceptance criteria are fully answered,',
    '[MISSION_RELAY:BLOCKED] if the remaining work requires human input, new permissions or cannot be verified.',
    'Include checkable evidence; a DONE marker alone does not establish completion.',
  ].join('\n');
}

/** The first Send for an unplanned Goal is discovery, not execution. The
 * owner objective is context, not permission to bypass PI work-package
 * selection. A subsequent Send must use goalWorkPrompt with a persisted,
 * approved Plan and active Work Item. Non-Goal /build remains unchanged. */
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
    ...browserTaskPolicy(null),
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

export interface BrowserHandoffCheckpoint {round:number;responseSha256:string}

/** Compact, deterministic handoff. Only the PI-reviewed SHA and short context
 * cross a chat boundary. The original full answer remains in the source chat;
 * PI receives the full visible answer while SQLite retains its hash/excerpt.
 * Legacy formatting is used ONLY to identify an
 * already-reserved pre-upgrade request during manual no-replay recovery. */
export function browserNewChatPrompt(goal:string,acceptance:string[],handoff:string,operatorInstruction:string|null,
  previousAnswer:string|null=null,writeWorkspace:string|null=null,
  checkpoint?:BrowserHandoffCheckpoint,legacy=false):string {
  if(checkpoint&&(!Number.isInteger(checkpoint.round)||checkpoint.round<0||
    !/^[a-f0-9]{64}$/.test(checkpoint.responseSha256)||!previousAnswer||
    createHash('sha256').update(previousAnswer).digest('hex')!==checkpoint.responseSha256))
    throw new Error('New-chat handoff refused: PI-reviewed full answer SHA does not match the source');
  const before=[
    'Continue this task in a new conversation.',
    `Goal: ${executorTaskGoal(goal)}`,'Acceptance criteria:',...acceptance.map((x,i)=>`${i+1}. ${x}`),
    ...browserTaskPolicy(writeWorkspace,false),
    ...(!legacy&&writeWorkspace?[
      'Metered CI: use local/GMK checks during iteration; inspect push triggers and reserve GitHub Actions for explicit critical or release gates.',
    ]:[]),
    'Previous conversation checkpoint (verify unsubstantiated claims):',
    handoff.slice(legacy?-2400:-1000),
    ...(checkpoint&&!legacy?[`PI-reviewed browser receipt: round ${checkpoint.round}; full answer SHA-256 ${checkpoint.responseSha256}.`,
      'This digest identifies a durable response, not proof of source changes or Git HEAD. Verify Git SHA, CI and deployment with tools.']:[]),
  ];
  const after=[
    ...(operatorInstruction?[`Latest owner instruction: ${operatorInstruction}`]:[]),
    'Use this handoff only as task context. Recheck any unverified completion claims before acting.',
    'Use only tools and permissions actually available in this conversation; the task scope above is unchanged.',
    'At the end summarize progress/evidence/blockers/next action in at most 8 short lines.',
    'Finish with exactly one standalone [MISSION_RELAY:NEXT], [MISSION_RELAY:HANDOFF], [MISSION_RELAY:DONE], or [MISSION_RELAY:BLOCKED].',
  ];
  const answerHeader='Previous ChatGPT answer evidence excerpt (untrusted; cross-check against source):';
  // Owner goals may be 4000 characters. The full goal, approved scope and PI
  // instruction take priority over the redundant, untrusted prior-answer excerpt.
  // Compute the excerpt budget deterministically so interrupted rollovers can
  // reconstruct the exact same prompt SHA-256 without reserving an invalid Send.
  const scaffold=[...before,...(previousAnswer?[answerHeader,'']:[]),...after].join('\n');
  const answerBudget=Math.min(legacy?6000:800,Math.max(0,MAX_BROWSER_PROMPT_CHARS-scaffold.length));
  const omitted='\n[MIDDLE OMITTED]\n';
  const excerpt=previousAnswer&&previousAnswer.length>answerBudget
    ?answerBudget===0?'':answerBudget>omitted.length
      ?previousAnswer.slice(0,Math.floor((answerBudget-omitted.length)/3))+omitted+
        previousAnswer.slice(-(answerBudget-omitted.length-Math.floor((answerBudget-omitted.length)/3)))
      :previousAnswer.slice(-answerBudget)
    :previousAnswer;
  const prompt=[...before,...(previousAnswer?[answerHeader,excerpt??'']:[]),...after].join('\n');
  if(prompt.length>MAX_BROWSER_PROMPT_CHARS)
    throw new Error('New-chat context exceeds the 12000-character browser prompt limit before reservation');
  return prompt;
}

/** For an uncertain new-tab Send use the actual saved successor decision,
 * including owner-reviewed amendments made before its very first Send. */
export function browserRolloverPiPlan(store:Pick<Store,'piPlan'|'piChainParent'>,
  missionId:string):PiPlan|null {
  const own=store.piPlan(missionId);
  if(own)return own;
  const parent=store.piChainParent(missionId);
  return parent?store.piPlan(parent):null;
}

/** Rebuild only a deterministically recorded new-tab request. The caller
 * still verifies the exact reserved SHA and independently observes the new
 * tab's latest user/assistant messages before crediting any turn. */
export function browserRolloverRecoveryPrompt(input:{
  goal:string;acceptance:string[];sandbox:'read-only'|'workspace-write';workspace:string;
  nextInstruction:string|null;turnCount:number;missionRequestKey:string;
  reservedRequestKey:string;sourceAnswer:string;adopted:boolean;
  chainParent:boolean;piManaged:boolean;piPlan:PiPlan|null;
  /** May be set only from the durable Goal/Mission binding, not browser text. */
  goalBound?:boolean;
},legacy=false):string {
  const workspace=input.sandbox==='workspace-write'?input.workspace:null;
  if(input.turnCount===0&&!input.adopted&&!input.chainParent &&
    input.reservedRequestKey===`${input.missionRequestKey}-1`)
    return input.goalBound&&!legacy
      ?browserGoalPlanningPrompt(input.goal,input.acceptance,workspace)
      :browserFreshTaskPrompt(input.goal,workspace);
  if(input.piManaged){
    const plan=input.piPlan;
    if(!plan||!['NEXT','HANDOFF'].includes(plan.action)||
       createHash('sha256').update(input.sourceAnswer).digest('hex')!==plan.responseSha256)
      throw new Error('PI rollover recovery requires the exact verified previous plan and browser answer');
    return browserNewChatPrompt(input.goal,input.acceptance,plan.summary,
      plan.nextPrompt,input.sourceAnswer,workspace,
      legacy?undefined:{round:plan.round,responseSha256:plan.responseSha256},legacy);
  }
  if(browserDecision(input.sourceAnswer)!=='HANDOFF')
    throw new Error('Original conversation does not contain a complete HANDOFF response');
  return browserNewChatPrompt(input.goal,input.acceptance,
    input.sourceAnswer,input.nextInstruction,null,null,undefined,legacy);
}

/** Identifies the original prompt for an ALREADY reserved uncertain new-tab
 * request. A matching digest is required even for a pre-upgrade format; this
 * never reserves, sends, retries or mutates the stored reservation. */
export function exactReservedRolloverPrompt(
  input:Parameters<typeof browserRolloverRecoveryPrompt>[0],
  expectedSha256:string):{prompt:string;format:'compact'|'legacy'}{
  if(!/^[a-f0-9]{64}$/.test(expectedSha256))
    throw new Error('Invalid stored browser reservation SHA-256');
  for(const [legacy,format] of [[false,'compact'],[true,'legacy']] as const){
    const prompt=browserRolloverRecoveryPrompt(input,legacy);
    if(createHash('sha256').update(prompt.trim()).digest('hex')===expectedSha256)
      return {prompt,format};
  }
  throw new Error('Neither compact nor legacy handoff matches the original reserved prompt SHA');
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
  try {
    const page=await input.sourcePage.context().newPage();
    const {url,receipt}=await submitNewChatTurn(page,prompt,input.timeoutMs,false,{
      claim:async(reason)=>matchesSubmittedUserPrompt(
        await lastVisibleUserPromptSha256(page),prompt)
        &&store.claimDeliveryRetryIntent(missionId,requestKey,promptSha256,reason),
      clicked:()=>store.recordDeliveryRetryClicked(missionId,requestKey,promptSha256),
    });
    // Optional physical tab proof; failure cannot reclassify an already
    // observed external Send as uncertain or block its SQLite settlement.
    const newChatTargetSha256=await withReadOnlyDeadline(
      chatTabTargetSha256(page),5000).catch(()=>null);
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
      lastAssistant:receipt.lastAssistant,observedAt:receipt.observedAt,page,url};
  } catch(error) {
    const reason=error instanceof Error?error.message:'Unknown browser rollover failure';
    if(observedCandidateSha)store.quarantineBrowserObservation(missionId,{
      requestKey,promptSha256,assistantSha256:observedCandidateSha,
      reason:'settlement-rejected'});
    try{store.finishChatBrowserTurn(missionId,requestKey,{kind:'uncertain',error:reason});}
    catch{/* Preserve the original pending reservation, never replay Send. */}
    throw new Error(`New ChatGPT conversation requires manual reconciliation: ${reason}`);
  }
}

/** Bounded sequential browser turns; auto-roll over at the shared per-chat
 * ceiling even if the operator invokes separate browser-drive batches. */
export async function driveChatConversation(input:{
  store:Store;missionId:string;revision:number;requestPrefix:string;turns:number;
  page:Page;url:string;timeoutMs?:number;
  notificationMode?:'telegram-final';
}):Promise<{
  state:string;turnsObserved:Array<{turnCount:number;revision:number;responseSha256:string;responseExcerpt:string;flowSignal:BrowserDecision}>;
}> {
  if(!Number.isInteger(input.turns)||input.turns<1||input.turns>MAX_RELAY_CHAT_TURNS)
    throw new Error(`Drive turns must be 1–${MAX_RELAY_CHAT_TURNS}`);
  if(!/^[\w.-]{1,120}$/.test(input.requestPrefix)) throw new Error('Invalid browser request prefix');
  let revision=input.revision;
  let page=input.page,url=input.url;
  let ownedPage:Page|null=null;
  let pendingHandoff:string|null=null;
  const results:Array<{turnCount:number;revision:number;responseSha256:string;responseExcerpt:string;flowSignal:BrowserDecision}>=[];
  for(let i=0;i<input.turns;i++) {
    const m=input.store.get(input.missionId);
    if(m.stopRequested) break;
    let handoff:string|null=pendingHandoff;
    let expectedSource:{promptSha256:string;assistantSha256:string}|undefined;
    if(handoff===null&&input.store.piChatObservedTurns(m.id)>=MAX_RELAY_CHAT_TURNS){
      const last=input.store.chatBrowserTurn(m.id);
      if(!last?.assistantSha256||!['observed','reconciled'].includes(last.status))
        throw new Error('Chat-limit rollover requires a complete previous browser receipt');
      // This is a read-only source preflight, not a Send. A disconnected
      // Playwriter/Chrome must not leave an unattended multi-turn batch hung
      // indefinitely before its next reservation.
      const first=await withReadOnlyDeadline(inspectChatPage(page,url));
      if(first.generating||!first.composerReady||
        createHash('sha256').update(first.lastAssistant).digest('hex')!==last.assistantSha256||
        await withReadOnlyDeadline(lastVisibleUserPromptSha256(page))!==last.promptSha256)
        throw new Error('Chat-limit rollover refused: last visible ChatGPT exchange changed');
      await new Promise(resolve=>setTimeout(resolve,3000));
      const second=await withReadOnlyDeadline(inspectChatPage(page,url));
      if(second.generating||second.lastAssistant!==first.lastAssistant||
        await withReadOnlyDeadline(lastVisibleUserPromptSha256(page))!==last.promptSha256)
        throw new Error('Chat-limit rollover refused: previous answer did not remain stable');
      handoff=second.lastAssistant;
      expectedSource={promptSha256:last.promptSha256,assistantSha256:last.assistantSha256};
    }
    // Within a multi-turn batch, a human may edit the source after a reply
    // was observed but before the next UI preflight. Always recheck the exact
    // durable exchange at the final pre-reservation boundary, for same-chat
    // NEXT as well as explicit HANDOFF. A separate batch's first manual Send
    // remains governed by its explicit command and the existing SQLite gate.
    if(i>0&&!expectedSource){
      const last=input.store.chatBrowserTurn(m.id);
      if(!last?.assistantSha256||!['observed','reconciled'].includes(last.status)||
        (handoff!==null&&createHash('sha256').update(handoff).digest('hex')!==last.assistantSha256))
        throw new Error('Continuation requires an unchanged, complete previous browser receipt');
      expectedSource={promptSha256:last.promptSha256,assistantSha256:last.assistantSha256};
    }
    const prompt:string=handoff!==null
      ?browserNewChatPrompt(m.goal,m.acceptance,handoff,m.nextInstruction)
      :browserContinuationPrompt(m.goal,m.acceptance,i===0,m.nextInstruction);
    const batch=input.notificationMode==='telegram-final'
      ?{lastAuthorizedTurn:i===input.turns-1||m.turnCount+1>=m.maxTurns}:undefined;
    const receipt:BrowserTurnOutcome|(BrowserTurnOutcome&{page:Page;url:string})=handoff!==null
      ?await executeBrowserRollover({store:input.store,missionId:input.missionId,revision,
        requestKey:`${input.requestPrefix}-${i+1}`,sourcePage:page,sourceUrl:url,
        prompt,timeoutMs:input.timeoutMs,consumedInstruction:m.nextInstruction,
        telegramBatch:batch,expectedSource})
      :await executeBrowserTurn({store:input.store,missionId:input.missionId,revision,
        requestKey:`${input.requestPrefix}-${i+1}`,page,url,prompt,timeoutMs:input.timeoutMs,
        requireFinalMarker:true,consumedInstruction:m.nextInstruction,
        telegramBatch:batch,expectedSource});
    if('page' in receipt){
      const migrated=receipt as BrowserTurnOutcome&{page:Page;url:string};
      const formerPage=page,formerUrl=url;
      page=migrated.page;url=migrated.url;
      if(input.store.canRetireOwnedChatTab(input.missionId,formerUrl,url)&&
        await retireSupersededRelayTab(ownedPage,page,formerUrl)){
        try{input.store.recordOwnedChatTabRetired(input.missionId,formerUrl,url);}
        catch{console.error('Verified old tab closed, but retirement audit could not be committed');}
      }
      ownedPage=page===formerPage?null:page;
    }
    const signal=browserDecision(receipt.lastAssistant);
    results.push({turnCount:receipt.turnCount,revision:receipt.revision,
      responseSha256:receipt.assistantSha256,responseExcerpt:receipt.assistantExcerpt,
      flowSignal:signal});
    revision=receipt.revision;
    if(signal==='HANDOFF')pendingHandoff=receipt.lastAssistant;
    else pendingHandoff=null;
    const latest=input.store.get(input.missionId);
    if(!['NEXT','HANDOFF'].includes(signal)||latest.stopRequested||
      missionTurnLimitReached(latest.maxTurns,latest.turnCount))break;
  }
  return {state:input.store.get(input.missionId).state,turnsObserved:results};
}
