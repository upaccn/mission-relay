import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/core/store.js';
import { Engine } from '../src/core/engine.js';
import { normalizeChatGPTUrl, renderChatGPTHandoff } from '../src/core/chatgpt-handoff.js';
import type { AgentAdapter, TurnInput, Decision, Mission, Verification } from '../src/core/types.js';

const CHAT='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174000';
class NeverExecute implements AgentAdapter {
  calls=0;
  async execute(_input:TurnInput):Promise<Decision> {
    this.calls++;
    throw new Error('Codex must not be dispatched');
  }
  async verify(_mission:Mission,_decision:Decision):Promise<Verification> {
    throw new Error('Verifier must not be dispatched');
  }
}
function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'relay-chat-handoff-'));
  const store=new Store(join(dir,'missions.sqlite'));
  const agent=new NeverExecute();
  const engine=new Engine(store,agent);
  const mission=engine.create({goal:'Review an existing ChatGPT task',acceptance:['Evidence-backed review'],
    workspace:dir,sandbox:'read-only',mode:'supervised',maxTurns:3,requestKey:'existing-chat'});
  return {dir,store,engine,agent,mission,cleanup:()=>{store.close();rmSync(dir,{recursive:true,force:true});}};
}

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

test('Link persists across restarts and never dispatches Codex or asserts completion',()=>{
  const f=fixture();try{
    const linked=f.store.linkChat(f.mission.id,CHAT,f.mission.version);
    assert.equal(linked.mission.version,f.mission.version+1);
    assert.equal(linked.mission.state,'READY');
    assert.equal(f.store.chatLink(f.mission.id),CHAT);
    assert.equal(f.store.linkChat(f.mission.id,CHAT,linked.mission.version).mission.version,linked.mission.version);
    assert.throws(()=>f.engine.run(f.mission.id),/external ChatGPT conversation/);
    assert.equal(f.agent.calls,0);
    assert.match(renderChatGPTHandoff(linked.mission,CHAT),/send MANUALLY/);
    assert.equal(f.store.events(f.mission.id).filter(e=>e.type==='chatgpt.handoff_linked').length,1);
    f.store.close();
    const reopened=new Store(join(f.dir,'missions.sqlite'));
    assert.equal(reopened.chatLink(f.mission.id),CHAT);
    assert.equal(reopened.get(f.mission.id).state,'READY');
    reopened.close();
  }finally{
    // already closed by the test to simulate process restart
    rmSync(f.dir,{recursive:true,force:true});
  }
});

test('Linking requires the current revision and never rewrites active or ambiguous missions',()=>{
  const f=fixture();try{
    f.engine.instruct(f.mission.id,'Revision advanced');
    assert.throws(()=>f.store.linkChat(f.mission.id,CHAT,f.mission.version),/State conflict/);
    const active=f.store.acquire(f.mission.id);
    assert.throws(()=>f.store.linkChat(f.mission.id,CHAT,active.version),/Cannot link ChatGPT/);
    assert.equal(f.store.chatLink(f.mission.id),null);
  }finally{f.cleanup();}
});

test('Terminal missions cannot be repurposed as new ChatGPT work',()=>{
  const f=fixture();try{
    const cancelled=f.engine.cancel(f.mission.id);
    assert.throws(()=>f.store.linkChat(f.mission.id,CHAT,cancelled.version),/inactive unfinished mission/);
    assert.equal(f.store.chatLink(f.mission.id),null);
  }finally{f.cleanup();}
});

test('ChatGPT-first CLI creates and repeats a linked mission without a Codex workspace',()=>{
  const dir=mkdtempSync(join(tmpdir(),'relay-chat-cli-'));
  const env={...process.env,MISSION_RELAY_HOME:join(dir,'state')};
  const command=['--import','tsx','src/cli.ts','chat-create','--goal','Research next step',
    '--accept','Source-backed evidence','--url',CHAT,'--request-key','chat-first-key'];
  try{
    const one=JSON.parse(execFileSync(process.execPath,command,
      {cwd:process.cwd(),env,encoding:'utf8'})) as {mission:Mission;url:string};
    assert.equal(one.mission.workspace,'');
    assert.equal(one.mission.state,'READY');
    assert.equal(one.mission.version,1);
    assert.equal(one.url,CHAT);
    const again=JSON.parse(execFileSync(process.execPath,command,
      {cwd:process.cwd(),env,encoding:'utf8'})) as {mission:Mission;url:string};
    assert.equal(again.mission.id,one.mission.id);
    assert.equal(again.mission.version,1);
    const handoff=execFileSync(process.execPath,['--import','tsx','src/cli.ts','handoff',one.mission.id],
      {cwd:process.cwd(),env,encoding:'utf8'});
    assert.match(handoff,/MANUALLY/);
    assert.match(handoff,/chatgpt.com\/c\//);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('CLI read and browser dispatch refuse unpinned profile without touching Playwriter',()=>{
  const dir=mkdtempSync(join(tmpdir(),'relay-chat-pin-cli-'));
  const env={...process.env,MISSION_RELAY_HOME:join(dir,'state')};
  try {
    const args=['--import','tsx','src/cli.ts','chat-create','--goal','Safe profile pin',
      '--accept','Exact authorized tab','--url',CHAT,'--request-key','profile-pin-test'];
    const created=JSON.parse(execFileSync(process.execPath,args,
      {cwd:process.cwd(),env,encoding:'utf8'})) as {mission:Mission};
    for(const command of ['browser-probe','browser-drive']) {
      const commandArgs=['--import','tsx','src/cli.ts',command,created.mission.id,
        ...(command==='browser-drive'?['--revision','1','--request-prefix','never-dispatch']:[])];
      assert.throws(()=>execFileSync(process.execPath,commandArgs,
        {cwd:process.cwd(),env,encoding:'utf8',stdio:['ignore','pipe','pipe']}),
        /Pin this ChatGPT Mission/);
    }
    const db=new Store(join(dir,'state','missions.sqlite'));
    try {
      assert.equal(db.get(created.mission.id).state,'READY');
      assert.equal(db.get(created.mission.id).version,1);
      assert.equal(db.events(created.mission.id).filter(e=>e.type==='chatgpt.browser_reserved').length,0);
    }finally{db.close();}
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('CLI rejects split generic recovery and atomically reconciles the interrupted browser turn',()=>{
  const dir=mkdtempSync(join(tmpdir(),'relay-browser-reconcile-cli-'));
  const env={...process.env,MISSION_RELAY_HOME:join(dir,'state')};
  const db=new Store(join(dir,'state','missions.sqlite'));
  try {
    const base=db.create({goal:'Synthetic recovery',acceptance:['No duplicate browser send'],
      workspace:'',sandbox:'read-only',mode:'supervised',maxTurns:2,requestKey:'synthetic-recovery'});
    const linked=db.linkChat(base.id,CHAT,base.version).mission;
    db.reserveChatBrowserTurn(linked.id,linked.version,'synthetic-once','a'.repeat(64));
    const uncertain=db.finishChatBrowserTurn(linked.id,'synthetic-once',
      {kind:'uncertain',error:'Simulated relay disconnection'});
    db.close();
    const invoke=(command:string)=>execFileSync(process.execPath,
      ['--import','tsx','src/cli.ts',command,linked.id,'--acknowledge-side-effects'],
      {cwd:process.cwd(),env,encoding:'utf8',stdio:['ignore','pipe','pipe']});
    assert.throws(()=>invoke('reconcile'),/browser-reconcile/);
    const inspect=new Store(join(dir,'state','missions.sqlite'));
    try {
      assert.equal(inspect.get(linked.id).state,'NEEDS_RECONCILIATION');
      assert.equal(inspect.get(linked.id).version,uncertain.version);
      assert.equal(inspect.events(linked.id).filter(x=>x.type==='mission.reconciled').length,0);
    }finally{inspect.close();}
    const result=JSON.parse(invoke('browser-reconcile')) as Mission;
    assert.equal(result.state,'PAUSED');
    assert.equal(result.version,uncertain.version+1);
    const reopened=new Store(join(dir,'state','missions.sqlite'));
    try {
      assert.equal(reopened.chatBrowserTurn(linked.id)?.status,'reconciled');
      assert.equal(reopened.events(linked.id).filter(x=>x.type==='mission.reconciled').length,1);
      assert.equal(reopened.events(linked.id).filter(x=>x.type==='chatgpt.browser_reconciled').length,1);
      assert.throws(()=>reopened.reserveChatBrowserTurn(linked.id,result.version,'synthetic-once','a'.repeat(64)),
        /already used/);
    }finally{reopened.close();}
  }finally{rmSync(dir,{recursive:true,force:true});}
});
