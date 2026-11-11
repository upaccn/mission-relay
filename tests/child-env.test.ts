import test from 'node:test';
import assert from 'node:assert/strict';
import {childEnvironment} from '../src/core/child-env.js';

test('Core check and PI child processes receive no native agent or Telegram secrets',()=>{
  const env=childEnvironment('check',{
    PATH:'/usr/bin',HOME:'/home/example',OPENAI_API_KEY:'secret',
    CLAUDE_API_KEY:'secret',CODEX_HOME:'/sensitive',
    MISSION_RELAY_TELEGRAM_BOT_TOKEN:'secret',GITHUB_TOKEN:'secret',
  });
  assert.deepEqual(env,{PATH:'/usr/bin',HOME:'/home/example'});
});
