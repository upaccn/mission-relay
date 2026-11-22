import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,copyFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {backup,DatabaseSync} from 'node:sqlite';
import {Store} from '../src/core/store.js';
import {GoalLedger} from '../src/core/goal-store.js';
import {MAX_RELAY_CHAT_TURNS} from '../src/core/chat-limits.js';
import {SshPiPlanner,piInferenceArgs} from '../src/core/pi-planner.js';
import {inspectPiEvidence} from '../src/core/pi-evidence.js';

const digest=(text:string|Buffer)=>createHash('sha256').update(text).digest('hex');
const sourceSha=()=>execFileSync('git',['rev-parse','HEAD'],{
  cwd:process.cwd(),encoding:'utf8',timeout:5000}).trim();
const url=(n:number)=>'https://chatgpt.com/c/123e4567-e89b-42d3-a456-'+
  String(426614170000+n).padStart(12,'0');
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'mr-v1-deterministic-limits-'));
  const file=join(dir,'missions.sqlite'),store=new Store(file);
  return {dir,file,store,close:()=>{store.close();rmSync(dir,{force:true,recursive:true});}};
}
function receipt(kind:string,observed:Record<string,unknown>):void {
  process.stdout.write('MR_LIMIT_RECEIPT='+JSON.stringify({
    version:1,kind,sourceSha:sourceSha(),fixture:'isolated-sqlite-no-browser-send',
    observed})+'\n');
}
test('isolated SQLite integrity, backup and independent restore preserve protected rows and stop flags',async()=>{
  const f=fixture();
  try{
    const created=f.store.create({goal:'Synthetic protected history',
      acceptance:['Keep historical stop flag'],workspace:'',sandbox:'read-only',
      mode:'supervised',requestKey:'protected-original',checks:[]});
    f.store.update(created.id,created.version,{stopRequested:true},
      'mission.pause_requested',{reason:'synthetic owner stop'});
    const original=f.store.get(created.id);
    const events=f.store.events(created.id);
    const saved=join(f.dir,'backup.sqlite'),restored=join(f.dir,'isolated-restore.sqlite');
    await backup(f.store.db,saved);
    copyFileSync(saved,restored);
    const copy=new DatabaseSync(restored,{readOnly:true});
    try{
      copy.exec('PRAGMA query_only=ON');
      assert.equal(f.store.db.prepare('PRAGMA integrity_check').get()?.integrity_check,'ok');
      assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(),[]);
      assert.equal(copy.prepare('PRAGMA integrity_check').get()?.integrity_check,'ok');
      assert.deepEqual(copy.prepare('PRAGMA foreign_key_check').all(),[]);
      assert.deepEqual(copy.prepare('SELECT * FROM missions').all(),
        f.store.db.prepare('SELECT * FROM missions').all());
      assert.deepEqual(copy.prepare('SELECT * FROM events').all(),
        f.store.db.prepare('SELECT * FROM events').all());
      assert.equal(copy.prepare('SELECT stop_requested FROM missions WHERE id=?')
        .get(original.id)?.stop_requested,1);
      assert.equal(original.turnCount,0);
      assert.equal(f.store.events(created.id).length,events.length);
      receipt('sqlite-isolated-backup-restore',{
        integrity:'ok',foreignKeyViolations:0,protectedHistoryUnchanged:true,
        stopRequested:true,sourceBackupSha256:digest(readFileSync(saved)),
        isolatedRestoreSha256:digest(readFileSync(restored)),
        originalEvents:events.length});
    }finally{copy.close();}
  }finally{f.close();}
});
test('one SQLite channel lease excludes a competing live Worker and enforces bound runtime provenance',()=>{
  const f=fixture();let competing:Store|undefined;
  try{
    competing=new Store(f.file);
    const first=f.store.acquireChannelLease('telegram');
    const held=f.store.db.prepare('SELECT * FROM channel_leases WHERE source=?')
      .all('telegram') as Array<{owner_pid:number;lease_key:string}>;
    assert.equal(held.length,1);
    assert.equal(held[0]?.owner_pid,process.pid);
    assert.equal(held[0]?.lease_key,first);
    assert.throws(()=>competing!.acquireChannelLease('telegram'),
      /Another channel poller is already running/);
    assert.equal(competing.db.prepare('SELECT count(*) AS n FROM channel_leases WHERE source=?')
      .get('telegram')?.n,1);
    const provenance={sourceSha:sourceSha(),compiledTreeSha256:'a'.repeat(64),
      cliSha256:'b'.repeat(64),manifestSha256:'c'.repeat(64),fileCount:1};
    assert.throws(()=>f.store.recordChannelRuntime('telegram','wrong-lease',provenance),
      /current worker lease/);
    f.store.recordChannelRuntime('telegram',first,provenance);
    const attestation=JSON.parse(f.store.getMeta('telegram.runtime_provenance')??'{}');
    assert.equal(attestation.sourceSha,sourceSha());
    assert.equal(attestation.pid,process.pid);
    f.store.releaseChannelLease('telegram',first);
    const second=competing.acquireChannelLease('telegram');
    assert.notEqual(second,first);
    competing.releaseChannelLease('telegram',second);
    receipt('single-worker-exclusive-lease',{
      maxConcurrentWorkers:1,competingLiveLeaseRejected:true,
      wrongLeaseRuntimeAttestationRejected:true,sourceSha:provenance.sourceSha});
  }finally{competing?.close();f.close();}
});
test('PI inference inherits configured default without overriding model/provider/thinking',()=>{
  const project='/srv/projects/mission-relay';
  const args=piInferenceArgs(project);
  assert.deepEqual(args,['infer','--project',project,'--stdin','--timeout','120','--json']);
  const planner=new SshPiPlanner({sshHost:'operator',project});
  const policy=planner.invocationPolicy();
  assert.deepEqual(policy,{argvSha256:digest(JSON.stringify(args)),
    modelOverride:false,providerOverride:false,thinkingOverride:false});
  assert.equal(args.some(x=>/^(--model|--provider|--thinking|--effort)$/.test(x)),false);
  receipt('pi-default-model-no-override',{
    argvSha256:policy.argvSha256,modelOverride:false,providerOverride:false,
    thinkingOverride:false,remoteInferenceInvoked:false});
});
