import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../src/core/store.js';
import {GoalLedger} from '../src/core/goal-store.js';

const cli=resolve('scripts/windows/fresh-project-db.mjs');
const anchor='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174000';

function fixture(){
  const home=mkdtempSync(join(tmpdir(),'relay-fresh-preproduction-'));
  const dbFile=join(home,'missions.sqlite'),archive=join(home,'private-audit');
  const store=new Store(dbFile);
  const mission=store.create({goal:'Historical sandbox test',acceptance:['Old test'],
    workspace:'',sandbox:'read-only',mode:'supervised',maxTurns:32,
    requestKey:'old-test-mission'});
  const linked=store.linkChat(mission.id,anchor,mission.version).mission;
  const bound=store.bindChatBrowser(mission.id,'install:Chrome:synthetic',linked.version).mission;
  store.update(bound.id,bound.version,{state:'COMPLETED'},'test.completed',{});
  new GoalLedger(store).createGoal({requestKey:'old-goal',objective:'Old sandbox test Goal',priority:50});
  store.setMeta('telegram.chatgpt.anchorMissionId',bound.id);
  store.setMeta('telegram.pi.sshHost','approved-pi');
  store.setMeta('telegram.pi.project','/srv/projects/project');
  store.setMeta('telegram.build.project','/srv/projects/project');
  store.setMeta('telegram.inbox_cursor','700001');
  store.setMeta('telegram.notifications_cursor',String(store.maxEventId()));
  store.setMeta('browser.watch.seen','historical-chat-list-must-not-migrate');
  const drain=store.requestChannelDrain('telegram');
  store.close();
  return {home,dbFile,archive,drain,close:()=>rmSync(home,{recursive:true,force:true})};
}

function invoke(...args:string[]){
  return spawnSync(process.execPath,[cli,...args],{encoding:'utf8',timeout:20000});
}

test('fenced fresh reset preserves owner configuration and cursors but zero project rows',()=>{
  const f=fixture();
  try{
    const old=new DatabaseSync(f.dbFile,{readOnly:true});
    assert.equal(old.prepare('SELECT count(*) AS n FROM missions').get().n,1);
    old.close();
    const result=invoke('--reset',f.dbFile,f.drain,f.archive);
    assert.equal(result.status,0,result.stderr);
    assert.equal(JSON.parse(result.stdout).result,'RESET_VERIFIED');
    const readback=invoke('--verify',f.dbFile,f.drain);
    assert.equal(readback.status,0,readback.stderr);
    const reopened=new Store(f.dbFile);
    try{
      assert.equal(reopened.list().length,0);
      assert.equal(new GoalLedger(reopened).listGoals().length,0);
      assert.equal(reopened.maxEventId(),0);
      assert.equal(reopened.getMeta('telegram.inbox_cursor'),'700001');
      assert.equal(reopened.getMeta('telegram.notifications_cursor'),null);
      assert.equal(reopened.getMeta('telegram.chatgpt.anchorUrl'),anchor);
      assert.equal(reopened.getMeta('telegram.chatgpt.browserId'),'install:Chrome:synthetic');
      assert.equal(reopened.getMeta('telegram.chatgpt.anchorMissionId'),null);
      assert.equal(reopened.getMeta('browser.watch.seen'),null);
      assert.equal(reopened.getMeta('telegram.build.project'),'/srv/projects/project');
      assert.equal(reopened.channelDrainId('telegram'),f.drain);
      assert.equal(reopened.getMeta('telegram.pi.sshHost'),'approved-pi');
    }finally{reopened.close()}
    assert.ok(existsSync(join(f.archive,'pre-reset-live.sqlite')));
    const archived=new DatabaseSync(join(f.archive,'pre-reset-live.sqlite'),{readOnly:true});
    assert.equal(archived.prepare('SELECT count(*) AS n FROM missions').get().n,1);
    archived.close();
  }finally{f.close()}
});

test('fresh reset fails closed without its original drain and leaves prior records intact',()=>{
  const f=fixture();
  try{
    const result=invoke('--reset',f.dbFile,'00000000-0000-0000-0000-000000000001',f.archive);
    assert.notEqual(result.status,0);
    const db=new DatabaseSync(f.dbFile,{readOnly:true});
    assert.equal(db.prepare('SELECT count(*) AS n FROM missions').get().n,1);
    db.close();
    assert.equal(existsSync(join(f.archive,'pre-reset-live.sqlite')),false);
  }finally{f.close()}
});
