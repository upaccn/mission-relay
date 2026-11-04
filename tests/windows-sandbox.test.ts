import test from 'node:test';
import assert from 'node:assert/strict';
import { windowsSandboxOverride } from '../src/core/windows-sandbox.js';

test('Codex Windows backend defaults to official elevated sandbox, not unrestricted access', () => {
  assert.deepEqual(windowsSandboxOverride({},'win32'),{windows:{sandbox:'elevated'}});
  assert.deepEqual(windowsSandboxOverride({MISSION_RELAY_WINDOWS_SANDBOX:'unelevated'},'win32'),
    {windows:{sandbox:'unelevated'}});
  assert.deepEqual(windowsSandboxOverride({MISSION_RELAY_WINDOWS_SANDBOX:'unelevated'},'linux'),{});
  for(const setting of ['disabled','danger-full-access','none']) {
    assert.throws(()=>windowsSandboxOverride({MISSION_RELAY_WINDOWS_SANDBOX:setting},'win32'),/elevated or unelevated/);
  }
});
