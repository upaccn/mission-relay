import {MAX_RELAY_CHAT_TURNS} from '../core/chat-limits.js';
import {missionTurnsRemaining,missionTurnLimitReached,formatMissionTurns} from '../core/mission-turns.js';
import type { PluginManifest } from '../core/plugins.js';
import {createHash} from 'node:crypto';
import { Engine } from '../core/engine.js';
import { Store,PI_SUCCESSOR_CHECKPOINT_MISMATCH } from '../core/store.js';
import type {PreflightResult} from '../core/executor-plugins.js';
import { renderChatGPTHandoff } from '../core/chatgpt-handoff.js';
import {connectChatPage,inspectChatPage,lastVisibleUserPromptSha256,listConnectedChatCandidates,type BrowserSession} from './chatgpt-browser.js';
import {adoptConnectedConversation} from '../core/chat-adoption.js';
import {watchedBrowser,nextBrowserWatchCandidate,acknowledgeBrowserWatchCandidate,
  orderedBrowserWatchCandidates,recordBrowserWatchAttempt,
  type ConnectedChatCandidate} from '../core/browser-watch.js';
import {driveChatConversation,executeBrowserRollover,browserFreshTaskPrompt} from '../core/browser-controller.js';
import {withReadOnlyDeadline} from '../core/read-only-deadline.js';
import {consumeScopedPiConnectionDrill,attestScopedPiConnectionClosed} from '../core/pi-connection-drill.js';
import {drivePiAutopilot,pauseFailedPiPlanning,
  deferTransientPiBrowserRecovery} from '../core/pi-autopilot.js';
import {SshPiPlanner,validateRemoteProjectPath,type PiPlanner} from '../core/pi-planner.js';
import {GoalLedger} from '../core/goal-store.js';
import {StagedGoalIntake,isFreshStagedApproval,type StageBaselineDimensions} from '../core/staged-goal-intake.js';
import {collectStagedGoalBaseline} from '../core/staged-goal-baseline.js';
import {GoalReleaseGate} from '../core/goal-release.js';
import type {RuntimeProvenance} from '../core/runtime-provenance.js';
import type {Mission,MissionEvent} from '../core/types.js';

export const telegramPluginManifest:PluginManifest={
  id:'channel.telegram',version:'0.1.0',apiVersion:1,kind:'channel',
  capabilities:['receive-command','notify'],
};

/** A recoverable asynchronous stall, not a slow ChatGPT turn or a temporary
 * Telegram network outage. No extra watchdog process or scheduled task. */
export const TELEGRAM_IDLE_STALL_EXIT_MS=5*60_000;
export function stalledPollerMayExit(now:number,lastLoopProgressAt:number,
  activeMission:boolean,safeCheckpoint:boolean):boolean {
  return Number.isFinite(now)&&Number.isFinite(lastLoopProgressAt)&&
    now-lastLoopProgressAt>=TELEGRAM_IDLE_STALL_EXIT_MS &&
    !activeMission&&safeCheckpoint;
}

/** Only a narrowly recognizable read-only transport/timeout failure may
 * trigger unattended PI Chrome recovery. Authorization failures, ambiguous
 * DOM attribution and arbitrary exceptions must not become retries. */
function isTransientPiRecoveryReadFailure(error:unknown):boolean {
  if(!(error instanceof Error))return false;
  return /Read-only Chrome preflight timed out|Playwriter relay reconnecting|Playwriter (?:connection|relay) (?:closed|disconnected)|(?:connection|socket) (?:reset|closed|refused|aborted)|Target (?:page )?closed|locator\.(?:innerText|count|isVisible): Timeout \d+ms exceeded|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE/i
    .test(error.message);
}

export interface TelegramUpdate {
  update_id:number;
  message?:{
    text?:string;
    from?:{id:number};
    chat:{id:number;type:string};
  };
  callback_query?:{
    id:string;data?:string;from:{id:number};
    message?:{chat:{id:number;type:string}};
  };
}
type TelegramKeyboard={inline_keyboard:Array<Array<{text:string;callback_data:string}>>};
const TELEGRAM_MISSION_PAGE_SIZE=8;
function missionPage(argument:string|undefined,extra:string[],total:number):{page:number;pages:number;start:number}{
  if(extra.length|| (argument!==undefined&&!/^[1-9]\d*$/.test(argument)))
    throw new Error('Expected a positive page number (for example /list 2)');
  const page=argument===undefined?1:Number(argument);
  const pages=Math.max(1,Math.ceil(total/TELEGRAM_MISSION_PAGE_SIZE));
  if(!Number.isSafeInteger(page)||page>pages)
    throw new Error(`Page out of range; available pages: 1–${pages}`);
  return {page,pages,start:(page-1)*TELEGRAM_MISSION_PAGE_SIZE};
}
export interface TelegramTransport {
  getUpdates(offset:number,timeoutSeconds:number):Promise<TelegramUpdate[]>;
  sendMessage(chatId:number,text:string,keyboard?:TelegramKeyboard):Promise<void>;
  answerCallbackQuery?(id:string):Promise<void>;
}

/** A replacement Worker that starts inside an already-acquired maintenance
 * drain may prove Bot API connectivity without consuming, acknowledging or
 * executing an incoming command. The original Worker (started before the
 * drain) still exits cooperatively. No cursor is advanced here. */
export async function probeFencedTelegramTransport(store:Store,
  transport:TelegramTransport,source='telegram'):Promise<boolean>{
  if(!store.channelDrainRequested(source))return false;
  const text=store.getMeta(`${source}.inbox_cursor`)??'0';
  if(!/^(0|[1-9]\d*)$/.test(text)||!Number.isSafeInteger(Number(text)))
    throw new Error('Invalid maintenance Telegram inbox cursor');
  const result=await transport.getUpdates(Number(text),1);
  if(!Array.isArray(result))throw new Error('Maintenance transport probe returned no update array');
  // If the drain ended during the transport request, normal polling owns the
  // next update. The result of this probe is never dispatched or credited.
  if(!store.channelDrainRequested(source))return false;
  store.recordChannelPollSuccess(source);
  return true;
}

/** Bot token is in process memory only; errors never print it or the request URL. */
export class TelegramHttpTransport implements TelegramTransport {
  constructor(private readonly token:string) {
    if(!token || !/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new Error('Invalid Telegram bot token');
  }
  private async call<T>(method:string,payload:unknown):Promise<T> {
    let response:Response;
    try {
      response=await fetch(`https://api.telegram.org/bot${this.token}/${method}`,{
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),
        signal:AbortSignal.timeout(35000),
      });
    } catch{throw new Error(`Telegram ${method} network request failed`);}
    if(!response.ok) throw new Error(`Telegram ${method} returned HTTP ${response.status}`);
    const body=await response.json() as {ok?:boolean;result?:T};
    if(!body.ok || body.result===undefined) throw new Error(`Telegram ${method} returned an unsuccessful response`);
    return body.result;
  }
  async getUpdates(offset:number,timeoutSeconds:number):Promise<TelegramUpdate[]> {
    return this.call<TelegramUpdate[]>('getUpdates',{offset,timeout:timeoutSeconds,allowed_updates:['message','callback_query'],limit:30});
  }
  async sendMessage(chatId:number,text:string,keyboard?:TelegramKeyboard):Promise<void> {
    await this.call('sendMessage',{chat_id:chatId,text:text.slice(0,3900),
      ...(keyboard?{reply_markup:keyboard}:{})});
  }
  async answerCallbackQuery(id:string):Promise<void> {
    await this.call('answerCallbackQuery',{callback_query_id:id});
  }
}

/** Read-only buttons; the authoritative reply remains persisted as text and
 * the keyboard can be deterministically re-created after a network failure. */
export function telegramKeyboardForReply(reply:string):TelegramKeyboard|undefined {
  if(reply.startsWith('Missions requiring attention:')||reply.startsWith('Recent Mission history')){
    const uuids=[...reply.matchAll(/\/status ([0-9a-f-]{36})/gi)].slice(0,3).map(m=>m[1]!);
    const section=reply.startsWith('Recent Mission history')?'history':'list';
    const paging=reply.match(/: Page (\d+)\/(\d+)\b/);
    const page=paging?Number(paging[1]):1,pages=paging?Number(paging[2]):1;
    return {inline_keyboard:[
      ...uuids.map((id,i)=>[{text:`View ${i+1}`,callback_data:`mr:status:${id}`}]),
      ...(page>1?[[{text:'Previous page',callback_data:`mr:${section}:${page-1}`}]]:[]),
      ...(page<pages?[[{text:'Next page',callback_data:`mr:${section}:${page+1}`}]]:[]),
      [{text:'Refresh tasks',callback_data:'mr:list'},{text:'History',callback_data:'mr:history'}],
    ]};
  }
  const detail=reply.match(/^([0-9a-f-]{36}) \[/i);
  if(detail)return {inline_keyboard:[
    [{text:'Refresh status',callback_data:`mr:status:${detail[1]}`}],
    [{text:'Tasks',callback_data:'mr:list'},{text:'History',callback_data:'mr:history'}],
  ]};
  const status=reply.match(/\/status ([0-9a-f-]{36})/i);
  if(status)return {inline_keyboard:[
    [{text:'View status',callback_data:`mr:status:${status[1]}`}],
    [{text:'Tasks',callback_data:'mr:list'}],
  ]};
  return undefined;
}

export function telegramCallbackCommand(data:string):string {
  if(data==='mr:list')return '/list';
  if(data==='mr:history')return '/history';
  const page=data.match(/^mr:(list|history):([1-9]\d*)$/);
  if(page&&Number.isSafeInteger(Number(page[2])))return `/${page[1]} ${page[2]}`;
  const match=data.match(/^mr:status:([0-9a-f-]{36})$/i);
  if(match)return `/status ${match[1]}`;
  throw new Error('Unknown or unsupported button action');
}

const TERMINAL_EVENTS=new Set([
  'mission.ambiguous_failure','mission.blocked','mission.paused',
  'verification.accepted','verification.checks_required',
  'chatgpt.browser_observed','chatgpt.browser_uncertain',
  'chatgpt.browser_rollover_recovered',
  'chatgpt.browser_turn_recovered',
  'chatgpt.browser_run_finished',
  'pi.decision','pi.autopilot_finished','pi.autopilot_interrupted',
]);
const STATUS_BY_EVENT:Record<string,string>={
  'mission.ambiguous_failure':'NEEDS_RECONCILIATION',
  'mission.blocked':'BLOCKED',
  'mission.paused':'PAUSED',
  'verification.accepted':'COMPLETED',
  'verification.checks_required':'PAUSED (verification checks required)',
  'chatgpt.browser_observed':'PAUSED (ChatGPT browser response observed)',
  'chatgpt.browser_uncertain':'NEEDS_RECONCILIATION (browser side effect ambiguous)',
  'chatgpt.browser_rollover_recovered':'PAUSED (operator-confirmed new ChatGPT conversation)',
  'chatgpt.browser_turn_recovered':'PAUSED (original ChatGPT reply independently re-observed)',
  'chatgpt.browser_run_finished':'PAUSED (final ChatGPT browser batch result observed)',
  'pi.autopilot_finished':'PAUSED (PI autopilot ended)',
  'pi.autopilot_interrupted':'PAUSED (PI coordinator failed; no next Send)',
};

/** Telegram is not end-to-end encrypted. Treat all model summaries and
 * verifier evidence as untrusted, potentially secret-bearing display text. */
function redactTelegramText(value:string):string {
  return value.replace(/\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{22,}/g,'[REDACTED]')
    .replace(/\b(?:ghp_|gho_|ghu_|ghs_|github_pat_)[A-Za-z0-9_]{18,}/g,'[REDACTED]')
    .replace(/\b\d{7,11}:[A-Za-z0-9_-]{30,}\b/g,'[REDACTED]')
    .replace(/https?:\/\/[^\s]*[#?][^\s]*/gi,'[PRIVATE LINK]');
}
function compactTelegramText(value:string,maxLength:number):string {
  const cleaned=redactTelegramText(value.replace(/\s+/g,' ').trim());
  return cleaned.length<=maxLength?cleaned:`${cleaned.slice(0,maxLength-1)}…`;
}

/** A native executor Mission must surface the verified outcome, not just an
 * opaque status code. Verifier conclusions are separate model judgment, not
 * independently proven real-world facts or deterministic checks. */
export function formatNativeMissionNotification(m:Mission,event:MissionEvent):string {
  const base=[`Mission ${m.id}: ${STATUS_BY_EVENT[event.type]??m.state}`,
    `Event #${event.id}: ${event.type}`];
  if(event.type==='verification.accepted') {
    const payload=event.payload && typeof event.payload==='object'
      ? event.payload as {reason?:unknown;evidence?:unknown}: {};
    const evidence=Array.isArray(payload.evidence)?payload.evidence
      .filter((x):x is string=>typeof x==='string').slice(0,3):[];
    return [
      ...base,
      'Native agent result (model + independent model verifier; not deterministic proof):',
      `Summary: ${compactTelegramText(m.lastSummary??'No summary available',450)}`,
      ...evidence.map((x,i)=>`Evidence ${i+1}: ${compactTelegramText(x,235)}`),
      `Details: /status ${m.id}`,
    ].join('\n').slice(0,2900);
  }
  return [...base,`Use /status ${m.id} for details.`].join('\n');
}

export function formatPiNotification(m:Mission,event:MissionEvent):string {
  const payload=event.payload && typeof event.payload==='object'
    ?event.payload as {summary?:unknown;action?:unknown;reason?:unknown}:{};
  const action=event.type==='pi.autopilot_interrupted'?'INTERRUPTED':
    typeof payload.action==='string'?payload.action:'UNKNOWN';
  const summary=typeof payload.summary==='string'?payload.summary:
    typeof payload.reason==='string'?payload.reason:'No PI decision summary';
  return [`Mission ${m.id}: PI ${action} — ${formatMissionTurns(m.turnCount,m.maxTurns)} ChatGPT turns`,
    'Result (PI model-reviewed, not independently verified):',
    compactTelegramText(summary,850),
    action==='INTERRUPTED'?'No new browser Send has been authorized; inspect before resuming.':'',
    `Status: /status ${m.id}`,
    `ChatGPT link: /handoff ${m.id}`].filter(Boolean).join('\n').slice(0,1600);
}
function formatPiProgress(m:Mission,event:MissionEvent):string {
  const payload=event.payload && typeof event.payload==='object'
    ?event.payload as {action?:unknown;round?:unknown;summary?:unknown}:{};
  return [`PI Mission ${m.id}: round ${formatMissionTurns(typeof payload.round==='number'?payload.round:m.turnCount,m.maxTurns)} observed`,
    `PI decision: ${String(payload.action??'UNKNOWN')}`,
    `Progress (model-reviewed): ${compactTelegramText(typeof payload.summary==='string'?payload.summary:'',520)}`,
    'Owner notes received during the next ChatGPT turn will be queued for the following PI decision.',
    `Status: /status ${m.id}`].join('\n').slice(0,1250);
}

/** Telegram is not end-to-end encrypted: only send a bounded tail of the
 * browser response, never complete tool logs, screenshots or browser secrets. */
export function formatBrowserResultNotification(m:Mission,event:MissionEvent):string {
  const data=(event.payload && typeof event.payload==='object')
    ?event.payload as {excerpt?:unknown;round?:unknown;reason?:unknown}:{};
  if(event.type==='chatgpt.browser_uncertain')
    return [`Mission ${m.id}: NEEDS_RECONCILIATION`,
      `Round: ${formatMissionTurns(typeof data.round==='number'?data.round:m.turnCount,m.maxTurns)}`,
      'Browser send or reply is ambiguous; no automatic replay.',
      'Inspect the Chrome conversation before manual reconciliation.',
      `Use /status ${m.id} for details.`].join('\n');
  const excerpt=typeof data.excerpt==='string'?data.excerpt:(m.lastSummary??'');
  const allLines=excerpt.replace(/\r/g,'').split('\n').map(x=>x.trim()).filter(Boolean);
  // Prefer the deliberate compact handoff to the arbitrary tail of a 5–30min
  // response. The model's claims are unverified, so label them accordingly.
  // Keep the flow marker outside the summary, so it cannot consume a useful line.
  const marker=/^\[MISSION_RELAY:(?:NEXT|DONE|BLOCKED|HANDOFF)\]$/;
  const finalMarker=marker.test(allLines.at(-1)??'')?allLines.pop():undefined;
  let headerIndex=-1;
  for(let i=allLines.length-1;i>=0;i--) {
    const heading=allLines[i]!.replace(/^#{1,6}\s*/,'').replace(/\*\*/g,'').trim();
    if(/^Telegram[- ]ready summary\s*:?$/i.test(heading)){headerIndex=i;break;}
  }
  const selected=headerIndex>=0?allLines.slice(headerIndex+1):allLines.slice(-6);
  const lines=selected.filter(x=>!/^[-=]{3,}$/.test(x)).slice(0,6)
    .map(x=>x.length>190?'…'+x.slice(-189):x);
  // Redact recognizable credential formats if a model accidentally quotes one.
  const round=typeof data.round==='number'?data.round:m.turnCount;
  const text=[`Mission ${m.id} — turn ${formatMissionTurns(round,m.maxTurns)}`,
    'ChatGPT result (model-provided; not independently verified):',
    ...lines.map(redactTelegramText),
    ...(finalMarker?[finalMarker]:[]),
    `Status: /status ${m.id}`];
  return text.join('\n').slice(0,2900);
}

/** A single-owner, foreground-only optional channel. Never auto-approve or reconcile. */
export class TelegramBridge {
  private activeMission:string|null=null;
  private activeTask:Promise<void>|null=null;
  private lastBrowserWatchAt=0;
  /** An idle, already-observed PI checkpoint may outlive a Chrome restart.
   * A connector/read-only DOM outage must not poison its durable NEXT plan;
   * retry only after bounded quiet time, never by replaying a browser Send. */
  private lastTransientPiRecoveryAt=0;
  private readonly source='telegram';
  constructor(
    readonly store:Store, readonly engine:Engine, readonly transport:TelegramTransport,
    readonly userId:number,readonly chatId:number,
    private readonly preflight:(missionId?:string)=>Promise<PreflightResult>=async()=>({
      ok:false,source:'default',message:'No native executor plugin configured',
    }),
    private readonly browserConnector:(url:string,options?:{browserId?:string;bootstrapMissingAnchor?:boolean})=>Promise<BrowserSession>=connectChatPage,
    private readonly piPlanner:PiPlanner=new SshPiPlanner({
      sshHost:store.getMeta('telegram.pi.sshHost')||'UNCONFIGURED',
      project:store.getMeta('telegram.pi.project')||'/srv',
    }),
    private readonly watchCandidates:(browserId:string)=>Promise<ConnectedChatCandidate[]>=listConnectedChatCandidates,
    private readonly startupProvenance:RuntimeProvenance|null=null,
    private readonly stageBaselineProbe:(store:Store,goalId:string,planner:PiPlanner)=>
      Promise<StageBaselineDimensions>=collectStagedGoalBaseline,
  ) {
    if(!Number.isSafeInteger(userId)||userId<=0||!Number.isSafeInteger(chatId)||chatId<=0)
      throw new Error('Set numeric Telegram owner user and private chat IDs');
  }

  /** This small method is intentionally public for offline integration tests. */
  async pollOnce(timeoutSeconds=8):Promise<void> {
    if(this.store.getMeta('telegram.notifications_cursor')===null)
      this.store.setMeta('telegram.notifications_cursor',String(this.store.maxEventId()));
    if(!this.activeTask&&!this.store.channelDrainRequested(this.source))
      for(const m of this.engine.list())this.store.createPiSuccessor(m.id);
    await this.deliverPendingReplies();
    await this.deliverNotifications();
    const offset=Number(this.store.getMeta('telegram.inbox_cursor') ?? '0');
    const updates=await this.transport.getUpdates(offset,timeoutSeconds);
    if(!Array.isArray(updates)) throw new Error('Telegram getUpdates did not return an array');
    this.store.recordChannelPollSuccess(this.source);
    // A concurrent maintenance request must not acknowledge freshly fetched
    // Bot API updates. Telegram will return them after the replacement starts.
    if(this.store.channelDrainRequested(this.source))return;
    // Never let an out-of-order transport response apply commands out of sequence.
    const ordered=[...updates].sort((a,b)=>(a?.update_id ?? -1)-(b?.update_id ?? -1));
    for(const update of ordered) {
      if(!update || !Number.isSafeInteger(update.update_id) || update.update_id<offset) continue;
      const next=update.update_id+1;
      const message=update.message;
      const cb=update.callback_query;
      // Treat all Bot API data as untrusted; malformed updates must not wedge the inbox.
      const permittedMessage=message?.chat?.type==='private'&&message.from?.id===this.userId&&message.chat.id===this.chatId;
      const permittedCallback=cb?.message?.chat?.type==='private'&&cb.from?.id===this.userId&&
        cb.message.chat.id===this.chatId&&typeof cb.data==='string';
      if(!permittedMessage&&!permittedCallback) {
        this.store.advanceChannelCursor(this.source,next);
        continue;
      }
      const externalId=String(update.update_id);
      if(!this.store.reserveChannelCommand(this.source,externalId,next)) continue;
      let reply:string;
      try { reply=await this.handle(permittedCallback?telegramCallbackCommand(cb!.data!):message!.text ?? '',externalId); }
      catch(err){reply=`Command rejected: ${err instanceof Error?err.message:'unknown error'}`;}
      this.store.completeChannelCommand(this.source,externalId,reply);
      if(permittedCallback&&cb?.id&&this.transport.answerCallbackQuery){
        try{await this.transport.answerCallbackQuery(cb.id);}catch{
          // Acknowledgement is cosmetic; do not rerun a durable command.
          console.error('Telegram button acknowledgement failed; command result is preserved');
        }
      }
    }
    await this.deliverPendingReplies();
  }

  async run(signal?:AbortSignal):Promise<void> {
    const lease=this.store.acquireChannelLease(this.source);
    let startedInsideDrain=this.store.channelDrainRequested(this.source);
    let backoff=1000;
    let lastLoopProgressAt=Date.now();
    // If an awaited Chrome/transport operation hangs while no Mission is in
    // flight, voluntarily exit this ONE worker so its existing scheduled task
    // can restart it. This timer cannot recover a blocked JS event loop.
    const watchdog=setInterval(()=>{
      if(Date.now()-lastLoopProgressAt<TELEGRAM_IDLE_STALL_EXIT_MS||
         this.activeMission||this.activeTask)return;
      try {
        if(stalledPollerMayExit(Date.now(),lastLoopProgressAt,false,
          this.store.canAbandonStalledChannel(this.source))) {
          // The Windows task intentionally ignores duplicate trigger results;
          // persist a minimal self-exit reason so a later PID change can be
          // distinguished from an unexplained crash without exposing messages.
          this.store.recordChannelIdleExit(this.source,lastLoopProgressAt);
          console.error('Telegram idle control loop stalled; exiting worker for task-managed recovery (no Mission replay)');
          process.exit(75);
        }
      }catch{ /* Unreadable SQLite state must never authorize self-termination. */ }
    },30_000);
    watchdog.unref();
    try {
      if(this.startupProvenance)
        this.store.recordChannelRuntime(this.source,lease,this.startupProvenance);
      // Recover ONLY a PI decision whose previous browser response and
      // next-step plan were durably observed. Never reconstruct an uncertain Send.
      if(!this.store.channelDrainRequested(this.source))
        await this.recoverObservedPiCheckpoint();
      while(!signal?.aborted) {
        if(this.store.channelDrainRequested(this.source)) {
          // A previously accepted browser/PI task is authoritative and must
          // finish. If the operator cancels the drain during that task,
          // continue normal polling rather than exiting unexpectedly.
          if(this.activeTask)await this.activeTask;
          if(this.store.channelDrainRequested(this.source)){
            if(!startedInsideDrain)break;
            // Keep only the newly enrolled replacement Worker alive for
            // startup/identity validation under the SAME SQLite fence.
            // Never call pollOnce(), PI recovery or any browser Send here.
            try{
              await probeFencedTelegramTransport(this.store,this.transport,this.source);
              lastLoopProgressAt=Date.now();
              backoff=1000;
            }catch{
              // No artificial healthy receipt after a transport failure.
              if(this.store.channelDrainRequested(this.source))
                this.store.recordChannelPollFailure(this.source);
              await new Promise(resolve=>setTimeout(resolve,backoff));
              backoff=Math.min(backoff*2,30000);
            }
            await new Promise(resolve=>setTimeout(resolve,1000));
            continue;
          }
          continue;
        }
        startedInsideDrain=false;
        try {
          await this.pollOnce();
          lastLoopProgressAt=Date.now();
          if(this.store.channelDrainRequested(this.source))continue;
          // Adopted ChatGPT missions may be queued by an independent local
          // CLI. Only this leased foreground controller drives PI/browser.
          if(!this.activeTask&&!this.store.channelDrainRequested(this.source))
            await this.recoverObservedPiCheckpoint();
          if(!this.activeTask&&!this.store.channelDrainRequested(this.source)&&
            watchedBrowser(this.store)&&
            Date.now()-this.lastBrowserWatchAt>=15_000) {
            this.lastBrowserWatchAt=Date.now();
            try {await this.scanBrowserWatchOnce();}
            catch {
              // Discovery is best-effort and never delays Telegram polling
              // through its transport backoff when Chrome is disconnected.
              console.error('Browser watch scan unavailable; Telegram controller stays online');
            }
            if(!this.activeTask&&!this.store.channelDrainRequested(this.source))
              await this.recoverObservedPiCheckpoint();
          }
          backoff=1000;
          lastLoopProgressAt=Date.now();
        }
        catch(error) {
          const message=error instanceof Error?error.message:'Telegram transport error';
          if(/HTTP (401|403|409)/.test(message)) throw new Error(message);
          console.error(`Telegram channel transient failure: ${message}`);
          await new Promise(resolve=>setTimeout(resolve,backoff));
          lastLoopProgressAt=Date.now();
          backoff=Math.min(backoff*2,30000);
        }
      }
    } finally {
      clearInterval(watchdog);
      // Finish the current turn before closing its authoritative SQLite store.
      // A transport exit must not silently kill an in-flight external action.
      if(this.activeTask) await this.activeTask;
      this.store.releaseChannelLease(this.source,lease);
    }
  }

  /** One candidate per scan; existing Telegram foreground lease remains the
   * only PI/browser writer. A changed existing human chat is merely observed
   * until its stable answer is independently checked. No extra daemon. */
  async scanBrowserWatchOnce():Promise<string|null> {
    if(this.activeMission||this.activeTask)return null;
    // A new-tab Send may have completed while the observer lost its URL.
    // Do not adopt that orphan as a separate read-only human conversation:
    // preserve its original write scope and request identity for recovery.
    if(this.engine.list().some(m=>m.state==='NEEDS_RECONCILIATION'&&
      this.store.getMeta(`pi.autopilot.enabled.${m.id}`)==='1'&&
      this.store.chatBrowserTurn(m.id)?.status==='uncertain'))return null;
    const browserId=watchedBrowser(this.store);
    if(!browserId)return null;
    const inventory=await this.watchCandidates(browserId);
    const ordered=orderedBrowserWatchCandidates(this.store,browserId,inventory);
    let candidate=nextBrowserWatchCandidate(this.store,browserId,ordered);
    // An already linked conversation is never treated as a new Mission just
    // because the user or another agent has continued its visible history.
    // Skip all already-linked candidates in this inventory, so one frequently
    // updated old chat cannot starve a newly opened eligible conversation.
    while(candidate){
      const item=candidate;
      if(!this.store.list().some(m=>this.store.chatLink(m.id)===item.url))break;
      acknowledgeBrowserWatchCandidate(this.store,browserId,item);
      candidate=nextBrowserWatchCandidate(this.store,browserId,ordered);
    }
    if(!candidate)return null;
    recordBrowserWatchAttempt(this.store,browserId,candidate);
    if(this.piPlanner instanceof SshPiPlanner)await this.piPlanner.preflight();
    const session=await this.browserConnector(candidate.url,{browserId});
    try {
      const adopted=await adoptConnectedConversation(
        this.store,session.page,candidate.url,browserId,{
          piEnabled:true,
          stillAuthorized:()=>watchedBrowser(this.store)===browserId,
          // This runs in the same SQL transaction as Mission creation.
          // A crash or concurrent watch revocation cannot leave a newly
          // adopted Mission without PI enablement and watch attribution.
          onAdopted:missionId=>{
            this.store.setMeta(`browser.watch.mission.${missionId}`,browserId);
            acknowledgeBrowserWatchCandidate(this.store,browserId,candidate);
          },
        });
      return adopted.missionId;
    }catch(error) {
      // A partial or generating answer should be re-evaluated on the next
      // scan, not marked seen and permanently lost.
      if(!/Cannot adopt|changed before adoption|already belongs/.test(
        error instanceof Error?error.message:''))throw error;
      return null;
    }finally {
      try{await session.close();}catch{console.error('Browser watch session cleanup warning');}
    }
  }

  private async recoverObservedPiCheckpoint():Promise<void> {
    if(this.activeMission||this.activeTask||this.store.channelDrainRequested(this.source))return;
    // Reconstruct a missing successor after a controller crash between PI's
    // durable LIMIT decision and the child creation. The SQLite request key
    // makes this step idempotent; it does not send a browser message.
    for(const prior of this.engine.list())this.store.createPiSuccessor(prior.id);
    const ledger=new GoalLedger(this.store);
    const candidates=this.engine.list().filter(m=>{
      const receipt=this.store.chatBrowserTurn(m.id),plan=this.store.piPlan(m.id);
      const correctedPending=m.lastError?.startsWith('Corrected answer attribution awaits')&&
        !!receipt?.assistantSha256&&plan?.round===m.turnCount&&
        plan.responseSha256!==receipt.assistantSha256&&
        this.store.hasVerifiedPiBrowserCheckpoint(m.id);
      const retryAfter=Number(this.store.getMeta(`pi.retry.after.${m.id}`)??'0');
      if(this.store.getMeta(`pi.retry.sha.${m.id}`)===receipt?.assistantSha256&&
        this.store.getMeta(`pi.retry.request.${m.id}`)===receipt?.requestKey&&
        Number.isFinite(retryAfter)&&retryAfter>Date.now())return false;
      return this.store.getMeta(`pi.autopilot.enabled.${m.id}`)==='1' &&
      !m.stopRequested&&(!m.lastError||correctedPending)&&
      ((m.state==='READY'&&m.turnCount===0&&
        (!!this.store.piChainParent(m.id)||ledger.missionGoalId(m.id)!==null))||
      (m.state==='PAUSED'&&
        (m.turnCount>0||this.store.chatAdoption(m.id)!==null)))&&
      (m.maxTurns===0||m.turnCount<=m.maxTurns)&&
      (correctedPending||this.store.piChainParent(m.id)&&m.turnCount===0||
       m.turnCount===0&&ledger.missionGoalId(m.id)!==null||
       plan?.round!==m.turnCount||
        (missionTurnsRemaining(m.maxTurns,m.turnCount)&&
         ['NEXT','HANDOFF'].includes(plan?.action??'')));
    });
    if(!candidates.length)return;
    if(this.lastTransientPiRecoveryAt&&
      Date.now()-this.lastTransientPiRecoveryAt<60_000)return;
    // Queued adoptions are processed sequentially, not treated as conflicting
    // writers. Per-conversation SQLite locks still prevent duplicate Sends.
    const m=candidates.sort((a,b)=>a.createdAt.localeCompare(b.createdAt))[0]!;
    const url=this.store.chatLink(m.id),browserId=this.store.chatBrowserBinding(m.id);
    if(!url||!browserId){
      pauseFailedPiPlanning(this.store,m.id,'PI recovery source URL or bound Chrome profile is absent');
      return;
    }
    let session:BrowserSession|undefined;
    try{
      // Only the side-effect-free connector/DOM read is transient. A real
      // source hash mismatch below remains a durable, fail-closed interruption.
      let snapshot:Awaited<ReturnType<typeof inspectChatPage>>;
      let lastUserHash:string|null;
      try {
        session=await withReadOnlyDeadline(this.browserConnector(url,{browserId}),30_000,
          lateSession=>lateSession.close());
        // One explicitly armed drill closes ONLY this already-pinned recovery
        // client session, not Chrome, the target tab or another controller.
        // The marker was durably consumed with a TTL before the failure.
        if(consumeScopedPiConnectionDrill(this.store,m.id)){
          let clientClosed=false;
          try{await session.close();clientClosed=true;}
          catch{/* An unverified close is not attested as successful. */}
          session=undefined;
          if(clientClosed)attestScopedPiConnectionClosed(this.store,m.id);
          throw new Error('Playwriter relay reconnecting: scoped PI recovery connection drill');
        }
        snapshot=await withReadOnlyDeadline(inspectChatPage(session.page,url));
        lastUserHash=await withReadOnlyDeadline(lastVisibleUserPromptSha256(session.page));
      }catch(error){
        const message=error instanceof Error?error.message:'Unknown Chrome read error';
        if(isTransientPiRecoveryReadFailure(error)) {
          if(!deferTransientPiBrowserRecovery(this.store,m.id,message))
            this.lastTransientPiRecoveryAt=Date.now();
          console.error(`PI recovery ${m.id}: temporary Chrome read failure; only the original checkpoint may be rechecked after backoff, without Send`);
        }else{
          pauseFailedPiPlanning(this.store,m.id,
            error instanceof Error?error:new Error(message));
          console.error(`PI recovery ${m.id}: browser read error requires inspection; no automatic Send`);
        }
        return;
      }
      if(snapshot.generating||!snapshot.composerReady){
        if(!deferTransientPiBrowserRecovery(this.store,m.id,
          'Original ChatGPT conversation is still generating or composer is unavailable'))
          this.lastTransientPiRecoveryAt=Date.now();
        console.error(`PI recovery ${m.id}: linked ChatGPT tab not idle; preserving exact checkpoint without Send`);
        return;
      }
      const firstGoalSend=m.state==='READY'&&m.turnCount===0&&
        !this.store.piChainParent(m.id)&&ledger.missionGoalId(m.id)!==null;
      // Only a zero-turn successor inherits the parent's final browser
      // checkpoint. Once the child has observed its own first Send, all
      // subsequent recovery reads MUST compare to the child's own latest
      // receipt; the parent is a different ChatGPT conversation.
      const checkpointId=m.turnCount===0&&this.store.piChainParent(m.id)
        ?this.store.piChainParent(m.id)!:m.id;
      const previous=firstGoalSend?null:
        this.store.chatBrowserTurn(checkpointId);
      if(firstGoalSend){
        if(this.store.chatBrowserTurn(m.id)||this.store.piPlan(m.id))
          throw new Error('Initial Goal recovery refused: a browser Send or PI decision already exists');
      }else if(!previous||
        !this.store.hasVerifiedPiBrowserCheckpoint(checkpointId)||
        createHash('sha256').update(snapshot.lastAssistant).digest('hex')!==previous.assistantSha256||
        lastUserHash!==previous.promptSha256)
        throw new Error(PI_SUCCESSOR_CHECKPOINT_MISMATCH);
      this.lastTransientPiRecoveryAt=0;
      this.activeMission=m.id;
      const held=session;session=undefined;
      this.activeTask=drivePiAutopilot({
        store:this.store,planner:this.piPlanner,missionId:m.id,
        revision:m.version,requestPrefix:m.requestKey,
        page:held.page,url,
        ...(firstGoalSend?{}:{recoveredAnswer:{
          responseSha256:createHash('sha256').update(snapshot.lastAssistant).digest('hex'),
          lastAssistant:snapshot.lastAssistant,
        }}),
      }).catch(error=>{
        const reason=error instanceof Error?error.message:'unknown PI recovery error';
        console.error(`PI recovery ${m.id}: ${reason}`);
        pauseFailedPiPlanning(this.store,m.id,error instanceof Error?error:reason);
      }).finally(async()=>{
        try{await held.close();}catch{console.error('PI recovery session cleanup warning');}
        finally{this.activeMission=null;this.activeTask=null;}
      });
    }catch(error){
      const reason=error instanceof Error?error.message:'unknown PI checkpoint error';
      console.error(`PI recovery ${m.id}: ${reason}`);
      pauseFailedPiPlanning(this.store,m.id,error instanceof Error?error:reason);
    }finally{
      if(session)try{await session.close();}catch{/* Best effort only. */}
    }
  }

  private async deliverPendingReplies():Promise<void> {
    for(const reply of this.store.pendingChannelReplies(this.source)) {
      if(reply.status==='reserved') {
        // A previous process may have stopped between reserving and applying a command.
        // Never replay it automatically; the user must inspect state and issue a new command.
        this.store.completeChannelCommand(this.source,reply.externalId,
          'An earlier command was interrupted before acknowledgement. Inspect mission status and send a NEW command if needed. Nothing was automatically retried.');
      }
      const finished=this.store.pendingChannelReplies(this.source).find(x=>x.externalId===reply.externalId);
      if(!finished || finished.status!=='finished') continue;
      await this.transport.sendMessage(this.chatId,finished.reply,telegramKeyboardForReply(finished.reply));
      this.store.markChannelDelivered(this.source,reply.externalId);
    }
  }

  private async deliverNotifications():Promise<void> {
    let cursor=Number(this.store.getMeta('telegram.notifications_cursor') || '0');
    for(const event of this.store.eventsAfter(cursor)) {
      if(TERMINAL_EVENTS.has(event.type)) {
        const payload=event.payload as {notificationMode?:string}|null;
        // Telegram batch intermediate turns remain in the SQLite event log,
        // but only its final outcome is delivered as one concise notification.
        if(event.type==='chatgpt.browser_observed'&&payload?.notificationMode==='telegram-batch'){
          cursor=event.id;
          this.store.setMeta('telegram.notifications_cursor',String(cursor));
          continue;
        }
        if(event.type==='pi.decision' &&
          (!['NEXT','HANDOFF'].includes(String((event.payload as {action?:unknown})?.action))||
            missionTurnLimitReached(this.store.get(event.missionId).maxTurns,Number((event.payload as {round?:unknown})?.round)))){
          cursor=event.id;
          this.store.setMeta('telegram.notifications_cursor',String(cursor));
          continue;
        }
        const successor=event.type==='pi.autopilot_finished'
          ?this.store.piChainSuccessor(event.missionId):null;
        const body=successor&&
          (event.payload as {action?:unknown})?.action==='LIMIT'
          ?`PI Mission ${event.missionId} reached ${this.store.get(event.missionId).maxTurns} turns; the owner goal remains open.\nAutomatically continued as Mission ${successor}.\nStatus: /status ${successor}`
          :event.type==='pi.decision'
          ?formatPiProgress(this.store.get(event.missionId),event)
          :event.type==='pi.autopilot_finished'||event.type==='pi.autopilot_interrupted'
          ?formatPiNotification(this.store.get(event.missionId),event)
          :event.type==='chatgpt.browser_observed'||event.type==='chatgpt.browser_uncertain'||
          event.type==='chatgpt.browser_run_finished'||
          event.type==='chatgpt.browser_rollover_recovered'||event.type==='chatgpt.browser_turn_recovered'
          ?formatBrowserResultNotification(this.store.get(event.missionId),event)
          :formatNativeMissionNotification(this.store.get(event.missionId),event);
        await this.transport.sendMessage(this.chatId,body);
      }
      cursor=event.id;
      this.store.setMeta('telegram.notifications_cursor',String(cursor));
    }
  }

  /** PI stays tool-free. An explicit /build command grants ChatGPT a single
   * operator-approved source scope; ordinary text and /auto stay read-only. */
  private async startPiChat(task:string,commandId:string,write=false,goalDriven=false):Promise<string> {
    const goal=task.trim();
    if(this.activeMission){
      if(goalDriven)
        throw new Error('A PI Mission is already active; /goal cannot silently replace it or become an owner note');
      if(write&&this.store.get(this.activeMission).sandbox!=='workspace-write')
        throw new Error('A read-only PI Mission is already active; /build cannot silently upgrade it');
      return this.queuePiOwnerText(goal,commandId);
    }
    // A dead foreground process may have left a reserved browser Send or a
    // PI analysis checkpoint behind. Do not treat a fresh Telegram message
    // as permission to submit the old task in another new tab.
    const unresolved=this.engine.list().find(m=>{
      if(this.store.getMeta(`pi.autopilot.enabled.${m.id}`)!=='1')return false;
      // A cooperative owner pause cannot make an original browser Send safe
      // to ignore. Even a paused/stopped Mission still owns its reserved or
      // uncertain side effect until the original request is settled.
      const receipt=this.store.chatBrowserTurn(m.id);
      if(receipt&&['reserved','uncertain'].includes(receipt.status))return true;
      if(m.stopRequested)return false;
      if(['RUNNING','VERIFYING','NEEDS_RECONCILIATION','READY'].includes(m.state))
        return true;
      if(m.state!=='PAUSED')return false;
      // A prior PI failure that is durably paused is not an active writer.
      // Preserve its original error/receipts for explicit recovery, but do
      // not let it monopolize all future owner-originated ChatGPT requests.
      // A leftover reserved or uncertain browser Send remains a global gate.
      if(m.lastError&&this.store.events(m.id).some(
        event=>event.type==='pi.autopilot_interrupted'))return false;
      const finished=this.store.events(m.id).some(e=>e.type==='pi.autopilot_finished');
      return !finished;
    });
    if(unresolved&&this.store.chatAdoption(unresolved.id)!==null)
      if(goalDriven)throw new Error(`Another PI Mission ${unresolved.id} is unresolved; /goal will not create a duplicate Goal or queue its text as another Mission instruction`);
    if(unresolved&&this.store.chatAdoption(unresolved.id)!==null)
      return this.queuePiOwnerText(goal,commandId,unresolved.id);
    if(unresolved?.state==='READY'&&this.store.piChainParent(unresolved.id)){
      if(goalDriven)throw new Error(`PI successor ${unresolved.id} is already awaiting continuation; /goal cannot create a competing Goal`);
      if(write&&unresolved.sandbox!=='workspace-write')
        throw new Error('A read-only PI successor cannot be upgraded by /build');
      return this.queuePiOwnerText(goal,commandId,unresolved.id);
    }
    if(unresolved)
      throw new Error(`An earlier PI Mission ${unresolved.id} is not terminal (${unresolved.state}); inspect its exact Chrome/SQLite receipt before starting another. No browser Send was submitted.`);
    if(this.piPlanner instanceof SshPiPlanner &&
      !this.store.getMeta('telegram.pi.sshHost'))
      throw new Error('PI coordinator not configured; use the local telegram-pi-config command');
    const approved=write?this.store.getMeta('telegram.build.project'):null;
    if(write&&(!approved||approved!==this.store.getMeta('telegram.pi.project')))
      throw new Error('Write-enabled PI task needs a locally approved project matching the PI route; configure telegram-build-project first');
    const writeWorkspace=approved?validateRemoteProjectPath(approved):null;
    browserFreshTaskPrompt(goal,writeWorkspace);
    const anchorId=this.store.getMeta('telegram.chatgpt.anchorMissionId');
    if(!anchorId)throw new Error('No approved PI ChatGPT anchor; use telegram-anchor locally');
    const url=this.store.chatLink(anchorId),browserId=this.store.chatBrowserBinding(anchorId);
    if(!url||!browserId)throw new Error('PI source Chrome binding is missing');
    if(this.piPlanner instanceof SshPiPlanner)
      await this.piPlanner.preflight(); // Avoid starting Chrome if PI is already offline.
    // The anchor is an approved Chrome PROFILE identity, not a permanent tab
    // lease. A new task always creates its own chat; replace only a missing
    // launch source with a new owned tab in that same pinned profile.
    const session=await this.browserConnector(url,{browserId,bootstrapMissingAnchor:true});
    try{
      const state=await inspectChatPage(session.page,url);
      if(!state.composerReady||state.generating)
        throw new Error('PI ChatGPT anchor tab is not ready');
      // The external maintenance CLI may request a drain while PI preflight
      // or Chrome inspection is awaited. Publish the PI-ready intent, exact
      // browser binding and drain check as one SQLite transaction.
      const created=this.store.atomic(()=>{
        if(this.store.channelDrainRequested(this.source))
          throw new Error('Telegram maintenance drain active; PI task was not created');
        const requestKey=goalDriven?`telegram-goal-${commandId}`:`telegram-pi-${commandId}`;
        const m=this.engine.create({
          goal,acceptance:[writeWorkspace?
            'Implement the owner goal inside the approved source repository, verify changed files, tests and Git/CI evidence before claiming completion':
            'Substantively answer the owner request with evidence within read-only permissions'],
          workspace:writeWorkspace??'',sandbox:writeWorkspace?'workspace-write':'read-only',mode:'supervised',maxTurns:0,
          requestKey,checks:[],
        });
        const linked=this.store.linkChat(m.id,url,m.version).mission;
        const bound=this.store.bindChatBrowser(m.id,browserId,linked.version).mission;
        this.store.setMeta(`pi.autopilot.enabled.${m.id}`,'1');
        const ownerGoal=goalDriven?new GoalLedger(this.store).createGoal({
          requestKey,objective:goal,priority:50,
        }):null;
        if(ownerGoal)new GoalLedger(this.store).bindPiMission(ownerGoal.id,
          bound.id,bound.version,`initial-${commandId}`);
        return {bound,ownerGoal};
      });
      const {bound,ownerGoal}=created;
      const m=bound;
      this.activeMission=m.id;
      this.activeTask=drivePiAutopilot({
        store:this.store,planner:this.piPlanner,missionId:m.id,
        revision:bound.version,
        requestPrefix:goalDriven?`telegram-goal-${commandId}`:`telegram-pi-${commandId}`,
        page:session.page,url,
      }).catch(error=>{
        const message=error instanceof Error?error.message:'unknown PI autopilot error';
        console.error(`PI autopilot ${m.id}: ${message}`);
        pauseFailedPiPlanning(this.store,m.id,error instanceof Error?error:message);
      }).finally(async()=>{
        try{await session.close();}catch{console.error('PI Playwriter session cleanup warning');}
        finally{this.activeMission=null;this.activeTask=null;}
      });
      return `${ownerGoal?`Goal ${ownerGoal.id} created (persistent; not yet independently accepted).\n`:''}PI-coordinated ChatGPT Mission ${m.id} accepted (${writeWorkspace?'workspace-write':'read-only'}, unbounded Mission turns, max ${MAX_RELAY_CHAT_TURNS} per chat).\n${writeWorkspace?`Approved source: ${writeWorkspace}\n`:''}PI reviews each complete ChatGPT answer and decides the next action.\nAdditional plain-text instructions are queued for PI. Progress: /status ${m.id}.${ownerGoal?` Goal: /goal-status ${ownerGoal.id}.`:''} Do not resend.`;
    }catch(error){
      try{await session.close();}catch{console.error('PI source preflight cleanup warning');}
      throw error;
    }
  }

  private queuePiOwnerText(text:string,commandId:string,missionId:string|null=this.activeMission):string {
    const id=missionId;
    if(!id)throw new Error('No PI Mission is currently available for owner instructions');
    if(this.store.getMeta(`pi.autopilot.enabled.${id}`)!=='1')
      return this.alreadyRunning(text);
    if(!text||text.length>1500)
      throw new Error('PI instruction must contain 1–1500 characters');
    const accepted=this.store.queuePiOwnerDirective(id,commandId,text);
    // On a verified legacy bounded Goal continuation the Store atomically routes
    // this note to the child, never to the already-exhausted parent.
    let actual=id;
    const visited=new Set<string>();
    while(this.store.piChainSuccessor(actual)){
      if(visited.has(actual)||visited.size>=64)
        throw new Error('PI Mission successor lineage invalid');
      visited.add(actual);
      actual=this.store.piChainSuccessor(actual)!;
    }
    return accepted?`Owner instruction queued for PI Mission ${actual}.\nPI will integrate it before the next ChatGPT Send (a paused Mission requires an active foreground controller).\nProgress: /status ${actual}`
      :`Instruction already queued for PI Mission ${actual}; no duplicate.\nProgress: /status ${actual}`;
  }

  /** One fresh, read-only ChatGPT task per owner message, in the Chrome profile
   * explicitly approved and stored by the LOCAL telegram-anchor command.
   * No model is allowed to choose a browser or create a second Send. */
  private async startFreshChat(task:string,commandId:string):Promise<string> {
    if(this.activeMission)return this.alreadyRunning(task.trim());
    const goal=task.trim();
    const prompt=browserFreshTaskPrompt(goal);
    const anchorId=this.store.getMeta('telegram.chatgpt.anchorMissionId');
    if(!anchorId)throw new Error('No owner-approved ChatGPT anchor; configure telegram-anchor locally first');
    const url=this.store.chatLink(anchorId);
    const browserId=this.store.chatBrowserBinding(anchorId);
    if(!url||!browserId)throw new Error('Configured ChatGPT anchor is missing its exact URL or Chrome binding');
    const session=await this.browserConnector(url,{browserId,bootstrapMissingAnchor:true});
    try{
      const pageState=await inspectChatPage(session.page,url);
      if(!pageState.composerReady||pageState.generating)
        throw new Error('Authorized ChatGPT anchor tab is not idle');
      // This mission is private to the owner and read-only. A duplicate Bot
      // API update reuses its request key, never repeats a browser Send.
      const m=this.engine.create({
        goal,acceptance:['Return a useful, evidence-aware read-only answer to the owner request'],
        workspace:'',sandbox:'read-only',mode:'supervised',maxTurns:1,
        requestKey:`telegram-chat-${commandId}`,checks:[],
      });
      const linked=this.store.linkChat(m.id,url,m.version).mission;
      const bound=this.store.bindChatBrowser(m.id,browserId,linked.version).mission;
      this.activeMission=m.id;
      this.activeTask=executeBrowserRollover({
        store:this.store,missionId:m.id,revision:bound.version,
        requestKey:`telegram-chat-${commandId}-1`,
        sourcePage:session.page,sourceUrl:url,prompt,
        telegramBatch:{lastAuthorizedTurn:true},
      }).then(()=>{}).catch(error=>{
        console.error(`Fresh ChatGPT mission ${m.id}: ${error instanceof Error?error.message:'unknown error'}`);
      }).finally(async()=>{
        try{await session.close();}
        catch{console.error('Playwriter fresh-chat session cleanup warning');}
        finally{this.activeMission=null;this.activeTask=null;}
      });
      return `New ChatGPT Mission ${m.id} accepted (one read-only turn). The controller will open an authorized fresh Chrome tab and return a final notification. Do not resend.`;
    }catch(error){
      try{await session.close();}catch{console.error('Playwriter fresh-chat preflight cleanup warning');}
      throw error;
    }
  }

  /** The native executor is an optional independently installed plugin.
   * Neither the browser-first path nor this channel selects a vendor. */
  private async startAgentTask(task:string,commandId:string):Promise<string> {
    if(this.activeMission)return this.alreadyRunning(task.trim());
    const goal=task.trim();
    if(!goal||goal.length>1500)throw new Error('Agent task must contain 1–1500 characters');
    const workspace=this.store.getMeta('telegram.agent.workspace');
    if(!workspace)throw new Error('No approved native agent workspace; configure telegram-agent-workspace locally');
    const preflight=await this.preflight();
    if(!preflight.ok)throw new Error(preflight.message);
    const m=this.engine.create({goal,
      acceptance:['Provide an evidence-based read-only result in the approved workspace'],
      workspace,sandbox:'read-only',mode:'supervised',maxTurns:1,
      requestKey:`telegram-agent-${commandId}`,checks:[]});
    const execution=this.engine.run(m.id,m.version);
    this.activeMission=m.id;
    this.activeTask=execution.then(()=>{}).catch(error=>{
      console.error(`Native agent Mission ${m.id}: ${error instanceof Error?error.message:'unknown error'}`);
    }).finally(()=>{this.activeMission=null;this.activeTask=null;});
    return `Native Agent Mission ${m.id} accepted (one supervised read-only turn).\n`+
      `Executor plugin is locally configured. Final evidence follows separately.\nStatus: /status ${m.id}`;
  }

  private alreadyRunning(goal:string):string {
    const current=this.engine.get(this.activeMission!);
    const same=current.goal===goal;
    return [
      same?`This task is already active as Mission ${current.id}.`
        :`Another Mission ${current.id} is active; your new task was not started.`,
      'No new execution was submitted. Do not resend.',
      `Progress: /status ${current.id}`,
      'The terminal result will be delivered automatically.',
    ].join('\n');
  }

  private async handle(text:string,commandId='local-test'):Promise<string> {
    const clean=text.trim();
    const [cmd,id,...words]=clean.split(/\s+/);
    if(!cmd) return 'Send /help for available commands.';
    if(cmd==='/help'||cmd==='/start') return id==='advanced'?[
      'Mission Relay — advanced commands (rarely needed)',
      '/history [page] — historical audit; /goals [page] and /goal-status <id> — Goals',
      '/handoff <id> — open linked ChatGPT context; /new <task> — single-turn chat',
      '/auto <task> — alias for plain-text task; /agent <task> — installed native executor',
      '/goal-stage and /goal-stage-build — held Goal creation',
      '/goal-verify, /goal-review, /goal-activate — staged Goal approval',
      '/continue, /resume, /cancel, /instruct — legacy/manual revision-gated actions',
      'Recovery, approvals and secrets remain local CLI operations.',
    ].join('\n'):[
      'Mission Relay — send a task as a normal message.',
      'PI continues until the work is done or blocked; each Chat is limited to 5 Sends.',
      '/build <task> — implement in your approved repository',
      '/goal <objective> — track a persistent goal',
      '/goal-build <objective> — persistent goal with approved code writes',
      '/list — tasks requiring attention',
      '/status <mission-id> — progress and next action',
      '/pause <mission-id> — safely stop further work',
      'While a task runs, send another message to update its instructions.',
      '/help advanced — less common commands',
    ].join('\n');
    if(/^agent\s*[:：]/i.test(clean))
      return this.startAgentTask(clean.replace(/^agent\s*[:：]\s*/i,''),commandId);
    if(/^chatgpt\s*[:：]/i.test(clean))
      return this.startPiChat(clean.replace(/^chatgpt\s*[:：]\s*/i,''),commandId);
    if(cmd==='/goal')return this.startPiChat(clean.slice(5),commandId,false,true);
    if(cmd==='/goal-build')return this.startPiChat(clean.slice(11),commandId,true,true);
    if(cmd==='/goal-stage'||cmd==='/goal-stage-build'){
      const write=cmd==='/goal-stage-build';
      const project=write?this.store.getMeta('telegram.build.project'):null;
      if(write&&(!project||project!==this.store.getMeta('telegram.pi.project')))
        throw new Error('Staged write Goal requires matching locally approved PI/build project');
      const workspace=project?validateRemoteProjectPath(project):'';
      const result=new StagedGoalIntake(this.store).stage({
        ownerId:this.userId,commandId,objective:clean.slice(cmd.length).trim(),workspace,
      });
      return [
        `STAGED Goal ${result.record.goalId} / Mission ${result.record.missionId}`,
        `Checkpoint: ${result.record.checkpointSha256}`,
        `State: ${result.missionState}, ${result.turnCount} turns, ${result.browserReservations} reservations; no PI/Send scheduled.`,
        `Verify: /goal-verify ${result.record.goalId}`,
        `PI review: /goal-review ${result.record.goalId}`,
        'Activation requires a separate owner command and current safety gates.',
      ].join('\n');
    }
    if(cmd==='/goal-verify'||cmd==='/goal-review'){
      if(!id||!/^[0-9a-f-]{36}$/i.test(id)||words.length)
        throw new Error(`Use ${cmd} <complete staged Goal UUID>`);
      const staging=new StagedGoalIntake(this.store);
      const current=staging.verifyReadOnly(id);
      if(current.record.ownerId!==this.userId)
        throw new Error('Staged Goal belongs to another owner');
      const needsReview=cmd==='/goal-review'&&!isFreshStagedApproval(current.review);
      if(needsReview){
        const evidence=await this.stageBaselineProbe(this.store,id,this.piPlanner);
        staging.recordOperationalBaseline(id,this.userId,evidence);
      }
      const result=needsReview
        ?await staging.reviewByPi(id,this.userId,this.piPlanner)
        :staging.verifyReadOnly(id);
      if(result.record.ownerId!==this.userId)
        throw new Error('Staged Goal belongs to another owner');
      return [
        `Goal ${id}; Mission ${result.record.missionId}`,
        `Checkpoint: ${result.record.checkpointSha256}`,
        `Seven-dimensional baseline: ${result.baseline?.baselineSha256??'PENDING'}.`,
        `Independent readback: ${result.unchanged?'MATCH':'CHANGED'}; ${result.missionState}; ${result.turnCount} turns; ${result.browserReservations} reservations; parent ${result.parentId??'none'}.`,
        `PI review: ${result.review?.verdict??'PENDING'}${result.review?` at ${result.review.reviewedAt}`:''}${result.review?.verdict==='APPROVE'&&!isFreshStagedApproval(result.review)?' (EXPIRED; use /goal-review to renew)':''}.`,
        ...(result.review?.inference?[
          `PI actual inference: ${result.review.inference.observedProvider}/${result.review.inference.observedModel}; default invocation flags: model=false, provider=false, thinking=false.`,
          `PI inference envelope SHA-256: ${result.review.inference.responseSha256}; argv SHA-256: ${result.review.inference.argvSha256}.`,
        ]:[]),
        `Activated: ${result.activated?'YES':'NO'}.`,
        ...(isFreshStagedApproval(result.review)?
          [`Owner activation: /goal-activate ${id} ${result.record.checkpointSha256}`]:[]),
      ].join('\n');
    }
    if(cmd==='/goal-activate'){
      if(!id||!/^[0-9a-f-]{36}$/i.test(id)||words.length!==1)
        throw new Error('Use /goal-activate <complete staged Goal UUID> <checkpoint SHA-256>');
      const result=new StagedGoalIntake(this.store).activate(id,this.userId,words[0]!,commandId);
      return `Goal ${id} activated as READY Mission ${result.record.missionId}. Dispatch is controlled by the single existing PI Worker; no browser Send was submitted by activation. Progress: /status ${result.record.missionId}`;
    }
    if(cmd==='/goals'){
      const goals=new GoalLedger(this.store).listGoals();
      const {page,pages,start}=missionPage(id,words,goals.length);
      return goals.length?[
        `Persistent Goals: Page ${page}/${pages} (${goals.length} total; not independent acceptance)`,
        ...goals.slice(start,start+TELEGRAM_MISSION_PAGE_SIZE).map(g=>
          `${g.id.slice(0,8)}… — ${g.status} v${g.version}: ${compactTelegramText(g.objective,100)}\n/goal-status ${g.id}`),
      ].join('\n'):'No Goal records. Existing /auto and /build Missions are not automatically converted.';
    }
    if(cmd==='/goal-status'){
      if(!id||!/^[0-9a-f-]{36}$/i.test(id)||words.length)
        throw new Error('Use /goal-status <complete Goal UUID>');
      const graph=new GoalLedger(this.store).graph(id);
      const approved=graph.plans.find(p=>p.status==='APPROVED');
      const items=approved?graph.items.filter(x=>x.planId===approved.id):[];
      const active=items.find(x=>['IN_PROGRESS','REVIEW'].includes(x.status));
      const verified=items.filter(x=>x.status==='PASSED').length;
      const owner=graph.events.find(e=>e.type==='goal.pi_mission_bound');
      const missionId=typeof owner?.payload.missionId==='string'?owner.payload.missionId:null;
      const lineage=missionId?[missionId,...this.engine.list()
        .filter(m=>m.id!==missionId&&new GoalLedger(this.store).missionGoalId(m.id)===id)
        .map(m=>m.id)]:[];
      const release=new GoalReleaseGate(this.store).report(id);
      return [
        `Goal ${graph.goal.id} [${graph.goal.status}] v${graph.goal.version}`,
        `Objective: ${compactTelegramText(graph.goal.objective,420)}`,
        `Plan: ${approved?`${approved.ordinal} [${approved.status}] v${approved.version}`:'awaiting PI review'}`,
        `Work: ${verified}/${items.length} reported PASSED; ${active?`current ${active.key} [${active.status}] v${active.version}`:'none active'}`,
        `Acceptance: ${graph.acceptance.filter(a=>a.status==='PASS').length}/${graph.acceptance.length} reported PASS (model-reviewed only)`,
        release.complete? `Goal DONE: independently gated at ${release.target?.targetSha.slice(0,12)}`:
          `Release gate: ${release.target?.targetSha.slice(0,12)??'not targeted'}, ${release.checks.filter(c=>c.state==='PASS').length}/${release.checks.length} independently checked; ${release.blockers.length} blockers (not DONE)`,
        ...lineage.slice(-3).map(mid=>`PI Mission: /status ${mid}`),
      ].join('\n');
    }
    if(cmd==='/auto')return this.startPiChat(clean.slice(5),commandId);
    if(cmd==='/build')return this.startPiChat(clean.slice(6),commandId,true);
    if(cmd==='/new')return this.startFreshChat(clean.slice(4),commandId);
    if(!cmd.startsWith('/'))return this.startPiChat(clean,commandId);
    if(cmd==='/agent')return this.startAgentTask(clean.slice(6),commandId);
    if(cmd==='/list') {
      // piHealth is deliberately a bounded diagnostics preview (20 rows),
      // not the authoritative inventory for a paginated Mission inbox.
      const all=this.engine.list().filter(m=>!this.store.isMissionArchived(m.id)&&(
        ['READY','RUNNING','VERIFYING','BLOCKED','NEEDS_RECONCILIATION'].includes(m.state)||
        (this.store.getMeta(`pi.autopilot.enabled.${m.id}`)==='1'&&m.state==='PAUSED'&&
          !m.stopRequested&&(!!m.lastError||
          (missionTurnsRemaining(m.maxTurns,m.turnCount)&&
            (!this.store.piPlan(m.id)||['NEXT','HANDOFF'].includes(this.store.piPlan(m.id)!.action)))))||
        this.store.chatBrowserTurn(m.id)?.status==='uncertain'));
      // An old ambiguous Send must not disappear below newer, ordinary READY
      // tasks. All entries remain accessible through bounded, read-only pages.
      const priority=(m:Mission)=>m.state==='NEEDS_RECONCILIATION'||
        this.store.chatBrowserTurn(m.id)?.status==='uncertain'?0:
        m.state==='RUNNING'||m.state==='VERIFYING'?1:
        m.state==='BLOCKED'?2:m.state==='READY'?3:4;
      all.sort((a,b)=>priority(a)-priority(b));
      const {page,pages,start}=missionPage(id,words,all.length);
      return all.length?[`Missions requiring attention: Page ${page}/${pages} (${all.length} total)`,
        ...all.slice(start,start+TELEGRAM_MISSION_PAGE_SIZE).map(m=>
        `${m.id.slice(0,8)}… — ${m.state} v${m.version}, ${formatMissionTurns(m.turnCount,m.maxTurns)}\n/status ${m.id}`),
        'Full Mission audit history: /history'].join('\n'):
        'No active or unresolved Missions. Historical records: /history';
    }
    if(cmd==='/history'){
      const all=this.engine.list();
      const {page,pages,start}=missionPage(id,words,all.length);
      return all.length?[`Recent Mission history: Page ${page}/${pages} (${all.length} total; not evidence of business completion)`,
        ...all.slice(start,start+TELEGRAM_MISSION_PAGE_SIZE).map(m=>
          `${m.id.slice(0,8)}… — ${m.state} v${m.version}${this.store.isMissionArchived(m.id)?' (archived)':''}\n/status ${m.id}`)
      ].join('\n'):'No history yet.';
    }
    if(!['/status','/handoff','/pause','/resume','/cancel','/instruct','/continue'].includes(cmd))
      throw new Error('Unknown command. Send /help. Native agents use /agent, not a vendor-specific command.');
    if(!id || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Provide a complete mission UUID');
    const m=this.engine.get(id);
    if(cmd==='/status') {
      const piLive=this.store.getMeta(`pi.autopilot.enabled.${id}`)==='1'
        ?this.store.piHealth().missions.find(item=>item.id===id):undefined;
      return [`${m.id} [${m.state}] v${m.version}`,`Turn ${formatMissionTurns(m.turnCount,m.maxTurns)}`,
      `Mode: ${m.sandbox}${m.sandbox==='workspace-write'&&m.workspace?` (${m.workspace})`:''}`,
      `Goal: ${m.goal.slice(0,400)}`,
      ...(new GoalLedger(this.store).missionGoalId(m.id)
        ?[`Persistent Goal: /goal-status ${new GoalLedger(this.store).missionGoalId(m.id)} (not automatically DONE)`]:[]),
      ...(this.store.getMeta(`pi.autopilot.enabled.${id}`)==='1'
        ?[`PI coordinator: ${this.store.piPlan(id)?.action??'analyzing / awaiting the first answer'}`,
          `Pending owner instructions: ${this.store.pendingPiOwnerDirectives(id).length}`]:[]),
      ...(piLive?[`Current Chat observed sends: ${piLive.currentChatObservedTurns}/${MAX_RELAY_CHAT_TURNS}`,
        `Controller phase: ${piLive.phase}`,
        ...(piLive.browserNewChatReserved
          ?['New Chat: reserved only (Send, new URL and answer not yet verified)']:[]),
        ...(piLive.browserReservationAgeSeconds!==null
          ?[`Current browser request age: ${piLive.browserReservationAgeSeconds}s (not proof of a stall; do not resend)`]:[])]:[]),
      ...(this.store.piChainParent(id)?[`Previous Mission: ${this.store.piChainParent(id)}`]:[]),
      ...(this.store.piChainSuccessor(id)?[`Continued as: ${this.store.piChainSuccessor(id)}`]:[]),
      ...(m.lastError?[`Last controller error: ${compactTelegramText(m.lastError,250)}`]:[]),
      `Last summary: ${(m.lastSummary ?? 'none').slice(0,1000)}`].join('\n');
    }
    if(cmd==='/handoff') {
      if(words.length) throw new Error('Use /handoff <mission-id>');
      const url=this.store.chatLink(id);
      if(!url) throw new Error('No ChatGPT conversation linked; use the local link-chat CLI first');
      return renderChatGPTHandoff(m,url);
    }
    // A safety stop must not fail because executor progress increments the revision.
    if(cmd==='/pause') {
      if(words.length) throw new Error('Use /pause <mission-id> without a revision');
      if(this.store.getMeta(`pi.autopilot.enabled.${id}`)==='1'){
        this.store.pausePiChain(id);
        return 'PI chain pause recorded. No further browser Send will be submitted after any in-flight response is reconciled.';
      }
      return `Pause recorded: ${this.engine.pause(id).state}`;
    }
    const revision=words.shift();
    if(!revision || !/^v(0|[1-9]\d*)$/.test(revision) || !Number.isSafeInteger(Number(revision.slice(1))))
      throw new Error('Expected v<revision> from a fresh /status command (for example v3)');
    const expectedVersion=Number(revision.slice(1));
    if(m.version!==expectedVersion) throw new Error(`State conflict: expected v${expectedVersion}, current v${m.version}; run /status again`);
    if(cmd!=='/instruct' && words.length) throw new Error('Unexpected command arguments');
    if(cmd==='/resume') {
      if(m.sandbox!=='read-only') throw new Error('Remote resume of workspace-write missions is disabled; use the local CLI');
      if(this.store.getMeta(`pi.autopilot.enabled.${id}`)==='1')
        throw new Error('PI automated recovery after restart requires exact browser receipt reconciliation; do not use native resume');
      return `Mission is now ${this.engine.resume(id,expectedVersion).state}; use /status then /continue to run.`;
    }
    if(cmd==='/cancel') return `Mission is now ${this.engine.cancel(id,expectedVersion).state}`;
    if(cmd==='/instruct') {
      const instruction=words.join(' ').trim();
      if(!instruction || instruction.length>1500) throw new Error('Instruction must contain 1–1500 characters');
      if(this.store.getMeta(`pi.autopilot.enabled.${id}`)==='1'){
        if(id!==this.activeMission&&this.store.chatAdoption(id)===null&&
          !(m.state==='READY'&&this.store.piChainParent(id)))
          throw new Error('PI Mission is not currently active; no instruction was queued');
        return this.queuePiOwnerText(instruction,commandId,id);
      }
      if(m.sandbox!=='read-only') throw new Error('Remote instructions for native workspace-write missions are disabled; use the local CLI');
      return `Instruction saved (state ${this.engine.instruct(id,instruction,expectedVersion).state}).`;
    }
    if(cmd==='/continue') {
      if(this.store.getMeta(`pi.autopilot.enabled.${id}`)==='1')
        throw new Error('PI-owned Mission cannot be continued through the legacy ChatGPT driver; inspect PI checkpoint first');
      if(this.activeMission) throw new Error(`Mission ${this.activeMission} already running in this bridge`);
      if(m.sandbox!=='read-only') throw new Error('Remote execution of workspace-write missions is disabled; use the local CLI');
      if(!['READY','PAUSED'].includes(m.state)) throw new Error(`Mission ${id} is ${m.state}; inspect/reconcile before continuing`);
      const linkedUrl=this.store.chatLink(id);
      if(linkedUrl) {
        const bound=this.store.chatBrowserBinding(id);
        if(!bound) throw new Error('ChatGPT Mission has no pinned Chrome profile; bind one locally with browser-list and browser-bind before remote continuation');
        const session=await this.browserConnector(linkedUrl,{browserId:bound});
        try {
          const pageState=await inspectChatPage(session.page,linkedUrl);
          if(!pageState.composerReady||pageState.generating)
            throw new Error('ChatGPT target tab is not ready for a new message');
          if(this.store.get(id).version!==expectedVersion) throw new Error('Mission revision changed during browser preflight');
          this.activeMission=id;
          this.activeTask=driveChatConversation({
            store:this.store,missionId:id,revision:expectedVersion,
            requestPrefix:`telegram-${commandId}`,turns:3,page:session.page,url:linkedUrl,
            notificationMode:'telegram-final',
          }).then(()=>{}).catch(error=>{
            console.error(`ChatGPT browser mission ${id}: ${error instanceof Error?error.message:'unknown error'}`);
          }).finally(async()=>{
            try{await session.close();}
            catch(error){console.error(`Playwriter session cleanup: ${error instanceof Error?error.message:'unknown error'}`);}
            finally{this.activeMission=null;this.activeTask=null;}
          });
          return `Mission ${id} accepted for a bounded ChatGPT browser attempt (up to 3 turns). Check /status for observed results. This is not a completion confirmation.`;
        } catch(error) {
          // Relay loss during cleanup must not hide the original failed preflight.
          try{await session.close();}
          catch{console.error('Playwriter session cleanup warning: relay connection unavailable');}
          throw error;
        }
      }
      const preflight=await this.preflight(id);
      if(!preflight.ok) throw new Error(preflight.message);
      // Preflight is async; reject commands made stale by another local operator.
      if(this.engine.get(id).version!==expectedVersion) throw new Error('Mission revision changed during preflight; run /status again');
      const readyVersion=m.state==='PAUSED' ? this.engine.resume(id,expectedVersion).version : expectedVersion;
      // This claim throws synchronously if a local command won the revision race.
      // Do not send an acceptance reply until the mission is actually claimed.
      const task=this.engine.run(id,readyVersion);
      this.activeMission=id;
      // The durable event notification is the sole terminal-status signal.
      // Avoid sending a second, non-durable COMPLETED message from this promise.
      this.activeTask=task.then(()=>{}).catch(err=>{
        console.error(`Mission ${id} controller error: ${err instanceof Error?err.message:'unknown error'}`);
      }).finally(()=>{this.activeMission=null;this.activeTask=null;});
      return `Mission ${id} accepted for execution. This is not a completion confirmation.`;
    }
    throw new Error('Unknown command. Send /help.');
  }
}
