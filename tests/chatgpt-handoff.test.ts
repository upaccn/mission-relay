import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store } from '../src/core/store.js';
import { normalizeChatGPTUrl } from '../src/core/chatgpt-handoff.js';

const CHAT='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174000';

test('ChatGPT URLs are constrained to direct conversation links, never credentials or arbitrary sites',()=>{
  assert.equal(normalizeChatGPTUrl(CHAT+'/'),CHAT);
  assert.equal(normalizeChatGPTUrl('https://chatgpt.com/g/g-abc/c/123e4567-e89b-42d3-a456-426614174000'),
    'https://chatgpt.com/g/g-abc/c/123e4567-e89b-42d3-a456-426614174000');
  for(const url of [
    'http://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174000',
    'https://chatgpt.com.evil.test/c/123e4567-e89b-42d3-a456-426614174000',
    'https://evil.test/c/123e4567-e89b-42d3-a456-426614174000',
    'https://username:password@chatgpt.com/c/123e4567-e89b-42d3-a456-426614174000',
    CHAT+'?private=true',CHAT+'#secret','https://chatgpt.com/',
  ]) assert.throws(()=>normalizeChatGPTUrl(url),/direct https:\/\/chatgpt.com/);
});

test('a Chat link persists across restarts and requires the current revision',()=>{
  const dir=mkdtempSync(join(tmpdir(),'relay-chat-link-'));
  try{
    const store=new Store(join(dir,'missions.sqlite'));
    const m=store.create({goal:'Review',acceptance:['Evidence'],workspace:'',
      sandbox:'read-only',mode:'supervised',requestKey:'link'});
    const linked=store.linkChat(m.id,CHAT,m.version);
    assert.equal(linked.mission.version,m.version+1);
    assert.equal(store.linkChat(m.id,CHAT,linked.mission.version).mission.version,linked.mission.version);
    assert.throws(()=>store.linkChat(m.id,CHAT.replace('000','001'),m.version),/State conflict/);
    store.close();
    const reopened=new Store(join(dir,'missions.sqlite'));
    assert.equal(reopened.chatLink(m.id),CHAT);
    reopened.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});

function recoverRig(){
  const dir=mkdtempSync(join(tmpdir(),'relay-recover-cli-'));
  const env={...process.env,MISSION_RELAY_HOME:join(dir,'state')};
  const db=new Store(join(dir,'state','missions.sqlite'));
  const base=db.create({goal:'Synthetic recovery',acceptance:['No duplicate browser send'],
    workspace:'',sandbox:'read-only',mode:'supervised',requestKey:'synthetic-recovery'});
  const linked=db.linkChat(base.id,CHAT,base.version).mission;
  const bound=db.bindChatBrowser(base.id,'install:Chrome:synthetic',linked.version).mission;
  db.setMeta(`pi.autopilot.enabled.${base.id}`,'1');
  db.reserveChatBrowserTurn(bound.id,bound.version,'synthetic-recovery-1','a'.repeat(64));
  const uncertain=db.finishChatBrowserTurn(bound.id,'synthetic-recovery-1',
    {kind:'uncertain',error:'Simulated relay disconnection'});
  db.close();
  const cli=(...args:string[])=>spawnSync(process.execPath,
    ['--import','tsx','src/cli.ts','recover',...(args[0]==='--ref'?args.slice(1,2):[base.id]),
      ...(args[0]==='--ref'?args.slice(2):args)],
    {cwd:process.cwd(),env,encoding:'utf8'});
  const open=()=>new Store(join(dir,'state','missions.sqlite'));
  return {id:base.id,revision:uncertain.version,cli,open,
    cleanup:()=>rmSync(dir,{recursive:true,force:true})};
}

test('recover diagnoses an uncertain request read-only and names the next action',()=>{
  const r=recoverRig();try{
    const out=r.cli();
    assert.equal(out.status,0,out.stderr);
    const report=JSON.parse(out.stdout) as {state:string;nextAction:string;request:{status:string}};
    assert.equal(report.state,'NEEDS_RECONCILIATION');
    assert.equal(report.request.status,'uncertain');
    assert.match(report.nextAction,/recover --accept-reply.*recover --abandon/);
    const short=r.cli('--ref',r.id.slice(0,8));
    assert.equal(short.status,0,short.stderr);
    assert.equal((JSON.parse(short.stdout) as {missionId:string}).missionId,r.id,
      'the 8-character prefix shown in Telegram resolves the Mission');
    assert.notEqual(r.cli('--ref','0000000a').status,0);
    const db=r.open();try{
      assert.equal(db.get(r.id).version,r.revision,'diagnosis never mutates SQLite');
    }finally{db.close();}
  }finally{r.cleanup();}
});

test('recover --abandon settles without crediting or resending; stale revisions and mixed modes are refused',()=>{
  const r=recoverRig();try{
    assert.notEqual(r.cli('--abandon','--retry','--revision',String(r.revision)).status,0);
    assert.notEqual(r.cli('--abandon','--revision',String(r.revision+1)).status,0);
    const before=r.open();try{assert.equal(before.get(r.id).version,r.revision);}finally{before.close();}
    const out=r.cli('--abandon','--revision',String(r.revision));
    assert.equal(out.status,0,out.stderr);
    const db=r.open();try{
      const m=db.get(r.id);
      assert.equal(m.state,'CANCELLED');
      assert.equal(m.turnCount,0,'no answer credited');
      assert.equal(db.chatBrowserTurn(r.id)?.status,'reconciled');
      assert.equal(db.events(r.id).filter(e=>e.type==='chatgpt.browser_reserved').length,1,'never resent');
    }finally{db.close();}
    assert.notEqual(r.cli('--abandon','--revision',String(r.revision)).status,0,'second abandon refused');
  }finally{r.cleanup();}
});

test('recover --retry refuses a request whose outcome is unknown, before touching Chrome',()=>{
  const r=recoverRig();try{
    const out=r.cli('--retry','--revision',String(r.revision));
    assert.notEqual(out.status,0);
    assert.match(out.stderr,/settled step/);
  }finally{r.cleanup();}
});
