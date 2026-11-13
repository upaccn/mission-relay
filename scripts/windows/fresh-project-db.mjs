// Reset the owner's pre-production projects under the EXISTING SQLite drain.
// Never call this while a Telegram Worker can accept commands. No Chrome Send.
import {DatabaseSync} from 'node:sqlite';
import {randomUUID,createHash} from 'node:crypto';
import {existsSync,mkdirSync,renameSync,rmSync,statSync} from 'node:fs';
import {dirname,join,resolve,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';

const PROJECT_TABLES=['missions','events','goals','goal_plans','goal_work_items',
  'goal_acceptance','goal_dependencies','goal_operations','goal_release_checks',
  'goal_release_completion','goal_release_targets','goal_events',
  'pi_owner_directives','channel_commands'];
const RESET_EMPTY_TABLES=[...PROJECT_TABLES,'channel_leases'];
const SUPPORTED_TABLES=new Set([...RESET_EMPTY_TABLES,'meta']);
const PRESERVE=['schema_version','telegram.inbox_cursor','telegram.pi.sshHost',
  'telegram.pi.project','telegram.build.project','telegram.agent.workspace',
  'telegram.chatgpt.anchorUrl','telegram.chatgpt.browserId',
  'telegram.maintenance.drain'];
const UUID=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const count=(db,table)=>db.prepare(`SELECT count(*) AS n FROM "${table}"`).get().n;
const getMeta=(db,key)=>db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value??null;

function assertHealthy(db,drainId){
  if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok'||
    db.prepare('PRAGMA foreign_key_check').all().length)
    throw new Error('SQLite integrity or foreign keys invalid');
  if(!UUID.test(drainId)||getMeta(db,'telegram.maintenance.drain')!==drainId)
    throw new Error('Existing original maintenance drain ID does not match');
  if(count(db,'channel_leases')!==0)
    throw new Error('A Telegram Worker still holds a SQLite channel lease');
  if(db.prepare("SELECT count(*) AS n FROM channel_commands WHERE status!='delivered'").get().n)
    throw new Error('Unsent Telegram responses block project reset');
  const last=db.prepare('SELECT COALESCE(MAX(id),0) AS n FROM events').get().n;
  if(Number(getMeta(db,'telegram.notifications_cursor')??last)!==last)
    throw new Error('Undelivered event notifications block project reset');
  if(!/^(0|[1-9][0-9]*)$/.test(getMeta(db,'telegram.inbox_cursor')??''))
    throw new Error('Telegram cursor missing; old updates could be replayed');
}

function snapshotSource(db){
  const settings=new Map();
  for(const key of PRESERVE){
    const value=getMeta(db,key);
    if(value!==null)settings.set(key,value);
  }
  // A future owner-approved project reset must never silently destroy
  // independent repository grants OR an explicit revocation. Preserve only
  // strictly validated local operator scope records, never Goal state.
  for(const row of db.prepare(
    "SELECT key,value FROM meta WHERE key LIKE 'telegram.build.allow.%' ORDER BY key"
  ).all()){
    if(!/^telegram\.build\.allow\.[0-9a-f]{64}$/.test(row.key)||
      (row.value!==''&&(
        !/^\/[a-zA-Z0-9_./-]{1,240}$/.test(row.value)||
        row.value.endsWith('/')||row.value==='/'||
        row.value.split('/').some(part=>part==='.'||part==='..')||
        createHash('sha256').update(row.value).digest('hex')!==
          row.key.slice('telegram.build.allow.'.length))))
      throw new Error('Invalid repository approval or revocation record');
    settings.set(row.key,row.value);
  }
  // The old browser launch source was attached to a historical Mission.
  // Extract only the already-approved source URL/profile pair, not the
  // Mission row, context, prompt or any of its browser request receipts.
  if(!settings.get('telegram.chatgpt.anchorUrl')){
    const id=getMeta(db,'telegram.chatgpt.anchorMissionId');
    if(!UUID.test(id??''))throw new Error('Cannot independently recover approved Chrome profile');
    settings.set('telegram.chatgpt.anchorUrl',
      getMeta(db,`chatgpt.handoff.${id}`)??'');
    settings.set('telegram.chatgpt.browserId',
      getMeta(db,`chatgpt.browser.binding.${id}`)??'');
  }
  const url=settings.get('telegram.chatgpt.anchorUrl')??'';
  const browserId=settings.get('telegram.chatgpt.browserId')??'';
  if(!/^https:\/\/chatgpt\.com\/(?:c\/[A-Za-z0-9-]{20,}|g\/[A-Za-z0-9_-]+\/c\/[A-Za-z0-9-]{20,})$/.test(url)||
    !/^[\w.:/-]{1,200}$/.test(browserId))
    throw new Error('Old approved ChatGPT browser launch identity missing or malformed');
  if(!settings.get('telegram.pi.sshHost')||!settings.get('telegram.pi.project')||
    !settings.get('telegram.build.project')||
    settings.get('telegram.pi.project')!==settings.get('telegram.build.project'))
    throw new Error('PI host/project and matching approved build scope are required');
  return settings;
}

/** Source schema and indexes are copied; all historical rows are excluded. */
export function resetProjectDatabase(dbPath,drainId,auditDir){
  if(!isAbsolute(dbPath)||!isAbsolute(auditDir)||!UUID.test(drainId))
    throw new Error('Absolute state/audit paths and original maintenance ID required');
  const srcPath=resolve(dbPath),privateDir=resolve(auditDir);
  if(dirname(srcPath)===privateDir||!existsSync(srcPath))
    throw new Error('Invalid live database or audit destination');
  mkdirSync(privateDir,{recursive:true});
  const temp=join(dirname(srcPath),`.fresh-${randomUUID()}.sqlite`);
  const previous=join(privateDir,'pre-reset-live.sqlite');
  if(existsSync(previous))throw new Error('Refusing to overwrite an existing historical recovery image');
  let original=new DatabaseSync(srcPath);
  let target=null;
  let settings;
  let summary;
  try{
    assertHealthy(original,drainId);
    const checkpoint=original.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    if(checkpoint?.busy)throw new Error('SQLite checkpoint busy; do not replace database');
    settings=snapshotSource(original);
    summary={missions:count(original,'missions'),goals:count(original,'goals'),
      events:count(original,'events'),goalEvents:count(original,'goal_events')};
    const schema=original.prepare(
      "SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type,name"
    ).all();
    if(schema.some(item=>!['table','index','trigger'].includes(item.type)))
      throw new Error('Unsupported SQLite schema object; reset refused');
    const actualTables=schema.filter(item=>item.type==='table').map(item=>item.name);
    if(actualTables.length!==SUPPORTED_TABLES.size||
      actualTables.some(name=>!SUPPORTED_TABLES.has(name)))
      throw new Error('Unsupported SQLite table set; reset refused');
    target=new DatabaseSync(temp);
    target.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
    try{
      for(const type of ['table','index','trigger']){
        for(const item of schema.filter(x=>x.type===type)){
          if(!/^(?:CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|TRIGGER)\b)/i.test(item.sql))
            throw new Error('Unknown schema DDL encountered; reset refused');
          target.exec(item.sql);
        }
      }
      const insert=target.prepare('INSERT INTO meta(key,value) VALUES(?,?)');
      for(const [key,value] of settings)insert.run(key,value);
      target.exec('COMMIT; PRAGMA foreign_keys=ON');
    }catch(err){target.exec('ROLLBACK');throw err}
    if(target.prepare('PRAGMA integrity_check').get().integrity_check!=='ok'||
      target.prepare('PRAGMA foreign_key_check').all().length||
      RESET_EMPTY_TABLES.some(table=>count(target,table)!==0)||
      JSON.stringify(target.prepare(
        "SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type,name"
      ).all())!==JSON.stringify(schema))
      throw new Error('Fresh project database failed independent empty-state checks');
  }finally{
    target?.close();
    original.close();
  }
  // SQLite handles and WAL must be closed before the file swap. The private
  // previous image and independently verified earlier backup permit rollback.
  for(const file of [srcPath,temp]){
    for(const suffix of ['-wal','-shm']){
      const sidecar=file+suffix;
      if(existsSync(sidecar)&&statSync(sidecar).size>0)
        throw new Error('Uncheckpointed SQLite sidecar blocks project reset');
      if(existsSync(sidecar))rmSync(sidecar);
    }
  }
  renameSync(srcPath,previous);
  try{renameSync(temp,srcPath)}
  catch(err){renameSync(previous,srcPath);throw err}
  return {result:'RESET_VERIFIED',before:summary,
    preservedConfigKeys:[...settings.keys()].filter(x=>x!=='schema_version'),
    missions:0,goals:0,events:0};
}

export function verifyFreshProjectDatabase(dbPath,drainId){
  const db=new DatabaseSync(dbPath,{readOnly:true});
  try{
    if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok'||
       db.prepare('PRAGMA foreign_key_check').all().length||
       getMeta(db,'telegram.maintenance.drain')!==drainId||
       PROJECT_TABLES.some(t=>count(db,t)!==0)||
       !/^(0|[1-9][0-9]*)$/.test(getMeta(db,'telegram.inbox_cursor')??'')||
       !getMeta(db,'telegram.pi.sshHost')||
       !getMeta(db,'telegram.pi.project')||
       !getMeta(db,'telegram.build.project')||
       getMeta(db,'telegram.pi.project')!==getMeta(db,'telegram.build.project')||
       !getMeta(db,'telegram.chatgpt.anchorUrl')||
       !getMeta(db,'telegram.chatgpt.browserId'))
      throw new Error('Fresh project readback failed');
    // A reset may not leave a grant key pointing at an unrelated repository.
    const scopes=db.prepare(
      "SELECT key,value FROM meta WHERE key LIKE 'telegram.build.allow.%'"
    ).all();
    if(scopes.some(row=>!/^telegram\.build\.allow\.[0-9a-f]{64}$/.test(row.key)||
      (row.value!==''&&createHash('sha256').update(row.value).digest('hex')!==
      row.key.slice('telegram.build.allow.'.length))))
      throw new Error('Repository approval corrupted after project reset');
    return {result:'EMPTY_PROJECT_HISTORY',missions:0,goals:0,events:0,
      inboxCursorPreserved:true,drainHeld:true};
  }finally{db.close()}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{
    const mode=process.argv[2];
    const reply=mode==='--reset'
      ?resetProjectDatabase(process.argv[3],process.argv[4],process.argv[5])
      :mode==='--verify'
        ?verifyFreshProjectDatabase(process.argv[3],process.argv[4])
        :(()=>{throw new Error('Unknown reset mode')})();
    console.log(JSON.stringify(reply));
  }catch{console.error('Fenced project reset refused or failed; inspect private audit and restore image');process.exitCode=2}
}
