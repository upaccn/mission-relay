import { DatabaseSync } from 'node:sqlite';
import { randomUUID,createHash } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { hostname } from 'node:os';
import type { CreateMission, Mission, MissionEvent, MissionState, VerificationCheck } from './types.js';
import { normalizeChatGPTUrl } from './chatgpt-handoff.js';
import {MAX_RELAY_CHAT_TURNS,MAX_CONVERSATION_LENGTH_ERROR} from './chat-limits.js';
import {isApprovedBuildRepository,declaredSourceMatchesScope,hasIsolatedRepositoryGrant} from './build-scopes.js';
import type {RuntimeProvenance} from './runtime-provenance.js';
import {hasFinalMissionRelayMarker,missionRelayMarker} from './mission-marker.js';

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
  /** The settled receipt this reservation replaced; restored if the Send is never attempted. */
  previous?:Omit<ChatBrowserTurn,'previous'>;
}
export interface GoalPromptBinding {
  goalId:string;planId:string;itemId:string;itemVersion:number;
  piResponseSha256:string;piPlanSha256:string;
}
export interface PiOwnerDirective {
  id:number;externalId:string;text:string;
}
export type PiPlanAction='NEXT'|'DONE'|'BLOCKED'|'HANDOFF';
/** The live Chat no longer matches the last durable receipt. Only an explicit
 * double-read (`recover --retry`) may clear it; nothing is ever resent. */
export const PI_CHECKPOINT_MISMATCH=
  'PI recovery refused: current Chrome user/assistant turns differ from the last durable receipt';
/** The pre-Send history check found a changed Chat; no request was reserved. */
export const PI_NEXT_SOURCE_PREFLIGHT_ERROR=
  'PI next browser Send refused: visible ChatGPT history differs from the last observed receipt';


export interface PiPlan {
  action:PiPlanAction;summary:string;nextPrompt:string;responseSha256:string;
  round:number;reviewedDirectiveIds:number[];
}

function fromRow(r: MissionRow): Mission {
  return {
    id: r.id, goal: r.goal, acceptance: JSON.parse(r.acceptance_json) as string[],
    checks: JSON.parse(r.checks_json) as VerificationCheck[],
    workspace: r.workspace, sandbox: r.sandbox, mode: r.mode,
    requestKey: r.request_key, state: r.state,
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
    // Additive: a Goal is DONE when PI's review accepted its final work package
    // (owner decision 2026-11-22). One immutable row per Goal. The retired
    // goal_release_* tables stay in the v5 schema, unused and empty.
    this.db.exec(`CREATE TABLE IF NOT EXISTS goal_completions (
      goal_id TEXT PRIMARY KEY REFERENCES goals(id),
      mission_id TEXT NOT NULL, plan_id TEXT NOT NULL,
      response_sha256 TEXT NOT NULL, summary TEXT NOT NULL, completed_at TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS goal_completions_no_update BEFORE UPDATE ON goal_completions
      BEGIN SELECT RAISE(ABORT,'Goal completion is immutable'); END;`);
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
      id:string;state:Mission['state'];turnCount:number;
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
      return !plan||['NEXT','HANDOFF'].includes(plan.action)||
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
      return {id:m.id,state:m.state,turnCount:m.turnCount,
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
      const uncertain=record?.status==='uncertain'&&m.state==='NEEDS_RECONCILIATION'&&
        m.ownerPid===null&&m.lastError===record.error;
      const oldChatTimeout=uncertain&&record?.newConversation!==true&&
        m.lastError==='ChatGPT response observation timed out; submission outcome is ambiguous';
      const newChatTimeout=uncertain&&record?.newConversation===true&&
        m.lastError==='New ChatGPT reply observation timed out; creation outcome is ambiguous'&&
        this.chatBrowserBinding(id)!==null&&this.chatLink(id)!==null&&
        record.urlHash===createHash('sha256').update(this.chatLink(id)!).digest('hex');
      // An owner pause defers Retry instead of converting the original
      // in-flight Send into a misleading generic exception.
      if(m.stopRequested)return false;
      if(this.channelDrainRequested('telegram')||
        !record||record.requestKey!==requestKey||record.promptSha256!==promptSha256||
        !((m.state==='RUNNING'&&record.status==='reserved')||oldChatTimeout||newChatTimeout))
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
  /** A timed-out original UI Retry may itself fail. Permit at most two MORE
   * distinct same-message UI Retry attempts, never another composer Send.
   * Each follow-up gets its own committed intent before a click; a crash
   * between intent and click consumes that allowance permanently. */
  claimDeliveryRetryFollowupIntent(id:string,requestKey:string,promptSha256:string,
    reason:'delivery-timeout'|'stream-error',nowMs=Date.now()):number|null {
    return this.transaction(()=>{
      const m=this.get(id),r=this.chatBrowserTurn(id);
      const active=m.state==='RUNNING'&&r?.status==='reserved';
      const uncertain=m.state==='NEEDS_RECONCILIATION'&&r?.status==='uncertain'&&
        m.ownerPid===null&&
        m.lastError==='ChatGPT response observation timed out; submission outcome is ambiguous';
      if((!active&&!uncertain)||
        m.stopRequested||this.channelDrainRequested('telegram')||
        !r||r.newConversation===true||
        r.requestKey!==requestKey||r.promptSha256!==promptSha256||
        !this.hasDeliveryRetryIntent(id,requestKey,promptSha256))
        return null;
      this.requireUnspentBrowserReservation(id,r);
      const clicked=this.events(id).filter(e=>
        e.type==='chatgpt.browser_delivery_retry_clicked'&&
        (e.payload as {requestKey?:string}).requestKey===requestKey);
      if(clicked.length!==1)return null;
      const key=`chatgpt.browser.delivery_retry_followup.${id}.${requestKey}`;
      const raw=this.getMeta(key);
      const prev=raw?JSON.parse(raw) as {
        attempt:number;requestKey:string;promptSha256:string;atMs:number;
      }:null;
      if(prev&&(prev.requestKey!==requestKey||prev.promptSha256!==promptSha256||
        ![2,3].includes(prev.attempt)||!Number.isSafeInteger(prev.atMs)))
        throw new Error('Corrupted follow-up delivery Retry history');
      const prior=prev?this.events(id).filter(e=>
        e.type==='chatgpt.browser_delivery_retry_followup_clicked'&&
        (e.payload as {requestKey?:string;attempt?:number}).requestKey===requestKey&&
        (e.payload as {attempt?:number}).attempt===prev.attempt):clicked;
      if(prior.length!==1)return null;
      const lastClickedAt=prev?.atMs??Date.parse(clicked[0]!.createdAt);
      // A fresh retry may still be generating/settling. A failed UI status
      // must persist beyond a conservative cooling period before repeating.
      if(!Number.isFinite(lastClickedAt)||nowMs-lastClickedAt<120_000)return null;
      if(prev?.attempt===3){
        if(!this.events(id).some(e=>
          e.type==='chatgpt.browser_delivery_retry_exhausted'&&
          (e.payload as {requestKey?:string}).requestKey===requestKey))
          this.event(id,'chatgpt.browser_delivery_retry_exhausted',{
            requestKey,attempts:3,originalSendPreserved:true,
            action:'owner_attention_after_bounded_same_message_retries'});
        return null;
      }
      const attempt=(prev?.attempt??1)+1;
      this.setMeta(key,JSON.stringify({attempt,requestKey,promptSha256,atMs:nowMs}));
      this.event(id,'chatgpt.browser_delivery_retry_followup_intent',{
        requestKey,promptSha256,attempt,reason,
        mode:'same-message-ui-retry',sendAgain:false});
      return attempt;
    });
  }
  recordDeliveryRetryFollowupClicked(id:string,requestKey:string,
    promptSha256:string,attempt:number):void {
    this.transaction(()=>{
      const saved=this.getMeta(`chatgpt.browser.delivery_retry_followup.${id}.${requestKey}`);
      const value=saved?JSON.parse(saved) as {
        attempt?:number;requestKey?:string;promptSha256?:string;
      }:null;
      if(value?.attempt!==attempt||value.requestKey!==requestKey||
        value.promptSha256!==promptSha256)
        throw new Error('Follow-up Retry click lacks matching durable intent');
      if(this.events(id).some(e=>
        e.type==='chatgpt.browser_delivery_retry_followup_clicked'&&
        (e.payload as {requestKey?:string;attempt?:number}).requestKey===requestKey&&
        (e.payload as {attempt?:number}).attempt===attempt))return;
      this.event(id,'chatgpt.browser_delivery_retry_followup_clicked',{
        requestKey,attempt,mode:'same-message-ui-retry',sendAgain:false});
    });
  }
  /** Native ChatGPT 'Start new chat' is a DIFFERENT side effect from
   * delivery Retry and never replays an original composer Send. This only
   * authorizes the one visible platform button after the original request
   * has ended uncertain; its incomplete result is never credited as a turn.
   * An explicitly paused request requires an operator-acknowledged call.
   * Record intent BEFORE click, preserving original lock and provenance. */
  claimConversationLengthStartIntent(id:string,revision:number,
    requestKey:string,promptSha256:string,allowPaused=false):boolean {
    return this.transaction(()=>{
      const m=this.get(id),r=this.chatBrowserTurn(id);
      const link=this.chatLink(id),plan=this.piPlan(id);
      if(m.version!==revision||this.channelDrainRequested('telegram')||
        m.state!=='NEEDS_RECONCILIATION'||m.ownerPid!==null||
        (allowPaused&&!m.stopRequested)||
        (m.stopRequested&&!allowPaused)||
        !r||r.status!=='uncertain'||r.newConversation===true||
        r.requestKey!==requestKey||r.promptSha256!==promptSha256||
        r.error!==m.lastError||
        ![MAX_CONVERSATION_LENGTH_ERROR,
          'ChatGPT response observation timed out; submission outcome is ambiguous'].includes(m.lastError??'')||
        !link||r.urlHash!==createHash('sha256').update(link).digest('hex')||
        !this.chatBrowserBinding(id)||
        this.getMeta(`pi.autopilot.enabled.${id}`)!=='1'||
        m.turnCount<1||plan?.round!==m.turnCount||
        !['NEXT','HANDOFF'].includes(plan.action)||
        !this.events(id).some(e=>
          ['chatgpt.browser_observed','chatgpt.browser_turn_recovered',
           'chatgpt.browser_rollover_recovered'].includes(e.type)&&
          (e.payload as {round?:number;assistantSha256?:string}).round===m.turnCount&&
          (e.payload as {assistantSha256?:string}).assistantSha256===plan.responseSha256)||
        this.pendingPiOwnerDirectives(id).length>0||
        (m.sandbox==='workspace-write'&&
          (!hasIsolatedRepositoryGrant(this,m.workspace)||
           !declaredSourceMatchesScope(m.goal,m.workspace))))
        throw new Error('Start new chat requires the original stopped, verified PI continuation and unchanged repository grant');
      this.requireUnspentBrowserReservation(id,r);
      const key=`chatgpt.browser.length_start.${id}.${requestKey}`;
      if(this.getMeta(key)!==null)return false;
      this.setMeta(key,JSON.stringify({
        requestKey,promptSha256,at:new Date().toISOString(),
        ownerAcknowledgedPause:allowPaused&&m.stopRequested,
      }));
      this.event(id,'chatgpt.browser_length_start_intent',{
        requestKey,promptSha256,round:m.turnCount+1,
        nativeUiOnly:true,composerSend:false,originalAnswerCredited:false});
      return true;
    });
  }
  recordConversationLengthStartClicked(id:string,requestKey:string,promptSha256:string):void {
    this.transaction(()=>{
      const raw=this.getMeta(`chatgpt.browser.length_start.${id}.${requestKey}`);
      let saved:{requestKey?:string;promptSha256?:string}|null=null;
      try{saved=raw?JSON.parse(raw) as {requestKey?:string;promptSha256?:string}:null;}
      catch{/* fail closed */ }
      if(saved?.requestKey!==requestKey||saved.promptSha256!==promptSha256)
        throw new Error('Start new chat click lacks its original one-shot intent');
      if(this.events(id).some(e=>e.type==='chatgpt.browser_length_start_clicked'&&
        (e.payload as {requestKey?:string}).requestKey===requestKey))return;
      this.event(id,'chatgpt.browser_length_start_clicked',{
        requestKey,originalAnswerCredited:false,composerSend:false,
        originalRequestPreserved:true});
    });
  }
  /** Owner-authorized, one-time FIRST Send of the *existing unsent draft*
   * carried by ChatGPT's native maximum-length button. This is not a
   * retry of the old chat: the old failed request is credited only if a
   * distinct new conversation later yields independent, stable evidence.
   * The browser caller must prove a unique empty origin and SHA-matched
   * draft twice, and must commit this intent BEFORE the UI Send click. */
  claimNativePrefilledSendIntent(id:string,revision:number,
    requestKey:string,promptSha256:string,unpausedWorker=false):boolean {
    return this.transaction(()=>{
      const m=this.get(id),r=this.chatBrowserTurn(id),url=this.chatLink(id);
      const events=this.events(id),plan=this.piPlan(id);
      if(m.version!==revision||m.state!=='NEEDS_RECONCILIATION'||
        (unpausedWorker?m.stopRequested:!m.stopRequested)||
        m.ownerPid!==null||this.channelDrainRequested('telegram')||
        r?.status!=='uncertain'||r.newConversation===true||
        r.requestKey!==requestKey||r.promptSha256!==promptSha256||
        ![MAX_CONVERSATION_LENGTH_ERROR,
          'ChatGPT response observation timed out; submission outcome is ambiguous'].includes(m.lastError??'')||
        m.lastError!==r.error||!url||
        r.urlHash!==createHash('sha256').update(url).digest('hex')||
        !this.chatBrowserBinding(id)||m.turnCount<1||
        this.getMeta(`pi.autopilot.enabled.${id}`)!=='1'||
        plan?.round!==m.turnCount||!['NEXT','HANDOFF'].includes(plan.action)||
        this.pendingPiOwnerDirectives(id).length>0||
        (m.sandbox==='workspace-write'&&
          (!hasIsolatedRepositoryGrant(this,m.workspace)||
            !declaredSourceMatchesScope(m.goal,m.workspace)))||
        !events.some(e=>e.type==='chatgpt.browser_length_start_clicked'&&
          (e.payload as {requestKey?:string}).requestKey===requestKey)||
        events.filter(e=>e.type==='chatgpt.browser_length_start_intent'&&
          (e.payload as {requestKey?:string}).requestKey===requestKey).length!==1)
        throw new Error('Native draft Send requires owner-paused original request, matching PI plan, scope and one verified Start new chat');
      const snapshot=this.reservedBrowserPrompt(id,requestKey);
      if(!snapshot||createHash('sha256').update(snapshot.prompt.trim()).digest('hex')!==promptSha256)
        throw new Error('Native draft Send requires the unchanged versioned original prompt snapshot');
      this.requireUnspentBrowserReservation(id,r);
      const key=`chatgpt.browser.native_prefilled_send.${id}.${requestKey}`;
      if(this.getMeta(key)!==null)return false;
      this.setMeta(key,JSON.stringify({requestKey,promptSha256,at:new Date().toISOString()}));
      this.event(id,'chatgpt.browser_native_prefilled_send_intent',{
        requestKey,promptSha256,round:m.turnCount+1,
        nativeDraft:true,oneShot:true,unpausedWorker,
        originalReservationPreserved:true,
        originalAnswerCredited:false});
      return true;
    });
  }
  /** A completed click is NOT a completed ChatGPT reply. On ambiguous UI
   * outcome the existing intent blocks all further Send attempts. */
  recordNativePrefilledSendClicked(id:string,requestKey:string,promptSha256:string):void {
    this.transaction(()=>{
      const raw=this.getMeta(`chatgpt.browser.native_prefilled_send.${id}.${requestKey}`);
      let intent:{requestKey?:string;promptSha256?:string}|null=null;
      try{intent=raw?JSON.parse(raw) as {requestKey?:string;promptSha256?:string}:null;}
      catch{/* deny */}
      if(intent?.requestKey!==requestKey||intent.promptSha256!==promptSha256)
        throw new Error('Native draft Send lacks matching pre-committed one-shot intent');
      if(this.events(id).some(e=>e.type==='chatgpt.browser_native_prefilled_send_clicked'&&
        (e.payload as {requestKey?:string}).requestKey===requestKey))return;
      this.event(id,'chatgpt.browser_native_prefilled_send_clicked',{
        requestKey,composerSendOnce:true,newConversationNotYetVerified:true,
        originalAnswerCredited:false});
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
      if(!['chatgpt.browser_turn_recovered','chatgpt.browser_rollover_recovered'].includes(event.type))
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
        m.turnCount<1||m.lastError||
        !receipt||!this.hasVerifiedPiBrowserCheckpoint(id)||
        (plan?.round===m.turnCount&&['DONE','BLOCKED'].includes(plan.action)))
        throw new Error('PI resume requires an owner-paused, settled, nonterminal browser checkpoint');
      if(m.sandbox==='workspace-write'&&
        (!isApprovedBuildRepository(this,m.workspace)||
         !hasIsolatedRepositoryGrant(this,m.workspace)||
         !declaredSourceMatchesScope(m.goal,m.workspace)))
        throw new Error('PI repository approval was revoked or no longer matches its isolated Goal scope');
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
  /** Operator `recover --retry`: clear the error of a PI Mission parked at a
   * SETTLED checkpoint (observed or reconciled receipt, no Send in flight)
   * after the caller re-read the live tab twice and both SHAs match the
   * receipt. Only the error is cleared; the single Worker then re-reads the
   * tab again before any further step. No Send, no PI decision, no owner
   * pause release. */
  clearSettledPiInterruption(id:string,revision:number,input:{
    requestPromptSha256:string;assistantSha256:string;
  }):Mission {
    return this.transaction(()=>{
      const m=this.get(id),receipt=this.chatBrowserTurn(id);
      if(m.version!==revision||m.state!=='PAUSED'||m.stopRequested||
        m.ownerPid!==null||!m.lastError||
        this.getMeta(`pi.autopilot.enabled.${id}`)!=='1'||
        this.channelDrainRequested('telegram')||
        !receipt||!['observed','reconciled'].includes(receipt.status)||
        receipt.promptSha256!==input.requestPromptSha256||
        receipt.assistantSha256!==input.assistantSha256||
        !this.hasVerifiedPiBrowserCheckpoint(id)||
        !this.chatLink(id)||!this.chatBrowserBinding(id)||
        (m.sandbox==='workspace-write'&&
          (!isApprovedBuildRepository(this,m.workspace)||
           !hasIsolatedRepositoryGrant(this,m.workspace)||
           !declaredSourceMatchesScope(m.goal,m.workspace))))
        throw new Error('Retry requires a PI Mission paused by an error at a settled, verified checkpoint');
      return this.update(id,revision,{lastError:null},'pi.interruption_cleared',{
        clearedError:m.lastError.slice(0,300),round:m.turnCount,requestKey:receipt.requestKey,
        assistantSha256:receipt.assistantSha256,requiresIndependentBrowserReadback:true,
        noBrowserSend:true,
      });
    });
  }
  /** Operator `recover --abandon`: settle an uncertain (or dead-owner reserved)
   * request WITHOUT crediting any answer, end the Mission and mark its Goal
   * BLOCKED so the owner continues it with /goal-continue. Never replays. */
  abandonUncertainRequest(id:string,revision:number):Mission {
    return this.transaction(()=>{
      const m=this.get(id);
      if(m.version!==revision)throw new Error(`State conflict: expected v${revision}, current v${m.version}`);
      const reconciled=this.reconcileChatBrowserTurn(id);
      const ended=this.update(id,reconciled.version,{state:'CANCELLED',ownerPid:null,ownerHost:null,
        lastError:'Operator abandoned an unverifiable request; continue the Goal with /goal-continue'},
        'mission.request_abandoned',{noAnswerCredited:true,noReplay:true});
      const goalId=this.getMeta(`goal.pi.binding.${id}`);
      if(goalId){
        const goal=this.db.prepare('SELECT status,version FROM goals WHERE id=?').get(goalId) as
          {status:string;version:number}|undefined;
        if(goal&&['ACTIVE','PAUSED'].includes(goal.status)){
          const at=new Date().toISOString();
          this.db.prepare("UPDATE goals SET status='BLOCKED',version=version+1,updated_at=? WHERE id=?")
            .run(at,goalId);
          this.db.prepare('INSERT INTO goal_events(goal_id,created_at,type,payload_json) VALUES(?,?,?,?)')
            .run(goalId,at,'goal.status',JSON.stringify({from:goal.status,
              to:'BLOCKED',previousVersion:goal.version,newVersion:goal.version+1,
              reason:'request_abandoned',missionId:id}));
        }
      }
      return ended;
    });
  }
  /** First unused request key for a step: `base`, or `base-a<n>` after a
   * Send that was never attempted. Keys stay unique, so audits never see a
   * reused reservation. */
  nextRequestKey(id:string,base:string):string {
    for(let n=0;n<100;n++){
      const key=n?`${base}-a${n}`:base;
      if(!this.getMeta(`chatgpt.browser.request.${id}.${key}`))return key;
    }
    throw new Error('Too many unsent attempts for one browser step');
  }
  /** Release a reservation whose Send was provably never attempted (the
   * failure happened before Relay clicked Send). The settled receipt it
   * replaced comes back, the conversation lock is released and the Worker
   * may retry with a fresh request key after a backoff. After 8 consecutive
   * unsent attempts the Mission stops with a visible error. */
  abortUnsentBrowserTurn(id:string,requestKey:string,reason:string):Mission {
    return this.transaction(()=>{
      const m=this.get(id),record=this.chatBrowserTurn(id);
      if(!record||record.status!=='reserved'||record.requestKey!==requestKey||m.state!=='RUNNING')
        throw new Error('Only the active reserved request can be released as unsent');
      if(record.previous)this.setMeta(this.browserTurnKey(id),JSON.stringify(record.previous));
      else this.db.prepare('DELETE FROM meta WHERE key=?').run(this.browserTurnKey(id));
      this.db.prepare('DELETE FROM meta WHERE key=?').run(this.browserUrlLockKey(record.urlHash));
      const events=this.events(id);
      const settledTypes=['chatgpt.browser_observed','chatgpt.browser_turn_recovered',
        'chatgpt.browser_rollover_recovered'];
      const lastSettled=events.map(e=>settledTypes.includes(e.type)).lastIndexOf(true);
      const aborts=events.slice(lastSettled+1).filter(e=>e.type==='chatgpt.browser_send_aborted').length+1;
      const exhausted=aborts>=8;
      const now=new Date().toISOString();
      this.db.prepare(`UPDATE missions SET state=?,owner_pid=NULL,owner_host=NULL,
        last_error=?,version=version+1,updated_at=? WHERE id=? AND version=?`)
        .run(record.previous||m.turnCount>0?'PAUSED':'READY',
          exhausted?`Browser Send could not be started ${aborts} times: ${reason}`.slice(0,500):null,
          now,id,m.version);
      this.setMeta(`chatgpt.browser.presend_after.${id}`,
        String(Date.now()+Math.min(15*60_000,30_000*2**Math.min(aborts-1,5))));
      this.event(id,'chatgpt.browser_send_aborted',{requestKey,reason:reason.slice(0,300),
        attempt:aborts,noSend:true,stopped:exhausted});
      return this.get(id);
    });
  }
  /** Earliest time the Worker may retry after an unsent attempt. */
  browserPresendRetryAfter(id:string):number {
    return Number(this.getMeta(`chatgpt.browser.presend_after.${id}`)??'0')||0;
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
      const completedGoal=this.getMeta(`goal.pi.binding.${id}`);
      if(completedGoal&&this.db.prepare(
        'SELECT 1 FROM goal_completions WHERE goal_id=?').get(completedGoal))
        throw new Error('Goal completed; further browser Sends are prohibited');
      if(m.version!==revision) throw new Error(`State conflict: expected v${revision}, current v${m.version}`);
      if(!['READY','PAUSED'].includes(m.state)) throw new Error(`Cannot run browser turn in state ${m.state}`);
      if(m.stopRequested) throw new Error('Mission has a pending pause request; resume explicitly before another browser turn');
      // This is the final, atomic dispatch gate. A raw browser-send or future
      // controller path must not bypass the same-chat ceiling by omitting the
      // higher-level PI/browser-drive rotation check. A new-tab Send is
      // separately reserved and may only be credited with an actual URL move.
      if(!options.newConversation&&this.piChatObservedTurns(id)>=MAX_RELAY_CHAT_TURNS)
        throw new Error(`ChatGPT conversation already has ${MAX_RELAY_CHAT_TURNS} observed Relay Sends; start a new conversation before another Send`);
      if(m.sandbox==='workspace-write'&&this.getMeta(`pi.autopilot.enabled.${id}`)==='1'&&
        !hasIsolatedRepositoryGrant(this,m.workspace))
        throw new Error('Approved PI build workspace changed or was revoked before Send');
      if(m.sandbox==='workspace-write'&&this.getMeta(`pi.autopilot.enabled.${id}`)==='1'&&
        !declaredSourceMatchesScope(m.goal,m.workspace))
        throw new Error('Goal source repository and approved write scope differ; refusing browser Send');
      if(options.goalBinding){
        const binding=options.goalBinding;
        const linked=this.getMeta(`goal.pi.binding.${id}`);
        const pi=this.piPlan(id);
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
      if(this.getMeta(`chatgpt.browser.request.${id}.${requestKey}`)) throw new Error('Browser request key already used; never resend');
      const prior=this.chatBrowserTurn(id);
      if(prior && ['reserved','uncertain'].includes(prior.status))
        throw new Error('Previous browser turn may have been submitted; reconcile before another send');
      const urlHash=createHash('sha256').update(url).digest('hex');
      if(this.getMeta(this.browserUrlLockKey(urlHash)))
        throw new Error('Another Mission owns the active ChatGPT conversation; inspect and reconcile before sending');
      const {previous:_older,...settled}=prior??{} as ChatBrowserTurn;
      const record:ChatBrowserTurn={requestKey,promptSha256,urlHash,status:'reserved',
        reservationRevision:revision,createdAt:new Date().toISOString(),
        ...(options.newConversation?{newConversation:true}:{}),
        ...(prior?{previous:settled}:{})};
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
        perChatLimit:MAX_RELAY_CHAT_TURNS,
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
      if(record.promptSha256!==input.requestPromptSha256||oldUrl===destination)
        throw new Error('Rollover request hash mismatch or destination is not a new conversation');
      this.requireUnspentBrowserReservation(id,record);
      if(deadReserved&&(
        createHash('sha256').update(input.summary).digest('hex')!==input.assistantSha256||
        !hasFinalMissionRelayMarker(input.summary)))
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
      if(record.promptSha256!==input.requestPromptSha256||
        record.urlHash!==createHash('sha256').update(url).digest('hex'))
        throw new Error('Observed reply cannot be linked to the exact original reserved prompt and chat');
      this.requireUnspentBrowserReservation(id,record);
      if(deadReserved){
        if(createHash('sha256').update(input.summary).digest('hex')!==input.assistantSha256||
          !hasFinalMissionRelayMarker(input.summary))
          throw new Error('Dead-owner recovery requires the complete SHA-matched final-marked answer');
      }
      // A re-rendered *previous* assistant after a newer exact user prompt
      // caused the actual seventh-round false attribution. Without a stored
      // distinct assistant identity, equal bytes cannot be independently
      // credited as a new turn on either recovery path.
      const prior=this.events(id).filter(e=>
        ['chatgpt.browser_observed','chatgpt.browser_turn_recovered',
          'chatgpt.browser_rollover_recovered'].includes(e.type)).at(-1);
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
      if(plan?.round===m.turnCount&&['DONE','BLOCKED'].includes(plan.action))
        throw new Error('PI Mission has already reached its terminal decision');
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
      if(!ownCheckpoint)
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
  /** Owner pause. A READY Goal Mission parks immediately; a running one stops
   * cooperatively at its next safe point. An in-flight Send is never
   * cancelled by guessing; it settles through normal observation first. */
  pauseGoalMission(id:string):Mission {
    return this.transaction(()=>{
      const m=this.get(id);
      if(this.getMeta(`pi.autopilot.enabled.${id}`)!=='1')
        throw new Error('Pause requires a PI Goal Mission');
      if(!m.stopRequested&&!['COMPLETED','CANCELLED','BLOCKED'].includes(m.state))
        this.update(id,m.version,{
          stopRequested:true,...(m.state==='READY'?{state:'PAUSED' as const}:{})},
          'mission.pause_requested',{reason:'Owner paused Goal'});
      return this.get(id);
    });
  }
  /** Explicit owner action only. Stop flags are never cleared on restart or
   * scheduling. The original reservation must have settled and, if there was
   * a Send, its exact independently verified checkpoint must still exist. */
  resumeGoalMission(id:string):Mission {
    return this.transaction(()=>{
      if(this.channelDrainRequested('telegram'))
        throw new Error('Maintenance drain forbids resuming a Goal');
      const m=this.get(id),receipt=this.chatBrowserTurn(id);
      if(this.getMeta(`pi.autopilot.enabled.${id}`)!=='1'||
        m.state!=='PAUSED'||m.ownerPid!==null||m.lastError||
        !m.stopRequested||
        (receipt&&['reserved','uncertain'].includes(receipt.status))||
        (m.turnCount>0&&(!receipt||
          !['observed','reconciled'].includes(receipt.status)||
          !this.hasVerifiedPiBrowserCheckpoint(id)))||
        ['DONE','BLOCKED'].includes(this.piPlan(id)?.action??''))
        throw new Error('Goal resume requires an owner-paused, settled and verified checkpoint; no Send was retried');
      return this.update(id,m.version,{
        stopRequested:false,
        ...(m.turnCount===0&&!receipt?{state:'READY' as const}:{}),
      },'mission.owner_resumed',{ownerInitiated:true,noBrowserReplay:true});
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
        (!replaceExisting||
          !['NEXT','HANDOFF'].includes(previous.action)||reviewedDirectiveIds.length===0))
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
        directivesReviewed:reviewedDirectiveIds.length,
      });
      if(['DONE','BLOCKED'].includes(plan.action)){
        this.event(id,'pi.autopilot_finished',{action:plan.action,round:m.turnCount,summary:plan.summary,
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
  archiveSettledMissions(options:{
    /** Automatic housekeeping must not hide a fresh verdict. */
    minAgeMs?:number;
    /** BLOCKED is an owner-action state, not an automatic expiration. */
    includeBlocked?:boolean;
    nowMs?:number;
  }={}):{archived:number;retained:number} {
    const minAgeMs=options.minAgeMs??0,nowMs=options.nowMs??Date.now();
    if(!Number.isSafeInteger(minAgeMs)||minAgeMs<0||
      !Number.isFinite(nowMs)||nowMs<0)
      throw new Error('Invalid archive retention interval or observation time');
    return this.transaction(()=>{
      let archived=0,retained=0;
      for(const m of this.list()){
        if(this.isMissionArchived(m.id))continue;
        const updatedAtMs=Date.parse(m.updatedAt);
        if(minAgeMs>0&&(!Number.isFinite(updatedAtMs)||
          nowMs-updatedAtMs<minAgeMs)){retained++;continue;}
        const receipt=this.chatBrowserTurn(m.id),pi=this.piPlan(m.id);
        const safeReceipt=!receipt||['observed','reconciled'].includes(receipt.status);
        // The durable latest PI plan is terminal only on an explicit
        // DONE/BLOCKED decision; any other event never settles a Goal.
        const terminalPi=pi&&['DONE','BLOCKED'].includes(pi.action);
        if(options.includeBlocked===false&&pi?.action==='BLOCKED'){
          retained++;continue;
        }
        const terminalBrowser=missionRelayMarker(m.lastSummary??'')==='DONE';
        const settled=['COMPLETED','CANCELLED'].includes(m.state)||
          (m.state==='PAUSED'&&!m.lastError&&!m.stopRequested&&
           this.pendingPiOwnerDirectives(m.id).length===0&&
           (terminalPi||
            (this.getMeta(`pi.autopilot.enabled.${m.id}`)!=='1'&&terminalBrowser)));
        if(!safeReceipt||!settled){retained++;continue;}
        const at=new Date().toISOString();
        this.setMeta(`mission.archive.${m.id}`,at);
        this.event(m.id,'mission.archived',{at,
          reason:options.minAgeMs?'settled_retention_elapsed':'settled_history'});
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
        for (const key of ['goal','workspace','sandbox','mode'] as const) {
          if (previous[key] !== input[key]) throw new Error('Idempotency key reused for a different mission');
        }
        if (JSON.stringify(previous.acceptance) !== JSON.stringify(input.acceptance)) throw new Error('Idempotency key reused for different acceptance criteria');
        if (JSON.stringify(previous.checks) !== JSON.stringify(input.checks ?? [])) throw new Error('Idempotency key reused for different checks');
        return previous;
      }
      const id = randomUUID(), now = new Date().toISOString();
      this.db.prepare(`INSERT INTO missions (id,goal,acceptance_json,checks_json,workspace,sandbox,mode,max_turns,request_key,state,version,turn_count,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?, 'READY',0,0,?,?)`)
        .run(id,input.goal,JSON.stringify(input.acceptance),JSON.stringify(input.checks ?? []),input.workspace,input.sandbox,input.mode,0,input.requestKey,now,now);
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
  isOwnerAlive(m: Mission): boolean {
    if (m.ownerHost !== hostname() || m.ownerPid === null) return true;
    try { process.kill(m.ownerPid, 0); return true; }
    catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; }
  }
}
