import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/core/store.js';
import {inspectPiEvidence,inspectPiChainEvidence} from '../src/core/pi-evidence.js';

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
  store.reserveChatBrowserTurn(id,store.get(id).version,request,
    sha(`private prompt ${round}`),newChatUrl?{newConversation:true}:{});
  store.finishChatBrowserTurn(id,request,{kind:'observed',assistantSha256:sha(answer),
    summary:answer,...(newChatUrl?{newChatUrl}:{})});
  store.commitPiPlan(id,sha(answer),[],{action:round===9?'DONE':'NEXT',
    summary:`Stage ${round} independently reviewed`,nextPrompt:round===9?'':'Continue one stage'});
};

test('PI ledger audits nine observed sends across exact five-turn chat boundary without claiming business completion',()=>{
  const f=fixture();try{
    for(let i=1;i<=9;i++)observe(f.store,f.id,i,i===1?first:i===6?second:undefined);
    const eventsBefore=f.store.maxEventId();
    const report=inspectPiEvidence(f.store,f.id);
    assert.equal(report.ledgerConsistent,true);
    assert.deepEqual(report.violations,[]);
    assert.equal(report.observedTurns,9);
    assert.equal(report.decisionsVerified,9);
    assert.equal(report.currentChatObservedTurns,4);
    assert.equal(report.maxObservedTurnsInOneChat,5);
    assert.equal(report.chatSegments,2);
    assert.deepEqual(report.rounds.map(r=>r.chatTurn),[1,2,3,4,5,1,2,3,4]);
    assert.deepEqual(report.rounds.map(r=>r.chatSegment),[1,1,1,1,1,2,2,2,2]);
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
    assert.equal(cli.maxObservedTurnsInOneChat,5);
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

test('PI ledger independently flags a sixth Send in one conversation even when PI decisions are hash-matched',()=>{
  const f=fixture();try{
    for(let i=1;i<=6;i++)observe(f.store,f.id,i,i===6?second:undefined);
    // The live reservation gate now prevents this illegal sixth Send. Corrupt
    // an isolated test ledger instead: erase the migration event without
    // changing the observed answer, PI SHA or recorded Send counts.
    const migration=f.store.events(f.id).find(e=>e.type==='chatgpt.browser_migrated')!;
    f.store.db.prepare('DELETE FROM events WHERE id=?').run(migration.id);
    const report=inspectPiEvidence(f.store,f.id);
    assert.equal(report.decisionsVerified,6);
    assert.equal(report.ledgerConsistent,false);
    assert.equal(report.chatSegments,1);
    assert.equal(report.maxObservedTurnsInOneChat,6);
    assert.ok(report.violations.includes('chat_send_limit_exceeded'));
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

test('PI ledger rejects duplicate base decisions and changed historical SHA even when latest revision matches',()=>{
  const f=fixture();try{
    observe(f.store,f.id,1,first);
    const decision=f.store.events(f.id).find(e=>e.type==='pi.decision')!;
    const insert=(type:string,payload:unknown)=>f.store.db.prepare(
      'INSERT INTO events(mission_id,created_at,type,payload_json) VALUES(?,?,?,?)'
    ).run(f.id,new Date().toISOString(),type,JSON.stringify(payload));
    insert('pi.decision_revised',decision.payload);
    assert.equal(inspectPiEvidence(f.store,f.id).ledgerConsistent,true);
    insert('pi.decision',decision.payload);
    assert.ok(inspectPiEvidence(f.store,f.id).violations.includes('duplicate_base_pi_decision'));
    const tampered={...(decision.payload as object),responseSha256:sha('other')};
    f.store.db.prepare('UPDATE events SET payload_json=? WHERE id=?')
      .run(JSON.stringify(tampered),decision.id);
    assert.ok(inspectPiEvidence(f.store,f.id).violations.includes(
      'historical_pi_decision_answer_sha_mismatch'));
  }finally{f.cleanup();}
});

const createVerifiedSuccessor=(store:Store)=>{
  const created=store.create({goal:'Owner-approved chained evidence review',
    acceptance:['Verify all 32 checkpoints'],workspace:'',sandbox:'read-only',
    mode:'supervised',maxTurns:32,checks:[],requestKey:'chain-ledger-parent'});
  const linked=store.linkChat(created.id,source,created.version).mission;
  const bound=store.bindChatBrowser(created.id,'install:Chrome:synthetic',linked.version).mission;
  store.setMeta(`pi.autopilot.enabled.${created.id}`,'1');
  const parentId=bound.id;
  for(let round=1;round<=32;round++){
    const requestKey=`chain-ledger-${round}`,answer=`Private stage ${round}`;
    const migration=round===1||[6,11,16,21,26,31].includes(round)
      ?{newChatUrl:`https://chatgpt.com/c/123e4567-e89b-42d3-a456-${(426614174000+round).toString()}`}
      :{};
    store.reserveChatBrowserTurn(parentId,store.get(parentId).version,requestKey,
      sha(`private submitted prompt ${round}`),
      migration.newChatUrl?{newConversation:true}:{});
    store.finishChatBrowserTurn(parentId,requestKey,{kind:'observed',
      assistantSha256:sha(answer),summary:answer,...migration});
    store.commitPiPlan(parentId,sha(answer),[],{
      action:'NEXT',summary:`Stage ${round} confirmed, more remains`,
      nextPrompt:'Verify remaining stages'});
  }
  const child=store.createPiSuccessor(parentId);
  assert.ok(child);
  return {parentId,childId:child.id};
};

test('real store lineage reader verifies 32-to-1 successor creation, inherited scope and exact first-chat migration',()=>{
  const f=fixture();try{
    const {parentId,childId}=createVerifiedSuccessor(f.store);
    assert.equal(f.store.createPiSuccessor(parentId)?.id,childId);
    const before=f.store.maxEventId();
    const ready=inspectPiChainEvidence(f.store,childId);
    assert.equal(ready.chainConsistent,true);
    assert.equal(ready.missionCount,2);
    assert.equal(ready.missions[0]?.observedTurns,32);
    assert.equal(ready.missions[0]?.decisionsVerified,32);
    assert.equal(ready.missions[0]?.maxObservedTurnsInOneChat,5);
    assert.equal(ready.links[0]?.scopeInherited,true);
    assert.equal(ready.links[0]?.childStartsInNewChat,null);
    assert.equal(ready.links[0]?.parentAnswerShaMatches,true);
    assert.equal(ready.links[0]?.parentPlanRound,32);
    assert.equal(ready.businessAcceptanceVerified,false);
    assert.equal(f.store.maxEventId(),before);
    const req='child-first',answer='Child verified final stage';
    f.store.reserveChatBrowserTurn(childId,f.store.get(childId).version,
      req,sha('child prompt'),{newConversation:true});
    f.store.finishChatBrowserTurn(childId,req,{kind:'observed',
      assistantSha256:sha(answer),summary:answer,newChatUrl:second});
    f.store.commitPiPlan(childId,sha(answer),[],{action:'DONE',summary:'Test finished',nextPrompt:''});
    const after=inspectPiChainEvidence(f.store,parentId);
    assert.equal(after.chainConsistent,true);
    assert.equal(after.links[0]?.childStartsInNewChat,true);
    assert.equal(after.missions[1]?.observedTurns,1);
    const cli=JSON.parse(execFileSync(process.execPath,
      ['--import','tsx','src/cli.ts','pi-chain-evidence',childId],
      {cwd:process.cwd(),env:{...process.env,MISSION_RELAY_HOME:f.dir},
        encoding:'utf8',timeout:12000})) as typeof after;
    assert.equal(cli.chainConsistent,true);
    assert.equal(cli.missionCount,2);
    assert.equal(cli.links[0]?.parentAnswerShaMatches,true);
    assert.equal(cli.businessAcceptanceVerified,false);
    const output=JSON.stringify(cli);
    assert.ok(!output.includes('Owner-approved chained evidence review'));
    assert.ok(!output.includes('Private stage'));
    assert.ok(!output.includes('chatgpt.com'));
  }finally{f.cleanup();}
});

test('cross-Mission lineage reader detects scope tampering and child using the existing conversation',()=>{
  const f=fixture();try{
    const {parentId,childId}=createVerifiedSuccessor(f.store);
    const req='child-same-chat',answer='Should be refused by control plane';
    assert.throws(()=>f.store.reserveChatBrowserTurn(childId,f.store.get(childId).version,
      'child-rejected-same-chat',sha('bad prompt')),/first Send must open a new ChatGPT conversation/);
    // The new reservation gate prevents a malformed first Send. To retain an
    // independent HISTORICAL ledger audit, forge only an isolated test record
    // by removing its first migration event after an otherwise valid Send.
    f.store.reserveChatBrowserTurn(childId,f.store.get(childId).version,req,
      sha('bad prompt'),{newConversation:true});
    f.store.finishChatBrowserTurn(childId,req,{kind:'observed',
      assistantSha256:sha(answer),summary:answer,newChatUrl:second});
    const firstMigration=f.store.events(childId).find(e=>e.type==='chatgpt.browser_migrated')!;
    f.store.db.prepare('DELETE FROM events WHERE id=?').run(firstMigration.id);
    f.store.commitPiPlan(childId,sha(answer),[],{action:'NEXT',summary:'Bad child test',nextPrompt:'Move chat'});
    const report=inspectPiChainEvidence(f.store,parentId);
    assert.equal(report.chainConsistent,false);
    assert.ok(report.violations.includes('pi_chain_child_first_send_not_new_chat'));
    // Switching chats later must not retroactively legitimize the FIRST
    // child Send, which was incorrectly issued in the predecessor chat.
    const secondRequest='child-second',secondAnswer='Eventually moved';
    f.store.reserveChatBrowserTurn(childId,f.store.get(childId).version,
      secondRequest,sha('second child prompt'),{newConversation:true});
    f.store.finishChatBrowserTurn(childId,secondRequest,{kind:'observed',
      assistantSha256:sha(secondAnswer),summary:secondAnswer,newChatUrl:first});
    f.store.commitPiPlan(childId,sha(secondAnswer),[],{
      action:'DONE',summary:'Later move cannot repair the violation',nextPrompt:''});
    assert.ok(inspectPiChainEvidence(f.store,parentId).violations.includes(
      'pi_chain_child_first_send_not_new_chat'));
    f.store.db.prepare('UPDATE missions SET workspace=? WHERE id=?')
      .run('unauthorized-scope',childId);
    const altered=inspectPiChainEvidence(f.store,childId);
    assert.ok(altered.violations.includes('pi_chain_scope_not_preserved'));
    assert.equal(altered.links[0]?.scopeInherited,false);
  }finally{f.cleanup();}
});

test('PI diagnostic database opens strictly read-only and refuses state mutation or missing state creation',()=>{
  const f=fixture();try{
    const baseline=f.store.maxEventId();
    const reader=new Store(join(f.dir,'missions.sqlite'),{readOnly:true});
    try{
      assert.equal(inspectPiEvidence(reader,f.id).ledgerConsistent,true);
      assert.equal(inspectPiChainEvidence(reader,f.id).chainConsistent,true);
      assert.throws(()=>reader.setMeta('unauthorized.audit.write','nope'),/readonly|READONLY/i);
      assert.equal(reader.getMeta('unauthorized.audit.write'),null);
    }finally{reader.close();}
    assert.equal(f.store.maxEventId(),baseline);
    const nonexistent=join(f.dir,'does-not-exist.sqlite');
    assert.throws(()=>new Store(nonexistent,{readOnly:true}),/open|SQLITE_CANTOPEN/i);
    assert.equal(existsSync(nonexistent),false);
    const cli=JSON.parse(execFileSync(process.execPath,
      ['--import','tsx','src/cli.ts','pi-evidence',f.id],
      {cwd:process.cwd(),env:{...process.env,MISSION_RELAY_HOME:f.dir},
        encoding:'utf8',timeout:12000})) as {ledgerConsistent:boolean};
    assert.equal(cli.ledgerConsistent,true);
    assert.equal(f.store.maxEventId(),baseline);
  }finally{f.cleanup();}
});
