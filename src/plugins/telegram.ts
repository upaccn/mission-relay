import {MAX_RELAY_CHAT_TURNS} from '../core/chat-limits.js';
import {missionTurnsRemaining,missionTurnLimitReached} from '../core/mission-turns.js';
import type { PluginManifest } from '../core/plugins.js';
import {createHash} from 'node:crypto';
import { Engine } from '../core/engine.js';
import { Store,PI_SUCCESSOR_CHECKPOINT_MISMATCH } from '../core/store.js';
import type {PreflightResult} from '../core/executor-plugins.js';
import { renderChatGPTHandoff } from '../core/chatgpt-handoff.js';
import {connectChatPage,inspectChatPage,lastVisibleUserPromptSha256,listConnectedChatCandidates,
  clickDeliveryRetryOnce,visibleLongTaskBanner,type BrowserSession} from './chatgpt-browser.js';
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
import {isApprovedBuildRepository} from '../core/build-scopes.js';
import {telegramChatAnchor} from '../core/chat-anchor.js';
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
  if(reply.startsWith('Tasks: Page ')||reply.startsWith('History: Page ')){
    const section=reply.startsWith('History:')?'history':'list';
    const paging=reply.match(/: Page (\d+)\/(\d+)\b/);
    const page=paging?Number(paging[1]):1,pages=paging?Number(paging[2]):1;
    return {inline_keyboard:[
      ...(section==='list'?[...reply.matchAll(/^([1-9]\d*)\. /gm)].slice(0,3)
        .map(m=>[{text:`View task ${m[1]}`,callback_data:`mr:status-index:${m[1]}`}]) : []),
      ...(page>1?[[{text:'Previous page',callback_data:`mr:${section}:${page-1}`}]]:[]),
      ...(page<pages?[[{text:'Next page',callback_data:`mr:${section}:${page+1}`}]]:[]),
      [{text:'Refresh tasks',callback_data:'mr:list'},{text:'History',callback_data:'mr:history'}],
    ]};
  }
  if(reply.startsWith('Task status:'))return {inline_keyboard:[
    [{text:'Refresh status',callback_data:'mr:status'}],
    [{text:'Tasks',callback_data:'mr:list'},{text:'History',callback_data:'mr:history'}],
  ]};
  const detail=reply.match(/^([0-9a-f-]{36}) \[/i);
  if(detail)return {inline_keyboard:[
    [{text:'Refresh status',callback_data:`mr:status:${detail[1]}`}],
    [{text:'Tasks',callback_data:'mr:list'}],
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
  if(data==='mr:status')return '/status';
  const index=data.match(/^mr:status-index:([1-9]\d*)$/);
  if(index&&Number.isSafeInteger(Number(index[1])))return `/status ${index[1]}`;
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
/** Telegram is not end-to-end encrypted. Treat all model summaries and
 * verifier evidence as untrusted, potentially secret-bearing display text. */
function redactTelegramText(value:string):string {
  return value.replace(/\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{22,}/g,'[REDACTED]')
    .replace(/\b(?:ghp_|gho_|ghu_|ghs_|github_pat_)[A-Za-z0-9_]{18,}/g,'[REDACTED]')
    .replace(/\b\d{7,11}:[A-Za-z0-9_-]{30,}\b/g,'[REDACTED]')
    .replace(/https?:\/\/[^\s]*[#?][^\s]*/gi,'[PRIVATE LINK]');
}
function compactTelegramText(value:string,maxLength:number):string {
  const cleaned=redactTelegramText(value.replace(/\s+/g,' ').trim())
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,'[internal reference]');
  return cleaned.length<=maxLength?cleaned:`${cleaned.slice(0,maxLength-1)}…`;
}
function taskTitle(m:Mission,max=85):string{
  return compactTelegramText(m.goal,max);
}
function taskState(m:Mission):string {
  if(m.stopRequested)return 'Paused';
  if(m.state==='COMPLETED')return 'Completed';
  if(m.state==='NEEDS_RECONCILIATION')return 'Needs attention';
  if(m.state==='BLOCKED')return 'Blocked — action required';
  if(m.state==='RUNNING'||m.state==='VERIFYING')return 'Working';
  if(m.state==='READY')return 'Queued';
  const plan=m.state==='PAUSED'?m.lastError:null;
  return plan?'Needs attention':'Paused / reviewing';
}

/** A native executor Mission must surface the verified outcome, not just an
 * opaque status code. Verifier conclusions are separate model judgment, not
 * independently proven real-world facts or deterministic checks. */
export function formatNativeMissionNotification(m:Mission,event:MissionEvent):string {
  const base=[event.type==='verification.accepted'?'All Done — Task completed':
    `Task update — ${taskState(m)}`,
    taskTitle(m)];
  if(event.type==='verification.accepted') {
    const payload=event.payload && typeof event.payload==='object'
      ? event.payload as {reason?:unknown;evidence?:unknown}: {};
    const evidence=Array.isArray(payload.evidence)?payload.evidence
      .filter((x):x is string=>typeof x==='string').slice(0,3):[];
    return [
      ...base,
      `Summary: ${compactTelegramText(m.lastSummary??'No summary available',450)}`,
      ...evidence.map((x,i)=>`Check ${i+1}: ${compactTelegramText(x,235)}`),
      'Review: model verifier accepted; external outcomes may need separate checks.',
      'Details: /status',
    ].join('\n').slice(0,2900);
  }
  return [...base,'Details: /status'].join('\n');
}

export function formatPiNotification(m:Mission,event:MissionEvent):string {
  const payload=event.payload && typeof event.payload==='object'
    ?event.payload as {summary?:unknown;action?:unknown;reason?:unknown}:{};
  const action=event.type==='pi.autopilot_interrupted'?'INTERRUPTED':
    typeof payload.action==='string'?payload.action:'UNKNOWN';
  const summary=typeof payload.summary==='string'?payload.summary:
    typeof payload.reason==='string'?payload.reason:'No PI decision summary';
  const complete=action==='DONE';
  const label=complete?'All Done — Task finished':
    action==='LIMIT'?'Continuing — Moving to the next stage':
    action==='BLOCKED'||action==='INTERRUPTED'?'Needs attention — Task paused':
    'Task update';
  return [label,
    taskTitle(m),
    `Rounds completed: ${m.turnCount}`,
    `Summary: ${compactTelegramText(summary,850)}`,
    complete?'PI review finished. Independent release or external acceptance is separate.':
      action==='BLOCKED'||action==='INTERRUPTED'?
        'No new ChatGPT message will be sent until the issue is resolved.':'',
    'Details: /status'].filter(Boolean).join('\n').slice(0,1600);
}
function formatPiProgress(m:Mission,event:MissionEvent):string {
  const payload=event.payload && typeof event.payload==='object'
    ?event.payload as {action?:unknown;round?:unknown;summary?:unknown}:{};
  return [`Progress — ${typeof payload.round==='number'?payload.round:m.turnCount} rounds completed`,
    taskTitle(m),
    compactTelegramText(typeof payload.summary==='string'?payload.summary:'',520),
    'Still working. No action needed; send /status for the latest update.'
  ].join('\n').slice(0,1250);
}

/** Telegram is not end-to-end encrypted: only send a bounded tail of the
 * browser response, never complete tool logs, screenshots or browser secrets. */
export function formatBrowserResultNotification(m:Mission,event:MissionEvent):string {
  const data=(event.payload && typeof event.payload==='object')
    ?event.payload as {excerpt?:unknown;round?:unknown;reason?:unknown;flowSignal?:unknown}:{};
  if(event.type==='chatgpt.browser_uncertain')
    return ['Needs attention — ChatGPT response unconfirmed',
      `Round: ${typeof data.round==='number'?data.round:m.turnCount}`,
      'The original request is protected; it will not be sent again automatically.',
      'Details: /status'].join('\n');
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
    .map(x=>compactTelegramText(x,190));
  // Redact recognizable credential formats if a model accidentally quotes one.
  const round=typeof data.round==='number'?data.round:m.turnCount;
  const finished=event.type==='chatgpt.browser_run_finished'&&
    (data.flowSignal==='DONE'||finalMarker==='[MISSION_RELAY:DONE]');
  const text=[finished?'All Done — ChatGPT task finished (model-reported)':
    `ChatGPT update — Round ${round}`,
    'Summary (not independently verified):',
    ...lines.map(redactTelegramText),
    ...(finalMarker?[`Next step: ${finalMarker.includes('BLOCKED')?'Needs attention':finalMarker.includes('DONE')?'Review complete':'Continuing'}`]:[]),
    'Details: /status'];
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
  private lastDeliveryRetryRecoveryAt=0;
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
        await this.recoverUncertainDeliveryOnce();
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
            await this.recoverUncertainDeliveryOnce();
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

  /** One leased Worker may inspect a timed-out ORIGINAL Send. The only
   * permitted external action is one already-submitted-message UI Retry.
   * A durable intent, recorded BEFORE the click, prevents replay after crash.
   * The old request remains uncertain until the same exact tab yields a
   * stable, final-marked reply; then the usual PI checkpoint path resumes. */
  async recoverUncertainDeliveryOnce():Promise<void> {
    if(this.activeMission||this.activeTask||this.store.channelDrainRequested(this.source))return;
    if(Date.now()-this.lastDeliveryRetryRecoveryAt<60_000)return;
    this.lastDeliveryRetryRecoveryAt=Date.now();
    const candidate=this.engine.list().find(m=>{
      const r=this.store.chatBrowserTurn(m.id);
      return m.state==='NEEDS_RECONCILIATION'&&!m.stopRequested&&
        m.lastError==='ChatGPT response observation timed out; submission outcome is ambiguous'&&
        r?.status==='uncertain'&&r.newConversation!==true&&
        this.store.getMeta(`pi.autopilot.enabled.${m.id}`)==='1';
    });
    if(!candidate)return;
    const r=this.store.chatBrowserTurn(candidate.id)!;
    const url=this.store.chatLink(candidate.id),browserId=this.store.chatBrowserBinding(candidate.id);
    if(!url||!browserId)return;
    let session:BrowserSession|undefined;
    try {
      session=await withReadOnlyDeadline(this.browserConnector(url,{browserId}),30_000,
        late=>late.close());
      const page=session.page;
      const snapshot=await withReadOnlyDeadline(inspectChatPage(page,url));
      if(!snapshot.composerReady||
        await withReadOnlyDeadline(lastVisibleUserPromptSha256(page))!==r.promptSha256)return;
      const already=this.store.hasDeliveryRetryIntent(candidate.id,r.requestKey,r.promptSha256);
      const banner=await withReadOnlyDeadline(visibleLongTaskBanner(page,snapshot.lastAssistant));
      if(!already && !snapshot.generating &&
        (banner==='delivery-timeout'||banner==='stream-error')) {
        const clicked=await clickDeliveryRetryOnce(page,url,true,false,
          async(reason)=>{
            if(await lastVisibleUserPromptSha256(page)!==r.promptSha256)return false;
            return this.store.claimDeliveryRetryIntent(candidate.id,r.requestKey,r.promptSha256,reason);
          });
        if(clicked){
          this.store.recordDeliveryRetryClicked(candidate.id,r.requestKey,r.promptSha256);
          console.warn('Recovered timed-out ChatGPT delivery/stream by one existing-message UI Retry (no composer Send)');
        }
        return;
      }
      if(!already||snapshot.generating||banner!==null||
        !/(?:^|\n)\[MISSION_RELAY:(?:NEXT|DONE|BLOCKED|HANDOFF)\]\s*$/.test(snapshot.lastAssistant.trim()))
        return;
      // Never credit a stale earlier answer, a mid-stream UI refresh, or a
      // different owner's message. The Store also checks the original lock,
      // unique request, assistant SHA, and previous observed answer.
      await new Promise(resolve=>setTimeout(resolve,3000));
      const stable=await withReadOnlyDeadline(inspectChatPage(page,url));
      if(stable.generating||!stable.composerReady||
        stable.lastAssistant!==snapshot.lastAssistant||
        await withReadOnlyDeadline(lastVisibleUserPromptSha256(page))!==r.promptSha256||
        await withReadOnlyDeadline(visibleLongTaskBanner(page,stable.lastAssistant))!==null)return;
      const assistantSha256=createHash('sha256').update(stable.lastAssistant).digest('hex');
      this.store.recoverObservedBrowserTurn(candidate.id,candidate.version,{
        requestPromptSha256:r.promptSha256,assistantSha256,summary:stable.lastAssistant});
      console.warn('Independently recovered the original timed-out ChatGPT answer; PI must review before next Send');
    }catch(error) {
      // No change to original uncertainty on a missing tab/DOM/reconnect.
      // A consumed click intent is never erased or blindly repeated.
      console.error(`Delivery Retry recovery ${candidate.id}: ${error instanceof Error?error.message:'read failed'}`);
    }finally{
      if(session)try{await session.close();}catch{/* Preserve original state. */}
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
    // Never switch browsers while ANY original Send remains unaccounted for,
    // including a paused or uncertain owner. Queue intake remains permitted.
    if(this.engine.list().some(m=>{
      const status=this.store.chatBrowserTurn(m.id)?.status;
      return status==='reserved'||status==='uncertain';
    }))return;
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
    candidates.sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));
    // Durable round-robin cursor: restart may reconsider a settled checkpoint,
    // but never alters a previously reserved external request's identity.
    const last=this.store.getMeta('pi.scheduler.lastMission');
    const pivot=candidates.findIndex(m=>m.id===last);
    const m=candidates[(pivot+1)%candidates.length]!;
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
      this.store.setMeta('pi.scheduler.lastMission',m.id);
      this.activeMission=m.id;
      const held=session;session=undefined;
      this.activeTask=drivePiAutopilot({
        store:this.store,planner:this.piPlanner,missionId:m.id,
        revision:m.version,requestPrefix:m.requestKey,
        yieldAtGoalCheckpoint:true,
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
            missionTurnLimitReached(this.store.get(event.missionId).maxTurns,Number((event.payload as {round?:unknown})?.round))||
            (Number((event.payload as {round?:unknown})?.round)!==1&&
              Number((event.payload as {round?:unknown})?.round)%5!==0))){
          cursor=event.id;
          this.store.setMeta('telegram.notifications_cursor',String(cursor));
          continue;
        }
        const successor=event.type==='pi.autopilot_finished'
          ?this.store.piChainSuccessor(event.missionId):null;
        const body=successor&&
          (event.payload as {action?:unknown})?.action==='LIMIT'
          ?`Continuing — Next stage\n${taskTitle(this.store.get(event.missionId))}\nPrevious stage finished; the overall task is still running.\nDetails: /status`
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
  /** Goal intake never opens Chrome and never waits for another Goal to finish.
   * Initial browser/PI preflight is performed later by the ONE leased worker. */
  private enqueueGoal(task:string,commandId:string,write:boolean):string {
    const specified=write?/^--repo\s+(\S+)\s+([\s\S]+)$/.exec(task.trim()):null;
    if(write&&task.trim().startsWith('--repo')&&!specified)
      throw new Error('Use /goal-build --repo /approved/absolute/path <objective>');
    const objective=(specified?specified[2]!:task).trim();
    const project=write?(specified?validateRemoteProjectPath(specified[1]!):
      this.store.getMeta('telegram.build.project')):null;
    if(write&&(!project||!isApprovedBuildRepository(this.store,project)))
      throw new Error('Write-enabled Goal needs a locally approved repository; use telegram-build-project --allow <path>');
    browserFreshTaskPrompt(objective,project);
    const anchor=telegramChatAnchor(this.store);
    if(!anchor)throw new Error('No approved ChatGPT profile; configure telegram-anchor locally');
    if(this.piPlanner instanceof SshPiPlanner&&!this.store.getMeta('telegram.pi.sshHost'))
      throw new Error('PI coordinator not configured; use telegram-pi-config locally');
    const created=this.store.atomic(()=>{
      if(this.store.channelDrainRequested(this.source))
        throw new Error('Telegram maintenance drain active; no Goal was accepted');
      if(project&&!isApprovedBuildRepository(this.store,project))
        throw new Error('Approved build repository was revoked during Goal intake');
      const key=`telegram-goal-${commandId}`;
      const previous=this.engine.list().find(m=>m.requestKey===key);
      if(previous){
        if(previous.goal!==objective||previous.workspace!==(project??'')||
          previous.sandbox!==(project?'workspace-write':'read-only')||
          !new GoalLedger(this.store).missionGoalId(previous.id))
          throw new Error('Goal idempotency key was reused with a different scope');
        // A duplicate command must never relink a now-running conversation
        // to the original launch anchor or change its approved repository.
        return {mission:previous};
      }
      const m=this.engine.create({
        goal:objective,acceptance:[project?
          'Implement within the individually approved repository; verify tests, Git and CI before completion':
          'Substantively answer the owner Goal with read-only evidence'],
        workspace:project??'',sandbox:project?'workspace-write':'read-only',
        mode:'supervised',maxTurns:0,requestKey:key,checks:[],
      });
      const linked=this.store.linkChat(m.id,anchor.url,m.version).mission;
      const bound=this.store.chatBrowserBinding(m.id)
        ?linked:this.store.bindChatBrowser(m.id,anchor.browserId,linked.version).mission;
      if(this.store.chatBrowserBinding(bound.id)!==anchor.browserId)
        throw new Error('Original Goal browser binding changed; refusing reassignment');
      this.store.setMeta(`pi.autopilot.enabled.${m.id}`,'1');
      const ledger=new GoalLedger(this.store);
      const goal=ledger.createGoal({requestKey:key,objective,priority:50});
      const existing=ledger.missionGoalId(m.id);
      if(existing&&existing!==goal.id)
        throw new Error('Original request key already belongs to a different Goal');
      if(!existing)ledger.bindPiMission(goal.id,m.id,bound.version,`initial-${commandId}`);
      return {mission:bound};
    });
    return [
      this.activeMission?'Task queued — the current request will not be interrupted.':
        'Task accepted — awaiting the single Worker.',
      taskTitle(created.mission),
      project?'Write scope: individually approved repository.':'Read-only Goal.',
      'Progress: /list or /status. Each Goal keeps its own ChatGPT conversation.',
    ].join('\n');
  }

  private async startPiChat(task:string,commandId:string,write=false,goalDriven=false):Promise<string> {
    // Preserve the established first-Goal launch path. A second Goal is
    // always independent, even if the first is PAUSED or its Send is uncertain.
    // The leased run() loop, not an arbitrary pollOnce caller, schedules the
    // queued Goal at a safe checkpoint.
    const otherActive=goalDriven&&this.engine.list().some(m=>{
      if(this.store.getMeta(`pi.autopilot.enabled.${m.id}`)!=='1')return false;
      const status=this.store.chatBrowserTurn(m.id)?.status;
      if(status==='reserved'||status==='uncertain')return true;
      if(m.stopRequested)return false;
      if(['READY','RUNNING','VERIFYING','NEEDS_RECONCILIATION'].includes(m.state))return true;
      return m.state==='PAUSED'&&!this.store.events(m.id).some(e=>
        e.type==='pi.autopilot_finished'&&
        ['DONE','BLOCKED'].includes(String((e.payload as {action?:unknown}).action)));
    });
    const alreadyEnrolled=goalDriven&&this.engine.list().some(m=>
      m.requestKey===`telegram-goal-${commandId}`);
    if(goalDriven&&(this.activeMission||otherActive||alreadyEnrolled||
      task.trim().startsWith('--repo')))
      return this.enqueueGoal(task,commandId,write);
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
    const anchor=telegramChatAnchor(this.store);
    if(!anchor)throw new Error('No approved ChatGPT profile; configure telegram-anchor locally');
    const {url,browserId}=anchor;
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
      if(goalDriven)this.store.setMeta('pi.scheduler.lastMission',m.id);
      this.activeMission=m.id;
      this.activeTask=drivePiAutopilot({
        store:this.store,planner:this.piPlanner,missionId:m.id,
        revision:bound.version,
        yieldAtGoalCheckpoint:goalDriven,
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
      return [
        `Task started — ${writeWorkspace?'approved repository work':'research and analysis'}.`,
        taskTitle(m),
        ownerGoal?'Long-term goal tracking is enabled.':'Planning and review are automatic.',
        'Progress will arrive here. Use /status for an update or /pause to stop.',
        'Send a new message to refine this task. Do not repeat the original request.',
      ].join('\n');
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
    return accepted?'Instruction saved. It will be considered before the next step.\nProgress: /status'
      :'This instruction was already saved; it was not added again.\nProgress: /status';
  }

  /** One fresh, read-only ChatGPT task per owner message, in the Chrome profile
   * explicitly approved and stored by the LOCAL telegram-anchor command.
   * No model is allowed to choose a browser or create a second Send. */
  private async startFreshChat(task:string,commandId:string):Promise<string> {
    if(this.activeMission)return this.alreadyRunning(task.trim());
    const goal=task.trim();
    const prompt=browserFreshTaskPrompt(goal);
    const anchor=telegramChatAnchor(this.store);
    if(!anchor)throw new Error('No owner-approved ChatGPT profile; configure telegram-anchor locally first');
    const {url,browserId}=anchor;
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
      return 'New ChatGPT task started. A result will appear here when finished.\nProgress: /status';
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
    return 'Task started. The final result will appear here when verified.\nProgress: /status';
  }

  private alreadyRunning(goal:string):string {
    const current=this.engine.get(this.activeMission!);
    const same=current.goal===goal;
    return [
      same?'This task is already running.':'A task is already running; your new task was not started.',
      'No new execution was submitted. Do not resend.',
      'Progress: /status',
      'The terminal result will be delivered automatically.',
    ].join('\n');
  }

  /** An actionable inbox, independent of the bounded diagnostic preview.
   * User-visible numbers are only view selectors, never persistent IDs. */
  private inboxMissions():Mission[] {
    const all=this.engine.list().filter(m=>!this.store.isMissionArchived(m.id)&&(
      ['READY','RUNNING','VERIFYING','BLOCKED','NEEDS_RECONCILIATION'].includes(m.state)||
      (new GoalLedger(this.store).missionGoalId(m.id)!==null&&
        this.store.events(m.id).some(e=>e.type==='pi.autopilot_finished'&&
          (e.payload as {action?:unknown}).action==='DONE'))||
      (this.store.getMeta(`pi.autopilot.enabled.${m.id}`)==='1'&&m.state==='PAUSED'&&
        !m.stopRequested&&(!!m.lastError||
        (missionTurnsRemaining(m.maxTurns,m.turnCount)&&
          (!this.store.piPlan(m.id)||['NEXT','HANDOFF'].includes(this.store.piPlan(m.id)!.action)))))||
      this.store.chatBrowserTurn(m.id)?.status==='uncertain'));
    const priority=(m:Mission)=>m.state==='NEEDS_RECONCILIATION'||
      this.store.chatBrowserTurn(m.id)?.status==='uncertain'?0:
      m.state==='RUNNING'||m.state==='VERIFYING'?1:
      m.state==='BLOCKED'?2:m.state==='READY'?3:4;
    return all.sort((a,b)=>priority(a)-priority(b));
  }
  private taskDisplayState(m:Mission):string {
    if(m.stopRequested)return 'Paused';
    if(this.store.events(m.id).some(e=>e.type==='pi.autopilot_finished'&&
      (e.payload as {action?:unknown}).action==='DONE'))return 'Completed (PI review)';
    if(m.id===this.activeMission)return 'Running';
    if(m.state==='READY')return 'Queued';
    if(m.state==='PAUSED'&&!m.lastError&&
      ['NEXT','HANDOFF'].includes(this.store.piPlan(m.id)?.action??''))
      return 'Queued — checkpoint ready';
    return taskState(m);
  }

  private async handle(text:string,commandId='local-test'):Promise<string> {
    const clean=text.trim();
    const [cmd,explicitId,...words]=clean.split(/\s+/);
    let id=explicitId;
    if(!cmd) return 'Send /help for available commands.';
    if(cmd==='/help'||cmd==='/start') return id==='advanced'?[
      'Mission Relay — advanced commands (rarely needed)',
      '/history [page] — historical audit; /goals [page] and /goal-status <id> — Goals',
      '/handoff <id> — open linked ChatGPT context; /new <task> — single-turn chat',
      '/auto <task> — alias for plain-text task; /agent <task> — installed native executor',
      '/continue, /resume, /cancel, /instruct — legacy/manual revision-gated actions',
      'Recovery, approvals and secrets remain local CLI operations.',
    ].join('\n'):[
      'Mission Relay — send a task as a normal message.',
      'The assistant continues until finished or blocked; each Chat allows 10 messages.',
      '/build <task> — implement in your approved repository',
      '/goal <objective> — track a persistent goal',
      '/goal-build [--repo /approved/path] <objective> — independent write-enabled Goal',
      '/list — tasks requiring attention',
      '/status — current task (or /status 2 after /list)',
      '/pause — stop the current task',
      '/pause 2 — stop a particular Goal from /list',
      'New /goal-build commands are queued independently; plain text updates the current task.',
      '/help advanced — less common commands',
    ].join('\n');
    if(/^agent\s*[:：]/i.test(clean))
      return this.startAgentTask(clean.replace(/^agent\s*[:：]\s*/i,''),commandId);
    if(/^chatgpt\s*[:：]/i.test(clean))
      return this.startPiChat(clean.replace(/^chatgpt\s*[:：]\s*/i,''),commandId);
    if(cmd==='/goal')return this.startPiChat(clean.slice(5),commandId,false,true);
    if(cmd==='/goal-build')return this.startPiChat(clean.slice(11),commandId,true,true);
    if(cmd==='/goals'){
      const ledger=new GoalLedger(this.store),goals=ledger.listGoals();
      const {page,pages,start}=missionPage(id,words,goals.length);
      return goals.length?[
        `Goals: Page ${page}/${pages} (${goals.length} total)`,
        ...goals.slice(start,start+TELEGRAM_MISSION_PAGE_SIZE).map((g,i)=>{
          const m=this.engine.list().find(x=>ledger.missionGoalId(x.id)===g.id);
          const state=g.status==='DONE'?'Completed':
            m?this.taskDisplayState(m):g.status==='BLOCKED'?'Needs attention':'Queued';
          return `${start+i+1}. ${compactTelegramText(g.objective,100)} — ${state}`;
        }),
        'Use /goal-status for the latest goal.'
      ].join('\n'):'No tracked goals. Send /goal <objective> to begin.';
    }
    if(cmd==='/goal-status'){
      if(words.length)throw new Error('Use /goal-status (or /goal-status <id> in advanced mode)');
      id=id??new GoalLedger(this.store).listGoals()[0]?.id;
      if(!id)return 'No tracked goals yet.';
      if(!/^[0-9a-f-]{36}$/i.test(id))
        throw new Error('Use /goal-status or a complete internal Goal reference');
      const graph=new GoalLedger(this.store).graph(id);
      const approved=graph.plans.find(p=>p.status==='APPROVED');
      const items=approved?graph.items.filter(x=>x.planId===approved.id):[];
      const active=items.find(x=>['IN_PROGRESS','REVIEW'].includes(x.status));
      const verified=items.filter(x=>x.status==='PASSED').length;
      const release=new GoalReleaseGate(this.store).report(id);
      return [
        `Goal status: ${graph.goal.status==='DONE'&&release.complete?'All Done':graph.goal.status==='BLOCKED'?'Needs attention':'In progress'}`,
        compactTelegramText(graph.goal.objective,210),
        `Work packages: ${verified} of ${items.length} reviewed as passed`,
        ...(active?[`Current: ${compactTelegramText(active.title,100)}`]:[]),
        release.complete?'Independent release checks: complete':
          'Independent release checks: pending (a model review is not final acceptance)',
        'Task details: /status',
      ].join('\n');
    }
    if(cmd==='/auto')return this.startPiChat(clean.slice(5),commandId);
    if(cmd==='/build')return this.startPiChat(clean.slice(6),commandId,true);
    if(cmd==='/new')return this.startFreshChat(clean.slice(4),commandId);
    if(!cmd.startsWith('/'))return this.startPiChat(clean,commandId);
    if(cmd==='/agent')return this.startAgentTask(clean.slice(6),commandId);
    if(cmd==='/list') {
      const all=this.inboxMissions();
      const {page,pages,start}=missionPage(id,words,all.length);
      return all.length?[`Tasks: Page ${page}/${pages} (${all.length} active or requiring attention)`,
        ...all.slice(start,start+TELEGRAM_MISSION_PAGE_SIZE).map((m,i)=>
        `${start+i+1}. ${taskTitle(m,82)} — ${this.taskDisplayState(m)} (round ${m.turnCount})`),
        'Use /status or the View task buttons for details. History: /history'].join('\n'):
        'No active tasks or unresolved requests. History: /history';
    }
    if(cmd==='/history'){
      const all=this.engine.list();
      const {page,pages,start}=missionPage(id,words,all.length);
      return all.length?[`History: Page ${page}/${pages} (${all.length} tasks)`,
        ...all.slice(start,start+TELEGRAM_MISSION_PAGE_SIZE).map((m,i)=>
          `${start+i+1}. ${taskTitle(m,84)} — ${taskState(m)} (round ${m.turnCount})`)
      ].join('\n'):'No task history yet.';
    }
    if(!['/status','/handoff','/pause','/resume','/cancel','/instruct','/continue'].includes(cmd))
      throw new Error('Unknown command. Send /help. Native agents use /agent, not a vendor-specific command.');
    if(!id&&cmd==='/status'){
    id=this.activeMission??this.engine.list().find(m=>m.state==='RUNNING'&&
      !this.store.isMissionArchived(m.id))?.id??this.inboxMissions()[0]?.id??
        this.engine.list().find(m=>!this.store.isMissionArchived(m.id))?.id;
      if(!id)return 'No tasks yet. Send a normal message or /build <task> to begin.';
    }
    if(!id&&cmd==='/pause'){
      const active=this.activeMission;
      if(active)id=active;
      else{
        const eligible=this.engine.list().filter(m=>!m.stopRequested&&
          ['RUNNING','READY','VERIFYING'].includes(m.state));
        if(eligible.length!==1)
          throw new Error('Cannot identify one active task. Use /list; advanced mode supports explicit references.');
        id=eligible[0]!.id;
      }
    }
    // Numbers shown in /list are read-only selectors; UUIDs remain supported
    // for operator recovery but are never needed in routine Telegram output.
    if(['/status','/pause','/resume','/instruct'].includes(cmd)&&id&&/^[1-9]\d*$/.test(id)){
      const index=Number(id),all=this.inboxMissions();
      if(!Number.isSafeInteger(index)||index>all.length)
        throw new Error('That task is no longer in the active list. Send /list to refresh.');
      id=all[index-1]!.id;
    }
    if(!id || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Provide a complete mission UUID');
    const m=this.engine.get(id);
    if(cmd==='/status') {
      const piLive=this.store.getMeta(`pi.autopilot.enabled.${id}`)==='1'
        ?this.store.piHealth().missions.find(item=>item.id===id):undefined;
      const completed=this.store.events(id).some(e=>e.type==='pi.autopilot_finished'&&
        (e.payload as {action?:unknown}).action==='DONE');
      const phase=piLive?.phase==='browser_answer_pending_do_not_resend'?
        'Waiting for the current ChatGPT reply — please do not resend':
        piLive?.phase==='awaiting_pi_review'?'Reviewing the completed reply':
        piLive?.phase==='reconciliation_required_do_not_resend'?
          'Reply needs verification — will not resend automatically':
        m.state==='RUNNING'?'Working on the next step':null;
      const goalId=new GoalLedger(this.store).missionGoalId(id);
      const goal=goalId?new GoalLedger(this.store).graph(goalId):null;
      const approved=goal?.plans.find(p=>p.status==='APPROVED');
      const items=approved?goal!.items.filter(x=>x.planId===approved.id):[];
      return [`Task status: ${completed?'All Done':this.taskDisplayState(m)}`,
        taskTitle(m,160),
        `Rounds completed: ${m.turnCount}`,
        ...(piLive?[`Current Chat: ${piLive.currentChatObservedTurns} of ${MAX_RELAY_CHAT_TURNS} messages`]:[]),
        ...(phase?[phase]:[]),
        ...(goal?[`Work packages reviewed as passed: ${items.filter(x=>x.status==='PASSED').length}/${items.length}`,
          'Final independent acceptance is separate from model progress.']:[]),
        ...(m.lastError?[`Issue: ${compactTelegramText(m.lastError,170)}`]:[]),
        ...(m.lastSummary?[`Latest result: ${compactTelegramText(m.lastSummary,460)}`]:[]),
        'Commands: /list · /pause · /help'].join('\n');
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
      this.engine.pause(id);
      return 'Paused — no further work will start. Any request already sent must finish or be verified first.';
    }
    if(cmd==='/resume'&&this.store.getMeta(`pi.autopilot.enabled.${id}`)==='1'&&
      !words.length){
      this.store.resumePiChain(id);
      return 'Goal resumed at its original settled checkpoint; no previous Send was replayed. Use /list.';
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
