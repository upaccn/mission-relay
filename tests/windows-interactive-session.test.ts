import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

test('Windows Telegram worker refuses Session 0 but permits interactive desktop sessions',
  {skip:process.platform!=='win32'},()=>{
    const source=readFileSync(resolve('scripts/windows/telegram-task.ps1'),'utf8');
    const start=source.indexOf('function Assert-InteractiveSession(');
    const end=source.indexOf('\nfunction Get-ChannelStatus',start);
    assert.ok(start>0&&end>start,'The worker guard must be present before channel operations');
    assert.match(source.slice(end),/'Worker'\s*\{\s*Assert-Prerequisites\s+Assert-InteractiveSession/);
    // Evaluate only the pure guard function, not the installed production task.
    const check=`${source.slice(start,end)}\n`+
      `Assert-InteractiveSession -sessionId 1; `+
      `try { Assert-InteractiveSession -sessionId 0; throw 'Session 0 was allowed' } `+
      `catch { if ($_.Exception.Message -notlike '*Session 0 is prohibited*') { throw } }; `+
      // PowerShell propagates the last thrown command's failure exit status
      // even after a matching catch unless a final successful command runs.
      `Write-Output 'interactive-session-guard-pass'`;
    const run=spawnSync('pwsh',['-NoProfile','-NonInteractive','-Command',check],
      {encoding:'utf8',timeout:10000});
    assert.equal(run.status,0,`PowerShell guard test failed: ${run.error??''} ${run.stderr} ${run.stdout}`);
    assert.match(run.stdout,/interactive-session-guard-pass/);
});
