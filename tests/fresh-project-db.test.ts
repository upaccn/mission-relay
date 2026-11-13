import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {approveBuildRepository,revokeBuildRepository,isApprovedBuildRepository} from '../src/core/build-scopes.js';
import {Store} from '../src/core/store.js';
import {GoalLedger} from '../src/core/goal-store.js';

const cli=resolve('scripts/windows/fresh-project-db.mjs');
const anchor='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174000';
const EMPTY_PROJECT_TABLES=['missions','events','goals','goal_plans','goal_work_items',
  'goal_acceptance','goal_dependencies','goal_operations','goal_release_checks',
  'goal_release_completion','goal_release_targets','goal_events','pi_owner_directives',
  'channel_commands','channel_leases'];

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
  approveBuildRepository(store,'/srv/projects/second');
  revokeBuildRepository(store,'/srv/projects/retired');
  store.setMeta('telegram.agent.workspace','/srv/projects/project');
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
      const emptyCheck=new DatabaseSync(f.dbFile,{readOnly:true});
      try{
        for(const table of EMPTY_PROJECT_TABLES)
          assert.equal(emptyCheck.prepare(`SELECT count(*) AS n FROM ${table}`).get().n,0,table);
      }finally{emptyCheck.close()}
      assert.equal(reopened.getMeta('telegram.inbox_cursor'),'700001');
      assert.equal(reopened.getMeta('telegram.notifications_cursor'),null);
      assert.equal(reopened.getMeta('telegram.chatgpt.anchorUrl'),anchor);
      assert.equal(reopened.getMeta('telegram.chatgpt.browserId'),'install:Chrome:synthetic');
      assert.equal(reopened.getMeta('telegram.chatgpt.anchorMissionId'),null);
      assert.equal(reopened.getMeta('browser.watch.seen'),null);
      assert.equal(reopened.getMeta('telegram.build.project'),'/srv/projects/project');
      assert.equal(isApprovedBuildRepository(reopened,'/srv/projects/second'),true);
      assert.equal(isApprovedBuildRepository(reopened,'/srv/projects/retired'),false);
      assert.equal(reopened.getMeta('telegram.build.allow.'+
        createHash('sha256').update('/srv/projects/retired').digest('hex')),'');
      assert.equal(reopened.getMeta('telegram.pi.project'),'/srv/projects/project');
      assert.equal(reopened.getMeta('telegram.agent.workspace'),'/srv/projects/project');
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

test('fresh reset refuses unsupported schema objects before replacing the original database',()=>{
  const f=fixture();
  try{
    const db=new DatabaseSync(f.dbFile);
    db.exec('CREATE VIEW legacy_test_view AS SELECT id FROM missions');
    db.close();
    const result=invoke('--reset',f.dbFile,f.drain,f.archive);
    assert.notEqual(result.status,0);
    const readback=new DatabaseSync(f.dbFile,{readOnly:true});
    try{
      assert.equal(readback.prepare('SELECT count(*) AS n FROM missions').get().n,1);
      assert.equal(readback.prepare('SELECT count(*) AS n FROM sqlite_master WHERE type=? AND name=?')
        .get('view','legacy_test_view').n,1);
    }finally{readback.close()}
    assert.equal(existsSync(join(f.archive,'pre-reset-live.sqlite')),false);
  }finally{f.close()}
});

test('fresh reset refuses an unknown table and mismatched PI/build scope before replacing state',()=>{
  for(const mutation of ['unknown-table','mismatched-scope']){
    const f=fixture();
    try{
      const db=new DatabaseSync(f.dbFile);
      if(mutation==='unknown-table')
        db.exec('CREATE TABLE future_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
      else db.prepare('UPDATE meta SET value=? WHERE key=?')
        .run('/srv/projects/other','telegram.build.project');
      db.close();
      const result=invoke('--reset',f.dbFile,f.drain,f.archive);
      assert.notEqual(result.status,0,mutation);
      const readback=new DatabaseSync(f.dbFile,{readOnly:true});
      try{
        assert.equal(readback.prepare('SELECT count(*) AS n FROM missions').get().n,1);
        if(mutation==='unknown-table')
          assert.equal(readback.prepare('SELECT count(*) AS n FROM sqlite_master WHERE type=? AND name=?')
            .get('table','future_settings').n,1);
        else assert.equal(readback.prepare('SELECT value FROM meta WHERE key=?')
          .get('telegram.build.project').value,'/srv/projects/other');
      }finally{readback.close()}
      assert.equal(existsSync(join(f.archive,'pre-reset-live.sqlite')),false);
    }finally{f.close()}
  }
});
