import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
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
    workspace:'',sandbox:'read-only',mode:'supervised',checks:[],requestKey:'nine'});
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

test('owned-tab close receipts require a prior Relay-created chat and are independently audited',()=>{
  const f=fixture();try{
    for(let i=1;i<=6;i++)observe(f.store,f.id,i,i===1?first:i===6?second:undefined);
    assert.equal(f.store.canRetireOwnedChatTab(f.id,source,second),false,
      'A human-owned anchor has no close preflight authorization');
    assert.equal(f.store.canRetireOwnedChatTab(f.id,first,second),true,
      'The second Relay migration and matching complete answer are durable');
    assert.throws(()=>f.store.recordOwnedChatTabRetired(f.id,source,second),
      /previously Relay-created/,'Never certify closure of an owner-linked anchor');
    f.store.recordOwnedChatTabRetired(f.id,first,second);
    assert.equal(f.store.canRetireOwnedChatTab(f.id,first,second),false,
      'An existing retirement receipt denies a second physical close');
    assert.throws(()=>f.store.recordOwnedChatTabRetired(f.id,first,second),
      /already has a retirement receipt/,'Do not duplicate a successful close');
    const report=inspectPiEvidence(f.store,f.id);
    assert.equal(report.ledgerConsistent,true,report.violations.join(','));
    assert.equal(report.tabRetirementReceipts.length,1);
    assert.equal(report.tabRetirementReceipts[0]?.retiredUrlSha256,sha(first));
    assert.equal(report.tabRetirementReceipts[0]?.activeUrlSha256,sha(second));
    assert.ok(!JSON.stringify(report).includes('chatgpt.com'),'Keep full browser URLs private');
    f.store.db.prepare('INSERT INTO events(mission_id,created_at,type,payload_json) VALUES (?,?,?,?)')
      .run(f.id,new Date().toISOString(),'chatgpt.browser_tab_retired',
        JSON.stringify({...f.store.events(f.id).at(-1)!.payload,
          migrationEventId:123456}));
    const corrupted=inspectPiEvidence(f.store,f.id);
    assert.equal(corrupted.ledgerConsistent,false);
    assert.ok(corrupted.violations.includes('invalid_browser_tab_retirement'));
    assert.equal(corrupted.tabRetirementReceipts.length,1,
      'Forged receipt must not be credited');
  }finally{f.cleanup();}
});

test('read-only PI evidence attributes pending and uncertain requests to the original reservation',()=>{
  const f=fixture();try{
    const promptSha256=sha('private pending prompt');
    f.store.reserveChatBrowserTurn(f.id,f.store.get(f.id).version,
      'private-first-request',promptSha256,{newConversation:true});
    const event=f.store.events(f.id).find(e=>e.type==='chatgpt.browser_reserved')!;
    const before=f.store.maxEventId();
    const pending=inspectPiEvidence(f.store,f.id);
    assert.equal(pending.ledgerConsistent,true);
    assert.deepEqual(pending.activeRequestEvidence,{
      reservationEventId:event.id,round:1,promptSha256,status:'reserved',
      newConversationIntent:true,
    });
    assert.equal(pending.pendingBrowserRequest,true);
    assert.equal(pending.observedTurns,0);
    assert.equal(f.store.maxEventId(),before);
    const printed=JSON.stringify(pending);
    for(const secret of ['private pending prompt','private-first-request',
      'chatgpt.com','install:Chrome:synthetic'])assert.ok(!printed.includes(secret));
    f.store.finishChatBrowserTurn(f.id,'private-first-request',{
      kind:'uncertain',error:'Synthetic uncertain effect, never replay'});
    const uncertain=inspectPiEvidence(f.store,f.id);
    assert.equal(uncertain.ledgerConsistent,true);
    assert.equal(uncertain.pendingBrowserRequest,false);
    assert.equal(uncertain.activeRequestEvidence?.status,'uncertain');
    assert.equal(uncertain.activeRequestEvidence?.reservationEventId,event.id);
    const key=`chatgpt.browser.active.${f.id}`;
    const original=f.store.getMeta(key)!;
    f.store.setMeta(key,JSON.stringify({...JSON.parse(original),
      promptSha256:sha('forged later request')}));
    const forged=inspectPiEvidence(f.store,f.id);
    assert.equal(forged.ledgerConsistent,false);
    assert.equal(forged.activeRequestEvidence,null);
    assert.ok(forged.violations.includes('active_request_reservation_unlinked'));
    f.store.setMeta(key,original);
  }finally{f.cleanup();}
});

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

test('PI ledger independently flags a ninth Send in one conversation even when PI decisions are hash-matched',()=>{
  const f=fixture();try{
    for(let i=1;i<=9;i++)observe(f.store,f.id,i,i===9?second:undefined);
    // The live reservation gate prevents this illegal ninth same-chat Send. Corrupt
    // an isolated test ledger instead: erase the migration event without
    // changing the observed answer, PI SHA or recorded Send counts.
    const migration=f.store.events(f.id).find(e=>e.type==='chatgpt.browser_migrated')!;
    f.store.db.prepare('DELETE FROM events WHERE id=?').run(migration.id);
    const report=inspectPiEvidence(f.store,f.id);
    assert.equal(report.decisionsVerified,9);
    assert.equal(report.ledgerConsistent,false);
    assert.equal(report.chatSegments,1);
    assert.equal(report.maxObservedTurnsInOneChat,9);
    assert.ok(report.violations.includes('chat_send_limit_exceeded'));
    assert.equal(report.businessAcceptanceVerified,false);
  }finally{f.cleanup();}
});

test('PI ledger rejects fake or misattributed chat migrations even when all answer and decision hashes match',()=>{
  const f=fixture();try{
    for(let i=1;i<=6;i++)observe(f.store,f.id,i,i===1?first:i===6?second:undefined);
    assert.equal(inspectPiEvidence(f.store,f.id).ledgerConsistent,true);
    const migrations=f.store.events(f.id).filter(e=>e.type==='chatgpt.browser_migrated');
    assert.equal(migrations.length,2);
    const update=(eventId:number,p:unknown)=>f.store.db.prepare(
      'UPDATE events SET payload_json=? WHERE id=?').run(JSON.stringify(p),eventId);
    const firstEvent=migrations[0]!;
    // Model and PI agree on all six answers; the unrelated migration cannot
    // be used to manufacture a valid 5->6 transition.
    update(firstEvent.id,{...(firstEvent.payload as object),requestKey:'unrelated-request'});
    const wrongRequest=inspectPiEvidence(f.store,f.id);
    assert.equal(wrongRequest.decisionsVerified,6);
    assert.ok(wrongRequest.violations.includes('migration_request_mismatch'));
    assert.ok(wrongRequest.violations.includes('migration_without_matching_reservation'));
    update(firstEvent.id,firstEvent.payload);
    update(firstEvent.id,{...(firstEvent.payload as object),
      newUrlSha256:(firstEvent.payload as {previousUrlSha256:string}).previousUrlSha256});
    assert.ok(inspectPiEvidence(f.store,f.id).violations.includes('invalid_migration_url_sha256'));
    update(firstEvent.id,firstEvent.payload);
    const last=migrations[1]!;
    f.store.db.prepare('INSERT INTO events(mission_id,created_at,type,payload_json) VALUES(?,?,?,?)')
      .run(f.id,new Date().toISOString(),'chatgpt.browser_migrated',JSON.stringify(last.payload));
    assert.ok(inspectPiEvidence(f.store,f.id).violations.includes('migration_without_observed_response'));
    assert.equal(inspectPiEvidence(f.store,f.id).businessAcceptanceVerified,false);
  }finally{f.cleanup();}
});

test('PI ledger refuses a discontinuous 5-to-6 Chat URL migration despite matching answer and PI hashes',()=>{
  const f=fixture();try{
    for(let i=1;i<=6;i++)observe(f.store,f.id,i,i===1?first:i===6?second:undefined);
    const migrations=f.store.events(f.id).filter(e=>e.type==='chatgpt.browser_migrated');
    assert.equal(migrations.length,2);
    const firstPayload=migrations[0]!.payload as {newUrlSha256:string};
    const secondPayload=migrations[1]!.payload as {previousUrlSha256:string};
    assert.equal(secondPayload.previousUrlSha256,firstPayload.newUrlSha256);
    const old=inspectPiEvidence(f.store,f.id);
    assert.equal(old.ledgerConsistent,true);
    const forged={...secondPayload,previousUrlSha256:sha('a different, unrelated browser conversation')};
    assert.notEqual(forged.previousUrlSha256,firstPayload.newUrlSha256);
    f.store.db.prepare('UPDATE events SET payload_json=? WHERE id=?')
      .run(JSON.stringify(forged),migrations[1]!.id);
    const audit=inspectPiEvidence(f.store,f.id);
    assert.equal(audit.decisionsVerified,6,
      'A valid answer/PI hash cannot justify a migration from an unrelated source tab');
    assert.equal(audit.ledgerConsistent,false);
    assert.ok(audit.violations.includes('migration_source_url_discontinuity'));
  }finally{f.cleanup();}
});

test('PI ledger also verifies source URL continuity for an independently recovered new-chat answer',()=>{
  const f=fixture();try{
    observe(f.store,f.id,1,first);
    const answer='Previously ambiguous new chat, later independently inspected';
    const request='recovered-next-chat',promptSha=sha('new chat request');
    f.store.reserveChatBrowserTurn(f.id,f.store.get(f.id).version,request,
      promptSha,{newConversation:true});
    f.store.finishChatBrowserTurn(f.id,request,{kind:'uncertain',error:'Chrome observer unavailable'});
    f.store.recoverObservedBrowserRollover(f.id,f.store.get(f.id).version,{
      requestPromptSha256:promptSha,newChatUrl:second,
      assistantSha256:sha(answer),summary:answer});
    f.store.commitPiPlan(f.id,sha(answer),[],{
      action:'NEXT',summary:'The observed response is attributable',nextPrompt:'Continue'});
    assert.equal(inspectPiEvidence(f.store,f.id).ledgerConsistent,true);
    const recovered=f.store.events(f.id).find(e=>e.type==='chatgpt.browser_rollover_recovered')!;
    f.store.db.prepare('UPDATE events SET payload_json=? WHERE id=?')
      .run(JSON.stringify({...recovered.payload as object,
        previousUrlSha256:sha('another unrelated old conversation')}),recovered.id);
    const report=inspectPiEvidence(f.store,f.id);
    assert.equal(report.decisionsVerified,2);
    assert.equal(report.ledgerConsistent,false);
    assert.ok(report.violations.includes('migration_source_url_discontinuity'));
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

test('invalid Chrome Target identity in an existing migration is an audit violation',()=>{
  const f=fixture();try{
    observe(f.store,f.id,1,first);
    const migrated=f.store.events(f.id).find(e=>e.type==='chatgpt.browser_migrated')!;
    f.store.db.prepare('UPDATE events SET payload_json=? WHERE id=?')
      .run(JSON.stringify({...migrated.payload,newTabTargetSha256:'unsafe target id'}),migrated.id);
    const report=inspectPiEvidence(f.store,f.id);
    assert.equal(report.ledgerConsistent,false);
    assert.ok(report.violations.includes('invalid_migration_target_sha256'));
    assert.equal(report.tabRetirementReceipts.length,0);
  }finally{f.cleanup();}
});

test('PI diagnostic database opens strictly read-only and refuses state mutation or missing state creation',()=>{
  const f=fixture();try{
    const baseline=f.store.maxEventId();
    const reader=new Store(join(f.dir,'missions.sqlite'),{readOnly:true});
    try{
      assert.equal(inspectPiEvidence(reader,f.id).ledgerConsistent,true);
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
