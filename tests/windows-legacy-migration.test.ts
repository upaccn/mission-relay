import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

const script=resolve('scripts/windows/telegram-task.ps1');
const source=readFileSync(script,'utf8');

test('the one-time legacy exception is pinned to the independently read deployed bytes',()=>{
  assert.match(source,/df3044eb2dc787236391918c2b7730b9b9407b8b/);
  assert.match(source,/6801cca587e12482fb638ee9b864493346e5b12d0c1b1bb8dee719bdd85e73b6/);
  assert.match(source,/520f4bba184a207853a6d4104754cb5930fe7ac4af5f6fad8d1a85a84967ebb5/);
  assert.match(source,/Assert-ReviewedBootstrapScript \$ExpectedSha/);
  assert.match(source,/\$LegacyMigration -and \(\$Action -notin/);
  assert.match(source,/Legacy rollback is not the explicitly authorized, byte-matched deployed version/);
  assert.match(source,/COMPATIBLE_SOURCE_ONLY_NOT_MAINTENANCE/);
});

test('legacy rollback release is not confused with fenced-startup acceptance',()=>{
  const branch=source.indexOf("if ($oldRollbackCapability.mode -eq 'legacy-release-before-start')");
  const end=source.indexOf('} else {',branch);
  assert.ok(branch>0&&end>branch);
  const body=source.slice(branch,end);
  const steps=[
    'Verify-UpgradeSQLiteContinuity',
    "'legacy_rollback_pre_release_verified'",
    'Release-ChannelDrain $drainId',
    'Start-ScheduledTask -TaskName $taskName',
    'Assert-LegacyRollbackWorker',
    "'rollback_verified'",
  ];
  // The enclosing catch performs Verify-UpgradeSQLiteContinuity before the
  // special branch; the in-branch guard remains ordered release-before-start.
  assert.ok(source.lastIndexOf('Verify-UpgradeSQLiteContinuity',branch)>0);
  let previous=0;
  for(const step of steps.slice(1)){
    const index=body.indexOf(step);
    assert.ok(index>previous,step+' is absent or out of order');
    previous=index;
  }
  assert.match(body,/legacyPostReleaseRestart=\$true/);
  assert.doesNotMatch(body,/Release-VerifiedChannelDrain/);
});

test('PowerShell 7 parser accepts the reviewed migration lifecycle',
  {skip:process.platform!=='win32'},()=>{
  const quotedPath="'"+script.replaceAll("'","''")+"'";
  const command='$tokens=$null;$errors=$null;'+
    '[System.Management.Automation.Language.Parser]::ParseFile('+
    quotedPath+',[ref]$tokens,[ref]$errors)|Out-Null;'+
    'if($errors.Count){$errors|Out-String|Write-Error;exit 2}';
  const result=execFileSync('pwsh',['-NoProfile','-NonInteractive','-Command',command],
    {encoding:'utf8',timeout:20_000});
  assert.equal(result.trim(),'');
});
