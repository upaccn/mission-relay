import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/core/store.js';
import { DatabaseSync } from 'node:sqlite';
import { runChecks } from '../src/core/checks.js';
import { Engine } from '../src/core/engine.js';
import type { AgentAdapter, Decision, Mission, TurnInput, Verification } from '../src/core/types.js';

class Candidate implements AgentAdapter {
  public verifications=0;
  async execute(_input:TurnInput):Promise<Decision>{
    return {status:'candidate_complete',summary:'Executor claims done',next_instruction:'',evidence:['model-claim']};
  }
  async verify(_mission:Mission,_decision:Decision):Promise<Verification>{
    this.verifications++;
    return {accepted:true,reason:'Verified',evidence:['verified']};
  }
}

const make=(checks:Mission['checks'],sandbox:Mission['sandbox']='workspace-write')=>{
  const dir=mkdtempSync(join(tmpdir(),'relay-checks-'));
  const store=new Store(join(dir,'data.sqlite'));
  const agent=new Candidate(),engine=new Engine(store,agent);
  const m=engine.create({goal:'Check output',acceptance:['Tests pass'],workspace:dir,
    sandbox,mode:'supervised',maxTurns:3,requestKey:'test',checks});
  return {m,store,engine,agent,cleanup:()=>{store.close();rmSync(dir,{force:true,recursive:true});}};
};

test('workspace-write cannot be model-verified without deterministic checks',async()=>{
  const f=make([]);
  try{const m=await f.engine.run(f.m.id);
    assert.equal(m.state,'PAUSED');assert.equal(f.agent.verifications,0);
    assert.ok(f.store.events(m.id).some(e=>e.type==='verification.checks_required'));
  }finally{f.cleanup();}
});

test('trusted deterministic check success allows independent verification',async()=>{
  const f=make([{argv:[process.execPath,'-e','process.exit(0)'],timeoutMs:3000}]);
  try{const m=await f.engine.run(f.m.id);
    assert.equal(m.state,'COMPLETED');assert.equal(f.agent.verifications,1);
    const event=f.store.events(m.id).find(x=>x.type==='verification.check_receipts');
    assert.ok(event);const receipt=(event.payload as {receipts:{passed:boolean}[]}).receipts[0];
    assert.equal(receipt?.passed,true);
  }finally{f.cleanup();}
});

test('failing check rejects model claim and preserves evidence',async()=>{
  const f=make([{argv:[process.execPath,'-e','process.exit(4)'],timeoutMs:3000}]);
  try{const m=await f.engine.run(f.m.id);
    assert.equal(m.state,'PAUSED');assert.equal(f.agent.verifications,0);
    const event=f.store.events(m.id).find(x=>x.type==='verification.check_receipts');
    const receipt=(event?.payload as {receipts:{passed:boolean,exitCode:number}[]}).receipts[0];
    assert.equal(receipt.passed,false);assert.equal(receipt.exitCode,4);
  }finally{f.cleanup();}
});

test('timeout prevents completion and does not trust running subprocess',async()=>{
  const f=make([{argv:[process.execPath,'-e','setInterval(()=>{},1000)'],timeoutMs:1000}]);
  try{const m=await f.engine.run(f.m.id);
    assert.equal(m.state,'PAUSED');assert.equal(f.agent.verifications,0);
    const event=f.store.events(m.id).find(x=>x.type==='verification.check_receipts');
    const receipt=(event?.payload as {receipts:{timedOut:boolean}[]}).receipts[0];
    assert.equal(receipt.timedOut,true);
  }finally{f.cleanup();}
});

test('validation rejects unsafe check config',()=>{
  const f=make([]);
  try{assert.throws(()=>f.store.create({goal:'x',acceptance:['y'],workspace:f.m.workspace,
    sandbox:'read-only',mode:'supervised',maxTurns:2,requestKey:'test2',
    checks:[{argv:['node'],timeoutMs:0}]}),/Invalid verification check/);
  }finally{f.cleanup();}
});

test('v1 SQLite database upgrades in place without losing mission history',()=>{
  const dir=mkdtempSync(join(tmpdir(),'relay-migration-'));
  const file=join(dir,'old.sqlite');
  try{
    const old=new DatabaseSync(file);
    old.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      INSERT INTO meta VALUES('schema_version','1');
      CREATE TABLE missions(id TEXT PRIMARY KEY,goal TEXT NOT NULL,acceptance_json TEXT NOT NULL,
        workspace TEXT NOT NULL,sandbox TEXT NOT NULL,mode TEXT NOT NULL,max_turns INTEGER NOT NULL,
        request_key TEXT NOT NULL UNIQUE,state TEXT NOT NULL,version INTEGER NOT NULL,
        turn_count INTEGER NOT NULL,thread_id TEXT,next_instruction TEXT,last_summary TEXT,
        last_error TEXT,owner_pid INTEGER,owner_host TEXT,stop_requested INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT,mission_id TEXT NOT NULL,
        created_at TEXT NOT NULL,type TEXT NOT NULL,payload_json TEXT NOT NULL,
        FOREIGN KEY(mission_id) REFERENCES missions(id));
      INSERT INTO missions(id,goal,acceptance_json,workspace,sandbox,mode,max_turns,request_key,state,
        version,turn_count,created_at,updated_at) VALUES
        ('old','Preserve old goal','["one"]','.','read-only','supervised',2,'old-key','READY',0,0,
        '2026-01-01','2026-01-01');`);
    old.close();
    const upgraded=new Store(file);
    assert.equal(upgraded.get('old').goal,'Preserve old goal');
    assert.deepEqual(upgraded.get('old').checks,[]);
    assert.equal((upgraded.db.prepare('SELECT value FROM meta WHERE key=?').get('schema_version') as {value:string}).value,'3');
    upgraded.close();
    const reopen=new Store(file);assert.equal(reopen.get('old').goal,'Preserve old goal');reopen.close();
  }finally{rmSync(dir,{force:true,recursive:true});}
});
