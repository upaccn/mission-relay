import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync,backup} from 'node:sqlite';
import {copyFileSync,linkSync,unlinkSync,statSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync,rmSync,truncateSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/core/store.js';
import {GoalLedger} from '../src/core/goal-store.js';
import {assessMaintenanceJournal} from '../src/core/goal-release-maintenance-probe.js';
import {assessGmkReadback} from '../src/core/goal-release-runtime.js';

const sha=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
const SHA='c'.repeat(40),PREVIOUS='b'.repeat(40),TREE='d'.repeat(64),DRAIN='a'.repeat(64);
type Fact={stage:string;details:Record<string,unknown>};
const fixture=async(protectedPaused=false)=>{
  const dir=mkdtempSync(join(tmpdir(),'relay-maintenance-safe-'));
  const path=join(dir,'private.sqlite'),store=new Store(path);
  const original=store.create({goal:'Isolated maintenance recovery verification',
    acceptance:['Keep original settled request'],workspace:'',sandbox:'read-only',
    mode:'supervised',maxTurns:32,checks:[],requestKey:'synthetic-maintenance'});
  const linked=store.linkChat(original.id,
    'https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174008',original.version).mission;
  store.bindChatBrowser(original.id,'synthetic-browser',linked.version);
  let protectedGoalId:string|null=null;
  if(protectedPaused){
    // Isolated representative of a reconciled but permanently interrupted
    // ten-turn Mission. No browser or production history is involved.
    store.db.prepare(`UPDATE missions SET state='PAUSED',turn_count=10,
      last_error='Original reply load failed' WHERE id=?`).run(original.id);
    store.setMeta('chatgpt.browser.active.'+original.id,
      JSON.stringify({status:'reconciled',requestKey:'spent-original'}));
    const ledger=new GoalLedger(store);
    const goal=ledger.createGoal({requestKey:'synthetic-protected-goal',
      objective:original.goal,priority:80});
    ledger.createPlan(goal.id,goal.version,{
      requestKey:'original-protected-plan',summary:'Original immutable Goal operation',
      items:[{key:'preserve-history',title:'Preserve protected history',
        priority:80,acceptance:['Historical request identity remains intact']}]});
    protectedGoalId=goal.id;
    store.setMeta('goal.pi.binding.'+original.id,goal.id);
  }
  const snapshot=join(dir,'missions.sqlite');
  await backup(store.db,snapshot);
  const digest=sha(readFileSync(snapshot));
  const restored=join(dir,'isolated-restore.sqlite');
  // Only a disposable isolated fixture: production uses an independent
  // SQLite backup() restoration before any checkout or build mutation.
  copyFileSync(snapshot,restored);
  const restoredDigest=sha(readFileSync(restored));
  const oldEvents=store.events(original.id);
  const oldMissions=(store.db.prepare('SELECT id FROM missions').all() as {id:string}[]).map(r=>r.id);
  const eventHash=sha(JSON.stringify(store.db.prepare('SELECT * FROM events ORDER BY id').all()));
  const rollbackDir=join(dir,'rollback','dist');
  mkdirSync(rollbackDir,{recursive:true});
  mkdirSync(join(rollbackDir,'plugins'));
  const compiled=[{name:'cli.js',bytes:'/* original worker channel-drain-release-verified */\n'},
    {name:'core.js',bytes:'export const oldWorker = true;\n'},
    {name:'plugins/telegram.js',bytes:'const startedInsideDrain = true;\n'+
      'export async function probeFencedTelegramTransport() { return true; }\n'}];
  const js=compiled.map(file=>({name:file.name,hash:sha(file.bytes)}));
  const tree=sha(js.map(file=>file.name+'\0'+file.hash+'\n').join(''));
  for(const file of compiled)writeFileSync(join(rollbackDir,file.name),file.bytes);
  writeFileSync(join(rollbackDir,'build-provenance.json'),JSON.stringify({
    format:1,sourceSha:PREVIOUS,treeSha256:tree,
    cliSha256:js[0]!.hash,fileCount:js.length,
  })+'\n');
  const allFiles=['build-provenance.json',...compiled.map(f=>f.name)].map(name=>({
    name,hash:sha(readFileSync(join(rollbackDir,name))),
  }));
  const bytesHash=sha(JSON.stringify(allFiles));
  const facts:Fact[]=[
    {stage:'intent',details:{fromSha:PREVIOUS,toSha:SHA,oldWorkerPid:180,source:'github-main-pull-only'}},
    {stage:'rollback_capability_verified',details:{previousSha:PREVIOUS,originalTreeSha256:tree,
      verified:true,compiledFiles:allFiles.length}},
    {stage:'preflight',details:{exitCode:0,message:'synthetic safe preflight',
      channel:{pollerPid:180,pollerPresent:true,pendingReplies:0,
        notificationsCursor:store.maxEventId(),lastEventId:store.maxEventId()}}},
    {stage:'drain_acquired',details:{confirmedRequested:true,drainIdSha256:DRAIN,
      oldWorkerPid:180}},
    {stage:'worker_stopped',details:{oldWorkerPid:180,pollerPresent:false}},
    {stage:'sqlite_backup',details:{sha256:digest,integrity:'ok',reserved:0,
      missions:oldMissions.length,events:{count:oldEvents.length}}},
    {stage:'sqlite_restore_verified',details:{backupSha256:digest,
      restoredSha256:restoredDigest,integrity:'ok',foreignKeyViolations:0}},
    {stage:'compiled_rollback_saved',details:{previousSha:PREVIOUS,verified:true,
      compiledTreeSha256:tree,copiedBytesSha256:bytesHash,fileCount:allFiles.length}},
    {stage:'source_verified',details:{fetchedSha:SHA,expectedSha:SHA}},
    {stage:'checkout_updated',details:{newSha:SHA,previousSha:PREVIOUS,method:'pull --ff-only origin main'}},
    {stage:'compiled',details:{sourceSha:SHA,compiledTreeSha256:TREE}},
    {stage:'worker_healthy',details:{pid:200,transportHealth:'healthy',fenced:true,
      notificationsCursor:store.maxEventId(),lastEventId:store.maxEventId()}},
    {stage:'runtime_verified',details:{pid:200,sourceSha:SHA,compiledTreeSha256:TREE,fenced:true}},
    {stage:'sqlite_continuity_verified',details:{
      eventsSha256:eventHash,integrity:'ok',originalEvents:oldEvents.length,
      originalMissions:oldMissions.length,newHighWater:store.maxEventId(),
      missionRowsSha256:sha(JSON.stringify(store.db.prepare('SELECT * FROM missions ORDER BY id').all())),
      requestsSha256:sha(JSON.stringify(store.db.prepare(
        "SELECT key,value FROM meta WHERE key LIKE 'chatgpt.browser.active.%' ORDER BY key").all())),
      foreignKeyViolations:0}},
    {stage:'fenced_acceptance_verified',details:{sha:SHA,pid:200,
      drainHeld:true,rollbackVerified:true}},
    {stage:'drain_release_requested',details:{drainIdSha256:DRAIN}},
    {stage:'drain_released',details:{confirmed:true}},
    {stage:'complete',details:{sha:SHA,pid:200,result:'healthy'}},
  ];
  const render=(stages:Fact[]=facts)=>{
    let prev='';
    return stages.map((s,i)=>{
      const original=JSON.stringify({sequence:i+1,
        at:new Date(Date.now()-60_000+(i*100)).toISOString(),
        stage:s.stage,previousSha256:prev,details:s.details});
      const next=sha(original),line=JSON.stringify({payload:original,sha256:next});
      prev=next;return line;
    }).join('\n')+'\n';
  };
  return {dir,store,original,protectedGoalId,snapshot,restored,rollbackDir,
    rollbackBytesSha256:bytesHash,rollbackTreeSha256:tree,facts,render,
    close:()=>{store.close();rmSync(dir,{recursive:true,force:true});}};
};

test('verified atomic drain, SQLite backup integrity, history continuity and single verified restart receipt',async()=>{
  const f=await fixture();try{
    const receipt=assessMaintenanceJournal(f.render(),SHA,f.snapshot,f.store);
    assert.equal(receipt.sourceSha,SHA);
    assert.equal(receipt.previousSha,PREVIOUS);
    assert.equal(receipt.originalMissions,1);
    assert.equal(receipt.runtimePid,200);
    assert.equal(receipt.lastHistoricalEventId,f.store.maxEventId());
    assert.ok(Number.isSafeInteger(receipt.lastHistoricalGoalEventId));
    assert.match(receipt.sqliteBackupSha256,/^[a-f0-9]{64}$/);
    assert.equal(receipt.isolatedRestoreSha256,sha(readFileSync(f.restored)));
    assert.match(receipt.historicalEventsSha256,/^[a-f0-9]{64}$/);
    assert.equal(receipt.rollbackBytesSha256,f.rollbackBytesSha256);
    assert.equal(receipt.rollbackTreeSha256,f.rollbackTreeSha256);
    assert.equal(receipt.rollbackFileCount,4);
    assert.equal(receipt.drainIdSha256,DRAIN);
  }finally{f.close();}
});

test('drained SQLite backup restores into an isolated database with original paused request and stop custody',async()=>{
  const f=await fixture(true);
  try{
    const restoredFile=f.restored;
    const originalBackupSha=sha(readFileSync(f.snapshot));
    const expectedEvents=f.store.db.prepare('SELECT * FROM events ORDER BY id').all();
    const expectedMissions=f.store.db.prepare(`SELECT id,state,turn_count,
      stop_requested,last_error FROM missions ORDER BY id`).all();
    const protectedGoalTables=[
      'goals','goal_plans','goal_work_items','goal_dependencies','goal_acceptance',
      'goal_events','goal_operations','goal_release_targets','goal_release_checks',
      'goal_release_completion',
    ];
    const expectedGoalRows=new Map(protectedGoalTables.map(table=>[
      table,f.store.db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all(),
    ]));
    const receiptKey='chatgpt.browser.active.'+f.original.id;
    const expectedReceipt=f.store.getMeta(receiptKey);
    // Copy only the already completed sqlite.backup() file; never copy a
    // live WAL database or open its original production path for writing.
    copyFileSync(f.snapshot,restoredFile);
    const restored=new DatabaseSync(restoredFile,{readOnly:true});
    try{
      restored.exec('PRAGMA query_only=ON');
      assert.equal(restored.prepare('PRAGMA integrity_check').get()?.integrity_check,'ok');
      assert.deepEqual(restored.prepare('PRAGMA foreign_key_check').all(),[]);
      assert.deepEqual(restored.prepare('SELECT * FROM events ORDER BY id').all(),expectedEvents);
      assert.deepEqual(restored.prepare(`SELECT id,state,turn_count,
        stop_requested,last_error FROM missions ORDER BY id`).all(),expectedMissions);
      for(const [table,expectedRows] of expectedGoalRows)
        assert.deepEqual(restored.prepare('SELECT * FROM '+table+' ORDER BY rowid').all(),
          expectedRows,'Isolated restore must preserve '+table);
      assert.equal(restored.prepare('SELECT value FROM meta WHERE key=?')
        .get('goal.pi.binding.'+f.original.id)?.value,f.protectedGoalId);
      assert.equal(restored.prepare('SELECT value FROM meta WHERE key=?')
        .get(receiptKey)?.value,expectedReceipt);
      const protectedMission=restored.prepare(`SELECT state,turn_count,
        stop_requested,last_error FROM missions WHERE id=?`).get(f.original.id);
      assert.deepEqual({...protectedMission},{state:'PAUSED',turn_count:10,
        stop_requested:0,last_error:'Original reply load failed'});
    }finally{restored.close();}
    assert.equal(sha(readFileSync(f.snapshot)),originalBackupSha);
    // A corrupt restored *copy* fails closed, never changes the recoverable
    // original backup or claims a valid maintenance receipt.
    truncateSync(restoredFile,512);
    assert.throws(()=>{
      const damaged=new DatabaseSync(restoredFile,{readOnly:true});
      try{
        if(damaged.prepare('PRAGMA integrity_check').get()?.integrity_check!=='ok')
          throw new Error('Damaged restored SQLite integrity');
      }finally{damaged.close();}
    });
    assert.equal(sha(readFileSync(f.snapshot)),originalBackupSha);
    assert.throws(()=>assessMaintenanceJournal(f.render(),SHA,f.snapshot,f.store),
      /Isolated SQLite restoration is missing or altered/);
    // Restore only the *test copy* without modifying the original backup.
    copyFileSync(f.snapshot,restoredFile);
    assert.doesNotThrow(()=>assessMaintenanceJournal(f.render(),SHA,f.snapshot,f.store));
  }finally{f.close();}
});

test('pending request and active mission refuse an atomic drain and never mark original Send delivered',async()=>{
  const f=await fixture();try{
    const m=f.store.get(f.original.id);
    f.store.reserveChatBrowserTurn(m.id,m.version,'unresolved-send',sha('prompt'),{
      newConversation:true});
    assert.throws(()=>f.store.requestChannelDrain('telegram'),/Maintenance deferred/);
    assert.equal(f.store.channelDrainRequested('telegram'),false);
    assert.equal(f.store.get(f.original.id).turnCount,0);
    assert.equal(f.store.chatBrowserTurn(m.id)?.status,'reserved');
    f.store.finishChatBrowserTurn(m.id,'unresolved-send',{
      kind:'uncertain',error:'Network link interrupted after the request'});
    assert.equal(f.store.get(m.id).turnCount,0);
    assert.throws(()=>f.store.reserveChatBrowserTurn(m.id,
      f.store.get(m.id).version,'duplicate',sha('prompt 2')),/Cannot run|state/);
    assert.equal(f.store.events(m.id).filter(x=>x.type==='chatgpt.browser_reserved').length,1);
  }finally{f.close();}
});

test('atomic drain refuses PI READY work, undelivered Telegram commands, unscanned events and invalid notification cursors',async()=>{
  const failures:Array<{name:string;inject:(f:Awaited<ReturnType<typeof fixture>>)=>void}>=[
    {name:'accepted PI READY',inject:f=>f.store.setMeta(
      'pi.autopilot.enabled.'+f.original.id,'1')},
    {name:'durable Telegram command',inject:f=>{f.store.db.prepare(
      `INSERT INTO channel_commands(source,external_id,status,reply,received_at)
       VALUES('telegram','synthetic-only','reserved','',?)`
    ).run(new Date().toISOString());}},
    {name:'event delivery backlog',inject:f=>f.store.setMeta(
      'telegram.notifications_cursor','0')},
    {name:'invalid event cursor',inject:f=>f.store.setMeta(
      'telegram.notifications_cursor','not-an-integer')},
  ];
  for(const {name,inject} of failures){
    const f=await fixture();
    try{
      inject(f);
      assert.throws(()=>f.store.requestChannelDrain('telegram'),undefined,name);
      assert.equal(f.store.channelDrainRequested('telegram'),false,name);
      const reopened=new Store(join(f.dir,'private.sqlite'));
      try{
        assert.equal(reopened.channelDrainRequested('telegram'),false,name);
        assert.equal(reopened.get(f.original.id).turnCount,0,name);
        assert.equal(reopened.events(f.original.id)
          .filter(x=>x.type==='chatgpt.browser_reserved').length,0,name);
      }finally{reopened.close();}
    }finally{f.close();}
  }
});

test('maintenance exclusion survives SQLite reconnect and permits only original drain token to release',async()=>{
  const f=await fixture();
  try{
    f.store.setMeta('telegram.notifications_cursor',String(f.store.maxEventId()));
    const token=f.store.requestChannelDrain('telegram');
    const second=new Store(join(f.dir,'private.sqlite'));
    try{
      assert.equal(second.channelDrainRequested('telegram'),true);
      assert.equal(second.channelDrainId('telegram'),token);
      assert.throws(()=>second.requestChannelDrain('telegram'),/already requested/);
      assert.throws(()=>second.releaseChannelDrain('telegram','forged-maintenance-token'),
        /mismatch/);
      assert.equal(f.store.channelDrainId('telegram'),token);
      second.releaseChannelDrain('telegram',token);
      assert.equal(f.store.channelDrainId('telegram'),null);
      assert.equal(second.channelDrainRequested('telegram'),false);
      assert.equal(f.store.events(f.original.id).filter(e=>
        e.type==='chatgpt.browser_reserved').length,0);
    }finally{second.close();}
  }finally{f.close();}
});

test('successful drain is exclusive and fences browser Sends until same original token releases',async()=>{
  const f=await fixture();try{
    f.store.setMeta('telegram.notifications_cursor',String(f.store.maxEventId()));
    const lease=f.store.requestChannelDrain('telegram');
    assert.match(lease,/^[a-f0-9-]{36}$/i);
    assert.throws(()=>f.store.requestChannelDrain('telegram'),/already requested/);
    assert.equal(f.store.channelDrainId('telegram'),lease);
    assert.throws(()=>f.store.reserveChatBrowserTurn(f.original.id,
      f.store.get(f.original.id).version,'blocked-by-drain',sha('blocked')),
      /drain active/);
    assert.throws(()=>f.store.releaseChannelDrain('telegram','wrong-token'),/mismatch/);
    assert.equal(f.store.channelDrainRequested('telegram'),true);
    f.store.releaseChannelDrain('telegram',lease);
    assert.equal(f.store.channelDrainRequested('telegram'),false);
    assert.equal(f.store.events(f.original.id).filter(x=>x.type==='chatgpt.browser_reserved').length,0);
  }finally{f.close();}
});

test('journal forged hashes, duplicates, wrong order and incomplete restart never become maintenance PASS',async()=>{
  const f=await fixture();try{
    const cases=[
      f.render().replace(SHA,'a'.repeat(40)),
      f.render(f.facts.filter(x=>x.stage!=='sqlite_backup')),
      f.render(f.facts.filter(x=>x.stage!=='rollback_capability_verified')),
      f.render(f.facts.map(x=>x.stage==='rollback_capability_verified'?
        {...x,details:{...x.details,verified:false}}:x)),
      f.render(f.facts.map(x=>x.stage==='rollback_capability_verified'?
        {...x,details:{...x.details,mode:'unknown'}}:x)),
      f.render(f.facts.map(x=>x.stage==='intent'?
        {...x,details:{...x.details,legacyMigration:true}}:x)),
      f.render(f.facts.map(x=>x.stage==='rollback_capability_verified'?
        {...x,details:{...x.details,mode:'legacy-release-before-start'}}:x)),
      f.render(f.facts.map(x=>x.stage==='rollback_capability_verified'?
        {...x,details:{...x.details,mode:'legacy-release-before-start',
          legacyCliSha256:'6801cca587e12482fb638ee9b864493346e5b12d0c1b1bb8dee719bdd85e73b6',
          legacyModuleSha256:'520f4bba184a207853a6d4104754cb5930fe7ac4af5f6fad8d1a85a84967ebb5'}}:x)),
      f.render(f.facts.filter(x=>x.stage!=='sqlite_restore_verified')),
      f.render(f.facts.map(x=>x.stage==='sqlite_restore_verified'?
        {...x,details:{...x.details,backupSha256:'0'.repeat(64)}}:x)),
      f.render(f.facts.map(x=>x.stage==='sqlite_restore_verified'?
        {...x,details:{...x.details,restoredSha256:'0'.repeat(64)}}:x)),
      f.render(f.facts.map(x=>x.stage==='compiled_rollback_saved'?
        {...x,details:{...x.details,verified:false}}:x)),
      f.render(f.facts.map(x=>x.stage==='compiled_rollback_saved'?
        {...x,details:{...x.details,copiedBytesSha256:'0'}}:x)),
      f.render([...f.facts.slice(0,-1),
        {stage:'rollback_verified',details:{restoredSha:PREVIOUS}},
        f.facts.at(-1)!]),
      f.render(f.facts.filter(x=>x.stage!=='worker_healthy')),
      f.render(f.facts.filter(x=>x.stage!=='fenced_acceptance_verified')),
      f.render(f.facts.map(x=>x.stage==='fenced_acceptance_verified'?
        {...x,details:{...x.details,drainHeld:false}}:x)),
      f.render(f.facts.map(x=>x.stage==='worker_healthy'?
        {...x,details:{...x.details,fenced:false}}:x)),
      f.render(f.facts.map(x=>x.stage==='worker_healthy'?
        {...x,details:{pid:200,transportHealth:'healthy',fenced:true}}:x)),
      f.render(f.facts.map(x=>x.stage==='sqlite_continuity_verified'?
        {...x,details:{...x.details,foreignKeyViolations:1}}:x)),
      f.render(f.facts.map(x=>x.stage==='sqlite_continuity_verified'?
        {...x,details:{...x.details,requestsSha256:'0'.repeat(64)}}:x)),
      f.render([...f.facts.slice(0,-1),{stage:'runtime_identity_failed',details:{}},f.facts.at(-1)!]),
      f.render(f.facts.map(x=>x.stage==='source_verified'?
        {...x,details:{...x.details,expectedSha:PREVIOUS}}:x)),
      f.render(f.facts.map(x=>x.stage==='drain_acquired'?
        {...x,details:{confirmedRequested:false}}:x)),
      f.render(f.facts.map(x=>x.stage==='preflight'?
        {...x,details:{exitCode:3}}:x)),
      f.render(f.facts.map(x=>x.stage==='preflight'?
        {...x,details:{...x.details,channel:{pollerPid:180,
          pollerPresent:true,pendingReplies:1,notificationsCursor:1,lastEventId:1}}}:x)),
      f.render(f.facts.map(x=>x.stage==='preflight'?
        {...x,details:{...x.details,channel:{pollerPid:180,
          pollerPresent:true,pendingReplies:0,notificationsCursor:0,lastEventId:1}}}:x)),
      f.render(f.facts.map(x=>x.stage==='preflight'?
        {...x,details:{...x.details,channel:{pollerPid:180,
          pollerPresent:false,pendingReplies:0,notificationsCursor:1,lastEventId:1}}}:x)),
      f.render(f.facts.map(x=>x.stage==='drain_acquired'?
        {...x,details:{...x.details,oldWorkerPid:181}}:x)),
      f.render(f.facts.map(x=>x.stage==='worker_stopped'?
        {...x,details:{...x.details,pollerPresent:true}}:x)),
      f.render(f.facts.map(x=>x.stage==='drain_release_requested'?
        {...x,details:{drainIdSha256:'b'.repeat(64)}}:x)),
      f.render(f.facts.map(x=>x.stage==='worker_healthy'?
        {...x,details:{...x.details,pid:205}}:x)),
    ];
    for(const raw of cases)assert.throws(()=>assessMaintenanceJournal(raw,SHA,
      f.snapshot,f.store));
  }finally{f.close();}
});

test('rollback readiness independently checks retained original compiled bytes and manifest',async()=>{
  const cases=[
    {name:'missing image',mutate:(dir:string)=>rmSync(dir,{recursive:true})},
    {name:'altered CLI',mutate:(dir:string)=>writeFileSync(join(dir,'cli.js'),'forged')},
    {name:'missing module',mutate:(dir:string)=>rmSync(join(dir,'core.js'))},
    {name:'changed manifest',mutate:(dir:string)=>writeFileSync(join(dir,'build-provenance.json'),
      JSON.stringify({format:1,sourceSha:SHA}))},
    {name:'extra file',mutate:(dir:string)=>writeFileSync(join(dir,'unexpected.js'),'extra')},
  ];
  for(const {name,mutate} of cases){
    const f=await fixture(true);
    try{
      const originalRequest=f.store.getMeta('chatgpt.browser.active.'+f.original.id);
      const originalGoal=f.protectedGoalId;
      const originalEvents=sha(JSON.stringify(f.store.db.prepare('SELECT * FROM events').all()));
      const journal=f.render();
      assert.doesNotThrow(()=>assessMaintenanceJournal(journal,SHA,f.snapshot,f.store),name);
      mutate(f.rollbackDir);
      assert.throws(()=>assessMaintenanceJournal(journal,SHA,f.snapshot,f.store),
        /rollback|ENOENT/i,name);
      assert.equal(f.store.get(f.original.id).state,'PAUSED',name);
      assert.equal(f.store.get(f.original.id).turnCount,10,name);
      assert.equal(f.store.getMeta('chatgpt.browser.active.'+f.original.id),originalRequest,name);
      assert.equal(f.store.getMeta('goal.pi.binding.'+f.original.id),originalGoal,name);
      assert.equal(sha(JSON.stringify(f.store.db.prepare('SELECT * FROM events').all())),
        originalEvents,name);
    }finally{f.close();}
  }
});

test('an intact backup cannot certify a forged or corrupted isolated restoration',async()=>{
  const f=await fixture(true);
  try{
    const record=f.render(),backupSha=sha(readFileSync(f.snapshot));
    assert.doesNotThrow(()=>assessMaintenanceJournal(record,SHA,f.snapshot,f.store));
    // A valid-looking, separately hashed restore can still lose historical
    // records; cross-table comparison must fail instead of trusting a hash.
    const recovered=new DatabaseSync(f.restored);
    recovered.exec('DELETE FROM goal_operations');
    recovered.close();
    const updatedSha=sha(readFileSync(f.restored));
    const forged=f.render(f.facts.map(s=>s.stage==='sqlite_restore_verified'?
      {...s,details:{...s.details,restoredSha256:updatedSha}}:s));
    assert.throws(()=>assessMaintenanceJournal(forged,SHA,f.snapshot,f.store),
      /restore lost original request or history rows/);
    assert.equal(sha(readFileSync(f.snapshot)),backupSha);
  }finally{f.close();}
});

test('an intact same-inode hard-link alias is never an isolated SQLite restore (Linux and Windows)',async()=>{
  const f=await fixture(true);
  try{
    const original=f.render(),backupBytes=readFileSync(f.snapshot);
    const protectedBefore=f.store.db.prepare(`SELECT id,state,turn_count,
      stop_requested,last_error FROM missions WHERE id=?`).get(f.original.id);
    const eventsBefore=f.store.db.prepare('SELECT * FROM events ORDER BY id').all();
    assert.doesNotThrow(()=>assessMaintenanceJournal(original,SHA,f.snapshot,f.store));
    unlinkSync(f.restored);
    linkSync(f.snapshot,f.restored);
    const backupIdentity=statSync(f.snapshot,{bigint:true});
    const restoreIdentity=statSync(f.restored,{bigint:true});
    assert.equal(backupIdentity.dev,restoreIdentity.dev);
    assert.equal(backupIdentity.ino,restoreIdentity.ino);
    assert.equal(sha(readFileSync(f.restored)),sha(backupBytes));
    assert.throws(()=>assessMaintenanceJournal(original,SHA,f.snapshot,f.store),
      /restoration aliases the original backup file/);
    assert.deepEqual(readFileSync(f.snapshot),backupBytes);
    assert.deepEqual(f.store.db.prepare(`SELECT id,state,turn_count,
      stop_requested,last_error FROM missions WHERE id=?`).get(f.original.id),
      protectedBefore);
    assert.deepEqual(f.store.db.prepare('SELECT * FROM events ORDER BY id').all(),
      eventsBefore);
    // A truly independent copy with exactly the same bytes must still pass.
    unlinkSync(f.restored);
    copyFileSync(f.snapshot,f.restored);
    assert.notEqual(statSync(f.snapshot,{bigint:true}).ino,
      statSync(f.restored,{bigint:true}).ino);
    assert.doesNotThrow(()=>assessMaintenanceJournal(original,SHA,f.snapshot,f.store));
  }finally{f.close();}
});

test('backup mutation and changed live original event custody fail; later new events are permitted',async()=>{
  const f=await fixture();try{
    const original=f.render();
    const newMission=f.store.create({goal:'Additional independent work',acceptance:['Separate'],
      workspace:'',sandbox:'read-only',mode:'supervised',maxTurns:1,checks:[],
      requestKey:'post-upgrade-work'});
    assert.equal(f.store.get(newMission.id).turnCount,0);
    assert.doesNotThrow(()=>assessMaintenanceJournal(original,SHA,f.snapshot,f.store),
      'New append-only work after the snapshot must not invalidate preserved history');
    const db=new DatabaseSync(f.snapshot);
    db.exec("INSERT INTO meta(key,value) VALUES('test.audit.changed','yes')");
    db.close();
    assert.throws(()=>assessMaintenanceJournal(original,SHA,f.snapshot,f.store),
      /backup missing or changed/);
  }finally{f.close();}
});

test('altered original live SQLite event custody is rejected even when the snapshot matches',async()=>{
  const f=await fixture();try{
    const original=f.render();
    const event=f.store.events(f.original.id).find(x=>x.type==='mission.created')!;
    // In isolated synthetic SQLite only: defeat immutable trigger intentionally
    // to demonstrate that the independent continuity digest detects tampering.
    const triggers=f.store.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='events'")
      .all() as {name:string}[];
    for(const t of triggers)f.store.db.exec('DROP TRIGGER "'+t.name+'"');
    f.store.db.prepare('UPDATE events SET payload_json=? WHERE id=?')
      .run('{"goal":"tampered"}',event.id);
    assert.throws(()=>assessMaintenanceJournal(original,SHA,f.snapshot,f.store),
      /custody changed/);
  }finally{f.close();}
});

test('a protected paused Mission cannot silently change state, 10-turn count, stop flag, error or original receipt',async()=>{
  const changes:Array<(f:Awaited<ReturnType<typeof fixture>>)=>void>=[
    f=>{f.store.db.prepare("UPDATE missions SET state='RUNNING' WHERE id=?").run(f.original.id);},
    f=>{f.store.db.prepare('UPDATE missions SET turn_count=11 WHERE id=?').run(f.original.id);},
    f=>{f.store.db.prepare('UPDATE missions SET stop_requested=1 WHERE id=?').run(f.original.id);},
    f=>{f.store.db.prepare('UPDATE missions SET last_error=NULL WHERE id=?').run(f.original.id);},
    f=>{f.store.setMeta('chatgpt.browser.active.'+f.original.id,
      JSON.stringify({status:'observed',requestKey:'spent-original'}));},
    f=>{f.store.db.prepare("UPDATE missions SET goal='altered origin' WHERE id=?").run(f.original.id);},
  ];
  for(const change of changes){
    const f=await fixture(true);
    try{
      const original=f.render();
      assert.doesNotThrow(()=>assessMaintenanceJournal(original,SHA,f.snapshot,f.store));
      change(f);
      assert.throws(()=>assessMaintenanceJournal(original,SHA,f.snapshot,f.store),
        /Historical SQLite event\/Mission custody changed/);
    }finally{f.close();}
  }
});

test('maintenance proof preserves protected Goal identity, version, binding, operations and append-only Goal history',async()=>{
  const cases:Array<(f:Awaited<ReturnType<typeof fixture>>)=>void>=[
    f=>{f.store.db.prepare('UPDATE goals SET status=? WHERE id=?')
      .run('ACTIVE',f.protectedGoalId);},
    f=>{f.store.db.prepare('UPDATE goals SET version=version+1 WHERE id=?')
      .run(f.protectedGoalId);},
    f=>{f.store.db.prepare('UPDATE goals SET objective=? WHERE id=?')
      .run('Substituted owner objective',f.protectedGoalId);},
    f=>{f.store.db.prepare('DELETE FROM meta WHERE key=?')
      .run('goal.pi.binding.'+f.original.id);},
    f=>{
      const triggers=f.store.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='goal_events'"
      ).all() as {name:string}[];
      for(const t of triggers)f.store.db.exec('DROP TRIGGER "'+t.name+'"');
      f.store.db.prepare('UPDATE goal_events SET payload_json=? WHERE goal_id=?')
        .run('{"substituted":true}',f.protectedGoalId);
    },
    f=>{f.store.db.prepare('UPDATE goal_operations SET result_json=? WHERE goal_id=?')
      .run('{"forged":true}',f.protectedGoalId);},
  ];
  for(const alter of cases){
    const f=await fixture(true);
    try{
      const before=f.render();
      assert.ok(f.protectedGoalId);
      // Ensure the fixture contains an original idempotent operation.
      assert.ok((f.store.db.prepare('SELECT COUNT(*) AS n FROM goal_operations WHERE goal_id=?')
        .get(f.protectedGoalId) as {n:number}).n>0);
      assert.doesNotThrow(()=>assessMaintenanceJournal(before,SHA,f.snapshot,f.store));
      alter(f);
      assert.throws(()=>assessMaintenanceJournal(before,SHA,f.snapshot,f.store),
        /Historical SQLite event\/Mission custody changed/);
    }finally{f.close();}
  }
});

test('protected historical Goal plan, work and acceptance rows cannot be rewritten under an otherwise valid upgrade journal',async()=>{
  const mutations:Array<{name:string;apply:(f:Awaited<ReturnType<typeof fixture>>)=>void}>=[
    {name:'approved-plan payload',apply:f=>{f.store.db.prepare(
      'UPDATE goal_plans SET summary=? WHERE goal_id=?'
    ).run('Substituted approved plan',f.protectedGoalId);}},
    {name:'work item identity and status',apply:f=>{f.store.db.prepare(
      'UPDATE goal_work_items SET item_key=?,status=? WHERE goal_id=?'
    ).run('substituted-protected-work','PASSED',f.protectedGoalId);}},
    {name:'original acceptance criterion',apply:f=>{f.store.db.prepare(
      `UPDATE goal_acceptance SET criterion=? WHERE item_id IN
        (SELECT id FROM goal_work_items WHERE goal_id=?)`
    ).run('Forged acceptance',f.protectedGoalId);}},
    {name:'unexpected release target',apply:f=>{
      const plan=f.store.db.prepare('SELECT id FROM goal_plans WHERE goal_id=?')
        .get(f.protectedGoalId) as {id:string};
      const goal=f.store.db.prepare('SELECT version FROM goals WHERE id=?')
        .get(f.protectedGoalId) as {version:number};
      f.store.db.prepare(`INSERT INTO goal_release_targets(goal_id,target_sha,
        goal_version,plan_id,plan_version,graph_sha256,revision,created_at)
        VALUES(?,?,?,?,?,?,?,?)`).run(f.protectedGoalId,'a'.repeat(40),
          goal.version,plan.id,1,'b'.repeat(64),1,new Date().toISOString());
    }},
  ];
  for(const {name,apply} of mutations){
    const f=await fixture(true);
    try{
      const journal=f.render();
      assert.ok(f.protectedGoalId);
      assert.doesNotThrow(()=>assessMaintenanceJournal(journal,SHA,f.snapshot,f.store));
      apply(f);
      assert.throws(()=>assessMaintenanceJournal(journal,SHA,f.snapshot,f.store),
        /Historical SQLite .* custody changed/,name);
    }finally{f.close();}
  }
});

test('unprotected active Goal work may advance while original Goal events remain append-only',async()=>{
  const f=await fixture();
  try{
    const goal=new GoalLedger(f.store).createGoal({requestKey:'later-unprotected-goal',
      objective:'An isolated follow-on Mission',priority:70});
    const baseline=f.render();
    f.store.db.prepare('UPDATE goals SET status=?,version=version+1 WHERE id=?')
      .run('ACTIVE',goal.id);
    assert.doesNotThrow(()=>assessMaintenanceJournal(baseline,SHA,f.snapshot,f.store));
  }finally{f.close();}
});

test('normal, non-protected work may advance after an upgrade without invalidating preserved history',async()=>{
  const f=await fixture();
  try{
    const receipt=f.render();
    f.store.db.prepare("UPDATE missions SET state='RUNNING',turn_count=1 WHERE id=?")
      .run(f.original.id);
    assert.doesNotThrow(()=>assessMaintenanceJournal(receipt,SHA,f.snapshot,f.store));
  }finally{f.close();}
});

test('GMK production runtime readback rejects mismatched compiled Worker and missing Chrome custody',()=>{
  const source={sourceSha:SHA,compiledTreeSha256:TREE,cliSha256:'a'.repeat(64),
    manifestSha256:'b'.repeat(64),fileCount:38};
  const proof={
    source,
    channel:{source:'telegram',inboxCursor:42,notificationsCursor:70,lastEventId:70,
      pollerPresent:true,pollerPid:200,transportHealth:'healthy',
      drainRequested:false,pendingReplies:0,
      runtimeProvenance:{...source,pid:200,at:'2026-11-10T00:00:00Z'}},
    task:{installed:true,taskVerified:true,taskState:'Running',recoverySchedule:true,
      pollerPresent:true,pollerPid:200,transportHealth:'healthy',
      workerProcessVerified:true,workerProcessStartedAt:'2026-11-09T23:59:59Z',
      workerParentStartedAt:'2026-11-09T23:59:58Z'},
    sqliteIntegrity:'ok',foreignKeyViolations:0,
    chrome:{exactUrl:true,promptSha256:'a'.repeat(64),answerSha256:'b'.repeat(64),
      stable:true,composerReady:true,generating:false},
    expectedPromptSha256:'a'.repeat(64),expectedAnswerSha256:'b'.repeat(64),
  };
  assert.doesNotThrow(()=>assessGmkReadback(SHA,proof));
  assert.throws(()=>assessGmkReadback(SHA,{
    ...proof,channel:{...proof.channel,runtimeProvenance:{
      ...proof.channel.runtimeProvenance,compiledTreeSha256:'c'.repeat(64)}}}));
  assert.throws(()=>assessGmkReadback(SHA,{
    ...proof,chrome:{...proof.chrome,answerSha256:'c'.repeat(64)}}));
  assert.throws(()=>assessGmkReadback(SHA,{
    ...proof,channel:{...proof.channel,pollerPid:201}}));
});

test('concurrent SQLite writer lock refuses maintenance drain without leaking a second lease',async()=>{
  const f=await fixture();
  const second=new Store(join(f.dir,'private.sqlite'));
  try{
    second.db.exec('PRAGMA busy_timeout=40');
    f.store.db.exec('BEGIN IMMEDIATE');
    try{
      assert.throws(()=>second.requestChannelDrain('telegram'),/locked|BUSY/i);
    }finally{f.store.db.exec('ROLLBACK');}
    assert.equal(second.channelDrainRequested('telegram'),false);
    f.store.setMeta('telegram.notifications_cursor',String(f.store.maxEventId()));
    const id=second.requestChannelDrain('telegram');
    assert.equal(f.store.channelDrainId('telegram'),id);
    second.releaseChannelDrain('telegram',id);
    assert.equal(f.store.channelDrainRequested('telegram'),false);
  }finally{second.close();f.close();}
});

test('network interruption plus failed PI inference never creates a second Send or a false maintenance completion',async()=>{
  const f=await fixture();try{
    const m=f.store.get(f.original.id),request='original-network-request',
      text='Full synthetic answer\n[MISSION_RELAY:NEXT]';
    f.store.reserveChatBrowserTurn(m.id,m.version,request,sha('original prompt'),{
      newConversation:true});
    f.store.finishChatBrowserTurn(m.id,request,{kind:'uncertain',
      error:'Original network response interrupted after Send'});
    assert.equal(f.store.get(m.id).turnCount,0);
    assert.equal(f.store.events(m.id).filter(x=>x.type==='chatgpt.browser_reserved').length,1);
    assert.throws(()=>f.store.commitPiPlan(m.id,sha(text),[],{
      action:'NEXT',summary:'not yet observed',nextPrompt:'replay Send'}),
    /fully observed|matching/);
    // A valid prior backup remains valid even when the later uncertain
    // response is preserved; it does not grant request settlement or PI PASS.
    assert.doesNotThrow(()=>assessMaintenanceJournal(f.render(),SHA,f.snapshot,f.store));
    assert.equal(f.store.chatBrowserTurn(m.id)?.status,'uncertain');
    assert.equal(f.store.events(m.id).filter(x=>x.type==='chatgpt.browser_reserved').length,1);
  }finally{f.close();}
});

test('controlled rollback preserves original compiled and request state but cannot be mistaken for successful promotion',async()=>{
  const f=await fixture();try{
    const original=f.render();
    const old=f.store.events(f.original.id).map(e=>[e.id,e.type,e.payload]);
    const previousHead=PREVIOUS;
    const rolledBack=f.render([...f.facts.filter(s=>s.stage!=='complete'),
      {stage:'upgrade_failed',details:{changedHead:true,workerStopped:true}},
      {stage:'rollback_verified',details:{restoredSha:PREVIOUS}}]);
    assert.throws(()=>assessMaintenanceJournal(rolledBack,SHA,f.snapshot,f.store),
      /interrupted or rolled-back/);
    assert.equal(previousHead,PREVIOUS);
    assert.deepEqual(f.store.events(f.original.id).map(e=>[e.id,e.type,e.payload]),old);
    assert.doesNotThrow(()=>assessMaintenanceJournal(original,SHA,f.snapshot,f.store));
    assert.equal(f.store.get(f.original.id).turnCount,0);
  }finally{f.close();}
});
