import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { configuredBaseUrl, codexPreflight } from '../src/core/preflight.js';

test('preflight prioritizes process override without modifying Codex configuration', async()=>{
  const dir=mkdtempSync(join(tmpdir(),'mission-preflight-'));
  try{
    mkdirSync(join(dir,'.codex'));
    writeFileSync(join(dir,'.codex','config.toml'),'openai_base_url = "http://127.0.0.1:1/v1"\n[mcp_servers.fake]\nenabled=true\n');
    const env={MISSION_RELAY_CODEX_BASE_URL:'https://chatgpt.com/backend-api/codex'};
    assert.equal(configuredBaseUrl(env,dir).source,'process-override');
    assert.equal((await codexPreflight(env,dir)).ok,true);
    assert.equal(configuredBaseUrl({},dir).url,'http://127.0.0.1:1/v1');
    assert.equal((await codexPreflight({},dir)).ok,false);
    assert.match(configuredBaseUrl({},dir).url ?? '',/127\.0\.0\.1/);
    writeFileSync(join(dir,'.codex','config.toml'),"openai_base_url = 'http://localhost:19041/v1'\n");
    assert.equal(configuredBaseUrl({},dir).url,'http://localhost:19041/v1');
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('preflight detects an active loopback listener',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'relay-isolated-home-'));
  const server=createServer();
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  try{
    const address=server.address();
    if(!address||typeof address==='string') throw new Error('Test TCP server unavailable');
    const result=await codexPreflight({MISSION_RELAY_CODEX_HOME:dir,MISSION_RELAY_CODEX_BASE_URL:`http://127.0.0.1:${address.port}/v1`});
    assert.equal(result.ok,true);
    assert.equal(result.reachable,true);
  }finally{await new Promise<void>(r=>server.close(()=>r()));rmSync(dir,{recursive:true,force:true});}
});

test('preflight rejects invalid protocols without connecting',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'relay-invalid-protocol-'));
  try {
    const result=await codexPreflight({MISSION_RELAY_CODEX_HOME:dir,MISSION_RELAY_CODEX_BASE_URL:'file:///tmp/private'});
    assert.equal(result.ok,false);
    assert.match(result.message,/HTTP/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('uninitialized isolated Codex home blocks execution before any model dispatch',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'relay-missing-home-'));
  try {
    const result=await codexPreflight({MISSION_RELAY_CODEX_HOME:join(dir,'not-created')});
    assert.equal(result.ok,false);
    assert.match(result.message,/codex-init/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
