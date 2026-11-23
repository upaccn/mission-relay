import {MAX_RELAY_CHAT_TURNS} from '../core/chat-limits.js';
import {createHash} from 'node:crypto';
import { Store,PI_CHECKPOINT_MISMATCH } from '../core/store.js';
import {connectChatPage,inspectChatPage,lastVisibleUserPromptSha256,listConnectedChatCandidates,
  clickDeliveryRetryOnce,visibleLongTaskBanner,visibleConversationLengthLimit,
  clickConversationLengthStartOnce,connectNativePrefilledDraft,
  nativePrefilledDraftSha256,clickNativePrefilledSendOnce,
  type BrowserSession} from './chatgpt-browser.js';
import {MAX_CONVERSATION_LENGTH_ERROR} from '../core/chat-limits.js';
type ConnectedChatCandidate=Awaited<ReturnType<typeof listConnectedChatCandidates>>[number];
import {browserGoalPlanningPrompt,MAX_FRESH_CHAT_TASK_CHARS} from '../core/browser-controller.js';
import {withReadOnlyDeadline} from '../core/read-only-deadline.js';
import {drivePiAutopilot,pauseFailedPiPlanning,
  deferTransientPiBrowserRecovery} from '../core/pi-autopilot.js';
import {SshPiPlanner,validateRemoteProjectPath,type PiPlanner} from '../core/pi-planner.js';
import {GoalLedger} from '../core/goal-store.js';
import {goalContinuationAcceptance} from '../core/goal-prompts.js';
import {hasIsolatedRepositoryGrant,declaredSourceMatchesScope} from '../core/build-scopes.js';
import {telegramChatAnchor} from '../core/chat-anchor.js';
import type {RuntimeProvenance} from '../core/runtime-provenance.js';
import type {Mission,MissionEvent} from '../core/types.js';
import {missionRelayMarker} from '../core/mission-marker.js';

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
  return /Read-only Chrome preflight timed out|Playwriter relay reconnecting|Playwriter (?:connection|relay) (?:closed|disconnected)|(?:connection|socket) (?:reset|closed|refused|aborted)|Target (?:page )?closed|locator\.(?:count|innerText|isVisible): Target page, context or browser has been closed|locator\.(?:innerText|count|isVisible): Timeout \d+ms exceeded|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE/i
    .test(error.message);
}

/** A continuous browser session can vanish AFTER PI commits NEXT but BEFORE
 * the next browser request is reserved. Use the same persisted read-only
 * reconnect backoff as a fresh-worker preflight. Reserved/uncertain Sends,
 * terminal plans, owner stops and unmatched checkpoints still fail closed. */
function deferSettledPiNextChromeFailure(store:Store,id:string,error:unknown):boolean {
  if(!isTransientPiRecoveryReadFailure(error))return false;
  const m=store.get(id),plan=store.piPlan(id);
  return plan?.round===m.turnCount&&['NEXT','HANDOFF'].includes(plan.action)&&
    deferTransientPiBrowserRecovery(store,id,(error as Error).message);
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
  'chatgpt.browser_observed','chatgpt.browser_uncertain',
  'chatgpt.browser_rollover_recovered',
  'chatgpt.browser_turn_recovered',
  'chatgpt.browser_run_finished',
  'chatgpt.browser_delivery_retry_exhausted',
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

export function formatPiNotification(m:Mission,event:MissionEvent):string {
  const payload=event.payload && typeof event.payload==='object'
    ?event.payload as {summary?:unknown;action?:unknown;reason?:unknown}:{};
  const action=event.type==='pi.autopilot_interrupted'?'INTERRUPTED':
    typeof payload.action==='string'?payload.action:'UNKNOWN';
  const summary=typeof payload.summary==='string'?payload.summary:
    typeof payload.reason==='string'?payload.reason:'No PI decision summary';
  const complete=action==='DONE';
  const label=complete?'All Done — Task finished':
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
  if(event.type==='chatgpt.browser_delivery_retry_exhausted')
    return ['Needs attention — ChatGPT Retry limit reached',
      'Three bounded Retry clicks on the original message did not produce a verified answer.',
      'Original Send is preserved; no message was resubmitted.',
      'Inspect the existing browser response before authorizing further recovery.',
      'Details: /status'].join('\n');
  const excerpt=typeof data.excerpt==='string'?data.excerpt:(m.lastSummary??'');
  const allLines=excerpt.replace(/\r/g,'').split('\n').map(x=>x.trim()).filter(Boolean);
  // Prefer the deliberate compact handoff to the arbitrary tail of a 5–30min
  // response. The model's claims are unverified, so label them accordingly.
  // Keep the flow marker outside the summary, so it cannot consume a useful line.
  const marker=missionRelayMarker(excerpt);
  const finalMarker=marker?`[MISSION_RELAY:${marker}]`:undefined;
  if(finalMarker)allLines.pop();
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
  private lastArchiveSweepAt=0;
  /** An idle, already-observed PI checkpoint may outlive a Chrome restart.
   * A connector/read-only DOM outage must not poison its durable NEXT plan;
   * retry only after bounded quiet time, never by replaying a browser Send. */
  private lastTransientPiRecoveryAt=0;
  private lastDeliveryRetryRecoveryAt=0;
  private readonly source='telegram';
  constructor(
    readonly store:Store, readonly transport:TelegramTransport,
    readonly userId:number,readonly chatId:number,
    private readonly browserConnector:(url:string,options?:{browserId?:string;bootstrapMissingAnchor?:boolean})=>Promise<BrowserSession>=connectChatPage,
    private readonly piPlanner:PiPlanner=new SshPiPlanner({
      sshHost:store.getMeta('telegram.pi.sshHost')||'UNCONFIGURED',
      project:store.getMeta('telegram.pi.project')||'/srv',
    }),
    private readonly watchCandidates:(browserId:string)=>Promise<ConnectedChatCandidate[]>=listConnectedChatCandidates,
    private readonly startupProvenance:RuntimeProvenance|null=null,
    private readonly nativeDraftConnector:(browserId:string,promptSha256:string)=>Promise<BrowserSession>=connectNativePrefilledDraft,
  ) {
    if(!Number.isSafeInteger(userId)||userId<=0||!Number.isSafeInteger(chatId)||chatId<=0)
      throw new Error('Set numeric Telegram owner user and private chat IDs');
  }

  /** One full Worker cycle (intake → dispatch/recovery → delivery), public
   * so offline integration tests drive exactly what the Worker runs. */
  async pollOnce(timeoutSeconds=8):Promise<void> {
    await this.controlCycleOnce(timeoutSeconds);
  }

  /** Intake is the control-plane fence: process authenticated owner commands
   * before scheduling any new browser side effect. Outbound Telegram delivery
   * is deliberately not part of this transaction or scheduling decision. */
  private async pollOwnerInboxOnce(timeoutSeconds=8):Promise<void> {
    if(this.store.getMeta('telegram.notifications_cursor')===null)
      this.store.setMeta('telegram.notifications_cursor',String(this.store.maxEventId()));
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
  }

  /** Outbound notifications are at-least-once, cursor-backed delivery. A
   * Telegram send failure must leave its durable reply/event pending, but must
   * never abort the independent Mission scheduler or owner-command intake. */
  private async deliverOutboundBestEffort():Promise<void> {
    try{await this.deliverPendingReplies();}
    catch(error){
      const reason=error instanceof Error?error.message:'unknown transport error';
      console.error(`Telegram reply delivery deferred: ${reason}`);
    }
    try{await this.deliverNotifications();}
    catch(error){
      const reason=error instanceof Error?error.message:'unknown transport error';
      console.error(`Telegram notification delivery deferred: ${reason}`);
    }
  }

  /** One deterministic Worker cycle: owner intake → durable recovery/dispatch
   * → best-effort outbound delivery. No second daemon or queue is introduced. */
  private async controlCycleOnce(timeoutSeconds=8):Promise<void> {
    await this.pollOwnerInboxOnce(timeoutSeconds);
    if(this.store.channelDrainRequested(this.source))return;
    await this.reconcileControlStateOnce();
    await this.deliverOutboundBestEffort();
  }

  private async reconcileControlStateOnce():Promise<void> {
    if(this.store.channelDrainRequested(this.source))return;
    // Housekeeping belongs to the existing leased Worker, not a new service.
    // Preserve unresolved/paused missions and their immutable audit trail.
    if(!this.activeTask&&!this.activeMission&&
      Date.now()-this.lastArchiveSweepAt>=60*60*1000){
      this.lastArchiveSweepAt=Date.now();
      try {
        this.store.archiveSettledMissions({
          minAgeMs:24*60*60*1000,includeBlocked:false,
        });
      }catch{
        console.error('Settled Mission housekeeping deferred; no active request was changed');
      }
    }
    // Each recovery path remains fenced by the same single Worker and SQLite
    // request identity. Any reserved/uncertain Send blocks Goal switching.
    if(!this.activeTask&&!this.store.channelDrainRequested(this.source))
      await this.recoverUncertainDeliveryOnce();
    if(!this.activeTask&&!this.store.channelDrainRequested(this.source))
      await this.recoverNativePrefilledDraftOnce();
    if(!this.activeTask&&!this.store.channelDrainRequested(this.source))
      await this.recoverNativePrefilledReplyOnce();
    if(!this.activeTask&&!this.store.channelDrainRequested(this.source))
      await this.recoverObservedPiCheckpoint();
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
          await this.controlCycleOnce();
          lastLoopProgressAt=Date.now();
          if(this.store.channelDrainRequested(this.source))continue;
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
    const candidate=this.store.list().find(m=>{
      const r=this.store.chatBrowserTurn(m.id);
      return m.state==='NEEDS_RECONCILIATION'&&!m.stopRequested&&
        (([MAX_CONVERSATION_LENGTH_ERROR,
            'ChatGPT response observation timed out; submission outcome is ambiguous'].includes(m.lastError??'')&&
          r?.status==='uncertain'&&r.newConversation!==true)||
         (m.lastError==='New ChatGPT reply observation timed out; creation outcome is ambiguous'&&
          r?.status==='uncertain'&&r.newConversation===true))&&
        this.store.getMeta(`pi.autopilot.enabled.${m.id}`)==='1';
    });
    if(!candidate)return;
    // A Goal whose repository grant no longer matches is still allowed
    // read-only recovery, but cannot trigger a side-effecting UI Retry
    // that would continue work inside the wrong approved repository.
    const scopeConsistent=candidate.sandbox!=='workspace-write'||
      (declaredSourceMatchesScope(candidate.goal,candidate.workspace)&&
        hasIsolatedRepositoryGrant(this.store,candidate.workspace));
    const r=this.store.chatBrowserTurn(candidate.id)!;
    const url=this.store.chatLink(candidate.id),browserId=this.store.chatBrowserBinding(candidate.id);
    if(!url||!browserId)return;
    let session:BrowserSession|undefined;
    try {
      let destination=url;
      if(r.newConversation===true){
        // The original Chat URL is still the SOURCE. Find the unique newly
        // created destination from its exact reserved user-prompt digest.
        // Neither a guessed tab URL nor a generic Retry button is sufficient.
        const matches=(await withReadOnlyDeadline(this.watchCandidates(browserId),30_000))
          .filter(c=>c.url!==url&&c.lastUserSha256===r.promptSha256);
        if(matches.length!==1||matches[0]!.duplicate)return;
        destination=matches[0]!.url;
        // A legitimate rollover follows a fully observed source and PI NEXT.
        // Re-check that physical source before touching the new tab.
        if(candidate.turnCount>0){
          const plan=this.store.piPlan(candidate.id);
          if(!plan||plan.round!==candidate.turnCount||!['NEXT','HANDOFF'].includes(plan.action))return;
          const source=await withReadOnlyDeadline(this.browserConnector(url,{browserId}),30_000,
            late=>late.close());
          try{
            const snapshot=await withReadOnlyDeadline(inspectChatPage(source.page,url));
            if(snapshot.generating||!snapshot.composerReady||
              createHash('sha256').update(snapshot.lastAssistant).digest('hex')!==plan.responseSha256)return;
          }finally{await source.close().catch(()=>{});}
        }
      }
      session=await withReadOnlyDeadline(this.browserConnector(destination,{browserId}),30_000,
        late=>late.close());
      const page=session.page;
      const snapshot=await withReadOnlyDeadline(inspectChatPage(page,destination));
      if(!snapshot.composerReady||
        await withReadOnlyDeadline(lastVisibleUserPromptSha256(page))!==r.promptSha256)return;
      // Capacity exhaustion is terminal for THIS Chat, not an existing-message
      // transport Retry. When not owner-paused, click the exact native UI
      // only after a durable one-shot intent; do not claim the lost answer,
      // release its lock, submit a new composer message or switch Goals.
      if(scopeConsistent&&r.newConversation!==true&&!candidate.stopRequested&&
        !snapshot.generating&&
        await withReadOnlyDeadline(visibleConversationLengthLimit(page))) {
        const clicked=await clickConversationLengthStartOnce(page,destination,true,
          ()=>this.store.claimConversationLengthStartIntent(candidate.id,
            candidate.version,r.requestKey,r.promptSha256));
        if(clicked){
          this.store.recordConversationLengthStartClicked(candidate.id,
            r.requestKey,r.promptSha256);
          console.warn('ChatGPT conversation exhausted; native Start new chat clicked once, original Send uncredited and preserved');
        }
        return;
      }
      const already=this.store.hasDeliveryRetryIntent(candidate.id,r.requestKey,r.promptSha256);
      const banner=await withReadOnlyDeadline(visibleLongTaskBanner(page,snapshot.lastAssistant));
      if(scopeConsistent&&!snapshot.generating &&
        (banner==='delivery-timeout'||banner==='stream-error')) {
        let attempt=0;
        const clicked=await clickDeliveryRetryOnce(page,destination,true,false,
          async(reason)=>{
            if(await lastVisibleUserPromptSha256(page)!==r.promptSha256)return false;
            if(!already){
              if(!this.store.claimDeliveryRetryIntent(candidate.id,r.requestKey,r.promptSha256,reason))
                return false;
              attempt=1;return true;
            }
            attempt=this.store.claimDeliveryRetryFollowupIntent(candidate.id,
              r.requestKey,r.promptSha256,reason)??0;
            return attempt>0;
          });
        if(clicked){
          if(attempt===1)
            this.store.recordDeliveryRetryClicked(candidate.id,r.requestKey,r.promptSha256);
          else this.store.recordDeliveryRetryFollowupClicked(candidate.id,
            r.requestKey,r.promptSha256,attempt);
          console.warn(`Recovered timed-out ChatGPT delivery/stream by existing-message UI Retry #${attempt} (no composer Send)`);
        }
        return;
      }
      // A response can finish normally after the observer's deadline. A
      // Retry intent proves only that a UI Retry was attempted, not that a
      // completed original answer is authentic. For an unretried existing-chat
      // continuation, use the prior independently committed PI checkpoint
      // instead. First-turn/adopted and new-chat recovery keep their stricter
      // original custody requirements.
      if(!already||(r.newConversation!==true&&candidate.turnCount>0)){
        const plan=this.store.piPlan(candidate.id);
        if(r.newConversation===true||candidate.turnCount<1||!plan||
          plan.round!==candidate.turnCount||
          !['NEXT','HANDOFF'].includes(plan.action)||
          !this.store.events(candidate.id).some(e=>
            ['chatgpt.browser_observed','chatgpt.browser_turn_recovered',
              'chatgpt.browser_rollover_recovered'].includes(e.type)&&
            (e.payload as {round?:number;assistantSha256?:string}).round===candidate.turnCount&&
            (e.payload as {assistantSha256?:string}).assistantSha256===plan.responseSha256))return;
      }
      if(snapshot.generating||banner!==null||
        !missionRelayMarker(snapshot.lastAssistant))
        return;
      // Never credit a stale earlier answer, a mid-stream UI refresh, or a
      // different owner's message. The Store also checks the original lock,
      // unique request, assistant SHA, and previous observed answer.
      await new Promise(resolve=>setTimeout(resolve,3000));
      const stable=await withReadOnlyDeadline(inspectChatPage(page,destination));
      if(stable.generating||!stable.composerReady||
        stable.lastAssistant!==snapshot.lastAssistant||
        await withReadOnlyDeadline(lastVisibleUserPromptSha256(page))!==r.promptSha256||
        await withReadOnlyDeadline(visibleLongTaskBanner(page,stable.lastAssistant))!==null)return;
      const assistantSha256=createHash('sha256').update(stable.lastAssistant).digest('hex');
      if(r.newConversation===true){
        this.store.recoverObservedBrowserRollover(candidate.id,candidate.version,{
          requestPromptSha256:r.promptSha256,newChatUrl:destination,
          assistantSha256,summary:stable.lastAssistant});
      }else{
        this.store.recoverObservedBrowserTurn(candidate.id,candidate.version,{
          requestPromptSha256:r.promptSha256,assistantSha256,summary:stable.lastAssistant});
      }
      console.warn('Independently recovered the original timed-out ChatGPT answer; PI must review before next Send');
    }catch(error) {
      // No change to original uncertainty on a missing tab/DOM/reconnect.
      // A consumed click intent is never erased or blindly repeated.
      console.error(`Delivery Retry recovery ${candidate.id}: ${error instanceof Error?error.message:'read failed'}`);
    }finally{
      if(session)try{await session.close();}catch{/* Preserve original state. */}
    }
  }

  /** For future *unpaused* capacity recovery, the single enrolled Worker
   * follows its own verified native Start-new-chat click with one Send of
   * the exact carried draft. A cooperative owner pause ALWAYS wins; an
   * already-paused request needs the explicit operator CLI after deployment.
   * The original request remains uncertain until independent reply proof. */
  async recoverNativePrefilledDraftOnce():Promise<void> {
    if(this.activeMission||this.activeTask||this.store.channelDrainRequested(this.source))return;
    const candidate=this.store.list().find(m=>{
      if(m.state!=='NEEDS_RECONCILIATION'||m.stopRequested||
        this.store.getMeta(`pi.autopilot.enabled.${m.id}`)!=='1')return false;
      const r=this.store.chatBrowserTurn(m.id);
      if(r?.status!=='uncertain'||r.newConversation===true)return false;
      const events=this.store.events(m.id);
      return events.some(e=>e.type==='chatgpt.browser_length_start_clicked'&&
        (e.payload as {requestKey?:string}).requestKey===r.requestKey)&&
        !events.some(e=>e.type==='chatgpt.browser_native_prefilled_send_intent'&&
          (e.payload as {requestKey?:string}).requestKey===r.requestKey);
    });
    if(!candidate)return;
    const receipt=this.store.chatBrowserTurn(candidate.id)!;
    const browserId=this.store.chatBrowserBinding(candidate.id);
    if(!browserId)return;
    let session:BrowserSession|undefined;
    try {
      session=await withReadOnlyDeadline(
        this.nativeDraftConnector(browserId,receipt.promptSha256),30_000,
        late=>late.close());
      const page=session.page;
      if(await withReadOnlyDeadline(nativePrefilledDraftSha256(page))!==receipt.promptSha256)return;
      await new Promise(resolve=>setTimeout(resolve,1500));
      if(await withReadOnlyDeadline(nativePrefilledDraftSha256(page))!==receipt.promptSha256)return;
      const clicked=await clickNativePrefilledSendOnce(page,receipt.promptSha256,
        ()=>this.store.claimNativePrefilledSendIntent(candidate.id,candidate.version,
          receipt.requestKey,receipt.promptSha256,true),
        ()=>this.store.recordNativePrefilledSendClicked(candidate.id,
          receipt.requestKey,receipt.promptSha256));
      if(clicked)console.warn('Native maximum-length new Chat submitted its exact carried draft once; original request remains uncertain');
    }catch(error){
      console.error(`Native draft recovery deferred: ${error instanceof Error?error.message:'read unavailable'}`);
    }finally{
      if(session)try{await session.close();}catch{/* Original intent remains durable. */}
    }
  }

  /** After the native draft's FIRST Send, independently
   * observe the exact original prompt in one distinct direct Chat, then
   * settle the *original* uncertain reservation atomically. The Worker
   * never clicks Send here. A stored click event alone is not a reply. */
  async recoverNativePrefilledReplyOnce():Promise<void> {
    if(this.activeMission||this.activeTask||this.store.channelDrainRequested(this.source))return;
    const candidate=this.store.list().find(m=>{
      if(m.state!=='NEEDS_RECONCILIATION'||
        this.store.getMeta(`pi.autopilot.enabled.${m.id}`)!=='1')return false;
      const r=this.store.chatBrowserTurn(m.id);
      return r?.status==='uncertain'&&r.newConversation!==true&&
        this.store.events(m.id).some(e=>
          e.type==='chatgpt.browser_native_prefilled_send_intent'&&
          (e.payload as {requestKey?:string;promptSha256?:string}).requestKey===r.requestKey&&
          (e.payload as {promptSha256?:string}).promptSha256===r.promptSha256);
    });
    if(!candidate)return;
    const record=this.store.chatBrowserTurn(candidate.id)!;
    const source=this.store.chatLink(candidate.id);
    const browserId=this.store.chatBrowserBinding(candidate.id);
    if(!source||!browserId)return;
    let session:BrowserSession|undefined;
    try{
      const matched=(await withReadOnlyDeadline(
        this.watchCandidates(browserId),30_000))
        .filter(c=>c.url!==source&&
          c.lastUserSha256===record.promptSha256&&!c.duplicate);
      if(matched.length!==1)return;
      const destination=matched[0]!.url;
      if(this.store.list().some(m=>m.id!==candidate.id&&
        this.store.chatLink(m.id)===destination))return;
      session=await withReadOnlyDeadline(this.browserConnector(destination,{browserId}),
        30_000,late=>late.close());
      const page=session.page;
      const read=async()=>{
        const snapshot=await withReadOnlyDeadline(inspectChatPage(page,destination));
        const user=await withReadOnlyDeadline(lastVisibleUserPromptSha256(page));
        const banner=await withReadOnlyDeadline(visibleLongTaskBanner(page,snapshot.lastAssistant));
        if(snapshot.generating||!snapshot.composerReady||
          user!==record.promptSha256||banner!==null||
          !missionRelayMarker(snapshot.lastAssistant))
          return null;
        return snapshot.lastAssistant;
      };
      const first=await read();
      if(!first)return;
      await new Promise(resolve=>setTimeout(resolve,3000));
      const second=await read();
      if(second!==first)return;
      const recovered=this.store.recoverObservedBrowserRollover(
        candidate.id,candidate.version,{
          requestPromptSha256:record.promptSha256,newChatUrl:destination,
          assistantSha256:createHash('sha256').update(second).digest('hex'),
          summary:second,
        });
      console.warn('Native prefilled new-chat response verified and original uncertain request atomically migrated; PI review required');
      // The owner explicitly requested recovery/continuation after the
      // guarded deployment, but a fresh verification gate must still run
      // before PI may perform any *later* Send.
      if(recovered.stopRequested){
        try{
          this.store.resumePausedPiCheckpoint(candidate.id,recovered.version);
        }catch{
          console.warn('Native reply recovered but PI auto-resume gate denied; Mission remains safely paused');
        }
      }
    }catch(error){
      console.error(`Native prefilled reply inspection deferred: ${error instanceof Error?error.message:'browser read unavailable'}`);
    }finally{
      if(session)try{await session.close();}catch{/* Keep stored answer evidence. */}
    }
  }


  private async recoverObservedPiCheckpoint():Promise<void> {
    if(this.activeMission||this.activeTask||this.store.channelDrainRequested(this.source))return;
    // Never switch browsers while ANY original Send remains unaccounted for,
    // including a paused or uncertain owner. Queue intake remains permitted.
    if(this.store.list().some(m=>{
      const status=this.store.chatBrowserTurn(m.id)?.status;
      return status==='reserved'||status==='uncertain';
    }))return;
    const ledger=new GoalLedger(this.store);
    const candidates=this.store.list().filter(m=>{
      const receipt=this.store.chatBrowserTurn(m.id),plan=this.store.piPlan(m.id);
      const retryAfter=Number(this.store.getMeta(`pi.retry.after.${m.id}`)??'0');
      if(this.store.getMeta(`pi.retry.sha.${m.id}`)===receipt?.assistantSha256&&
        this.store.getMeta(`pi.retry.request.${m.id}`)===receipt?.requestKey&&
        Number.isFinite(retryAfter)&&retryAfter>Date.now())return false;
      // An unsent (aborted) browser reservation backs off before retrying.
      if(this.store.browserPresendRetryAfter(m.id)>Date.now())return false;
      return this.store.getMeta(`pi.autopilot.enabled.${m.id}`)==='1' &&
      !m.stopRequested&&!m.lastError&&
      ledger.missionGoalId(m.id)!==null&&
      ((m.state==='READY'&&m.turnCount===0)||(m.state==='PAUSED'&&m.turnCount>0))&&
      (m.turnCount===0||plan?.round!==m.turnCount||
        ['NEXT','HANDOFF'].includes(plan?.action??''));
    });
    if(!candidates.length)return;
    if(this.lastTransientPiRecoveryAt&&
      Date.now()-this.lastTransientPiRecoveryAt<60_000)return;
    // Queued Goals are processed sequentially, not treated as conflicting
    // writers. Per-conversation SQLite locks still prevent duplicate Sends.
    candidates.sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));
    // Durable round-robin cursor: restart may reconsider a settled checkpoint,
    // but never alters a previously reserved external request's identity.
    const last=this.store.getMeta('pi.scheduler.lastMission');
    const pivot=candidates.findIndex(m=>m.id===last);
    const m=candidates[(pivot+1)%candidates.length]!;
    if(m.sandbox==='workspace-write'&&
      (!declaredSourceMatchesScope(m.goal,m.workspace)||
        !hasIsolatedRepositoryGrant(this.store,m.workspace))){
      const reason='Goal repository isolation failed: declared source, approved path or overlapping grants; no further Send permitted';
      if(m.state==='READY')
        this.store.update(m.id,m.version,{state:'BLOCKED',lastError:reason},
          'pi.autopilot_interrupted',{reason});
      else pauseFailedPiPlanning(this.store,m.id,reason);
      return;
    }
    const url=this.store.chatLink(m.id),browserId=this.store.chatBrowserBinding(m.id);
    if(!url||!browserId){
      pauseFailedPiPlanning(this.store,m.id,'PI recovery source URL or bound Chrome profile is absent');
      return;
    }
    // Only an original, zero-Send Goal launch can recreate a missing
    // operator-approved anchor inside its already pinned Chrome profile.
    // A continued/uncertain Send MUST reconnect to the exact original tab.
    const firstGoalSend=m.state==='READY'&&m.turnCount===0&&
      this.store.chatBrowserTurn(m.id)===null;
    let session:BrowserSession|undefined;
    try{
      // Only the side-effect-free connector/DOM read is transient. A real
      // source hash mismatch below remains a durable, fail-closed interruption.
      let snapshot:Awaited<ReturnType<typeof inspectChatPage>>;
      let lastUserHash:string|null;
      try {
        session=await withReadOnlyDeadline(this.browserConnector(url,{
          browserId,...(firstGoalSend?{bootstrapMissingAnchor:true}:{})}),
          30_000,
          lateSession=>lateSession.close());
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
      const previous=firstGoalSend?null:this.store.chatBrowserTurn(m.id);
      if(firstGoalSend){
        if(this.store.chatBrowserTurn(m.id)||this.store.piPlan(m.id))
          throw new Error('Initial Goal recovery refused: a browser Send or PI decision already exists');
      }else if(!previous||
        !this.store.hasVerifiedPiBrowserCheckpoint(m.id)||
        createHash('sha256').update(snapshot.lastAssistant).digest('hex')!==previous.assistantSha256||
        lastUserHash!==previous.promptSha256)
        throw new Error(PI_CHECKPOINT_MISMATCH);
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
        if(!deferSettledPiNextChromeFailure(this.store,m.id,error))
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
            (Number((event.payload as {round?:unknown})?.round)!==1&&
              Number((event.payload as {round?:unknown})?.round)%5!==0))){
          cursor=event.id;
          this.store.setMeta('telegram.notifications_cursor',String(cursor));
          continue;
        }
        const body=event.type==='pi.decision'
          ?formatPiProgress(this.store.get(event.missionId),event)
          :event.type==='pi.autopilot_finished'||event.type==='pi.autopilot_interrupted'
          ?formatPiNotification(this.store.get(event.missionId),event)
          :event.type==='chatgpt.browser_observed'||event.type==='chatgpt.browser_uncertain'||
          event.type==='chatgpt.browser_run_finished'||
          event.type==='chatgpt.browser_delivery_retry_exhausted'||
          event.type==='chatgpt.browser_rollover_recovered'||event.type==='chatgpt.browser_turn_recovered'
          ?formatBrowserResultNotification(this.store.get(event.missionId),event)
          :`Task update — ${taskState(this.store.get(event.missionId))}\n${taskTitle(this.store.get(event.missionId))}\nDetails: /status`;
        await this.transport.sendMessage(this.chatId,body);
      }
      cursor=event.id;
      this.store.setMeta('telegram.notifications_cursor',String(cursor));
    }
  }

  /** Goal intake never opens Chrome and never waits for another Goal to finish.
   * Initial browser/PI preflight is performed later by the ONE leased worker. */
  private enqueueGoal(task:string,commandId:string,write:boolean):string {
    const specified=write?/^--repo\s+(\S+)\s+([\s\S]+)$/.exec(task.trim()):null;
    if(write&&!specified)
      throw new Error('Every writable Goal requires /goal-build --repo /approved/absolute/path <objective>; no default repository is inherited');
    const objective=(specified?specified[2]!:task).trim();
    const project=write?validateRemoteProjectPath(specified![1]!):null;
    if(write&&(!project||!hasIsolatedRepositoryGrant(this.store,project)))
      throw new Error('Write-enabled Goal needs a locally approved repository; use telegram-build-project --allow <path>');
    if(project&&!declaredSourceMatchesScope(objective,project))
      throw new Error('Goal names a different source repository; use /goal-build --repo <approved path> <objective> with an exact local repository approval');
    if(!objective||objective.length>MAX_FRESH_CHAT_TASK_CHARS)
      throw new Error(`Goal objective must be 1–${MAX_FRESH_CHAT_TASK_CHARS} characters`);
    const anchor=telegramChatAnchor(this.store);
    if(!anchor)throw new Error('No approved ChatGPT profile; configure telegram-anchor locally');
    if(this.piPlanner instanceof SshPiPlanner&&!this.store.getMeta('telegram.pi.sshHost'))
      throw new Error('PI coordinator not configured; use telegram-pi-config locally');
    const created=this.store.atomic(()=>{
      if(this.store.channelDrainRequested(this.source))
        throw new Error('Telegram maintenance drain active; no Goal was accepted');
      if(project&&!hasIsolatedRepositoryGrant(this.store,project))
        throw new Error('Approved build repository was revoked during Goal intake');
      const key=`telegram-goal-${commandId}`;
      const previous=this.store.list().find(m=>m.requestKey===key);
      if(previous){
        if(previous.goal!==objective||previous.workspace!==(project??'')||
          previous.sandbox!==(project?'workspace-write':'read-only')||
          !new GoalLedger(this.store).missionGoalId(previous.id))
          throw new Error('Goal idempotency key was reused with a different scope');
        // A duplicate command must never relink a now-running conversation
        // to the original launch anchor or change its approved repository.
        return {mission:previous,duplicate:true};
      }
      // A new Telegram update ID is not proof of a new owner intention:
      // repeated text in the same approved repository is usually a retry.
      // Separate repositories remain separate identities even if their
      // objective text is identical; terminal Goals may be reattempted.
      const ledger=new GoalLedger(this.store);
      const duplicate=this.store.list().find(m=>{
        if(m.goal.trim()!==objective||m.workspace!==(project??'')||
          m.sandbox!==(project?'workspace-write':'read-only'))return false;
        const goalId=ledger.missionGoalId(m.id);
        return goalId!==null&&['DRAFT','ACTIVE','PAUSED'].includes(ledger.getGoal(goalId).status);
      });
      if(duplicate)return {mission:duplicate,duplicate:true};
      const m=this.store.create({
        goal:objective,acceptance:[project?
          'Implement within the individually approved repository; verify tests, Git and CI before completion':
          'Substantively answer the owner Goal with read-only evidence'],
        workspace:project??'',sandbox:project?'workspace-write':'read-only',
        mode:'supervised',requestKey:key,checks:[],
      });
      const linked=this.store.linkChat(m.id,anchor.url,m.version).mission;
      const bound=this.store.chatBrowserBinding(m.id)
        ?linked:this.store.bindChatBrowser(m.id,anchor.browserId,linked.version).mission;
      if(this.store.chatBrowserBinding(bound.id)!==anchor.browserId)
        throw new Error('Original Goal browser binding changed; refusing reassignment');
      this.store.setMeta(`pi.autopilot.enabled.${m.id}`,'1');
      const goal=ledger.createGoal({requestKey:key,objective,priority:50});
      const existing=ledger.missionGoalId(m.id);
      if(existing&&existing!==goal.id)
        throw new Error('Original request key already belongs to a different Goal');
      if(!existing)ledger.bindPiMission(goal.id,m.id,bound.version,`initial-${commandId}`);
      return {mission:bound,duplicate:false};
    });
    return [
      created.duplicate?'This Goal already exists — the original task was not duplicated.':
      this.activeMission?'Task queued — the current request will not be interrupted.':
        'Task accepted — awaiting the single Worker.',
      taskTitle(created.mission),
      project?'Write scope: individually approved repository.':'Read-only Goal.',
      'Progress: /list or /status. Each Goal keeps its own ChatGPT conversation.',
    ].join('\n');
  }

  /** `/goal-continue <n|goal-id> <what changed>` — the owner says an external
   * blocker was resolved. Continue the SAME Goal (graph, PASSED work, audit)
   * with a fresh queued Mission instead of a new Goal that re-plans from
   * scratch. The old Mission, its receipts and stop flag are never touched,
   * no earlier Send is replayed, and the new Mission's first Send is the
   * ordinary read-only Goal discovery turn rebuilt from immutable Mission
   * fields. The single leased Worker schedules it like any queued Goal. */
  private continueGoal(ref:string|undefined,note:string,commandId:string):string {
    const ledger=new GoalLedger(this.store),goals=ledger.listGoals();
    if(!ref||!note.trim())
      throw new Error('Use /goal-continue <number from /goals> <what changed since it was blocked>');
    let goalId:string|undefined;
    if(/^[1-9]\d*$/.test(ref)){
      const n=Number(ref);
      if(!Number.isSafeInteger(n)||n>goals.length)throw new Error('Goal number is no longer present; refresh /goals.');
      goalId=goals[n-1]!.id;
    }else if(/^[0-9a-f-]{8,36}$/i.test(ref)){
      const matches=goals.filter(g=>g.id.startsWith(ref.toLowerCase()));
      if(matches.length!==1)throw new Error('Goal id prefix must match exactly one Goal');
      goalId=matches[0]!.id;
    }else throw new Error('Use /goal-continue <number from /goals> <what changed>');
    const text=note.trim();
    if(text.length>1500)throw new Error('Continuation note must contain 1–1500 characters');
    const anchor=telegramChatAnchor(this.store);
    if(!anchor)throw new Error('No approved ChatGPT profile; configure telegram-anchor locally');
    if(this.piPlanner instanceof SshPiPlanner&&!this.store.getMeta('telegram.pi.sshHost'))
      throw new Error('PI coordinator not configured; use telegram-pi-config locally');
    const key=`telegram-goal-continue-${commandId}`;
    const created=this.store.atomic(()=>{
      if(this.store.channelDrainRequested(this.source))
        throw new Error('Telegram maintenance drain active; no Goal was continued');
      const previous=this.store.list().find(m=>m.requestKey===key);
      if(previous){
        if(ledger.missionGoalId(previous.id)!==goalId)
          throw new Error('Continuation idempotency key was reused for a different Goal');
        return {mission:previous,duplicate:true};
      }
      const goal=ledger.getGoal(goalId!);
      if(goal.status!=='BLOCKED')
        throw new Error(`Goal is ${goal.status}; /goal-continue only reopens a BLOCKED Goal (use /resume for a paused one)`);
      const roots=ledger.goalRootMissions(goal.id).map(id=>this.store.get(id))
        .sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
      const origin=roots.at(-1);
      if(!origin)throw new Error('Goal has no original Mission scope to continue');
      const write=origin.sandbox==='workspace-write';
      if(write&&(!hasIsolatedRepositoryGrant(this.store,origin.workspace)||
        !declaredSourceMatchesScope(goal.objective,origin.workspace)))
        throw new Error('Goal repository is no longer individually approved; no continuation was created');
      const acceptance=goalContinuationAcceptance(ledger.graph(goal.id),
        origin.acceptance.slice(0,1),text);
      // Validate the exact first read-only Send before any state changes.
      browserGoalPlanningPrompt(goal.objective,acceptance,write?origin.workspace:null);
      ledger.reopenBlockedGoal(goal.id,goal.version,
        createHash('sha256').update(text).digest('hex'),`continue-${commandId}`);
      const m=this.store.create({goal:goal.objective,acceptance,
        workspace:origin.workspace,sandbox:origin.sandbox,mode:'supervised',
        requestKey:key,checks:[]});
      const linked=this.store.linkChat(m.id,anchor.url,m.version).mission;
      const bound=this.store.bindChatBrowser(m.id,anchor.browserId,linked.version).mission;
      this.store.setMeta(`pi.autopilot.enabled.${m.id}`,'1');
      ledger.bindPiMission(goal.id,bound.id,bound.version,`continue-bind-${commandId}`);
      return {mission:bound,duplicate:false};
    });
    return [
      created.duplicate?'This continuation already exists — nothing was duplicated.':
        'Goal continued — queued for the single Worker.',
      taskTitle(created.mission),
      'Passed work packages are reused; PI re-plans only what was blocked or remains.',
      'Progress: /list or /status.',
    ].join('\n');
  }

  /** Every Goal is queued durably and started by the single leased Worker;
   * intake never opens Chrome or waits for another Goal. */
  private startPiChat(task:string,commandId:string,write=false):string {
    return this.enqueueGoal(task,commandId,write);
  }

  private queuePiOwnerText(text:string,commandId:string,missionId:string|null=this.activeMission):string {
    const id=missionId;
    if(!id)throw new Error('No PI Mission is currently available for owner instructions');
    if(this.store.getMeta(`pi.autopilot.enabled.${id}`)!=='1')
      return this.alreadyRunning(text);
    if(!text||text.length>1500)
      throw new Error('PI instruction must contain 1–1500 characters');
    const accepted=this.store.queuePiOwnerDirective(id,commandId,text);
    return accepted?'Instruction saved. It will be considered before the next step.\nProgress: /status'
      :'This instruction was already saved; it was not added again.\nProgress: /status';
  }

  private alreadyRunning(goal:string):string {
    const current=this.store.get(this.activeMission!);
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
    const ledger=new GoalLedger(this.store);
    const all=this.store.list().filter(m=>!this.store.isMissionArchived(m.id)&&(
      ['READY','RUNNING','VERIFYING','BLOCKED','NEEDS_RECONCILIATION'].includes(m.state)||
      (ledger.missionGoalId(m.id)!==null&&m.state==='PAUSED')||
      (this.store.getMeta(`pi.autopilot.enabled.${m.id}`)==='1'&&m.state==='PAUSED'&&
        !m.stopRequested&&(!!m.lastError||
        !this.store.piPlan(m.id)||['NEXT','HANDOFF'].includes(this.store.piPlan(m.id)!.action)))||
      this.store.chatBrowserTurn(m.id)?.status==='uncertain'));
    const priority=(m:Mission)=>m.state==='NEEDS_RECONCILIATION'||
      this.store.chatBrowserTurn(m.id)?.status==='uncertain'?0:
      m.state==='RUNNING'||m.state==='VERIFYING'?1:
      m.state==='BLOCKED'?2:m.state==='READY'?3:4;
    return all.sort((a,b)=>priority(a)-priority(b));
  }
  /** Goal Missions that can still take an owner note: not finished,
   * blocked, cancelled or archived. */
  private openGoalMissions():Mission[] {
    const ledger=new GoalLedger(this.store);
    return this.store.list().filter(m=>!this.store.isMissionArchived(m.id)&&
      this.store.getMeta(`pi.autopilot.enabled.${m.id}`)==='1'&&ledger.missionGoalId(m.id)!==null&&
      ['READY','RUNNING','PAUSED'].includes(m.state)&&!m.stopRequested&&
      !['DONE','BLOCKED'].includes(this.store.piPlan(m.id)?.action??''));
  }
  private taskDisplayState(m:Mission):string {
    if(m.stopRequested)return 'Paused';
    if(this.store.events(m.id).some(e=>e.type==='pi.autopilot_finished'&&
      (e.payload as {action?:unknown}).action==='DONE'))return 'Completed (PI review)';
    if(m.state==='PAUSED'&&this.store.piPlan(m.id)?.action==='BLOCKED')
      return 'Needs attention — blocked on an external condition (/goal-continue after fixing it)';
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
    if(cmd==='/help'||cmd==='/start') return [
      'Mission Relay — give it a goal; it plans, works and reports until done or blocked.',
      'Plain message — add a note to the Goal in progress, or start a read-only Goal',
      '/note 2 <text> — add a note to a specific task from /list',
      '/goal <objective> — start a read-only Goal',
      '/goal-build --repo /approved/path <objective> — start a Goal that may change that repository',
      '/goal-continue 2 <what changed> — continue a blocked Goal after you fixed its blocker',
      '/goals · /goal-status 2 — Goals and their progress',
      '/list · /status 2 — tasks needing attention and their details',
      '/pause 2 · /resume 2 — stop or resume a task at a safe point',
      '/history — all past tasks',
    ].join('\n');
    if(cmd==='/goal')return this.startPiChat(clean.slice(5),commandId,false);
    if(cmd==='/goal-build')return this.startPiChat(clean.slice(11),commandId,true);
    if(cmd==='/goal-continue')return this.continueGoal(id,words.join(' '),commandId);
    if(cmd==='/goals'){
      const ledger=new GoalLedger(this.store),goals=ledger.listGoals();
      const {page,pages,start}=missionPage(id,words,goals.length);
      return goals.length?[
        `Goals: Page ${page}/${pages} (${goals.length} total)`,
        ...goals.slice(start,start+TELEGRAM_MISSION_PAGE_SIZE).map((g,i)=>{
          const m=this.store.list().filter(x=>ledger.missionGoalId(x.id)===g.id)
            .sort((a,b)=>a.createdAt.localeCompare(b.createdAt)).at(-1);
          const state=g.status==='DONE'?'Completed':
            g.status==='BLOCKED'?'Needs attention':
            m?this.taskDisplayState(m):'Queued';
          return `${start+i+1}. ${compactTelegramText(g.objective,100)} — ${state}`;
        }),
        'Use /goal-status 2 for Goal 2, or /goal-status for the latest.'
      ].join('\n'):'No tracked goals. Send /goal <objective> to begin.';
    }
    if(cmd==='/goal-status'){
      if(words.length)throw new Error('Use /goal-status or /goal-status <number from /goals>');
      const goals=new GoalLedger(this.store).listGoals();
      if(id&&/^[1-9]\d*$/.test(id)){
        const ordinal=Number(id);
        if(!Number.isSafeInteger(ordinal)||ordinal>goals.length)
          throw new Error('Goal number is no longer present; refresh /goals.');
        id=goals[ordinal-1]!.id;
      }
      id=id??goals.at(-1)?.id;
      if(!id)return 'No tracked goals yet.';
      if(!/^[0-9a-f-]{36}$/i.test(id))
        throw new Error('Use /goal-status or a goal number from /goals');
      const graph=new GoalLedger(this.store).graph(id);
      const approved=graph.plans.find(p=>p.status==='APPROVED');
      const items=approved?graph.items.filter(x=>x.planId===approved.id):[];
      const active=items.find(x=>['IN_PROGRESS','REVIEW'].includes(x.status));
      const verified=items.filter(x=>x.status==='PASSED').length;
      const done=new GoalLedger(this.store).goalCompletion(id);
      return [
        `Goal status: ${done?'All Done':graph.goal.status==='BLOCKED'?'Needs attention':'In progress'}`,
        compactTelegramText(graph.goal.objective,210),
        `Work packages: ${verified} of ${items.length} reviewed as passed`,
        ...(active?[`Current: ${compactTelegramText(active.title,100)}`]:[]),
        ...(graph.goal.status==='BLOCKED'?[
          ...items.filter(x=>x.status==='BLOCKED').slice(0,3)
            .map(x=>`Blocked: ${compactTelegramText(x.title,100)}`),
          `After fixing it: /goal-continue ${new GoalLedger(this.store).listGoals().findIndex(g=>g.id===id)+1} <what changed>`]:[]),
        ...(done?[`Result: ${compactTelegramText(done.summary,300)}`]:[]),
        'Task details: /status',
      ].join('\n');
    }
    if(!cmd.startsWith('/')){
      const open=this.openGoalMissions();
      if(open.length===0)return this.startPiChat(clean,commandId,false);
      if(open.length===1)return this.queuePiOwnerText(clean,commandId,open[0]!.id);
      throw new Error('Several Goals are in progress. Use /note <number from /list> <text>, or /goal <objective> for a new Goal.');
    }
    if(cmd==='/note'){
      if(!id||!/^[1-9]\d*$/.test(id)||!words.length)throw new Error('Use /note <number from /list> <text>');
      const target=this.inboxMissions()[Number(id)-1];
      if(!target)throw new Error('That task is no longer in the active list. Send /list to refresh.');
      return this.queuePiOwnerText(clean.replace(/^\/note\s+\S+\s+/,''),commandId,target.id);
    }
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
      const all=this.store.list();
      const {page,pages,start}=missionPage(id,words,all.length);
      return all.length?[`History: Page ${page}/${pages} (${all.length} tasks)`,
        ...all.slice(start,start+TELEGRAM_MISSION_PAGE_SIZE).map((m,i)=>
          `${start+i+1}. ${taskTitle(m,84)} — ${taskState(m)} (round ${m.turnCount})`)
      ].join('\n'):'No task history yet.';
    }
    if(!['/status','/pause','/resume'].includes(cmd))
      throw new Error('Unknown command. Send /help.');
    if(!id&&cmd==='/status'){
    id=this.activeMission??this.store.list().find(m=>m.state==='RUNNING'&&
      !this.store.isMissionArchived(m.id))?.id??this.inboxMissions()[0]?.id??
        this.store.list().find(m=>!this.store.isMissionArchived(m.id))?.id;
      if(!id)return 'No tasks yet. Send a normal message or /goal <objective> to begin.';
    }
    if(!id&&cmd==='/pause'){
      const active=this.activeMission;
      if(active)id=active;
      else{
        const eligible=this.store.list().filter(m=>!m.stopRequested&&
          ['RUNNING','READY','VERIFYING'].includes(m.state));
        if(eligible.length!==1)
          throw new Error('Cannot identify one active task. Use /list; advanced mode supports explicit references.');
        id=eligible[0]!.id;
      }
    }
    // Numbers shown in /list are read-only selectors; UUIDs remain supported
    // for operator recovery but are never needed in routine Telegram output.
    if(['/status','/pause','/resume'].includes(cmd)&&id&&/^[1-9]\d*$/.test(id)){
      const index=Number(id),all=this.inboxMissions();
      if(!Number.isSafeInteger(index)||index>all.length)
        throw new Error('That task is no longer in the active list. Send /list to refresh.');
      id=all[index-1]!.id;
    }
    if(!id || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Provide a complete mission UUID');
    const m=this.store.get(id);
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
        ...(goal?[`Work packages reviewed as passed: ${items.filter(x=>x.status==='PASSED').length}/${items.length}`]:[]),
        ...(m.lastError?[`Issue: ${compactTelegramText(m.lastError,170)}`]:[]),
        ...(m.lastSummary?[`Latest result: ${compactTelegramText(m.lastSummary,460)}`]:[]),
        'Commands: /list · /pause · /help'].join('\n');
    }
    if(words.length)throw new Error(`Use ${cmd} or ${cmd} <number from /list>`);
    if(this.store.getMeta(`pi.autopilot.enabled.${id}`)!=='1')
      throw new Error('This task is not managed by Mission Relay PI');
    // A safety stop never needs a revision: progress may change it meanwhile.
    if(cmd==='/pause') {
      this.store.pauseGoalMission(id);
      return 'Paused. Nothing new will be sent; a request already in ChatGPT finishes first.';
    }
    this.store.resumeGoalMission(id);
    return 'Resumed at its last settled step; nothing earlier is sent again. Progress: /list';
  }
}
