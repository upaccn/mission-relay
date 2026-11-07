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

test('owned-tab close receipts require a prior Relay-created chat and are independently audited',()=>{
  const f=fixture();try{
    for(let i=1;i<=6;i++)observe(f.store,f.id,i,i===1?first:i===6?second:undefined);
    assert.throws(()=>f.store.recordOwnedChatTabRetired(f.id,source,second),
      /previously Relay-created/,'Never certify closure of an owner-linked anchor');
    f.store.recordOwnedChatTabRetired(f.id,first,second);
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

test('independent latest-answer attribution correction preserves old events, never credits a Send and requires fresh PI review',()=>{
  const f=fixture();try{
    observe(f.store,f.id,1,first);
    const reused='Private code result for stage 1\n[MISSION_RELAY:NEXT]';
    const incorrectSha=sha(reused);
    f.store.reserveChatBrowserTurn(f.id,f.store.get(f.id).version,'round-2',sha('private prompt 2'));
    f.store.finishChatBrowserTurn(f.id,'round-2',{kind:'observed',
      assistantSha256:incorrectSha,summary:reused});
    f.store.commitPiPlan(f.id,incorrectSha,[],{
      action:'NEXT',summary:'PI was fooled by stale reply',nextPrompt:'Continue from false checkpoint',
    });
    const original=f.store.events(f.id),originalCount=original.length;
    const suspected=inspectPiEvidence(f.store,f.id);
    assert.deepEqual(suspected.repeatedAnswerCandidates,[2]);
    assert.equal(suspected.ledgerConsistent,true); // SHA equality alone cannot prove attribution.
    const complete='Actual second stage content with different evidence\n[MISSION_RELAY:NEXT]';
    const corrected=f.store.correctPiBrowserAttribution(f.id,f.store.get(f.id).version,{
      requestPromptSha256:sha('private prompt 2'),assistantSha256:sha(complete),summary:complete,
    });
    assert.equal(corrected.turnCount,2);
    assert.equal(f.store.chatBrowserTurn(f.id)?.status,'reconciled');
    assert.equal(f.store.hasVerifiedPiBrowserCheckpoint(f.id),true);
    assert.deepEqual(f.store.events(f.id).slice(0,originalCount),original);
    assert.equal(f.store.events(f.id).filter(e=>e.type==='chatgpt.browser_reserved').length,2);
    assert.equal(f.store.events(f.id).filter(e=>e.type==='chatgpt.browser_observed').length,2);
    const pending=inspectPiEvidence(f.store,f.id);
    assert.equal(pending.ledgerConsistent,false);
    assert.deepEqual(pending.attributionCorrections,[2]);
    assert.deepEqual(pending.pendingPiReviewRounds,[2]);
    assert.equal(pending.decisionsVerified,1);
    assert.ok(pending.violations.includes('corrected_answer_awaits_pi_review'));
    assert.equal(pending.rounds[1]?.originalAnswerSha256,incorrectSha);
    assert.throws(()=>f.store.reserveChatBrowserTurn(f.id,corrected.version,'third',sha('third')),
      /PI must re-review corrected browser answer/);
    // Even a later generic error-clear operation must not bypass the atomic
    // corrected PI decision boundary or submit a browser Send.
    const cleared=f.store.update(f.id,corrected.version,{lastError:null},
      'test.error_clear_does_not_authorize_send');
    assert.throws(()=>f.store.reserveChatBrowserTurn(f.id,cleared.version,'third',sha('third')),
      /matching new PI decision/);
    assert.throws(()=>f.store.correctPiBrowserAttribution(f.id,corrected.version,{
      requestPromptSha256:sha('private prompt 2'),assistantSha256:sha('another'),summary:'another',
    }),/fully observed|already corrected/);
    assert.throws(()=>f.store.commitPiPlan(f.id,incorrectSha,[],{
      action:'NEXT',summary:'Invalid replayed review',nextPrompt:'Continue',
    },true),/fully observed/);
    f.store.commitPiPlan(f.id,sha(complete),[],{
      action:'NEXT',summary:'Now reviewed the independently corrected answer',nextPrompt:'Continue verified work',
    },true);
    const accepted=inspectPiEvidence(f.store,f.id);
    assert.equal(accepted.ledgerConsistent,true);
    assert.deepEqual(accepted.violations,[]);
    assert.equal(accepted.decisionsVerified,2);
    assert.equal(accepted.observedTurns,2);
    assert.equal(accepted.rounds[1]?.answerSha256,sha(complete));
    assert.equal(accepted.rounds[1]?.originalAnswerSha256,incorrectSha);
    assert.equal(f.store.get(f.id).lastError,null);
    assert.equal(f.store.events(f.id).filter(e=>e.type==='pi.decision_attribution_corrected').length,1);
    assert.equal(f.store.events(f.id).filter(e=>e.type==='pi.decision').length,2);
    const printed=JSON.stringify(accepted);
    for(const secret of ['Private code result','private prompt','round-2','chatgpt.com'])
      assert.ok(!printed.includes(secret));
  }finally{f.cleanup();}
});

test('corrected PI checkpoint stays consistent while its authorized NEXT is reserved, but not for an unlinked receipt',()=>{
  const f=fixture();try{
    observe(f.store,f.id,1,first);
    const original=sha('Private code result for stage 1\n[MISSION_RELAY:NEXT]');
    f.store.correctPiBrowserAttribution(f.id,f.store.get(f.id).version,{
      requestPromptSha256:sha('private prompt 1'),
      assistantSha256:sha('Correct independently re-observed answer\n[MISSION_RELAY:NEXT]'),
      summary:'Correct independently re-observed answer\n[MISSION_RELAY:NEXT]',
    });
    f.store.commitPiPlan(f.id,sha('Correct independently re-observed answer\n[MISSION_RELAY:NEXT]'),[],{
      action:'NEXT',summary:'Verified correction',nextPrompt:'Continue with the next actual Send',
    },true);
    const afterCorrection=inspectPiEvidence(f.store,f.id);
    assert.equal(afterCorrection.ledgerConsistent,true);
    assert.equal(afterCorrection.rounds[0]?.originalAnswerSha256,original);
    const request='after-corrected-next';
    f.store.reserveChatBrowserTurn(f.id,f.store.get(f.id).version,request,sha('next real prompt'));
    const pending=inspectPiEvidence(f.store,f.id);
    assert.equal(pending.pendingBrowserRequest,true);
    assert.equal(pending.observedTurns,1,'A reservation is not an observed answer');
    assert.equal(pending.decisionsVerified,1);
    assert.deepEqual(pending.violations,[],
      'The active NEXT reservation legitimately replaces the prior corrected receipt');
    const key=`chatgpt.browser.active.${f.id}`;
    const originalReceipt=f.store.getMeta(key)!;
    f.store.setMeta(key,JSON.stringify({...JSON.parse(originalReceipt),requestKey:'unlinked-request'}));
    const forged=inspectPiEvidence(f.store,f.id);
    assert.equal(forged.ledgerConsistent,false);
    assert.ok(forged.violations.includes('corrected_active_browser_receipt_mismatch'));
    f.store.setMeta(key,originalReceipt);
    const response='Actual third-round answer\n[MISSION_RELAY:NEXT]';
    f.store.finishChatBrowserTurn(f.id,request,{kind:'observed',
      assistantSha256:sha(response),summary:response});
    const nextUnreviewed=inspectPiEvidence(f.store,f.id);
    assert.equal(nextUnreviewed.observedTurns,2);
    assert.deepEqual(nextUnreviewed.pendingPiReviewRounds,[2]);
    assert.ok(!nextUnreviewed.violations.includes('corrected_active_browser_receipt_mismatch'));
  }finally{f.cleanup();}
});

test('attribution correction rejects forged original reservation and PI history before mutation',()=>{
  for(const sabotage of ['changed-reservation-prompt','duplicate-reservation','changed-original-pi-hash'] as const){
    const f=fixture();try{
      observe(f.store,f.id,1,first);
      const old='Private code result for stage 1\n[MISSION_RELAY:NEXT]';
      f.store.reserveChatBrowserTurn(f.id,f.store.get(f.id).version,'round-2',
        sha('private prompt 2'));
      f.store.finishChatBrowserTurn(f.id,'round-2',{
        kind:'observed',assistantSha256:sha(old),summary:old,
      });
      f.store.commitPiPlan(f.id,sha(old),[],{
        action:'NEXT',summary:'Old wrong attribution',nextPrompt:'Continue',
      });
      const reservation=f.store.events(f.id).find(e=>e.type==='chatgpt.browser_reserved'&&
        (e.payload as {requestKey?:string}).requestKey==='round-2')!;
      const decision=f.store.events(f.id).find(e=>e.type==='pi.decision'&&
        (e.payload as {round?:number}).round===2)!;
      if(sabotage==='changed-reservation-prompt'){
        f.store.db.prepare('UPDATE events SET payload_json=? WHERE id=?').run(
          JSON.stringify({...reservation.payload,promptSha256:sha('forged other user prompt')}),
          reservation.id);
      }else if(sabotage==='duplicate-reservation'){
        f.store.db.prepare('INSERT INTO events(mission_id,created_at,type,payload_json) VALUES(?,?,?,?)')
          .run(f.id,new Date().toISOString(),reservation.type,JSON.stringify(reservation.payload));
      }else{
        f.store.db.prepare('UPDATE events SET payload_json=? WHERE id=?').run(
          JSON.stringify({...decision.payload,responseSha256:sha('forged decision')}),
          decision.id);
      }
      const oldEvents=f.store.events(f.id),oldRevision=f.store.get(f.id).version;
      const oldReceipt=f.store.chatBrowserTurn(f.id);
      const actual='Actual full second answer\n[MISSION_RELAY:NEXT]';
      assert.throws(()=>f.store.correctPiBrowserAttribution(f.id,oldRevision,{
        requestPromptSha256:sha('private prompt 2'),
        assistantSha256:sha(actual),summary:actual,
      }),/Original reservation, observation and PI decision cannot be independently linked/,
      sabotage);
      assert.equal(f.store.get(f.id).version,oldRevision,sabotage);
      assert.deepEqual(f.store.chatBrowserTurn(f.id),oldReceipt,sabotage);
      assert.deepEqual(f.store.events(f.id),oldEvents,sabotage);
      assert.equal(f.store.events(f.id).filter(e=>
        e.type==='chatgpt.browser_attribution_corrected').length,0,sabotage);
    }finally{f.cleanup();}
  }
});

test('PI evidence rejects forged attribution corrections without inventing a corrected turn',()=>{
  const f=fixture();try{
    observe(f.store,f.id,1,first);
    const before=inspectPiEvidence(f.store,f.id);
    assert.equal(before.ledgerConsistent,true);
    const event=f.store.events(f.id).find(e=>e.type==='chatgpt.browser_observed')!;
    f.store.db.prepare('INSERT INTO events(mission_id,created_at,type,payload_json) VALUES(?,?,?,?)')
      .run(f.id,new Date().toISOString(),'chatgpt.browser_attribution_corrected',
        JSON.stringify({round:1,requestKey:'forged',observedEventId:event.id,
          decisionEventId:event.id+1,originalAssistantSha256:(event.payload as {assistantSha256:string}).assistantSha256,
          assistantSha256:sha('forged answer'),promptSha256:sha('forged prompt'),independentlyInspected:true}));
    const result=inspectPiEvidence(f.store,f.id);
    assert.equal(result.ledgerConsistent,false);
    assert.ok(result.violations.includes('invalid_attribution_correction'));
    assert.deepEqual(result.attributionCorrections,[]);
    assert.equal(result.observedTurns,1);
  }finally{f.cleanup();}
});

test('corrected PI round independently supersedes earlier owner-directed revisions without deleting them',()=>{
  const f=fixture();try{
    observe(f.store,f.id,1,first);
    const original=sha('Private code result for stage 1\n[MISSION_RELAY:NEXT]');
    f.store.queuePiOwnerDirective(f.id,'445','Change the review priority');
    const pending=f.store.pendingPiOwnerDirectives(f.id);
    f.store.commitPiPlan(f.id,original,[pending[0]!.id],{
      action:'NEXT',summary:'Original PI decision revised for owner notes',nextPrompt:'New priority',
    },true);
    const actual='Stable corrected answer after owner priorities\n[MISSION_RELAY:NEXT]';
    f.store.correctPiBrowserAttribution(f.id,f.store.get(f.id).version,{
      requestPromptSha256:sha('private prompt 1'),assistantSha256:sha(actual),summary:actual,
    });
    const pendingReview=inspectPiEvidence(f.store,f.id);
    assert.ok(pendingReview.violations.includes('corrected_answer_awaits_pi_review'));
    f.store.commitPiPlan(f.id,sha(actual),[],{
      action:'NEXT',summary:'New PI review of actual latest answer',nextPrompt:'Proceed with real evidence',
    },true);
    const report=inspectPiEvidence(f.store,f.id);
    assert.equal(report.ledgerConsistent,true);
    assert.equal(report.decisionsVerified,1);
    assert.equal(report.observedTurns,1);
    assert.deepEqual(report.attributionCorrections,[1]);
    assert.deepEqual(f.store.events(f.id).filter(e=>e.type.startsWith('pi.decision')).map(e=>e.type),
      ['pi.decision','pi.decision_revised','pi.decision_attribution_corrected']);
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
      assistantSha256:sha(answer),summary:answer,...migration,
      ...(migration.newChatUrl?{newChatTargetSha256:sha(`parent-target-${round}`)}:{})});
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

test('32-to-1 successor closes only a proven Relay-created predecessor, with a linked immutable receipt',()=>{
  const f=fixture();try{
    const {parentId,childId}=createVerifiedSuccessor(f.store);
    const priorUrl=f.store.chatLink(parentId)!;
    const fingerprint=sha('parent-target-31');
    assert.notEqual(priorUrl,source,'Parent is no longer the owner-linked anchor');
    assert.equal(f.store.canRetirePiChainSourceTab(childId,priorUrl,second,fingerprint),false,
      'Never close a parent tab before its successor answer has committed');
    const request='verified-child-new-tab';
    f.store.reserveChatBrowserTurn(childId,f.store.get(childId).version,request,
      sha('Child continued task'),{newConversation:true});
    f.store.finishChatBrowserTurn(childId,request,{kind:'observed',
      assistantSha256:sha('Child full reply'),summary:'Child full reply',
      newChatUrl:second});
    assert.equal(f.store.canRetirePiChainSourceTab(childId,source,second,fingerprint),false,
      'Original human anchor is not an owned predecessor page');
    assert.equal(f.store.canRetirePiChainSourceTab(childId,priorUrl,second,sha('different physical tab')),false,
      'Same URL in a different physical Chrome tab must not authorize deletion');
    assert.equal(f.store.canRetirePiChainSourceTab(childId,priorUrl,second,null),false,
      'An unsupported CDP identity cannot be treated as confirmed ownership');
    assert.equal(f.store.canRetirePiChainSourceTab(childId,priorUrl,second,fingerprint),true);
    f.store.recordPiChainSourceTabRetired(childId,priorUrl,second,fingerprint);
    assert.throws(()=>f.store.recordPiChainSourceTabRetired(childId,priorUrl,second,fingerprint),
      /provenance was not verified/,'Do not mint duplicate physical-close receipts');
    const report=inspectPiChainEvidence(f.store,childId);
    assert.equal(report.chainConsistent,true,report.violations.join(','));
    const one=report.missions[1]!.tabRetirementReceipts;
    assert.equal(one.length,1);
    assert.equal(one[0]!.parentId,parentId);
    assert.equal(one[0]!.retiredUrlSha256,sha(priorUrl));
    assert.equal(one[0]!.sourceTabTargetSha256,fingerprint);
    assert.equal(one[0]!.activeUrlSha256,sha(second));
    assert.equal(JSON.stringify(report).includes('chatgpt.com'),false);
    const receipt=f.store.events(childId).find(e=>e.type==='chatgpt.browser_tab_retired')!;
    const tampered={...(receipt.payload as object),parentMigrationEventId:987654};
    f.store.db.prepare('UPDATE events SET payload_json=? WHERE id=?')
      .run(JSON.stringify(tampered),receipt.id);
    const invalid=inspectPiChainEvidence(f.store,childId);
    assert.equal(invalid.chainConsistent,false);
    assert.ok(invalid.violations.includes('mission_event_ledger_inconsistent'));
    assert.ok(invalid.missions[1]!.violations.includes('invalid_browser_tab_retirement'));
  }finally{f.cleanup();}
});

test('32-to-1 predecessor tab is never retired while an unrelated Mission also claims the source',()=>{
  const f=fixture();try{
    const {parentId,childId}=createVerifiedSuccessor(f.store);
    const shared=f.store.chatLink(parentId)!;
    const fingerprint=sha('parent-target-31');
    f.store.reserveChatBrowserTurn(childId,f.store.get(childId).version,
      'valid-child-first',sha('Child new Chat'),{newConversation:true});
    f.store.finishChatBrowserTurn(childId,'valid-child-first',{kind:'observed',
      assistantSha256:sha('Child first answer'),summary:'Child first answer',
      newChatUrl:second});
    assert.equal(f.store.canRetirePiChainSourceTab(childId,shared,second,fingerprint),true);
    const unrelated=f.store.create({goal:'Separate human-owned investigation',
      acceptance:['Keep original conversation'],workspace:'',sandbox:'read-only',
      mode:'supervised',maxTurns:1,checks:[],requestKey:'shared-human-link'});
    f.store.linkChat(unrelated.id,shared,unrelated.version);
    assert.equal(f.store.canRetirePiChainSourceTab(childId,shared,second,fingerprint),false);
    assert.throws(()=>f.store.recordPiChainSourceTabRetired(childId,shared,second,fingerprint),
      /provenance was not verified/);
    assert.equal(f.store.events(childId).filter(e=>e.type==='chatgpt.browser_tab_retired').length,0);
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
