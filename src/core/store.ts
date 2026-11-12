import { DatabaseSync } from 'node:sqlite';
import { randomUUID,createHash } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { hostname } from 'node:os';
import type { CreateMission, Mission, MissionEvent, MissionState, VerificationCheck } from './types.js';
import { normalizeChatGPTUrl } from './chatgpt-handoff.js';
import {MAX_RELAY_CHAT_TURNS} from './chat-limits.js';
import {missionTurnsRemaining,missionTurnLimitReached} from './mission-turns.js';
import type {RuntimeProvenance} from './runtime-provenance.js';

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
/** OS-local process identity from the enrolled Windows Scheduled Task. */
export interface ChannelWorkerProcessReadback {
  taskVerified:boolean;taskState:string;pollerPid:number;
  workerProcessVerified:boolean;
  workerProcessStartedAt:string|null;
  workerParentStartedAt:string|null;
}
export interface VerifiedChannelDrainProof {
  leaseFingerprint:string;
  expectedAttestedAt:string;
  inspectProcess:()=>ChannelWorkerProcessReadback;
}
export interface ChatBrowserTurn {
  requestKey:string; promptSha256:string; status:'reserved'|'observed'|'uncertain'|'reconciled';
  createdAt:string; urlHash:string; reservationRevision?:number;
  /** Reserved for a separately created ChatGPT conversation, not this chat. */
  newConversation?:boolean;
  assistantSha256?:string; observedAt?:string; error?:string;
}
export interface GoalPromptBinding {
  goalId:string;planId:string;itemId:string;itemVersion:number;
  piResponseSha256:string;piPlanSha256:string;
}
export interface PiOwnerDirective {
  id:number;externalId:string;text:string;
}
export type PiPlanAction='NEXT'|'DONE'|'BLOCKED'|'HANDOFF';
/** Exact old controller error caused by checking a successor's own observed
 * answer against its exhausted parent's different ChatGPT conversation. Only
 * a fresh, explicit, double-read browser hash attestation may clear it. */
export const PI_SUCCESSOR_CHECKPOINT_MISMATCH=
  'PI recovery refused: current Chrome user/assistant turns differ from the last durable receipt';

/** Only the old installed PI controller's exact exit-2 capacity error is
 * eligible for operator-attested checkpoint recovery. */
function isHistoricPiCapacityInterruption(error:string|null):boolean {
  // Keep recognizing the original deployed controller's prefixed error even
  // after the host/provider name changes. Only the exact structured
  // maintenance-capacity payload below can authorize this recovery path.
  const match=/^[a-zA-Z][a-zA-Z0-9 -]{0,48} PI inference failed \(SSH exit 2\); no browser retry\. /.exec(error??'');
  if(!match)return false;
  try {
    const parsed=JSON.parse(error!.slice(match[0].length)) as {ok?:unknown;error?:unknown};
    return parsed?.ok===false&&parsed.error==='Pi maintenance or a global task is active';
  }catch{return false;}
}

/** The ONLY old browser navigation failure that is control-flow-proven to
 * precede composer.fill() and Send.click(): submitNewChatTurn() invokes this
 * first, before ANY outgoing user message. Other errors/timeouts are never
 * permission to retry a possibly committed Send. */
export function isPreSendNewChatOriginNavigationTimeout(error:string|null|undefined):boolean{
  return typeof error==='string' &&
    error.startsWith('page.goto: Timeout 30000ms exceeded.\nCall log:\n') &&
    error.includes('navigating to "https://chatgpt.com/"') &&
    error.includes('waiting until "domcontentloaded"');
}
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
    try {
    this.db.exec('PRAGMA foreign_keys = ON');
    if(readOnly){
      // No implicit CREATE TABLE / schema upgrade / PRAGMA journal_mode
      // on live production state when the operator only asks for evidence.
      // Both file-open flags and query_only fence writes even if a future
      // diagnostic accidentally calls a mutating Store helper.
      this.db.exec('PRAGMA query_only = ON');
      const version=this.db.prepare('SELECT value FROM meta WHERE key = ?')
        .get('schema_version') as {value:string}|undefined;
      if(!['3','4','5'].includes(version?.value??''))
        throw new Error('Read-only PI diagnostic requires schema v3–v5; upgrade separately under maintenance');
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
    } else if (!['2','3','4','5'].includes(version.value)) throw new Error(`Unsupported database schema ${version.value}; upgrade explicitly`);
    const currentVersion=(this.db.prepare('SELECT value FROM meta WHERE key=?').get('schema_version') as {value:string}).value;
    if (currentVersion === '2') this.transaction(()=>{
      this.db.exec(`CREATE TABLE IF NOT EXISTS channel_commands (
        source TEXT NOT NULL,external_id TEXT NOT NULL,status TEXT NOT NULL,
        reply TEXT NOT NULL DEFAULT '',received_at TEXT NOT NULL,
        PRIMARY KEY(source,external_id)
      )`);
      this.db.prepare('UPDATE meta SET value=? WHERE key=?').run('3','schema_version');
    });
    // Goal management is additive: historical Mission IDs, browser reservations,
    // events and exact-prompt recovery records are not rewritten or backfilled.
    // The version update and every DDL statement commit or roll back together.
    if ((this.db.prepare('SELECT value FROM meta WHERE key=?').get('schema_version') as {value:string}).value === '3')
      this.transaction(()=>{
        this.db.exec(`
          CREATE TABLE goals (
            id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE,
            objective TEXT NOT NULL, priority INTEGER NOT NULL CHECK(priority BETWEEN 0 AND 100),
            status TEXT NOT NULL CHECK(status IN ('DRAFT','ACTIVE','PAUSED','BLOCKED')),
            version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL
          );
          CREATE TABLE goal_plans (
            id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES goals(id),
            request_key TEXT NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal > 0),
            summary TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('DRAFT','APPROVED','SUPERSEDED','CANCELLED')),
            version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
            UNIQUE(goal_id,request_key), UNIQUE(goal_id,ordinal),
            UNIQUE(id,goal_id)
          );
          CREATE UNIQUE INDEX goal_single_approved_plan ON goal_plans(goal_id) WHERE status='APPROVED';
          CREATE TABLE goal_work_items (
            id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES goals(id),
            plan_id TEXT NOT NULL REFERENCES goal_plans(id),
            item_key TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL,
            priority INTEGER NOT NULL CHECK(priority BETWEEN 0 AND 100),
            status TEXT NOT NULL CHECK(status IN
              ('PENDING','READY','IN_PROGRESS','REVIEW','PASSED','BLOCKED','FAILED')),
            evidence_json TEXT NOT NULL DEFAULT '[]',
            version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
            UNIQUE(plan_id,item_key), UNIQUE(id,goal_id,plan_id),
            FOREIGN KEY(plan_id,goal_id) REFERENCES goal_plans(id,goal_id)
          );
          CREATE TABLE goal_dependencies (
            goal_id TEXT NOT NULL, plan_id TEXT NOT NULL,
            item_id TEXT NOT NULL, depends_on_id TEXT NOT NULL,
            PRIMARY KEY(item_id,depends_on_id),
            CHECK(item_id <> depends_on_id),
            FOREIGN KEY(item_id,goal_id,plan_id) REFERENCES goal_work_items(id,goal_id,plan_id),
            FOREIGN KEY(depends_on_id,goal_id,plan_id) REFERENCES goal_work_items(id,goal_id,plan_id)
          );
          CREATE TABLE goal_acceptance (
            id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES goal_work_items(id),
            criterion TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('PENDING','PASS','PARTIAL','FAIL','BLOCKED')),
            evidence_json TEXT NOT NULL DEFAULT '[]',
            version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL
          );
          CREATE TABLE goal_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            goal_id TEXT NOT NULL REFERENCES goals(id),
            created_at TEXT NOT NULL, type TEXT NOT NULL,
            payload_json TEXT NOT NULL
          );
          CREATE INDEX goal_events_by_goal ON goal_events(goal_id,id);
          CREATE TRIGGER goal_events_no_update BEFORE UPDATE ON goal_events
            BEGIN SELECT RAISE(ABORT,'Goal audit events are append-only'); END;
          CREATE TRIGGER goal_events_no_delete BEFORE DELETE ON goal_events
            BEGIN SELECT RAISE(ABORT,'Goal audit events are append-only'); END;
          CREATE TABLE goal_operations (
            goal_id TEXT NOT NULL REFERENCES goals(id),
            operation_key TEXT NOT NULL, request_sha256 TEXT NOT NULL,
            result_json TEXT NOT NULL,
            PRIMARY KEY(goal_id,operation_key)
          );
        `);
        this.db.prepare('UPDATE meta SET value=? WHERE key=?').run('4','schema_version');
      });
    // WP5: additive release attestations. The v4 Goal and Mission rows,
    // including unobserved browser reservations, are not rewritten.
    if ((this.db.prepare('SELECT value FROM meta WHERE key=?').get('schema_version') as {value:string}).value === '4')
      this.transaction(()=>{
        this.db.exec(`
          CREATE TABLE goal_release_targets (
            goal_id TEXT PRIMARY KEY REFERENCES goals(id),
            target_sha TEXT NOT NULL, goal_version INTEGER NOT NULL,
            plan_id TEXT NOT NULL REFERENCES goal_plans(id),
            plan_version INTEGER NOT NULL, graph_sha256 TEXT NOT NULL,
            revision INTEGER NOT NULL CHECK(revision > 0),
            created_at TEXT NOT NULL
          );
          CREATE TABLE goal_release_checks (
            goal_id TEXT NOT NULL REFERENCES goal_release_targets(goal_id),
            requirement TEXT NOT NULL, target_sha TEXT NOT NULL,
            state TEXT NOT NULL CHECK(state IN ('PENDING','PASS','FAIL','BLOCKED')),
            source TEXT, reference TEXT, proof_sha256 TEXT,
            verified_at TEXT, expires_at TEXT, revision INTEGER NOT NULL,
            PRIMARY KEY(goal_id,requirement)
          );
          CREATE TABLE goal_release_completion (
            goal_id TEXT PRIMARY KEY REFERENCES goal_release_targets(goal_id),
            target_sha TEXT NOT NULL, graph_sha256 TEXT NOT NULL,
            completed_at TEXT NOT NULL, evidence_sha256 TEXT NOT NULL
          );
          CREATE TRIGGER goal_release_completion_no_update
            BEFORE UPDATE ON goal_release_completion
            BEGIN SELECT RAISE(ABORT,'Goal completion is immutable'); END;
          CREATE TRIGGER goal_release_completion_no_delete
            BEFORE DELETE ON goal_release_completion
            BEGIN SELECT RAISE(ABORT,'Goal completion is immutable'); END;
        `);
        this.db.prepare('UPDATE meta SET value=? WHERE key=?').run('5','schema_version');
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
    } catch(error) {
      // A failed in-place schema migration must release the SQLite handle,
      // particularly on Windows where an unclosed file blocks backup/restore.
      try { this.db.close(); } catch { /* Keep the original migration error. */ }
      throw error;
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
  /** Bind compiled Git/JS identity to the actual single, live worker lease.
   * Merely invoking the CLI in a second process cannot replace this record. */
  recordChannelRuntime(source:string,leaseKey:string,proof:RuntimeProvenance):void {
    this.transaction(()=>{
      const current=this.db.prepare(
        'SELECT owner_pid,owner_host,lease_key FROM channel_leases WHERE source=?'
      ).get(source) as {owner_pid:number;owner_host:string;lease_key:string}|undefined;
      if(!current||current.owner_pid!==process.pid||
         current.owner_host!==hostname()||current.lease_key!==leaseKey)
        throw new Error('Runtime attestation requires the current worker lease');
      if(!/^[0-9a-f]{40}$/.test(proof.sourceSha)||
         ![proof.compiledTreeSha256,proof.cliSha256,proof.manifestSha256]
           .every(value=>/^[0-9a-f]{64}$/.test(value))||
         !Number.isSafeInteger(proof.fileCount)||proof.fileCount<1)
        throw new Error('Malformed worker runtime provenance');
      this.setMeta(`${source}.runtime_provenance`,JSON.stringify({
        ...proof,pid:process.pid,at:new Date().toISOString(),
        leaseKeySha256:createHash('sha256').update(leaseKey).digest('hex'),
      }));
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
  /** Private lease generation fingerprint, never the raw lease key. */
  channelLeaseFingerprint(source:string):string|null {
    const row=this.db.prepare(
      'SELECT owner_pid,owner_host,lease_key FROM channel_leases WHERE source=?'
    ).get(source) as {owner_pid:number;owner_host:string;lease_key:string}|undefined;
    return row?createHash('sha256').update(JSON.stringify(
      [source,row.owner_pid,row.owner_host,row.lease_key])).digest('hex'):null;
  }
  releaseChannelDrain(source:string,drainId:string):void {
    this.transaction(()=>{
      const key=`${source}.maintenance.drain`;
      if(!drainId||this.getMeta(key)!==drainId)
        throw new Error('Channel maintenance lease mismatch: no change made');
      this.db.prepare('DELETE FROM meta WHERE key=?').run(key);
    });
  }
  /** Final upgrade admission is one SQLite write transaction, not an earlier
   * read-only Worker sample. A concurrent failed transport probe, lease
   * replacement, queued notification or Send reservation must win by keeping
   * the maintenance fence intact. Ordinary task restarts use the separate,
   * unverified release method above and cannot certify a source promotion. */
  releaseVerifiedChannelDrain(source:string,drainId:string,
    expectedSha:string,expectedPid:number,proof?:VerifiedChannelDrainProof,
    now=Date.now(),clock:()=>number=Date.now):void {
    this.transaction(()=>{
      const key=`${source}.maintenance.drain`;
      if(!drainId||this.getMeta(key)!==drainId||
        !/^[a-f0-9]{40}$/.test(expectedSha)||
        !Number.isSafeInteger(expectedPid)||expectedPid<=0||
        !proof||!/^[0-9a-f]{64}$/.test(proof.leaseFingerprint)||
        typeof proof.expectedAttestedAt!=='string'||
        typeof proof.inspectProcess!=='function')
        throw new Error('Verified maintenance release identity mismatch');
      const status=this.channelStatus(source),worker=status.runtimeProvenance;
      const lastSuccess=status.lastPollSuccessAt===null?NaN:
        Date.parse(status.lastPollSuccessAt);
      const expectedAttested=Date.parse(proof.expectedAttestedAt);
      if(!status.drainRequested||status.source!==source||
        !status.pollerPresent||status.pollerPid!==expectedPid||
        status.transportHealth!=='healthy'||
        !Number.isFinite(lastSuccess)||!Number.isFinite(now)||
        now-lastSuccess<0||now-lastSuccess>15_000||
        !worker||worker.pid!==expectedPid||worker.sourceSha!==expectedSha||
        !Number.isFinite(expectedAttested)||
        expectedAttested!==Date.parse(worker.at)||
        proof.leaseFingerprint!==this.channelLeaseFingerprint(source)||
        status.pendingReplies!==0||
        !Number.isSafeInteger(status.notificationsCursor)||
        !Number.isSafeInteger(status.lastEventId)||
        status.notificationsCursor!==status.lastEventId||
        this.channelHasInFlightWork(source))
        throw new Error('Verified maintenance release refused: Worker, transport or pending work changed');
      // A matching numeric PID, retained lease and recent heartbeat alone
      // cannot prove a Worker still exists: an OS PID can be recycled.
      // Sample the actual enrolled task and child process under the SQLite
      // write fence. Missing/equal-millisecond process birth rejects release.
      let identity:ChannelWorkerProcessReadback;
      try { identity=proof.inspectProcess(); }
      catch { throw new Error('Verified maintenance release refused: process identity unavailable'); }
      const workerBorn=Date.parse(identity?.workerProcessStartedAt??'');
      const parentBorn=Date.parse(identity?.workerParentStartedAt??'');
      if(!identity||identity.taskVerified!==true||
        identity.taskState!=='Running'||identity.workerProcessVerified!==true||
        identity.pollerPid!==expectedPid||
        typeof identity.workerProcessStartedAt!=='string'||
        typeof identity.workerParentStartedAt!=='string'||
        !Number.isFinite(workerBorn)||!Number.isFinite(parentBorn)||
        parentBorn>=workerBorn||workerBorn>=expectedAttested||
        workerBorn>now+30_000)
        throw new Error('Verified maintenance release refused: enrolled Worker process incarnation changed');
      // An OS/PowerShell readback can itself be slow. A heartbeat that was
      // fresh before the subprocess began may have expired by completion.
      const finalNow=clock();
      if(!Number.isFinite(finalNow)||finalNow-lastSuccess<0||
        finalNow-lastSuccess>15_000)
        throw new Error('Verified maintenance release refused: transport proof expired during process inspection');
      this.db.prepare('DELETE FROM meta WHERE key=?').run(key);
    });
  }
  /** Record a successful provider response without saving message contents or credentials. */
  recordChannelPollSuccess(source:string):void {
    this.setMeta(`${source}.poll_success`,JSON.stringify({
      pid:process.pid,at:new Date().toISOString(),
    }));
  }
  /** A fenced replacement's latest failed transport probe invalidates its
   * earlier successful heartbeat until a newer real success is observed. */
  recordChannelPollFailure(source:string):void {
    this.setMeta(`${source}.poll_failure`,JSON.stringify({
      pid:process.pid,at:new Date().toISOString(),
    }));
  }
  channelStatus(source:string):{
    source:string;inboxCursor:number;notificationsCursor:number;lastEventId:number;
    pendingReplies:number;pollerPid:number|null;pollerPresent:boolean;
    transportHealth:'offline'|'starting'|'healthy'|'stale'|'unhealthy';
    lastPollSuccessAt:string|null;
    lastIdleExit:{at:string;pid:number;elapsedMs:number;exitCode:75}|null;
    drainRequested:boolean;
    runtimeProvenance:(RuntimeProvenance&{pid:number;at:string})|null;
  } {
    const lease=this.db.prepare('SELECT owner_pid,owner_host,lease_key FROM channel_leases WHERE source=?').get(source) as
      {owner_pid:number;owner_host:string;lease_key:string}|undefined;
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
    let moreRecentFailure=false;
    if(pollerPresent){
      try{
        const raw=this.getMeta(`${source}.poll_failure`);
        if(raw!==null){
          const failure=JSON.parse(raw) as {pid?:unknown;at?:unknown}|null;
          if(!failure||typeof failure!=='object'||Array.isArray(failure)||
            !Number.isSafeInteger(failure.pid)||Number(failure.pid)<=0||
            typeof failure.at!=='string'||!Number.isFinite(Date.parse(failure.at))||
            Date.parse(failure.at)>Date.now()+30_000)
            moreRecentFailure=true;
          else if(failure.pid===lease?.owner_pid)
            moreRecentFailure=lastPollSuccessAt===null||
              Date.parse(failure.at)>=Date.parse(lastPollSuccessAt);
        }
      }catch { moreRecentFailure=true; }
    }
    const transportHealth=!pollerPresent?'offline':moreRecentFailure?'unhealthy':
      lastPollSuccessAt===null?'starting':age>=0 && age<=90_000?'healthy':'stale';
    let lastIdleExit:{at:string;pid:number;elapsedMs:number;exitCode:75}|null=null;
    try{
      const record=JSON.parse(this.getMeta(`${source}.last_idle_exit`)??'null') as
        {at?:unknown;pid?:unknown;elapsedMs?:unknown;exitCode?:unknown}|null;
      if(record&&typeof record.at==='string'&&Number.isFinite(Date.parse(record.at))&&
         Number.isSafeInteger(record.pid)&&Number.isSafeInteger(record.elapsedMs)&&
         Number(record.elapsedMs)>=300_000&&record.exitCode===75)
        lastIdleExit=record as {at:string;pid:number;elapsedMs:number;exitCode:75};
    }catch{/* Malformed diagnostic data is not evidence of a restart cause. */}
    let runtimeProvenance:(RuntimeProvenance&{pid:number;at:string})|null=null;
    if(pollerPresent){
      try{
        const candidate=JSON.parse(this.getMeta(`${source}.runtime_provenance`)??'null') as
          (RuntimeProvenance&{pid:number;at:string;leaseKeySha256:string})|null;
        if(candidate&&candidate.pid===lease?.owner_pid&&
           candidate.leaseKeySha256===
             createHash('sha256').update(lease.lease_key).digest('hex')&&
           typeof candidate.at==='string'&&Number.isFinite(Date.parse(candidate.at))&&
           /^[0-9a-f]{40}$/.test(candidate.sourceSha)&&
           [candidate.compiledTreeSha256,candidate.cliSha256,candidate.manifestSha256]
             .every(value=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value))&&
           Number.isSafeInteger(candidate.fileCount)&&candidate.fileCount>0)
          runtimeProvenance={
            sourceSha:candidate.sourceSha,
            compiledTreeSha256:candidate.compiledTreeSha256,
            cliSha256:candidate.cliSha256,
            manifestSha256:candidate.manifestSha256,
            fileCount:candidate.fileCount,
            pid:candidate.pid,at:candidate.at,
          };
      }catch{/* A stale or corrupted proof is not evidence of loaded code. */}
    }
    return {source,inboxCursor:Number(this.getMeta(`${source}.inbox_cursor`)||'0'),
      notificationsCursor:Number(this.getMeta(`${source}.notifications_cursor`)||'0'),
      lastEventId:this.maxEventId(),pendingReplies:pending,
      pollerPid:lease?.owner_pid??null,pollerPresent,
      transportHealth,lastPollSuccessAt,lastIdleExit,
      drainRequested:this.channelDrainRequested(source),runtimeProvenance};
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
      return (missionTurnsRemaining(m.maxTurns,m.turnCount)&&(!plan||['NEXT','HANDOFF'].includes(plan.action)))||
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
      const retryAfter=Number(this.getMeta(`pi.retry.after.${m.id}`)??'0');
      const phase=m.state==='NEEDS_RECONCILIATION'?'reconciliation_required_do_not_resend':
        this.isAbandonedBrowserReservation(m.id)?'dead_owner_reserved_inspect_only_do_not_resend':
        this.isAbandonedBrowserRolloverReservation(m.id)?
          'dead_owner_new_chat_reserved_inspect_only_do_not_resend':
        receipt?.status==='reserved'?'browser_answer_pending_do_not_resend':
        m.state==='READY'?'awaiting_controller_dispatch':
        m.state==='PAUSED'&&m.lastError?.startsWith('Corrected answer attribution awaits')?
          'corrected_answer_requires_pi_review':
        m.state==='PAUSED'&&m.lastError?'controller_interrupted':
        m.state==='PAUSED'&&this.getMeta(`pi.retry.sha.${m.id}`)===receipt?.assistantSha256&&
          this.getMeta(`pi.retry.request.${m.id}`)===receipt?.requestKey&&
          Number.isFinite(retryAfter)&&retryAfter>now&&
          ['pi.autopilot_retry_deferred','pi.browser_read_retry_deferred'].includes(last?.type??'')
          ?last?.type==='pi.browser_read_retry_deferred'
            ?'pi_browser_read_retry_deferred_no_send':'pi_inference_retry_deferred_no_send':
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
  /** Shared readback for normal settlement and BOTH independently inspected
   * recovery paths. A mutable receipt without its single original reservation
   * and still-owned Chat lock must never be credited, even after a crash. */
  private requireUnspentBrowserReservation(id:string,record:ChatBrowserTurn):void {
    const events=this.events(id);
    const reservations=events.filter(e=>e.type==='chatgpt.browser_reserved');
    const originals=reservations.filter(e=>
      (e.payload as {requestKey?:string}).requestKey===record.requestKey);
    const settled=events.some(e=>
      ['chatgpt.browser_observed','chatgpt.browser_turn_recovered',
        'chatgpt.browser_rollover_recovered'].includes(e.type)&&
      (e.payload as {requestKey?:string}).requestKey===record.requestKey);
    let lock:{missionId?:string;requestKey?:string}|null=null;
    try{lock=JSON.parse(this.getMeta(this.browserUrlLockKey(record.urlHash))??'null');}
    catch{/* Invalid lock never grants permission to settle. */}
    const linked=this.chatLink(id);
    if(originals.length!==1||reservations.at(-1)?.id!==originals[0]?.id||
      (originals[0]?.payload as {promptSha256?:string}).promptSha256!==record.promptSha256||
      !linked||createHash('sha256').update(linked).digest('hex')!==record.urlHash||
      lock?.missionId!==id||lock.requestKey!==record.requestKey||settled)
      throw new Error('Browser settlement lacks unique original reservation, chat lock or unspent evidence');
  }
  chatBrowserTurn(id:string):ChatBrowserTurn|null {
    this.raw(id);
    const value=this.getMeta(this.browserTurnKey(id));
    return value?JSON.parse(value) as ChatBrowserTurn:null;
  }
  /** Exactly one UI Retry intent per immutable browser request, including
   * across Worker death. The intent is committed BEFORE the external click:
   * an interrupted click may never be repeated blindly. This does not reserve
   * another Send, clear the original lock, or credit an answer. */
  hasDeliveryRetryIntent(id:string,requestKey:string,promptSha256:string):boolean {
    const saved=this.getMeta(`chatgpt.browser.delivery_retry.${id}.${requestKey}`);
    if(saved===null)return false;
    let intent:unknown;
    try{intent=JSON.parse(saved);}catch{throw new Error('Corrupted delivery Retry intent');}
    const value=intent as {requestKey?:string;promptSha256?:string}|null;
    if(!value||value.requestKey!==requestKey||value.promptSha256!==promptSha256)
      throw new Error('Delivery Retry intent does not match original request');
    return true;
  }
  claimDeliveryRetryIntent(id:string,requestKey:string,promptSha256:string,
    reason:'delivery-timeout'|'stream-error'='delivery-timeout'):boolean {
    return this.transaction(()=>{
      const m=this.get(id),record=this.chatBrowserTurn(id);
      if(this.channelDrainRequested('telegram')||m.stopRequested||
        !record||record.requestKey!==requestKey||record.promptSha256!==promptSha256||
        !((m.state==='RUNNING'&&record.status==='reserved')||
          (m.state==='NEEDS_RECONCILIATION'&&record.status==='uncertain'&&
            record.newConversation!==true&&
            m.lastError==='ChatGPT response observation timed out; submission outcome is ambiguous')))
        throw new Error('Delivery Retry requires the original active or timed-out request');
      this.requireUnspentBrowserReservation(id,record);
      if(this.hasDeliveryRetryIntent(id,requestKey,promptSha256))return false;
      this.setMeta(`chatgpt.browser.delivery_retry.${id}.${requestKey}`,
        JSON.stringify({requestKey,promptSha256,reason,at:new Date().toISOString()}));
      this.event(id,'chatgpt.browser_delivery_retry_intent',{
        requestKey,promptSha256,round:m.turnCount+1,
        reason,mode:'same-message-ui-retry',sendAgain:false});
      return true;
    });
  }
  recordDeliveryRetryClicked(id:string,requestKey:string,promptSha256:string):void {
    this.transaction(()=>{
      if(!this.hasDeliveryRetryIntent(id,requestKey,promptSha256))
        throw new Error('Delivery Retry click lacks its durable intent');
      if(this.events(id).some(e=>e.type==='chatgpt.browser_delivery_retry_clicked'&&
        (e.payload as {requestKey?:string}).requestKey===requestKey))return;
      this.event(id,'chatgpt.browser_delivery_retry_clicked',{
        requestKey,mode:'same-message-ui-retry',sendAgain:false});
    });
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
  /** A new-chat reservation from a definitely exited SAME-host owner can be
   * inspected separately from an uncertain rollover. This is never authority
   * to replay Send, adopt a URL by its name alone, or interrupt a live worker. */
  isAbandonedBrowserRolloverReservation(id:string):boolean {
    const m=this.get(id),receipt=this.chatBrowserTurn(id);
    return m.state==='RUNNING'&&receipt?.status==='reserved'&&
      receipt.newConversation===true&&m.ownerPid!==null&&m.ownerPid>0&&
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
        m.turnCount<1||missionTurnLimitReached(m.maxTurns,m.turnCount)||m.lastError||
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
  /** A narrowly scoped, append-only repair of an incorrect PI recovery
   * interruption. The caller MUST first independently inspect the pinned
   * live browser, twice, proving BOTH original user/assistant SHA-256s.
   * This method cannot send a browser request, forge a PI plan, change an
   * observed turn, or release an owner pause. The normal controller makes
   * its own third read before any later Send. */
  clearVerifiedPiSuccessorMismatch(id:string,revision:number,input:{
    requestPromptSha256:string;assistantSha256:string;
  }):Mission {
    return this.transaction(()=>{
      const m=this.get(id),receipt=this.chatBrowserTurn(id),plan=this.piPlan(id);
      if(m.version!==revision)
        throw new Error(`State conflict: expected v${revision}, current v${m.version}`);
      if(this.getMeta(`pi.autopilot.enabled.${id}`)!=='1'||
        m.state!=='PAUSED'||m.stopRequested||m.ownerPid!==null||
        m.lastError!==PI_SUCCESSOR_CHECKPOINT_MISMATCH||
        m.turnCount<1||!this.piChainParent(id)||
        !receipt||!this.hasVerifiedPiBrowserCheckpoint(id)||
        receipt.promptSha256!==input.requestPromptSha256||
        receipt.assistantSha256!==input.assistantSha256||
        !this.chatLink(id)||!this.chatBrowserBinding(id)||
        plan?.round===m.turnCount||
        this.channelDrainRequested('telegram')||
        !this.goalContinuationEligible(id))
        throw new Error('PI successor recovery requires the same settled, unpaused, independently verified original checkpoint');
      const parent=this.get(this.piChainParent(id)!);
      if(parent.stopRequested||parent.lastError)
        throw new Error('PI successor parent has an unresolved stop or error');
      if(m.sandbox==='workspace-write'&&
        (this.getMeta('telegram.build.project')!==m.workspace||
         this.getMeta('telegram.pi.project')!==m.workspace))
        throw new Error('PI build approval changed or was revoked; cannot recover');
      return this.update(id,revision,{lastError:null},
        'pi.autopilot_checkpoint_revalidated',{
          round:m.turnCount,requestPromptSha256:receipt.promptSha256,
          assistantSha256:receipt.assistantSha256,
          requiresIndependentBrowserReadback:true,
          reason:'fixed_successor_parent_receipt_selection',
        });
    });
  }
  /** Operator-attested one-time clearing of a LEGACY capacity interruption.
   * The current Worker must independently read Chrome again and rerun only
   * PI inference. Neither this method nor its CLI issues a browser Send. */
  clearHistoricPiCapacityInterruption(id:string,revision:number,input:{
    requestPromptSha256:string;assistantSha256:string;
  }):Mission {
    return this.transaction(()=>{
      const m=this.get(id),receipt=this.chatBrowserTurn(id),plan=this.piPlan(id);
      const events=this.events(id);
      const interrupted=events.at(-1),invocation=events.at(-2),observed=events.at(-3);
      const interruption=(interrupted?.payload??{}) as {reason?:unknown};
      const intent=(invocation?.payload??{}) as {round?:unknown;responseSha256?:unknown};
      const observation=(observed?.payload??{}) as {round?:unknown;assistantSha256?:unknown;
        requestKey?:unknown};
      if(m.version!==revision||m.state!=='PAUSED'||m.stopRequested||
        m.ownerPid!==null||m.turnCount<1||missionTurnLimitReached(m.maxTurns,m.turnCount)||
        !isHistoricPiCapacityInterruption(m.lastError)||
        this.getMeta(`pi.autopilot.enabled.${id}`)!=='1'||
        this.channelDrainRequested('telegram')||!this.goalContinuationEligible(id)||
        !receipt||receipt.status!=='observed'||!this.hasVerifiedPiBrowserCheckpoint(id)||
        !this.chatLink(id)||!this.chatBrowserBinding(id)||
        receipt.promptSha256!==input.requestPromptSha256||
        receipt.assistantSha256!==input.assistantSha256||
        plan?.round===m.turnCount||
        interrupted?.type!=='pi.autopilot_interrupted'||interruption.reason!==m.lastError||
        invocation?.type!=='pi.default_model_invocation_intent'||
        intent.round!==m.turnCount||intent.responseSha256!==receipt.assistantSha256||
        observed?.type!=='chatgpt.browser_observed'||
        observation.round!==m.turnCount||observation.assistantSha256!==receipt.assistantSha256||
        observation.requestKey!==receipt.requestKey||
        this.piChainParent(id)&&this.get(this.piChainParent(id)!).stopRequested||
        m.sandbox==='workspace-write'&&
          (this.getMeta('telegram.build.project')!==m.workspace||
           this.getMeta('telegram.pi.project')!==m.workspace))
        throw new Error('PI capacity recovery requires the exact settled, unpaused original inference interruption');
      return this.update(id,revision,{lastError:null},
        'pi.autopilot_capacity_revalidated',{
          interruptedEventId:interrupted.id,invocationEventId:invocation.id,
          round:m.turnCount,requestKey:receipt.requestKey,
          requestPromptSha256:receipt.promptSha256,
          assistantSha256:receipt.assistantSha256,
          requiresIndependentBrowserReadback:true,
          noBrowserSend:true,
        });
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
    options:{newConversation?:boolean;promptSnapshot?:{
      format:'goal-work-v1';prompt:string;
    };goalBinding?:GoalPromptBinding}={}):Mission {
    if(!/^[\w.-]{1,128}$/.test(requestKey)) throw new Error('Browser request key must be 1–128 safe characters');
    if(!/^[0-9a-f]{64}$/.test(promptSha256)) throw new Error('Expected SHA-256 of browser prompt');
    const snapshot=options.promptSnapshot;
    if(snapshot && (snapshot.format!=='goal-work-v1'||
      !snapshot.prompt.trim()||snapshot.prompt.length>12000||
      createHash('sha256').update(snapshot.prompt.trim()).digest('hex')!==promptSha256))
      throw new Error('Versioned browser prompt snapshot must match its exact reserved SHA-256');
    if(Boolean(snapshot)!==Boolean(options.goalBinding))
      throw new Error('Goal work prompt snapshot and versioned Goal binding must be recorded together');
    return this.transaction(()=>{
      if(this.channelDrainRequested('telegram'))
        throw new Error('Telegram maintenance drain active; new browser Sends are refused');
      const m=this.get(id);
      const url=this.chatLink(id);
      if(!url) throw new Error('Mission has no linked ChatGPT conversation');
      // A release completion is an immutable dispatch fence, not merely a
      // status label. Enforce it at the lowest-level browser reservation path
      // so a legacy/manual Send cannot race a successfully finalized Goal.
      let goalCursor:string|null=id,completedGoal:string|null=null;
      const ancestry=new Set<string>();
      while(goalCursor&&!completedGoal){
        if(ancestry.has(goalCursor))throw new Error('PI Goal binding lineage cycle');
        ancestry.add(goalCursor);
        completedGoal=this.getMeta(`goal.pi.binding.${goalCursor}`);
        goalCursor=this.piChainParent(goalCursor);
      }
      if(completedGoal&&this.db.prepare(
        'SELECT 1 FROM goal_release_completion WHERE goal_id=?').get(completedGoal))
        throw new Error('Goal release completed; further browser Sends are prohibited');
      if(m.version!==revision) throw new Error(`State conflict: expected v${revision}, current v${m.version}`);
      if(!['READY','PAUSED'].includes(m.state)) throw new Error(`Cannot run browser turn in state ${m.state}`);
      if(m.stopRequested) throw new Error('Mission has a pending pause request; resume explicitly before another browser turn');
      if(missionTurnLimitReached(m.maxTurns,m.turnCount)) throw new Error('Browser mission turn budget exhausted');
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
      if(options.goalBinding){
        const binding=options.goalBinding;
        let cursor:string|null=id,linked:string|null=null;
        const seen=new Set<string>();
        while(cursor&&!linked){
          if(seen.has(cursor))throw new Error('PI Goal binding lineage cycle');
          seen.add(cursor);
          linked=this.getMeta(`goal.pi.binding.${cursor}`);
          cursor=this.piChainParent(cursor);
        }
        const pi=this.piPlan(id)??(this.piChainParent(id)?
          this.piPlan(this.piChainParent(id)!):null);
        const row=this.db.prepare(`SELECT w.version,w.status,
          p.status AS plan_status,g.status AS goal_status,g.objective
          FROM goal_work_items w JOIN goal_plans p ON p.id=w.plan_id
          JOIN goals g ON g.id=w.goal_id
          WHERE w.id=? AND w.goal_id=? AND w.plan_id=?`)
          .get(binding.itemId,binding.goalId,binding.planId) as
          {version:number;status:string;plan_status:string;goal_status:string;objective:string}|undefined;
        if(linked!==binding.goalId||!row||row.objective!==m.goal.trim()||
          row.version!==binding.itemVersion||
          !['IN_PROGRESS','REVIEW'].includes(row.status)||
          row.plan_status!=='APPROVED'||row.goal_status!=='ACTIVE'||
          !pi||pi.responseSha256!==binding.piResponseSha256||
          createHash('sha256').update(JSON.stringify(pi)).digest('hex')!==binding.piPlanSha256||
          this.pendingPiOwnerDirectives(id).length)
          throw new Error('Goal work package or PI checkpoint changed before Send reservation');
      }
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
          parent.stopRequested||parent.lastError||(parent.maxTurns===0||parent.turnCount!==parent.maxTurns)||
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
      if(snapshot){
        // Private SQLite, same atomic reservation. History is immutable:
        // snapshots never re-render from mutable Goal/Plan state.
        const key=`chatgpt.browser.prompt.${id}.${requestKey}`;
        if(this.getMeta(key)!==null)throw new Error('Versioned prompt already recorded');
        this.setMeta(key,JSON.stringify(snapshot));
      }
      this.db.prepare('UPDATE missions SET state=?,owner_pid=?,owner_host=?,version=version+1,updated_at=? WHERE id=? AND version=?')
        .run('RUNNING',process.pid,hostname(),record.createdAt,id,m.version);
      this.event(id,'chatgpt.browser_reserved',{requestKey,promptSha256,
        ...(snapshot?{promptFormat:snapshot.format,
          goalId:options.goalBinding!.goalId,
          planId:options.goalBinding!.planId,
          workItemId:options.goalBinding!.itemId,
          workItemVersion:options.goalBinding!.itemVersion,
          piResponseSha256:options.goalBinding!.piResponseSha256,
          piPlanSha256:options.goalBinding!.piPlanSha256}:{})});
      return this.get(id);
    });
  }
  /** Read-only exact reconstruction for versioned Sends. Historical pre-WP3
   * reservations have no snapshot and use the original hash-checked builder.
   * A corrupt present snapshot is a hard failure, NEVER a fallback. */
  reservedBrowserPrompt(id:string,requestKey:string):{
    format:'goal-work-v1';prompt:string;
  }|null {
    const record=this.chatBrowserTurn(id);
    if(!record||record.requestKey!==requestKey)
      throw new Error('No matching active browser receipt for prompt reconstruction');
    const saved=this.getMeta(`chatgpt.browser.prompt.${id}.${requestKey}`);
    if(saved===null)return null;
    let parsed:unknown;
    try{parsed=JSON.parse(saved);}catch{
      throw new Error('Corrupted versioned prompt snapshot: invalid JSON');
    }
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))
      throw new Error('Corrupted versioned prompt snapshot');
    const value=parsed as {format?:unknown;prompt?:unknown};
    if(value.format!=='goal-work-v1'||typeof value.prompt!=='string'||
      !value.prompt.trim()||value.prompt.length>12000||
      createHash('sha256').update(value.prompt.trim()).digest('hex')!==record.promptSha256)
      throw new Error('Versioned prompt snapshot does not match original reservation SHA');
    return {format:value.format,prompt:value.prompt};
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
      // A process-local reply is not sufficient evidence to settle a Send.
      // Validate its immutable reservation and the durable conversation lock
      // in the same SQLite transaction that credits the answer. A stale worker,
      // duplicate observer or corrupted receipt must never gain a second turn.
      this.requireUnspentBrowserReservation(id,record);
      if(outcome.kind==='observed'&&!/^[0-9a-f]{64}$/.test(outcome.assistantSha256??''))
        throw new Error('Browser observation requires a complete SHA-256 answer');
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
      if(migratedUrl&&this.list().some(other=>other.id!==id&&
        this.chatLink(other.id)===migratedUrl&&
        !['CANCELLED','COMPLETED'].includes(other.state)))
        throw new Error('New ChatGPT destination belongs to another active Mission');
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
  /** Persist a rejected observation separately from turn credit. This is an
   * immutable, de-duplicated quarantine record, NEVER a browser reservation,
   * PI decision or recovery authorization. Only hashes and event IDs leave
   * the controller; no prompt, answer, request key or URL is logged. */
  quarantineBrowserObservation(id:string,input:{
    requestKey:string;promptSha256:string;assistantSha256:string;
    reason:'settlement-rejected'|'unattributed-observation';
  }):number {
    if(!input.requestKey||input.requestKey.length>128||
      !/^[0-9a-f]{64}$/.test(input.promptSha256)||
      !/^[0-9a-f]{64}$/.test(input.assistantSha256))
      throw new Error('Quarantine needs bounded request identity and exact evidence hashes');
    return this.transaction(()=>{
      const requestSha256=createHash('sha256').update(input.requestKey).digest('hex');
      const fingerprint=createHash('sha256').update(JSON.stringify({
        requestSha256,promptSha256:input.promptSha256,
        assistantSha256:input.assistantSha256,reason:input.reason,
      })).digest('hex');
      const existing=this.events(id).find(e=>e.type==='chatgpt.browser_observation_quarantined'&&
        (e.payload as {fingerprint?:string}).fingerprint===fingerprint);
      if(existing)return existing.id;
      const reservation=this.events(id).filter(e=>e.type==='chatgpt.browser_reserved'&&
        (e.payload as {requestKey?:string;promptSha256?:string}).requestKey===input.requestKey&&
        (e.payload as {promptSha256?:string}).promptSha256===input.promptSha256);
      this.event(id,'chatgpt.browser_observation_quarantined',{
        fingerprint,requestSha256,promptSha256:input.promptSha256,
        assistantSha256:input.assistantSha256,reason:input.reason,
        reservationEventId:reservation.length===1?reservation[0]!.id:null,
        status:'UNATTRIBUTED_NO_CREDIT',
      });
      return this.events(id).at(-1)!.id;
    });
  }
  /** Independent ledger preflight BEFORE closing a same-Mission Page. The
   * caller must additionally retain the actual Relay-created Page object,
   * verify its current URL and read back isClosed() after attempting close. */
  private ownedTabRetirementEvidence(id:string,oldUrl:string,newUrl:string):{
    retiredUrlSha256:string;activeUrlSha256:string;
    migrationEventId:number;observedEventId:number;
  }|null {
    const oldLink=normalizeChatGPTUrl(oldUrl),newLink=normalizeChatGPTUrl(newUrl);
    const hash=(url:string)=>createHash('sha256').update(url).digest('hex');
    const oldSha=hash(oldLink),newSha=hash(newLink);
    const events=this.events(id);
    const migration=events.filter(e=>e.type==='chatgpt.browser_migrated').at(-1);
    const p=migration?.payload as {previousUrlSha256?:string;newUrlSha256?:string;requestKey?:string}|undefined;
    const observed=events.find(e=>e.id>(migration?.id??Number.MAX_SAFE_INTEGER)&&
      e.type==='chatgpt.browser_observed'&&
      (e.payload as {requestKey?:string}).requestKey===p?.requestKey);
    const origin=events.filter(e=>e.id<(migration?.id??0)&&
      e.type==='chatgpt.browser_migrated'&&
      (e.payload as {newUrlSha256?:string}).newUrlSha256===oldSha).at(-1);
    const originReply=origin&&events.find(e=>e.id>origin.id&&e.id<(migration?.id??Infinity)&&
      e.type==='chatgpt.browser_observed'&&
      (e.payload as {requestKey?:string}).requestKey===
        (origin.payload as {requestKey?:string}).requestKey);
    const originalReservation=events.filter(e=>e.id<(migration?.id??Infinity)&&
      e.type==='chatgpt.browser_reserved'&&
      (e.payload as {requestKey?:string}).requestKey===p?.requestKey);
    const receipt=this.chatBrowserTurn(id);
    if(oldSha===newSha||this.chatLink(id)!==newLink||
      !migration||!observed||!origin||!originReply||originalReservation.length!==1||
      originalReservation[0]!.id>=migration.id||
      p?.previousUrlSha256!==oldSha||p.newUrlSha256!==newSha||
      receipt?.status!=='observed'||receipt.requestKey!==p.requestKey||
      receipt.assistantSha256!==(observed.payload as {assistantSha256?:string}).assistantSha256||
      this.list().some(m=>m.id!==id&&this.chatLink(m.id)===oldLink&&
        !['COMPLETED','CANCELLED'].includes(m.state))||
      events.some(e=>e.type==='chatgpt.browser_tab_retired'&&
        (e.payload as {retiredUrlSha256?:string}).retiredUrlSha256===oldSha))
      return null;
    return {retiredUrlSha256:oldSha,activeUrlSha256:newSha,
      migrationEventId:migration.id,observedEventId:observed.id};
  }
  canRetireOwnedChatTab(id:string,oldUrl:string,newUrl:string):boolean {
    return this.ownedTabRetirementEvidence(id,oldUrl,newUrl)!==null;
  }
  /** After the in-memory Page confirms isClosed(), recheck custody inside
   * the write transaction and append one hashed retirement receipt. Never
   * backfill a close for an unknown, detached or user-created tab. */
  recordOwnedChatTabRetired(id:string,oldUrl:string,newUrl:string):void {
    this.transaction(()=>{
      const evidence=this.ownedTabRetirementEvidence(id,oldUrl,newUrl);
      if(!evidence&&this.events(id).some(e=>e.type==='chatgpt.browser_tab_retired'&&
        (e.payload as {retiredUrlSha256?:string}).retiredUrlSha256===
          createHash('sha256').update(normalizeChatGPTUrl(oldUrl)).digest('hex')))
        throw new Error('This Relay-owned tab already has a retirement receipt');
      if(!evidence)
        throw new Error('Tab retirement requires a completed migration from a previously Relay-created tab and no earlier retirement receipt');
      this.event(id,'chatgpt.browser_tab_retired',evidence);
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
          .run(now,'Original browser attempt reconciled without a verified answer. No turn credited; PI cannot continue from an unverified checkpoint. A separately verified recovery or a new owner-authorized Goal is required.',id,m.version);
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
  /** One-shot operator-initiated FIRST actual Send after a provably pre-Send
   * old navigation timeout. This records intent BEFORE any Chrome side
   * effect and never turns the uncertain receipt into a fake observation.
   * The external caller must re-read the pinned OLD source prompt+answer
   * twice, check for any connected destination already holding the reserved
   * prompt, and use only the original immutable prompt snapshot. A failure
   * after this intent must be inspected, never automatically repeated. */
  authorizePreSendRolloverOnce(id:string,revision:number,input:{
    originalPromptSha256:string;sourcePromptSha256:string;
    sourceAnswerSha256:string;
  }):{missionId:string;revision:number;intentEventId:number}{
    return this.transaction(()=>{
      const m=this.get(id),r=this.chatBrowserTurn(id),url=this.chatLink(id),
        plan=this.piPlan(id),events=this.events(id);
      if(m.version!==revision||m.state!=='NEEDS_RECONCILIATION'||
        m.ownerPid!==null||m.stopRequested||m.turnCount<1||
        missionTurnLimitReached(m.maxTurns,m.turnCount)||!r||r.status!=='uncertain'||
        r.newConversation!==true||!url||!this.chatBrowserBinding(id)||
        r.urlHash!==createHash('sha256').update(url).digest('hex')||
        r.promptSha256!==input.originalPromptSha256||
        !isPreSendNewChatOriginNavigationTimeout(m.lastError)||
        m.lastError!==r.error||
        !plan||plan.round!==m.turnCount||
        !['NEXT','HANDOFF'].includes(plan.action)||
        this.getMeta(`pi.autopilot.enabled.${id}`)!=='1'||
        this.pendingPiOwnerDirectives(id).length>0||
        this.channelDrainRequested('telegram')||
        !this.goalContinuationEligible(id))
        throw new Error('One-shot pre-Send recovery requires the exact old navigation timeout and an active, settled PI continuation');
      // A new conversation is mandatory after five observed sends; do not
      // grant this recovery for an existing-chat or premature rollover.
      if(this.piChatObservedTurns(id)<MAX_RELAY_CHAT_TURNS)
        throw new Error('Pre-Send new-chat recovery requires the exhausted original ChatGPT segment');
      this.requireUnspentBrowserReservation(id,r);
      const uncertain=events.filter(e=>e.type==='chatgpt.browser_uncertain'&&
        (e.payload as {requestKey?:string}).requestKey===r.requestKey);
      const previous=events.filter(e=>e.type==='chatgpt.browser_observed'&&
        (e.payload as {round?:number}).round===m.turnCount).at(-1);
      const previousKey=(previous?.payload as {requestKey?:string}|undefined)?.requestKey;
      const priorSend=events.find(e=>e.type==='chatgpt.browser_reserved'&&
        (e.payload as {requestKey?:string}).requestKey===previousKey);
      const previousAnswer=(previous?.payload as {assistantSha256?:string}|undefined)?.assistantSha256;
      const previousPrompt=(priorSend?.payload as {promptSha256?:string}|undefined)?.promptSha256;
      if(uncertain.length!==1||!previous||!priorSend||
        previous.id>=uncertain[0]!.id||priorSend.id>=previous.id||
        previousAnswer!==input.sourceAnswerSha256||
        previousPrompt!==input.sourcePromptSha256||
        plan.responseSha256!==previousAnswer||
        events.some(e=>e.type==='chatgpt.browser_pre_send_retry_intent'&&
          (e.payload as {requestKey?:string}).requestKey===r.requestKey))
        throw new Error('Pre-Send recovery has no unique prior source proof or has already been attempted');
      if(m.sandbox==='workspace-write'&&
        (this.getMeta('telegram.build.project')!==m.workspace||
         this.getMeta('telegram.pi.project')!==m.workspace))
        throw new Error('Approved PI workspace was revoked; pre-Send recovery refused');
      this.event(id,'chatgpt.browser_pre_send_retry_intent',{
        requestKey:r.requestKey,originalPromptSha256:r.promptSha256,
        priorRound:m.turnCount,priorReservationEventId:priorSend.id,
        priorObservationEventId:previous.id,
        priorAssistantSha256:previousAnswer,
        failure:'original_chatgpt_origin_navigation_timeout_before_send',
        maxAttempts:1,noExistingSendClicked:true,
        originalUncertainEvidencePreserved:true,
      });
      return {missionId:id,revision:m.version,
        intentEventId:this.events(id).at(-1)!.id};
    });
  }
  /** Operator-confirmed recovery of a rollover whose first Send succeeded but
   * its browser observer failed or the original owner exited before recording
   * uncertainty. The caller must independently verify the
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
      const uncertain=m.state==='NEEDS_RECONCILIATION'&&record?.status==='uncertain';
      const deadReserved=this.isAbandonedBrowserRolloverReservation(id);
      // Preserve the historical, separately verified uncertain-recovery
      // contract (older reservations did not persist newConversation intent).
      // Only the NEW dead-owner reserved branch requires that intent bit.
      if(!record||(!uncertain&&!deadReserved)||!oldUrl)
        throw new Error('Only an uncertain or dead-owner reserved new-chat migration may be recovered as observed');
      if(m.ownerPid!==null&&this.isOwnerAlive(m))throw new Error('A browser owner may still be active');
      if(missionTurnLimitReached(m.maxTurns,m.turnCount))throw new Error('Recovery would exceed the authorized Mission turn budget');
      if(record.promptSha256!==input.requestPromptSha256||oldUrl===destination)
        throw new Error('Rollover request hash mismatch or destination is not a new conversation');
      this.requireUnspentBrowserReservation(id,record);
      if(deadReserved&&(
        createHash('sha256').update(input.summary).digest('hex')!==input.assistantSha256||
        !/(?:^|\n)\[MISSION_RELAY:(?:NEXT|DONE|BLOCKED|HANDOFF)\]\s*$/.test(input.summary)))
        throw new Error('Dead-owner rollover recovery requires the complete SHA-matched final-marked answer');
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
      this.event(id,'mission.reconciled',{acknowledged:true,
        kind:deadReserved?'observed-dead-owner-rollover-reservation':'observed-browser-rollover'});
      this.event(id,'chatgpt.browser_rollover_recovered',{
        requestKey:record.requestKey,round:m.turnCount+1,
        assistantSha256:input.assistantSha256,excerpt:input.summary.slice(-1000),
        previousUrlSha256:createHash('sha256').update(oldUrl).digest('hex'),
        newUrlSha256:createHash('sha256').update(destination).digest('hex'),
        independentlyInspected:true,
        ...(deadReserved?{recoverySource:'dead-owner-reserved',
          originalReservationPreserved:true,originalUncertainEventPreserved:false}:{}),
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
      if(missionTurnLimitReached(m.maxTurns,m.turnCount))throw new Error('Recovery exceeds the authorized turn budget');
      if(record.promptSha256!==input.requestPromptSha256||
        record.urlHash!==createHash('sha256').update(url).digest('hex'))
        throw new Error('Observed reply cannot be linked to the exact original reserved prompt and chat');
      this.requireUnspentBrowserReservation(id,record);
      if(deadReserved){
        if(createHash('sha256').update(input.summary).digest('hex')!==input.assistantSha256||
          !/(?:^|\n)\[MISSION_RELAY:(?:NEXT|DONE|BLOCKED|HANDOFF)\]\s*$/.test(input.summary))
          throw new Error('Dead-owner recovery requires the complete SHA-matched final-marked answer');
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
      // A new authenticated note addressing a just-exhausted Goal Mission
      // belongs to its verified successor, not the historical 32/32 parent.
      // Materialize/reuse ONLY an eligible Goal continuation; never wake an
      // explicitly paused, terminal, or unbound historical Mission.
      if((m.maxTurns>0&&m.turnCount===m.maxTurns)&&m.state==='PAUSED'&&!m.stopRequested&&
        !m.lastError&&plan?.round===m.maxTurns&&
        ['NEXT','HANDOFF'].includes(plan.action)&&
        this.getMeta(`pi.autopilot.enabled.${id}`)==='1'&&
        this.goalContinuationEligible(id)){
        const child=this.createPiSuccessor(id);
        if(child)return this.queuePiOwnerDirective(child.id,externalId,text);
      }
      if(plan?.round===m.turnCount &&
        (['DONE','BLOCKED'].includes(plan.action)||missionTurnLimitReached(m.maxTurns,m.turnCount)))
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
  /** Records the caller's configured remote PI inference intent, NOT a
   * claimed successful remote inference or the remote system's selected model.
   * No credential, host, prompt, model name or provider is stored. */
  auditPiDefaultModelInvocation(id:string,round:number,responseSha256:string,
    policy:{argvSha256:string;modelOverride:false;
      providerOverride:false;thinkingOverride:false}):void {
    if(!Number.isInteger(round)||round<0||
      !/^[a-f0-9]{64}$/.test(responseSha256)||
      !/^[a-f0-9]{64}$/.test(policy.argvSha256)||
      policy.modelOverride!==false||policy.providerOverride!==false||
      policy.thinkingOverride!==false)
      throw new Error('PI inference must inherit the configured remote default model');
    this.transaction(()=>{
      const mission=this.get(id),receipt=this.chatBrowserTurn(id);
      const ownCheckpoint=mission.state==='PAUSED'&&!mission.stopRequested&&
        mission.turnCount===round&&receipt?.assistantSha256===responseSha256&&
        this.hasVerifiedPiBrowserCheckpoint(id);
      const adoption=round===0&&mission.turnCount===0&&mission.state==='PAUSED'&&
        !mission.stopRequested&&this.chatAdoption(id)?.assistantSha256===responseSha256;
      const parentId=round===0?this.piChainParent(id):null;
      const parent=parentId?this.get(parentId):null;
      const parentPlan=parentId?this.piPlan(parentId):null;
      const inherited=round===0&&mission.state==='READY'&&!mission.stopRequested&&
        mission.turnCount===0&&!receipt&&!!parentId&&
        parent?.state==='PAUSED'&&!parent.stopRequested&&!parent.lastError&&
        (parent.maxTurns>0&&parent.turnCount===parent.maxTurns)&&
        this.piChainSuccessor(parentId)===id&&
        parentPlan?.round===parent.maxTurns&&
        ['NEXT','HANDOFF'].includes(parentPlan.action)&&
        parentPlan.responseSha256===responseSha256&&
        this.chatBrowserTurn(parentId)?.assistantSha256===responseSha256&&
        this.hasVerifiedPiBrowserCheckpoint(parentId);
      if(!ownCheckpoint&&!adoption&&!inherited)
        throw new Error('PI invocation intent requires a verified, unchanged browser checkpoint');
      const exists=this.events(id).some(e=>e.type==='pi.default_model_invocation_intent'&&
        (e.payload as {round?:number;responseSha256?:string;argvSha256?:string}).round===round&&
        (e.payload as {responseSha256?:string}).responseSha256===responseSha256&&
        (e.payload as {argvSha256?:string}).argvSha256===policy.argvSha256);
      if(!exists)this.event(id,'pi.default_model_invocation_intent',{
        round,responseSha256,argvSha256:policy.argvSha256,
        modelOverride:false,thinkingOverride:false,providerOverride:false,
        status:'intent_not_remote_result',
      });
    });
  }
  piChainParent(id:string):string|null {
    this.raw(id);
    return this.getMeta(`pi.chain.parent.${id}`);
  }
  piChainSuccessor(id:string):string|null {
    this.raw(id);
    return this.getMeta(`pi.chain.successor.${id}`);
  }
  /** A 32-turn LIMIT is not authority to keep running a Goal that was later
   * completed, blocked or superseded. Check the CURRENT approved work inside
   * the same SQLite transaction that creates its successor. Legacy unbound
   * Missions keep their original continuation protocol. */
  private goalContinuationEligible(id:string):boolean {
    let cursor:string|null=id;
    const seen=new Set<string>();
    while(cursor){
      if(seen.has(cursor))throw new Error('Goal PI Mission lineage cycle');
      seen.add(cursor);
      const goalId=this.getMeta(`goal.pi.binding.${cursor}`);
      if(goalId){
        const goal=this.db.prepare('SELECT objective,status FROM goals WHERE id=?')
          .get(goalId) as {objective:string;status:string}|undefined;
        if(!goal||goal.status!=='ACTIVE'||goal.objective!==this.get(id).goal.trim()||
          this.db.prepare('SELECT 1 FROM goal_release_completion WHERE goal_id=?')
            .get(goalId))return false;
        const active=this.db.prepare(`SELECT w.id FROM goal_work_items w
          JOIN goal_plans p ON p.id=w.plan_id AND p.goal_id=w.goal_id
          WHERE w.goal_id=? AND p.status='APPROVED'
            AND w.status IN ('IN_PROGRESS','REVIEW')`).all(goalId);
        return active.length===1;
      }
      cursor=this.piChainParent(cursor);
    }
    return true;
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
        (parent.maxTurns===0||parent.turnCount!==parent.maxTurns)||parent.state!=='PAUSED'||
        parent.stopRequested||parent.lastError||plan?.round!==parent.maxTurns||
        !['NEXT','HANDOFF'].includes(plan.action))return null;
      if(!this.hasVerifiedPiBrowserCheckpoint(id)||
        this.chatBrowserTurn(id)?.assistantSha256!==plan.responseSha256||
        !this.events(id).some(e=>e.type==='pi.autopilot_finished'&&
          (e.payload as {action?:string}).action==='LIMIT'))return null;
      const existing=this.piChainSuccessor(id);
      if(existing)return this.get(existing);
      if(!this.goalContinuationEligible(id))return null;
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
      if(parent.stopRequested||parent.lastError||(parent.maxTurns===0||parent.turnCount!==parent.maxTurns)||
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
      if(['DONE','BLOCKED'].includes(plan.action)||missionTurnLimitReached(m.maxTurns,m.turnCount)){
        this.event(id,'pi.autopilot_finished',{action:missionTurnLimitReached(m.maxTurns,m.turnCount)&&['NEXT','HANDOFF'].includes(plan.action)
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
    if (!Number.isInteger(input.maxTurns) || input.maxTurns < 0 || input.maxTurns > 100) throw new Error('maxTurns must be zero (unbounded) or between 1 and 100');
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
