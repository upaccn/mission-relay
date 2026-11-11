import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {Store} from '../src/core/store.js';
import {GoalLedger} from '../src/core/goal-store.js';
import {StagedGoalIntake,isFreshStagedApproval,STAGED_BASELINE_SOURCES,
  type StageBaselineDimensions} from '../src/core/staged-goal-intake.js';
import {parseStagedPiInference} from '../src/core/pi-planner.js';
import {Engine} from '../src/core/engine.js';
import {TelegramBridge,type TelegramUpdate,type TelegramTransport} from '../src/plugins/telegram.js';
import type {PiPlanner} from '../src/core/pi-planner.js';
import type {AgentAdapter} from '../src/core/types.js';

const SRC='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174000';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const APPROVED='/srv/projects/mission-relay';
const syntheticInference={
  observedProvider:'synthetic-provider',
  observedModel:'synthetic-default-model',
  responseSha256:hash('synthetic-pictl-inference-envelope'),
  argvSha256:hash('synthetic-no-override-inference-argv'),
  modelOverride:false as const,providerOverride:false as const,
  thinkingOverride:false as const,
};
const syntheticSevenDimensions=Object.fromEntries(
  Object.entries(STAGED_BASELINE_SOURCES).map(([domain,source])=>[
    domain,{source,evidenceSha256:hash(`isolated-${domain}-readback`)},
  ])) as StageBaselineDimensions;
async function reviewedWithBaseline(intake:StagedGoalIntake,goalId:string,
  ownerId:number,pi:PiPlanner,now=Date.now()){
  if(!intake.readback(goalId).baseline)
    intake.recordOperationalBaseline(goalId,ownerId,syntheticSevenDimensions,
      new Date(now).toISOString());
  return intake.reviewByPi(goalId,ownerId,pi,now);
}
const never:AgentAdapter={
  execute:async()=>{throw new Error('No native executor may run staged Mission');},
  verify:async()=>{throw new Error('No native verifier may run staged Mission');},
};
const planner=(verdict:'APPROVE'|'REJECT'='APPROVE'):PiPlanner=>({
  decide:async()=>{throw new Error('No browser turn should reach PI');},
  invocationPolicy:()=>({
    argvSha256:syntheticInference.argvSha256,
    modelOverride:false,providerOverride:false,thinkingOverride:false,
  }),
  reviewStagedGoal:async input=>{
    assert.match(input.checkpointSha256,/^[a-f0-9]{64}$/);
    return {verdict,
      summary:verdict==='APPROVE'?'Verified bounded zero-turn plan for later activation':'Owner review refused',
      inference:syntheticInference};
  },
});

test('PI staged review parses actual pictl envelope model/provider and fixed-default argv, rejecting unauthenticated claims',()=>{
  const envelope=JSON.stringify({ok:true,provider:'openai-codex',model:'gpt-6.1-sol',
    result:JSON.stringify({verdict:'APPROVE',summary:'Verified a staged zero-turn checkpoint'})});
  const policy={argvSha256:hash('fixed-infer-argv'),modelOverride:false as const,
    providerOverride:false as const,thinkingOverride:false as const};
  const result=parseStagedPiInference(envelope,policy);
  assert.equal(result.inference.observedModel,'gpt-6.1-sol');
  assert.equal(result.inference.observedProvider,'openai-codex');
  assert.equal(result.inference.responseSha256,hashRaw(envelope));
  assert.equal(result.inference.argvSha256,policy.argvSha256);
  assert.equal(result.inference.modelOverride,false);
  assert.throws(()=>parseStagedPiInference(
    JSON.stringify({ok:true,result:JSON.stringify({verdict:'APPROVE',summary:'claimed gpt-6.1-sol'})}),policy),
  /attested model/);
  assert.throws(()=>parseStagedPiInference(envelope,{...policy,modelOverride:true as never}),/default argv/);
  assert.throws(()=>parseStagedPiInference(
    JSON.stringify({ok:true,provider:'openai-codex',model:'gpt-6.1-sol',
      result:JSON.stringify({verdict:'APPROVE',summary:''})}),policy),/invalid verdict/);
});
test('seven-dimensional operational baseline is mandatory, immutable and bound into the PI review event',async()=>{
  const f=fixture();
  try{
    const s=f.intake.stage(f.owner),id=s.record.goalId;
    await assert.rejects(f.intake.reviewByPi(id,1001,planner()),/seven-dimensional/);
    assert.equal(f.intake.readback(id).review,null);
    const missing={...syntheticSevenDimensions} as Record<string,unknown>;
    delete missing.chrome;
    assert.throws(()=>f.intake.recordOperationalBaseline(id,1001,
      missing as StageBaselineDimensions),/Seven distinct/);
    const before=f.store.events(s.record.missionId);
    const evidence=f.intake.recordOperationalBaseline(id,1001,syntheticSevenDimensions);
    assert.equal(evidence.currentSha256,s.currentSha256);
    assert.equal(evidence.unchanged,true);
    assert.equal(evidence.baseline?.checkpointSha256,s.currentSha256);
    assert.deepEqual(f.store.events(s.record.missionId),before);
    assert.deepEqual(f.intake.verifyReadOnly(id),evidence);
    const original=f.store.getMeta(`goal.stage.baseline.${id}`)!;
    f.store.setMeta(`goal.stage.baseline.${id}`,JSON.stringify({
      ...evidence.baseline,dimensions:{...syntheticSevenDimensions,
        chrome:{...syntheticSevenDimensions.chrome,evidenceSha256:hash('forged')}},
    }));
    assert.throws(()=>f.intake.verifyReadOnly(id),/immutable audit custody/);
    f.store.setMeta(`goal.stage.baseline.${id}`,original);
    const reviewed=await f.intake.reviewByPi(id,1001,planner());
    const events=new GoalLedger(f.store).graph(id).events;
    const pi=events.filter(e=>e.type==='goal.stage_pi_reviewed').at(-1)!;
    assert.equal(reviewed.review?.baselineSha256,evidence.baseline?.baselineSha256);
    assert.equal(pi.payload.baselineSha256,evidence.baseline?.baselineSha256);
    assert.equal(events.filter(e=>e.type==='goal.stage_baseline_attested').length,1);
    assert.throws(()=>f.intake.recordOperationalBaseline(id,1001,
      syntheticSevenDimensions,new Date(Date.now()+1000).toISOString()),
    /fresh approved/);
    assert.equal(f.intake.readback(id).missionState,'PAUSED');
  }finally{f.dispose();}
});

test('baseline race during PI inference rejects the stale approval and keeps Mission held',async()=>{
  const f=fixture();
  try{
    const s=f.intake.stage(f.owner),id=s.record.goalId;
    f.intake.recordOperationalBaseline(id,1001,syntheticSevenDimensions);
    let release:()=>void=()=>{};
    const blocker=new Promise<void>(resolve=>{release=resolve;});
    let entered:()=>void=()=>{};
    const called=new Promise<void>(resolve=>{entered=resolve;});
    const pending=f.intake.reviewByPi(id,1001,{
      ...planner(),reviewStagedGoal:async input=>{
        assert.match(input.baselineSha256,/^[a-f0-9]{64}$/);
        assert.equal(Object.keys(input.baselineEvidence).length,7);
        entered();await blocker;
        return {verdict:'APPROVE',summary:'Stale seven-dimensional readback',
          inference:syntheticInference};
      },
    });
    await called;
    const different={...syntheticSevenDimensions,
      worker:{...syntheticSevenDimensions.worker,evidenceSha256:hash('changed worker')}};
    f.intake.recordOperationalBaseline(id,1001,different,
      new Date(Date.now()+1000).toISOString());
    release();
    await assert.rejects(pending,/stale/);
    assert.equal(f.intake.readback(id).review,null);
    assert.equal(f.store.getMeta(`goal.stage.hold.${s.record.missionId}`),'1');
    assert.equal(new GoalLedger(f.store).graph(id).events
      .filter(e=>e.type==='goal.stage_baseline_attested').length,2);
  }finally{f.dispose();}
});
function hashRaw(x:string){return createHash('sha256').update(x).digest('hex');}
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'relay-staged-goal-'));
  const filename=join(dir,'missions.sqlite');
  const store=new Store(filename);
  const anchor=store.create({goal:'Historical pinned anchor',acceptance:['Anchor remains'],
    workspace:'',sandbox:'read-only',mode:'supervised',maxTurns:1,
    requestKey:'historic-anchor',checks:[]});
  const linked=store.linkChat(anchor.id,SRC,anchor.version).mission;
  store.bindChatBrowser(anchor.id,'install:Chrome:synthetic',linked.version);
  store.setMeta('telegram.chatgpt.anchorMissionId',anchor.id);
  store.setMeta('telegram.pi.project',APPROVED);
  store.setMeta('telegram.build.project',APPROVED);
  const stop=store.create({goal:'Historical stop retained',acceptance:['Preserve stop'],
    workspace:'',sandbox:'read-only',mode:'supervised',maxTurns:1,
    requestKey:'historic-stopped',checks:[]});
  const paused=store.update(stop.id,stop.version,{state:'PAUSED',stopRequested:true},
    'mission.pause_requested',{historic:true});
  const intake=new StagedGoalIntake(store);
  const owner={ownerId:1001,commandId:'501',objective:'Independent isolated Goal with reliable PI review',
    workspace:''};
  const dispose=()=>{store.close();rmSync(dir,{recursive:true,force:true});};
  return {dir,filename,store,intake,owner,anchorId:anchor.id,stopId:paused.id,dispose};
}

test('STAGE is atomic, distinct, zero-turn, held on restart and preserves historical stop/requests',()=>{
  const f=fixture();
  try {
    const before=f.store.events(f.stopId),anchor=f.store.events(f.anchorId);
    const r=f.intake.stage(f.owner),m=f.store.get(r.record.missionId);
    assert.deepEqual(f.intake.verifyReadOnly(r.record.goalId),r);
    assert.match(r.record.goalId,/^[a-f0-9-]{36}$/i);
    assert.notEqual(r.record.goalId,r.record.missionId);
    assert.notEqual(m.id,f.stopId);
    assert.equal(m.state,'PAUSED');assert.equal(m.turnCount,0);
    assert.equal(m.stopRequested,false);assert.equal(m.ownerPid,null);
    assert.equal(m.version,r.record.missionVersion);
    assert.equal(f.store.piChainParent(m.id),null);
    assert.equal(f.store.getMeta(`goal.stage.hold.${m.id}`),'1');
    assert.equal(f.store.chatLink(m.id),null);
    assert.equal(f.store.chatBrowserTurn(m.id),null);
    assert.equal(f.store.piPlan(m.id),null);
    assert.equal(r.unchanged,true);
    assert.equal(r.browserReservations,0);
    assert.equal(new GoalLedger(f.store).missionGoalId(m.id),r.record.goalId);
    assert.deepEqual(f.store.events(f.stopId),before);
    assert.deepEqual(f.store.events(f.anchorId),anchor);
    assert.equal(f.store.get(f.stopId).stopRequested,true);
    assert.throws(()=>f.store.acquire(m.id),/Staged Goal/);
    assert.throws(()=>new Engine(f.store,never).resume(m.id,m.version),/PI-owned/);
    assert.throws(()=>f.store.reserveChatBrowserTurn(m.id,m.version,'stage-send',hash('wrong')),/Staged Goal/);
    assert.throws(()=>f.store.queuePiOwnerDirective(m.id,'502','Run now'),/Staged Goal/);
    const second=new Store(f.filename);
    try{
      const snapshot=new StagedGoalIntake(second).readback(r.record.goalId);
      assert.equal(snapshot.currentSha256,r.record.checkpointSha256);
      assert.equal(snapshot.turnCount,0);
      assert.equal(snapshot.review,null);
    }finally{second.close();}
  }finally{f.dispose();}
});

test('STAGE coexists with a genuinely reserved legacy Send without resolving, sending or resuming it',async()=>{
  const f=fixture();
  try{
    const old=f.store.create({goal:'Active original request',acceptance:['No replay'],
      workspace:'',sandbox:'read-only',mode:'supervised',maxTurns:4,
      requestKey:'historical-inflight',checks:[]});
    let m=f.store.linkChat(old.id,
      'https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174008',old.version).mission;
    m=f.store.bindChatBrowser(m.id,'install:Chrome:synthetic',m.version).mission;
    f.store.reserveChatBrowserTurn(m.id,m.version,'historical-inflight-1',hash('old original text'));
    const before=f.store.events(m.id),receipt=f.store.chatBrowserTurn(m.id);
    const staged=f.intake.stage(f.owner);
    assert.equal(staged.unchanged,true);
    assert.equal(staged.turnCount,0);
    assert.equal(staged.browserReservations,0);
    assert.deepEqual(f.store.events(m.id),before);
    assert.deepEqual(f.store.chatBrowserTurn(m.id),receipt);
    assert.equal(f.store.get(m.id).state,'RUNNING');
    assert.equal(f.store.get(f.stopId).stopRequested,true);
    const reviewed=await reviewedWithBaseline(f.intake,staged.record.goalId,1001,planner());
    assert.equal(reviewed.review?.verdict,'APPROVE');
    // A PI-reviewed stage cannot silently start while that original request
    // remains unspent. Activation must reject without touching either record.
    assert.throws(()=>f.intake.activate(staged.record.goalId,1001,
      staged.currentSha256,'804'),/unresolved browser request/);
  }finally{f.dispose();}
});

test('STAGE idempotency, owner/payload collision, concurrent opens, and binding failure rollback',()=>{
  const f=fixture();
  try{
    const r=f.intake.stage(f.owner);
    assert.deepEqual(f.intake.stage(f.owner),r);
    assert.throws(()=>f.intake.stage({...f.owner,objective:'Changed payload'}),/idempotency/);
    assert.throws(()=>f.intake.stage({...f.owner,ownerId:9999}),/idempotency/);
    assert.equal(new GoalLedger(f.store).listGoals().length,1);
    const second=new Store(f.filename);
    try{
      const a=new StagedGoalIntake(second);
      assert.equal(a.stage(f.owner).record.goalId,r.record.goalId);
      const added=f.intake.stage({...f.owner,commandId:'502'});
      assert.notEqual(added.record.goalId,r.record.goalId);
      assert.equal(a.stage({...f.owner,commandId:'502'}).record.missionId,added.record.missionId);
    }finally{second.close();}
    f.store.db.exec(`CREATE TRIGGER fail_staged_binding BEFORE INSERT ON goal_events
      WHEN NEW.type='goal.pi_mission_bound'
      BEGIN SELECT RAISE(FAIL,'synthetic atomic binding error'); END;`);
    const beforeGoals=new GoalLedger(f.store).listGoals().length;
    const beforeMission=f.store.list().length;
    assert.throws(()=>f.intake.stage({...f.owner,commandId:'503'}),/synthetic atomic binding error/);
    assert.equal(new GoalLedger(f.store).listGoals().length,beforeGoals);
    assert.equal(f.store.list().length,beforeMission);
    const holds=f.store.db.prepare(
      "SELECT COUNT(*) AS count FROM meta WHERE key LIKE 'goal.stage.hold.%'"
    ).get() as {count:number};
    assert.equal(holds.count,beforeGoals);
    f.store.db.exec('DROP TRIGGER fail_staged_binding');
    assert.equal(f.intake.stage({...f.owner,commandId:'503'}).turnCount,0);
  }finally{f.dispose();}
});

test('Two independent Node processes racing the same authenticated STAGE create only one Goal and Mission',async()=>{
  const f=fixture();
  try{
    const source=[
      "import {Store} from './src/core/store.ts';",
      "import {StagedGoalIntake} from './src/core/staged-goal-intake.ts';",
      'const db=new Store(process.argv[1]);',
      'try {const result=new StagedGoalIntake(db).stage(JSON.parse(process.argv[2]));',
      'process.stdout.write(result.record.goalId+" "+result.record.missionId);}',
      'finally {db.close();}',
    ].join('\n');
    const start=()=>new Promise<string>((resolve,reject)=>{
      const p=spawn(process.execPath,['--import','tsx','--input-type=module',
        '-e',source,f.filename,JSON.stringify(f.owner)],{
        cwd:process.cwd(),stdio:['ignore','pipe','pipe'],
      });
      let stdout='',stderr='';
      p.stdout.on('data',(x:Buffer)=>{stdout+=x.toString();});
      p.stderr.on('data',(x:Buffer)=>{stderr+=x.toString();});
      p.on('error',reject);
      p.on('close',code=>code===0?resolve(stdout.trim()):
        reject(new Error(`Concurrent staged process exited ${code}: ${stderr}`)));
    });
    const [first,second]=await Promise.all([start(),start()]);
    assert.equal(first,second);
    assert.equal(new GoalLedger(f.store).listGoals().length,1);
    assert.equal(f.store.list().length,3); // anchor, historic stopped, new staged root
    const [id,missionId]=first.split(' ');
    const verified=f.intake.readback(id!);
    assert.equal(verified.record.missionId,missionId);
    assert.equal(verified.turnCount,0);
    assert.equal(verified.browserReservations,0);
  }finally{f.dispose();}
});

test('PI review is bound to the exact immutable checkpoint; ACTIVATE is idempotent and sends nothing',async()=>{
  const f=fixture();
  try{
    const staged=f.intake.stage(f.owner);
    const goal=staged.record.goalId,missionId=staged.record.missionId;
    assert.throws(()=>f.intake.activate(goal,1001,staged.currentSha256,'700'),/PI review/);
    f.intake.recordOperationalBaseline(goal,1001,syntheticSevenDimensions);
    await assert.rejects(()=>f.intake.reviewByPi(goal,9999,planner()),/not owned/);
    const checked=await reviewedWithBaseline(f.intake,goal,1001,planner());
    assert.equal(checked.review?.verdict,'APPROVE');
    assert.equal(checked.review?.baselineSha256,checked.baseline?.baselineSha256);
    assert.deepEqual(checked.review?.inference,syntheticInference);
    assert.equal(checked.currentSha256,staged.currentSha256);
    assert.equal(checked.unchanged,true);
    assert.equal(checked.turnCount,0);
    assert.ok(new GoalLedger(f.store).graph(goal).events.some(e=>e.type==='goal.stage_pi_reviewed'));
    const piAudit=new GoalLedger(f.store).graph(goal).events.find(e=>e.type==='goal.stage_pi_reviewed')!;
    assert.equal(piAudit.payload.baselineSha256,checked.baseline?.baselineSha256);
    assert.equal((piAudit.payload.inference as {observedModel:string}).observedModel,
      syntheticInference.observedModel);
    assert.equal((piAudit.payload.inference as {modelOverride:boolean}).modelOverride,false);
    const originalReview=f.store.getMeta(`goal.stage.review.${goal}`)!;
    f.store.setMeta(`goal.stage.review.${goal}`,JSON.stringify({
      ...checked.review,inference:{...syntheticInference,observedModel:'forged-model'},
    }));
    assert.throws(()=>f.intake.readback(goal),/immutable audit event/);
    assert.throws(()=>f.intake.activate(goal,1001,staged.currentSha256,'699'),
      /immutable audit event/);
    f.store.setMeta(`goal.stage.review.${goal}`,originalReview);
    const active=f.intake.activate(goal,1001,staged.currentSha256,'701');
    assert.equal(active.activated,true);
    assert.equal(active.missionState,'READY');
    assert.equal(active.turnCount,0);
    assert.equal(active.browserReservations,0);
    assert.equal(f.store.chatLink(missionId),SRC);
    assert.equal(f.store.chatBrowserBinding(missionId),'install:Chrome:synthetic');
    assert.equal(f.store.getMeta(`goal.stage.hold.${missionId}`),'0');
    assert.equal(f.store.get(f.stopId).stopRequested,true);
    const events=f.store.events(missionId);
    assert.equal(events.filter(e=>e.type==='goal.stage_activated').length,1);
    assert.equal(events.filter(e=>e.type==='chatgpt.browser_reserved').length,0);
    f.intake.activate(goal,1001,staged.currentSha256,'702');
    assert.deepEqual(f.store.events(missionId),events);
    assert.equal(f.store.get(missionId).turnCount,0);
  }finally{f.dispose();}
});

test('REVIEW refuses rejected, expired, changed, and racing checkpoints; each remains held',async()=>{
  const f=fixture();
  try{
    const rejected=f.intake.stage(f.owner);
    await reviewedWithBaseline(f.intake,rejected.record.goalId,1001,planner('REJECT'));
    assert.throws(()=>f.intake.activate(rejected.record.goalId,1001,rejected.currentSha256,'601'),
      /absent, rejected/);
    const expired=f.intake.stage({...f.owner,commandId:'602'});
    const reviewed=await reviewedWithBaseline(f.intake,expired.record.goalId,1001,planner(),
      Date.now()-16*60_000);
    assert.throws(()=>f.intake.activate(expired.record.goalId,1001,expired.currentSha256,'603',
      Date.parse(reviewed.review!.reviewedAt)+16*60_000),/expired/);
    // An expired approval may be renewed only by a new PI result for the
    // still-identical original checkpoint; the prior review event is retained.
    f.intake.recordOperationalBaseline(expired.record.goalId,1001,
      syntheticSevenDimensions,new Date().toISOString());
    const renewed=await reviewedWithBaseline(f.intake,expired.record.goalId,1001,planner());
    assert.equal(renewed.currentSha256,expired.currentSha256);
    assert.equal(renewed.review?.verdict,'APPROVE');
    assert.throws(()=>f.intake.activate(expired.record.goalId,1001,
      expired.currentSha256,'603',Date.parse(renewed.baseline!.capturedAt)+16*60_000),
    /expired PI review/);
    assert.equal(new GoalLedger(f.store).graph(expired.record.goalId).events
      .filter(e=>e.type==='goal.stage_pi_reviewed').length,2);
    const changed=f.intake.stage({...f.owner,commandId:'604'});
    f.store.update(changed.record.missionId,changed.record.missionVersion,
      {nextInstruction:'unauthorized scoped change'},'mission.instruction_added',{});
    assert.equal(f.intake.readback(changed.record.goalId).unchanged,false);
    await assert.rejects(()=>reviewedWithBaseline(f.intake,changed.record.goalId,1001,planner()),/Changed/);
    const racing=f.intake.stage({...f.owner,commandId:'605'});
    let release:()=>void=()=>{};
    const hold=new Promise<void>(resolve=>{release=resolve;});
    let entered:()=>void=()=>{};
    const called=new Promise<void>(resolve=>{entered=resolve;});
    const pending=reviewedWithBaseline(f.intake,racing.record.goalId,1001,{
      ...planner(),reviewStagedGoal:async()=>{entered();await hold;return {
        verdict:'APPROVE',summary:'Late approval must fail',
        inference:syntheticInference};},
    });
    await called;
    f.store.update(racing.record.missionId,racing.record.missionVersion,
      {nextInstruction:'race change'},'mission.instruction_added',{});
    release();
    await assert.rejects(pending,/stale/);
    assert.equal(f.intake.readback(racing.record.goalId).review,null);
    for(const id of [rejected,expired,changed,racing].map(x=>x.record.missionId))
      assert.equal(f.store.getMeta(`goal.stage.hold.${id}`),'1');
  }finally{f.dispose();}
});

test('Missing model attestation and caller policy mismatch never commit PI review',async()=>{
  const f=fixture();
  try{
    const stage=f.intake.stage(f.owner);
    await assert.rejects(reviewedWithBaseline(f.intake,stage.record.goalId,1001,{
      ...planner(),reviewStagedGoal:async()=>({
        verdict:'APPROVE',summary:'A decision without a real inference envelope',
        inference:{...syntheticInference,observedModel:''},
      }),
    }),/real model identity/);
    assert.equal(f.intake.readback(stage.record.goalId).review,null);
    await assert.rejects(reviewedWithBaseline(f.intake,stage.record.goalId,1001,{
      ...planner(),invocationPolicy:()=>({
        argvSha256:hash('different-argv'),modelOverride:false,
        providerOverride:false,thinkingOverride:false,
      }),
    }),/fixed default argv/);
    assert.equal(f.intake.readback(stage.record.goalId).review,null);
    assert.equal(f.store.getMeta(`goal.stage.hold.${stage.record.missionId}`),'1');
  }finally{f.dispose();}
});

test('ACTIVATE refuses active/PI-ready Missions, unresolved original request, stop, drain and changed scope',async()=>{
  const f=fixture();
  try{
    const s=f.intake.stage({...f.owner,workspace:APPROVED});
    await reviewedWithBaseline(f.intake,s.record.goalId,1001,planner());
    const activate=()=>f.intake.activate(s.record.goalId,1001,s.currentSha256,'610');
    const competitor=f.store.create({goal:'Old outstanding',acceptance:['Preserve'],
      workspace:'',sandbox:'read-only',mode:'supervised',maxTurns:3,
      requestKey:'old-outstanding',checks:[]});
    f.store.setMeta(`pi.autopilot.enabled.${competitor.id}`,'1');
    assert.throws(activate,/PI-ready/);
    f.store.update(competitor.id,competitor.version,{state:'PAUSED',stopRequested:true},
      'mission.pause_requested',{});
    f.store.setMeta('telegram.build.project','/tmp/changed');
    assert.throws(activate,/workspace approval changed/);
    f.store.setMeta('telegram.build.project',APPROVED);
    f.store.setMeta('telegram.maintenance.drain','synthetic-drain');
    assert.throws(activate,/drained/);
    f.store.db.prepare('DELETE FROM meta WHERE key=?').run('telegram.maintenance.drain');
    const old=f.store.create({goal:'Legacy pending Send',acceptance:['Do not replay'],
      workspace:'',sandbox:'read-only',mode:'supervised',maxTurns:3,
      requestKey:'original-pending',checks:[]});
    let linked=f.store.linkChat(old.id,
      'https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174005',old.version).mission;
    linked=f.store.bindChatBrowser(old.id,'install:Chrome:synthetic',linked.version).mission;
    f.store.reserveChatBrowserTurn(old.id,linked.version,'original-pending-1',hash('pending text'));
    const reserved=f.store.chatBrowserTurn(old.id);
    assert.equal(reserved?.status,'reserved');
    assert.throws(activate,/unresolved browser request/);
    assert.deepEqual(f.store.chatBrowserTurn(old.id),reserved);
    f.store.setMeta(`chatgpt.browser.active.${old.id}`,
      JSON.stringify({...reserved,status:'uncertain'}));
    assert.throws(activate,/unresolved browser request/);
    assert.equal(f.store.getMeta(`goal.stage.hold.${s.record.missionId}`),'1');
    const stopMission=f.store.get(s.record.missionId);
    f.store.update(stopMission.id,stopMission.version,{stopRequested:true},
      'mission.pause_requested',{});
    assert.throws(activate,/altered or expired PI review/);
  }finally{f.dispose();}
});

test('Activation audit write failure rolls back link, READY transition and hold in one transaction',async()=>{
  const f=fixture();
  try{
    const staged=f.intake.stage(f.owner);
    await reviewedWithBaseline(f.intake,staged.record.goalId,1001,planner());
    f.store.db.exec(`CREATE TRIGGER fail_stage_activation BEFORE INSERT ON events
      WHEN NEW.type='goal.stage_activated'
      BEGIN SELECT RAISE(FAIL,'synthetic activation audit failure'); END;`);
    assert.throws(()=>f.intake.activate(staged.record.goalId,1001,
      staged.currentSha256,'850'),/synthetic activation audit failure/);
    const after=f.intake.readback(staged.record.goalId);
    assert.equal(after.unchanged,true);
    assert.equal(after.activated,false);
    assert.equal(after.missionState,'PAUSED');
    assert.equal(f.store.chatLink(after.record.missionId),null);
    assert.equal(f.store.chatBrowserBinding(after.record.missionId),null);
    assert.equal(f.store.getMeta(`goal.stage.hold.${after.record.missionId}`),'1');
    f.store.db.exec('DROP TRIGGER fail_stage_activation');
    assert.equal(f.intake.activate(staged.record.goalId,1001,
      staged.currentSha256,'851').missionState,'READY');
  }finally{f.dispose();}
});

test('Telegram STAGE/VERIFY/REVIEW/ACTIVATE require authenticated private owner and never connect Chrome',async()=>{
  const f=fixture();
  try {
    let updates:TelegramUpdate[]=[];
    const sent:string[]=[];
    const transport:TelegramTransport={
      getUpdates:async offset=>updates.filter(x=>x.update_id>=offset),
      sendMessage:async(_chat,text)=>{sent.push(text);},
    };
    const bridge=new TelegramBridge(f.store,new Engine(f.store,never),transport,1001,2001,
      async()=>{throw new Error('No native Agent');},
      async()=>{throw new Error('Staged intake must not open Chrome');},planner(),
      undefined,undefined,async()=>syntheticSevenDimensions);
    const message=(n:number,text:string,from=1001):TelegramUpdate=>({
      update_id:n,message:{text,from:{id:from},chat:{id:2001,type:'private'}},
    });
    updates=[message(700,'/goal-stage should not run',9999)];
    await bridge.pollOnce(0);
    assert.equal(new GoalLedger(f.store).listGoals().length,0);
    updates=[message(701,'/goal-stage Launch a separately reviewed independent Goal')];
    await bridge.pollOnce(0);
    const staged=new GoalLedger(f.store).listGoals()[0]!;
    const initial=f.intake.readback(staged.id);
    assert.equal(initial.turnCount,0);
    assert.equal(initial.browserReservations,0);
    assert.equal(initial.record.ownerId,1001);
    updates=[message(702,`/goal-verify ${staged.id}`)];
    await bridge.pollOnce(0);
    assert.ok(sent.some(s=>s.includes('Independent readback: MATCH')));
    updates=[message(703,`/goal-review ${staged.id}`)];
    await bridge.pollOnce(0);
    assert.equal(f.intake.readback(staged.id).review?.verdict,'APPROVE');
    updates=[message(704,`/goal-activate ${staged.id} ${initial.currentSha256}`)];
    await bridge.pollOnce(0);
    assert.equal(f.store.get(initial.record.missionId).state,'READY');
    assert.equal(f.store.chatBrowserTurn(initial.record.missionId),null);
    assert.ok(sent.some(s=>s.includes('no browser Send was submitted by activation')));
    assert.equal(new GoalLedger(f.store).listGoals().length,1);
  }finally{f.dispose();}
});

test('expired stage approval is visibly stale and /goal-review renews seven witnesses and PI once',async()=>{
  const f=fixture();
  try{
    const staged=f.intake.stage({...f.owner,commandId:'900'});
    const id=staged.record.goalId;
    const old=Date.now()-20*60_000;
    // Simulate durable, independently audited historical approval, without
    // changing old events or shortening the real controller's 15-minute TTL.
    f.intake.recordOperationalBaseline(id,1001,syntheticSevenDimensions,
      new Date(old).toISOString());
    const previous=await f.intake.reviewByPi(id,1001,planner(),old);
    assert.equal(previous.review?.verdict,'APPROVE');
    assert.equal(isFreshStagedApproval(previous.review,old),true);
    assert.equal(isFreshStagedApproval(previous.review),false);
    assert.equal(isFreshStagedApproval(previous.review,old+15*60_000+1),false);
    assert.equal(isFreshStagedApproval(previous.review,old-1),false);
    assert.equal(f.intake.verifyReadOnly(id).activated,false);
    const updates:TelegramUpdate[]=[];
    const sent:string[]=[];
    let probes=0,reviews=0;
    const configured:PiPlanner={...planner(),reviewStagedGoal:async input=>{
      reviews++;
      assert.equal(input.checkpointSha256,staged.currentSha256);
      return {verdict:'APPROVE',summary:'Fresh stage renewal by independent PI',
        inference:syntheticInference};
    }};
    const bridge=new TelegramBridge(f.store,new Engine(f.store,never),{
      getUpdates:async offset=>updates.filter(x=>x.update_id>=offset),
      sendMessage:async(_chat,text)=>{sent.push(text);},
    },1001,2001,async()=>{throw Error('No executor');},
    async()=>{throw Error('No Chrome Send');},configured,
    undefined,undefined,async()=>{
      probes++;return syntheticSevenDimensions;
    });
    const command=(n:number,text:string):TelegramUpdate=>({
      update_id:n,message:{text,from:{id:1001},chat:{id:2001,type:'private'}},
    });
    updates.push(command(901,`/goal-verify ${id}`));
    await bridge.pollOnce(0);
    assert.ok(sent.some(s=>s.includes('EXPIRED; use /goal-review to renew')));
    assert.ok(!sent.some(s=>s.includes('Owner activation:')));
    assert.equal(probes,0);
    updates.push(command(902,`/goal-review ${id}`));
    await bridge.pollOnce(0);
    const renewed=f.intake.verifyReadOnly(id);
    assert.equal(probes,1);
    assert.equal(reviews,1);
    assert.equal(renewed.currentSha256,staged.currentSha256);
    assert.equal(renewed.unchanged,true);
    assert.equal(renewed.missionState,'PAUSED');
    assert.equal(renewed.turnCount,0);
    assert.equal(renewed.browserReservations,0);
    assert.equal(renewed.activated,false);
    assert.ok(isFreshStagedApproval(renewed.review));
    assert.notEqual(renewed.review?.reviewedAt,previous.review?.reviewedAt);
    assert.notEqual(renewed.baseline?.baselineSha256,previous.baseline?.baselineSha256);
    const graph=new GoalLedger(f.store).graph(id);
    assert.equal(graph.events.filter(e=>e.type==='goal.stage_pi_reviewed').length,2);
    assert.equal(graph.events.filter(e=>e.type==='goal.stage_baseline_attested').length,2);
    updates.push(command(903,`/goal-review ${id}`));
    await bridge.pollOnce(0);
    assert.equal(probes,1,'a fresh approval cannot trigger another baseline');
    assert.equal(reviews,1,'a fresh approval cannot trigger another PI inference');
    updates.push(command(904,`/goal-activate ${id} ${staged.currentSha256}`));
    await bridge.pollOnce(0);
    assert.equal(f.store.get(staged.record.missionId).state,'READY');
    assert.equal(f.store.chatBrowserTurn(staged.record.missionId),null);
    assert.equal(f.store.getMeta(`goal.stage.hold.${staged.record.missionId}`),'0');
    assert.equal(f.store.get(f.stopId).stopRequested,true);
  }finally{f.dispose();}
});
