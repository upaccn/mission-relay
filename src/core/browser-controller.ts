import {createHash} from 'node:crypto';
import type {Page} from 'playwriter';
import type {Store} from './store.js';
import {inspectChatPage,submitChatTurn,submitNewChatTurn,MAX_BROWSER_TURN_TIMEOUT_MS} from '../plugins/chatgpt-browser.js';

export interface BrowserTurnOutcome {
  missionId:string; requestKey:string; state:string; revision:number; turnCount:number;
  assistantSha256:string; assistantExcerpt:string; lastAssistant:string; observedAt:string;
}

export async function executeBrowserTurn(input:{
  store:Store;missionId:string;revision:number;requestKey:string;
  page:Page;url:string;prompt:string;timeoutMs?:number;requireFinalMarker?:boolean;
  consumedInstruction?:string|null;
  telegramBatch?:{lastAuthorizedTurn:boolean;piManaged?:boolean};
}):Promise<BrowserTurnOutcome> {
  const {store,missionId,revision,requestKey,page,url,prompt}=input;
  // Reject deterministic input errors before reserving a possibly committed
  // browser side effect; after reservation, uncertain failures never retry.
  if(typeof prompt!=='string'||!prompt.trim()||prompt.length>12000)
    throw new Error('Browser prompt must contain 1–12000 characters; no message was reserved');
  if(input.timeoutMs!==undefined && (!Number.isInteger(input.timeoutMs)||
     input.timeoutMs<10000||input.timeoutMs>MAX_BROWSER_TURN_TIMEOUT_MS))
    throw new Error('Browser timeout must be between 10 seconds and 45 minutes; no message was reserved');
  const before=await inspectChatPage(page,url);
  if(!before.composerReady||before.generating) throw new Error('ChatGPT tab is not ready for a new turn');
  const promptSha256=createHash('sha256').update(prompt.trim()).digest('hex');
  store.reserveChatBrowserTurn(missionId,revision,requestKey,promptSha256);
  try {
    const receipt=await submitChatTurn(page,url,prompt,input.timeoutMs,input.requireFinalMarker);
    const assistantSha256=createHash('sha256').update(receipt.lastAssistant).digest('hex');
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
    store.finishChatBrowserTurn(missionId,requestKey,{kind:'uncertain',error:reason});
    throw new Error(`Browser turn requires manual reconciliation: ${reason}`);
  }
}

export type BrowserDecision='NEXT'|'DONE'|'BLOCKED'|'HANDOFF'|'UNMARKED';
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
    `Goal: ${goal}`,
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
export function browserFreshTaskPrompt(goal:string):string {
  if(!goal.trim()||goal.length>1500)throw new Error('Fresh ChatGPT task must be 1–1500 characters');
  return [
    'Complete this new task requested by the owner from a private Telegram chat.',
    'Owner request:',
    goal.trim(),
    'This is a bounded, read-only research and planning task. Do not modify files,',
    'websites, accounts or external services, send messages, spend money or expand permissions.',
    'Separate verifiable evidence from inference, and state what was not checked.',
    'If a requested action needs write permissions or further authorization, explain the boundary instead of acting.',
    'Finish with a Telegram-ready summary of up to six concise lines, then exactly one standalone marker:',
    '[MISSION_RELAY:DONE] if the read-only task is answered, otherwise [MISSION_RELAY:BLOCKED].',
    'The controller will independently record this answer; a DONE marker is not proof of business completion.',
  ].join('\n');
}

export function browserNewChatPrompt(goal:string,acceptance:string[],handoff:string,operatorInstruction:string|null):string {
  return [
    'Continue an explicitly authorized Mission Relay task in this NEW ChatGPT conversation.',
    `Goal: ${goal}`,'Acceptance criteria:',...acceptance.map((x,i)=>`${i+1}. ${x}`),
    'Prior conversation handoff (model-provided context, not independent evidence):',
    handoff.slice(-2400),
    ...(operatorInstruction?[`Latest owner instruction: ${operatorInstruction}`]:[]),
    'Use this handoff only as task context. Recheck any unverified completion claims before acting.',
    'Do not assume tools or authorizations from the previous ChatGPT conversation are transferable.',
    'Do not make destructive, financial, permission-raising or external writes without specific authorization.',
    'At the end summarize progress/evidence/blockers/next action in at most 8 short lines.',
    'Finish with a standalone [MISSION_RELAY:NEXT], [MISSION_RELAY:DONE], or [MISSION_RELAY:BLOCKED].',
  ].join('\n');
}

/** New-tab rollover reserves the request BEFORE any tab creation or message Send.
 * Failure stays ambiguous and never resends. The newly visible conversation
 * URL and reply are committed to SQLite together, so no split link update. */
export async function executeBrowserRollover(input:{
  store:Store;missionId:string;revision:number;requestKey:string;
  sourcePage:Page;sourceUrl:string;prompt:string;timeoutMs?:number;
  consumedInstruction?:string|null;
  telegramBatch?:{lastAuthorizedTurn:boolean;piManaged?:boolean};
}):Promise<BrowserTurnOutcome&{page:Page;url:string}> {
  const {store,missionId,revision,requestKey,prompt}=input;
  if(!prompt.trim()||prompt.length>12000)throw new Error('Rollover prompt must contain 1–12000 characters');
  if(input.timeoutMs!==undefined&&(!Number.isInteger(input.timeoutMs)||
    input.timeoutMs<10000||input.timeoutMs>MAX_BROWSER_TURN_TIMEOUT_MS))
    throw new Error('Rollover timeout must be between 10 seconds and 45 minutes');
  const current=await inspectChatPage(input.sourcePage,input.sourceUrl);
  if(!current.composerReady||current.generating)
    throw new Error('Source ChatGPT tab must be idle before a new conversation is opened');
  store.reserveChatBrowserTurn(missionId,revision,requestKey,createHash('sha256').update(prompt.trim()).digest('hex'));
  try {
    const page=await input.sourcePage.context().newPage();
    const {url,receipt}=await submitNewChatTurn(page,prompt,input.timeoutMs);
    const assistantSha256=createHash('sha256').update(receipt.lastAssistant).digest('hex');
    const flow=browserDecision(receipt.lastAssistant);
    const terminal=input.telegramBatch?.lastAuthorizedTurn||
      !['NEXT','HANDOFF'].includes(flow);
    const m=store.finishChatBrowserTurn(missionId,requestKey,{kind:'observed',
      assistantSha256,summary:receipt.lastAssistant.slice(-1000),
      consumedInstruction:input.consumedInstruction,newChatUrl:url,
      ...(input.telegramBatch?{telegramBatch:{terminal,flowSignal:flow,
        piManaged:input.telegramBatch.piManaged}}:{})});
    return {missionId,requestKey,state:m.state,revision:m.version,turnCount:m.turnCount,
      assistantSha256,assistantExcerpt:receipt.lastAssistant.slice(-1000),
      lastAssistant:receipt.lastAssistant,observedAt:receipt.observedAt,page,url};
  } catch(error) {
    const reason=error instanceof Error?error.message:'Unknown browser rollover failure';
    store.finishChatBrowserTurn(missionId,requestKey,{kind:'uncertain',error:reason});
    throw new Error(`New ChatGPT conversation requires manual reconciliation: ${reason}`);
  }
}

/** Bounded sequential conversation turns in the SAME visible ChatGPT tab. */
export async function driveChatConversation(input:{
  store:Store;missionId:string;revision:number;requestPrefix:string;turns:number;
  page:Page;url:string;timeoutMs?:number;
  notificationMode?:'telegram-final';
}):Promise<{
  state:string;turnsObserved:Array<{turnCount:number;revision:number;responseSha256:string;responseExcerpt:string;flowSignal:BrowserDecision}>;
}> {
  if(!Number.isInteger(input.turns)||input.turns<1||input.turns>8) throw new Error('Drive turns must be 1–8');
  if(!/^[\w.-]{1,120}$/.test(input.requestPrefix)) throw new Error('Invalid browser request prefix');
  let revision=input.revision;
  let page=input.page,url=input.url;
  let pendingHandoff:string|null=null;
  const results:Array<{turnCount:number;revision:number;responseSha256:string;responseExcerpt:string;flowSignal:BrowserDecision}>=[];
  for(let i=0;i<input.turns;i++) {
    const m=input.store.get(input.missionId);
    if(m.stopRequested) break;
    const prompt:string=pendingHandoff!==null
      ?browserNewChatPrompt(m.goal,m.acceptance,pendingHandoff,m.nextInstruction)
      :browserContinuationPrompt(m.goal,m.acceptance,i===0,m.nextInstruction);
    const batch=input.notificationMode==='telegram-final'
      ?{lastAuthorizedTurn:i===input.turns-1||m.turnCount+1>=m.maxTurns}:undefined;
    const receipt:BrowserTurnOutcome|(BrowserTurnOutcome&{page:Page;url:string})=pendingHandoff!==null
      ?await executeBrowserRollover({store:input.store,missionId:input.missionId,revision,
        requestKey:`${input.requestPrefix}-${i+1}`,sourcePage:page,sourceUrl:url,
        prompt,timeoutMs:input.timeoutMs,consumedInstruction:m.nextInstruction,
        telegramBatch:batch})
      :await executeBrowserTurn({store:input.store,missionId:input.missionId,revision,
        requestKey:`${input.requestPrefix}-${i+1}`,page,url,prompt,timeoutMs:input.timeoutMs,
        requireFinalMarker:true,consumedInstruction:m.nextInstruction,
        telegramBatch:batch});
    if('page' in receipt){
      page=(receipt as BrowserTurnOutcome&{page:Page;url:string}).page;
      url=(receipt as BrowserTurnOutcome&{page:Page;url:string}).url;
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
      latest.turnCount>=latest.maxTurns)break;
  }
  return {state:input.store.get(input.missionId).state,turnsObserved:results};
}
