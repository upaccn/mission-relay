import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/core/store.js';
import {assessPendingBrowserAnswer} from '../src/core/browser-pending-evidence.js';
import type {ChatPageSnapshot} from '../src/plugins/chatgpt-browser.js';

const sha=(x:string)=>createHash('sha256').update(x).digest('hex');
const missionId='123e4567-e89b-42d3-a456-426614174322';
const url='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174323';
const previous='Previous round complete\n[MISSION_RELAY:NEXT]';
const current='New audited answer\n[MISSION_RELAY:NEXT]';
const snapshot=(answer:string,change:Partial<ChatPageSnapshot>={}):ChatPageSnapshot=>({
  url,assistantCount:2,userCount:2,composerReady:true,generating:false,
  lastAssistant:answer,lastAssistantTurnId:'new-turn',...change,
});
const input={
  missionId,round:9,reservationEventId:357,
  reservationPromptSha256:sha('unique private prompt'),
  latestUserSha256:sha('unique private prompt'),
  lastObservedAnswerSha256:sha(previous),
  first:snapshot(current),second:snapshot(current),
};

test('a matching stable marked but uncommitted answer is only a content-free candidate',()=>{
  const report=assessPendingBrowserAnswer(input);
  assert.equal(report.originalPromptMatches,true);
  assert.equal(report.stableMarkedReplyCandidate,true);
  assert.equal(report.priorAnswerRepeated,false);
  assert.equal(report.assistantCandidateSha256,sha(current));
  assert.equal(report.sendOrRecoveryAuthorized,false);
  assert.equal(report.receiptMutationPerformed,false);
  assert.match(report.note,/still pending/);
  const printed=JSON.stringify(report);
  for(const privateText of ['unique private prompt',current,url,'requestKey'])
    assert.equal(printed.includes(privateText),false);
});

test('prior assistant rerender, changed prompt, generating response and unstable DOM never count',()=>{
  const cases=[
    {...input,first:snapshot(previous),second:snapshot(previous)},
    {...input,latestUserSha256:sha('different turn')},
    {...input,latestUserSha256:null},
    {...input,lastObservedAnswerSha256:null},
    {...input,lastObservedAnswerSha256:'invalid previous digest'},
    {...input,first:snapshot(current,{generating:true})},
    {...input,second:snapshot(current,{composerReady:false})},
    {...input,first:snapshot(current,{lastAssistantTurnId:'first'}),
      second:snapshot(current,{lastAssistantTurnId:'other'})},
    {...input,first:snapshot(current),second:snapshot('Incomplete answer')},
    {...input,first:snapshot('Incomplete answer'),second:snapshot('Incomplete answer')},
    {...input,second:snapshot(current,{url:'https://chatgpt.com/c/other'})},
  ];
  for(const item of cases){
    const result=assessPendingBrowserAnswer(item);
    assert.equal(result.stableMarkedReplyCandidate,false);
    assert.equal(result.assistantCandidateSha256,null);
    assert.equal(result.sendOrRecoveryAuthorized,false);
  }
  assert.equal(assessPendingBrowserAnswer(cases[0]!).priorAnswerRepeated,true,
    'Do not confuse a persistent old assistant with completion of the newest Send');
});

test('pending-readback CLI opens SQLite read-only and refuses absent pending reservation before Chrome',()=>{
  const dir=mkdtempSync(join(tmpdir(),'mr-pending-evidence-'));
  const store=new Store(join(dir,'missions.sqlite'));
  try{
    const m=store.create({goal:'Read-only browser incident',acceptance:['Check attribution'],
      workspace:'',sandbox:'read-only',mode:'supervised',maxTurns:10,
      requestKey:'pending-evidence-test',checks:[]});
    const linked=store.linkChat(m.id,url,m.version).mission;
    const bound=store.bindChatBrowser(m.id,'install:Chrome:synthetic',linked.version).mission;
    const before=store.maxEventId();
    const result=spawnSync(process.execPath,
      ['--import','tsx','src/cli.ts','browser-pending-evidence',m.id],
      {cwd:process.cwd(),env:{...process.env,MISSION_RELAY_HOME:dir},
       encoding:'utf8',timeout:12000});
    assert.equal(result.status,1);
    assert.match(result.stderr,/No single linked, original-conversation pending Send/);
    assert.equal(store.maxEventId(),before);
    assert.equal(store.get(m.id).turnCount,0);
    // A first Send planned for a *new* Chat may not be diagnosed against the
    // still-linked source conversation. Refuse before any Chrome connection.
    store.reserveChatBrowserTurn(m.id,bound.version,'new-tab-original',sha('new first prompt'),
      {newConversation:true});
    const reservedEvents=store.maxEventId();
    const forbidden=spawnSync(process.execPath,
      ['--import','tsx','src/cli.ts','browser-pending-evidence',m.id],
      {cwd:process.cwd(),env:{...process.env,MISSION_RELAY_HOME:dir},
       encoding:'utf8',timeout:12000});
    assert.equal(forbidden.status,1);
    assert.match(forbidden.stderr,/No single linked, original-conversation pending Send/);
    assert.equal(store.maxEventId(),reservedEvents);
    assert.equal(store.chatBrowserTurn(m.id)?.status,'reserved');
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
