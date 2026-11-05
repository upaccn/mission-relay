import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createExecutor,manifest,preflight} from '../index.mjs';

test('Optional SDK module is separately installable and exports the generic executor contract',()=>{
  assert.equal(manifest.kind,'executor');
  assert.ok(manifest.capabilities.includes('execute-turn'));
  assert.ok(manifest.capabilities.includes('verify-read-only'));
  const executor=createExecutor();
  assert.equal(typeof executor.execute,'function');
  assert.equal(typeof executor.verify,'function');
});

test('Optional Codex preflight refuses missing profile and undeclared external MCP tool permissions',async()=>{
  const root=mkdtempSync(join(tmpdir(),'relay-optional-codex-'));
  const previous=process.env.MISSION_RELAY_HOME;
  process.env.MISSION_RELAY_HOME=root;
  try{
    assert.equal((await preflight()).ok,false);
    execFileSync(process.execPath,[new URL('../init.mjs',import.meta.url).pathname],{
      env:{...process.env,MISSION_RELAY_HOME:root},stdio:'ignore',
    });
    assert.equal(statSync(join(root,'codex-home')).isDirectory(),true);
    assert.equal((await preflight()).ok,true);
    writeFileSync(join(root,'codex-home','config.toml'),'[mcp_servers.sample]\ncommand = "unsafe"\n');
    assert.equal((await preflight()).ok,false);
  }finally{
    if(previous===undefined)delete process.env.MISSION_RELAY_HOME;
    else process.env.MISSION_RELAY_HOME=previous;
    rmSync(root,{recursive:true,force:true});
  }
});

test('Malformed Codex-only proxy cannot be silently inherited by the optional executor',()=>{
  const previous=process.env.MISSION_RELAY_CODEX_PROXY;
  process.env.MISSION_RELAY_CODEX_PROXY='file:///etc/passwd';
  try{assert.throws(()=>createExecutor(),/Invalid Codex proxy URL/);}
  finally{
    if(previous===undefined)delete process.env.MISSION_RELAY_CODEX_PROXY;
    else process.env.MISSION_RELAY_CODEX_PROXY=previous;
  }
});
