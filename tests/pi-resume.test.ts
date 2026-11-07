import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Engine} from '../src/core/engine.js';
import {Store} from '../src/core/store.js';
import type {AgentAdapter} from '../src/core/types.js';

const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const URL='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174000';
const answer='Complete paused in-flight response\n[MISSION_RELAY:NEXT]';
const never:AgentAdapter={
  async execute(){throw new Error('Native agent must not dispatch a browser Mission');},
  async verify(){throw new Error('Native verifier must not dispatch a browser Mission');},
};
function fixture(write=false){
  const dir=mkdtempSync(join(tmpdir(),'relay-pi-resume-'));
  const workspace=write?'/srv/ai/workspace/projects/mission-relay':'';
  const store=new Store(join(dir,'missions.sqlite'));
  const initial=store.create({goal:'Continue after cooperative maintenance',
    acceptance:['Preserve the original Send'],sandbox:write?'workspace-write':'read-only',
    workspace,mode:'supervised',maxTurns:32,checks:[],requestKey:'pi-resume-test'});
  const linked=store.linkChat(initial.id,URL,initial.version).mission;
  const bound=store.bindChatBrowser(initial.id,'install:Chrome:synthetic',linked.version).mission;
  store.setMeta(`pi.autopilot.enabled.${bound.id}`,'1');
  if(write){
    store.setMeta('telegram.build.project',workspace);
    store.setMeta('telegram.pi.project',workspace);
  }
  const engine=new Engine(store,never);
  store.reserveChatBrowserTurn(bound.id,bound.version,'original-1',sha('Original submitted prompt'));
  return {dir,store,engine,id:bound.id,workspace,
    pause:()=>engine.pause(bound.id),
    finish:()=>store.finishChatBrowserTurn(bound.id,'original-1',{
      kind:'observed',assistantSha256:sha(answer),summary:answer,
      telegramBatch:{terminal:false,flowSignal:'NEXT',piManaged:true},
    }),
    cleanup:()=>{store.close();rmSync(dir,{force:true,recursive:true});}};
}

test('cooperative maintenance pause settles existing original Send then resumes only its PAUSED PI checkpoint',()=>{
  const f=fixture();try{
    const paused=f.pause();
    assert.equal(paused.state,'RUNNING');
    assert.equal(paused.stopRequested,true);
    assert.equal(f.store.chatBrowserTurn(f.id)?.status,'reserved');
    assert.throws(()=>f.store.resumePausedPiCheckpoint(f.id,paused.version),
      /owner-paused, settled, nonterminal/, 'in-flight Send must not be resumed');
    const settled=f.finish();
    assert.equal(settled.state,'PAUSED');
    assert.equal(settled.turnCount,1);
    assert.equal(settled.stopRequested,true);
    assert.equal(f.store.chatBrowserTurn(f.id)?.status,'observed');
    assert.throws(()=>f.engine.resume(f.id,settled.version),
      /PI-owned Mission cannot use generic resume/,
      'native resume cannot strand a PI checkpoint in generic READY');
    const original=f.store.events(f.id);
    const resumed=f.store.resumePausedPiCheckpoint(f.id,settled.version);
    assert.equal(resumed.state,'PAUSED','must never become generic READY');
    assert.equal(resumed.turnCount,1);
    assert.equal(resumed.stopRequested,false);
    assert.equal(f.store.piPlan(f.id),null,'new PI decision must follow independent browser readback');
    const events=f.store.events(f.id);
    assert.deepEqual(events.slice(0,original.length),original);
    assert.equal(events.filter(x=>x.type==='chatgpt.browser_reserved').length,1);
    assert.equal(events.filter(x=>x.type==='chatgpt.browser_observed').length,1);
    assert.equal(events.filter(x=>x.type==='pi.pause_released').length,1);
    assert.equal((events.at(-1)!.payload as {requiresIndependentBrowserReadback?:boolean})
      .requiresIndependentBrowserReadback,true);
    assert.throws(()=>f.store.resumePausedPiCheckpoint(f.id,resumed.version),
      /owner-paused, settled, nonterminal/, 'one pause must produce at most one release');
    assert.throws(()=>f.store.resumePausedPiCheckpoint(f.id,settled.version),
      /State conflict/,'stale revision must not mutate state');
    assert.equal(f.store.events(f.id).length,original.length+1);
  }finally{f.cleanup();}
});

test('local PI resume requires explicit acknowledgement and live revision, without touching Chrome',()=>{
  const f=fixture();try{
    f.pause();
    const settled=f.finish();
    const argv=['--import','tsx','src/cli.ts','pi-resume',f.id,
      '--revision',String(settled.version)];
    const command=(suffix:string[]=[])=>spawnSync(process.execPath,[...argv,...suffix],
      {cwd:process.cwd(),encoding:'utf8',timeout:15000,
        env:{...process.env,MISSION_RELAY_HOME:f.dir}});
    const before=f.store.events(f.id).length;
    const unauthorized=command();
    assert.notEqual(unauthorized.status,0);
    assert.match(unauthorized.stderr,/explicit --acknowledge-side-effects/);
    assert.equal(f.store.events(f.id).length,before);
    const wrongCommand=spawnSync(process.execPath,
      ['--import','tsx','src/cli.ts','resume',f.id],{
        cwd:process.cwd(),encoding:'utf8',timeout:15000,
        env:{...process.env,MISSION_RELAY_HOME:f.dir},
      });
    assert.notEqual(wrongCommand.status,0);
    assert.match(wrongCommand.stderr,/PI-owned Mission cannot use generic resume/);
    assert.equal(f.store.events(f.id).length,before);
    const ok=command(['--acknowledge-side-effects']);
    assert.equal(ok.status,0,ok.stderr);
    const output=JSON.parse(ok.stdout) as {state:string;turnCount:number;stopRequested:boolean};
    assert.equal(output.state,'PAUSED');
    assert.equal(output.turnCount,1);
    assert.equal(output.stopRequested,false);
    assert.equal(f.store.events(f.id).filter(e=>e.type==='pi.pause_released').length,1);
    const repeated=command(['--acknowledge-side-effects']);
    assert.notEqual(repeated.status,0);
    assert.match(repeated.stderr,/State conflict/);
    assert.equal(f.store.chatBrowserTurn(f.id)?.assistantSha256,sha(answer));
  }finally{f.cleanup();}
});

test('PI resume refuses unpaused, terminal, erroneous or revoked-write checkpoints',()=>{
  const normal=fixture();try{
    normal.pause();
    const settled=normal.finish();
    normal.store.update(normal.id,settled.version,{lastError:'Unresolved prior error'},
      'test.source_error');
    assert.throws(()=>normal.store.resumePausedPiCheckpoint(normal.id,
      normal.store.get(normal.id).version),/owner-paused, settled, nonterminal/);
    assert.equal(normal.store.get(normal.id).stopRequested,true);
  }finally{normal.cleanup();}
  const write=fixture(true);try{
    write.pause();
    write.finish();
    write.store.setMeta('telegram.build.project','');
    assert.throws(()=>write.store.resumePausedPiCheckpoint(write.id,
      write.store.get(write.id).version),/approval changed or was revoked/);
    assert.equal(write.store.get(write.id).stopRequested,true);
    assert.equal(write.store.events(write.id).filter(e=>e.type==='pi.pause_released').length,0);
  }finally{write.cleanup();}
  const terminal=fixture();try{
    terminal.finish();
    terminal.store.commitPiPlan(terminal.id,sha(answer),[],{
      action:'DONE',summary:'Verified complete',nextPrompt:'',
    });
    terminal.store.update(terminal.id,terminal.store.get(terminal.id).version,
      {stopRequested:true},'mission.pause_requested');
    assert.throws(()=>terminal.store.resumePausedPiCheckpoint(terminal.id,
      terminal.store.get(terminal.id).version),/owner-paused, settled, nonterminal/);
  }finally{terminal.cleanup();}
});

test('manual acknowledgement of a paused ambiguous Send preserves the owner stop and never invents a credited reply',()=>{
  const f=fixture();try{
    const requested=f.pause();
    assert.equal(requested.stopRequested,true);
    const ambiguous=f.store.finishChatBrowserTurn(f.id,'original-1',{
      kind:'uncertain',error:'Synthetic browser observer lost the original outcome',
    });
    assert.equal(ambiguous.state,'NEEDS_RECONCILIATION');
    assert.equal(ambiguous.stopRequested,true);
    assert.equal(ambiguous.turnCount,0);
    const acknowledged=f.store.reconcileChatBrowserTurn(f.id);
    assert.equal(acknowledged.state,'PAUSED');
    assert.equal(acknowledged.stopRequested,true);
    assert.equal(acknowledged.turnCount,0);
    assert.equal(f.store.chatBrowserTurn(f.id)?.status,'reconciled');
    assert.equal(f.store.hasVerifiedPiBrowserCheckpoint(f.id),false);
    assert.throws(()=>f.store.resumePausedPiCheckpoint(f.id,acknowledged.version),
      /owner-paused, settled, nonterminal/);
    assert.equal(f.store.events(f.id).filter(e=>e.type==='chatgpt.browser_reserved').length,1);
    assert.equal(f.store.events(f.id).filter(e=>e.type==='chatgpt.browser_uncertain').length,1);
    assert.equal(f.store.events(f.id).filter(e=>e.type==='chatgpt.browser_observed').length,0);
  }finally{f.cleanup();}
});
