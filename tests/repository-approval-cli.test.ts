import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/core/store.js';
import {GoalLedger} from '../src/core/goal-store.js';

test('real owner CLI grants and revokes independent repository roots without touching Missions',()=>{
  const home=mkdtempSync(join(tmpdir(),'mission-relay-repo-grant-cli-'));
  const store=new Store(join(home,'missions.sqlite'));
  const first='/srv/projects/first-product',second='/srv/projects/x-markdown';
  const invoke=(...args:string[])=>spawnSync(process.execPath,
    ['--import','tsx','src/cli.ts','telegram-build-project',...args],{
      cwd:process.cwd(),encoding:'utf8',timeout:15000,
      env:{...process.env,MISSION_RELAY_HOME:home},
    });
  try {
    assert.notEqual(invoke('--allow',second).status,0,'No configured PI route');
    store.setMeta('telegram.pi.sshHost','test-pi-host');
    store.setMeta('telegram.pi.project',first);
    store.setMeta('telegram.build.project',first);
    const parse=(...args:string[])=>{
      const result=invoke(...args);
      assert.equal(result.status,0,result.stderr);
      return JSON.parse(result.stdout) as {approved?:string;revoked?:string;
        repositories?:string[]};
    };
    assert.deepEqual(parse('--allow',second),{
      approved:second,repositories:[first,second],
    });
    assert.deepEqual(parse('--list').repositories,[first,second]);
    assert.deepEqual(parse('--allow',second).repositories,[first,second],
      'An identical grant is idempotent');
    assert.notEqual(invoke('--allow').status,0,'Missing path must fail');
    assert.notEqual(invoke('--allow',second,'--allow',first).status,0,
      'Duplicate/unexpected extra flags must fail');
    assert.notEqual(invoke('--allow',first+'/nested').status,0,
      'A nested repository must never receive an overlapping grant');
    assert.notEqual(invoke('--allow','/srv/projects//x-markdown').status,0,
      'Repeated separators must not alias an approved root');
    assert.deepEqual(parse('--list').repositories,[first,second]);
    const revoked=parse('--revoke',second);
    assert.equal(revoked.revoked,second);
    assert.deepEqual(revoked.repositories,[first]);
    assert.deepEqual(parse('--list').repositories,[first]);
    assert.notEqual(invoke('--revoke').status,0,'Revoke requires a path');
    assert.notEqual(invoke('--revoke',second,'--revoke',first).status,0,
      'Revoke cannot affect two paths in one malformed invocation');
    assert.deepEqual(parse('--allow',second).repositories,[first,second],
      'An explicitly revoked root can be reapproved');
    assert.equal(store.list().length,0);
    assert.equal(new GoalLedger(store).listGoals().length,0);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM events').get()?.n,0);
  } finally {
    store.close();
    rmSync(home,{recursive:true,force:true});
  }
});
