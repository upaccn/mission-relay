import { DatabaseSync } from 'node:sqlite';
import { randomUUID,createHash } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { hostname } from 'node:os';
import type { CreateMission, Mission, MissionEvent, MissionState, VerificationCheck } from './types.js';
import { normalizeChatGPTUrl } from './chatgpt-handoff.js';

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
  constructor(filename: string) {
    if (filename !== ':memory:') {
      mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(filename, { timeout: 5000 });
    this.db.exec('PRAGMA foreign_keys = ON');
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
    return Boolean(active||piReady||pending||reserved);
  }
  /** Only the CURRENT local lease owner may abandon a stalled, fully idle
   * channel. No drain is created: a task-managed restart must not inherit a
   * persistent maintenance fence. Malformed receipts fail closed. */
  canAbandonStalledChannel(source:string):boolean {
    const owner=this.db.prepare('SELECT owner_pid,owner_host FROM channel_leases WHERE source=?')
      .get(source) as {owner_pid:number;owner_host:string}|undefined;
    if(!owner||owner.owner_pid!==process.pid||owner.owner_host!==hostname()||
       this.channelDrainRequested(source)||this.channelHasInFlightWork(source))return false;
    const cursor=this.getMeta(`${source}.notifications_cursor`);
    if(cursor===null||!/^(0|[1-9]\d*)$/.test(cursor)||
       !Number.isSafeInteger(Number(cursor))||Number(cursor)<this.maxEventId())return false;
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
      if(!['chatgpt.browser_turn_recovered','chatgpt.browser_rollover_recovered'].includes(event.type))
        return false;
      const evidence=event.payload as {requestKey?:unknown;assistantSha256?:unknown;
        round?:unknown;independentlyInspected?:unknown}|null;
      return evidence?.requestKey===receipt.requestKey &&
        evidence.assistantSha256===receipt.assistantSha256 &&
        evidence.round===round && evidence.independentlyInspected===true;
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
  reserveChatBrowserTurn(id:string,revision:number,requestKey:string,promptSha256:string):Mission {
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
      if(this.getMeta(`chatgpt.browser.request.${id}.${requestKey}`)) throw new Error('Browser request key already used; never resend');
      const prior=this.chatBrowserTurn(id);
      if(prior && ['reserved','uncertain'].includes(prior.status))
        throw new Error('Previous browser turn may have been submitted; reconcile before another send');
      const urlHash=createHash('sha256').update(url).digest('hex');
      if(this.getMeta(this.browserUrlLockKey(urlHash)))
        throw new Error('Another Mission owns the active ChatGPT conversation; inspect and reconcile before sending');
      const record:ChatBrowserTurn={requestKey,promptSha256,urlHash,status:'reserved',
        reservationRevision:revision,createdAt:new Date().toISOString()};
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
          stop_requested=0,version=version+1,updated_at=?,
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
      const now=new Date().toISOString();
      this.setMeta(`chatgpt.handoff.${id}`,destination);
      this.setMeta(this.browserTurnKey(id),JSON.stringify({...record,status:'reconciled',
        assistantSha256:input.assistantSha256,observedAt:now}));
      this.db.prepare('DELETE FROM meta WHERE key=?').run(this.browserUrlLockKey(record.urlHash));
      this.db.prepare(`UPDATE missions SET state='PAUSED',owner_pid=NULL,owner_host=NULL,
        turn_count=turn_count+1,last_summary=?,last_error=NULL,stop_requested=0,
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
  /** Recover an *already submitted* existing-tab reply after a false timeout
   * or obsolete load-error observation. The CLI must independently re-read
   * the exact sent prompt and stable complete answer; no Send is permitted.
   * Preserve the uncertain history while granting only one observed turn. */
  recoverObservedBrowserTurn(id:string,revision:number,input:{
    requestPromptSha256:string;assistantSha256:string;summary:string;
  }):Mission {
    if(!/^[0-9a-f]{64}$/.test(input.requestPromptSha256)||
      !/^[0-9a-f]{64}$/.test(input.assistantSha256)||!input.summary.trim())
      throw new Error('Existing-chat recovery requires validated prompt/assistant hashes and a nonempty reply');
    return this.transaction(()=>{
      const m=this.get(id),record=this.chatBrowserTurn(id),url=this.chatLink(id);
      if(m.version!==revision)throw new Error(`State conflict: expected v${revision}, current v${m.version}`);
      if(m.state!=='NEEDS_RECONCILIATION'||record?.status!=='uncertain'||!url)
        throw new Error('Only an uncertain existing-chat browser turn can be recovered');
      if(m.ownerPid!==null&&this.isOwnerAlive(m))throw new Error('Browser owner may still be active');
      if(m.turnCount>=m.maxTurns)throw new Error('Recovery exceeds the authorized turn budget');
      if(record.promptSha256!==input.requestPromptSha256||
        record.urlHash!==createHash('sha256').update(url).digest('hex'))
        throw new Error('Observed reply cannot be linked to the exact original reserved prompt and chat');
      const now=new Date().toISOString();
      this.setMeta(this.browserTurnKey(id),JSON.stringify({...record,status:'reconciled',
        assistantSha256:input.assistantSha256,observedAt:now}));
      this.db.prepare('DELETE FROM meta WHERE key=?').run(this.browserUrlLockKey(record.urlHash));
      this.db.prepare(`UPDATE missions SET state='PAUSED',owner_pid=NULL,owner_host=NULL,
        turn_count=turn_count+1,last_summary=?,last_error=NULL,stop_requested=0,
        version=version+1,updated_at=? WHERE id=? AND version=?`)
        .run(input.summary.slice(-1000),now,id,m.version);
      this.event(id,'mission.reconciled',{acknowledged:true,kind:'observed-browser-turn'});
      this.event(id,'chatgpt.browser_turn_recovered',{
        requestKey:record.requestKey,round:m.turnCount+1,
        assistantSha256:input.assistantSha256,excerpt:input.summary.slice(-1000),
        independentlyInspected:true,originalUncertainEventPreserved:true,
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
      if(previous?.round===m.turnCount &&
        (!replaceExisting||!['NEXT','HANDOFF'].includes(previous.action)||
          reviewedDirectiveIds.length===0))
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
      this.event(id,replaceExisting?'pi.decision_revised':'pi.decision',{
        action:plan.action,round:m.turnCount,
        summary:plan.summary,
        responseSha256:expectedSha,nextPromptSha256:createHash('sha256').update(plan.nextPrompt).digest('hex'),
        directivesReviewed:reviewedDirectiveIds.length});
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
  list(): Mission[] { return (this.db.prepare('SELECT * FROM missions ORDER BY created_at DESC').all() as MissionRow[]).map(fromRow); }
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
