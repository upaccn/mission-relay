import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/core/store.js';
import { Engine } from '../src/core/engine.js';
import { PluginRegistry } from '../src/core/plugins.js';
import type { AgentAdapter, Decision, Mission, TurnInput, Verification } from '../src/core/types.js';

class FakeAgent implements AgentAdapter {
  turns: Decision[] = [];
  verified: Verification = {accepted:true,reason:'Evidence checked independently',evidence:['test receipt']};
  turnCount=0;
  verifierCount=0;
  beforeTurn?: (input:TurnInput) => void;
  error?: Error;
  prompts:string[]=[];
  async execute(input:TurnInput):Promise<Decision> {
    this.turnCount++;
    this.prompts.push(input.prompt);
    input.onThreadStarted(input.mission.threadId ?? 'fake-thread-1');
    input.onEvent?.('turn.started');
    this.beforeTurn?.(input);
    if (this.error) throw this.error;
    input.onEvent?.('turn.completed');
    const turn=this.turns.shift();
    if (!turn) throw new Error('Test has no scripted turn');
    return turn;
  }
  async verify(_m:Mission,_decision:Decision):Promise<Verification> {
    this.verifierCount++;
    return this.verified;
  }
}
const cont:Decision = {status:'continue',summary:'Work remains',next_instruction:'Inspect remaining files',evidence:['initial review']};
const candidate:Decision = {status:'candidate_complete',summary:'All criteria addressed',next_instruction:'',evidence:['actual diff']};

function fixture(options:{mode?:'supervised'|'autopilot',maxTurns?:number}={}) {
  const dir=mkdtempSync(join(tmpdir(),'mission-relay-test-'));
  const store=new Store(join(dir,'state','missions.sqlite'));
  const agent=new FakeAgent();
  const engine=new Engine(store,agent);
  const create=(key='unique-test-key')=>engine.create({
    goal:'Inspect a test project', acceptance:['Verified test output'],
    workspace:dir,sandbox:'read-only',mode:options.mode ?? 'autopilot',
    maxTurns:options.maxTurns ?? 5,requestKey:key,
  });
  return {dir,store,agent,engine,create,cleanup:()=>{store.close();rmSync(dir,{recursive:true,force:true});}};
}

test('create is idempotent, and rejects changed request intent',()=>{
  const f=fixture();try {
    const m=f.create();
    assert.equal(f.create().id,m.id);
    assert.equal(f.store.events(m.id).filter(e=>e.type==='mission.created').length,1);
    assert.throws(()=>f.store.create({...m,goal:'Different mission'}),/Idempotency key/);
    assert.equal(f.engine.list().length,1);
  } finally { f.cleanup(); }
});

test('autopilot continues then completes only after independent acceptance',async()=>{
  const f=fixture();try {
    f.agent.turns=[cont,candidate];
    const m=await f.engine.run(f.create().id);
    assert.equal(m.state,'COMPLETED');
    assert.equal(m.turnCount,2);
    assert.equal(m.threadId,'fake-thread-1');
    assert.equal(f.agent.verifierCount,1);
    assert.match(f.agent.prompts[1]!,/Inspect remaining files/);
    assert.ok(f.store.events(m.id).some(e=>e.type==='verification.accepted'));
    assert.throws(()=>f.engine.resume(m.id),/Cannot resume COMPLETED/);
  }finally{f.cleanup();}
});

test('supervised mode pauses after a turn and resumes by operator',async()=>{
  const f=fixture({mode:'supervised'});try {
    f.agent.turns=[cont,candidate];
    const m=f.create();
    const first=await f.engine.run(m.id);
    assert.equal(first.state,'PAUSED');
    assert.equal(first.turnCount,1);
    f.engine.instruct(m.id,'Review tests before finishing');
    f.engine.resume(m.id);
    const second=await f.engine.run(m.id);
    assert.equal(second.state,'COMPLETED');
    assert.match(f.agent.prompts[1]!,/Review tests before finishing/);
  }finally{f.cleanup();}
});

test('verifier rejects unsupported claims; budget eventually pauses',async()=>{
  const f=fixture({maxTurns:1});try {
    f.agent.turns=[candidate];
    f.agent.verified={accepted:false,reason:'No test receipt found',evidence:[]};
    const m=await f.engine.run(f.create().id);
    assert.equal(m.state,'PAUSED');
    assert.equal(m.turnCount,1);
    assert.ok(f.store.events(m.id).some(e=>e.type==='verification.rejected'));
    assert.throws(()=>f.engine.resume(m.id),/budget exhausted/i);
  }finally{f.cleanup();}
});

test('agent error after a thread starts is ambiguous and never retried',async()=>{
  const f=fixture();try {
    f.agent.error=new Error('Transport lost during tool execution');
    const m=await f.engine.run(f.create().id);
    assert.equal(m.state,'NEEDS_RECONCILIATION');
    assert.equal(m.threadId,'fake-thread-1');
    assert.equal(m.turnCount,0);
    assert.equal(f.agent.turnCount,1);
    assert.throws(()=>f.engine.run(m.id),/only READY/);
    assert.throws(()=>f.engine.reconcile(m.id,false),/Inspect workspace/);
    assert.equal(f.engine.reconcile(m.id,true).state,'PAUSED');
    assert.equal(f.agent.turnCount,1);
  }finally{f.cleanup();}
});

test('queued pause during active turn prevents the next turn',async()=>{
  const f=fixture();try {
    const m=f.create();
    f.agent.turns=[cont,candidate];
    f.agent.beforeTurn=()=>{f.engine.pause(m.id);};
    const done=await f.engine.run(m.id);
    assert.equal(done.state,'PAUSED');
    assert.equal(done.turnCount,1);
    assert.equal(f.agent.turnCount,1);
  }finally{f.cleanup();}
});

test('operator instruction injected during a turn wins over model proposal',async()=>{
  const f=fixture();try {
    const m=f.create();
    f.agent.turns=[cont,candidate];
    f.agent.beforeTurn=()=>{if(f.agent.turnCount===1) f.engine.instruct(m.id,'Operator overrides next turn');};
    const done=await f.engine.run(m.id);
    assert.equal(done.state,'COMPLETED');
    assert.match(f.agent.prompts[1]!,/Operator overrides next turn/);
  }finally{f.cleanup();}
});

test('parallel run of one mission is refused and does not create a second session',async()=>{
  const f=fixture();try {
    const m=f.create();f.agent.turns=[candidate];
    f.agent.beforeTurn=()=>{assert.throws(()=>f.store.acquire(m.id),/only READY/);};
    const done=await f.engine.run(m.id);
    assert.equal(done.state,'COMPLETED');
    assert.equal(f.agent.turnCount,1);
  }finally{f.cleanup();}
});

test('stale version rejects conflicting state mutation',()=>{
  const f=fixture();try {
    const m=f.create();
    f.engine.instruct(m.id,'New instruction');
    assert.throws(()=>f.store.update(m.id,m.version,{state:'PAUSED'},'bad'),/State conflict/);
  }finally{f.cleanup();}
});

test('remote-style expected revisions are enforced atomically by engine/store',async()=>{
  const f=fixture();try{
    const m=f.create();
    f.engine.instruct(m.id,'New instruction');
    assert.throws(()=>f.engine.pause(m.id,m.version),/State conflict/);
    assert.throws(()=>f.engine.cancel(m.id,m.version),/State conflict/);
    assert.throws(()=>f.engine.instruct(m.id,'outdated',m.version),/State conflict/);
    assert.throws(()=>f.engine.run(m.id,m.version),/State conflict/);
    assert.equal(f.agent.turnCount,0);
    const paused=f.engine.pause(m.id,m.version+1);
    assert.throws(()=>f.engine.resume(m.id,paused.version-1),/State conflict/);
    assert.equal(f.engine.resume(m.id,paused.version).state,'READY');
  }finally{f.cleanup();}
});

test('plugin manifest validation blocks incompatible and duplicate plugins',()=>{
  const registry=new PluginRegistry<{name:string}>();
  const manifest={id:'executor.fake',version:'0.1.0',apiVersion:1,kind:'executor' as const,capabilities:['run']};
  registry.register(manifest,{name:'fake'});
  assert.equal(registry.get('executor.fake','executor').name,'fake');
  assert.throws(()=>registry.get('executor.fake','channel'),/Wrong plugin kind/);
  assert.throws(()=>registry.register(manifest,{name:'fake2'}),/already registered/);
  assert.throws(()=>registry.register({...manifest,id:'executor.future',apiVersion:99},{name:'bad'}),/Unsupported plugin API/);
});

test('reconciliation refuses to revoke a live executor lease',()=>{
  const f=fixture();try {
    const m=f.create();
    const running=f.store.acquire(m.id);
    assert.equal(running.state,'RUNNING');
    assert.throws(()=>f.engine.reconcile(m.id,true),/still be active/);
    assert.throws(()=>f.engine.cancel(m.id),/pause active work/);
  }finally{f.cleanup();}
});

test('SQLite state and audit evidence persist across a clean restart',()=>{
  const dir=mkdtempSync(join(tmpdir(),'mission-relay-restart-'));
  const file=join(dir,'state','missions.sqlite');
  try {
    const s1=new Store(file);
    const m=s1.create({goal:'Persist state',acceptance:['Test passes'],workspace:dir,
      sandbox:'read-only',mode:'supervised',maxTurns:3,requestKey:'persist-1'});
    s1.close();
    const s2=new Store(file);
    assert.equal(s2.get(m.id).state,'READY');
    assert.equal(s2.events(m.id)[0]?.type,'mission.created');
    assert.equal(s2.create({goal:'Persist state',acceptance:['Test passes'],workspace:dir,
      sandbox:'read-only',mode:'supervised',maxTurns:3,requestKey:'persist-1'}).id,m.id);
    s2.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});
