import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

const path=resolve('scripts/windows/telegram-task.ps1');
const script=readFileSync(path,'utf8');

test('GMK pull-only upgrade is ordered behind the SQLite drain and never installs dependencies',()=>{
  const start=script.indexOf("    'Upgrade' {");
  const end=script.indexOf("    'Remove' {",start);
  assert.ok(start>0&&end>start,'Separate optional Upgrade action must exist');
  const upgrade=script.slice(start,end);
  const steps=[
    'Assert-Prerequisites',
    '$null=Assert-OurTask',
    'Assert-UpgradeTarget $ExpectedSha',
    'Assert-SafeRestart',
    '$drainId=Request-ChannelDrain',
    'Stop-FencedTelegramTask',
    'git -C $root fetch origin main',
    'git -C $root merge-base --is-ancestor $oldSha $remoteSha',
    'git -C $root pull --ff-only origin main',
    'npm.cmd run build',
    'Release-ChannelDrain $drainId',
    'Wait-ForChannel $true',
    'pi-resume $ResumeMissionId',
  ];
  let previous=-1;
  for(const step of steps){
    const position=upgrade.indexOf(step);
    assert.ok(position>previous,`Required safe upgrade ordering: ${step}`);
    previous=position;
  }
  assert.match(upgrade,/\$remoteSha -cne \$ExpectedSha/);
  assert.match(script,/function Assert-OurTask \{[\s\S]*?Principal\.LogonType -ne 'Interactive'[\s\S]*?Principal\.RunLevel -ne 'Limited'/);
  assert.match(script,/'Worker'\s*\{\s*Assert-Prerequisites\s+Assert-InteractiveSession/);
  assert.doesNotMatch(upgrade,/Assert-InteractiveSession\s*$/m,
    'Session 0 may coordinate a known interactive task but must never run a Chrome Worker itself');
  assert.match(upgrade,/\$oldPid -and \$current\.pollerPid -eq \$oldPid/);
  assert.match(upgrade,/\$head -cne \$ExpectedSha.*\$rollbackSafe=\$false/s);
  assert.match(upgrade,/git -C \$root reset --hard \$oldSha/);
  assert.match(upgrade,/Copy-Item -LiteralPath \(Join-Path \$backup 'dist'\)/);
  assert.match(upgrade,/\$backupComplete=\$true/);
  assert.match(upgrade,/if \(\$buildStarted\) \{/);
  assert.match(upgrade,/if \(-not \$backupComplete\) \{ \$rollbackSafe=\$false \}/);
  assert.match(upgrade,/\$rollbackSafe.*Release-ChannelDrain \$drainId/s);
  assert.doesNotMatch(upgrade,/npm\s+(?:ci|install)|Stop-Process|taskkill|chrome\.exe/i);
});

test('PowerShell parses guarded Upgrade script and its exact-SHA guard fails before Git access',
  {skip:process.platform!=='win32'},()=>{
    const quoted=path.replaceAll("'","''");
    const parse=`$tokens=$null; $errors=$null; `+
      `[System.Management.Automation.Language.Parser]::ParseFile('${quoted}',`+
      `[ref]$tokens,[ref]$errors) | Out-Null; `+
      `if ($errors.Count -ne 0) { $errors | ForEach-Object { Write-Error $_ }; exit 2 }; `+
      `Write-Output 'upgrade-syntax-pass'`;
    const checked=spawnSync('pwsh',['-NoProfile','-NonInteractive','-Command',parse],
      {encoding:'utf8',timeout:12000});
    assert.equal(checked.status,0,`${checked.stderr} ${checked.stdout}`);
    assert.match(checked.stdout,/upgrade-syntax-pass/);

    const start=script.indexOf('function Assert-UpgradeTarget(');
    const end=script.indexOf('\nfunction Stop-FencedTelegramTask',start);
    assert.ok(start>0&&end>start);
    const reject=`${script.slice(start,end)}\n`+
      `try { Assert-UpgradeTarget -sha 'not-an-exact-sha'; throw 'Invalid SHA accepted' } `+
      `catch { if ($_.Exception.Message -notlike '*exact lowercase 40-character*') { throw } }; `+
      `Write-Output 'upgrade-hash-rejection-pass'`;
    const refused=spawnSync('pwsh',['-NoProfile','-NonInteractive','-Command',reject],
      {encoding:'utf8',timeout:12000});
    assert.equal(refused.status,0,`${refused.stderr} ${refused.stdout}`);
    assert.match(refused.stdout,/upgrade-hash-rejection-pass/);

    // Prove a foreign/non-task writer cannot be stopped by this action. The
    // extracted helper runs against in-memory stubs only; no real scheduled
    // task, browser, Git checkout, SQLite or Telegram token is touched.
    const stopStart=script.indexOf('function Stop-FencedTelegramTask {');
    const stopEnd=script.indexOf('\nswitch ($Action)',stopStart);
    assert.ok(stopStart>0&&stopEnd>stopStart);
    const rejectForeign=`${script.slice(stopStart,stopEnd)}\n`+
      `function Get-Task { return [pscustomobject]@{ State='Ready' } }; `+
      `function Get-ChannelStatus { return [pscustomobject]@{ pollerPresent=$true } }; `+
      `function Stop-ScheduledTask { throw 'Foreign task was stopped' }; `+
      `try { Stop-FencedTelegramTask; throw 'Foreign writer was allowed' } `+
      `catch { if ($_.Exception.Message -notlike '*Non-task Telegram poller*') { throw } }; `+
      `Write-Output 'foreign-owner-rejection-pass'`;
    const foreign=spawnSync('pwsh',['-NoProfile','-NonInteractive','-Command',rejectForeign],
      {encoding:'utf8',timeout:12000});
    assert.equal(foreign.status,0,`${foreign.stderr} ${foreign.stdout}`);
    assert.match(foreign.stdout,/foreign-owner-rejection-pass/);
  });
