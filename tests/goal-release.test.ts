import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/core/store.js';
import {GoalLedger} from '../src/core/goal-store.js';
import {GoalReleaseGate,RELEASE_GATES,type ReleaseProbe} from '../src/core/goal-release.js';

const SHA='a'.repeat(40),NEXT_SHA='b'.repeat(40);
const proof=(text:string)=>createHash('sha256').update(text).digest('hex');
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'relay-release-gate-'));
  const file=join(dir,'private.sqlite'),store=new Store(file);
  const ledger=new GoalLedger(store),gate=new GoalReleaseGate(store);
  const goal=ledger.createGoal({requestKey:'release-owner',objective:'Release the owner goal',
    priority:90});
  const plan=ledger.createPlan(goal.id,goal.version,{
    requestKey:'planned',summary:'Implement and release',items:[
      {key:'impl',title:'Implement',priority:100,acceptance:['End-user test passes']},
    ],
  });
  const approved=ledger.setPlanStatus(goal.id,plan.id,plan.version,'APPROVED','approve');
  ledger.setGoalStatus(goal.id,ledger.getGoal(goal.id).version,'ACTIVE','activate');
  const item=ledger.graph(goal.id).items[0]!;
  const check=ledger.graph(goal.id).acceptance[0]!;
  const passed=()=>{
    ledger.setWorkStatus(goal.id,item.id,1,'READY',[],'ready');
    ledger.setWorkStatus(goal.id,item.id,2,'IN_PROGRESS',[],'doing');
    ledger.setWorkStatus(goal.id,item.id,3,'REVIEW',[],'in-review');
    ledger.recordAcceptance(goal.id,check.id,1,'PASS',['browser-sha256:'+proof('claimed')],
      'reported-pass');
    ledger.setWorkStatus(goal.id,item.id,4,'PASSED',['browser-sha256:'+proof('claimed')],
      'work-passed');
  };
  const close=()=>{store.close();rmSync(dir,{recursive:true,force:true});};
  return {dir,file,store,ledger,gate,goal,approved,passed,close};
}
function independent(requirement:string,sha=SHA,
  state:'PASS'|'FAIL'|'BLOCKED'='PASS'):ReleaseProbe{
  const source=requirement.startsWith('criterion:')?'independent-work':
    ['check','privacy-check','test','build'].includes(requirement)?'local-command':
    requirement.startsWith('ci-')?'github-actions':
    requirement==='gmk-production-readback'?'gmk-readback':'chrome-readback';
  return {source,inspect:async()=>({state,observedSha:sha,
    reference:`verified://${requirement.replaceAll(':','-')}-receipt`,
    proofSha256:proof(`${requirement}:${sha}:${state}`)})};
}
async function fullEvidence(f:ReturnType<typeof fixture>){
  for(const requirement of f.gate.report(f.goal.id).checks.map(c=>c.requirement))
    await f.gate.inspect(f.goal.id,requirement,independent(requirement));
}

test('a model/PI-reported work PASS is insufficient for Goal DONE',async()=>{
  const f=fixture();
  try{
    assert.throws(()=>f.gate.begin(f.goal.id,SHA),/work and claimed criteria/);
    f.passed();
    assert.equal(f.ledger.getGoal(f.goal.id).status,'ACTIVE');
    assert.throws(()=>f.ledger.setGoalStatus(f.goal.id,3,'DONE','fake'),/Invalid goal/);
    const started=f.gate.begin(f.goal.id,SHA);
    assert.equal(started.checks.length,RELEASE_GATES.length+1);
    assert.equal(started.ready,false);
    assert.ok(started.blockers.includes('criterion:'+f.ledger.graph(f.goal.id).acceptance[0]!.id));
    let read=0;
    await assert.rejects(f.gate.finalize(f.goal.id,async()=>{read++;return SHA;}),/evidence/);
    assert.equal(read,0,'No external readback runs if recorded release gates are already incomplete');
    assert.equal(f.ledger.getGoal(f.goal.id).status,'ACTIVE');
  }finally{f.close();}
});

test('fake, source-mismatched, nonmatching-version, or untraceable evidence never writes PASS',async()=>{
  const f=fixture();
  try{
    f.passed();f.gate.begin(f.goal.id,SHA);
    const start=f.ledger.graph(f.goal.id).events.length;
    await assert.rejects(f.gate.inspect(f.goal.id,'test',
      {...independent('test'),source:'browser-answer'}),/source/);
    await assert.rejects(f.gate.inspect(f.goal.id,'test',independent('test',NEXT_SHA)),
      /matching target SHA/);
    await assert.rejects(f.gate.inspect(f.goal.id,'test',{
      source:'local-command',inspect:async()=>({state:'PASS',observedSha:SHA,
        reference:'model said it passed',proofSha256:proof('text')}),
    }),/reference/);
    await assert.rejects(f.gate.inspect(f.goal.id,'test',{
      source:'local-command',inspect:async()=>({state:'PASS',observedSha:SHA,
        reference:'valid://receipt',proofSha256:'not-a-digest'}),
    }),/digest/);
    assert.equal(f.ledger.graph(f.goal.id).events.length,start);
    assert.equal(f.gate.report(f.goal.id).checks.find(x=>x.requirement==='test')?.state,'PENDING');
  }finally{f.close();}
});

test('a failed verification is retained and reverified; only complete fresh evidence gates DONE',async()=>{
  const f=fixture();
  try{
    f.passed();f.gate.begin(f.goal.id,SHA);
    await f.gate.inspect(f.goal.id,'test',independent('test',SHA,'FAIL'));
    assert.ok(f.gate.report(f.goal.id).blockers.includes('test'));
    await fullEvidence(f);
    assert.equal(f.gate.report(f.goal.id).ready,true);
    await assert.rejects(f.gate.finalize(f.goal.id,async()=>NEXT_SHA),/main SHA/);
    assert.equal(f.ledger.getGoal(f.goal.id).status,'ACTIVE');
    const done=await f.gate.finalize(f.goal.id,async()=>SHA);
    assert.equal(done.complete,true);
    assert.equal(f.ledger.getGoal(f.goal.id).status,'DONE');
    assert.equal(f.ledger.listGoals()[0]?.status,'DONE');
    assert.equal(f.ledger.createGoal({requestKey:'release-owner',
      objective:'Release the owner goal',priority:90}).status,'DONE');
    assert.equal(f.ledger.graph(f.goal.id).events.filter(e=>e.type==='goal.release_done').length,1);
    assert.throws(()=>f.gate.begin(f.goal.id,NEXT_SHA),/Completed Goal/);
    await assert.rejects(f.gate.inspect(f.goal.id,'test',independent('test')),/Completed Goal/);
    assert.throws(()=>f.ledger.createPlan(f.goal.id,f.ledger.getGoal(f.goal.id).version,{
      requestKey:'illicit',summary:'After completion',items:[
        {key:'illegal',title:'Illegal',priority:1,acceptance:['test']},
      ],
    }),/immutable/);
    assert.throws(()=>f.store.db.prepare('DELETE FROM goal_release_completion WHERE goal_id=?')
      .run(f.goal.id),/immutable/);
    assert.throws(()=>f.store.db.prepare(
      'UPDATE goal_release_completion SET target_sha=? WHERE goal_id=?'
    ).run(NEXT_SHA,f.goal.id),/immutable/);
  }finally{f.close();}
});

test('retargeting a different SHA invalidates PASS receipts without erasing audit',async()=>{
  const f=fixture();
  try{
    f.passed();f.gate.begin(f.goal.id,SHA);
    await f.gate.inspect(f.goal.id,'test',independent('test'));
    const history=f.ledger.graph(f.goal.id).events;
    const next=f.gate.begin(f.goal.id,NEXT_SHA);
    assert.equal(next.target?.revision,2);
    assert.equal(next.target?.targetSha,NEXT_SHA);
    assert.equal(next.checks.find(x=>x.requirement==='test')?.state,'PENDING');
    assert.equal(next.ready,false);
    assert.ok(f.ledger.graph(f.goal.id).events.length>history.length);
    assert.ok(f.ledger.graph(f.goal.id).events.some(x=>x.type==='goal.release_evidence'));
    await assert.rejects(f.gate.finalize(f.goal.id,async()=>NEXT_SHA),/evidence/);
  }finally{f.close();}
});

test('Goal version changes invalidate past release evidence even when SHA stays the same',async()=>{
  const f=fixture();
  try{
    f.passed();f.gate.begin(f.goal.id,SHA);
    await fullEvidence(f);
    assert.equal(f.gate.report(f.goal.id).ready,true);
    const goal=f.ledger.getGoal(f.goal.id);
    f.ledger.setGoalStatus(goal.id,goal.version,'PAUSED','pause-goal');
    assert.ok(f.gate.report(goal.id).blockers.includes('work or acceptance no longer passed'));
    await assert.rejects(f.gate.finalize(goal.id,async()=>SHA),/evidence/);
    const resumed=f.ledger.getGoal(goal.id);
    f.ledger.setGoalStatus(goal.id,resumed.version,'ACTIVE','activate-again');
    assert.ok(f.gate.report(goal.id).blockers.includes('Goal graph/version changed'));
    assert.equal(f.gate.begin(goal.id,SHA).target?.revision,2);
    assert.equal(f.gate.report(goal.id).ready,false);
  }finally{f.close();}
});

test('reopening SQLite preserves exact release and independent event ledger without duplicating Send',async()=>{
  const f=fixture();
  let peer:Store|undefined;
  try{
    f.passed();
    const mission=f.store.create({goal:'Unrelated live mission',acceptance:['No replay'],
      workspace:'',sandbox:'read-only',mode:'supervised',maxTurns:32,requestKey:'other-mission'});
    const started=f.store.get(mission.id);
    f.gate.begin(f.goal.id,SHA);
    await f.gate.inspect(f.goal.id,'test',independent('test'));
    const original=f.gate.report(f.goal.id),events=f.ledger.graph(f.goal.id).events;
    peer=new Store(f.file);
    const again=new GoalReleaseGate(peer);
    assert.deepEqual(again.report(f.goal.id),original);
    assert.deepEqual(new GoalLedger(peer).graph(f.goal.id).events,events);
    assert.deepEqual(peer.get(mission.id),started);
    assert.equal(peer.events(mission.id).length,1);
    assert.deepEqual(again.begin(f.goal.id,SHA),original);
  }finally{peer?.close();f.close();}
});

test('expired and tampered records never establish freshness or independent trust',async()=>{
  const f=fixture();
  try{
    f.passed();f.gate.begin(f.goal.id,SHA);await fullEvidence(f);
    f.store.db.prepare(`UPDATE goal_release_checks SET expires_at=?
      WHERE goal_id=? AND requirement='check'`)
      .run('2020-01-01T00:00:00.000Z',f.goal.id);
    assert.ok(f.gate.report(f.goal.id).blockers.includes('check'));
    await assert.rejects(f.gate.finalize(f.goal.id,async()=>SHA),/evidence/);
  }finally{f.close();}
});

test('a forged direct SQLite PASS without a matching immutable audit receipt is rejected',async()=>{
  const f=fixture();
  try{
    f.passed();f.gate.begin(f.goal.id,SHA);
    const at=new Date(),expiry=new Date(at.getTime()+60_000);
    f.store.db.prepare(`UPDATE goal_release_checks SET
      state='PASS',source='local-command',reference='local-run://forged',
      proof_sha256=?,verified_at=?,expires_at=?
      WHERE goal_id=? AND requirement='check'`)
      .run(proof('forged'),at.toISOString(),expiry.toISOString(),f.goal.id);
    assert.ok(f.gate.report(f.goal.id).blockers.includes('check'));
    await assert.rejects(f.gate.finalize(f.goal.id,async()=>SHA),/evidence/);
  }finally{f.close();}
});

test('SQLite v4-to-v5 migration preserves legacy Goals, Missions and events without replay',()=>{
  const f=fixture();
  try{
    const original=f.ledger.graph(f.goal.id);
    const mission=f.store.create({goal:'Unsettled original browser operation',
      acceptance:['Keep reservation'],workspace:'',sandbox:'read-only',
      mode:'supervised',maxTurns:32,requestKey:'pre-v5'});
    const current=f.store.get(mission.id),events=f.store.events(mission.id);
    f.store.close();
    const db=new DatabaseSync(f.file);
    db.exec(`DROP TABLE goal_release_completion;
      DROP TABLE goal_release_checks;
      DROP TABLE goal_release_targets;
      UPDATE meta SET value='4' WHERE key='schema_version';`);
    db.close();
    const reader=new Store(f.file,{readOnly:true});
    assert.equal(reader.getMeta('schema_version'),'4');
    assert.throws(()=>new GoalReleaseGate(reader),/schema v5/);
    reader.close();
    const upgraded=new Store(f.file);
    try{
      assert.equal(upgraded.getMeta('schema_version'),'5');
      assert.deepEqual(new GoalLedger(upgraded).graph(f.goal.id),original);
      assert.deepEqual(upgraded.get(mission.id),current);
      assert.deepEqual(upgraded.events(mission.id),events);
      assert.equal(new GoalReleaseGate(upgraded).report(f.goal.id).complete,false);
    }finally{upgraded.close();}
  }finally{
    // This test closes the original handle before constructing the old schema.
    rmSync(f.dir,{recursive:true,force:true});
  }
});
