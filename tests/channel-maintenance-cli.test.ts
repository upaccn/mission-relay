import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/core/store.js';

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

    assert.notEqual(run('channel-drain-release-verified','--id',requested.drainId,
      '--expected-sha','a'.repeat(40),'--expected-pid','99999').status,0,
      'A CLI without a verified replacement Worker must not release maintenance');
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

test('enrolled task channel and drain status remain read-only while the final SQLite write drain is held',()=>{
  const home=mkdtempSync(join(tmpdir(),'mission-relay-channel-status-'));
  const store=new Store(join(home,'missions.sqlite'));
  try{
    store.db.exec('BEGIN IMMEDIATE');
    try{
      for(const command of ['channel-status','channel-drain-status']){
      const status=spawnSync(process.execPath,
        ['--import','tsx','src/cli.ts',command],{
          cwd:process.cwd(),encoding:'utf8',timeout:8000,
          env:{...process.env,MISSION_RELAY_HOME:home},
        });
      assert.equal(status.status,0,status.stderr||String(status.error));
      const channel=JSON.parse(status.stdout) as {source?:string;drainRequested?:boolean;requested?:boolean};
      if(command==='channel-status'){
        assert.equal(channel.source,'telegram');
        assert.equal(channel.drainRequested,false);
      }else assert.equal(channel.requested,false);
      // Node 26 reports a loader-only DEP0205 warning from the pinned tsx
      // --import hook. This is not output from the read-only CLI. Reject
      // every other stderr message rather than suppressing all warnings.
      const loaderWarning=/^\(node:\d+\) \[DEP0205\] DeprecationWarning: `module\.register\(\)` is deprecated\. Use `module\.registerHooks\(\)` instead\.\r?\n\(Use `node --trace-deprecation \.\.\.` to show where the warning was created\)\r?\n$/;
      assert.ok(status.stderr===''||loaderWarning.test(status.stderr),
        `Unexpected CLI stderr: ${status.stderr}`);
      }
    }finally{store.db.exec('ROLLBACK');}
  }finally{store.close();rmSync(home,{recursive:true,force:true});}
});
