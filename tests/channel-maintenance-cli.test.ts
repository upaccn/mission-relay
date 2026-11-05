import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('Local maintenance CLI fences Telegram intake and releases only its matching nonce',()=>{
  const home=mkdtempSync(join(tmpdir(),'mission-relay-drain-cli-'));
  const run=(...args:string[])=>spawnSync(
    process.execPath,['--import','tsx','src/cli.ts',...args],{
      cwd:process.cwd(),encoding:'utf8',timeout:12000,
      env:{...process.env,MISSION_RELAY_HOME:home},
    });
  try {
    const first=run('channel-drain-request');
    assert.equal(first.status,0,first.stderr);
    const requested=JSON.parse(first.stdout) as {requested:boolean;drainId:string};
    assert.equal(requested.requested,true);
    assert.match(requested.drainId,/^[0-9a-f-]{36}$/);

    const status=run('channel-drain-status');
    assert.equal(status.status,0,status.stderr);
    assert.deepEqual(JSON.parse(status.stdout),{
      requested:true,drainId:requested.drainId,pollerPresent:false,
    });
    assert.notEqual(run('channel-drain-request').status,0);
    assert.notEqual(run('channel-drain-release','--id','not-the-owner').status,0);
    assert.equal(JSON.parse(run('channel-drain-status').stdout).requested,true);

    const released=run('channel-drain-release','--id',requested.drainId);
    assert.equal(released.status,0,released.stderr);
    assert.equal(JSON.parse(released.stdout).released,true);
    assert.deepEqual(JSON.parse(run('channel-drain-status').stdout),{
      drainId:null,requested:false,pollerPresent:false,
    });
  } finally {
    rmSync(home,{force:true,recursive:true});
  }
});
