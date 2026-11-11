import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/core/store.js';
import {LazyExecutor,executorPreflight,registerExecutorPlugin,configuredExecutor,
  registeredExecutorPlugins,defaultExecutorId,setDefaultExecutor,removeExecutorPlugin} from '../src/core/executor-plugins.js';

test('Native executor has no mandatory provider; registering an explicit trusted local module enables it',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'relay-executor-plugin-'));
  const store=new Store(join(dir,'state.sqlite'));
  try{
    const agent=new LazyExecutor(store);
    const first=store.create({goal:'Native smoke',acceptance:['Provide evidence'],workspace:dir,
      sandbox:'read-only',mode:'supervised',maxTurns:2,requestKey:'native-1',checks:[]});
    assert.equal((await executorPreflight(store)).ok,false);
    await assert.rejects(agent.execute({mission:first,prompt:'test',onThreadStarted:()=>{}}),/No native executor plugin/);
    const path=join(dir,'example.mjs');
    writeFileSync(path,`export const manifest={id:'executor.fake',version:'1.0.0',apiVersion:1,kind:'executor',capabilities:['execute-turn','verify-read-only']};
export const createExecutor=()=>({execute:async()=>({status:'continue',summary:'ok',next_instruction:'',evidence:[]}),verify:async()=>({accepted:true,reason:'ok',evidence:[]})});`);
    // macOS tempdir() may return /var/..., but realpathSync resolves it to
    // /private/var/.... The plugin deliberately stores the canonical path.
    assert.deepEqual(await registerExecutorPlugin(store,path),
      {id:'executor.fake',path:realpathSync(path)});
    assert.equal((await configuredExecutor(store))?.manifest.id,'executor.fake');
    assert.equal((await executorPreflight(store)).ok,true);
    assert.equal((await agent.execute({mission:first,prompt:'test',onThreadStarted:()=>{}})).summary,'ok');
    assert.equal(store.getMeta(`executor.mission.${first.id}`),'executor.fake');
    const sameExecutor=store.create({goal:'Shared executor cache',acceptance:['Answer'],workspace:dir,
      sandbox:'read-only',mode:'supervised',maxTurns:2,requestKey:'native-cache',checks:[]});
    assert.equal((await agent.execute({mission:sameExecutor,prompt:'test',onThreadStarted:()=>{}})).summary,'ok');
    assert.equal(store.getMeta(`executor.mission.${sameExecutor.id}`),'executor.fake',
      'Even a cached adapter must pin every Mission separately');
    const second=join(dir,'second.mjs');
    writeFileSync(second,`export const manifest={id:'executor.second',version:'1.0.0',apiVersion:1,kind:'executor',capabilities:['execute-turn','verify-read-only']};
export const createExecutor=()=>({execute:async()=>({status:'continue',summary:'second',next_instruction:'',evidence:[]}),verify:async()=>({accepted:true,reason:'second',evidence:[]})});`);
    await registerExecutorPlugin(store,second);
    assert.equal(registeredExecutorPlugins(store).length,2);
    assert.equal(defaultExecutorId(store),'executor.fake');
    setDefaultExecutor(store,'executor.second');
    assert.equal((await agent.execute({mission:first,prompt:'test',onThreadStarted:()=>{}})).summary,'ok',
      'First mission remains pinned despite changing the default');
    assert.equal((await agent.execute({mission:sameExecutor,prompt:'test',onThreadStarted:()=>{}})).summary,'ok',
      'The cached adapter does not allow an earlier Mission to follow the new default');
    const later=store.create({goal:'Second runtime',acceptance:['Answer'],workspace:dir,
      sandbox:'read-only',mode:'supervised',maxTurns:2,requestKey:'native-2',checks:[]});
    assert.equal((await agent.execute({mission:later,prompt:'test',onThreadStarted:()=>{}})).summary,'second');
    removeExecutorPlugin(store,'executor.second');
    assert.equal(registeredExecutorPlugins(store).length,1);
    await assert.rejects(agent.execute({mission:later,prompt:'test',onThreadStarted:()=>{}}),/not installed/,
      'Removing a bound plugin must never silently switch to another provider');
    removeExecutorPlugin(store,'executor.fake');
    assert.equal((await executorPreflight(store)).ok,false);
    await assert.rejects(registerExecutorPlugin(store,'./relative.mjs'),/absolute/);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
