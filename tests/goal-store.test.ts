import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/core/store.js';
import {GoalLedger,type CreateGoalPlan} from '../src/core/goal-store.js';

function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'relay-goal-ledger-'));
  const file=join(dir,'missions.sqlite'),store=new Store(file),ledger=new GoalLedger(store);
  return {dir,file,store,ledger,close:()=>{store.close();rmSync(dir,{recursive:true,force:true});}};
}
const request={requestKey:'owner-goal-1',objective:'Durable project independent of browser tabs',priority:80};
const plan:CreateGoalPlan={requestKey:'pi-plan-1',summary:'Build and verify the system',items:[
  {key:'schema',title:'Store model',priority:100,acceptance:['Schema verified']},
  {key:'integration',title:'Integrate controller',priority:90,dependsOn:['schema'],
    acceptance:['Controller tests pass','Runtime independently checked']},
]};
function init(){
  const f=fixture(),goal=f.ledger.createGoal(request);
  const draft=f.ledger.createPlan(goal.id,goal.version,plan);
  return {...f,goal,draft,graph:()=>f.ledger.graph(goal.id)};
}

test('goal and plan writes are repeatable with stable IDs and append-only events',()=>{
  const f=init();
  try{
    const before=f.graph(),secondGoal=f.ledger.createGoal(request);
    assert.equal(secondGoal.id,f.goal.id);
    assert.throws(()=>f.ledger.createGoal({...request,priority:0}),/Idempotency/);
    assert.deepEqual(f.ledger.createPlan(f.goal.id,f.goal.version,plan),f.draft);
    assert.equal(f.graph().events.length,before.events.length);
    assert.equal(f.graph().plans.length,1);
    assert.equal(f.graph().items.length,2);
    assert.equal(f.graph().acceptance.length,3);
    assert.equal(f.graph().dependencies.length,1);
    assert.ok(f.graph().events.every((e,i,a)=>i===0||e.id>a[i-1]!.id));
    assert.throws(()=>f.ledger.createPlan(f.goal.id,f.goal.version,
      {...plan,summary:'Different plan'}),/Idempotency/);
    assert.equal(f.ledger.getGoal(f.goal.id).version,2);
  }finally{f.close();}
});

test('goal audit is append-only even when another caller uses direct SQLite writes',()=>{
  const f=init();
  try{
    const original=f.graph().events;
    assert.throws(()=>f.store.db.prepare('DELETE FROM goal_events WHERE goal_id=?')
      .run(f.goal.id),/append-only/);
    assert.throws(()=>f.store.db.prepare('UPDATE goal_events SET type=? WHERE goal_id=?')
      .run('forged',f.goal.id),/append-only/);
    assert.deepEqual(f.graph().events,original);
  }finally{f.close();}
});

test('cycles, missing dependencies, duplicate keys, and invalid criteria roll back cleanly',()=>{
  const f=fixture();
  try{
    const goal=f.ledger.createGoal(request),version=goal.version;
    for(const invalid of [
      {...plan,requestKey:'bad-a',items:[{...plan.items[0],dependsOn:['missing']}]},
      {...plan,requestKey:'bad-b',items:[{...plan.items[0],dependsOn:['schema']}]},
      {...plan,requestKey:'bad-c',items:[
        {...plan.items[0],dependsOn:['integration']},
        {...plan.items[1],dependsOn:['schema']}]},
      {...plan,requestKey:'bad-d',items:[plan.items[0],plan.items[0]]},
      {...plan,requestKey:'bad-e',items:[{...plan.items[0],acceptance:['same','same']}]},
    ]){
      assert.throws(()=>f.ledger.createPlan(goal.id,version,invalid));
      assert.equal(f.ledger.graph(goal.id).plans.length,0);
      assert.equal(f.ledger.getGoal(goal.id).version,version);
      assert.deepEqual(f.ledger.graph(goal.id).events.map(x=>x.type),['goal.created']);
    }
  }finally{f.close();}
});

test('a mid-transaction SQLite error removes the entire plan and permits an identical retry',()=>{
  const f=fixture();
  try{
    const goal=f.ledger.createGoal(request),before=f.ledger.graph(goal.id);
    f.store.db.exec(`CREATE TRIGGER fail_second_goal_item
      BEFORE INSERT ON goal_work_items WHEN NEW.item_key='integration'
      BEGIN SELECT RAISE(ABORT,'synthetic insertion fault'); END;`);
    assert.throws(()=>f.ledger.createPlan(goal.id,goal.version,plan),/synthetic insertion fault/);
    assert.deepEqual(f.ledger.graph(goal.id),before);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM goal_operations').get().n,0);
    f.store.db.exec('DROP TRIGGER fail_second_goal_item');
    assert.equal(f.ledger.createPlan(goal.id,goal.version,plan).ordinal,1);
    assert.equal(f.ledger.graph(goal.id).acceptance.length,3);
  }finally{f.close();}
});

test('plan approval and goal activation have optimistic versions and a single approved plan',()=>{
  const f=init();
  try{
    assert.throws(()=>f.ledger.setGoalStatus(f.goal.id,2,'ACTIVE','active-too-early'),/approved plan/);
    assert.throws(()=>f.ledger.setPlanStatus(f.goal.id,f.draft.id,99,'APPROVED','stale-plan'),/version conflict/);
    const approved=f.ledger.setPlanStatus(f.goal.id,f.draft.id,1,'APPROVED','approve-1');
    assert.equal(approved.version,2);
    assert.deepEqual(f.ledger.setPlanStatus(f.goal.id,f.draft.id,1,'APPROVED','approve-1'),approved);
    assert.throws(()=>f.ledger.setPlanStatus(f.goal.id,f.draft.id,1,'APPROVED','other-key'),/version conflict/);
    assert.equal(f.ledger.setGoalStatus(f.goal.id,2,'ACTIVE','activate').version,3);
    assert.throws(()=>f.ledger.setGoalStatus(f.goal.id,2,'PAUSED','stale-goal'),/version conflict/);
    const plan2=f.ledger.createPlan(f.goal.id,3,{...plan,requestKey:'plan-2'});
    assert.throws(()=>f.ledger.setPlanStatus(f.goal.id,plan2.id,1,'APPROVED','approve-2'),
      /UNIQUE|constraint/i);
    assert.equal(f.ledger.getPlan(f.goal.id,plan2.id).status,'DRAFT');
    f.ledger.setPlanStatus(f.goal.id,f.draft.id,2,'SUPERSEDED','supersede-1');
    assert.equal(f.ledger.setPlanStatus(f.goal.id,plan2.id,1,'APPROVED','approve-2').status,'APPROVED',
      'A rolled-back idempotency key may be reused with the identical intent');
  }finally{f.close();}
});

test('work dependencies and acceptance evidence gate PASSED, while changes are audited',()=>{
  const f=init();
  try{
    assert.throws(()=>f.ledger.setWorkStatus(f.goal.id,f.graph().items[0]!.id,1,
      'READY',[],'before-plan-review'),/approved plan/);
    f.ledger.setPlanStatus(f.goal.id,f.draft.id,1,'APPROVED','approve-for-execution');
    const {items,acceptance,dependencies}=f.graph();
    const first=items.find(w=>w.key==='schema')!,second=items.find(w=>w.key==='integration')!;
    assert.equal(dependencies[0]?.dependsOnId,first.id);
    assert.throws(()=>f.ledger.setWorkStatus(f.goal.id,second.id,1,'READY',[],'early'),
      /dependencies/);
    assert.throws(()=>f.ledger.recordAcceptance(f.goal.id,acceptance[0]!.id,1,'PASS',[],'fake-pass'),
      /evidence/);
    assert.equal(f.ledger.setWorkStatus(f.goal.id,first.id,1,'READY',[],'ready-1').version,2);
    f.ledger.setWorkStatus(f.goal.id,first.id,2,'IN_PROGRESS',[],'working-1');
    f.ledger.setWorkStatus(f.goal.id,first.id,3,'REVIEW',[],'review-1');
    assert.throws(()=>f.ledger.setWorkStatus(f.goal.id,first.id,4,'PASSED',['test:ok'],'pass-too-soon'),
      /acceptance/);
    const firstAcceptance=acceptance.find(c=>c.itemId===first.id)!;
    const accepted=f.ledger.recordAcceptance(f.goal.id,firstAcceptance.id,1,'PASS',
      ['git:sha-1','ci:run-1'],'criterion-1');
    assert.equal(accepted.version,2);
    assert.deepEqual(f.ledger.recordAcceptance(f.goal.id,firstAcceptance.id,1,'PASS',
      ['git:sha-1','ci:run-1'],'criterion-1'),accepted);
    assert.throws(()=>f.ledger.recordAcceptance(f.goal.id,firstAcceptance.id,1,'FAIL',
      ['other:ref'],'criterion-2'),/version conflict/);
    const passed=f.ledger.setWorkStatus(f.goal.id,first.id,4,'PASSED',['check:1'],'work-pass-1');
    assert.equal(passed.status,'PASSED');
    assert.deepEqual(f.ledger.setWorkStatus(f.goal.id,first.id,4,'PASSED',['check:1'],'work-pass-1'),passed);
    assert.throws(()=>f.ledger.recordAcceptance(f.goal.id,firstAcceptance.id,2,'FAIL',
      ['other:ref'],'after-final'),/immutable/);
    assert.equal(f.ledger.setWorkStatus(f.goal.id,second.id,1,'READY',[],'ready-2').status,'READY');
    assert.equal(f.ledger.getGoal(f.goal.id).status,'DRAFT',
      'Work item reports alone never mark an owner Goal DONE');
    assert.ok(f.graph().events.some(e=>e.type==='goal.work_status'));
    assert.ok(f.graph().events.some(e=>e.type==='goal.acceptance_recorded'));
    const audited=f.graph().events.find(e=>e.type==='goal.acceptance_recorded')!;
    assert.deepEqual(audited.payload.evidenceRefs,['git:sha-1','ci:run-1'],
      'Historical evidence pointers must remain available after a later status change');
    assert.equal(audited.payload.newVersion,2);
  }finally{f.close();}
});

test('idempotency records survive restart and reject changed intent; separate connections enforce versions',()=>{
  const f=init();
  let peer:Store|undefined;
  try{
    peer=new Store(f.file);
    const other=new GoalLedger(peer);
    assert.deepEqual(other.createPlan(f.goal.id,1,plan),f.draft);
    assert.throws(()=>other.createPlan(f.goal.id,1,{...plan,summary:'Different'}),/Idempotency/);
    const paused=other.setGoalStatus(f.goal.id,2,'PAUSED','pause-once');
    assert.equal(paused.version,3);
    assert.deepEqual(f.ledger.setGoalStatus(f.goal.id,2,'PAUSED','pause-once'),paused);
    assert.throws(()=>f.ledger.setGoalStatus(f.goal.id,2,'BLOCKED','stale-other'),/version conflict/);
    assert.equal(f.ledger.getGoal(f.goal.id).version,3);
    const events=f.graph().events.length;
    assert.deepEqual(other.setGoalStatus(f.goal.id,2,'PAUSED','pause-once'),paused);
    assert.equal(f.graph().events.length,events);
  }finally{peer?.close();f.close();}
});

test('closed SQLite handle can resume the exact Goal graph without any Mission or browser state',()=>{
  const dir=mkdtempSync(join(tmpdir(),'relay-goal-reopen-')),file=join(dir,'state.sqlite');
  let store:Store|undefined;
  try{
    store=new Store(file);
    const first=new GoalLedger(store),goal=first.createGoal(request);
    const draft=first.createPlan(goal.id,1,plan);
    first.setPlanStatus(goal.id,draft.id,1,'APPROVED','approve-for-reopen');
    const work=first.graph(goal.id).items.find(x=>x.key==='schema')!;
    const ready=first.setWorkStatus(goal.id,work.id,1,'READY',[],'start-schema');
    const baseline=first.graph(goal.id);
    store.close();store=undefined;
    store=new Store(file);
    const after=new GoalLedger(store);
    assert.deepEqual(after.graph(goal.id),baseline);
    assert.deepEqual(after.createGoal(request),baseline.goal,
      'CreateGoal replay reads the current version without creating a new Goal');
    assert.deepEqual(after.createPlan(goal.id,1,plan),draft);
    assert.deepEqual(after.setWorkStatus(goal.id,work.id,1,'READY',[],'start-schema'),ready);
    assert.deepEqual(after.graph(goal.id),baseline,'No replay may duplicate an audit event');
    assert.equal(store.list().length,0,'Goal does not need an active or historical Mission');
  }finally{store?.close();rmSync(dir,{recursive:true,force:true});}
});

test('Goal graph is independent of historical Mission and Chat records',()=>{
  const f=init();
  try{
    const mission=f.store.create({goal:'Legacy independent request',acceptance:['Old acceptance'],
      workspace:'',sandbox:'read-only',mode:'supervised',maxTurns:2,requestKey:'legacy-1'});
    const initialEvents=f.store.events(mission.id);
    const initialGoalEvents=f.graph().events;
    f.store.update(mission.id,mission.version,{state:'CANCELLED'},'mission.cancelled',{reason:'isolated'});
    assert.equal(f.store.get(mission.id).state,'CANCELLED');
    assert.deepEqual(f.graph().events,initialGoalEvents);
    assert.equal(f.ledger.getGoal(f.goal.id).id,f.goal.id);
    assert.equal(f.store.events(mission.id).length,initialEvents.length+1);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM goal_work_items').get().n,2);
  }finally{f.close();}
});

test('database foreign keys forbid cross-plan dependencies even from direct SQL',()=>{
  const f=init();
  try{
    const next=f.ledger.createPlan(f.goal.id,2,{...plan,requestKey:'second-plan'});
    const first=f.graph().items.find(x=>x.planId===f.draft.id)!;
    const cross=f.graph().items.find(x=>x.planId===next.id)!;
    assert.throws(()=>f.store.db.prepare(`INSERT INTO goal_dependencies
      (goal_id,plan_id,item_id,depends_on_id) VALUES(?,?,?,?)`)
      .run(f.goal.id,f.draft.id,first.id,cross.id),/FOREIGN KEY/);
    assert.equal(f.graph().dependencies.length,2);
    const otherGoal=f.ledger.createGoal({...request,requestKey:'other-goal'});
    assert.throws(()=>f.store.db.prepare(`INSERT INTO goal_work_items
      (id,goal_id,plan_id,item_key,title,description,priority,status,version,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,'PENDING',1,?,?)`)
      .run('forged',otherGoal.id,f.draft.id,'forged','Cross-goal item','',50,
        '2026-01-01','2026-01-01'),/FOREIGN KEY/);
  }finally{f.close();}
});

function legacyV3(file:string,injectConflict=false):void{
  const db=new DatabaseSync(file);
  db.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    INSERT INTO meta VALUES('schema_version','3');
    INSERT INTO meta VALUES('chatgpt.browser.active.old','{"status":"reserved","promptSha256":"original"}');
    CREATE TABLE missions(id TEXT PRIMARY KEY,goal TEXT NOT NULL,acceptance_json TEXT NOT NULL,
      workspace TEXT NOT NULL,sandbox TEXT NOT NULL,mode TEXT NOT NULL,max_turns INTEGER NOT NULL,
      request_key TEXT NOT NULL UNIQUE,state TEXT NOT NULL,version INTEGER NOT NULL,
      turn_count INTEGER NOT NULL,thread_id TEXT,next_instruction TEXT,last_summary TEXT,
      last_error TEXT,owner_pid INTEGER,owner_host TEXT,stop_requested INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL,checks_json TEXT NOT NULL DEFAULT '[]');
    CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT,mission_id TEXT NOT NULL,
      created_at TEXT NOT NULL,type TEXT NOT NULL,payload_json TEXT NOT NULL,
      FOREIGN KEY(mission_id) REFERENCES missions(id));
    INSERT INTO missions(id,goal,acceptance_json,workspace,sandbox,mode,max_turns,request_key,state,
      version,turn_count,created_at,updated_at) VALUES
      ('old','Keep old Mission','["criterion"]','.','read-only','supervised',32,'old-key','PAUSED',19,11,
      '2026-01-01','2026-01-02');
    INSERT INTO events(mission_id,created_at,type,payload_json)
      VALUES('old','2026-01-02','chatgpt.browser_reserved','{"requestKey":"reserved-no-resend"}');
    CREATE TABLE channel_commands(source TEXT,external_id TEXT,status TEXT,reply TEXT,received_at TEXT,
      PRIMARY KEY(source,external_id));
    INSERT INTO channel_commands VALUES('telegram','old-update','delivered','done','2026-01-02');`);
  if(injectConflict)db.exec('CREATE TABLE goal_work_items (incompatible TEXT)');
  db.close();
}

test('v3 in-place upgrade preserves complete old Mission/events/receipt and read-only v3 diagnostics',()=>{
  const dir=mkdtempSync(join(tmpdir(),'relay-goal-upgrade-')),file=join(dir,'old.sqlite');
  try{
    legacyV3(file);
    const oldReader=new Store(file,{readOnly:true});
    assert.equal(oldReader.get('old').turnCount,11);
    assert.throws(()=>new GoalLedger(oldReader),/schema v4/);
    oldReader.close();
    const upgraded=new Store(file);
    assert.equal(upgraded.getMeta('schema_version'),'4');
    assert.equal(upgraded.get('old').version,19);
    assert.equal(upgraded.events('old')[0]?.id,1);
    assert.equal(upgraded.events('old')[0]?.type,'chatgpt.browser_reserved');
    assert.equal(upgraded.getMeta('chatgpt.browser.active.old'),
      '{"status":"reserved","promptSha256":"original"}');
    assert.equal(upgraded.db.prepare('SELECT status FROM channel_commands WHERE external_id=?')
      .get('old-update').status,'delivered');
    assert.equal(new GoalLedger(upgraded).listGoals().length,0,
      'Do not invent goals for historical Missions');
    upgraded.close();
    const reader=new Store(file,{readOnly:true});
    assert.equal(reader.getMeta('schema_version'),'4');
    assert.equal(reader.get('old').turnCount,11);
    assert.throws(()=>new GoalLedger(reader).createGoal(request),/readonly|SQLITE_READONLY/i);
    reader.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('schema v3 migration DDL is atomic if an incompatible prior table exists',()=>{
  const dir=mkdtempSync(join(tmpdir(),'relay-goal-rollback-')),file=join(dir,'old.sqlite');
  try{
    legacyV3(file,true);
    assert.throws(()=>new Store(file),/already exists/);
    const db=new DatabaseSync(file,{readOnly:true});
    assert.equal((db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as {value:string}).value,'3');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='goals'").get().n,0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM goal_work_items').get().n,0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n,1);
    assert.equal(db.prepare("SELECT value FROM meta WHERE key='chatgpt.browser.active.old'").get().value,
      '{"status":"reserved","promptSha256":"original"}');
    db.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});
