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
const NEXT_URL='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174001';
const answer='Complete paused in-flight response\n[MISSION_RELAY:NEXT]';
const never:AgentAdapter={
  async execute(){throw new Error('Native agent must not dispatch a browser Mission');},
  async verify(){throw new Error('Native verifier must not dispatch a browser Mission');},
};
function fixture(write=false,newConversation=false){
  const dir=mkdtempSync(join(tmpdir(),'relay-pi-resume-'));
  const workspace=write?'/srv/projects/mission-relay':'';
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
  store.reserveChatBrowserTurn(bound.id,bound.version,'original-1',
    sha('Original submitted prompt'),{newConversation});
  return {dir,store,engine,id:bound.id,workspace,
    pause:()=>engine.pause(bound.id),
    finish:()=>store.finishChatBrowserTurn(bound.id,'original-1',{
      kind:'observed',assistantSha256:sha(answer),summary:answer,
      ...(newConversation?{newChatUrl:NEXT_URL}:{}),
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

test('pause during a new-chat Send preserves its unique migration and can only resume after the answer is observed',()=>{
  const f=fixture(false,true);try{
    const pending=f.store.chatBrowserTurn(f.id);
    assert.equal(pending?.status,'reserved');
    assert.equal(pending?.newConversation,true);
    const paused=f.pause();
    assert.equal(paused.stopRequested,true);
    assert.equal(f.store.chatLink(f.id),URL,'the reservation alone must not replace the pinned URL');
    assert.throws(()=>f.store.resumePausedPiCheckpoint(f.id,paused.version),
      /owner-paused, settled, nonterminal/);
    const settled=f.finish();
    assert.equal(settled.state,'PAUSED');
    assert.equal(settled.stopRequested,true);
    assert.equal(f.store.chatLink(f.id),NEXT_URL);
    assert.equal(f.store.chatBrowserTurn(f.id)?.assistantSha256,sha(answer));
    const before=f.store.events(f.id);
    assert.equal(before.filter(e=>e.type==='chatgpt.browser_reserved').length,1);
    assert.equal(before.filter(e=>e.type==='chatgpt.browser_migrated').length,1);
    assert.equal(before.filter(e=>e.type==='chatgpt.browser_observed').length,1);
    const resumed=f.store.resumePausedPiCheckpoint(f.id,settled.version);
    assert.equal(resumed.state,'PAUSED');
    assert.equal(resumed.stopRequested,false);
    assert.equal(f.store.chatLink(f.id),NEXT_URL);
    assert.deepEqual(f.store.events(f.id).slice(0,before.length),before);
    assert.equal(f.store.events(f.id).filter(e=>e.type==='chatgpt.browser_reserved').length,1,
      'a maintenance resume must not reserve or resend the original new-chat prompt');
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

test('known successor false-mismatch repair CLI rejects missing acknowledgement and unrelated PI checkpoints before browser access',()=>{
  const f=fixture();try{
    f.finish();
    const argv=['--import','tsx','src/cli.ts','pi-recheck-successor',f.id,
      '--revision',String(f.store.get(f.id).version)];
    const command=(suffix:string[]=[])=>spawnSync(process.execPath,[...argv,...suffix],{
      cwd:process.cwd(),encoding:'utf8',timeout:15000,
      env:{...process.env,MISSION_RELAY_HOME:f.dir},
    });
    const existing=f.store.events(f.id).length;
    const noAck=command();
    assert.notEqual(noAck.status,0);
    assert.match(noAck.stderr,/Explicit --acknowledge-side-effects/);
    const wrongCheckpoint=command(['--acknowledge-side-effects']);
    assert.notEqual(wrongCheckpoint.status,0);
    assert.match(wrongCheckpoint.stderr,/No eligible settled successor false-mismatch interruption/);
    assert.equal(f.store.events(f.id).length,existing);
    assert.equal(f.store.chatBrowserTurn(f.id)?.status,'observed');
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

test('exact historic PI capacity interruption may be revalidated once without replaying original Send',()=>{
  const f=fixture(true);try{
    const settled=f.finish();
    const receipt=f.store.chatBrowserTurn(f.id)!;
    const originalEvents=f.store.events(f.id).length;
    const error='operator-managed host PI inference failed (SSH exit 2); no browser retry. '+
      '{"ok": false, "error": "Pi maintenance or a global task is active"}\n';
    const policy={argvSha256:'a'.repeat(64),modelOverride:false as const,
      providerOverride:false as const,thinkingOverride:false as const};
    f.store.auditPiDefaultModelInvocation(f.id,1,sha(answer),policy);
    const paused=f.store.update(f.id,settled.version,{lastError:error},
      'pi.autopilot_interrupted',{reason:error});
    assert.equal(paused.stopRequested,false);
    assert.throws(()=>f.store.clearHistoricPiCapacityInterruption(f.id,paused.version,{
      requestPromptSha256:'f'.repeat(64),assistantSha256:sha(answer),
    }),/exact settled/);
    const eventCount=f.store.events(f.id).length;
    const fixed=f.store.clearHistoricPiCapacityInterruption(f.id,paused.version,{
      requestPromptSha256:receipt.promptSha256,assistantSha256:receipt.assistantSha256!,
    });
    assert.equal(fixed.lastError,null);
    assert.equal(fixed.state,'PAUSED');
    assert.equal(fixed.stopRequested,false);
    assert.equal(fixed.turnCount,1);
    assert.equal(f.store.chatBrowserTurn(f.id)?.requestKey,receipt.requestKey);
    assert.equal(f.store.piPlan(f.id),null);
    assert.equal(f.store.events(f.id).length,eventCount+1);
    assert.equal(f.store.events(f.id).filter(e=>e.type==='chatgpt.browser_reserved').length,1);
    assert.equal(f.store.events(f.id).filter(e=>e.type==='chatgpt.browser_observed').length,1);
    assert.equal(f.store.events(f.id).filter(e=>e.type==='pi.autopilot_interrupted').length,1);
    assert.equal(f.store.events(f.id).filter(e=>e.type==='pi.autopilot_capacity_revalidated').length,1);
    assert.ok(f.store.events(f.id).length>originalEvents);
    assert.throws(()=>f.store.clearHistoricPiCapacityInterruption(f.id,fixed.version,{
      requestPromptSha256:receipt.promptSha256,assistantSha256:receipt.assistantSha256!,
    }),/exact settled/);
  }finally{f.cleanup();}
});

test('PI capacity repair refuses owner pause, unrelated error, and stale revision',()=>{
  const f=fixture();try{
    const settled=f.finish(),receipt=f.store.chatBrowserTurn(f.id)!;
    const exact={requestPromptSha256:receipt.promptSha256,assistantSha256:receipt.assistantSha256!};
    const wrong=f.store.update(f.id,settled.version,{lastError:'PI deadline exceeded'},
      'pi.autopilot_interrupted',{reason:'PI deadline exceeded'});
    assert.throws(()=>f.store.clearHistoricPiCapacityInterruption(f.id,wrong.version,exact),
      /exact settled/);
    const stopped=f.store.update(f.id,wrong.version,{stopRequested:true},
      'mission.pause_requested');
    assert.throws(()=>f.store.clearHistoricPiCapacityInterruption(f.id,stopped.version,exact),
      /exact settled/);
    assert.throws(()=>f.store.clearHistoricPiCapacityInterruption(f.id,wrong.version,exact),
      /State conflict|exact settled/);
    assert.equal(f.store.events(f.id).filter(e=>e.type==='pi.autopilot_capacity_revalidated').length,0);
  }finally{f.cleanup();}
});
