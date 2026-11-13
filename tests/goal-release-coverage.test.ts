import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {existsSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/core/store.js';
import {GoalLedger} from '../src/core/goal-store.js';
import {GoalReleaseGate} from '../src/core/goal-release.js';
import {inspectGoalReleaseCoverage} from '../src/core/goal-release-coverage.js';
import {inspectGoalReleaseMatrix} from '../src/core/goal-release-matrix.js';

const sha='a'.repeat(40),otherSha='b'.repeat(40);
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');

function fixture(counts:number[]=[4,3,4,3,3,3,3,4]){
  const dir=mkdtempSync(join(tmpdir(),'relay-coverage-'));
  const store=new Store(join(dir,'missions.sqlite'));
  const ledger=new GoalLedger(store);
  const goal=ledger.createGoal({requestKey:'coverage-owner',
    objective:'Synthetic, never production goal',priority:80});
  const plan=ledger.createPlan(goal.id,goal.version,{
    requestKey:'coverage-plan',summary:'Independent evidence coverage',
    items:counts.map((count,i)=>({key:`package-${i}`,title:`Package ${i}`,
      priority:100-i,acceptance:Array.from({length:count},(_,n)=>
        `Test criterion ${i}-${n} with PRIVATE_DO_NOT_EXPORT`)})),
  });
  ledger.setPlanStatus(goal.id,plan.id,plan.version,'APPROVED','owner');
  ledger.setGoalStatus(goal.id,ledger.getGoal(goal.id).version,'ACTIVE','activate');
  return {dir,store,ledger,goal,close:()=>{
    store.close();rmSync(dir,{force:true,recursive:true});
  }};
}

test('release coverage maps 38 active Goal requirements without obsolete 32-turn gate',()=>{
  const f=fixture();
  try{
    const beforeEvents=f.ledger.graph(f.goal.id).events.length;
    const first=inspectGoalReleaseCoverage(f.store,f.goal.id,sha);
    assert.equal(first.requirements.length,38);
    assert.equal(first.summary.total,38);
    assert.equal(first.summary.recordedPass,0);
    assert.equal(first.summary.unverified,38);
    assert.equal(first.candidateSha,sha);
    assert.equal(first.releaseTargetSha,null);
    assert.ok(first.requirements.every(row=>row.existingTargetState==='PENDING'&&
      row.candidateState==='NOT_TARGET'&&row.missing.length>0));
    const fixed=first.requirements.filter(row=>row.kind==='fixed');
    assert.equal(fixed.length,11);
    for(const name of ['chrome-10-to-11',
      'maintenance-resume','relay-tab-retirement']){
      const row=fixed.find(x=>x.requirement===name);
      assert.ok(row);
      assert.ok(row.missing.some(m=>m.includes('independent')||m.includes('audit')));
    }
    assert.equal(first.requirements.filter(row=>row.kind==='business-criterion').length,27);
    assert.ok(first.requirements.filter(row=>row.kind==='business-criterion')
      .every(row=>row.missing.includes('requirement_specific_independent_work_probe')));
    assert.doesNotMatch(JSON.stringify(first),/PRIVATE_DO_NOT_EXPORT/);
    assert.equal(inspectGoalReleaseCoverage(f.store,f.goal.id,sha).indexSha256,
      first.indexSha256,'unchanged original SQLite state must give a stable coverage digest');
    assert.equal(f.ledger.graph(f.goal.id).events.length,beforeEvents);
    assert.equal(new GoalReleaseGate(f.store).report(f.goal.id).target,null);
  }finally{f.close();}
});

test('release matrix excludes superseded plan work and criteria without deleting history',()=>{
  const f=fixture([2]);
  try{
    const original=f.ledger.graph(f.goal.id);
    const oldPlan=original.plans[0]!;
    const oldCriteria=original.acceptance.map(a=>a.id);
    f.ledger.setPlanStatus(f.goal.id,oldPlan.id,oldPlan.version,'SUPERSEDED','supersede-old');
    const next=f.ledger.createPlan(f.goal.id,f.ledger.getGoal(f.goal.id).version,{
      requestKey:'new-plan',summary:'Only current release scope',
      items:[{key:'new-work',title:'Current work',priority:10,acceptance:['New criterion']}],
    });
    f.ledger.setPlanStatus(f.goal.id,next.id,next.version,'APPROVED','approve-new');

    const graph=f.ledger.graph(f.goal.id);
    assert.equal(graph.plans.length,2,'historical plan must be preserved');
    assert.equal(graph.acceptance.length,3,'historical acceptance must be preserved');
    const matrix=inspectGoalReleaseMatrix(f.store,f.goal.id);
    assert.deepEqual(matrix.workItems.map(item=>item.key),['new-work']);
    assert.equal(matrix.requirements.length,12,'only current criterion plus eleven fixed gates');
    for(const criterion of oldCriteria)
      assert.ok(!matrix.requirements.some(r=>r.requirement===`criterion:${criterion}`));
    const coverage=inspectGoalReleaseCoverage(f.store,f.goal.id,sha);
    assert.equal(coverage.summary.total,12);
    assert.deepEqual(coverage.workItems.map(item=>item.key),['new-work']);
    assert.equal(f.ledger.graph(f.goal.id).acceptance.length,3,
      'diagnostic readbacks must not rewrite historical plan rows');
  }finally{f.close();}
});

test('only a matching, audited, SHA-bound Release Gate PASS becomes an independent receipt',async()=>{
  const f=fixture([1]);
  try{
    const item=f.ledger.graph(f.goal.id).items[0]!;
    const criterion=f.ledger.graph(f.goal.id).acceptance[0]!;
    f.ledger.setWorkStatus(f.goal.id,item.id,1,'READY',[],'ready');
    f.ledger.setWorkStatus(f.goal.id,item.id,2,'IN_PROGRESS',[],'working');
    f.ledger.setWorkStatus(f.goal.id,item.id,3,'REVIEW',[],'review');
    f.ledger.recordAcceptance(f.goal.id,criterion.id,1,'PASS',
      ['browser-sha256:'+hash('claimed')],'pi-claim');
    f.ledger.setWorkStatus(f.goal.id,item.id,4,'PASSED',
      ['browser-sha256:'+hash('claimed')],'pi-passed');
    const gate=new GoalReleaseGate(f.store);
    gate.begin(f.goal.id,sha);
    const before=inspectGoalReleaseCoverage(f.store,f.goal.id,sha);
    const claimed=before.requirements.find(x=>x.kind==='business-criterion')!;
    assert.equal(claimed.candidateState,'PENDING');
    assert.ok(claimed.missing.includes('original_observation_and_matching_pi_decision'));
    assert.equal(before.summary.recordedPass,0);

    const sensitiveReference='https://private.example/path?token=DO_NOT_EXPORT_TOKEN';
    await gate.inspect(f.goal.id,'check',{source:'local-command',inspect:async()=>({
      state:'PASS',observedSha:sha,reference:sensitiveReference,
      proofSha256:hash('original'),
    })});
    const qualified=inspectGoalReleaseCoverage(f.store,f.goal.id,sha);
    assert.equal(qualified.summary.recordedPass,1);
    const verified=qualified.requirements.find(x=>x.requirement==='check')!;
    assert.equal(verified.candidateClass,'independent-release-receipt');
    assert.deepEqual(verified.missing,[]);
    assert.equal(verified.receiptSha256,hash('original'));
    assert.equal(verified.receiptReferenceSha256,hash(sensitiveReference));
    assert.doesNotMatch(JSON.stringify(qualified),/private\.example|DO_NOT_EXPORT_TOKEN/);
    assert.equal(inspectGoalReleaseCoverage(f.store,f.goal.id,otherSha).summary.recordedPass,0,
      'A previous SHA is never a current release verification');
    const other=inspectGoalReleaseCoverage(f.store,f.goal.id,otherSha);
    assert.equal(other.candidateReady,false);
    assert.equal(other.candidateComplete,false);
    assert.equal(other.requirements.find(x=>x.requirement==='check')?.candidateState,'NOT_TARGET');

    // A forged row without the append-only Goal audit must fail closed.
    for(const [field,value] of [
      ['source','github-actions'],['reference','https://other.example/token=SECRET'],
      ['proof_sha256',hash('forged')],
    ]){
      f.store.db.prepare(`UPDATE goal_release_checks SET ${field}=?
        WHERE goal_id=? AND requirement='check'`).run(value,f.goal.id);
      const forged=inspectGoalReleaseCoverage(f.store,f.goal.id,sha);
      assert.equal(forged.summary.recordedPass,0);
      const invalidReceipt=forged.requirements.find(x=>x.requirement==='check')!;
      assert.ok(invalidReceipt.missing.length>0);
      assert.equal(invalidReceipt.existingTargetState,'PASS');
      assert.equal(invalidReceipt.candidateState,'UNVERIFIED',
        'A forged PASS field must never be represented as a verified candidate PASS');
      assert.equal(gate.report(f.goal.id).ready,false);
      assert.doesNotMatch(JSON.stringify(forged),/other\.example|SECRET/);
      await gate.inspect(f.goal.id,'check',{source:'local-command',inspect:async()=>({
        state:'PASS',observedSha:sha,reference:sensitiveReference,
        proofSha256:hash('original'),
      })});
      assert.equal(inspectGoalReleaseCoverage(f.store,f.goal.id,sha).summary.recordedPass,1);
    }
    gate.begin(f.goal.id,otherSha);
    assert.equal(inspectGoalReleaseCoverage(f.store,f.goal.id,sha).summary.recordedPass,0);
    assert.equal(inspectGoalReleaseCoverage(f.store,f.goal.id,otherSha).summary.recordedPass,0);
    gate.begin(f.goal.id,sha);
    await gate.inspect(f.goal.id,'maintenance-resume',{source:'maintenance-readback',
      inspect:async()=>({state:'PASS',observedSha:sha,
        reference:'maintenance-readback://verified-original-journal',
        proofSha256:hash('verified original maintenance test receipt')})});
    const recovery=inspectGoalReleaseCoverage(f.store,f.goal.id,sha);
    const maintenance=recovery.requirements.find(x=>x.requirement==='maintenance-resume')!;
    assert.equal(recovery.summary.recordedPass,1);
    assert.equal(maintenance.candidateClass,'independent-release-receipt');
    assert.deepEqual(maintenance.missing,[]);
    f.store.db.prepare(`UPDATE goal_release_checks SET source='chrome-readback'
      WHERE goal_id=? AND requirement='maintenance-resume'`).run(f.goal.id);
    const substituted=inspectGoalReleaseCoverage(f.store,f.goal.id,sha);
    assert.equal(substituted.summary.recordedPass,0);
    assert.equal(substituted.requirements.find(x=>x.requirement==='maintenance-resume')
      ?.candidateState,'UNVERIFIED');
    assert.equal(gate.report(f.goal.id).ready,false);
  }finally{f.close();}
});

test('candidate work evidence resolves to the original request, answer and PI decision without granting release PASS',()=>{
  const f=fixture([1]);
  try{
    const chat='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174100';
    const next='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174101';
    const created=f.store.create({goal:f.goal.objective,acceptance:['Private work'],
      workspace:'',sandbox:'read-only',mode:'supervised',maxTurns:32,
      requestKey:'original-mission',checks:[]});
    const linked=f.store.linkChat(created.id,chat,created.version).mission;
    const bound=f.store.bindChatBrowser(created.id,'fixture:Chrome',linked.version).mission;
    f.store.setMeta(`pi.autopilot.enabled.${created.id}`,'1');
    f.ledger.bindPiMission(f.goal.id,created.id,bound.version,'bind');
    const planningAnswer='Original plan\n[MISSION_RELAY:NEXT]';
    f.store.reserveChatBrowserTurn(created.id,f.store.get(created.id).version,
      'private-plan-key',hash('private plan'),{newConversation:true});
    f.store.finishChatBrowserTurn(created.id,'private-plan-key',{
      kind:'observed',assistantSha256:hash(planningAnswer),
      summary:planningAnswer,newChatUrl:next});
    f.store.commitPiPlan(created.id,hash(planningAnswer),[],{
      action:'NEXT',summary:'plan',nextPrompt:'work'});
    const graph=f.ledger.graph(f.goal.id);
    const item=graph.items[0]!,criterion=graph.acceptance[0]!;
    f.ledger.setWorkStatus(f.goal.id,item.id,1,'READY',[],'ready');
    const working=f.ledger.setWorkStatus(f.goal.id,item.id,2,'IN_PROGRESS',[],'working');
    const pi=f.store.piPlan(created.id)!;
    const privatePrompt='Do not publish my original request text';
    f.store.reserveChatBrowserTurn(created.id,f.store.get(created.id).version,
      'private-work-key',hash(privatePrompt),{
        promptSnapshot:{format:'goal-work-v1',prompt:privatePrompt},
        goalBinding:{goalId:f.goal.id,planId:graph.plans[0]!.id,
          itemId:item.id,itemVersion:working.version,
          piResponseSha256:pi.responseSha256,
          piPlanSha256:hash(JSON.stringify(pi))},
      });
    const workAnswer='Original observed private answer\n[MISSION_RELAY:NEXT]';
    f.store.finishChatBrowserTurn(created.id,'private-work-key',{
      kind:'observed',assistantSha256:hash(workAnswer),summary:workAnswer});
    f.store.commitPiPlan(created.id,hash(workAnswer),[],{
      action:'NEXT',summary:'review',nextPrompt:'Continue'});
    f.ledger.setWorkStatus(f.goal.id,item.id,3,'REVIEW',[],'pi-review');
    f.ledger.recordAcceptance(f.goal.id,criterion.id,1,'PASS',
      ['browser-sha256:'+hash(workAnswer)],'pi-reported-pass');
    f.ledger.setWorkStatus(f.goal.id,item.id,4,'PASSED',
      ['browser-sha256:'+hash(workAnswer)],'pi-pass');

    const report=inspectGoalReleaseCoverage(f.store,f.goal.id,sha);
    assert.equal(report.summary.recordedPass,0);
    const claim=report.requirements.find(row=>row.kind==='business-criterion')!;
    assert.equal(claim.candidateClass,'model-claim');
    assert.equal(claim.originalRequestCustody.length,1);
    assert.equal(claim.originalRequestCustody[0]?.promptSha256,hash(privatePrompt));
    assert.equal(claim.originalRequestCustody[0]?.answerSha256,hash(workAnswer));
    assert.ok(claim.originalRequestCustody[0]?.reservationEventId);
    assert.ok(claim.originalRequestCustody[0]?.decisionEventId);
    assert.ok(claim.missing.includes('requirement_specific_independent_work_probe'));
    const serialized=JSON.stringify(report);
    for(const secret of ['Do not publish my original request text',
      'Original observed private answer','private-work-key',chat,next])
      assert.ok(!serialized.includes(secret));
  }finally{f.close();}
});

test('read-only coverage CLI cannot create a missing SQLite database or accept malformed SHA',()=>{
  const home=mkdtempSync(join(tmpdir(),'relay-coverage-cli-'));
  const id='123e4567-e89b-42d3-a456-426614174000';
  const run=(...args:string[])=>spawnSync(process.execPath,
    ['--import','tsx','src/cli.ts','goal-release-coverage',...args],{
      cwd:process.cwd(),encoding:'utf8',timeout:15000,
      env:{...process.env,MISSION_RELAY_HOME:home},
    });
  try{
    const missing=run(id,'--sha',sha);
    assert.notEqual(missing.status,0);
    assert.equal(existsSync(join(home,'missions.sqlite')),false);
    const f=new Store(join(home,'missions.sqlite'));
    const goal=new GoalLedger(f).createGoal({requestKey:'coverage-cli',
      objective:'Read only CLI test',priority:1});
    const logicalDigest=(store:Store)=>{
      const tables=(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as Array<{name:string}>).map(row=>row.name);
      return hash(JSON.stringify(tables.map(table=>[table,store.db.prepare(
        `SELECT * FROM "${table.replaceAll('"','""')}"`).all()])));
    };
    const originalDigest=logicalDigest(f);
    f.close();
    assert.notEqual(run(goal.id,'--sha','not-a-sha').status,0);
    const valid=run(goal.id,'--sha',sha);
    assert.equal(valid.status,0,valid.stderr);
    const report=JSON.parse(valid.stdout) as {candidateSha:string;summary:{total:number}};
    assert.equal(report.candidateSha,sha);
    assert.equal(report.summary.total,11);
    const reopened=new Store(join(home,'missions.sqlite'),{readOnly:true});
    try{
      assert.equal(logicalDigest(reopened),originalDigest,
        'Every SQLite table must remain unchanged after the read-only CLI calls');
    }finally{reopened.close();}
  }finally{rmSync(home,{recursive:true,force:true});}
});
