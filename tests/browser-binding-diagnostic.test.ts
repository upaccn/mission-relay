import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/core/store.js';
import {inspectBrowserBinding} from '../src/core/browser-binding-diagnostic.js';
import type {ChatBrowserTurn} from '../src/core/store.js';

const url='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174000';
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const receipt:ChatBrowserTurn={
  requestKey:'private-request-key',promptSha256:sha('private prompt'),
  urlHash:sha(url),status:'uncertain',createdAt:'2026-11-07T04:07:17.376Z',
  error:'locator.click: Timeout 10000ms exceeded',
};
const base={missionId:'123e4567-e89b-42d3-a456-426614174222',
  missionState:'NEEDS_RECONCILIATION',turnCount:8,
  linkedUrl:url,receipt};

test('disconnected original tab stays explicitly unverified despite another enabled ChatGPT tab',()=>{
  const inspected=inspectBrowserBinding({...base,enabledChatCandidates:[
    {urlSha256:sha(url.replace(/000$/,'001')),lastUserSha256:sha('private prompt')},
  ]});
  assert.equal(inspected.binding,'not_exposed');
  assert.equal(inspected.enabledChatTabs,1);
  assert.equal(inspected.matchingLinkedTabs,0);
  assert.equal(inspected.latestUserMatchesPendingPrompt,null);
  assert.equal(inspected.independentlyVerifiedFinalAnswer,false);
  assert.equal(inspected.sendOrRecoveryAuthorized,false);
  assert.match(inspected.note,/cannot be distinguished/);
  for(const value of [url,'private prompt','private-request-key','locator.click'])
    assert.equal(JSON.stringify(inspected).includes(value),false);
});

test('one exact connected ChatGPT tab exposes only a prompt-hash comparison, never completion',()=>{
  const match={urlSha256:sha(url),lastUserSha256:sha('private prompt')};
  const inspected=inspectBrowserBinding({...base,enabledChatCandidates:[match]});
  assert.equal(inspected.binding,'exact_connected');
  assert.equal(inspected.latestUserMatchesPendingPrompt,true);
  assert.equal(inspected.independentlyVerifiedFinalAnswer,false);
  assert.equal(inspected.sendOrRecoveryAuthorized,false);
  assert.equal(inspectBrowserBinding({...base,enabledChatCandidates:[
    {...match,lastUserSha256:sha('different user message')},
  ]}).latestUserMatchesPendingPrompt,false);
  assert.equal(inspectBrowserBinding({...base,enabledChatCandidates:[
    {...match,lastUserSha256:null},
  ]}).latestUserMatchesPendingPrompt,null);
  assert.equal(inspectBrowserBinding({...base,receipt:{...receipt,status:'observed'},
    enabledChatCandidates:[match]}).latestUserMatchesPendingPrompt,null);
});

test('ambiguous duplicate linked tabs never authorize an original-request recovery',()=>{
  const candidate={urlSha256:sha(url),lastUserSha256:receipt.promptSha256};
  const inspected=inspectBrowserBinding({...base,enabledChatCandidates:[candidate,candidate]});
  assert.equal(inspected.binding,'duplicate_connected');
  assert.equal(inspected.matchingLinkedTabs,2);
  assert.equal(inspected.latestUserMatchesPendingPrompt,null);
  assert.equal(inspected.sendOrRecoveryAuthorized,false);
  const fresh=inspectBrowserBinding({...base,receipt:{...receipt,status:'reserved',
    newConversation:true},enabledChatCandidates:[candidate]});
  assert.equal(fresh.pendingNewConversation,true);
  assert.equal(fresh.independentlyVerifiedFinalAnswer,false,
    'Linked source tab presence is not new conversation destination evidence');
});

test('CLI rejects an unbound Mission before opening Chrome or mutating the local ledger',()=>{
  const dir=mkdtempSync(join(tmpdir(),'mr-binding-diagnostic-'));
  const store=new Store(join(dir,'missions.sqlite'));
  try{
    const m=store.create({goal:'Verify a disconnected browser without sending',
      acceptance:['Read-only'],workspace:'',sandbox:'read-only',
      mode:'supervised',maxTurns:2,requestKey:'binding-diag-test',checks:[]});
    const old=store.maxEventId();
    const run=spawnSync(process.execPath,
      ['--import','tsx','src/cli.ts','browser-binding-health',m.id],
      {cwd:process.cwd(),env:{...process.env,MISSION_RELAY_HOME:dir},
        encoding:'utf8',timeout:15000});
    assert.equal(run.status,1);
    assert.match(run.stderr,/no existing linked ChatGPT URL and approved Chrome binding/);
    assert.equal(store.maxEventId(),old);
    assert.equal(store.get(m.id).turnCount,0);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
