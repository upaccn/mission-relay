import test from 'node:test';
import assert from 'node:assert/strict';
import { childEnvironment } from '../src/core/child-env.js';

test('Telegram credential and unrelated host secrets never reach Codex or verifier subprocesses',()=>{
  const input={
    PATH:'/usr/bin',HOME:'/home/test',MISSION_RELAY_TELEGRAM_BOT_TOKEN:'123:secret',
    MISSION_RELAY_TELEGRAM_USER_ID:'42',GITHUB_TOKEN:'private-token',
    OPENAI_API_KEY:'codex-auth-key',CODEX_HOME:'/home/test/.codex',
  };
  const codex=childEnvironment('codex',input);
  assert.equal(codex.PATH,'/usr/bin');
  assert.equal(codex.CODEX_HOME,'/home/test/.codex');
  assert.equal(codex.OPENAI_API_KEY,'codex-auth-key');
  assert.equal(codex.MISSION_RELAY_TELEGRAM_BOT_TOKEN,undefined);
  assert.equal(codex.GITHUB_TOKEN,undefined);
  const check=childEnvironment('check',input);
  assert.equal(check.OPENAI_API_KEY,undefined);
  assert.equal(check.GITHUB_TOKEN,undefined);
  assert.equal(check.MISSION_RELAY_TELEGRAM_BOT_TOKEN,undefined);
});
