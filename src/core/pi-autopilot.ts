import type {Page} from 'playwriter';
import {createHash} from 'node:crypto';
import type {Store,PiPlan} from './store.js';
import type {PiPlanner,PiDecision} from './pi-planner.js';
import {inspectChatPage,lastVisibleUserPromptSha256} from '../plugins/chatgpt-browser.js';
import {executeBrowserTurn,executeBrowserRollover,browserFreshTaskPrompt,
  browserNewChatPrompt,type BrowserTurnOutcome} from './browser-controller.js';

const MAX_REPLANS=3;

function nextPiBrowserPrompt(goal:string,plan:PiPlan):string {
  return [
    'Continue the same owner-authorized Mission Relay task in this ChatGPT conversation.',
    `Original goal: ${goal}`,
    `PI planning checkpoint: ${plan.summary}`,
    'New instruction from the tool-free PI coordinator (not a grant of new permissions):',
    plan.nextPrompt,
    'This is a read-only research and planning task. Do not modify files, websites, accounts,',
    'external services, permissions or financial resources. Stop and report if human approval is needed.',
    'Provide checkable evidence and distinguish facts from assumptions.',
    'Finish with a concise summary and one standalone [MISSION_RELAY:DONE] or [MISSION_RELAY:BLOCKED].',
    'PI, not this ChatGPT marker, determines whether another read-only turn remains.',
  ].join('\n');
}

export interface PiAutopilotArgs {
  store:Store;planner:PiPlanner;missionId:string;revision:number;
  requestPrefix:string;page:Page;url:string;
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
  for(let attempt=0;attempt<MAX_REPLANS;attempt++){
    if(store.get(missionId).stopRequested)
      throw new Error('Owner requested a pause before PI could authorize another turn');
    const queued=store.pendingPiOwnerDirectives(missionId);
    const plan=await planner.decide({
      goal:mission.goal,acceptance:mission.acceptance,
      turnCount,maxTurns:mission.maxTurns,
      responseSha256,lastAssistant,ownerDirectives:queued,
      priorPiSummary:store.piPlan(missionId)?.summary,
    });
    const ids=queued.map(x=>x.id);
    if(JSON.stringify(ids)!==JSON.stringify(
      store.pendingPiOwnerDirectives(missionId).map(x=>x.id)))continue;
    return store.commitPiPlan(missionId,responseSha256,ids,plan,replaceExisting);
  }
  throw new Error('Owner messages changed repeatedly during PI planning; paused without a new Send');
}
/** A bounded, supervised-by-PI loop over the ALREADY approved ChatGPT browser.
 * Browser observations and owner input are durable. A missing/invalid PI
 * decision never authorizes another browser Send. */
export async function drivePiAutopilot(input:PiAutopilotArgs):Promise<void> {
  const {store,planner,missionId,requestPrefix}=input;
  const origin=store.get(missionId);
  const adopted=store.chatAdoption(missionId);
  if(origin.turnCount===0&&origin.state!==(adopted?'PAUSED':'READY'))
    throw new Error('New PI autopilot requires an unstarted READY or adopted PAUSED Mission');
  if(origin.sandbox!=='read-only'||!store.chatBrowserBinding(missionId))
    throw new Error('PI autopilot requires the exact pinned read-only ChatGPT Mission');
  let page=input.page,url=input.url,revision=input.revision;
  let nextPlan:PiPlan|null=null;
  let latestBrowserAnswer=input.recoveredAnswer?.lastAssistant??null;
  if(adopted&&origin.turnCount===0){
    // This is a real *human* ChatGPT reply, not a dispatched Relay turn.
    // Verify both last visible messages, including a stability read, before
    // letting PI infer next actions from this existing conversation.
    const first=await inspectChatPage(page,url);
    const userSha=await lastVisibleUserPromptSha256(page);
    if(first.generating||!first.composerReady||!first.lastAssistant.trim()||
       userSha!==adopted.userSha256||
       createHash('sha256').update(first.lastAssistant).digest('hex')!==adopted.assistantSha256)
      throw new Error('Adopted ChatGPT tab changed since its recorded initial snapshot');
    await new Promise(resolve=>setTimeout(resolve,3000));
    const second=await inspectChatPage(page,url);
    if(second.generating||second.lastAssistant!==first.lastAssistant||
       await lastVisibleUserPromptSha256(page)!==adopted.userSha256)
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
      if(['DONE','BLOCKED'].includes(plan.action))return;
      if(!['NEXT','HANDOFF'].includes(plan.action)||
        last.assistantSha256!==plan.responseSha256)
        throw new Error('PI recovery refused: the previous plan is terminal or does not match the browser receipt');
      nextPlan=plan;
    } else {
      if(!input.recoveredAnswer ||
        input.recoveredAnswer.responseSha256!==last.assistantSha256||
        createHash('sha256').update(input.recoveredAnswer.lastAssistant).digest('hex')!==last.assistantSha256)
        throw new Error('PI recovery refused: the pending unreviewed browser response was not independently re-observed');
      nextPlan=await reviewPiRound(store,planner,missionId,
        input.recoveredAnswer.responseSha256,input.recoveredAnswer.lastAssistant,origin.turnCount);
      if(['DONE','BLOCKED'].includes(nextPlan.action)||origin.turnCount>=origin.maxTurns)return;
    }
  }
  for(let i=origin.turnCount;i<origin.maxTurns;i++){
    const before=store.get(missionId);
    if(before.stopRequested) return;
    if((i>0||adopted)&&!nextPlan)throw new Error('PI cannot continue without a durable next-step decision');
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
      const snapshot=await inspectChatPage(page,url);
      const userSha=await lastVisibleUserPromptSha256(page);
      if(!snapshot.composerReady||snapshot.generating||!previous||
        !store.hasVerifiedPiBrowserCheckpoint(missionId)||
        createHash('sha256').update(snapshot.lastAssistant).digest('hex')!==nextPlan!.responseSha256||
        userSha!==previous.promptSha256)
        throw new Error('PI next browser Send refused: visible ChatGPT history differs from the last observed receipt');
    }
    const requestKey=`${requestPrefix}-${i+1}`;
    const payload={store,missionId,revision,requestKey,
      telegramBatch:{lastAuthorizedTurn:false,piManaged:true}};
    const received:BrowserTurnOutcome|(BrowserTurnOutcome&{page:Page;url:string})=
      i===0&&!adopted?await executeBrowserRollover({
        ...payload,sourcePage:page,sourceUrl:url,
        prompt:browserFreshTaskPrompt(origin.goal),
      }):nextPlan!.action==='HANDOFF'?await executeBrowserRollover({
        ...payload,sourcePage:page,sourceUrl:url,
        prompt:browserNewChatPrompt(origin.goal,origin.acceptance,
          nextPlan!.summary,nextPlan!.nextPrompt),
      }):await executeBrowserTurn({
        ...payload,page,url,prompt:nextPiBrowserPrompt(origin.goal,nextPlan!),
        requireFinalMarker:true,
      });
    if('page' in received){
      const rollover=received as BrowserTurnOutcome&{page:Page;url:string};
      page=rollover.page;url=rollover.url;
    }
    revision=received.revision;
    const lastAssistant=received.lastAssistant;
    latestBrowserAnswer=lastAssistant;
    if(store.get(missionId).stopRequested)return;
    nextPlan=await reviewPiRound(store,planner,missionId,
      received.assistantSha256,lastAssistant,received.turnCount);
    if(['DONE','BLOCKED'].includes(nextPlan!.action)||received.turnCount>=origin.maxTurns)
      return;
    revision=store.get(missionId).version;
  }
}

/** A planner failure after a finished browser answer must be visible to
 * Telegram. Do not equate that failure with an uncertain browser Send. */
export function pauseFailedPiPlanning(store:Store,id:string,reason:string):void {
  const current=store.get(id);
  if(current.state==='PAUSED'&&!current.stopRequested && !store.piPlan(id)?.action?.match(/DONE|BLOCKED/)){
    store.update(id,current.version,{lastError:reason.slice(0,500)},
      'pi.autopilot_interrupted',{reason:reason.slice(0,500)});
  }
}
