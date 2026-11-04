import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { codexProxyEnvironment, codexProxyUrl, localProxyPreflight } from '../src/core/proxy.js';

test('Codex-only proxy is opt-in and does not inherit any Telegram secrets', () => {
  assert.deepEqual(codexProxyEnvironment({}), {});
  const env = { MISSION_RELAY_CODEX_PROXY:'http://127.0.0.1:20808',MISSION_RELAY_TELEGRAM_BOT_TOKEN:'123:private' };
  assert.deepEqual(codexProxyEnvironment(env), {
    HTTP_PROXY:'http://127.0.0.1:20808',HTTPS_PROXY:'http://127.0.0.1:20808',
  });
  assert.equal(codexProxyUrl(env),'http://127.0.0.1:20808');
});

test('Invalid or credential-bearing proxies are rejected before starting a mission', () => {
  for (const proxy of ['not a url','socks5://localhost:1080','http://user:secret@localhost:8080',
    'http://localhost:8080/path','http://localhost:8080/?password=secret']) {
    assert.throws(()=>codexProxyUrl({MISSION_RELAY_CODEX_PROXY:proxy}),/proxy|Proxy|HTTP/);
  }
});

test('Missing local proxy is reported without dispatching Codex', async () => {
  const server=createServer();
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const address=server.address();
  if(!address||typeof address==='string') throw new Error('No test port');
  const env={MISSION_RELAY_CODEX_PROXY:`http://127.0.0.1:${address.port}`};
  try {
    assert.equal((await localProxyPreflight(env)).ok,true);
  } finally {await new Promise<void>(r=>server.close(()=>r()));}
  assert.equal((await localProxyPreflight(env)).ok,false);
});
