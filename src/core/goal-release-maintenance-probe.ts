import {createHash} from 'node:crypto';
import {existsSync,readFileSync,readdirSync,lstatSync,writeFileSync,statSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import type {Store} from './store.js';
import {requireSettledReleaseCustody,InsufficientReleaseEvidenceError,
  type ReleaseProbe} from './goal-release.js';
import {gmkProductionReleaseProbe,enrolledTaskStatus} from './goal-release-runtime.js';
import {verifiedRuntimeProvenance} from './runtime-provenance.js';
import {readReleaseWorkerIdentity,assertStableReleaseWorkerIdentity} from './goal-release-runtime.js';

const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const sha40=/^[a-f0-9]{40}$/;
const sha64=/^[a-f0-9]{64}$/;
interface Stage {
  sequence:number;at:string;stage:string;previousSha256:string;
  details:Record<string,unknown>;
}
interface Line {payload:string;sha256:string}
export interface MaintenanceJournalReadback {
  sourceSha:string;previousSha:string;journalSha256:string;sqliteBackupSha256:string;
  isolatedRestoreSha256:string;rollbackBytesSha256:string;rollbackTreeSha256:string;
  rollbackFileCount:number;drainIdSha256:string;
  historicalEventsSha256:string;originalEvents:number;
  lastHistoricalEventId:number;lastHistoricalGoalEventId:number;
  originalMissions:number;
  runtimePid:number;
}
type HistoricalMission={
  id:string;goal:string;acceptance_json:string;workspace:string;
  sandbox:string;mode:string;max_turns:number;request_key:string;
  created_at:string;checks_json:string;state:string;turn_count:number;
  stop_requested:number;last_error:string|null;
};
type HistoricalGoal={
  id:string;request_key:string;objective:string;priority:number;
  status:string;version:number;created_at:string;updated_at:string;
};
const immutableMissionFields=[
  'goal','acceptance_json','workspace','sandbox','mode','max_turns',
  'request_key','created_at','checks_json',
] as const;
const immutableGoalFields=['request_key','objective','priority','created_at'] as const;
/** Capture the *whole* historical Goal graph, not only its identity and
 * append-only audit prefix. A direct mutation of a plan/work/acceptance row
 * could otherwise slip through a successful maintenance journal without
 * producing any Goal event. This is read-only on both SQLite handles. */
function protectedGoalGraphDigest(db:DatabaseSync,goalId:string):string{
  const rows={
    goal:db.prepare('SELECT * FROM goals WHERE id=?').all(goalId),
    plans:db.prepare('SELECT * FROM goal_plans WHERE goal_id=? ORDER BY id').all(goalId),
    work:db.prepare('SELECT * FROM goal_work_items WHERE goal_id=? ORDER BY id').all(goalId),
    dependencies:db.prepare(
      'SELECT * FROM goal_dependencies WHERE goal_id=? ORDER BY item_id,depends_on_id'
    ).all(goalId),
    acceptance:db.prepare(`SELECT a.* FROM goal_acceptance a
      JOIN goal_work_items w ON w.id=a.item_id WHERE w.goal_id=? ORDER BY a.id`
    ).all(goalId),
    events:db.prepare('SELECT * FROM goal_events WHERE goal_id=? ORDER BY id').all(goalId),
    operations:db.prepare(
      'SELECT * FROM goal_operations WHERE goal_id=? ORDER BY operation_key'
    ).all(goalId),
    targets:db.prepare('SELECT * FROM goal_release_targets WHERE goal_id=?').all(goalId),
    checks:db.prepare(
      'SELECT * FROM goal_release_checks WHERE goal_id=? ORDER BY requirement'
    ).all(goalId),
    completion:db.prepare('SELECT * FROM goal_release_completion WHERE goal_id=?').all(goalId),
  };
  if(rows.goal.length!==1)
    throw new Error('Protected Goal has no original, unique SQLite identity');
  return hash(JSON.stringify(rows));
}
/** A settled, errored/owner-stopped PAUSED Mission is historical custody, not
 * ordinary PI work waiting for its next review. Completed/cancelled Missions
 * are equally final. Other Mission states may legitimately advance after a
 * successful upgrade, so their mutable counters cannot be compared forever. */
function protectedHistory(m:HistoricalMission):boolean{
  return m.state==='CANCELLED'||m.state==='COMPLETED'||
    (m.state==='PAUSED'&&(m.stop_requested!==0||m.last_error!==null));
}
function obj(value:unknown):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value))
    throw new Error('Invalid chained maintenance evidence shape');
  return value as Record<string,unknown>;
}
function requireString(o:Record<string,unknown>,key:string):string{
  return typeof o[key]==='string'?o[key] as string:'';
}
function parseJournal(raw:string):Stage[]{
  if(!raw||raw.length>1_000_000||!raw.endsWith('\n'))
    throw new Error('Incomplete or oversized private maintenance journal');
  const records=raw.trimEnd().split('\n');
  if(records.length<10||records.length>100)
    throw new Error('Upgrade lifecycle is not completely witnessed');
  let lastHash='',sequence=0,previousTime=0;
  const stages:Stage[]=[];
  for(const text of records){
    const line=JSON.parse(text) as Line;
    if(typeof line.payload!=='string'||!sha64.test(String(line.sha256))||
      hash(line.payload)!==line.sha256)
      throw new Error('Private maintenance audit hash chain was changed');
    const stage=obj(JSON.parse(line.payload)) as unknown as Stage;
    const at=Date.parse(stage.at);
    if(!Number.isSafeInteger(stage.sequence)||stage.sequence!==++sequence||
      stage.previousSha256!==lastHash||typeof stage.stage!=='string'||
      !Number.isFinite(at)||at<previousTime||at>Date.now()+60_000)
      throw new Error('Maintenance journal sequence or timing is invalid');
    obj(stage.details);
    previousTime=at;lastHash=line.sha256;stages.push(stage);
  }
  return stages;
}
function exactlyOne(stages:Stage[],name:string):Stage{
  const matches=stages.filter(s=>s.stage===name);
  if(matches.length!==1)throw new Error('Missing or repeated maintenance step '+name);
  return matches[0]!;
}
/** Verify the original SQLite backup was actually recovered into a SECOND
 * isolated database, not merely opened under its existing path. Inspect all
 * tables, including request/meta/Goal history, without writing to either
 * backup or live production. A journal assertion alone cannot certify it. */
function verifyIsolatedRestore(sourceFile:string,restoreFile:string,
  originalSha:string,restoredSha:string):void{
  if(sourceFile===restoreFile||!existsSync(restoreFile)||
    !lstatSync(restoreFile).isFile()||!sha64.test(restoredSha)||
    hash(readFileSync(sourceFile))!==originalSha||
    hash(readFileSync(restoreFile))!==restoredSha)
    throw new Error('Isolated SQLite restoration is missing or altered');
  // Distinct paths (and even identical validated bytes) do not prove a second
  // recovered database: a hard link aliases the original backup inode.
  // Compare native file identities across platforms before opening SQLite.
  const originalIdentity=statSync(sourceFile,{bigint:true});
  const restoredIdentity=statSync(restoreFile,{bigint:true});
  if(originalIdentity.dev===restoredIdentity.dev&&
    originalIdentity.ino===restoredIdentity.ino)
    throw new Error('Isolated SQLite restoration aliases the original backup file');
  const source=new DatabaseSync(sourceFile,{readOnly:true});
  try{
    const restored=new DatabaseSync(restoreFile,{readOnly:true});
    try{
      source.exec('PRAGMA query_only=ON');restored.exec('PRAGMA query_only=ON');
      for(const db of [source,restored]){
        if(db.prepare('PRAGMA integrity_check').get()?.integrity_check!=='ok'||
          db.prepare('PRAGMA foreign_key_check').all().length)
          throw new Error('Isolated SQLite restore integrity or foreign keys failed');
      }
      const tables=(db:DatabaseSync)=>db.prepare(`SELECT name,sql FROM sqlite_master
        WHERE type='table' ORDER BY name`).all() as Array<{name:string;sql:string|null}>;
      const originalTables=tables(source),recoveredTables=tables(restored);
      if(JSON.stringify(originalTables)!==JSON.stringify(recoveredTables))
        throw new Error('Isolated SQLite restore schema differs from drained backup');
      for(const {name} of originalTables){
        const table='"'+name.replaceAll('"','""')+'"';
        if(JSON.stringify(source.prepare(`SELECT * FROM ${table}`).all())!==
          JSON.stringify(restored.prepare(`SELECT * FROM ${table}`).all()))
          throw new Error('Isolated SQLite restore lost original request or history rows');
      }
    }finally{restored.close();}
  }finally{source.close();}
  if(hash(readFileSync(sourceFile))!==originalSha||
    hash(readFileSync(restoreFile))!==restoredSha)
    throw new Error('SQLite recovery files changed during read-only validation');
}
/** The Windows upgrade retains the *original* compiled rollback image in its
 * private audit directory. A journal's verified=true flag or a claimed digest
 * cannot establish rollback readiness if those bytes have gone missing. */
function verifyCompiledRollback(backupFile:string,previousSha:string,
  expectedTree:string,expectedBytes:string,expectedCount:number,
  mode:'fenced'|'legacy-release-before-start'='fenced'):void{
  const dir=join(dirname(backupFile),'rollback','dist');
  if(!existsSync(dir)||!lstatSync(dir).isDirectory())
    throw new Error('Private compiled rollback image is missing');
  const files:Array<{name:string;hash:string}>=[];
  const walk=(folder:string,prefix=''):void=>{
    for(const entry of readdirSync(folder,{withFileTypes:true})){
      const name=prefix+entry.name,full=join(folder,entry.name);
      if(entry.isDirectory())walk(full,name+'/');
      else if(entry.isFile()&&lstatSync(full).isFile())
        files.push({name,hash:hash(readFileSync(full))});
      else throw new Error('Unsafe compiled rollback image entry');
    }
  };
  walk(dir);
  files.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
  if(files.length!==expectedCount||hash(JSON.stringify(files))!==expectedBytes)
    throw new Error('Compiled rollback copy bytes or file inventory changed');
  const js=files.filter(file=>file.name.endsWith('.js'));
  const tree=hash(js.map(file=>file.name+'\0'+file.hash+'\n').join(''));
  if(!js.some(file=>file.name==='cli.js')||tree!==expectedTree)
    throw new Error('Compiled rollback executable tree is not recoverable');
  const manifest=JSON.parse(readFileSync(join(dir,'build-provenance.json'),'utf8')) as
    Record<string,unknown>;
  if(manifest.format!==1||manifest.sourceSha!==previousSha||
    manifest.treeSha256!==expectedTree||manifest.fileCount!==js.length||
    manifest.cliSha256!==files.find(file=>file.name==='cli.js')?.hash)
    throw new Error('Compiled rollback manifest is not bound to the previous Worker');
  const standby=files.find(file=>file.name==='plugins/telegram.js');
  if(!standby)throw new Error('Old compiled Worker cannot safely resume behind a held drain');
  const standbyCode=readFileSync(join(dir,'plugins','telegram.js'),'utf8');
  const oldCli=readFileSync(join(dir,'cli.js'),'utf8');
  if(mode==='fenced'){
    if(!standbyCode.includes('probeFencedTelegramTransport')||
      !standbyCode.includes('startedInsideDrain'))
      throw new Error('Old compiled Worker cannot safely resume behind a held drain');
    if(!oldCli.includes('channel-drain-release-verified'))
      throw new Error('Old compiled CLI cannot atomically release the restored Worker');
  }else{
    // A one-time exception bound to the ACTUAL old GMK source and original
    // compiled bytes, not to a generic old CLI or a model's compatibility
    // statement. It must never be classified as fenced rollback.
    const oldSha='df3044eb2dc787236391918c2b7730b9b9407b8b';
    const oldCliSha='6801cca587e12482fb638ee9b864493346e5b12d0c1b1bb8dee719bdd85e73b6';
    const oldModuleSha='520f4bba184a207853a6d4104754cb5930fe7ac4af5f6fad8d1a85a84967ebb5';
    if(previousSha!==oldSha||files.find(f=>f.name==='cli.js')?.hash!==oldCliSha||
      standby.hash!==oldModuleSha||
      standbyCode.includes('probeFencedTelegramTransport')||
      standbyCode.includes('startedInsideDrain')||
      oldCli.includes('channel-drain-release-verified')||
      !oldCli.includes('channel-drain-release'))
      throw new Error('Legacy rollback image differs from the exact deployed compatibility exception');
  }
  // A live mutation during inspection invalidates the claimed inventory.
  for(const file of files)
    if(hash(readFileSync(join(dir,file.name)))!==file.hash)
      throw new Error('Compiled rollback image changed during inspection');
}
export function assessMaintenanceJournal(raw:string,targetSha:string,
  sourceFile:string,live:Store,
  installedBootstrapScriptSha256?:string):MaintenanceJournalReadback{
  const stages=parseJournal(raw);
  if(!sha40.test(targetSha))throw new Error('Invalid upgrade source SHA');
  const ordered=['intent','rollback_capability_verified','preflight','drain_acquired','worker_stopped',
    'sqlite_backup','sqlite_restore_verified','compiled_rollback_saved','source_verified','checkout_updated',
    'compiled','worker_healthy','runtime_verified','sqlite_continuity_verified',
    'fenced_acceptance_verified','drain_release_requested','drain_released','complete'];
  if(stages.some(s=>['upgrade_failed','rollback_verified','rollback_unverified',
    'runtime_identity_failed'].includes(s.stage)))
    throw new Error('An interrupted or rolled-back upgrade cannot certify maintenance');
  let previous=-1;
  for(const name of ordered){
    const stage=exactlyOne(stages,name);
    const index=stages.indexOf(stage);
    if(index<=previous)throw new Error('Maintenance lifecycle order is not authoritative');
    previous=index;
  }
  if(stages.at(-1)?.stage!=='complete')
    throw new Error('Maintenance journal has no final success receipt');
  const intent=exactlyOne(stages,'intent').details;
  const prior=requireString(intent,'fromSha');
  const capability=exactlyOne(stages,'rollback_capability_verified').details;
  const mode=capability.mode===undefined?'fenced':capability.mode;
  if(mode!=='fenced'&&mode!=='legacy-release-before-start')
    throw new Error('Unknown or contradictory rollback compatibility mode');
  if(mode==='legacy-release-before-start'&&(
    intent.legacyMigration!==true||
    !sha64.test(String(intent.bootstrapScriptSha256))||
    intent.bootstrapScriptSha256!==installedBootstrapScriptSha256||
    capability.legacyCliSha256!=='6801cca587e12482fb638ee9b864493346e5b12d0c1b1bb8dee719bdd85e73b6'||
    capability.legacyModuleSha256!=='520f4bba184a207853a6d4104754cb5930fe7ac4af5f6fad8d1a85a84967ebb5'))
    throw new Error('Legacy migration did not prove the reviewed bootstrap and pinned old bytes');
  if(mode==='fenced'&&intent.legacyMigration===true)
    throw new Error('Legacy migration intent contradicts its rollback capability');
  if(!sha40.test(prior)||requireString(intent,'toSha')!==targetSha||
    requireString(intent,'source')!=='github-main-pull-only'||
    capability.verified!==true||capability.previousSha!==prior||
    !sha64.test(requireString(capability,'originalTreeSha256'))||
    !Number.isSafeInteger(capability.compiledFiles))
    throw new Error('Upgrade intent was not the approved exact source revision');
  const drain=exactlyOne(stages,'drain_acquired').details;
  const release=exactlyOne(stages,'drain_release_requested').details;
  const rollback=exactlyOne(stages,'compiled_rollback_saved').details;
  const preflight=exactlyOne(stages,'preflight').details;
  const channel=obj(preflight.channel);
  const oldPid=Number(intent.oldWorkerPid);
  if(Number(preflight.exitCode)!==0||
    channel.pollerPresent!==true||channel.pollerPid!==oldPid||
    channel.pendingReplies!==0||
    !Number.isSafeInteger(channel.notificationsCursor)||
    !Number.isSafeInteger(channel.lastEventId)||
    channel.notificationsCursor!==channel.lastEventId||
    drain.confirmedRequested!==true||!sha64.test(String(drain.drainIdSha256))||
    drain.oldWorkerPid!==oldPid||
    drain.drainIdSha256!==release.drainIdSha256||
    exactlyOne(stages,'drain_released').details.confirmed!==true||
    exactlyOne(stages,'worker_stopped').details.oldWorkerPid!==intent.oldWorkerPid||
    exactlyOne(stages,'worker_stopped').details.pollerPresent!==false||
    !Number.isSafeInteger(oldPid)||oldPid<=0||
    requireString(rollback,'previousSha')!==prior||
    capability.originalTreeSha256!==rollback.compiledTreeSha256||
    capability.compiledFiles!==rollback.fileCount||
    rollback.verified!==true||
    !sha64.test(requireString(rollback,'compiledTreeSha256'))||
    !sha64.test(requireString(rollback,'copiedBytesSha256'))||
    !Number.isSafeInteger(rollback.fileCount)||Number(rollback.fileCount)<2)
    throw new Error('Maintenance preflight, rollback backup or atomic drain receipt is missing');
  if(requireString(exactlyOne(stages,'source_verified').details,'expectedSha')!==targetSha||
    requireString(exactlyOne(stages,'source_verified').details,'fetchedSha')!==targetSha||
    requireString(exactlyOne(stages,'checkout_updated').details,'newSha')!==targetSha||
    requireString(exactlyOne(stages,'checkout_updated').details,'method')!=='pull --ff-only origin main'||
    requireString(exactlyOne(stages,'compiled').details,'sourceSha')!==targetSha||
    requireString(exactlyOne(stages,'complete').details,'sha')!==targetSha||
    requireString(exactlyOne(stages,'complete').details,'result')!=='healthy')
    throw new Error('Deployed and compiled source differs from the exact upgrade target');
  const backup=exactlyOne(stages,'sqlite_backup').details;
  const backupSha=requireString(backup,'sha256');
  const continuation=exactlyOne(stages,'sqlite_continuity_verified').details;
  const recordedHistory=requireString(continuation,'eventsSha256');
  if(!sha64.test(backupSha)||!sha64.test(recordedHistory)||
    backup.integrity!=='ok'||backup.reserved!==0||
    continuation.integrity!=='ok'||continuation.newHighWater===undefined||
    !sha64.test(requireString(continuation,'missionRowsSha256'))||
    !sha64.test(requireString(continuation,'requestsSha256'))||
    continuation.foreignKeyViolations!==0)
    throw new Error('A complete drained SQLite backup and continuity readback is missing');
  if(!existsSync(sourceFile)||!lstatSync(sourceFile).isFile()||
    hash(readFileSync(sourceFile))!==backupSha)
    throw new Error('Original private SQLite backup missing or changed');
  verifyCompiledRollback(sourceFile,prior,requireString(rollback,'compiledTreeSha256'),
    requireString(rollback,'copiedBytesSha256'),Number(rollback.fileCount),mode);
  const restore=exactlyOne(stages,'sqlite_restore_verified').details;
  const restoreSha=requireString(restore,'restoredSha256');
  if(restore.backupSha256!==backupSha||restore.integrity!=='ok'||
    restore.foreignKeyViolations!==0)
    throw new Error('Isolated recovery journal does not match the original drained backup');
  verifyIsolatedRestore(sourceFile,join(dirname(sourceFile),'isolated-restore.sqlite'),
    backupSha,restoreSha);
  const snapshot=new DatabaseSync(sourceFile,{readOnly:true});
  let oldEvents:unknown[];
  let oldGoalEvents:unknown[];
  let oldGoalOperations:unknown[];
  let oldGoals:HistoricalGoal[];
  let oldMissions:HistoricalMission[];
  let protectedReceipts:Map<string,string|null>;
  let protectedGoalBindings:Map<string,string|null>;
  let protectedGoalDigests:Map<string,string>;
  try{
    snapshot.exec('PRAGMA query_only=ON');
    if(snapshot.prepare('PRAGMA integrity_check').get()?.integrity_check!=='ok'||
      snapshot.prepare('PRAGMA foreign_key_check').all().length)
      throw new Error('SQLite backup integrity or foreign keys invalid');
    const missionRows= snapshot.prepare('SELECT * FROM missions ORDER BY id').all();
    const requestRows=snapshot.prepare(
      "SELECT key,value FROM meta WHERE key LIKE 'chatgpt.browser.active.%' ORDER BY key").all();
    if(hash(JSON.stringify(missionRows))!==continuation.missionRowsSha256||
      hash(JSON.stringify(requestRows))!==continuation.requestsSha256)
      throw new Error('Fenced SQLite Mission or request receipt digests differ from original snapshot');
    oldEvents=snapshot.prepare('SELECT * FROM events ORDER BY id').all();
    oldGoalEvents=snapshot.prepare('SELECT * FROM goal_events ORDER BY id').all();
    oldGoalOperations=snapshot.prepare(
      'SELECT * FROM goal_operations ORDER BY goal_id,operation_key').all();
    oldGoals=snapshot.prepare('SELECT * FROM goals ORDER BY id').all() as HistoricalGoal[];
    oldMissions=snapshot.prepare(`SELECT id,goal,acceptance_json,workspace,
      sandbox,mode,max_turns,request_key,created_at,checks_json,
      state,turn_count,stop_requested,last_error FROM missions ORDER BY id`)
      .all() as HistoricalMission[];
    protectedReceipts=new Map(oldMissions.filter(protectedHistory).map(m=>[
      m.id,(snapshot.prepare('SELECT value FROM meta WHERE key=?')
        .get('chatgpt.browser.active.'+m.id) as {value:string}|undefined)?.value??null,
    ]));
    protectedGoalBindings=new Map(oldMissions.filter(protectedHistory).map(m=>[
      m.id,(snapshot.prepare('SELECT value FROM meta WHERE key=?')
        .get('goal.pi.binding.'+m.id) as {value:string}|undefined)?.value??null,
    ]));
    const protectedIds=new Set<string>([
      ...oldGoals.filter(g=>g.status==='PAUSED'||g.status==='BLOCKED').map(g=>g.id),
      ...[...protectedGoalBindings.values()].filter((id):id is string=>id!==null),
    ]);
    protectedGoalDigests=new Map([...protectedIds].map(id=>[
      id,protectedGoalGraphDigest(snapshot,id),
    ]));
    const reserved=snapshot.prepare("SELECT count(*) AS n FROM meta WHERE key LIKE 'chatgpt.browser.active.%' AND json_extract(value,'$.status')='reserved'").get() as {n:number};
    if(reserved.n!==0)throw new Error('Backup has an in-flight browser Send');
  }finally{snapshot.close();}
  const originalHash=hash(JSON.stringify(oldEvents));
  const maxId=oldEvents.length?(oldEvents.at(-1) as {id:number}).id:0;
  const current=live.db.prepare('SELECT * FROM events WHERE id<=? ORDER BY id').all(maxId);
  const goalEventMaxId=oldGoalEvents.length?
    (oldGoalEvents.at(-1) as {id:number}).id:0;
  const currentGoalEvents=live.db.prepare('SELECT * FROM goal_events WHERE id<=? ORDER BY id')
    .all(goalEventMaxId);
  const currentGoalOperations=new Map((live.db.prepare(
    'SELECT * FROM goal_operations').all() as Array<{goal_id:string;operation_key:string}>)
    .map(row=>[JSON.stringify([row.goal_id,row.operation_key]),row]));
  const goalOperationsChanged=oldGoalOperations.some(value=>{
    const row=value as {goal_id:string;operation_key:string};
    return JSON.stringify(value)!==JSON.stringify(currentGoalOperations.get(
      JSON.stringify([row.goal_id,row.operation_key])));
  });
  const currentGoals=new Map((live.db.prepare('SELECT * FROM goals').all() as
    HistoricalGoal[]).map(g=>[g.id,g]));
  const protectedGoalIds=new Set([...protectedGoalBindings.values()]
    .filter((id):id is string=>id!==null));
  const protectedGoalGraphChanged=[...protectedGoalDigests].some(([id,digest])=>
    protectedGoalGraphDigest(live.db,id)!==digest);
  const goalHistoryChanged=oldGoals.some(old=>{
    const now=currentGoals.get(old.id);
    if(!now||immutableGoalFields.some(key=>old[key]!==now[key]))return true;
    // Active, unprotected Goals may continue after a successful upgrade.
    // Historical blocked/paused Goals and Goals belonging to protected
    // interrupted Missions must not be silently resumed or re-versioned.
    return (old.status==='PAUSED'||old.status==='BLOCKED'||
      protectedGoalIds.has(old.id))&&
      (old.status!==now.status||old.version!==now.version||
        old.updated_at!==now.updated_at);
  });
  const currentMissions=new Map((live.db.prepare(`SELECT id,goal,acceptance_json,
    workspace,sandbox,mode,max_turns,request_key,created_at,checks_json,
    state,turn_count,stop_requested,last_error FROM missions`)
    .all() as HistoricalMission[]).map(m=>[m.id,m]));
  const missionHistoryChanged=oldMissions.some(old=>{
    const now=currentMissions.get(old.id);
    if(!now||immutableMissionFields.some(key=>old[key]!==now[key]))return true;
    if(!protectedHistory(old))return false;
    const currentBinding=(live.db.prepare('SELECT value FROM meta WHERE key=?')
      .get('goal.pi.binding.'+old.id) as {value:string}|undefined)?.value??null;
    if(currentBinding!==protectedGoalBindings.get(old.id))return true;
    if(['state','turn_count','stop_requested','last_error'].some(key=>
      old[key as keyof HistoricalMission]!==now[key as keyof HistoricalMission]))return true;
    const receipt=(live.db.prepare('SELECT value FROM meta WHERE key=?')
      .get('chatgpt.browser.active.'+old.id) as {value:string}|undefined)?.value??null;
    return receipt!==protectedReceipts.get(old.id);
  });
  if(originalHash!==recordedHistory||hash(JSON.stringify(current))!==originalHash||
    missionHistoryChanged||goalHistoryChanged||goalOperationsChanged||
    protectedGoalGraphChanged||
    hash(JSON.stringify(currentGoalEvents))!==hash(JSON.stringify(oldGoalEvents))||
    obj(backup.events).count!==oldEvents.length||
    backup.missions!==oldMissions.length||
    continuation.originalEvents!==oldEvents.length||
    continuation.originalMissions!==oldMissions.length||
    live.db.prepare('PRAGMA integrity_check').get()?.integrity_check!=='ok'||
    live.db.prepare('PRAGMA foreign_key_check').all().length)
    throw new Error('Historical SQLite event/Mission custody changed during upgrade');
  const worker=exactlyOne(stages,'runtime_verified').details;
  const pid=Number(worker.pid);
  const compiled=exactlyOne(stages,'compiled').details;
  const acceptance=exactlyOne(stages,'fenced_acceptance_verified').details;
  const workerHealthy=exactlyOne(stages,'worker_healthy').details;
  if(!Number.isSafeInteger(pid)||pid<=0||
    Number(workerHealthy.pid)!==pid||workerHealthy.fenced!==true||
    !Number.isSafeInteger(workerHealthy.notificationsCursor)||
    !Number.isSafeInteger(workerHealthy.lastEventId)||
    Number(workerHealthy.notificationsCursor)<0||Number(workerHealthy.lastEventId)<0||
    workerHealthy.notificationsCursor!==workerHealthy.lastEventId||
    worker.fenced!==true||acceptance.drainHeld!==true||
    acceptance.rollbackVerified!==true||acceptance.sha!==targetSha||
    Number(acceptance.pid)!==pid||
    Number(intent.oldWorkerPid)===pid||
    Number(exactlyOne(stages,'complete').details.pid)!==pid||
    requireString(worker,'sourceSha')!==targetSha||
    requireString(worker,'compiledTreeSha256')!==requireString(compiled,'compiledTreeSha256')||
    workerHealthy.transportHealth!=='healthy')
    throw new Error('Post-restart worker identity was not independently verified');
  return {sourceSha:targetSha,previousSha:prior,journalSha256:hash(raw),
    sqliteBackupSha256:backupSha,isolatedRestoreSha256:restoreSha,
    rollbackBytesSha256:requireString(rollback,'copiedBytesSha256'),
    rollbackTreeSha256:requireString(rollback,'compiledTreeSha256'),
    rollbackFileCount:Number(rollback.fileCount),
    drainIdSha256:requireString(drain,'drainIdSha256'),
    historicalEventsSha256:originalHash,
    originalEvents:oldEvents.length,lastHistoricalEventId:maxId,
    lastHistoricalGoalEventId:goalEventMaxId,
    originalMissions:oldMissions.length,runtimePid:pid};
}
function latestJournalFolder(privateDir:string):string{
  if(!existsSync(privateDir))
    throw new InsufficientReleaseEvidenceError('No enrolled maintenance audit directory');
  const dirs=readdirSync(privateDir).filter(name=>/^upgrade-audit-[0-9a-f-]{36}$/i.test(name))
    .map(name=>join(privateDir,name))
    .filter(path=>lstatSync(path).isDirectory()&&existsSync(join(path,'receipts.jsonl')))
    .sort((a,b)=>statSync(join(b,'receipts.jsonl')).mtimeMs-
      statSync(join(a,'receipts.jsonl')).mtimeMs);
  if(!dirs[0])
    throw new InsufficientReleaseEvidenceError(
      'No previously completed original controlled upgrade receipt');
  return dirs[0];
}
/** Fail-closed, read-only witness of the existing owner-enrolled Upgrade
 * lifecycle. This cannot request drain, stop/start Worker or replay a Send.
 * The separate GMK probe supplies live Chrome and runtime readback. */
export function maintenanceReleaseProbe(store:Store,goalId:string,
  privateDir:string,entry=process.argv[1]):ReleaseProbe{
  return {source:'maintenance-readback',inspect:async(requirement,targetSha)=>{
    if(requirement!=='maintenance-resume'||process.platform!=='win32'||!entry)
      throw new Error('Maintenance ReleaseProbe requires the enrolled Windows runtime');
    requireSettledReleaseCustody(store,goalId);
    const liveWorkerBefore=readReleaseWorkerIdentity(store,targetSha,entry);
    const source=verifiedRuntimeProvenance(entry);
    const channel=store.channelStatus('telegram'),task=enrolledTaskStatus(entry);
    if(source.sourceSha!==targetSha||
      channel.runtimeProvenance?.sourceSha!==targetSha||
      channel.runtimeProvenance?.compiledTreeSha256!==source.compiledTreeSha256||
      !channel.pollerPresent||channel.transportHealth!=='healthy'||
      channel.drainRequested||channel.pendingReplies!==0||
      !task.taskVerified||!task.pollerPresent||task.pollerPid!==channel.pollerPid||
      task.transportHealth!=='healthy')
      throw new Error('Current single Worker, task or source SHA is not safely promoted');
    const folder=latestJournalFolder(privateDir),journal=readFileSync(join(folder,'receipts.jsonl'),'utf8');
    const installedScript=join(dirname(dirname(entry)),'scripts','windows','telegram-task.ps1');
    if(!existsSync(installedScript)||!lstatSync(installedScript).isFile())
      throw new Error('Installed reviewed upgrade script is missing');
    const evidence=assessMaintenanceJournal(journal,targetSha,
      join(folder,'missions.sqlite'),store,hash(readFileSync(installedScript)));
    if(evidence.runtimePid!==channel.pollerPid)
      throw new Error('Live single Worker differs from the completed maintenance restart');
    // An independently re-read healthy, exact pinned Chrome checkpoint is
    // mandatory; old historical answers and a Telegram heartbeat cannot PASS.
    const live=await gmkProductionReleaseProbe(store,goalId,
      join(privateDir,'goal-release-evidence'),entry).inspect('gmk-production-readback',targetSha);
    if(live.state!=='PASS'||live.observedSha!==targetSha||
      store.channelStatus('telegram').pollerPid!==channel.pollerPid)
      throw new Error('Post-maintenance physical Chrome/Worker evidence is not stable');
    assertStableReleaseWorkerIdentity(liveWorkerBefore,
      readReleaseWorkerIdentity(store,targetSha,entry));
    const body=JSON.stringify({version:1,probeVersion:1,requirement:'maintenance-resume',
      scenario:'completed-drain-restored-backup-and-live-recovery',goalId,targetSha,
      expectedOutcome:'PASS',observedOutcome:'PASS',
      evidenceProvenance:'enrolled-windows-upgrade-journal-and-live-worker-chrome',
      runtimeIdentity:liveWorkerBefore,
      eventReferences:{lastRestoredEventId:evidence.lastHistoricalEventId,
        lastRestoredGoalEventId:evidence.lastHistoricalGoalEventId,
        latestObservedEventId:liveWorkerBefore.lastEventId,
        originalEventsSha256:evidence.historicalEventsSha256},
      evidence,
      liveReadback:live.proofSha256,observedAt:new Date().toISOString()});
    const proof=hash(body),out=join(privateDir,'maintenance-'+proof+'.json');
    try{writeFileSync(out,body,{flag:'wx',mode:0o600});}
    catch(error){
      if((error as NodeJS.ErrnoException).code!=='EEXIST'||
        readFileSync(out,'utf8')!==body)throw error;
    }
    return {state:'PASS',reference:'maintenance-readback://'+proof,
      proofSha256:proof,observedSha:targetSha};
  }};
}
