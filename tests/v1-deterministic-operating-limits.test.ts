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
      mode:'supervised',maxTurns:32,requestKey:'protected-original',checks:[]});
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
test('ten observed Sends per Chat and 32-turn legacy Mission enforce distinct rollover and unique successor',()=>{
  const f=fixture();let parallel:Store|undefined;
  try{
    const ledger=new GoalLedger(f.store),objective='Synthetic bounded mission';
    const goal=ledger.createGoal({requestKey:'bounded-goal',objective,priority:90});
    const p=ledger.createPlan(goal.id,goal.version,{requestKey:'bounded-plan',
      summary:'Verify dispatch limits',items:[{key:'limits',title:'Limits',priority:90,
        acceptance:['No send beyond configured limit']}]});
    ledger.setPlanStatus(goal.id,p.id,p.version,'APPROVED','approved');
    ledger.setGoalStatus(goal.id,ledger.getGoal(goal.id).version,'ACTIVE','active');
    const item=ledger.graph(goal.id).items[0]!;
    const ready=ledger.setWorkStatus(goal.id,item.id,item.version,'READY',[],'start');
    ledger.setWorkStatus(goal.id,item.id,ready.version,'IN_PROGRESS',[],'running');
    const mission=f.store.create({goal:objective,acceptance:['Bounded completion'],
      workspace:'',sandbox:'read-only',mode:'supervised',maxTurns:32,
      requestKey:'original-32',checks:[]});
    const linked=f.store.linkChat(mission.id,url(0),mission.version).mission;
    const bound=f.store.bindChatBrowser(mission.id,'isolated-physical-target',linked.version).mission;
    f.store.setMeta('pi.autopilot.enabled.'+bound.id,'1');
    ledger.bindPiMission(goal.id,bound.id,bound.version,'original-binding');
    assert.equal(MAX_RELAY_CHAT_TURNS,10);
    for(let n=1;n<=32;n++){
      const newConversation=n>1&&(n-1)%MAX_RELAY_CHAT_TURNS===0;
      if(n===11){
        assert.throws(()=>f.store.reserveChatBrowserTurn(bound.id,
          f.store.get(bound.id).version,'illegal-eleventh',digest('old-chat')),
          /ten|10|new conversation/i);
        assert.equal(f.store.get(bound.id).turnCount,10);
      }
      const key='original-'+n,answer='Synthetic observed answer '+n+'\n[MISSION_RELAY:NEXT]';
      f.store.reserveChatBrowserTurn(bound.id,f.store.get(bound.id).version,
        key,digest('prompt '+n),newConversation?{newConversation:true}:{});
      f.store.finishChatBrowserTurn(bound.id,key,{
        kind:'observed',assistantSha256:digest(answer),summary:answer,
        ...(newConversation?{newChatUrl:url(n)}:{})});
      f.store.commitPiPlan(bound.id,digest(answer),[],{
        action:'NEXT',summary:'Original synthetic review '+n,
        nextPrompt:'Next scoped task '+n});
    }
    const report=inspectPiEvidence(f.store,bound.id);
    assert.equal(report.ledgerConsistent,true,report.violations.join(','));
    assert.equal(report.observedTurns,32);
    assert.equal(report.decisionsVerified,32);
    assert.equal(report.maxObservedTurnsInOneChat,10);
    assert.equal(report.chatSegments,4);
    assert.equal(f.store.get(bound.id).turnCount,32);
    assert.throws(()=>f.store.reserveChatBrowserTurn(bound.id,
      f.store.get(bound.id).version,'illegal-round-33',digest('forbidden'),
      {newConversation:true}),/turn budget exhausted/);
    parallel=new Store(f.file);
    const child=f.store.createPiSuccessor(bound.id);
    const same=parallel.createPiSuccessor(bound.id);
    assert.ok(child);
    assert.equal(same?.id,child.id);
    assert.equal(child.turnCount,0);
    assert.equal(child.maxTurns,32);
    assert.equal(f.store.events(bound.id).filter(e=>e.type==='pi.chain_successor').length,1);
    assert.equal(f.store.events(child.id).filter(e=>e.type==='pi.chain_started').length,1);
    assert.equal(f.store.chatBrowserTurn(child.id),null);
    receipt('ten-send-and-32-turn-limits',{
      maxChatSends:MAX_RELAY_CHAT_TURNS,maxMissionTurns:32,
      observedParentTurns:report.observedTurns,verifiedPiDecisions:report.decisionsVerified,
      observedChatSegments:report.chatSegments,maxObservedSendsPerChat:report.maxObservedTurnsInOneChat,
      illegalEleventhSameChatRejected:true,illegalThirtyThirdTurnRejected:true,
      successorCount:1,childInitialTurns:0,childOriginalSends:0,
      duplicateSuccessorAttemptSameId:true});
  }finally{parallel?.close();f.close();}
});
