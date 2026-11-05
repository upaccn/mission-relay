import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

const script=resolve('scripts/windows/telegram-restart-check.mjs');

function withFixture(run:(filename:string,db:DatabaseSync)=>void):void {
  const dir=mkdtempSync(join(tmpdir(),'mr-telegram-restart-'));
  const filename=join(dir,'missions.sqlite');
  const db=new DatabaseSync(filename);
  try {
    db.exec(`CREATE TABLE missions(state TEXT);
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
  db.prepare('INSERT INTO missions VALUES(?)').run('RUNNING');
  assert.equal(check(file),3);
  db.exec("UPDATE missions SET state='VERIFYING'");
  assert.equal(check(file),3);
}));

test('Telegram restart preflight refuses pending delivery or reserved browser Sends',()=>withFixture((file,db)=>{
  db.prepare('INSERT INTO channel_commands VALUES(?,?)').run('telegram','finished');
  assert.equal(check(file),3);
  db.exec('DELETE FROM channel_commands');
  db.prepare('INSERT INTO meta VALUES(?,?)').run('chatgpt.browser.active.example',JSON.stringify({status:'reserved'}));
  assert.equal(check(file),3);
  db.exec("UPDATE meta SET value='not-json'");
  assert.equal(check(file),2);
}));

test('Telegram restart preflight fails closed if the database is absent',()=>{
  assert.equal(check(join(tmpdir(),'mr-no-such-sqlite-file-9dab.sqlite')),2);
});
