import type { PluginManifest } from '../core/plugins.js';
import { Engine } from '../core/engine.js';
import { Store } from '../core/store.js';
import { codexPreflight, type PreflightResult } from '../core/preflight.js';
import { renderChatGPTHandoff } from '../core/chatgpt-handoff.js';
import {connectChatPage,inspectChatPage,type BrowserSession} from './chatgpt-browser.js';
import {driveChatConversation} from '../core/browser-controller.js';
import type {Mission,MissionEvent} from '../core/types.js';

export const telegramPluginManifest:PluginManifest={
  id:'channel.telegram',version:'0.1.0',apiVersion:1,kind:'channel',
  capabilities:['receive-command','notify'],
};

export interface TelegramUpdate {
  update_id:number;
  message?:{
    text?:string;
    from?:{id:number};
    chat:{id:number;type:string};
  };
}
export interface TelegramTransport {
  getUpdates(offset:number,timeoutSeconds:number):Promise<TelegramUpdate[]>;
  sendMessage(chatId:number,text:string):Promise<void>;
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
    return this.call<TelegramUpdate[]>('getUpdates',{offset,timeout:timeoutSeconds,allowed_updates:['message'],limit:30});
  }
  async sendMessage(chatId:number,text:string):Promise<void> {
    await this.call('sendMessage',{chat_id:chatId,text:text.slice(0,3900)});
  }
}

const TERMINAL_EVENTS=new Set([
  'mission.ambiguous_failure','mission.blocked','mission.paused',
  'verification.accepted','verification.checks_required',
  'chatgpt.browser_observed','chatgpt.browser_uncertain',
  'chatgpt.browser_rollover_recovered',
  'chatgpt.browser_run_finished',
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
  'chatgpt.browser_run_finished':'PAUSED (final ChatGPT browser batch result observed)',
};

/** Telegram is not end-to-end encrypted: only send a bounded tail of the
 * browser response, never complete tool logs, screenshots or browser secrets. */
export function formatBrowserResultNotification(m:Mission,event:MissionEvent):string {
  const data=(event.payload && typeof event.payload==='object')
    ?event.payload as {excerpt?:unknown;round?:unknown;reason?:unknown}:{};
  if(event.type==='chatgpt.browser_uncertain')
    return [`Mission ${m.id}: NEEDS_RECONCILIATION`,
      `Round: ${typeof data.round==='number'?data.round:m.turnCount}/${m.maxTurns}`,
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
  const redact=(s:string)=>s.replace(/\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{22,}/g,'[REDACTED]')
    .replace(/\b(?:ghp_|gho_|ghu_|ghs_|github_pat_)[A-Za-z0-9_]{18,}/g,'[REDACTED]')
    .replace(/\b\d{7,11}:[A-Za-z0-9_-]{30,}\b/g,'[REDACTED]')
    .replace(/https?:\/\/[^\s]*[#?][^\s]*/gi,'[PRIVATE LINK]');
  const round=typeof data.round==='number'?data.round:m.turnCount;
  const text=[`Mission ${m.id} — turn ${round}/${m.maxTurns}`,
    'ChatGPT result (model-provided; not independently verified):',
    ...lines.map(redact),
    ...(finalMarker?[finalMarker]:[]),
    `Status: /status ${m.id}`];
  return text.join('\n').slice(0,2900);
}

/** A single-owner, foreground-only optional channel. Never auto-approve or reconcile. */
export class TelegramBridge {
  private activeMission:string|null=null;
  private activeTask:Promise<void>|null=null;
  private readonly source='telegram';
  constructor(
    readonly store:Store, readonly engine:Engine, readonly transport:TelegramTransport,
    readonly userId:number,readonly chatId:number,
    private readonly preflight:()=>Promise<PreflightResult>=codexPreflight,
    private readonly browserConnector:(url:string,options?:{browserId?:string})=>Promise<BrowserSession>=connectChatPage,
  ) {
    if(!Number.isSafeInteger(userId)||userId<=0||!Number.isSafeInteger(chatId)||chatId<=0)
      throw new Error('Set numeric Telegram owner user and private chat IDs');
  }

  /** This small method is intentionally public for offline integration tests. */
  async pollOnce(timeoutSeconds=8):Promise<void> {
    if(this.store.getMeta('telegram.notifications_cursor')===null)
      this.store.setMeta('telegram.notifications_cursor',String(this.store.maxEventId()));
    await this.deliverPendingReplies();
    await this.deliverNotifications();
    const offset=Number(this.store.getMeta('telegram.inbox_cursor') ?? '0');
    const updates=await this.transport.getUpdates(offset,timeoutSeconds);
    if(!Array.isArray(updates)) throw new Error('Telegram getUpdates did not return an array');
    // Never let an out-of-order transport response apply commands out of sequence.
    const ordered=[...updates].sort((a,b)=>(a?.update_id ?? -1)-(b?.update_id ?? -1));
    for(const update of ordered) {
      if(!update || !Number.isSafeInteger(update.update_id) || update.update_id<offset) continue;
      const next=update.update_id+1;
      const message=update.message;
      // Treat all Bot API data as untrusted; malformed updates must not wedge the inbox.
      if(!message || !message.chat || message.chat.type!=='private' || message.from?.id!==this.userId || message.chat.id!==this.chatId) {
        this.store.advanceChannelCursor(this.source,next);
        continue;
      }
      const externalId=String(update.update_id);
      if(!this.store.reserveChannelCommand(this.source,externalId,next)) continue;
      let reply:string;
      try { reply=await this.handle(message.text ?? '',externalId); }
      catch(err){reply=`Command rejected: ${err instanceof Error?err.message:'unknown error'}`;}
      this.store.completeChannelCommand(this.source,externalId,reply);
    }
    await this.deliverPendingReplies();
  }

  async run(signal?:AbortSignal):Promise<void> {
    const lease=this.store.acquireChannelLease(this.source);
    let backoff=1000;
    try {
      while(!signal?.aborted) {
        try {await this.pollOnce();backoff=1000;}
        catch(error) {
          const message=error instanceof Error?error.message:'Telegram transport error';
          if(/HTTP (401|403|409)/.test(message)) throw new Error(message);
          console.error(`Telegram channel transient failure: ${message}`);
          await new Promise(resolve=>setTimeout(resolve,backoff));
          backoff=Math.min(backoff*2,30000);
        }
      }
    } finally {
      // Finish the current turn before closing its authoritative SQLite store.
      // A transport exit must not silently kill an in-flight external action.
      if(this.activeTask) await this.activeTask;
      this.store.releaseChannelLease(this.source,lease);
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
      await this.transport.sendMessage(this.chatId,finished.reply);
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
        const body=event.type==='chatgpt.browser_observed'||event.type==='chatgpt.browser_uncertain'||
          event.type==='chatgpt.browser_run_finished'||
          event.type==='chatgpt.browser_rollover_recovered'
          ?formatBrowserResultNotification(this.store.get(event.missionId),event)
          :`Mission ${event.missionId}: ${STATUS_BY_EVENT[event.type]}\nEvent #${event.id}: ${event.type}\nUse /status ${event.missionId} for details.`;
        await this.transport.sendMessage(this.chatId,body);
      }
      cursor=event.id;
      this.store.setMeta('telegram.notifications_cursor',String(cursor));
    }
  }

  private async handle(text:string,commandId='local-test'):Promise<string> {
    const [cmd,id,...words]=text.trim().split(/\s+/);
    if(!cmd) return 'Send /help for available commands.';
    if(cmd==='/help'||cmd==='/start') return [
      'Mission Relay (single authorized user)',
      '/list — latest missions',
      '/status <mission-id> — shows current revision',
      '/handoff <mission-id> — link and manual prompt for existing ChatGPT chat',
      '/continue <mission-id> v<revision> — Codex or linked ChatGPT Playwriter (up to 3 turns)',
      '/pause <mission-id> — best-effort stop (no revision needed)',
      '/resume <mission-id> v<revision> — reopens a paused mission without running',
      '/instruct <mission-id> v<revision> <instruction>',
      '/cancel <mission-id> v<revision> — only an inactive mission',
      'Reconciliation, secrets and high-risk approvals are CLI-only.',
    ].join('\n');
    if(cmd==='/list') {
      const all=this.engine.list().slice(0,10);
      return all.length?all.map(m=>`${m.id} — ${m.state} v${m.version}: ${m.goal.slice(0,100)}`).join('\n'):'No missions yet.';
    }
    if(!id || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Provide a complete mission UUID');
    const m=this.engine.get(id);
    if(cmd==='/status') return [`${m.id} [${m.state}] v${m.version}`,`Turn ${m.turnCount}/${m.maxTurns}`,
      `Goal: ${m.goal.slice(0,400)}`,`Last summary: ${(m.lastSummary ?? 'none').slice(0,1000)}`].join('\n');
    if(cmd==='/handoff') {
      if(words.length) throw new Error('Use /handoff <mission-id>');
      const url=this.store.chatLink(id);
      if(!url) throw new Error('No ChatGPT conversation linked; use the local link-chat CLI first');
      return renderChatGPTHandoff(m,url);
    }
    // A safety stop must not fail because executor progress increments the revision.
    if(cmd==='/pause') {
      if(words.length) throw new Error('Use /pause <mission-id> without a revision');
      return `Pause recorded: ${this.engine.pause(id).state}`;
    }
    if(!['/pause','/resume','/cancel','/instruct','/continue'].includes(cmd))
      throw new Error('Unknown command. Send /help.');
    const revision=words.shift();
    if(!revision || !/^v(0|[1-9]\d*)$/.test(revision) || !Number.isSafeInteger(Number(revision.slice(1))))
      throw new Error('Expected v<revision> from a fresh /status command (for example v3)');
    const expectedVersion=Number(revision.slice(1));
    if(m.version!==expectedVersion) throw new Error(`State conflict: expected v${expectedVersion}, current v${m.version}; run /status again`);
    if(cmd!=='/instruct' && words.length) throw new Error('Unexpected command arguments');
    if(cmd==='/resume') {
      if(m.sandbox!=='read-only') throw new Error('Remote resume of workspace-write missions is disabled; use the local CLI');
      return `Mission is now ${this.engine.resume(id,expectedVersion).state}; use /status then /continue to run.`;
    }
    if(cmd==='/cancel') return `Mission is now ${this.engine.cancel(id,expectedVersion).state}`;
    if(cmd==='/instruct') {
      if(m.sandbox!=='read-only') throw new Error('Remote instructions for workspace-write missions are disabled; use the local CLI');
      const instruction=words.join(' ').trim();
      if(!instruction || instruction.length>1500) throw new Error('Instruction must contain 1–1500 characters');
      return `Instruction saved (state ${this.engine.instruct(id,instruction,expectedVersion).state}).`;
    }
    if(cmd==='/continue') {
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
      const preflight=await this.preflight();
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
