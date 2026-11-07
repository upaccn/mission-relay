import { DatabaseSync } from 'node:sqlite';
import { randomUUID,createHash } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { hostname } from 'node:os';
import type { CreateMission, Mission, MissionEvent, MissionState, VerificationCheck } from './types.js';
import { normalizeChatGPTUrl } from './chatgpt-handoff.js';
import {MAX_RELAY_CHAT_TURNS} from './chat-limits.js';

type MissionRow = {
  id: string; goal: string; acceptance_json: string; checks_json: string; workspace: string;
  sandbox: Mission['sandbox']; mode: Mission['mode']; max_turns: number;
  request_key: string; state: MissionState; version: number; turn_count: number;
  thread_id: string | null; next_instruction: string | null;
  last_summary: string | null; last_error: string | null;
  owner_pid: number | null; owner_host: string | null; stop_requested: number;
  created_at: string; updated_at: string;
};
type EventRow = { id: number; mission_id: string; created_at: string; type: string; payload_json: string };
export interface ChannelReply { source:string; externalId:string; status:'reserved'|'finished'|'delivered'; reply:string; }
export interface ChatBrowserTurn {
  requestKey:string; promptSha256:string; status:'reserved'|'observed'|'uncertain'|'reconciled';
  createdAt:string; urlHash:string; reservationRevision?:number;
  /** Reserved for a separately created ChatGPT conversation, not this chat. */
  newConversation?:boolean;
  assistantSha256?:string; observedAt?:string; error?:string;
}
export interface PiOwnerDirective {
  id:number;externalId:string;text:string;
}
export type PiPlanAction='NEXT'|'DONE'|'BLOCKED'|'HANDOFF';
export interface PiPlan {
  action:PiPlanAction;summary:string;nextPrompt:string;responseSha256:string;
  round:number;reviewedDirectiveIds:number[];
}

function fromRow(r: MissionRow): Mission {
  return {
    id: r.id, goal: r.goal, acceptance: JSON.parse(r.acceptance_json) as string[],
    checks: JSON.parse(r.checks_json) as VerificationCheck[],
    workspace: r.workspace, sandbox: r.sandbox, mode: r.mode,
    maxTurns: r.max_turns, requestKey: r.request_key, state: r.state,
    version: r.version, turnCount: r.turn_count, threadId: r.thread_id,
    nextInstruction: r.next_instruction, lastSummary: r.last_summary,
    lastError: r.last_error, ownerPid: r.owner_pid, ownerHost: r.owner_host,
    stopRequested: Boolean(r.stop_requested),
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export class Store {
  readonly db: DatabaseSync;
  constructor(filename: string,options:{readOnly?:boolean}={}) {
    const readOnly=options.readOnly===true;
    if(readOnly&&filename===':memory:')
      throw new Error('Read-only diagnostics require a persisted SQLite database');
    if (filename !== ':memory:'&&!readOnly) {
      mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(filename, { timeout: 5000,readOnly });
    this.db.exec('PRAGMA foreign_keys = ON');
    if(readOnly){
      // No implicit CREATE TABLE / schema upgrade / PRAGMA journal_mode
      // on live production state when the operator only asks for evidence.
      // Both file-open flags and query_only fence writes even if a future
      // diagnostic accidentally calls a mutating Store helper.
      this.db.exec('PRAGMA query_only = ON');
      const version=this.db.prepare('SELECT value FROM meta WHERE key = ?')
        .get('schema_version') as {value:string}|undefined;
      if(version?.value!=='3')
        throw new Error('Read-only PI diagnostic requires existing schema v3; upgrade separately under maintenance');
      return;
    }
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS missions (
        id TEXT PRIMARY KEY, goal TEXT NOT NULL, acceptance_json TEXT NOT NULL,
        workspace TEXT NOT NULL, sandbox TEXT NOT NULL, mode TEXT NOT NULL,
        max_turns INTEGER NOT NULL, request_key TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL, version INTEGER NOT NULL, turn_count INTEGER NOT NULL,
        thread_id TEXT, next_instruction TEXT, last_summary TEXT, last_error TEXT,
        owner_pid INTEGER, owner_host TEXT, stop_requested INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, mission_id TEXT NOT NULL,
        created_at TEXT NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL,
        FOREIGN KEY(mission_id) REFERENCES missions(id)
      );
      CREATE INDEX IF NOT EXISTS events_by_mission ON events(mission_id, id);
    `);
    const version = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as {value: string} | undefined;
    if (!version) {
      this.db.exec("ALTER TABLE missions ADD COLUMN checks_json TEXT NOT NULL DEFAULT '[]'");
      this.db.prepare('INSERT INTO meta(key,value) VALUES (?,?)').run('schema_version','2');
    } else if (version.value === '1') {
      this.transaction(() => {
        this.db.exec("ALTER TABLE missions ADD COLUMN checks_json TEXT NOT NULL DEFAULT '[]'");
        this.db.prepare('UPDATE meta SET value=? WHERE key=?').run('2','schema_version');
      });
    } else if (!['2','3'].includes(version.value)) throw new Error(`Unsupported database schema ${version.value}; upgrade explicitly`);
    const currentVersion=(this.db.prepare('SELECT value FROM meta WHERE key=?').get('schema_version') as {value:string}).value;
    if (currentVersion === '2') this.transaction(()=>{
      this.db.exec(`CREATE TABLE IF NOT EXISTS channel_commands (
        source TEXT NOT NULL,external_id TEXT NOT NULL,status TEXT NOT NULL,
        reply TEXT NOT NULL DEFAULT '',received_at TEXT NOT NULL,
        PRIMARY KEY(source,external_id)
      )`);
      this.db.prepare('UPDATE meta SET value=? WHERE key=?').run('3','schema_version');
    });
    this.db.exec(`CREATE TABLE IF NOT EXISTS channel_leases (
      source TEXT PRIMARY KEY,owner_pid INTEGER NOT NULL,owner_host TEXT NOT NULL,
      lease_key TEXT NOT NULL,created_at TEXT NOT NULL
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS pi_owner_directives (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mission_id TEXT NOT NULL REFERENCES missions(id),
      external_id TEXT NOT NULL, text TEXT NOT NULL, received_at TEXT NOT NULL,
      consumed_round INTEGER,
      UNIQUE(mission_id,external_id)
    ); CREATE INDEX IF NOT EXISTS pi_owner_pending
      ON pi_owner_directives(mission_id,consumed_round,id);`);
    if (filename !== ':memory:' && process.platform !== 'win32') {
      try { chmodSync(filename, 0o600); } catch { /* host ACL may manage permissions */ }
    }
  }
  close(): void { this.db.close(); }

  acquireChannelLease(source:string):string {
    return this.transaction(()=>{
      const owner=this.db.prepare('SELECT * FROM channel_leases WHERE source=?').get(source) as
        {owner_pid:number;owner_host:string}|undefined;
      if(owner) {
        if(owner.owner_host!==hostname()) throw new Error('Channel is leased to another host; manual reconciliation required');
        try {process.kill(owner.owner_pid,0);throw new Error('Another channel poller is already running');}
        catch(error) {
          if((error as NodeJS.ErrnoException).code!=='ESRCH') throw error;
        }
      }
      const key=randomUUID();
      this.db.prepare('INSERT INTO channel_leases(source,owner_pid,owner_host,lease_key,created_at) VALUES(?,?,?,?,?) ON CONFLICT(source) DO UPDATE SET owner_pid=excluded.owner_pid,owner_host=excluded.owner_host,lease_key=excluded.lease_key,created_at=excluded.created_at')
        .run(source,process.pid,hostname(),key,new Date().toISOString());
      return key;
    });
  }
  releaseChannelLease(source:string,key:string):void {
    this.db.prepare('DELETE FROM channel_leases WHERE source=? AND lease_key=?').run(source,key);
  }
  private channelHasInFlightWork(source:string):boolean {
    const active=(this.db.prepare(
      "SELECT COUNT(*) AS count FROM missions WHERE state IN ('RUNNING','VERIFYING')"
    ).get() as {count:number}).count;
    // A PI task can be READY while the controller is inspecting its approved
    // anchor, before the first browser Send has been durably reserved. Draining
    // at that instant would strand an accepted owner command with no worker.
    const piReady=(this.db.prepare("SELECT id FROM missions WHERE state='READY'")
      .all() as {id:string}[]).some(({id})=>
      this.getMeta(`pi.autopilot.enabled.${id}`)==='1');
    const pending=(this.db.prepare(
      "SELECT COUNT(*) AS count FROM channel_commands WHERE source=? AND status!='delivered'"
    ).get(source) as {count:number}).count;
    // Telegram notification delivery is a separate append-only event cursor,
    // not a channel_commands row. A settled Mission can still have final
    // result notifications awaiting the one leased worker. Do not fence that
    // worker out until it has scanned all existing events. An absent cursor
    // denotes a never-initialized channel (initial poll baselines history).
    const notificationCursor=this.getMeta(`${source}.notifications_cursor`);
    let pendingNotifications=false;
    if(notificationCursor!==null){
      if(!/^(0|[1-9]\d*)$/.test(notificationCursor)||
        !Number.isSafeInteger(Number(notificationCursor))||
        Number(notificationCursor)>this.maxEventId())
        throw new Error('Invalid Telegram notifications cursor; maintenance must fail closed');
      pendingNotifications=Number(notificationCursor)<this.maxEventId();
    }
    const turns=this.db.prepare(
      "SELECT value FROM meta WHERE key LIKE 'chatgpt.browser.active.%'"
    ).all() as {value:string}[];
    const reserved=turns.some(({value})=>{
      const receipt:unknown=JSON.parse(value);
      if(!receipt||typeof receipt!=='object'||Array.isArray(receipt))
        throw new Error('Invalid browser turn receipt; maintenance must fail closed');
      const status=(receipt as {status?:unknown}).status;
      if(!['reserved','observed','uncertain','reconciled'].includes(String(status)))
        throw new Error('Unknown browser turn state; maintenance must fail closed');
      return status==='reserved';
    });
    return Boolean(active||piReady||pending||pendingNotifications||reserved);
  }
  /** Only the CURRENT local lease owner may abandon a stalled, fully idle
   * channel. No drain is created: a task-managed restart must not inherit a
   * persistent maintenance fence. Malformed receipts fail closed. */
  canAbandonStalledChannel(source:string):boolean {
    const owner=this.db.prepare('SELECT owner_pid,owner_host FROM channel_leases WHERE source=?')
      .get(source) as {owner_pid:number;owner_host:string}|undefined;
    if(!owner||owner.owner_pid!==process.pid||owner.owner_host!==hostname()||
       this.channelDrainRequested(source))return false;
    const cursor=this.getMeta(`${source}.notifications_cursor`);
    if(cursor===null||!/^(0|[1-9]\d*)$/.test(cursor)||
       !Number.isSafeInteger(Number(cursor))||Number(cursor)<this.maxEventId())return false;
    // The watchdog treats corrupt cursor metadata as a refused idle exit,
    // whereas explicit maintenance drain surfaces the precise parse error.
    // Check it before the shared maintenance predicate to retain that rule.
    if(this.channelHasInFlightWork(source))return false;
    return true;
  }
  /** Durable, secret-free evidence for the ONE worker's voluntary idle exit.
   * Store it only after rechecking its lease and the same fail-closed safety
   * predicate that permits exit; do not add a Mission event/notification. */
  recordChannelIdleExit(source:string,lastProgressAt:number,now=Date.now()):void {
    this.transaction(()=>{
      if(!Number.isSafeInteger(lastProgressAt)||!Number.isSafeInteger(now)||
         now-lastProgressAt<300_000||!this.canAbandonStalledChannel(source))
        throw new Error('Idle exit telemetry refused: worker is not safely idle');
      this.setMeta(`${source}.last_idle_exit`,JSON.stringify({
        at:new Date(now).toISOString(),pid:process.pid,
        elapsedMs:now-lastProgressAt,exitCode:75,
      }));
    });
  }
  /** A local, transactionally fenced maintenance request. No remote caller may set it. */
  requestChannelDrain(source:string):string {
    return this.transaction(()=>{
      const key=`${source}.maintenance.drain`;
      if(this.getMeta(key))throw new Error('Channel maintenance drain already requested');
      if(this.channelHasInFlightWork(source))
        throw new Error('Maintenance deferred: active Mission, pending reply or reserved browser Send');
      const drainId=randomUUID();
      this.setMeta(key,drainId);
      return drainId;
    });
  }
  channelDrainRequested(source:string):boolean {
    return Boolean(this.getMeta(`${source}.maintenance.drain`));
  }
  /** Local-only diagnostic for recovering a stalled maintenance launcher. */
  channelDrainId(source:string):string|null {
    return this.getMeta(`${source}.maintenance.drain`);
  }
  releaseChannelDrain(source:string,drainId:string):void {
    this.transaction(()=>{
      const key=`${source}.maintenance.drain`;
      if(!drainId||this.getMeta(key)!==drainId)
        throw new Error('Channel maintenance lease mismatch: no change made');
      this.db.prepare('DELETE FROM meta WHERE key=?').run(key);
    });
  }
  /** Record a successful provider response without saving message contents or credentials. */
  recordChannelPollSuccess(source:string):void {
    this.setMeta(`${source}.poll_success`,JSON.stringify({
      pid:process.pid,at:new Date().toISOString(),
    }));
  }
  channelStatus(source:string):{
    source:string;inboxCursor:number;notificationsCursor:number;lastEventId:number;
    pendingReplies:number;pollerPid:number|null;pollerPresent:boolean;
    transportHealth:'offline'|'starting'|'healthy'|'stale';
    lastPollSuccessAt:string|null;
    lastIdleExit:{at:string;pid:number;elapsedMs:number;exitCode:75}|null;
    drainRequested:boolean;
  } {
    const lease=this.db.prepare('SELECT owner_pid,owner_host FROM channel_leases WHERE source=?').get(source) as
      {owner_pid:number;owner_host:string}|undefined;
    let pollerPresent=false;
    if(lease?.owner_host===hostname()) {
      try {process.kill(lease.owner_pid,0);pollerPresent=true;}
      catch {pollerPresent=false;}
    }
    const pending=(this.db.prepare("SELECT COUNT(*) AS count FROM channel_commands WHERE source=? AND status!='delivered'")
      .get(source) as {count:number}).count;
    let lastPollSuccessAt:string|null=null;
    if(pollerPresent) {
      try {
        const entry=JSON.parse(this.getMeta(`${source}.poll_success`)??'null') as
          {pid?:number;at?:string}|null;
        if(entry && entry.pid===lease?.owner_pid && typeof entry.at==='string' &&
           Number.isFinite(Date.parse(entry.at)))lastPollSuccessAt=entry.at;
      }catch { /* Malformed health metadata must never imply transport success. */ }
    }
    const age=lastPollSuccessAt===null?Infinity:Date.now()-Date.parse(lastPollSuccessAt);
    const transportHealth=!pollerPresent?'offline':lastPollSuccessAt===null?'starting':
      age>=0 && age<=90_000?'healthy':'stale';
    let lastIdleExit:{at:string;pid:number;elapsedMs:number;exitCode:75}|null=null;
    try{
      const record=JSON.parse(this.getMeta(`${source}.last_idle_exit`)??'null') as
        {at?:unknown;pid?:unknown;elapsedMs?:unknown;exitCode?:unknown}|null;
      if(record&&typeof record.at==='string'&&Number.isFinite(Date.parse(record.at))&&
         Number.isSafeInteger(record.pid)&&Number.isSafeInteger(record.elapsedMs)&&
         Number(record.elapsedMs)>=300_000&&record.exitCode===75)
        lastIdleExit=record as {at:string;pid:number;elapsedMs:number;exitCode:75};
    }catch{/* Malformed diagnostic data is not evidence of a restart cause. */}
    return {source,inboxCursor:Number(this.getMeta(`${source}.inbox_cursor`)||'0'),
      notificationsCursor:Number(this.getMeta(`${source}.notifications_cursor`)||'0'),
      lastEventId:this.maxEventId(),pendingReplies:pending,
      pollerPid:lease?.owner_pid??null,pollerPresent,
      transportHealth,lastPollSuccessAt,lastIdleExit,
      drainRequested:this.channelDrainRequested(source)};
  }

  /** Operator-safe PI liveness readback. Never expose prompt/answer bodies,
   * browser links, Chrome IDs, token material or user-owned instructions.
   * Reservation age is not a heartbeat: an in-flight ChatGPT answer may run
   * for hours, and a live Bot API poll alone cannot prove browser progress. */
  piHealth(now=Date.now()):{
    observedAt:string;totalOutstanding:number;truncated:boolean;
    missions:Array<{
      id:string;state:Mission['state'];turnCount:number;maxTurns:number;
      currentChatObservedTurns:number;piDecision:string|null;
      piDecisionRound:number|null;browserReceipt:string|null;
      /** Reservation intent only; not proof of a new tab, Send or reply. */
      browserNewChatReserved:boolean;
      browserReservedAt:string|null;browserReservationAgeSeconds:number|null;
      receiptHasFullAnswerHash:boolean;lastEvent:string|null;
      lastEventAt:string|null;pendingOwnerNotes:number;
      ownerProcessMatchesPoller:boolean;phase:string;
    }>;
  } {
    if(!Number.isFinite(now)||now<0)throw new Error('PI health requires a valid observation time');
    const channel=this.channelStatus('telegram');
    const active=this.list().filter(m=>{
      if(this.getMeta(`pi.autopilot.enabled.${m.id}`)!=='1')return false;
      if(['READY','RUNNING','VERIFYING','NEEDS_RECONCILIATION'].includes(m.state))return true;
      if(m.state!=='PAUSED'||m.stopRequested)return false;
      const plan=this.piPlan(m.id);
      return (m.turnCount<m.maxTurns&&(!plan||['NEXT','HANDOFF'].includes(plan.action)))||
        !!m.lastError;
    });
    const priority=(m:Mission):number=>m.state==='RUNNING'||m.state==='VERIFYING'?0:
      m.state==='NEEDS_RECONCILIATION'?1:m.state==='READY'?2:3;
    active.sort((a,b)=>priority(a)-priority(b)||b.createdAt.localeCompare(a.createdAt));
    const selected=active.slice(0,20).map(m=>{
      const receipt=this.chatBrowserTurn(m.id),plan=this.piPlan(m.id);
      const events=this.events(m.id),last=events.at(-1);
      const reservationTime=receipt?.status==='reserved'?Date.parse(receipt.createdAt):NaN;
      const age=Number.isFinite(reservationTime)?Math.max(0,Math.floor((now-reservationTime)/1000)):null;
      const phase=m.state==='NEEDS_RECONCILIATION'?'reconciliation_required_do_not_resend':
        this.isAbandonedBrowserReservation(m.id)?'dead_owner_reserved_inspect_only_do_not_resend':
        receipt?.status==='reserved'?'browser_answer_pending_do_not_resend':
        m.state==='READY'?'awaiting_controller_dispatch':
        m.state==='PAUSED'&&m.lastError?.startsWith('Corrected answer attribution awaits')?
          'corrected_answer_requires_pi_review':
        m.state==='PAUSED'&&m.lastError?'controller_interrupted':
        receipt&&['observed','reconciled'].includes(receipt.status)&&
        plan?.round!==m.turnCount?'awaiting_pi_review':
        m.state==='PAUSED'?'pi_checkpoint_ready':
        'controller_active_browser_progress_unverified';
      return {id:m.id,state:m.state,turnCount:m.turnCount,maxTurns:m.maxTurns,
        currentChatObservedTurns:this.piChatObservedTurns(m.id),
        piDecision:plan?.action??null,piDecisionRound:plan?.round??null,
        browserReceipt:receipt?.status??null,
        browserNewChatReserved:receipt?.status==='reserved'&&receipt.newConversation===true,
        browserReservedAt:Number.isFinite(reservationTime)?receipt!.createdAt:null,
        browserReservationAgeSeconds:age,
        receiptHasFullAnswerHash:!!receipt?.assistantSha256&&/^[0-9a-f]{64}$/.test(receipt.assistantSha256),
        lastEvent:last?.type??null,lastEventAt:last?.createdAt??null,
        pendingOwnerNotes:this.pendingPiOwnerDirectives(m.id).length,
        ownerProcessMatchesPoller:channel.pollerPresent&&m.ownerPid!==null&&
          m.ownerPid===channel.pollerPid,
        phase};
    });
    return {observedAt:new Date(now).toISOString(),totalOutstanding:active.length,
      truncated:active.length>selected.length,missions:selected};
  }

  getMeta(key:string):string|null {
    const item=this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as {value:string}|undefined;
    return item?.value ?? null;
  }
  /** Link only; no browser access, scraping, or inferred mission completion. */
  chatLink(id:string):string|null {
    this.raw(id);
    return this.getMeta(`chatgpt.handoff.${id}`);
  }
  /** Stable Playwriter extension profile ID; never infer or persist a profile email. */
  chatBrowserBinding(id:string):string|null {
    this.raw(id);
    return this.getMeta(`chatgpt.browser.binding.${id}`);
  }
  /** A native Mission must keep its originally chosen executor after restart,
   * even if additional plugins are installed or the default later changes. */
  bindNativeExecutor(id:string,pluginId:string):void {
    if(!/^[a-z][a-z0-9]*(?:[.-][a-z][a-z0-9]*)+$/.test(pluginId))
      throw new Error('Invalid executor plugin ID');
    this.transaction(()=>{
      const m=this.get(id);
      if(this.chatLink(id))throw new Error('ChatGPT browser Mission cannot bind a native executor');
      if(!['READY','RUNNING','VERIFYING','PAUSED'].includes(m.state))
        throw new Error('Native executor binding requires an unfinished Mission');
      const key=`executor.mission.${id}`;
      const previous=this.getMeta(key);
      if(previous&&previous!==pluginId)
        throw new Error('Native Mission executor identity is immutable');
      if(!previous){
        if(m.threadId||m.turnCount>0)
          throw new Error('Cannot bind an executor after unbound work has already started');
        this.setMeta(key,pluginId);
        this.event(id,'executor.plugin_bound',{pluginId});
      }
    });
  }
  bindChatBrowser(id:string,browserId:string,expectedVersion:number):{mission:Mission;browserId:string} {
    if(!/^[A-Za-z0-9:._-]{1,200}$/.test(browserId)) throw new Error('Invalid Playwriter browser ID');
    if(!Number.isSafeInteger(expectedVersion)||expectedVersion<0) throw new Error('Expected revision must be a nonnegative integer');
    return this.transaction(()=>{
      const m=this.get(id);
      if(m.version!==expectedVersion) throw new Error(`State conflict for ${id}: expected ${expectedVersion}, got ${m.version}`);
      if(!this.chatLink(id)) throw new Error('Mission has no linked ChatGPT conversation');
      if(!['READY','PAUSED','BLOCKED'].includes(m.state)) throw new Error('Browser binding requires an inactive unfinished Mission');
      const pending=this.chatBrowserTurn(id);
      if(pending && ['reserved','uncertain'].includes(pending.status))
        throw new Error('Reconcile the previous browser dispatch before rebinding');
      const key=`chatgpt.browser.binding.${id}`;
      if(this.getMeta(key)===browserId) return {mission:m,browserId};
      this.setMeta(key,browserId);
      this.db.prepare('UPDATE missions SET version=version+1,updated_at=? WHERE id=? AND version=?')
        .run(new Date().toISOString(),id,m.version);
      this.event(id,'chatgpt.browser_bound',{browserId});
      return {mission:this.get(id),browserId};
    });
  }
  linkChat(id:string, rawUrl:string, expectedVersion:number):{mission:Mission;url:string} {
    const url=normalizeChatGPTUrl(rawUrl);
    if(!Number.isSafeInteger(expectedVersion)||expectedVersion<0) throw new Error('Expected revision must be a nonnegative integer');
    return this.transaction(()=>{
      const m=this.get(id);
      if(m.version!==expectedVersion) throw new Error(`State conflict for ${id}: expected ${expectedVersion}, got ${m.version}`);
      if(!['READY','PAUSED','BLOCKED'].includes(m.state))
        throw new Error(`Cannot link ChatGPT conversation while mission is ${m.state}; use an inactive unfinished mission`);
      const pending=this.chatBrowserTurn(id);
      if(pending && ['reserved','uncertain'].includes(pending.status))
        throw new Error('Reconcile previous browser dispatch before changing its ChatGPT link');
      const key=`chatgpt.handoff.${id}`;
      const old=this.getMeta(key);
      if(old===url) return {mission:m,url};
      this.setMeta(key,url);
      this.db.prepare('UPDATE missions SET version=version+1, updated_at=? WHERE id=? AND version=?')
        .run(new Date().toISOString(),id,m.version);
      this.event(id,'chatgpt.handoff_linked',{url});
      return {mission:this.get(id),url};
    });
  }
  private browserTurnKey(id:string):string {return `chatgpt.browser.active.${id}`;}
  private browserUrlLockKey(hash:string):string{return `chatgpt.browser.url_lock.${hash}`;}
  chatBrowserTurn(id:string):ChatBrowserTurn|null {
    this.raw(id);
    const value=this.getMeta(this.browserTurnKey(id));
    return value?JSON.parse(value) as ChatBrowserTurn:null;
  }
  /** A dead local Send owner may have submitted its reserved request before
   * exiting. This predicate authorizes only independent inspection, NEVER a
   * retry, lock removal or automatic credit. A foreign/unknown or live owner
   * remains conservatively in-flight. New-chat reservations need their own
   * distinct-destination recovery protocol. */
  isAbandonedBrowserReservation(id:string):boolean {
    const m=this.get(id),receipt=this.chatBrowserTurn(id);
    return m.state==='RUNNING'&&receipt?.status==='reserved'&&
      receipt.newConversation!==true&&m.ownerPid!==null&&m.ownerPid>0&&
      m.ownerHost===hostname()&&!this.isOwnerAlive(m);
  }
  /** A PI checkpoint may be a normally observed reply or a separately
   * inspected recovery. Merely acknowledging ambiguous side effects is NOT
   * equivalent to observing an answer and must never authorize PI continuation. */
  hasVerifiedPiBrowserCheckpoint(id:string):boolean {
    const receipt=this.chatBrowserTurn(id);
    if(!receipt||!/^[0-9a-f]{64}$/.test(receipt.assistantSha256??''))return false;
    if(receipt.status==='observed')return true;
    if(receipt.status!=='reconciled')return false;
    const round=this.get(id).turnCount;
    return this.events(id).some(event=>{
      if(!['chatgpt.browser_turn_recovered','chatgpt.browser_rollover_recovered',
        'chatgpt.browser_attribution_corrected'].includes(event.type))
        return false;
      const evidence=event.payload as {requestKey?:unknown;assistantSha256?:unknown;
        round?:unknown;independentlyInspected?:unknown}|null;
      return evidence?.requestKey===receipt.requestKey &&
        evidence.assistantSha256===receipt.assistantSha256 &&
        evidence.round===round && evidence.independentlyInspected===true;
    });
  }
  /** Release an owner-requested cooperative PI pause AFTER the original Send
   * has settled. Keep PAUSED (never generic READY) so the existing single
   * Telegram controller can independently re-read the exact prior user
   * prompt and full answer before PI review or any next Send. This method
   * cannot itself open Chrome, call PI, or reserve a browser Send. */
  resumePausedPiCheckpoint(id:string,revision:number):Mission {
    return this.transaction(()=>{
      const m=this.get(id),receipt=this.chatBrowserTurn(id),plan=this.piPlan(id);
      if(m.version!==revision)
        throw new Error(`State conflict: expected v${revision}, current v${m.version}`);
      if(this.getMeta(`pi.autopilot.enabled.${id}`)!=='1'||
        m.state!=='PAUSED'||!m.stopRequested||m.ownerPid!==null||
        m.turnCount<1||m.turnCount>=m.maxTurns||m.lastError||
        !receipt||!this.hasVerifiedPiBrowserCheckpoint(id)||
        (plan?.round===m.turnCount&&['DONE','BLOCKED'].includes(plan.action)))
        throw new Error('PI resume requires an owner-paused, settled, nonterminal browser checkpoint');
      if(m.sandbox==='workspace-write'&&
        (this.getMeta('telegram.build.project')!==m.workspace||
         this.getMeta('telegram.pi.project')!==m.workspace))
        throw new Error('PI build approval changed or was revoked; cannot resume');
      const parentId=this.piChainParent(id);
      if(parentId&&this.get(parentId).stopRequested)
        throw new Error('PI successor parent remains paused; resume the authorized lineage first');
      const now=new Date().toISOString();
      const updated=this.db.prepare(`UPDATE missions SET stop_requested=0,
        version=version+1,updated_at=? WHERE id=? AND version=?`)
        .run(now,id,revision);
      if(updated.changes!==1)throw new Error('PI resume revision conflict');
      this.event(id,'pi.pause_released',{
        round:m.turnCount,assistantSha256:receipt.assistantSha256,
        requiresIndependentBrowserReadback:true,
      });
      return this.get(id);
    });
  }
  /** Correct only the latest *already credited* PI answer after independently
   * observing the original request's exact user prompt and a different stable
   * complete assistant response. This is NOT another Send or another round.
   * Keep the original observation and PI decision immutable in the event log;
   * the old PI plan must be reviewed again before dispatch can resume. */
  correctPiBrowserAttribution(id:string,revision:number,input:{
    requestPromptSha256:string;assistantSha256:string;summary:string;
  }):Mission {
    if(!/^[0-9a-f]{64}$/.test(input.requestPromptSha256)||
      !/^[0-9a-f]{64}$/.test(input.assistantSha256)||!input.summary.trim()||
      createHash('sha256').update(input.summary).digest('hex')!==input.assistantSha256)
      throw new Error('Attribution correction requires exact hashes and the complete stable answer');
    return this.transaction(()=>{
      const m=this.get(id),record=this.chatBrowserTurn(id),plan=this.piPlan(id);
      if(m.version!==revision||m.state!=='PAUSED'||m.stopRequested||m.turnCount<1||
        this.getMeta(`pi.autopilot.enabled.${id}`)!=='1'||
        record?.status!=='observed'||!plan||plan.round!==m.turnCount||
        record.promptSha256!==input.requestPromptSha256||
        plan.responseSha256!==record.assistantSha256||
        record.assistantSha256===input.assistantSha256)
        throw new Error('Only the latest fully observed, mismatched PI checkpoint can be corrected');
      if(this.events(id).some(e=>e.type==='chatgpt.browser_attribution_corrected'&&
        (e.payload as {round?:number}).round===m.turnCount))
        throw new Error('Attribution was already corrected; never overwrite historical correction');
      const events=this.events(id);
      const observed=[...events].reverse().find(e=>e.type==='chatgpt.browser_observed'&&
        (e.payload as {round?:number}).round===m.turnCount);
      const decision=[...events].reverse().find(e=>e.type==='pi.decision'&&
        (e.payload as {round?:number}).round===m.turnCount);
      const reservations=events.filter(e=>e.type==='chatgpt.browser_reserved'&&
        (e.payload as {requestKey?:string}).requestKey===record.requestKey);
      const reservation=reservations[0];
      if(reservations.length!==1||!reservation||!observed||!decision||
        reservation.id>=observed.id||observed.id>=decision.id||
        (reservation.payload as {promptSha256?:string}).promptSha256!==record.promptSha256||
        (observed.payload as {requestKey?:string;assistantSha256?:string}).requestKey!==record.requestKey||
        (observed.payload as {assistantSha256?:string}).assistantSha256!==record.assistantSha256||
        (decision.payload as {responseSha256?:string}).responseSha256!==record.assistantSha256||
        (decision.payload as {responseSha256?:string}).responseSha256!==plan.responseSha256)
        throw new Error('Original reservation, observation and PI decision cannot be independently linked');
      const now=new Date().toISOString();
      this.setMeta(this.browserTurnKey(id),JSON.stringify({...record,status:'reconciled',
        assistantSha256:input.assistantSha256,observedAt:now}));
      this.db.prepare(`UPDATE missions SET version=version+1,updated_at=?,
        last_summary=?,last_error=? WHERE id=? AND version=?`)
        .run(now,input.summary.slice(-1000),
          'Corrected answer attribution awaits independent PI re-review; do not replay browser Send',id,m.version);
      this.event(id,'chatgpt.browser_attribution_corrected',{
        round:m.turnCount,requestKey:record.requestKey,
        observedEventId:observed.id,decisionEventId:decision.id,
        originalAssistantSha256:record.assistantSha256,
        assistantSha256:input.assistantSha256,promptSha256:record.promptSha256,
        independentlyInspected:true,originalEventsPreserved:true,
      });
      return this.get(id);
    });
  }
  /** Initial adoption reads an existing human-written conversation; this is
   * evidence of a browser snapshot, NEVER evidence that Relay sent a turn.
   * No turn budget is consumed and no request key is reserved for dispatch. */
  chatAdoption(id:string):{userSha256:string;assistantSha256:string}|null {
    this.raw(id);
    const item=this.getMeta(`chatgpt.browser.adoption.${id}`);
    return item?JSON.parse(item) as {userSha256:string;assistantSha256:string}:null;
  }
  recordChatAdoption(id:string,revision:number,input:{userSha256:string;assistantSha256:string;summary:string}):Mission {
    if(!/^[0-9a-f]{64}$/.test(input.userSha256)||
      !/^[0-9a-f]{64}$/.test(input.assistantSha256)||!input.summary.trim())
      throw new Error('Adoption requires a stable, nonempty ChatGPT answer and exact SHA-256s');
    return this.transaction(()=>{
      const m=this.get(id),url=this.chatLink(id);
      if(m.version!==revision||m.state!=='READY'||m.turnCount!==0||!url||
        !this.chatBrowserBinding(id)||this.chatBrowserTurn(id))
        throw new Error('Initial browser adoption requires a new READY bound Mission without prior turns');
      const current=this.list().filter(other=>other.id!==id&&
        this.getMeta(`chatgpt.handoff.${other.id}`)===url&&
        !['CANCELLED','COMPLETED'].includes(other.state));
      if(current.length)throw new Error('Conversation is already linked to another active Mission');
      const now=new Date().toISOString();
      const urlHash=createHash('sha256').update(url).digest('hex');
      if(this.getMeta(this.browserUrlLockKey(urlHash)))
        throw new Error('Conversation is locked by another browser send');
      const requestKey='initial-human-snapshot';
      const record:ChatBrowserTurn={requestKey,promptSha256:input.userSha256,
        urlHash,status:'observed',assistantSha256:input.assistantSha256,
        createdAt:now,observedAt:now};
      this.setMeta(this.browserTurnKey(id),JSON.stringify(record));
      this.setMeta(`chatgpt.browser.adoption.${id}`,JSON.stringify({
        userSha256:input.userSha256,assistantSha256:input.assistantSha256}));
      this.db.prepare(`UPDATE missions SET state='PAUSED',version=version+1,
        last_summary=?,updated_at=? WHERE id=? AND version=?`)
        .run(input.summary.slice(-1000),now,id,m.version);
      this.event(id,'chatgpt.browser_adopted',{
        userSha256:input.userSha256,assistantSha256:input.assistantSha256,
        humanOrigin:true,turnsSent:0});
      return this.get(id);
    });
  }
  /** Creation, canonical URL link, exact browser profile and human-origin
   * snapshot are one all-or-nothing durable action. No orphan READY Mission
   * remains if a later validation or audit insert fails. */
  adoptHumanChat(input:CreateMission,url:string,browserId:string,evidence:{
    userSha256:string;assistantSha256:string;summary:string;
  }):Mission {
    return this.transaction(()=>{
      if(this.channelDrainRequested('telegram'))
        throw new Error('Telegram maintenance drain active; new ChatGPT adoption is refused');
      const created=this.create(input);
      const linked=this.linkChat(created.id,url,created.version).mission;
      const bound=this.bindChatBrowser(created.id,browserId,linked.version).mission;
      return this.recordChatAdoption(created.id,bound.version,evidence);
    });
  }
  reserveChatBrowserTurn(id:string,revision:number,requestKey:string,promptSha256:string,
    options:{newConversation?:boolean}={}):Mission {
    if(!/^[\w.-]{1,128}$/.test(requestKey)) throw new Error('Browser request key must be 1–128 safe characters');
    if(!/^[0-9a-f]{64}$/.test(promptSha256)) throw new Error('Expected SHA-256 of browser prompt');
    return this.transaction(()=>{
      if(this.channelDrainRequested('telegram'))
        throw new Error('Telegram maintenance drain active; new browser Sends are refused');
      const m=this.get(id);
      const url=this.chatLink(id);
      if(!url) throw new Error('Mission has no linked ChatGPT conversation');
      if(m.version!==revision) throw new Error(`State conflict: expected v${revision}, current v${m.version}`);
      if(!['READY','PAUSED'].includes(m.state)) throw new Error(`Cannot run browser turn in state ${m.state}`);
      if(m.stopRequested) throw new Error('Mission has a pending pause request; resume explicitly before another browser turn');
      if(m.turnCount>=m.maxTurns) throw new Error('Browser mission turn budget exhausted');
      if(m.lastError?.startsWith('Corrected answer attribution awaits'))
        throw new Error('PI must re-review corrected browser answer before any new Send');
      const correctionPending=this.events(id).some(e=>
        e.type==='chatgpt.browser_attribution_corrected'&&
        (e.payload as {round?:number}).round===m.turnCount);
      if(correctionPending&&this.piPlan(id)?.responseSha256!==this.chatBrowserTurn(id)?.assistantSha256)
        throw new Error('Corrected PI browser answer has not received a matching new PI decision');
      // This is the final, atomic dispatch gate. A raw browser-send or future
      // controller path must not bypass the same-chat ceiling by omitting the
      // higher-level PI/browser-drive rotation check. A new-tab Send is
      // separately reserved and may only be credited with an actual URL move.
      if(!options.newConversation&&this.piChatObservedTurns(id)>=MAX_RELAY_CHAT_TURNS)
        throw new Error(`ChatGPT conversation already has ${MAX_RELAY_CHAT_TURNS} observed Relay Sends; start a new conversation before another Send`);
      if(m.sandbox==='workspace-write'&&this.getMeta(`pi.autopilot.enabled.${id}`)==='1'&&
        (this.getMeta('telegram.build.project')!==m.workspace||
         this.getMeta('telegram.pi.project')!==m.workspace))
        throw new Error('Approved PI build workspace changed or was revoked before Send');
      // The first child Send MUST open a distinct ChatGPT conversation. A raw
      // browser-send must not bypass the PI controller and append to the
      // predecessor's old chat. Recheck the chain source inside this same
      // transaction: an owner pause/revocation during PI inference must win.
      const parentId=m.turnCount===0?this.piChainParent(id):null;
      if(parentId){
        // A new owner note may arrive after PI planning but before UI preflight.
        if(this.pendingPiOwnerDirectives(id).length)
          throw new Error('PI successor has new owner notes; review before reserving a Send');
        if(!options.newConversation)
          throw new Error('PI successor first Send must open a new ChatGPT conversation');
        const parent=this.get(parentId),plan=this.piPlan(parentId);
        const receipt=this.chatBrowserTurn(parentId);
        if(this.piChainSuccessor(parentId)!==id||parent.state!=='PAUSED'||
          parent.stopRequested||parent.lastError||parent.turnCount!==parent.maxTurns||
          plan?.round!==parent.maxTurns||!['NEXT','HANDOFF'].includes(plan?.action??'')||
          !receipt||receipt.assistantSha256!==plan?.responseSha256||
          !this.hasVerifiedPiBrowserCheckpoint(parentId))
          throw new Error('PI successor parent no longer has an approved, verified continuation checkpoint');
      }
      if(this.getMeta(`chatgpt.browser.request.${id}.${requestKey}`)) throw new Error('Browser request key already used; never resend');
      const prior=this.chatBrowserTurn(id);
      if(prior && ['reserved','uncertain'].includes(prior.status))
        throw new Error('Previous browser turn may have been submitted; reconcile before another send');
      const urlHash=createHash('sha256').update(url).digest('hex');
      if(this.getMeta(this.browserUrlLockKey(urlHash)))
        throw new Error('Another Mission owns the active ChatGPT conversation; inspect and reconcile before sending');
      const record:ChatBrowserTurn={requestKey,promptSha256,urlHash,status:'reserved',
        reservationRevision:revision,createdAt:new Date().toISOString(),
        ...(options.newConversation?{newConversation:true}:{})};
      this.setMeta(this.browserTurnKey(id),JSON.stringify(record));
      this.setMeta(this.browserUrlLockKey(urlHash),JSON.stringify({missionId:id,requestKey}));
      this.setMeta(`chatgpt.browser.request.${id}.${requestKey}`,record.createdAt);
      this.db.prepare('UPDATE missions SET state=?,owner_pid=?,owner_host=?,version=version+1,updated_at=? WHERE id=? AND version=?')
        .run('RUNNING',process.pid,hostname(),record.createdAt,id,m.version);
      this.event(id,'chatgpt.browser_reserved',{requestKey,promptSha256});
      return this.get(id);
    });
  }
  finishChatBrowserTurn(id:string,requestKey:string,outcome:{
    kind:'observed'|'uncertain'; assistantSha256?:string; summary?:string; error?:string;
    /** A browser-drive operator note actually included in this dispatch, not an unsent note. */
    consumedInstruction?:string|null;
    /** Only on a successfully observed new-tab rollover, commit the new URL in this same transaction. */
    newChatUrl?:string;
    /** Optional SHA-256 of the new Chrome Target ID, never the raw ID.
     * This is physical tab provenance, not authorization to close it. */
    newChatTargetSha256?:string;
    /** Telegram multi-turn continuation emits only its final summary, never intermediate turns. */
    telegramBatch?:{terminal:boolean;flowSignal:'NEXT'|'DONE'|'BLOCKED'|'HANDOFF'|'UNMARKED';
      piManaged?:boolean};
  }):Mission {
    return this.transaction(()=>{
      const current=this.get(id);
      const record=this.chatBrowserTurn(id);
      if(!record || record.requestKey!==requestKey || record.status!=='reserved' || current.state!=='RUNNING')
        throw new Error('No matching active browser dispatch to finish');
      const now=new Date().toISOString();
      const observed=outcome.kind==='observed';
      const previousUrl=this.chatLink(id);
      const migratedUrl=outcome.newChatUrl?normalizeChatGPTUrl(outcome.newChatUrl):null;
      if(outcome.newChatTargetSha256&&
        (!migratedUrl||!observed||!/^[0-9a-f]{64}$/.test(outcome.newChatTargetSha256)))
        throw new Error('New ChatGPT target fingerprint requires an observed migration and valid SHA-256');
      if(observed&&record.newConversation&&!migratedUrl)
        throw new Error('New-conversation Send cannot be credited without a distinct observed ChatGPT URL');
      if(migratedUrl && (!observed||!previousUrl||migratedUrl===previousUrl))
        throw new Error('New ChatGPT conversation migration requires a distinct observed destination');
      // An instruction inserted while the browser was running increments the
      // Mission revision. Preserve it for the next turn even if text is equal.
      const clearInstruction=observed && !!outcome.consumedInstruction &&
        current.nextInstruction===outcome.consumedInstruction &&
        record.reservationRevision!==undefined &&
        current.version===record.reservationRevision+1;
      const updated:ChatBrowserTurn={...record,status:outcome.kind,observedAt:now,
        ...(outcome.assistantSha256?{assistantSha256:outcome.assistantSha256}:{}),
        ...(outcome.error?{error:outcome.error.slice(0,500)}:{})};
      this.setMeta(this.browserTurnKey(id),JSON.stringify(updated));
      if(observed)this.db.prepare('DELETE FROM meta WHERE key=?')
        .run(this.browserUrlLockKey(record.urlHash));
      if(migratedUrl) {
        this.setMeta(`chatgpt.handoff.${id}`,migratedUrl);
        this.event(id,'chatgpt.browser_migrated',{
          previousUrlSha256:createHash('sha256').update(previousUrl!).digest('hex'),
          newUrlSha256:createHash('sha256').update(migratedUrl).digest('hex'),
          ...(outcome.newChatTargetSha256?{newTabTargetSha256:outcome.newChatTargetSha256}:{}),
          requestKey,
        });
      }
      this.db.prepare(`UPDATE missions SET state=?, owner_pid=NULL,owner_host=NULL,
        turn_count=turn_count+?,last_summary=?,last_error=?,
        next_instruction=CASE WHEN ? THEN NULL ELSE next_instruction END,
        version=version+1,updated_at=? WHERE id=? AND version=?`)
        .run(observed?'PAUSED':'NEEDS_RECONCILIATION',observed?1:0,
          observed?(outcome.summary??'Browser response observed').slice(0,1000):current.lastSummary,
          observed?null:(outcome.error??'Browser turn outcome ambiguous').slice(0,500),
          clearInstruction?1:0,now,id,current.version);
      this.event(id,observed?'chatgpt.browser_observed':'chatgpt.browser_uncertain',
        {requestKey,assistantSha256:outcome.assistantSha256??null,
          round:current.turnCount+(observed?1:0),
          ...(observed?{excerpt:(outcome.summary??'Browser response observed').slice(-1000)}:{}),
          ...(observed&&outcome.telegramBatch?{notificationMode:'telegram-batch'}:{}),
          reason:outcome.error?.slice(0,500)});
      // The last Telegram notification is committed in the SAME transaction
      // as the observed reply and final URL migration. A crash between turns
      // cannot publish a false final result or silently duplicate a reply.
      if(observed&&outcome.telegramBatch&&!outcome.telegramBatch.piManaged&&
        (outcome.telegramBatch.terminal||current.stopRequested)) {
        this.event(id,'chatgpt.browser_run_finished',{
          requestKey,round:current.turnCount+1,
          assistantSha256:outcome.assistantSha256??null,
          excerpt:(outcome.summary??'Browser response observed').slice(-1000),
          flowSignal:outcome.telegramBatch.flowSignal,
        });
      }
      return this.get(id);
    });
  }
  /** Append-only receipt that the executing controller observed isClosed()
   * after closing an in-memory Page it had created. The ledger can validate
   * provenance, not independently re-observe the physical Chrome tab.
   * SQLite evidence never authorizes a later close, and a human-linked source
   * is not an owned page. Never persist raw URLs in this event. */
  recordOwnedChatTabRetired(id:string,oldUrl:string,newUrl:string):void {
    const oldLink=normalizeChatGPTUrl(oldUrl),newLink=normalizeChatGPTUrl(newUrl);
    const hash=(url:string)=>createHash('sha256').update(url).digest('hex');
    const oldSha=hash(oldLink),newSha=hash(newLink);
    this.transaction(()=>{
      const events=this.events(id);
      const migration=events.filter(e=>e.type==='chatgpt.browser_migrated').at(-1);
      const p=migration?.payload as {previousUrlSha256?:string;newUrlSha256?:string;requestKey?:string}|undefined;
      const observed=events.find(e=>e.id>(migration?.id??Number.MAX_SAFE_INTEGER)&&
        e.type==='chatgpt.browser_observed'&&
        (e.payload as {requestKey?:string}).requestKey===p?.requestKey);
      const ownedOrigin=events.some(e=>e.id<(migration?.id??0)&&
        e.type==='chatgpt.browser_migrated'&&
        (e.payload as {newUrlSha256?:string}).newUrlSha256===oldSha);
      if(oldSha===newSha||this.chatLink(id)!==newLink||
        !migration||!observed||!ownedOrigin||
        p?.previousUrlSha256!==oldSha||p.newUrlSha256!==newSha||
        this.chatBrowserTurn(id)?.status!=='observed')
        throw new Error('Tab retirement requires a completed migration from a previously Relay-created tab');
      if(events.some(e=>e.type==='chatgpt.browser_tab_retired'&&
        (e.payload as {retiredUrlSha256?:string}).retiredUrlSha256===oldSha))
        throw new Error('This Relay-owned tab already has a retirement receipt');
      this.event(id,'chatgpt.browser_tab_retired',{
        retiredUrlSha256:oldSha,activeUrlSha256:newSha,
        migrationEventId:migration.id,observedEventId:observed.id,
      });
    });
  }
  /** Strict cross-Mission custody proof. The 32-turn predecessor must have
   * created the precise source Chat itself, ended with a verified continuing
   * decision, and have no active/pending Send. The successor must have
   * independently committed its FIRST new-chat answer. Presence in SQLite
   * does not prove a physical tab is closed or authorize unattended cleanup. */
  private verifiedChainTabSource(childId:string,oldUrl:string,newUrl:string,
    sourceTargetSha256:string|null):{
    parentId:string;parentMigrationEventId:number;parentAnswerSha256:string;
    migrationEventId:number;observedEventId:number;
    retiredUrlSha256:string;activeUrlSha256:string;sourceTabTargetSha256:string;
  }|null {
    if(!sourceTargetSha256||!/^[0-9a-f]{64}$/.test(sourceTargetSha256))return null;
    const parentId=this.piChainParent(childId);
    if(!parentId||this.piChainSuccessor(parentId)!==childId)return null;
    const previous=normalizeChatGPTUrl(oldUrl),active=normalizeChatGPTUrl(newUrl);
    const retiredUrlSha256=createHash('sha256').update(previous).digest('hex');
    const activeUrlSha256=createHash('sha256').update(active).digest('hex');
    const parent=this.get(parentId),child=this.get(childId);
    const parentReceipt=this.chatBrowserTurn(parentId),childReceipt=this.chatBrowserTurn(childId);
    const plan=this.piPlan(parentId);
    if(previous===active||this.chatLink(parentId)!==previous||
      this.chatLink(childId)!==active||
      this.chatBrowserBinding(parentId)!==this.chatBrowserBinding(childId)||
      parent.turnCount!==32||parent.maxTurns!==32||parent.state!=='PAUSED'||
      parent.ownerPid!==null||parent.stopRequested||parent.lastError||
      !parentReceipt||parentReceipt.status!=='observed'||
      !plan||plan.round!==32||!['NEXT','HANDOFF'].includes(plan.action)||
      parentReceipt.assistantSha256!==plan.responseSha256||
      !this.hasVerifiedPiBrowserCheckpoint(parentId)||
      child.turnCount<1||!childReceipt||childReceipt.status!=='observed')
      return null;
    // A different Mission binding means the same page may be user-owned or
    // part of an unrelated in-flight chain. Never touch that tab.
    if(this.list().some(m=>m.id!==childId&&m.id!==parentId&&this.chatLink(m.id)===previous))
      return null;
    const pe=this.events(parentId),ce=this.events(childId);
    const parentOrigin=pe.filter(e=>e.type==='chatgpt.browser_migrated'&&
      (e.payload as {newUrlSha256?:string}).newUrlSha256===retiredUrlSha256).at(-1);
    const limit=pe.find(e=>e.type==='pi.autopilot_finished'&&
      (e.payload as {action?:string;round?:number}).action==='LIMIT'&&
      (e.payload as {round?:number}).round===32);
    const migrated=ce.find(e=>e.type==='chatgpt.browser_migrated');
    const p=migrated?.payload as {requestKey?:string;previousUrlSha256?:string;
      newUrlSha256?:string}|undefined;
    const observed=ce.find(e=>e.type==='chatgpt.browser_observed'&&e.id>(migrated?.id??Infinity)&&
      (e.payload as {requestKey?:string}).requestKey===p?.requestKey);
    if(!parentOrigin||!limit||!migrated||!observed||
      (parentOrigin.payload as {newTabTargetSha256?:string}).newTabTargetSha256!==sourceTargetSha256||
      (observed.payload as {round?:number}).round!==1||
      p?.previousUrlSha256!==retiredUrlSha256||p.newUrlSha256!==activeUrlSha256||
      ce.some(e=>e.type==='chatgpt.browser_tab_retired'&&
        (e.payload as {retiredUrlSha256?:string}).retiredUrlSha256===retiredUrlSha256))
      return null;
    return {parentId,parentMigrationEventId:parentOrigin.id,
      parentAnswerSha256:plan.responseSha256,migrationEventId:migrated.id,
      observedEventId:observed.id,retiredUrlSha256,activeUrlSha256,
      sourceTabTargetSha256:sourceTargetSha256};
  }
  canRetirePiChainSourceTab(childId:string,oldUrl:string,newUrl:string,
    sourceTargetSha256:string|null):boolean {
    return this.verifiedChainTabSource(childId,oldUrl,newUrl,sourceTargetSha256)!==null;
  }
  /** Called only AFTER the executing controller reads Page.isClosed()=true.
   * Both Mission lineages are checked again atomically. Never backfill. */
  recordPiChainSourceTabRetired(childId:string,oldUrl:string,newUrl:string,
    sourceTargetSha256:string|null):void {
    this.transaction(()=>{
      const evidence=this.verifiedChainTabSource(childId,oldUrl,newUrl,sourceTargetSha256);
      if(!evidence)throw new Error('Cross-Mission tab retirement provenance was not verified');
      this.event(childId,'chatgpt.browser_tab_retired',evidence);
    });
  }
  /** Commit the Mission state, browser record, conversation lock and both audit
   * events together. Accept an already PAUSED Mission for recovery of legacy
   * two-step reconciliations whose second transaction never committed. */
  reconcileChatBrowserTurn(id:string):Mission {
    return this.transaction(()=>{
      const m=this.get(id),record=this.chatBrowserTurn(id);
      if(!record||!['reserved','uncertain'].includes(record.status))
        throw new Error('No interrupted browser turn to reconcile');
      if(!['RUNNING','NEEDS_RECONCILIATION','PAUSED'].includes(m.state))
        throw new Error(`Cannot reconcile browser turn in state ${m.state}`);
      if(m.state!=='PAUSED') {
        if(m.ownerPid!==null && this.isOwnerAlive(m))
          throw new Error('Execution may still be active. Refusing reconciliation');
        const now=new Date().toISOString();
        this.db.prepare(`UPDATE missions SET state='PAUSED',owner_pid=NULL,owner_host=NULL,
          version=version+1,updated_at=?,
          next_instruction=? WHERE id=? AND version=?`)
          .run(now,'Operator reconciled the interrupted turn after inspecting actual side effects. Continue only remaining work.',id,m.version);
        this.event(id,'mission.reconciled',{acknowledged:true});
      }
      record.status='reconciled';
      this.setMeta(this.browserTurnKey(id),JSON.stringify(record));
      if(record.urlHash)this.db.prepare('DELETE FROM meta WHERE key=?')
        .run(this.browserUrlLockKey(record.urlHash));
      this.event(id,'chatgpt.browser_reconciled',{requestKey:record.requestKey});
      return this.get(id);
    });
  }
  /** Operator-confirmed recovery of a rollover whose first Send succeeded but
   * its browser observer failed. The caller must independently verify the
   * exact submitted prompt, stable complete answer and destination URL first.
   * Link, turn credit, original URL lock and audit evidence commit atomically. */
  recoverObservedBrowserRollover(id:string,revision:number,input:{
    requestPromptSha256:string;newChatUrl:string;assistantSha256:string;summary:string;
  }):Mission {
    const destination=normalizeChatGPTUrl(input.newChatUrl);
    if(!/^[0-9a-f]{64}$/.test(input.requestPromptSha256)||
       !/^[0-9a-f]{64}$/.test(input.assistantSha256)||!input.summary.trim())
      throw new Error('Rollover recovery requires validated SHA-256 hashes and a nonempty observed response');
    return this.transaction(()=>{
      const m=this.get(id),record=this.chatBrowserTurn(id),oldUrl=this.chatLink(id);
      if(m.version!==revision)throw new Error(`State conflict: expected v${revision}, current v${m.version}`);
      if(m.state!=='NEEDS_RECONCILIATION'||record?.status!=='uncertain'||!oldUrl)
        throw new Error('Only an uncertain browser migration may be recovered as observed');
      if(m.ownerPid!==null&&this.isOwnerAlive(m))throw new Error('A browser owner may still be active');
      if(m.turnCount>=m.maxTurns)throw new Error('Recovery would exceed the authorized Mission turn budget');
      if(record.promptSha256!==input.requestPromptSha256||oldUrl===destination)
        throw new Error('Rollover request hash mismatch or destination is not a new conversation');
      if(this.list().some(other=>other.id!==id &&
        this.chatLink(other.id)===destination &&
        !['CANCELLED','COMPLETED'].includes(other.state)))
        throw new Error('Recovery destination still belongs to another active Mission; resolve that attribution before migration');
      const now=new Date().toISOString();
      this.setMeta(`chatgpt.handoff.${id}`,destination);
      this.setMeta(this.browserTurnKey(id),JSON.stringify({...record,status:'reconciled',
        assistantSha256:input.assistantSha256,observedAt:now}));
      this.db.prepare('DELETE FROM meta WHERE key=?').run(this.browserUrlLockKey(record.urlHash));
      this.db.prepare(`UPDATE missions SET state='PAUSED',owner_pid=NULL,owner_host=NULL,
        turn_count=turn_count+1,last_summary=?,last_error=NULL,
        version=version+1,updated_at=? WHERE id=? AND version=?`)
        .run(input.summary.slice(-1000),now,id,m.version);
      this.event(id,'mission.reconciled',{acknowledged:true,kind:'observed-browser-rollover'});
      this.event(id,'chatgpt.browser_rollover_recovered',{
        requestKey:record.requestKey,round:m.turnCount+1,
        assistantSha256:input.assistantSha256,excerpt:input.summary.slice(-1000),
        previousUrlSha256:createHash('sha256').update(oldUrl).digest('hex'),
        newUrlSha256:createHash('sha256').update(destination).digest('hex'),
        independentlyInspected:true,
      });
      return this.get(id);
    });
  }
  /** Recover an *already submitted* existing-tab reply after an observer error,
   * or a dead owner that never got to record an uncertainty event. The CLI
   * independently reads the original prompt and stable complete answer;
   * no Send is permitted. Preserve historical uncertainty when it exists,
   * never invent it when the original reservation was abandoned. */
  recoverObservedBrowserTurn(id:string,revision:number,input:{
    requestPromptSha256:string;assistantSha256:string;summary:string;
  }):Mission {
    if(!/^[0-9a-f]{64}$/.test(input.requestPromptSha256)||
      !/^[0-9a-f]{64}$/.test(input.assistantSha256)||!input.summary.trim())
      throw new Error('Existing-chat recovery requires validated prompt/assistant hashes and a nonempty reply');
    return this.transaction(()=>{
      const m=this.get(id),record=this.chatBrowserTurn(id),url=this.chatLink(id);
      if(m.version!==revision)throw new Error(`State conflict: expected v${revision}, current v${m.version}`);
      const deadReserved=this.isAbandonedBrowserReservation(id);
      const uncertain=m.state==='NEEDS_RECONCILIATION'&&record?.status==='uncertain';
      if(!record||(!uncertain&&!deadReserved)||!url||record.newConversation===true)
        throw new Error('Only an uncertain or independently inspected dead-owner existing-chat request can be recovered');
      if(m.ownerPid!==null&&this.isOwnerAlive(m))throw new Error('Browser owner may still be active');
      if(m.turnCount>=m.maxTurns)throw new Error('Recovery exceeds the authorized turn budget');
      if(record.promptSha256!==input.requestPromptSha256||
        record.urlHash!==createHash('sha256').update(url).digest('hex'))
        throw new Error('Observed reply cannot be linked to the exact original reserved prompt and chat');
      if(deadReserved){
        if(createHash('sha256').update(input.summary).digest('hex')!==input.assistantSha256||
          !/(?:^|\n)\[MISSION_RELAY:(?:NEXT|DONE|BLOCKED|HANDOFF)\]\s*$/.test(input.summary))
          throw new Error('Dead-owner recovery requires the complete SHA-matched final-marked answer');
        const reservation=this.events(id).filter(e=>e.type==='chatgpt.browser_reserved'&&
          (e.payload as {requestKey?:string}).requestKey===record.requestKey);
        if(reservation.length!==1||
          (reservation[0]!.payload as {promptSha256?:string}).promptSha256!==record.promptSha256)
          throw new Error('Dead-owner reservation cannot be linked to one original immutable event');
        let lock:{missionId?:string;requestKey?:string}|null=null;
        try{lock=JSON.parse(this.getMeta(this.browserUrlLockKey(record.urlHash))??'null');}
        catch{/* Malformed lock is not evidence of ownership. */}
        if(lock?.missionId!==id||lock.requestKey!==record.requestKey)
          throw new Error('Dead-owner browser lock differs from the original reservation');
      }
      // A re-rendered *previous* assistant after a newer exact user prompt
      // caused the actual seventh-round false attribution. Without a stored
      // distinct assistant identity, equal bytes cannot be independently
      // credited as a new turn on either recovery path.
      const prior=this.events(id).filter(e=>
        ['chatgpt.browser_observed','chatgpt.browser_turn_recovered',
          'chatgpt.browser_rollover_recovered',
          'chatgpt.browser_attribution_corrected'].includes(e.type)).at(-1);
      if(prior&&(prior.payload as {assistantSha256?:string}).assistantSha256===input.assistantSha256)
        throw new Error('Cannot distinguish recovered answer from a stale prior assistant re-render');
      const now=new Date().toISOString();
      this.setMeta(this.browserTurnKey(id),JSON.stringify({...record,status:'reconciled',
        assistantSha256:input.assistantSha256,observedAt:now}));
      this.db.prepare('DELETE FROM meta WHERE key=?').run(this.browserUrlLockKey(record.urlHash));
      this.db.prepare(`UPDATE missions SET state='PAUSED',owner_pid=NULL,owner_host=NULL,
        turn_count=turn_count+1,last_summary=?,last_error=NULL,
        version=version+1,updated_at=? WHERE id=? AND version=?`)
        .run(input.summary.slice(-1000),now,id,m.version);
      this.event(id,'mission.reconciled',{acknowledged:true,
        kind:deadReserved?'observed-dead-owner-reservation':'observed-browser-turn'});
      this.event(id,'chatgpt.browser_turn_recovered',{
        requestKey:record.requestKey,round:m.turnCount+1,
        assistantSha256:input.assistantSha256,excerpt:input.summary.slice(-1000),
        independentlyInspected:true,originalUncertainEventPreserved:!deadReserved,
        originalReservationPreserved:true,
        ...(deadReserved?{recoverySource:'dead-owner-reserved'}:{}),
      });
      return this.get(id);
    });
  }
  setMeta(key:string,value:string):void {
    this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value);
  }
  queuePiOwnerDirective(id:string,externalId:string,text:string):boolean {
    if(!/^\d+$/.test(externalId)||!text.trim()||text.length>1500)
      throw new Error('PI owner instruction requires a Telegram update ID and 1–1500 characters');
    return this.transaction(()=>{
      const m=this.get(id);
      if(['COMPLETED','CANCELLED','BLOCKED','NEEDS_RECONCILIATION'].includes(m.state))
        throw new Error('PI Mission cannot accept an instruction in its current state');
      const plan=this.piPlan(id);
      if(plan?.round===m.turnCount &&
        (['DONE','BLOCKED'].includes(plan.action)||m.turnCount>=m.maxTurns))
        throw new Error('PI Mission has already reached its terminal decision or turn budget');
      const result=this.db.prepare(`INSERT OR IGNORE INTO pi_owner_directives
        (mission_id,external_id,text,received_at) VALUES(?,?,?,?)`)
        .run(id,externalId,text.trim(),new Date().toISOString());
      if(result.changes) this.event(id,'pi.owner_directive_queued',{
        externalId,textSha256:createHash('sha256').update(text.trim()).digest('hex')});
      return result.changes===1;
    });
  }
  pendingPiOwnerDirectives(id:string):PiOwnerDirective[] {
    this.raw(id);
    return this.db.prepare(`SELECT id,external_id AS externalId,text
      FROM pi_owner_directives WHERE mission_id=? AND consumed_round IS NULL ORDER BY id`)
      .all(id) as unknown as PiOwnerDirective[];
  }
  piPlan(id:string):PiPlan|null {
    this.raw(id);
    const value=this.getMeta(`pi.plan.${id}`);
    return value?JSON.parse(value) as PiPlan:null;
  }
  piChainParent(id:string):string|null {
    this.raw(id);
    return this.getMeta(`pi.chain.parent.${id}`);
  }
  piChainSuccessor(id:string):string|null {
    this.raw(id);
    return this.getMeta(`pi.chain.successor.${id}`);
  }
  /** Emergency stop propagates through every already-created successor so a
   * pause on the original Telegram Mission cannot leave a READY child that
   * automatically sends after the operator's stop. In-flight Sends still
   * require their normal observation/reconciliation, never cancellation by
   * guessing whether the remote side effect happened. */
  pausePiChain(id:string):Mission {
    return this.transaction(()=>{
      const visited=new Set<string>();
      let cursor:string|null=id;
      while(cursor){
        if(visited.has(cursor))throw new Error('PI Mission lineage cycle detected');
        visited.add(cursor);
        const m=this.get(cursor);
        if(this.getMeta(`pi.autopilot.enabled.${cursor}`)!=='1')
          throw new Error('PI chain pause requires an enabled PI Mission');
        if(!m.stopRequested&&!['COMPLETED','CANCELLED','BLOCKED'].includes(m.state))
          this.update(cursor,m.version,{
            stopRequested:true,...(m.state==='READY'?{state:'PAUSED' as const}:{})},
            'mission.pause_requested',{reason:'Owner paused PI Mission lineage'});
        cursor=this.piChainSuccessor(cursor);
      }
      return this.get(id);
    });
  }
  /** A PI NEXT/HANDOFF at the 32-turn boundary is a durable continuation
   * intent, not a completed owner goal. Create exactly one new READY Mission
   * bound to the same approved Chrome profile, without submitting anything.
   * The next controller pass independently verifies the parent's browser
   * checkpoint before the child's first new-tab Send. */
  createPiSuccessor(id:string):Mission|null {
    return this.transaction(()=>{
      const parent=this.get(id),plan=this.piPlan(id);
      if(this.getMeta(`pi.autopilot.enabled.${id}`)!=='1'||
        parent.turnCount!==parent.maxTurns||parent.state!=='PAUSED'||
        parent.stopRequested||parent.lastError||plan?.round!==parent.maxTurns||
        !['NEXT','HANDOFF'].includes(plan.action))return null;
      if(!this.hasVerifiedPiBrowserCheckpoint(id)||
        this.chatBrowserTurn(id)?.assistantSha256!==plan.responseSha256||
        !this.events(id).some(e=>e.type==='pi.autopilot_finished'&&
          (e.payload as {action?:string}).action==='LIMIT'))return null;
      const existing=this.piChainSuccessor(id);
      if(existing)return this.get(existing);
      if(this.channelDrainRequested('telegram'))return null;
      const url=this.chatLink(id),browserId=this.chatBrowserBinding(id);
      if(!url||!browserId)throw new Error('PI successor requires a verified Chrome source binding');
      const child=this.create({goal:parent.goal,acceptance:parent.acceptance,
        workspace:parent.workspace,sandbox:parent.sandbox,mode:parent.mode,
        maxTurns:parent.maxTurns,checks:parent.checks,
        requestKey:`pi-chain-${id}`});
      const linked=this.linkChat(child.id,url,child.version).mission;
      const bound=this.bindChatBrowser(child.id,browserId,linked.version).mission;
      this.setMeta(`pi.autopilot.enabled.${bound.id}`,'1');
      this.setMeta(`pi.chain.parent.${bound.id}`,id);
      this.setMeta(`pi.chain.successor.${id}`,bound.id);
      this.event(id,'pi.chain_successor',{successorId:bound.id,round:parent.maxTurns,
        parentAnswerSha256:plan.responseSha256});
      this.event(bound.id,'pi.chain_started',{parentId:id,
        parentAnswerSha256:plan.responseSha256});
      return bound;
    });
  }
  /** A child created at the 32-turn boundary may receive new owner notes
   * before its first browser Send. Replan from its verified parent reply,
   * acknowledge exactly the notes PI reviewed, and persist the new decision
   * atomically. No browser turn is credited by this planning checkpoint. */
  commitPiChainPreflight(id:string,parentAnswerSha256:string,reviewedDirectiveIds:number[],
    plan:Omit<PiPlan,'responseSha256'|'round'|'reviewedDirectiveIds'>):PiPlan {
    return this.transaction(()=>{
      const child=this.get(id),parentId=this.piChainParent(id);
      if(child.state!=='READY'||child.turnCount!==0||child.stopRequested||
        !parentId||this.piChainSuccessor(parentId)!==id||this.chatBrowserTurn(id))
        throw new Error('PI chain preflight requires an unsent, active successor');
      const parent=this.get(parentId),parentPlan=this.piPlan(parentId);
      if(parent.stopRequested||parent.lastError||parent.turnCount!==parent.maxTurns||
        !parentPlan||!['NEXT','HANDOFF'].includes(parentPlan.action)||
        parentPlan.responseSha256!==parentAnswerSha256||
        !this.hasVerifiedPiBrowserCheckpoint(parentId)||
        this.chatBrowserTurn(parentId)?.assistantSha256!==parentAnswerSha256)
        throw new Error('PI chain preflight requires a verified unchanged parent answer');
      const previous=this.piPlan(id);
      if(previous && (previous.round!==0||!['NEXT','HANDOFF'].includes(previous.action)))
        throw new Error('PI chain preflight already reached a terminal decision');
      const pending=this.pendingPiOwnerDirectives(id).map(x=>x.id);
      if(!pending.length||JSON.stringify(pending)!==JSON.stringify(reviewedDirectiveIds))
        throw new Error('PI chain preflight owner notes changed; re-plan before dispatch');
      for(const directiveId of reviewedDirectiveIds){
        const changed=this.db.prepare(`UPDATE pi_owner_directives SET consumed_round=0
          WHERE mission_id=? AND id=? AND consumed_round IS NULL`).run(id,directiveId);
        if(changed.changes!==1)throw new Error('PI chain directive acknowledgement conflict');
      }
      const result:PiPlan={...plan,responseSha256:parentAnswerSha256,round:0,
        reviewedDirectiveIds:[...reviewedDirectiveIds]};
      this.setMeta(`pi.plan.${id}`,JSON.stringify(result));
      this.event(id,'pi.chain_preflight_decision',{action:plan.action,
        parentId,parentAnswerSha256,notesReviewed:reviewedDirectiveIds.length,
        nextPromptSha256:createHash('sha256').update(plan.nextPrompt).digest('hex')});
      if(['DONE','BLOCKED'].includes(plan.action)){
        this.update(id,child.version,{state:plan.action==='BLOCKED'?'BLOCKED':'PAUSED',
          lastSummary:plan.summary.slice(0,1000)},'pi.chain_preflight_stopped',
          {action:plan.action,reason:'PI revised parent continuation after new owner instructions'});
        this.event(id,'pi.autopilot_finished',{action:plan.action,round:0,
          summary:plan.summary,responseSha256:parentAnswerSha256});
      }
      return result;
    });
  }
  /** Atomic PI decision + exact owner directive acknowledgement. If another
   * note arrived during inference, re-plan; never silently drop it. */
  commitPiPlan(id:string,expectedSha:string,reviewedDirectiveIds:number[],
    plan:Omit<PiPlan,'responseSha256'|'round'|'reviewedDirectiveIds'>,
    replaceExisting=false):PiPlan {
    return this.transaction(()=>{
      const m=this.get(id),receipt=this.chatBrowserTurn(id);
      if(m.state!=='PAUSED'||m.stopRequested||!receipt||
         !this.hasVerifiedPiBrowserCheckpoint(id)||receipt.assistantSha256!==expectedSha)
        throw new Error('PI decision requires one matching, fully observed and unpaused ChatGPT turn');
      const previous=this.piPlan(id);
      const correction=[...this.events(id)].reverse().find(e=>e.type==='chatgpt.browser_attribution_corrected'&&
        (e.payload as {round?:number;assistantSha256?:string}).round===m.turnCount&&
        (e.payload as {assistantSha256?:string}).assistantSha256===expectedSha);
      const correctedReview=!!correction&&previous?.round===m.turnCount&&
        previous.responseSha256!==(expectedSha);
      if(previous?.round===m.turnCount &&
        (!replaceExisting||(!correctedReview&&
          (!['NEXT','HANDOFF'].includes(previous.action)||reviewedDirectiveIds.length===0))))
        throw new Error('PI decision already exists for this turn');
      if(replaceExisting&&previous?.round!==m.turnCount)
        throw new Error('Cannot revise a PI decision for a different turn');
      const pending=this.pendingPiOwnerDirectives(id).map(x=>x.id);
      if(JSON.stringify(pending)!==JSON.stringify(reviewedDirectiveIds))
        throw new Error('PI owner instructions changed during inference; re-plan before dispatch');
      for(const directiveId of reviewedDirectiveIds){
        const changed=this.db.prepare(`UPDATE pi_owner_directives SET consumed_round=?
          WHERE mission_id=? AND id=? AND consumed_round IS NULL`)
          .run(m.turnCount,id,directiveId);
        if(changed.changes!==1)throw new Error('PI directive acknowledgement conflict');
      }
      const result:PiPlan={...plan,responseSha256:expectedSha,round:m.turnCount,
        reviewedDirectiveIds:[...reviewedDirectiveIds]};
      this.setMeta(`pi.plan.${id}`,JSON.stringify(result));
      if(correctedReview)this.db.prepare(`UPDATE missions SET last_error=NULL,
        version=version+1,updated_at=? WHERE id=? AND version=?`)
        .run(new Date().toISOString(),id,m.version);
      this.event(id,correctedReview?'pi.decision_attribution_corrected':
        replaceExisting?'pi.decision_revised':'pi.decision',{
        action:plan.action,round:m.turnCount,
        summary:plan.summary,
        responseSha256:expectedSha,nextPromptSha256:createHash('sha256').update(plan.nextPrompt).digest('hex'),
        directivesReviewed:reviewedDirectiveIds.length,
        ...(correctedReview?{correctionEventId:correction!.id}:{}),
      });
      if(['DONE','BLOCKED'].includes(plan.action)||m.turnCount>=m.maxTurns){
        this.event(id,'pi.autopilot_finished',{action:m.turnCount>=m.maxTurns&&['NEXT','HANDOFF'].includes(plan.action)
          ?'LIMIT':plan.action,round:m.turnCount,summary:plan.summary,
          responseSha256:expectedSha});
      }
      return result;
    });
  }
  maxEventId():number {
    return (this.db.prepare('SELECT COALESCE(MAX(id),0) AS max FROM events').get() as {max:number}).max;
  }
  eventsAfter(cursor:number,limit=100):MissionEvent[] {
    return (this.db.prepare('SELECT * FROM events WHERE id>? ORDER BY id LIMIT ?').all(cursor,limit) as EventRow[])
      .map(x=>({id:x.id,missionId:x.mission_id,createdAt:x.created_at,type:x.type,payload:JSON.parse(x.payload_json) as unknown}));
  }
  /** Reserve before side effects. A reserved command is NEVER silently re-executed. */
  reserveChannelCommand(source:string,externalId:string,nextCursor:number):boolean {
    return this.transaction(()=>{
      if(this.channelDrainRequested(source))
        throw new Error('Channel maintenance drain active; incoming updates remain unacknowledged');
      const existing=this.db.prepare('SELECT 1 FROM channel_commands WHERE source=? AND external_id=?').get(source,externalId);
      if(existing) return false;
      this.db.prepare('INSERT INTO channel_commands(source,external_id,status,reply,received_at) VALUES(?,?,?,?,?)')
        .run(source,externalId,'reserved','',new Date().toISOString());
      const key=`${source}.inbox_cursor`;
      const old=Number(this.getMeta(key) || '0');
      this.setMeta(key,String(Math.max(old,nextCursor)));
      return true;
    });
  }
  advanceChannelCursor(source:string,nextCursor:number):void {
    const key=`${source}.inbox_cursor`;
    this.setMeta(key,String(Math.max(Number(this.getMeta(key) || '0'),nextCursor)));
  }
  completeChannelCommand(source:string,externalId:string,reply:string):void {
    this.db.prepare("UPDATE channel_commands SET status='finished',reply=? WHERE source=? AND external_id=? AND status='reserved'")
      .run(reply,source,externalId);
  }
  pendingChannelReplies(source:string):ChannelReply[] {
    return (this.db.prepare("SELECT source,external_id,status,reply FROM channel_commands WHERE source=? AND status!='delivered' ORDER BY received_at LIMIT 50")
      .all(source) as {source:string;external_id:string;status:ChannelReply['status'];reply:string}[])
      .map(x=>({source:x.source,externalId:x.external_id,status:x.status,reply:x.reply}));
  }
  markChannelDelivered(source:string,externalId:string):void {
    this.db.prepare("UPDATE channel_commands SET status='delivered' WHERE source=? AND external_id=? AND status='finished'")
      .run(source,externalId);
  }
  private transactionDepth=0;
  /** Compose several trusted local state changes into one atomic decision.
   * This is an internal in-process API, never exposed to model/plugin inputs. */
  atomic<T>(fn:()=>T):T {return this.transaction(fn);}
  private transaction<T>(fn:()=>T):T {
    // SAVEPOINTs let a higher-level action compose already-tested mutations
    // without exposing partially created Missions on an exception.
    const level=this.transactionDepth++;
    const savepoint=`relay_${level}`;
    try {
      this.db.exec(level===0?'BEGIN IMMEDIATE':`SAVEPOINT ${savepoint}`);
      try {
        const result=fn();
        this.db.exec(level===0?'COMMIT':`RELEASE SAVEPOINT ${savepoint}`);
        return result;
      }catch(error){
        if(level===0)this.db.exec('ROLLBACK');
        else this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`);
        throw error;
      }
    }finally{this.transactionDepth--;}
  }
  private raw(id: string): MissionRow {
    const r = this.db.prepare('SELECT * FROM missions WHERE id = ?').get(id) as MissionRow | undefined;
    if (!r) throw new Error(`Unknown mission: ${id}`);
    return r;
  }
  get(id: string): Mission { return fromRow(this.raw(id)); }
  // Millisecond timestamps can tie during batched Mission creation. SQLite
  // insertion rowid provides a deterministic newest-first tie breaker so
  // stable Telegram pages do not duplicate or omit Missions between reads.
  list(): Mission[] { return (this.db.prepare('SELECT * FROM missions ORDER BY created_at DESC, rowid DESC').all() as MissionRow[]).map(fromRow); }
  /** Archiving removes old settled tasks from the daily inbox, not the audit.
   * Never archive an ambiguous Send, an active PI checkpoint or a paused error. */
  isMissionArchived(id:string):boolean {
    return this.getMeta(`mission.archive.${id}`)!==null;
  }
  archiveSettledMissions():{archived:number;retained:number} {
    return this.transaction(()=>{
      let archived=0,retained=0;
      for(const m of this.list()){
        if(this.isMissionArchived(m.id))continue;
        const receipt=this.chatBrowserTurn(m.id),pi=this.piPlan(m.id);
        const safeReceipt=!receipt||['observed','reconciled'].includes(receipt.status);
        // pi.autopilot_finished also records LIMIT when a 32-turn PI NEXT
        // still needs a successor Mission. Presence of that event alone
        // NEVER proves the owner's goal is settled. The durable latest PI
        // plan is terminal only on an explicit DONE/BLOCKED decision.
        const terminalPi=pi&&['DONE','BLOCKED'].includes(pi.action);
        const terminalBrowser=/\[MISSION_RELAY:DONE\]\s*$/.test(m.lastSummary??'');
        const settled=['COMPLETED','CANCELLED'].includes(m.state)||
          (m.state==='PAUSED'&&!m.lastError&&!m.stopRequested&&
           this.pendingPiOwnerDirectives(m.id).length===0&&
           (terminalPi||
            (this.getMeta(`pi.autopilot.enabled.${m.id}`)!=='1'&&terminalBrowser)));
        if(!safeReceipt||!settled){retained++;continue;}
        const at=new Date().toISOString();
        this.setMeta(`mission.archive.${m.id}`,at);
        this.event(m.id,'mission.archived',{at,reason:'settled_history'});
        archived++;
      }
      return {archived,retained};
    });
  }
  events(id: string): MissionEvent[] {
    this.raw(id);
    return (this.db.prepare('SELECT * FROM events WHERE mission_id = ? ORDER BY id').all(id) as EventRow[])
      .map(x => ({ id: x.id, missionId: x.mission_id, createdAt: x.created_at, type: x.type, payload: JSON.parse(x.payload_json) as unknown }));
  }
  /** Count only durably observed Relay submissions in the current ChatGPT
   * conversation. A verified new-tab migration resets the counter; ambiguous
   * reservations never count as a completed turn. No new mutable cursor. */
  piChatObservedTurns(id:string):number {
    let count=0;
    for(const event of this.events(id)) {
      if(event.type==='chatgpt.browser_migrated'||event.type==='chatgpt.browser_rollover_recovered')
        count=0;
      if(['chatgpt.browser_observed','chatgpt.browser_turn_recovered',
        'chatgpt.browser_rollover_recovered'].includes(event.type))count++;
    }
    return count;
  }
  private event(id: string, type: string, payload: unknown): void {
    this.db.prepare('INSERT INTO events(mission_id,created_at,type,payload_json) VALUES (?,?,?,?)')
      .run(id, new Date().toISOString(), type, JSON.stringify(payload));
  }
  create(input: CreateMission): Mission {
    if (!input.goal.trim() || input.acceptance.length === 0 || input.acceptance.some(x => !x.trim())) throw new Error('Goal and acceptance criteria are required');
    if (!Number.isInteger(input.maxTurns) || input.maxTurns < 1 || input.maxTurns > 100) throw new Error('maxTurns must be between 1 and 100');
    if (!['read-only','workspace-write'].includes(input.sandbox)) throw new Error('Invalid sandbox');
    if (!['supervised','autopilot'].includes(input.mode)) throw new Error('Invalid mode');
    if (!input.requestKey.trim()) throw new Error('requestKey is required');
    for (const check of input.checks ?? []) {
      if (!Array.isArray(check.argv) || check.argv.length === 0 ||
        check.argv.some(x => typeof x !== 'string' || !x.trim()) ||
        check.argv.some(x => x.includes('\0')) ||
        !Number.isInteger(check.timeoutMs) || check.timeoutMs < 1000 || check.timeoutMs > 120000) {
        throw new Error('Invalid verification check: argv and timeoutMs (1000..120000) required');
      }
    }
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM missions WHERE request_key = ?').get(input.requestKey) as MissionRow | undefined;
      if (existing) {
        const previous = fromRow(existing);
        for (const key of ['goal','workspace','sandbox','mode','maxTurns'] as const) {
          if (previous[key] !== input[key]) throw new Error('Idempotency key reused for a different mission');
        }
        if (JSON.stringify(previous.acceptance) !== JSON.stringify(input.acceptance)) throw new Error('Idempotency key reused for different acceptance criteria');
        if (JSON.stringify(previous.checks) !== JSON.stringify(input.checks ?? [])) throw new Error('Idempotency key reused for different checks');
        return previous;
      }
      const id = randomUUID(), now = new Date().toISOString();
      this.db.prepare(`INSERT INTO missions (id,goal,acceptance_json,checks_json,workspace,sandbox,mode,max_turns,request_key,state,version,turn_count,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?, 'READY',0,0,?,?)`)
        .run(id,input.goal,JSON.stringify(input.acceptance),JSON.stringify(input.checks ?? []),input.workspace,input.sandbox,input.mode,input.maxTurns,input.requestKey,now,now);
      this.event(id,'mission.created',{ goal: input.goal, acceptance: input.acceptance, sandbox: input.sandbox });
      return this.get(id);
    });
  }
  /** Every state change and its audit event are committed in the same SQLite transaction. */
  update(id: string, expectedVersion: number, changes: Partial<Pick<Mission,
    'state'|'turnCount'|'threadId'|'nextInstruction'|'lastSummary'|'lastError'|'ownerPid'|'ownerHost'|'stopRequested'>>,
    eventType: string, payload: unknown = {}): Mission {
    const columns: Record<string,string> = {
      state:'state', turnCount:'turn_count',threadId:'thread_id',nextInstruction:'next_instruction',
      lastSummary:'last_summary',lastError:'last_error',ownerPid:'owner_pid',ownerHost:'owner_host',stopRequested:'stop_requested',
    };
    return this.transaction(() => {
      const current = this.get(id);
      if (current.version !== expectedVersion) throw new Error(`State conflict for ${id}: expected ${expectedVersion}, got ${current.version}`);
      const entries = Object.entries(changes);
      const fields = entries.map(([key]) => `${columns[key]} = ?`).join(', ');
      const values = entries.map(([,value]) => typeof value === 'boolean' ? Number(value) : value);
      this.db.prepare(`UPDATE missions SET ${fields ? fields + ', ' : ''}version=version+1, updated_at=? WHERE id=? AND version=?`)
        .run(...values,new Date().toISOString(),id,expectedVersion);
      this.event(id,eventType,payload);
      return this.get(id);
    });
  }
  acquire(id: string, expectedVersion?: number): Mission {
    const m = this.get(id);
    if (expectedVersion !== undefined && m.version !== expectedVersion)
      throw new Error(`State conflict for ${id}: expected ${expectedVersion}, got ${m.version}`);
    if (m.state !== 'READY') throw new Error(`Mission ${id} is ${m.state}; only READY missions may run`);
    return this.update(id,m.version,{state:'RUNNING',ownerPid:process.pid,ownerHost:hostname(),stopRequested:false},'mission.run_started',{pid:process.pid});
  }
  isOwnerAlive(m: Mission): boolean {
    if (m.ownerHost !== hostname() || m.ownerPid === null) return true;
    try { process.kill(m.ownerPid, 0); return true; }
    catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; }
  }
}
