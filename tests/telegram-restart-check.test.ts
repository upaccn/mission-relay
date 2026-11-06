import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

const script=resolve('scripts/windows/telegram-restart-check.mjs');

test('restart preflight identifies a missing SQLite path instead of silently returning 2',()=>{
  const result=spawnSync(process.execPath,[script],{encoding:'utf8',timeout:5000});
  assert.equal(result.status,2);
  assert.match(result.stderr,/requires the absolute local missions.sqlite path/);
});

function withFixture(run:(filename:string,db:DatabaseSync)=>void):void {
  const dir=mkdtempSync(join(tmpdir(),'mr-telegram-restart-'));
  const filename=join(dir,'missions.sqlite');
  const db=new DatabaseSync(filename);
  try {
    db.exec(`CREATE TABLE missions(id TEXT,state TEXT);
      CREATE TABLE channel_commands(source TEXT,status TEXT);
      CREATE TABLE meta(key TEXT,value TEXT);`);
    run(filename,db);
  } finally {db.close();rmSync(dir,{recursive:true,force:true});}
}

function check(filename:string):number|null {
  return spawnSync(process.execPath,[script,filename],{encoding:'utf8',timeout:5000}).status;
}

test('Telegram restart preflight permits an idle durable database',()=>withFixture((file)=>{
  assert.equal(check(file),0);
}));

test('Telegram restart preflight refuses running or verifying Missions',()=>withFixture((file,db)=>{
  db.prepare('INSERT INTO missions VALUES(?,?)').run('task-one','RUNNING');
  assert.equal(check(file),3);
  db.exec("UPDATE missions SET state='VERIFYING'");
  assert.equal(check(file),3);
}));

test('Telegram restart preflight refuses accepted READY PI tasks but allows unrelated READY records',()=>withFixture((file,db)=>{
  db.prepare('INSERT INTO missions VALUES(?,?)').run('pi-ready','READY');
  assert.equal(check(file),0,'An unrelated READY mission is not the Telegram PI worker');
  db.prepare('INSERT INTO meta VALUES(?,?)').run('pi.autopilot.enabled.pi-ready','1');
  assert.equal(check(file),3,'Unsent READY PI mission cannot be stranded by restart');
  db.exec("UPDATE meta SET value='0'");
  assert.equal(check(file),0,'Revoked PI marker no longer claims a pending PI launch');
}));

test('Telegram restart preflight refuses pending delivery or reserved browser Sends',()=>withFixture((file,db)=>{
  db.prepare('INSERT INTO channel_commands VALUES(?,?)').run('telegram','finished');
  assert.equal(check(file),3);
  db.exec('DELETE FROM channel_commands');
  db.prepare('INSERT INTO meta VALUES(?,?)').run('chatgpt.browser.active.example',JSON.stringify({status:'reserved'}));
  assert.equal(check(file),3);
  db.exec("UPDATE meta SET value='not-json'");
  assert.equal(check(file),2);
  db.exec("UPDATE meta SET value='{\"status\":\"unknown\"}'");
  assert.equal(check(file),2,'Unknown receipt status must fail closed');
}));

test('Telegram restart preflight fails closed if the database is absent',()=>{
  assert.equal(check(join(tmpdir(),'mr-no-such-sqlite-file-9dab.sqlite')),2);
});
