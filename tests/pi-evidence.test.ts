import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/core/store.js';
import {inspectPiEvidence} from '../src/core/pi-evidence.js';

const source='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174000';
const first='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174001';
const second='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174002';
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const fixture=()=>{
  const dir=mkdtempSync(join(tmpdir(),'relay-pi-evidence-'));
  const store=new Store(join(dir,'missions.sqlite'));
  const created=store.create({goal:'Owner private nine-round work',acceptance:['Check nine stages'],
    workspace:'',sandbox:'read-only',mode:'supervised',maxTurns:10,checks:[],requestKey:'nine'});
  const linked=store.linkChat(created.id,source,created.version).mission;
  const bound=store.bindChatBrowser(created.id,'install:Chrome:synthetic',linked.version).mission;
  store.setMeta(`pi.autopilot.enabled.${created.id}`,'1');
  return {dir,store,id:bound.id,cleanup:()=>{store.close();rmSync(dir,{recursive:true,force:true});}};
};
const observe=(store:Store,id:string,round:number,newChatUrl?:string)=>{
  const request=`round-${round}`,answer=`Private code result for stage ${round}\n[MISSION_RELAY:NEXT]`;
  store.reserveChatBrowserTurn(id,store.get(id).version,request,sha(`private prompt ${round}`));
  store.finishChatBrowserTurn(id,request,{kind:'observed',assistantSha256:sha(answer),
    summary:answer,...(newChatUrl?{newChatUrl}:{})});
  store.commitPiPlan(id,sha(answer),[],{action:round===9?'DONE':'NEXT',
    summary:`Stage ${round} independently reviewed`,nextPrompt:round===9?'':'Continue one stage'});
};

test('PI ledger audits nine observed sends across exact eight-turn chat boundary without claiming business completion',()=>{
  const f=fixture();try{
    for(let i=1;i<=9;i++)observe(f.store,f.id,i,i===1?first:i===9?second:undefined);
    const eventsBefore=f.store.maxEventId();
    const report=inspectPiEvidence(f.store,f.id);
    assert.equal(report.ledgerConsistent,true);
    assert.deepEqual(report.violations,[]);
    assert.equal(report.observedTurns,9);
    assert.equal(report.decisionsVerified,9);
    assert.equal(report.currentChatObservedTurns,1);
    assert.equal(report.maxObservedTurnsInOneChat,8);
    assert.equal(report.chatSegments,2);
    assert.deepEqual(report.rounds.map(r=>r.chatTurn),[1,2,3,4,5,6,7,8,1]);
    assert.deepEqual(report.rounds.map(r=>r.chatSegment),[1,1,1,1,1,1,1,1,2]);
    assert.ok(report.rounds.every(r=>r.reservedEventId!==null&&r.decisionShaMatches===true));
    assert.equal(report.businessAcceptanceVerified,false);
    assert.equal(f.store.maxEventId(),eventsBefore);
    const cli=JSON.parse(execFileSync(process.execPath,
      ['--import','tsx','src/cli.ts','pi-evidence',f.id],
      {cwd:process.cwd(),env:{...process.env,MISSION_RELAY_HOME:f.dir},
        encoding:'utf8',timeout:12000})) as typeof report;
    assert.equal(cli.ledgerConsistent,true);
    assert.equal(cli.observedTurns,9);
    assert.equal(cli.chatSegments,2);
    assert.equal(cli.maxObservedTurnsInOneChat,8);
    assert.equal(f.store.maxEventId(),eventsBefore);
    const output=JSON.stringify(report);
    for(const sensitive of ['Owner private nine-round work','Private code result',
      'private prompt','chatgpt.com','install:Chrome:synthetic','round-9'])
      assert.ok(!output.includes(sensitive));
  }finally{f.cleanup();}
});

test('PI ledger exposes pending PI review and duplicate reservations as failures rather than certifying acceptance',()=>{
  const f=fixture();try{
    const answer='Unreviewed private response';
    f.store.reserveChatBrowserTurn(f.id,f.store.get(f.id).version,'pending-1',sha('private request'));
    f.store.finishChatBrowserTurn(f.id,'pending-1',{kind:'observed',
      assistantSha256:sha(answer),summary:answer});
    assert.deepEqual(inspectPiEvidence(f.store,f.id).pendingPiReviewRounds,[1]);
    // Corrupt only isolated test ledger rows to prove the independent reader
    // detects an impossible duplicate even when the original controller
    // would correctly refuse to write it.
    const original=f.store.events(f.id).find(e=>e.type==='chatgpt.browser_reserved')!;
    f.store.db.prepare('INSERT INTO events(mission_id,created_at,type,payload_json) VALUES(?,?,?,?)')
      .run(f.id,new Date().toISOString(),original.type,JSON.stringify(original.payload));
    const report=inspectPiEvidence(f.store,f.id);
    assert.equal(report.ledgerConsistent,false);
    assert.ok(report.violations.includes('duplicate_browser_reservation_key'));
    assert.deepEqual(report.pendingPiReviewRounds,[1]);
  }finally{f.cleanup();}
});

test('PI ledger independently flags a ninth Send in one conversation even when PI decisions are hash-matched',()=>{
  const f=fixture();try{
    for(let i=1;i<=9;i++)observe(f.store,f.id,i);
    const report=inspectPiEvidence(f.store,f.id);
    assert.equal(report.decisionsVerified,9);
    assert.equal(report.ledgerConsistent,false);
    assert.equal(report.chatSegments,1);
    assert.equal(report.maxObservedTurnsInOneChat,9);
    assert.ok(report.violations.includes('more_than_eight_sends_in_chat'));
    assert.equal(report.businessAcceptanceVerified,false);
  }finally{f.cleanup();}
});

test('PI ledger independently validates a recovered first-new-chat answer and rejects a mismatched PI hash',()=>{
  const f=fixture();try{
    const answer='Observed after exact-prompt operator recovery',request='first-recover';
    const promptSha=sha('private original');
    f.store.reserveChatBrowserTurn(f.id,f.store.get(f.id).version,request,promptSha);
    f.store.finishChatBrowserTurn(f.id,request,{kind:'uncertain',error:'Synthetic unknown result'});
    f.store.recoverObservedBrowserRollover(f.id,f.store.get(f.id).version,{
      requestPromptSha256:promptSha,newChatUrl:first,assistantSha256:sha(answer),summary:answer});
    f.store.commitPiPlan(f.id,sha(answer),[],{
      action:'NEXT',summary:'Recovered and independently reviewed',nextPrompt:'Check more evidence'});
    const valid=inspectPiEvidence(f.store,f.id);
    assert.equal(valid.ledgerConsistent,true);
    assert.equal(valid.decisionsVerified,1);
    assert.equal(valid.rounds[0]?.observation,'recovered-new-chat');
    assert.equal(valid.rounds[0]?.independentlyRecovered,true);
    assert.equal(valid.chatSegments,1);
    const decision=f.store.events(f.id).find(e=>e.type==='pi.decision')!;
    const altered={...(decision.payload as object),responseSha256:sha('another response')};
    f.store.db.prepare('UPDATE events SET payload_json=? WHERE id=?')
      .run(JSON.stringify(altered),decision.id);
    const invalid=inspectPiEvidence(f.store,f.id);
    assert.equal(invalid.ledgerConsistent,false);
    assert.ok(invalid.violations.includes('pi_decision_answer_sha_mismatch'));
    assert.equal(invalid.decisionsVerified,0);
  }finally{f.cleanup();}
});
