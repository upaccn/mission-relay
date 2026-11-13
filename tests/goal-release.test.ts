import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {existsSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/core/store.js';
import {GoalLedger} from '../src/core/goal-store.js';
import {GoalReleaseGate,RELEASE_GATES,InsufficientReleaseEvidenceError,
  inspectReleaseProbeOutcome,approvedReleaseEvidenceSource,
  type ReleaseProbe} from '../src/core/goal-release.js';
import {inspectGoalReleaseMatrix} from '../src/core/goal-release-matrix.js';

const SHA='a'.repeat(40),NEXT_SHA='b'.repeat(40);
const proof=(text:string)=>createHash('sha256').update(text).digest('hex');
function fixture(withTerminal=false){
  const dir=mkdtempSync(join(tmpdir(),'relay-release-gate-'));
  const file=join(dir,'private.sqlite'),store=new Store(file);
  const ledger=new GoalLedger(store),gate=new GoalReleaseGate(store);
  const goal=ledger.createGoal({requestKey:'release-owner',objective:'Release the owner goal',
    priority:90});
  const plan=ledger.createPlan(goal.id,goal.version,{
    requestKey:'planned',summary:'Implement and release',items:[
      {key:'impl',title:'Implement',priority:100,acceptance:['End-user test passes']},
      ...(withTerminal?[{key:'v1-independent-release-gate',
        title:'Independently certify the release',priority:10,
        dependsOn:['impl'],acceptance:['All required receipts independently verified']}]:[]),
    ],
  });
  const approved=ledger.setPlanStatus(goal.id,plan.id,plan.version,'APPROVED','approve');
  ledger.setGoalStatus(goal.id,ledger.getGoal(goal.id).version,'ACTIVE','activate');
  const item=ledger.graph(goal.id).items[0]!;
  const check=ledger.graph(goal.id).acceptance[0]!;
  const terminal=ledger.graph(goal.id).items.find(x=>x.key==='v1-independent-release-gate');
  const terminalCriterion=ledger.graph(goal.id).acceptance.find(x=>x.itemId===terminal?.id);
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
  return {dir,file,store,ledger,gate,goal,approved,passed,close,terminal,terminalCriterion};
}
function independent(requirement:string,sha=SHA,
  state:'PASS'|'FAIL'|'BLOCKED'='PASS'):ReleaseProbe{
  const source=requirement.startsWith('criterion:')?'independent-work':
    ['check','privacy-check','test','build'].includes(requirement)?'local-command':
    requirement.startsWith('ci-')?'github-actions':
    requirement==='gmk-production-readback'?'gmk-readback':
    requirement==='maintenance-resume'?'maintenance-readback':'chrome-readback';
  return {source,inspect:async()=>({state,observedSha:sha,
    reference:`verified://${requirement.replaceAll(':','-')}-receipt`,
    proofSha256:proof(`${requirement}:${sha}:${state}`)})};
}
async function fullEvidence(f:ReturnType<typeof fixture>){
  for(const requirement of f.gate.report(f.goal.id).checks.map(c=>c.requirement))
    await f.gate.inspect(f.goal.id,requirement,independent(requirement));
}

test('two-phase release target admits independent evidence while terminal PI work is open',async()=>{
  const f=fixture(true);
  try{
    f.passed();
    const terminal=f.terminal!,criterion=f.terminalCriterion!;
    const ready=f.ledger.setWorkStatus(f.goal.id,terminal.id,terminal.version,
      'READY',[],'terminal-ready');
    const active=f.ledger.setWorkStatus(f.goal.id,terminal.id,ready.version,
      'IN_PROGRESS',[],'terminal-active');
    const bootstrap=f.gate.begin(f.goal.id,SHA);
    assert.equal(bootstrap.checks.length,RELEASE_GATES.length+2);
    assert.ok(bootstrap.blockers.includes('terminal PI release work or acceptance not yet passed'));
    await fullEvidence(f);
    const held=f.gate.report(f.goal.id);
    assert.equal(held.checks.every(x=>x.state==='PASS'),true);
    assert.equal(held.ready,false,'fully independent receipts do not self-approve PI work');
    await assert.rejects(f.gate.finalize(f.goal.id,async()=>SHA),/evidence/);

    // The normal PI controller binds this review to an observed answer;
    // isolated test fixtures use only the typed SQLite/Goal controller API.
    const mission=f.store.create({goal:f.goal.objective,acceptance:['PI audit'],
      workspace:'',sandbox:'read-only',mode:'supervised',maxTurns:32,
      requestKey:'terminal-review-mission'});
    const linked=f.store.linkChat(mission.id,
      'https://chatgpt.com/c/123e4567-f60a-41ac-83a2-fd25dc311017',
      mission.version).mission;
    const bound=f.store.bindChatBrowser(mission.id,'fixture-browser',linked.version).mission;
    f.store.setMeta(`pi.autopilot.enabled.${mission.id}`,'1');
    f.ledger.bindPiMission(f.goal.id,mission.id,bound.version,'terminal-bind');
    f.store.update(mission.id,bound.version,{state:'PAUSED'},'test.pi-paused');
    const answer=proof('reviewed answer');
    f.ledger.recordPiReview(f.goal.id,mission.id,terminal.id,0,answer,'PASS',
      [`browser-sha256:${answer}`],'Independent review of gate evidence','terminal-pi-review');
    const inReview=f.ledger.setWorkStatus(f.goal.id,terminal.id,active.version,
      'REVIEW',[],'terminal-in-review');
    f.ledger.recordAcceptance(f.goal.id,criterion.id,criterion.version,'PASS',
      [`browser-sha256:${answer}`],'terminal-criterion-passed');
    f.ledger.setWorkStatus(f.goal.id,terminal.id,inReview.version,'PASSED',
      [`browser-sha256:${answer}`],'terminal-passed');
    const after=f.gate.report(f.goal.id);
    assert.equal(after.target?.graphSha256,bootstrap.target?.graphSha256,
      'PI terminal transition cannot erase or retarget independent receipts');
    assert.equal(after.ready,true,JSON.stringify(after.blockers));
    assert.deepEqual(f.gate.begin(f.goal.id,SHA),after,
      'same target and immutable graph must not reset evidence');
    const done=await f.gate.finalize(f.goal.id,async()=>SHA);
    assert.equal(done.complete,true);
    assert.equal(f.ledger.getGoal(f.goal.id).status,'DONE');
  }finally{f.close();}
});

test('terminal work cannot bypass final PI review or mutate its acceptance contract',async()=>{
  const f=fixture(true);
  try{
    f.passed();
    const terminal=f.terminal!,criterion=f.terminalCriterion!;
    const ready=f.ledger.setWorkStatus(f.goal.id,terminal.id,1,'READY',[],'ready-gate');
    const doing=f.ledger.setWorkStatus(f.goal.id,terminal.id,ready.version,
      'IN_PROGRESS',[],'doing-gate');
    f.gate.begin(f.goal.id,SHA);
    await fullEvidence(f);
    const inReview=f.ledger.setWorkStatus(f.goal.id,terminal.id,doing.version,
      'REVIEW',[],'review-without-pi');
    f.ledger.recordAcceptance(f.goal.id,criterion.id,criterion.version,'PASS',
      [`browser-sha256:${proof('unreviewed')}`],'unreviewed-criterion');
    f.ledger.setWorkStatus(f.goal.id,terminal.id,inReview.version,'PASSED',
      [`browser-sha256:${proof('unreviewed')}`],'unreviewed-gate');
    assert.equal(f.gate.report(f.goal.id).ready,false);
    assert.ok(f.gate.report(f.goal.id).blockers.includes(
      'terminal PI release work or acceptance not yet passed'));
    await assert.rejects(f.gate.finalize(f.goal.id,async()=>SHA),/evidence/);
    f.store.db.prepare('UPDATE goal_acceptance SET criterion=? WHERE id=?')
      .run('Tampered terminal acceptance',criterion.id);
    assert.ok(f.gate.report(f.goal.id).blockers.includes('Goal graph/version changed'));
    await assert.rejects(f.gate.inspect(f.goal.id,'test',independent('test')),
      /Goal graph invalid/);
  }finally{f.close();}
});

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

test('text-only, Git commit-only and DONE-marker claims cannot run or PASS any trusted runtime or work ReleaseProbe',async()=>{
  const requirements=[
    'chrome-10-to-11','mission-32-successor','maintenance-resume',
    'relay-tab-retirement','criterion:123e4567-e89b-42d3-a456-426614174001',
  ];
  const claims=[
    {name:'text-only',source:'model-answer',reference:'model-response://unverified-pass'},
    {name:'commit-only',source:'github-actions',
      reference:`https://github.com/upaccn/mission-relay/commit/${SHA}`},
    {name:'DONE-marker',source:'terminal-marker',reference:'model-DONE-marker'},
  ];
  let inspections=0;
  for(const requirement of requirements){
    for(const claim of claims){
      const result=await inspectReleaseProbeOutcome(requirement,SHA,{
        source:claim.source,inspect:async()=>{
          inspections++;
          return {state:'PASS',observedSha:SHA,reference:claim.reference,
            proofSha256:proof(claim.name)};
        },
      });
      assert.equal(result.verdict,'FAIL',`${requirement}: ${claim.name}`);
      assert.equal(result.proofSha256,undefined);
      assert.match(result.reason??'',/Unapproved source/);
    }
  }
  assert.equal(inspections,0,
    'No model statement, CI commit assertion or terminal marker may invoke a trusted runtime inspector');
});

test('maintenance journal cannot be substituted by Chrome-only or text-only receipts',async()=>{
  let invoked=0;
  for(const source of ['chrome-readback','github-actions','model-answer','terminal-marker']){
    const outcome=await inspectReleaseProbeOutcome('maintenance-resume',SHA,{
      source,inspect:async()=>{
        invoked++;
        return {state:'PASS',observedSha:SHA,
          reference:'chrome-readback://no-original-maintenance-journal',
          proofSha256:proof('fabricated-text')};
      },
    });
    assert.equal(outcome.verdict,'FAIL');
    assert.match(outcome.reason??'',/Unapproved source/);
    assert.equal(outcome.proofSha256,undefined);
  }
  assert.equal(invoked,0,'A source mismatch cannot invoke the maintenance inspector');
});

test('unknown and malformed requirements cannot inherit Chrome or independent-work authority',async()=>{
  let inspected=0;
  for(const [requirement,source] of [
    ['chrome-made-up','chrome-readback'],
    ['ci-other','github-actions'],
    ['criterion:placeholder','independent-work'],
    ['criterion:123e4567-e89b-42d3-a456-426614174001-extra','independent-work'],
    ['unknown', 'chrome-readback'],
  ]){
    const outcome=await inspectReleaseProbeOutcome(requirement,SHA,{
      source,inspect:async()=>{inspected++;return {
        state:'PASS',observedSha:SHA,reference:'chrome-readback://claimed',
        proofSha256:proof('unapproved'),
      };},
    });
    assert.equal(outcome.verdict,'FAIL',requirement);
    assert.match(outcome.reason??'',/Unapproved source/);
  }
  assert.equal(inspected,0,'Unknown probes must fail before executing a source');
});

test('every registered ReleaseProbe has an exact source binding, with no cross-source PASS',()=>{
  const bound:Record<string,string>={
    check:'local-command','privacy-check':'local-command',
    test:'local-command',build:'local-command',
    'ci-ubuntu':'github-actions','ci-macos':'github-actions','ci-windows':'github-actions',
    'chrome-10-to-11':'chrome-readback',
    'mission-32-successor':'chrome-readback',
    'maintenance-resume':'maintenance-readback',
    'relay-tab-retirement':'chrome-readback',
    'gmk-production-readback':'gmk-readback',
    'criterion:123e4567-e89b-42d3-a456-426614174001':'independent-work',
  };
  // The bounded 32-to-successor probe is still retained for saved Missions;
  // the obsolete 5→6 special-case probe is no longer part of the API.
  assert.deepEqual(Object.keys(bound).filter(x=>!x.startsWith('criterion:')).sort(),
    [...RELEASE_GATES,'mission-32-successor'].sort());
  const allSources=['local-command','github-actions','chrome-readback',
    'maintenance-readback','gmk-readback','independent-work','model-answer',null];
  for(const [requirement,source] of Object.entries(bound)){
    for(const actual of allSources){
      const accepted=actual===source||
        (actual==='github-actions'&&source==='local-command');
      assert.equal(approvedReleaseEvidenceSource(requirement,actual),accepted,
        `${requirement} via ${String(actual)}`);
    }
  }
  for(const malformed of ['criterion:','criterion:UPPERCASE',
    'criterion:123e4567-e89b-42d3-a456-426614174001-extra',
    'ci-linux','chrome-faked','gmk-production-success','arbitrary']){
    for(const source of allSources)
      assert.equal(approvedReleaseEvidenceSource(malformed,source),false,
        `Unknown requirement ${malformed} cannot inherit ${String(source)}`);
  }
});

test('trusted probe diagnostic distinguishes PASS, contradictory FAIL and insufficient evidence without writing release state',async()=>{
  const f=fixture();
  try{
    const eventCount=f.ledger.graph(f.goal.id).events.length;
    const requirement='chrome-10-to-11',good=independent(requirement);
    const pass=await inspectReleaseProbeOutcome(requirement,SHA,good);
    assert.equal(pass.verdict,'PASS');
    assert.equal(pass.targetSha,SHA);
    assert.equal(pass.source,'chrome-readback');
    assert.match(pass.proofSha256!,/^[0-9a-f]{64}$/);
    const missing=await inspectReleaseProbeOutcome(requirement,SHA,{
      source:'chrome-readback',inspect:async()=>{
        throw new InsufficientReleaseEvidenceError(
          'No independently witnessed physical Chat transition');
      }});
    assert.equal(missing.verdict,'INSUFFICIENT_EVIDENCE');
    assert.equal(missing.proofSha256,undefined);
    const wrongRevision=await inspectReleaseProbeOutcome(requirement,SHA,
      independent(requirement,NEXT_SHA));
    assert.equal(wrongRevision.verdict,'FAIL');
    const selfAttested=await inspectReleaseProbeOutcome(requirement,SHA,{
      source:'chrome-readback',inspect:async()=>({
        state:'PASS',observedSha:SHA,reference:'model DONE',
        proofSha256:proof('unverified browser prose')})});
    assert.equal(selfAttested.verdict,'FAIL');
    const conflict=await inspectReleaseProbeOutcome(requirement,SHA,{
      source:'chrome-readback',inspect:async()=>{throw new Error('Tampered physical Target');}});
    assert.equal(conflict.verdict,'FAIL');
    const wrongSource=await inspectReleaseProbeOutcome(requirement,SHA,{
      source:'github-actions',inspect:async()=>{throw new Error('Must never run');}});
    assert.equal(wrongSource.verdict,'FAIL');
    assert.equal(f.gate.report(f.goal.id).target,null);
    assert.equal(f.ledger.graph(f.goal.id).events.length,eventCount,
      'Diagnostic must not create an approval, release target or browser Send');
  }finally{f.close();}
});

test('persisted failed and blocked release readbacks must attest to the exact target SHA',async()=>{
  const f=fixture();try{
    f.passed();f.gate.begin(f.goal.id,SHA);
    const before=f.gate.report(f.goal.id).checks.find(x=>x.requirement==='test')!;
    const eventCount=f.ledger.graph(f.goal.id).events.length;
    for(const state of ['FAIL','BLOCKED'] as const){
      await assert.rejects(f.gate.inspect(f.goal.id,'test',
        independent('test',NEXT_SHA,state)),/matching target SHA/);
      assert.equal(f.gate.report(f.goal.id).checks.find(x=>x.requirement==='test')?.state,
        before.state);
      assert.equal(f.ledger.graph(f.goal.id).events.length,eventCount,
        'A contradictory failure must not enter immutable release evidence');
    }
    const valid=await f.gate.inspect(f.goal.id,'test',independent('test',SHA,'FAIL'));
    assert.equal(valid.checks.find(x=>x.requirement==='test')?.state,'FAIL');
  }finally{f.close();}
});

test('without a Release Target even a well-formed CI probe is never invoked or stored',async()=>{
  const f=fixture();
  try{
    const original=f.ledger.graph(f.goal.id).events.length;
    let inspections=0;
    const candidate:ReleaseProbe={source:'github-actions',inspect:async()=>{
      inspections++;
      return {state:'PASS',observedSha:SHA,
        reference:'https://github.com/upaccn/mission-relay/actions/runs/42365396806',
        proofSha256:proof('synthetic ci evidence')};
    }};
    await assert.rejects(f.gate.inspect(f.goal.id,'ci-ubuntu',candidate),
      /Release target or Goal graph invalid/);
    assert.equal(inspections,0,'The missing target must reject before even reading the probe');
    assert.equal(f.ledger.graph(f.goal.id).events.length,original);
    const report=f.gate.report(f.goal.id);
    assert.equal(report.target,null);
    assert.equal(report.checks.length,0);
    assert.equal(report.ready,false);
    assert.equal(report.complete,false);
    assert.ok(report.blockers.includes('no release target'));
  }finally{f.close();}
});

test('read-only release matrix never promotes a PI browser-answer claim to independent PASS',()=>{
  const f=fixture();
  try{
    f.passed();
    const before=f.ledger.graph(f.goal.id).events.length;
    const matrix=inspectGoalReleaseMatrix(f.store,f.goal.id);
    assert.equal(matrix.goalState,'ACTIVE');
    assert.equal(matrix.requirements.length,RELEASE_GATES.length+1);
    assert.equal(matrix.requirements.every(x=>x.state==='PENDING'),true);
    const browser=matrix.requirements.find(x=>x.requirement==='chrome-10-to-11');
    assert.equal(browser?.requiresIndependentProbe,true);
    const claimed=matrix.requirements.find(x=>x.requirement.startsWith('criterion:'));
    assert.equal(claimed?.requiresIndependentProbe,true);
    assert.equal(claimed?.state,'PENDING');
    assert.equal(f.ledger.graph(f.goal.id).events.length,before);
    assert.equal(f.gate.report(f.goal.id).target,null);
  }finally{f.close();}
});

test('release matrix CLI opens SQLite query-only and never creates missing state',()=>{
  const home=mkdtempSync(join(tmpdir(),'relay-release-cli-matrix-'));
  const run=(goalId:string)=>spawnSync(process.execPath,
    ['--import','tsx','src/cli.ts','goal-release-matrix',goalId],{
      cwd:process.cwd(),encoding:'utf8',timeout:12000,
      env:{...process.env,MISSION_RELAY_HOME:home},
    });
  try{
    const absent=run('123e4567-e89b-42d3-a456-426614174000');
    assert.notEqual(absent.status,0);
    assert.equal(existsSync(join(home,'missions.sqlite')),false,
      'Read-only diagnostics cannot initialize a missing production database');
    const store=new Store(join(home,'missions.sqlite'));
    const goal=new GoalLedger(store).createGoal({
      requestKey:'matrix-cli',objective:'Verify a read-only CLI matrix',priority:90});
    const before=store.db.prepare('SELECT count(*) AS n FROM goal_events').get() as {n:number};
    store.close();
    const actual=run(goal.id);
    assert.equal(actual.status,0,actual.stderr);
    const matrix=JSON.parse(actual.stdout) as {goalId:string;goalState:string};
    assert.equal(matrix.goalId,goal.id);
    assert.equal(matrix.goalState,'DRAFT');
    const again=new Store(join(home,'missions.sqlite'),{readOnly:true});
    try{
      const after=again.db.prepare('SELECT count(*) AS n FROM goal_events').get() as {n:number};
      assert.equal(after.n,before.n);
    }finally{again.close();}
  }finally{rmSync(home,{recursive:true,force:true});}
});

test('a fully PASS evidence set cannot finalize a Goal with a live original browser reservation',async()=>{
  const f=fixture();
  try{
    f.passed();
    const mission=f.store.create({goal:f.goal.objective,acceptance:['Independent receipt'],
      workspace:'',sandbox:'read-only',mode:'supervised',maxTurns:32,
      requestKey:'linked-live-release'});
    f.store.setMeta(`pi.autopilot.enabled.${mission.id}`,'1');
    const linked=f.store.linkChat(mission.id,
      'https://chatgpt.com/c/123e4567-f60a-41ac-83a2-fd25dc311012',
      mission.version).mission;
    const bound=f.store.bindChatBrowser(mission.id,'trusted-fixture-browser',
      linked.version).mission;
    f.ledger.bindPiMission(f.goal.id,mission.id,bound.version,'bind-live');
    f.gate.begin(f.goal.id,SHA);
    await fullEvidence(f);
    assert.equal(f.gate.report(f.goal.id).ready,false);
    assert.ok(f.gate.report(f.goal.id).blockers.includes('Goal Mission is still executing'));
    const reserved=f.store.reserveChatBrowserTurn(mission.id,bound.version,
      'release-pending-send',proof('the exact original prompt'));
    assert.equal(reserved.state,'RUNNING');
    assert.ok(f.gate.report(f.goal.id).blockers.includes('unsettled Goal browser request'));
    assert.equal(inspectGoalReleaseMatrix(f.store,f.goal.id)
      .requestCustody.unsettledReservationEventIds.length,1);
    await assert.rejects(f.gate.finalize(f.goal.id,async()=>SHA),/evidence/);
    // An operator reconciliation marker by itself is not a verified
    // assistant-answer observation or a PI decision.
    f.store.update(mission.id,reserved.version,{state:'PAUSED'},
      'chatgpt.browser_reconciled',{requestKey:'release-pending-send'});
    assert.ok(f.gate.report(f.goal.id).blockers.includes('unsettled Goal browser request'));
    await assert.rejects(f.gate.finalize(f.goal.id,async()=>SHA),/evidence/);
    assert.equal(f.ledger.getGoal(f.goal.id).status,'ACTIVE');
    assert.equal(f.store.events(mission.id).filter(e=>e.type==='chatgpt.browser_reserved').length,1);
  }finally{f.close();}
});

test('release completion atomically fences even a raw legacy browser Send',async()=>{
  const f=fixture();
  try{
    f.passed();
    const mission=f.store.create({goal:f.goal.objective,acceptance:['Independent receipt'],
      workspace:'',sandbox:'read-only',mode:'supervised',maxTurns:32,
      requestKey:'linked-settled-release'});
    f.store.setMeta(`pi.autopilot.enabled.${mission.id}`,'1');
    const linked=f.store.linkChat(mission.id,
      'https://chatgpt.com/c/123e4567-f60a-41ac-83a2-fd25dc311016',
      mission.version).mission;
    const bound=f.store.bindChatBrowser(mission.id,'trusted-fixture-browser',
      linked.version).mission;
    f.ledger.bindPiMission(f.goal.id,mission.id,bound.version,'bind-settled');
    const paused=f.store.update(mission.id,bound.version,{state:'PAUSED'},
      'mission.pause_requested',{reason:'safe release checkpoint'});
    f.gate.begin(f.goal.id,SHA);
    await fullEvidence(f);
    assert.equal(f.gate.report(f.goal.id).ready,true);
    await f.gate.finalize(f.goal.id,async()=>SHA);
    assert.throws(()=>f.store.reserveChatBrowserTurn(mission.id,paused.version,
      'legacy-post-release-send',proof('must never be sent')),
    /Goal release completed/);
    assert.equal(f.store.events(mission.id).filter(e=>e.type==='chatgpt.browser_reserved').length,0);
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

test('exact-head GitHub CI can independently attest source gates, never Chrome/GMK or business criteria',async()=>{
  const f=fixture();
  try{
    f.passed();f.gate.begin(f.goal.id,SHA);
    for(const requirement of ['check','privacy-check','test','build']){
      const probe={...independent(requirement),source:'github-actions'};
      await f.gate.inspect(f.goal.id,requirement,probe);
      assert.equal(f.gate.report(f.goal.id).checks.find(c=>c.requirement===requirement)?.source,
        'github-actions');
    }
    const current=f.gate.report(f.goal.id);
    assert.equal(current.ready,false);
    assert.ok(current.blockers.includes('gmk-production-readback'));
    assert.ok(current.blockers.includes('chrome-10-to-11'));
    assert.ok(current.blockers.some(b=>b.startsWith('criterion:')));
    await assert.rejects(f.gate.inspect(f.goal.id,'gmk-production-readback',{
      ...independent('gmk-production-readback'),source:'github-actions',
    }),/source/);
    const criterion=current.checks.find(c=>c.requirement.startsWith('criterion:'))!;
    await assert.rejects(f.gate.inspect(f.goal.id,criterion.requirement,{
      ...independent(criterion.requirement),source:'github-actions',
    }),/source/);
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
