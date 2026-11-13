import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import { Store } from '../src/core/store.js';
import { Engine } from '../src/core/engine.js';
import { TelegramBridge, formatBrowserResultNotification, formatNativeMissionNotification,
  telegramKeyboardForReply,telegramCallbackCommand,
  probeFencedTelegramTransport,
  stalledPollerMayExit,TELEGRAM_IDLE_STALL_EXIT_MS,
  type TelegramUpdate, type TelegramTransport } from '../src/plugins/telegram.js';
import type { AgentAdapter, Decision, Mission, TurnInput, Verification } from '../src/core/types.js';
import type { Page } from 'playwriter';

class FakeAgent implements AgentAdapter {
  calls=0;
  async execute(_input:TurnInput):Promise<Decision> {
    this.calls++;
    return {status:'candidate_complete',summary:'done',next_instruction:'',evidence:['fake']};
  }
  async verify(_m:Mission,_d:Decision):Promise<Verification> {
    return {accepted:true,reason:'check',evidence:['fake']};
  }
}

class FakeTransport implements TelegramTransport {
  updates:TelegramUpdate[]=[];
  fetchedOffsets:number[]=[];
  sent:string[]=[];
  keyboards:Array<unknown>=[];
  acknowledged:string[]=[];
  failSend=false;
  async getUpdates(offset:number):Promise<TelegramUpdate[]> {
    this.fetchedOffsets.push(offset);
    return this.updates.filter(x=>x.update_id>=offset);
  }
  async sendMessage(_chatId:number,text:string,keyboard?:unknown):Promise<void> {
    if(this.failSend) {this.failSend=false;throw new Error('simulated network drop');}
    this.sent.push(text);
    this.keyboards.push(keyboard);
  }
  async answerCallbackQuery(id:string):Promise<void> {this.acknowledged.push(id);}
}

const fixture=()=>{
  const dir=mkdtempSync(join(tmpdir(),'relay-telegram-'));
  const store=new Store(join(dir,'state.sqlite'));
  const agent=new FakeAgent();const engine=new Engine(store,agent);
  const m=engine.create({goal:'Telegram test',acceptance:['verifiable'],workspace:dir,
    sandbox:'read-only',mode:'supervised',maxTurns:3,requestKey:'m'});
  const transport=new FakeTransport();const bridge=new TelegramBridge(store,engine,transport,1001,2001,
    async()=>({ok:true,source:'default',message:'Mocked executor ready'}));
  const message=(id:number,text:string,user=1001,chat=2001,kind='private'):TelegramUpdate=>({update_id:id,
    message:{text,from:{id:user},chat:{id:chat,type:kind}}});
  return {dir,store,agent,engine,m,transport,bridge,message,
    cleanup:()=>{store.close();rmSync(dir,{force:true,recursive:true});}};
};

test('Telegram /help presents a short human-facing menu; rare commands remain discoverable',async()=>{
  const f=fixture();
  try{
    f.transport.updates=[f.message(51,'/help')];
    await f.bridge.pollOnce(0);
    const compact=f.transport.sent.at(-1)!;
    assert.match(compact,/send a task as a normal message/i);
    assert.match(compact,/\/build <task>/);
    assert.match(compact,/\/pause <mission-id>/);
    assert.match(compact,/\/help advanced/);
    assert.ok(compact.split('\n').length<=11);
    assert.doesNotMatch(compact,/\/goal-stage|\/goal-review|\/continue|\/resume/);
    f.transport.updates=[f.message(52,'/help advanced')];
    await f.bridge.pollOnce(0);
    const advanced=f.transport.sent.at(-1)!;
    assert.match(advanced,/\/agent/);
    assert.match(advanced,/\/resume/);
    assert.equal(f.engine.list().length,1,'help must never start a Mission');
  }finally{f.cleanup();}
});

test('status and pause work without UUID when a single task exists',async()=>{
  const f=fixture();
  try{
    f.transport.updates=[f.message(61,'/status'),f.message(62,'/pause')];
    await f.bridge.pollOnce(0);
    assert.ok(f.transport.sent.some(x=>x.includes(f.m.id)&&x.includes('Turn')));
    assert.ok(f.transport.sent.some(x=>x.includes('Pause recorded')));
    assert.equal(f.store.get(f.m.id).state,'PAUSED');
    assert.equal(f.agent.calls,0);
  }finally{f.cleanup();}
});

test('pause without UUID refuses to guess among multiple active tasks',async()=>{
  const f=fixture();
  try{
    const other=f.engine.create({goal:'Another pending task',acceptance:['No execution'],
      workspace:'',sandbox:'read-only',mode:'supervised',maxTurns:1,
      requestKey:'another-pending-task'});
    f.transport.updates=[f.message(63,'/pause')];
    await f.bridge.pollOnce(0);
    assert.ok(f.transport.sent.some(x=>x.includes('No single active task')));
    assert.equal(f.engine.get(f.m.id).state,'READY');
    assert.equal(f.engine.get(other.id).state,'READY');
  }finally{f.cleanup();}
});

test('fenced replacement Worker probes connectivity without accepting, acknowledging or sending',async()=>{
  const f=fixture();try{
    f.store.setMeta('telegram.inbox_cursor','41');
    f.transport.updates=[f.message(41,'/build should not run')];
    const beforeEvents=f.store.maxEventId();
    assert.equal(await probeFencedTelegramTransport(f.store,f.transport),false);
    assert.deepEqual(f.transport.fetchedOffsets,[]);
    const drain=f.store.requestChannelDrain('telegram');
    assert.equal(await probeFencedTelegramTransport(f.store,f.transport),true);
    assert.deepEqual(f.transport.fetchedOffsets,[41]);
    assert.equal(f.store.getMeta('telegram.inbox_cursor'),'41');
    assert.equal(f.store.maxEventId(),beforeEvents);
    assert.deepEqual(f.transport.sent,[]);
    assert.deepEqual(f.transport.acknowledged,[]);
    assert.equal(f.agent.calls,0);
    f.store.releaseChannelDrain('telegram',drain);
  }finally{f.cleanup();}
});

test('fenced transport refuses malformed cursor, invalid replies and drain loss',async()=>{
  const f=fixture();try{
    const drain=f.store.requestChannelDrain('telegram');
    f.store.setMeta('telegram.inbox_cursor','not-a-cursor');
    await assert.rejects(probeFencedTelegramTransport(f.store,f.transport),/Invalid maintenance/);
    assert.deepEqual(f.transport.fetchedOffsets,[]);
    f.store.setMeta('telegram.inbox_cursor','0');
    const invalid:TelegramTransport={...f.transport,getUpdates:async()=>null as unknown as TelegramUpdate[],
      sendMessage:f.transport.sendMessage.bind(f.transport)};
    await assert.rejects(probeFencedTelegramTransport(f.store,invalid),/no update array/);
    const lost:TelegramTransport={...f.transport,
      getUpdates:async()=>{f.store.releaseChannelDrain('telegram',drain);return f.transport.updates;},
      sendMessage:f.transport.sendMessage.bind(f.transport)};
    assert.equal(await probeFencedTelegramTransport(f.store,lost),false);
    assert.deepEqual(f.transport.sent,[]);
  }finally{f.cleanup();}
});

test('a newer fenced transport failure revokes stale healthy Worker evidence until a new success',async()=>{
  const f=fixture();try{
    const lease=f.store.acquireChannelLease('telegram');
    const drain=f.store.requestChannelDrain('telegram');
    const originalEvent=f.store.maxEventId();
    f.store.recordChannelPollSuccess('telegram');
    assert.equal(f.store.channelStatus('telegram').transportHealth,'healthy');
    await new Promise(resolve=>setTimeout(resolve,4));
    f.store.recordChannelPollFailure('telegram');
    assert.equal(f.store.channelStatus('telegram').transportHealth,'unhealthy');
    await new Promise(resolve=>setTimeout(resolve,4));
    f.store.recordChannelPollSuccess('telegram');
    assert.equal(f.store.channelStatus('telegram').transportHealth,'healthy');
    assert.equal(f.store.maxEventId(),originalEvent);
    f.store.releaseChannelDrain('telegram',drain);
    f.store.releaseChannelLease('telegram',lease);
  }finally{f.cleanup();}
});

test('verified drain release atomically binds source, PID, latest health, quiescence and original lease',async()=>{
  const f=fixture();try{
    const source='telegram',sha='a'.repeat(40);
    const lease=f.store.acquireChannelLease(source);
    const proof={sourceSha:sha,compiledTreeSha256:'b'.repeat(64),
      cliSha256:'c'.repeat(64),manifestSha256:'d'.repeat(64),fileCount:1};
    f.store.recordChannelRuntime(source,lease,proof);
    f.store.recordChannelPollSuccess(source);
    const drain=f.store.requestChannelDrain(source);
    const attestedAt=f.store.channelStatus(source).runtimeProvenance!.at;
    const leaseFingerprint=f.store.channelLeaseFingerprint(source)!;
    const admission={leaseFingerprint,expectedAttestedAt:attestedAt,
      inspectProcess:()=>{
        // The actual final OS readback runs inside BEGIN IMMEDIATE, not a
        // previously sampled mutable SQLite status or unlocked callback.
        const second=new DatabaseSync(join(f.dir,'state.sqlite'),{timeout:0});
        try {
          assert.throws(()=>second.exec('BEGIN IMMEDIATE'),/locked|BUSY/i);
        }finally{second.close();}
        return {taskVerified:true,taskState:'Running',pollerPid:process.pid,
          workerProcessVerified:true,
          workerProcessStartedAt:new Date(Date.parse(attestedAt)-1_000).toISOString(),
          workerParentStartedAt:new Date(Date.parse(attestedAt)-2_000).toISOString()};
      }};
    const refuse=(commit:string,pid:number,now?:number)=>{
      assert.throws(()=>f.store.releaseVerifiedChannelDrain(source,drain,commit,pid,admission,now),
        /Verified maintenance release/);
      assert.equal(f.store.channelDrainRequested(source),true);
    };
    refuse('f'.repeat(40),process.pid);
    refuse(sha,process.pid+10);
    await new Promise(resolve=>setTimeout(resolve,4));
    f.store.recordChannelPollFailure(source);
    refuse(sha,process.pid);
    await new Promise(resolve=>setTimeout(resolve,4));
    f.store.recordChannelPollSuccess(source);
    const success=Date.parse(f.store.channelStatus(source).lastPollSuccessAt!);
    refuse(sha,process.pid,success+15_001);
    f.store.setMeta('telegram.notifications_cursor','0');
    // The fixture starts with a Mission event, so this cursor is behind.
    refuse(sha,process.pid);
    f.store.setMeta('telegram.notifications_cursor',String(f.store.maxEventId()));
    assert.throws(()=>f.store.releaseVerifiedChannelDrain(source,drain,sha,process.pid,{
      ...admission,leaseFingerprint:'0'.repeat(64)}),/Verified maintenance release/);
    assert.equal(f.store.channelDrainId(source),drain);
    assert.throws(()=>f.store.releaseVerifiedChannelDrain(source,drain,sha,process.pid,
      admission,success+14_999,()=>success+15_001),
    /transport proof expired during process inspection/);
    assert.equal(f.store.channelDrainId(source),drain);
    f.store.releaseVerifiedChannelDrain(source,drain,sha,process.pid,admission);
    assert.equal(f.store.channelDrainRequested(source),false);
    assert.throws(()=>f.store.releaseVerifiedChannelDrain(source,drain,sha,process.pid,admission),/identity mismatch/);
    f.store.releaseChannelLease(source,lease);
  }finally{f.cleanup();}
});

test('verified drain rejects same-PID recycled process and retains its original fence',()=>{
  const f=fixture();try{
    const source='telegram',sha='a'.repeat(40);
    const lease=f.store.acquireChannelLease(source);
    f.store.recordChannelRuntime(source,lease,{
      sourceSha:sha,compiledTreeSha256:'b'.repeat(64),
      cliSha256:'c'.repeat(64),manifestSha256:'d'.repeat(64),fileCount:1});
    f.store.recordChannelPollSuccess(source);
    f.store.setMeta('telegram.notifications_cursor',String(f.store.maxEventId()));
    const drain=f.store.requestChannelDrain(source);
    const at=f.store.channelStatus(source).runtimeProvenance!.at;
    const leaseFingerprint=f.store.channelLeaseFingerprint(source)!;
    assert.throws(()=>f.store.releaseVerifiedChannelDrain(source,drain,sha,process.pid,{
      leaseFingerprint,expectedAttestedAt:at,
      inspectProcess:()=>({taskVerified:true,taskState:'Running',pollerPid:process.pid,
        workerProcessVerified:true,
        workerProcessStartedAt:new Date(Date.parse(at)+1).toISOString(),
        workerParentStartedAt:new Date(Date.parse(at)-1_000).toISOString()}),
    }),/process incarnation changed/);
    assert.equal(f.store.channelDrainId(source),drain);
    assert.throws(()=>f.store.releaseVerifiedChannelDrain(source,drain,sha,process.pid,{
      leaseFingerprint,expectedAttestedAt:at,
      inspectProcess:()=>({taskVerified:true,taskState:'Running',pollerPid:process.pid,
        workerProcessVerified:true,workerProcessStartedAt:at,
        workerParentStartedAt:new Date(Date.parse(at)-1_000).toISOString()}),
    }),/process incarnation changed/);
    assert.equal(f.store.channelDrainId(source),drain);
    assert.throws(()=>f.store.releaseVerifiedChannelDrain(source,drain,sha,process.pid,{
      leaseFingerprint,expectedAttestedAt:at,
      inspectProcess:()=>({taskVerified:true,taskState:'Running',pollerPid:process.pid,
        workerProcessVerified:true,
        workerProcessStartedAt:new Date(Date.parse(at)-1_000).toISOString(),
        workerParentStartedAt:new Date(Date.parse(at)-500).toISOString()}),
    }),/process incarnation changed/);
    assert.equal(f.store.channelDrainId(source),drain);
    assert.throws(()=>f.store.releaseVerifiedChannelDrain(source,drain,sha,process.pid,{
      leaseFingerprint,expectedAttestedAt:at,inspectProcess:()=>{throw new Error('CIM unavailable');},
    }),/process identity unavailable/);
    assert.equal(f.store.channelDrainId(source),drain);
    f.store.releaseChannelDrain(source,drain);
    f.store.releaseChannelLease(source,lease);
  }finally{f.cleanup();}
});

test('malformed failed-probe metadata never inherits an earlier healthy lease',()=>{
  const f=fixture();try{
    const lease=f.store.acquireChannelLease('telegram');
    f.store.recordChannelPollSuccess('telegram');
    for(const malformed of ['{}','null','[]','{"pid":4}','{"pid":'+process.pid+',"at":"bad"}']){
      f.store.setMeta('telegram.poll_failure',malformed);
      assert.equal(f.store.channelStatus('telegram').transportHealth,'unhealthy',malformed);
    }
    f.store.releaseChannelLease('telegram',lease);
  }finally{f.cleanup();}
});

test('settled Mission archive preserves audit history and refuses uncertain/active records',()=>{
  const f=fixture();try{
    const done=f.engine.create({goal:'Completed old test',acceptance:['done'],workspace:'',
      sandbox:'read-only',mode:'supervised',maxTurns:1,requestKey:'settled-old'});
    f.store.update(done.id,done.version,{state:'COMPLETED'},'verification.accepted',{reason:'test'});
    const paused=f.engine.create({goal:'Old completed browser test',acceptance:['done'],workspace:'',
      sandbox:'read-only',mode:'supervised',maxTurns:2,requestKey:'paused-done'});
    f.store.update(paused.id,paused.version,{state:'PAUSED',lastSummary:'Verified result\n[MISSION_RELAY:DONE]'},
      'chatgpt.browser_run_finished',{});
    const uncertain=f.engine.create({goal:'Uncertain browser request',acceptance:['inspect'],workspace:'',
      sandbox:'read-only',mode:'supervised',maxTurns:2,requestKey:'uncertain-test'});
    f.store.update(uncertain.id,uncertain.version,{state:'NEEDS_RECONCILIATION'},
      'chatgpt.browser_uncertain',{});
    const count=f.store.archiveSettledMissions();
    assert.equal(count.archived,2);
    assert.equal(f.store.isMissionArchived(done.id),true);
    assert.equal(f.store.isMissionArchived(paused.id),true);
    assert.equal(f.store.isMissionArchived(f.m.id),false);
    assert.equal(f.store.isMissionArchived(uncertain.id),false);
    assert.equal(f.store.archiveSettledMissions().archived,0);
    assert.equal(f.store.get(done.id).state,'COMPLETED');
    assert.equal(f.store.events(done.id).at(-1)?.type,'mission.archived');
    assert.ok(f.store.events(done.id).some(e=>e.type==='verification.accepted'));
  }finally{f.cleanup();}
});

test('archive-settled never hides a PI LIMIT/NEXT while its 32-turn successor still needs work',()=>{
  const f=fixture();try{
    const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
    const parent=f.engine.create({goal:'Multi-mission audit not yet complete',
      acceptance:['One more mission must finish'],workspace:'',
      sandbox:'read-only',mode:'supervised',maxTurns:32,requestKey:'limit-unfinished'});
    const linked=f.store.linkChat(parent.id,'https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174000',
      parent.version).mission;
    const bound=f.store.bindChatBrowser(parent.id,'install:Chrome:test',linked.version).mission;
    f.store.setMeta(`pi.autopilot.enabled.${parent.id}`,'1');
    const ready=f.store.update(parent.id,bound.version,{state:'PAUSED',turnCount:31},
      'test.previous_verified_rounds',{});
    const answer='Stage 32 completed; owner goal remains unfinished\n[MISSION_RELAY:NEXT]';
    f.store.reserveChatBrowserTurn(parent.id,ready.version,'limit-stage-32',sha('verified prompt'));
    f.store.finishChatBrowserTurn(parent.id,'limit-stage-32',{
      kind:'observed',assistantSha256:sha(answer),summary:answer,
      telegramBatch:{terminal:true,flowSignal:'NEXT',piManaged:true}});
    f.store.commitPiPlan(parent.id,sha(answer),[],{
      action:'NEXT',summary:'Further work must continue',nextPrompt:'Proceed to successor'});
    assert.equal(f.store.get(parent.id).turnCount,32);
    assert.equal(f.store.get(parent.id).state,'PAUSED');
    assert.equal((f.store.events(parent.id).find(e=>e.type==='pi.autopilot_finished')?.payload as
      {action:string}).action,'LIMIT');
    const before=f.store.maxEventId();
    f.store.archiveSettledMissions();
    assert.equal(f.store.isMissionArchived(parent.id),false,
      'LIMIT is a continuation checkpoint, not a settled Mission');
    assert.equal(f.store.maxEventId(),before,
      'The unfinished parent must not acquire an archive audit event');
    const child=f.store.createPiSuccessor(parent.id);
    assert.ok(child);
    f.store.archiveSettledMissions();
    assert.equal(f.store.isMissionArchived(parent.id),false,
      'A READY child does not prove the unfinished owner goal was satisfied');
    assert.equal(f.store.isMissionArchived(child.id),false);

    // A fully observed PI DONE remains archiveable (unlike LIMIT).
    const done=f.engine.create({goal:'A separate verified one-turn task',
      acceptance:['Complete task'],workspace:'',sandbox:'read-only',
      mode:'supervised',maxTurns:1,requestKey:'pi-done-archive'});
    const durl=f.store.linkChat(done.id,'https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174001',
      done.version).mission;
    f.store.setMeta(`pi.autopilot.enabled.${done.id}`,'1');
    const doneAnswer='Verified result\n[MISSION_RELAY:DONE]';
    f.store.reserveChatBrowserTurn(done.id,durl.version,'pi-done-send',sha('other prompt'));
    f.store.finishChatBrowserTurn(done.id,'pi-done-send',{
      kind:'observed',assistantSha256:sha(doneAnswer),summary:doneAnswer});
    f.store.commitPiPlan(done.id,sha(doneAnswer),[],{
      action:'DONE',summary:'Owner task completed',nextPrompt:''});
    f.store.archiveSettledMissions();
    assert.equal(f.store.isMissionArchived(done.id),true);
    assert.equal(f.store.isMissionArchived(parent.id),false);
  }finally{f.cleanup();}
});

test('Telegram /list shows actionable Missions and /history shows archived ones',async()=>{
  const f=fixture();try{
    const old=f.engine.create({goal:'Old settled study',acceptance:['done'],workspace:'',
      sandbox:'read-only',mode:'supervised',maxTurns:1,requestKey:'old-study'});
    f.store.update(old.id,old.version,{state:'COMPLETED'},'verification.accepted',{});
    f.store.archiveSettledMissions();
    f.transport.updates=[f.message(1,'/list'),f.message(2,'/history')];
    await f.bridge.pollOnce(0);
    assert.equal(f.transport.sent.length,2);
    assert.match(f.transport.sent[0]!,/Missions requiring attention/);
    assert.ok(f.transport.sent[0]!.includes(f.m.id));
    assert.ok(!f.transport.sent[0]!.includes(old.id));
    assert.match(f.transport.sent[1]!,/Recent Mission history/);
    assert.ok(f.transport.sent[1]!.includes(old.id));
    assert.match(f.transport.sent[1]!,/archived/);
  }finally{f.cleanup();}
});

test('Telegram list prioritizes old reconciliation and pages all tasks and audit history',async()=>{
  const f=fixture();try{
    const uncertain=f.engine.create({goal:'Old uncertain browser Send',acceptance:['reconcile'],
      workspace:'',sandbox:'read-only',mode:'supervised',maxTurns:32,requestKey:'old-uncertain'});
    f.store.update(uncertain.id,uncertain.version,{state:'NEEDS_RECONCILIATION'},
      'chatgpt.browser_uncertain',{});
    const ready=[];
    for(let i=0;i<12;i++)ready.push(f.engine.create({goal:`New READY ${i}`,acceptance:['test'],
      workspace:'',sandbox:'read-only',mode:'supervised',maxTurns:2,requestKey:`ready-${i}`}));
    for(let i=0;i<9;i++){
      const done=f.engine.create({goal:`Historic completed ${i}`,acceptance:['test'],
        workspace:'',sandbox:'read-only',mode:'supervised',maxTurns:1,requestKey:`done-${i}`});
      f.store.update(done.id,done.version,{state:'COMPLETED'},'verification.accepted',{});
    }
    f.store.archiveSettledMissions();
    f.transport.updates=[f.message(1,'/list'),f.message(2,'/list 2'),
      f.message(3,'/history'),f.message(4,'/history 3')];
    await f.bridge.pollOnce(0);
    assert.equal(f.transport.sent.length,4);
    const [first,second,historyFirst,historyLast]=f.transport.sent;
    assert.match(first!,/Missions requiring attention: Page 1\/2 \(14 total\)/);
    assert.ok(first!.includes(uncertain.id),'Old uncertain Mission must outrank newer READY tasks');
    assert.match(first!,/NEEDS_RECONCILIATION · turn 0\/32/);
    assert.match(second!,/Missions requiring attention: Page 2\/2/);
    assert.ok(second!.includes(f.m.id),'Oldest READY task must be accessible on the second page');
    assert.match(historyFirst!,/Recent Mission history: Page 1\/3 \(23 total/);
    assert.match(historyLast!,/Recent Mission history: Page 3\/3/);
    assert.ok(historyLast!.includes(f.m.id),'History includes the full ledger, not just settled records');
    const next=(f.transport.keyboards[0] as {inline_keyboard:Array<Array<{callback_data:string}>>})
      .inline_keyboard.flat().find(button=>button.callback_data==='mr:list:2');
    assert.ok(next,'First page has an authenticated read-only next-page button');
    assert.equal(telegramCallbackCommand('mr:history:3'),'/history 3');
    assert.throws(()=>telegramCallbackCommand('mr:list:0'),/Unknown/);
    assert.throws(()=>telegramCallbackCommand('mr:list:99999999999999999999'),/Unknown/);
    f.transport.updates=[f.message(5,'/list 3'),f.message(6,'/history -1')];
    await f.bridge.pollOnce(0);
    assert.match(f.transport.sent[4]!,/Page out of range/);
    assert.match(f.transport.sent[5]!,/Expected a positive page number/);
    const pageCallback:TelegramUpdate={update_id:7,callback_query:{id:'page-next',data:'mr:list:2',
      from:{id:1001},message:{chat:{id:2001,type:'private'}}}};
    f.transport.updates=[pageCallback];
    await f.bridge.pollOnce(0);
    assert.match(f.transport.sent[6]!,/Missions requiring attention: Page 2\/2/);
    assert.deepEqual(f.transport.acknowledged,['page-next']);
    await f.bridge.pollOnce(0);
    assert.equal(f.transport.sent.length,7,'Callback retry cannot append a second reply');
    assert.equal(f.store.get(uncertain.id).state,'NEEDS_RECONCILIATION');
    assert.equal(f.store.events(uncertain.id).filter(e=>e.type==='chatgpt.browser_uncertain').length,1);
  }finally{f.cleanup();}
});

test('Telegram list does not inherit the 20-row pi-health diagnostic cap',async()=>{
  const f=fixture();try{
    const checkpoints=[];
    for(let i=0;i<24;i++){
      const m=f.engine.create({goal:`PI checkpoint ${i}`,acceptance:['review'],
        workspace:'',sandbox:'read-only',mode:'supervised',maxTurns:32,requestKey:`checkpoint-${i}`});
      f.store.update(m.id,m.version,{state:'PAUSED'},'pi.autopilot_interrupted',{});
      f.store.setMeta(`pi.autopilot.enabled.${m.id}`,'1');
      checkpoints.push(m);
    }
    // Force an identical timestamp: wall-clock millisecond precision must not
    // determine which Mission appears on the last page after a restart.
    const tie=f.store.db.prepare('UPDATE missions SET created_at=? WHERE id=?');
    for(const m of checkpoints)tie.run('2026-01-01T00:00:00.000Z',m.id);
    assert.equal(f.store.piHealth().totalOutstanding,24);
    assert.equal(f.store.piHealth().missions.length,20);
    f.transport.updates=[f.message(1,'/list 4')];
    await f.bridge.pollOnce(0);
    assert.match(f.transport.sent[0]!,/Missions requiring attention: Page 4\/4 \(25 total\)/);
    assert.ok(f.transport.sent[0]!.includes(checkpoints[0]!.id));
    assert.equal(f.store.get(checkpoints[0]!.id).state,'PAUSED');
    assert.equal(f.store.getMeta(`pi.autopilot.enabled.${checkpoints[0]!.id}`),'1');
  }finally{f.cleanup();}
});

test('Telegram task cards offer authenticated read-only inline navigation, without a second writer',async()=>{
  const f=fixture();try{
    f.transport.updates=[f.message(10,'/list')];
    await f.bridge.pollOnce(0);
    const markup=f.transport.keyboards[0] as {inline_keyboard:Array<Array<{text:string;callback_data:string}>>};
    assert.ok(markup.inline_keyboard.some(row=>row.some(btn=>btn.callback_data===`mr:status:${f.m.id}`)));
    assert.ok(markup.inline_keyboard.some(row=>row.some(btn=>btn.callback_data==='mr:history')));
    const view:TelegramUpdate={update_id:11,callback_query:{id:'cb-read-11',data:`mr:status:${f.m.id}`,
      from:{id:1001},message:{chat:{id:2001,type:'private'}}}};
    const spoofed:TelegramUpdate={update_id:12,callback_query:{...view.callback_query!,id:'cb-other',
      from:{id:999}}};
    f.transport.updates=[view,spoofed];
    await f.bridge.pollOnce(0);
    assert.equal(f.transport.sent.length,2);
    assert.match(f.transport.sent[1]!,/Turn 0\/3/);
    assert.deepEqual(f.transport.acknowledged,['cb-read-11']);
    await f.bridge.pollOnce(0);
    assert.equal(f.transport.sent.length,2,'Duplicate callback must not generate another message');
    assert.equal(f.store.get(f.m.id).state,'READY');
    assert.throws(()=>telegramCallbackCommand('mr:pause:untrusted'),/Unknown/);
    assert.equal(telegramKeyboardForReply('unrelated text'),undefined);
  }finally{f.cleanup();}
});

test('pi-health reports exact browser/PI progress without revealing private goals or messages',()=>{
  const f=fixture();try{
    const linked=f.store.linkChat(f.m.id,'https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174000',f.m.version).mission;
    const bound=f.store.bindChatBrowser(f.m.id,'install:Chrome:private',linked.version).mission;
    f.store.setMeta(`pi.autopilot.enabled.${f.m.id}`,'1');
    const sha=createHash('sha256').update('private submitted user prompt').digest('hex');
    f.store.reserveChatBrowserTurn(f.m.id,bound.version,'private-request-1',sha);
    const original=f.store.chatBrowserTurn(f.m.id)!;
    const before=f.store.maxEventId();
    const health=f.store.piHealth(Date.parse(original.createdAt)+27_000);
    assert.equal(health.totalOutstanding,1);
    assert.equal(health.missions.length,1);
    const item=health.missions[0]!;
    assert.equal(item.state,'RUNNING');
    assert.equal(item.turnCount,0);
    assert.equal(item.browserReceipt,'reserved');
    assert.equal(item.browserNewChatReserved,false);
    assert.equal(item.browserReservationAgeSeconds,27);
    assert.equal(item.phase,'browser_answer_pending_do_not_resend');
    assert.equal(item.receiptHasFullAnswerHash,false);
    assert.equal(item.ownerProcessMatchesPoller,false);
    assert.equal(item.lastEvent,'chatgpt.browser_reserved');
    assert.equal(f.store.maxEventId(),before);
    const serialized=JSON.stringify(health);
    for(const privateValue of ['Telegram test','private submitted user prompt','private-request-1',
      'install:Chrome:private','chatgpt.com',sha])assert.ok(!serialized.includes(privateValue));
    const answer='Private response with [MISSION_RELAY:NEXT]';
    f.store.finishChatBrowserTurn(f.m.id,'private-request-1',{kind:'observed',
      assistantSha256:createHash('sha256').update(answer).digest('hex'),summary:answer});
    const after=f.store.piHealth();
    assert.equal(after.missions[0]?.phase,'awaiting_pi_review');
    assert.equal(after.missions[0]?.turnCount,1);
    assert.equal(after.missions[0]?.currentChatObservedTurns,1);
    assert.equal(after.missions[0]?.receiptHasFullAnswerHash,true);
    assert.equal(after.missions[0]?.browserNewChatReserved,false);
    f.store.commitPiPlan(f.m.id,createHash('sha256').update(answer).digest('hex'),[],
      {action:'DONE',summary:'All verified',nextPrompt:''});
    assert.equal(f.store.piHealth().totalOutstanding,0);
  }finally{f.cleanup();}
});

test('read-only diagnostics distinguish new-chat reservation from an observed migration',async()=>{
  const f=fixture();try{
    const linked=f.store.linkChat(f.m.id,'https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174000',f.m.version).mission;
    const bound=f.store.bindChatBrowser(f.m.id,'install:Chrome:private',linked.version).mission;
    f.store.setMeta(`pi.autopilot.enabled.${f.m.id}`,'1');
    const before=f.store.maxEventId();
    f.store.reserveChatBrowserTurn(f.m.id,bound.version,'new-chat-reserved',
      createHash('sha256').update('sensitive prompt').digest('hex'),{newConversation:true});
    const afterReservation=f.store.maxEventId();
    assert.equal(afterReservation,before+1);
    const health=f.store.piHealth();
    assert.equal(health.missions[0]?.browserNewChatReserved,true);
    assert.equal(health.missions[0]?.turnCount,0);
    const {inspectPiEvidence}=await import('../src/core/pi-evidence.js');
    const evidence=inspectPiEvidence(f.store,f.m.id);
    assert.equal(evidence.pendingBrowserRequest,true);
    assert.equal(evidence.pendingNewChatReservation,true);
    assert.equal(evidence.chatSegments,0);
    f.transport.updates=[f.message(740,`/status ${f.m.id}`)];
    await f.bridge.pollOnce(0);
    assert.match(f.transport.sent.join('\n'),/New Chat: reserved only/);
    assert.equal(f.store.maxEventId(),afterReservation,
      'Read-only diagnostics must not create new events or credit an answer');
    for(const secret of ['sensitive prompt','new-chat-reserved','chatgpt.com'])
      assert.ok(!JSON.stringify(health).includes(secret));
  }finally{f.cleanup();}
});

test('pi-health distinguishes an ambiguous browser request from a healthy Telegram connection',()=>{
  const f=fixture();try{
    const linked=f.store.linkChat(f.m.id,'https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174000',f.m.version).mission;
    const bound=f.store.bindChatBrowser(f.m.id,'install:Chrome:private',linked.version).mission;
    f.store.setMeta(`pi.autopilot.enabled.${f.m.id}`,'1');
    f.store.reserveChatBrowserTurn(f.m.id,bound.version,'private-uncertain',
      createHash('sha256').update('private prompt').digest('hex'));
    f.store.finishChatBrowserTurn(f.m.id,'private-uncertain',{
      kind:'uncertain',error:'UI reply cannot be attributed'});
    const status=f.store.piHealth();
    assert.equal(status.totalOutstanding,1);
    assert.equal(status.missions[0]?.browserReceipt,'uncertain');
    assert.equal(status.missions[0]?.phase,'reconciliation_required_do_not_resend');
    assert.equal(status.missions[0]?.browserReservationAgeSeconds,null);
    assert.equal(status.missions[0]?.state,'NEEDS_RECONCILIATION');
  }finally{f.cleanup();}
});

test('authenticated Telegram status exposes bounded in-flight PI phase without suggesting a duplicate Send',async()=>{
  const f=fixture();try{
    const linked=f.store.linkChat(f.m.id,'https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174000',f.m.version).mission;
    const bound=f.store.bindChatBrowser(f.m.id,'install:Chrome:private',linked.version).mission;
    f.store.setMeta(`pi.autopilot.enabled.${f.m.id}`,'1');
    f.store.reserveChatBrowserTurn(f.m.id,bound.version,'private-reservation',
      createHash('sha256').update('very private browser prompt').digest('hex'));
    f.transport.updates=[f.message(739,`/status ${f.m.id}`)];
    await f.bridge.pollOnce(0);
    const output=f.transport.sent.join('\n');
    assert.match(output,/Current Chat observed sends: 0\/10/);
    assert.match(output,/Controller phase: browser_answer_pending_do_not_resend/);
    assert.match(output,/Current browser request age: \d+s/);
    assert.match(output,/not proof of a stall; do not resend/);
    assert.ok(!output.includes('very private browser prompt'));
    assert.ok(!output.includes('private-reservation'));
    assert.equal(f.store.chatBrowserTurn(f.m.id)?.status,'reserved');
  }finally{f.cleanup();}
});

test('Telegram accepts only allowlisted numeric user and private chat',async()=>{
  const f=fixture();try {
    f.transport.updates=[f.message(1,`/pause ${f.m.id}`,999),f.message(2,`/pause ${f.m.id}`,1001,2001,'group'),
      f.message(3,`/status ${f.m.id}`)];
    await f.bridge.pollOnce(0);
    assert.equal(f.engine.get(f.m.id).state,'READY');
    assert.equal(f.transport.sent.length,1);
    assert.match(f.transport.sent[0]!,/READY/);
    assert.equal(f.store.getMeta('telegram.inbox_cursor'),'4');
  }finally{f.cleanup();}
});

test('Telegram duplicate update never repeats an action',async()=>{
  const f=fixture();try {
    f.transport.updates=[f.message(10,`/pause ${f.m.id}`)];
    await f.bridge.pollOnce(0);
    assert.equal(f.engine.get(f.m.id).state,'PAUSED');
    assert.equal(f.store.events(f.m.id).filter(x=>x.type==='mission.paused').length,1);
    await f.bridge.pollOnce(0);
    assert.equal(f.store.events(f.m.id).filter(x=>x.type==='mission.paused').length,1);
    assert.equal(f.store.getMeta('telegram.inbox_cursor'),'11');
  }finally{f.cleanup();}
});

test('Telegram retries failed replies but not commands',async()=>{
  const f=fixture();try {
    f.transport.updates=[f.message(11,`/pause ${f.m.id}`)];
    f.transport.failSend=true;
    await assert.rejects(f.bridge.pollOnce(0),/network drop/);
    assert.equal(f.engine.get(f.m.id).state,'PAUSED');
    await f.bridge.pollOnce(0);
    assert.equal(f.store.events(f.m.id).filter(x=>x.type==='mission.paused').length,1);
    assert.match(f.transport.sent[0]!,/PAUSED/);
  }finally{f.cleanup();}
});

test('Reserved command surviving restart is flagged uncertain instead of replayed',async()=>{
  const f=fixture();try {
    assert.equal(f.store.reserveChannelCommand('telegram','25',26),true);
    f.transport.updates=[];
    await f.bridge.pollOnce(0);
    assert.equal(f.engine.get(f.m.id).state,'READY');
    assert.match(f.transport.sent[0]!,/interrupted before acknowledgement/);
    assert.equal(f.store.pendingChannelReplies('telegram').length,0);
  }finally{f.cleanup();}
});

test('Mission notification is emitted only for new terminal events',async()=>{
  const f=fixture();try {
    await f.bridge.pollOnce(0); // initialize notification cursor at existing history
    f.engine.pause(f.m.id);
    await f.bridge.pollOnce(0);
    assert.equal(f.transport.sent.length,1);
    assert.match(f.transport.sent[0]!,/mission.paused/);
    await f.bridge.pollOnce(0);
    assert.equal(f.transport.sent.length,1);
  }finally{f.cleanup();}
});

test('Telegram reports a compact browser reply tail and real turn count without full output',async()=>{
  const f=fixture();try {
    await f.bridge.pollOnce(0); // Establish cursor before the synthetic new observation.
    const url='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174000';
    const linked=f.store.linkChat(f.m.id,url,f.m.version).mission;
    const longResult=['Top of a longer model response not for Telegram',
      ...Array.from({length:12},(_,i)=>`Final action item ${i+1}`),'[MISSION_RELAY:NEXT]'].join('\n');
    f.store.reserveChatBrowserTurn(linked.id,linked.version,'notify-browser',
      'a'.repeat(64));
    f.store.finishChatBrowserTurn(linked.id,'notify-browser',{
      kind:'observed',assistantSha256:'b'.repeat(64),summary:longResult});
    const events=f.store.events(linked.id);
    const event=events.find(e=>e.type==='chatgpt.browser_observed')!;
    const message=formatBrowserResultNotification(f.store.get(linked.id),event);
    assert.ok(message.includes('turn 1/3'));
    assert.ok(message.includes('Final action item 12'));
    assert.ok(message.includes('[MISSION_RELAY:NEXT]'));
    assert.ok(!message.includes('Top of a longer model response'));
    assert.ok(!message.includes('Final action item 1\n'));
    assert.ok(message.split('\n').length<=10);
    await f.bridge.pollOnce(0);
    const pushed=f.transport.sent.find(x=>x.includes('Final action item 12'));
    assert.equal(pushed,message);
    await f.bridge.pollOnce(0);
    assert.equal(f.transport.sent.filter(x=>x.includes('Final action item 12')).length,1);
  }finally{f.cleanup();}
});

test('Telegram multi-turn ChatGPT continuation delivers one final compact summary, never intermediate NEXT/HANDOFF turns',async()=>{
  const f=fixture();try {
    await f.bridge.pollOnce(0);
    const url='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174000';
    const m=f.store.linkChat(f.m.id,url,f.m.version).mission;
    const first=f.store.reserveChatBrowserTurn(m.id,m.version,'telegram-900-1','a'.repeat(64));
    const one=f.store.finishChatBrowserTurn(m.id,'telegram-900-1',{
      kind:'observed',assistantSha256:'b'.repeat(64),
      summary:'First interim status\n[MISSION_RELAY:NEXT]',
      telegramBatch:{terminal:false,flowSignal:'NEXT'},
    });
    assert.equal(one.turnCount,1);
    await f.bridge.pollOnce(0);
    assert.equal(f.transport.sent.length,0,'Intermediate NEXT must not notify Telegram');
    const two=f.store.reserveChatBrowserTurn(m.id,one.version,'telegram-900-2','c'.repeat(64));
    const done=f.store.finishChatBrowserTurn(m.id,'telegram-900-2',{
      kind:'observed',assistantSha256:'d'.repeat(64),
      summary:'Telegram-ready summary\nProgress: done\nEvidence: final receipt\nNext: inspect status\n[MISSION_RELAY:DONE]',
      telegramBatch:{terminal:true,flowSignal:'DONE'},
    });
    assert.equal(done.turnCount,2);
    const events=f.store.events(m.id);
    assert.equal(events.filter(x=>x.type==='chatgpt.browser_observed').length,2);
    assert.equal(events.filter(x=>x.type==='chatgpt.browser_run_finished').length,1);
    const final=events.find(x=>x.type==='chatgpt.browser_run_finished')!;
    assert.equal((final.payload as {requestKey:string}).requestKey,'telegram-900-2');
    assert.equal((final.payload as {assistantSha256:string}).assistantSha256,'d'.repeat(64));
    await f.bridge.pollOnce(0);
    assert.equal(f.transport.sent.length,1);
    assert.match(f.transport.sent[0]!,/Progress: done/);
    assert.match(f.transport.sent[0]!,/Evidence: final receipt/);
    assert.match(f.transport.sent[0]!,/\[MISSION_RELAY:DONE\]/);
    assert.doesNotMatch(f.transport.sent[0]!,/First interim status/);
    assert.ok(f.transport.sent[0]!.split('\n').length<=10);
    await f.bridge.pollOnce(0);
    assert.equal(f.transport.sent.length,1,'Notification cursor prevents duplicate final message');
  }finally{f.cleanup();}
});

test('Telegram single-turn capped NEXT still has one durable final notification',async()=>{
  const f=fixture();try {
    await f.bridge.pollOnce(0);
    const m=f.store.linkChat(f.m.id,'https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174000',f.m.version).mission;
    f.store.reserveChatBrowserTurn(m.id,m.version,'telegram-901-1','a'.repeat(64));
    f.store.finishChatBrowserTurn(m.id,'telegram-901-1',{
      kind:'observed',assistantSha256:'b'.repeat(64),
      summary:'Need operator to continue later\n[MISSION_RELAY:NEXT]',
      telegramBatch:{terminal:true,flowSignal:'NEXT'},
    });
    await f.bridge.pollOnce(0);
    assert.equal(f.transport.sent.length,1);
    assert.match(f.transport.sent[0]!,/Need operator to continue later/);
    assert.match(f.transport.sent[0]!,/\[MISSION_RELAY:NEXT\]/);
  }finally{f.cleanup();}
});

test('A failed Telegram final notification is retried from SQLite without repeating a browser turn',async()=>{
  const f=fixture();try {
    await f.bridge.pollOnce(0);
    const m=f.store.linkChat(f.m.id,'https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174000',f.m.version).mission;
    f.store.reserveChatBrowserTurn(m.id,m.version,'telegram-902-1','a'.repeat(64));
    f.store.finishChatBrowserTurn(m.id,'telegram-902-1',{
      kind:'observed',assistantSha256:'b'.repeat(64),
      summary:'Completed once\n[MISSION_RELAY:DONE]',
      telegramBatch:{terminal:true,flowSignal:'DONE'},
    });
    f.transport.failSend=true;
    await assert.rejects(f.bridge.pollOnce(0),/network drop/);
    assert.equal(f.transport.sent.length,0);
    await f.bridge.pollOnce(0);
    assert.equal(f.transport.sent.length,1);
    assert.match(f.transport.sent[0]!,/Completed once/);
    await f.bridge.pollOnce(0);
    assert.equal(f.transport.sent.length,1);
    assert.equal(f.store.events(m.id).filter(x=>x.type==='chatgpt.browser_reserved').length,1);
    assert.equal(f.store.events(m.id).filter(x=>x.type==='chatgpt.browser_run_finished').length,1);
  }finally{f.cleanup();}
});

test('An ambiguous Telegram continuation reports only its uncertainty, not a false final result',async()=>{
  const f=fixture();try {
    await f.bridge.pollOnce(0);
    const m=f.store.linkChat(f.m.id,'https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174000',f.m.version).mission;
    f.store.reserveChatBrowserTurn(m.id,m.version,'telegram-903-1','a'.repeat(64));
    f.store.finishChatBrowserTurn(m.id,'telegram-903-1',{
      kind:'observed',assistantSha256:'b'.repeat(64),
      summary:'Intermediate work\n[MISSION_RELAY:NEXT]',
      telegramBatch:{terminal:false,flowSignal:'NEXT'},
    });
    await f.bridge.pollOnce(0);
    assert.equal(f.transport.sent.length,0);
    const current=f.store.get(m.id);
    f.store.reserveChatBrowserTurn(m.id,current.version,'telegram-903-2','c'.repeat(64));
    f.store.finishChatBrowserTurn(m.id,'telegram-903-2',{
      kind:'uncertain',error:'Relay disconnected after sending',
    });
    await f.bridge.pollOnce(0);
    assert.equal(f.transport.sent.length,1);
    assert.match(f.transport.sent[0]!,/NEEDS_RECONCILIATION/);
    assert.doesNotMatch(f.transport.sent[0]!,/Intermediate work|Relay disconnected/);
    assert.equal(f.store.events(m.id).filter(x=>x.type==='chatgpt.browser_run_finished').length,0);
  }finally{f.cleanup();}
});

test('Atomic Telegram final notification rollback preserves reserved turn and cannot falsely report success',()=>{
  const f=fixture();try {
    const m=f.store.linkChat(f.m.id,'https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174000',f.m.version).mission;
    const running=f.store.reserveChatBrowserTurn(m.id,m.version,'telegram-rollback-1','a'.repeat(64));
    f.store.db.exec(`CREATE TRIGGER fail_telegram_batch BEFORE INSERT ON events
      WHEN NEW.type='chatgpt.browser_run_finished'
      BEGIN SELECT RAISE(ABORT,'injected batch failure'); END`);
    assert.throws(()=>f.store.finishChatBrowserTurn(m.id,'telegram-rollback-1',{
      kind:'observed',assistantSha256:'b'.repeat(64),
      summary:'Reply seems done\n[MISSION_RELAY:DONE]',
      telegramBatch:{terminal:true,flowSignal:'DONE'},
    }),/injected batch failure/);
    assert.equal(f.store.get(m.id).version,running.version);
    assert.equal(f.store.get(m.id).turnCount,0);
    assert.equal(f.store.chatBrowserTurn(m.id)?.status,'reserved');
    assert.equal(f.store.events(m.id).filter(x=>x.type==='chatgpt.browser_observed').length,0);
    assert.equal(f.store.events(m.id).filter(x=>x.type==='chatgpt.browser_run_finished').length,0);
  }finally{f.cleanup();}
});

test('Telegram preferentially extracts the explicit decision summary, redacts private links and sends at most ten lines',()=>{
  const f=fixture();try {
    const linked=f.store.linkChat(f.m.id,'https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174000',f.m.version).mission;
    const verbose=[
      'Earlier background discussion',
      ...Array.from({length:15},(_,i)=>`Technical detail ${i}`),
      '## **Telegram-ready summary:**',
      'Progress: reviewed the authorized single-tab workflow',
      'Evidence: local SQLite receipt and page hash matched',
      'Blocker: waiting for operator approval',
      'Next: check status then decide whether to resume',
      'Private: https://example.net/remote-control#secret-tunnel-token',
      '[MISSION_RELAY:BLOCKED]',
    ].join('\n');
    const ev={id:999,missionId:linked.id,type:'chatgpt.browser_observed',
      createdAt:'2026-11-04',payload:{round:2,excerpt:verbose}};
    const message=formatBrowserResultNotification(linked,ev);
    assert.match(message,/turn 2\/3/);
    assert.match(message,/Progress: reviewed/);
    assert.match(message,/Evidence: local SQLite/);
    assert.match(message,/Blocker: waiting/);
    assert.match(message,/Next: check status/);
    assert.match(message,/\[MISSION_RELAY:BLOCKED\]/);
    assert.doesNotMatch(message,/Earlier background|Technical detail|secret-tunnel-token/);
    assert.match(message,/\[PRIVATE LINK\]/);
    assert.ok(message.split('\n').length<=10);
  }finally{f.cleanup();}
});

test('Telegram browser notification redacts recognizable tokens and refuses uncertain details',()=>{
  const f=fixture();try {
    const linked=f.store.linkChat(f.m.id,'https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174000',
      f.m.version).mission;
    const secret='sk-proj-'+('x'.repeat(34));
    const ev={id:99,missionId:linked.id,type:'chatgpt.browser_observed',
      createdAt:'2026-01-01',payload:{round:1,excerpt:`Sensitive ${secret}\n[MISSION_RELAY:DONE]`}};
    const msg=formatBrowserResultNotification(linked,ev);
    assert.ok(msg.includes('[REDACTED]'));
    assert.ok(!msg.includes(secret));
    const bad=formatBrowserResultNotification(linked,{...ev,type:'chatgpt.browser_uncertain',
      payload:{round:1,reason:'sensitive internal exception text'}});
    assert.ok(bad.includes('NEEDS_RECONCILIATION'));
    assert.ok(!bad.includes('sensitive internal exception'));
  }finally{f.cleanup();}
});

test('Recovered complete reply produces a bounded correction notification while preserving the initial uncertainty event',async()=>{
  const f=fixture();try{
    await f.bridge.pollOnce(0);
    const m=f.store.linkChat(f.m.id,
      'https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174000',f.m.version).mission;
    f.store.reserveChatBrowserTurn(m.id,m.version,'recovery-telegram', 'a'.repeat(64));
    const uncertain=f.store.finishChatBrowserTurn(m.id,'recovery-telegram',{
      kind:'uncertain',error:'Old stale ChatGPT error',
    });
    await f.bridge.pollOnce(0);
    assert.equal(f.transport.sent.length,1);
    assert.match(f.transport.sent[0]!,/NEEDS_RECONCILIATION/);
    f.store.recoverObservedBrowserTurn(m.id,uncertain.version,{
      requestPromptSha256:'a'.repeat(64),assistantSha256:'b'.repeat(64),
      summary:'Telegram-ready summary\nProgress: original request completed\nEvidence: final reply verified\n[MISSION_RELAY:DONE]',
    });
    await f.bridge.pollOnce(0);
    assert.equal(f.transport.sent.length,2);
    assert.match(f.transport.sent[1]!,/original request completed/);
    assert.match(f.transport.sent[1]!,/\[MISSION_RELAY:DONE\]/);
    assert.equal(f.store.events(m.id).filter(x=>x.type==='chatgpt.browser_reserved').length,1);
    await f.bridge.pollOnce(0);
    assert.equal(f.transport.sent.length,2);
  }finally{f.cleanup();}
});

test('Channel poller lease rejects duplicates and is recoverable on clean release',()=>{
  const f=fixture();try{
    const lease=f.store.acquireChannelLease('telegram');
    assert.throws(()=>f.store.acquireChannelLease('telegram'),/already running/);
    f.store.releaseChannelLease('telegram',lease);
    assert.ok(f.store.acquireChannelLease('telegram'));
  }finally{f.cleanup();}
});

test('Maintenance drain fences Telegram intake and browser reservations until matching release',()=>{
  const f=fixture();try{
    const drainId=f.store.requestChannelDrain('telegram');
    assert.match(drainId,/^[0-9a-f-]{36}$/);
    assert.equal(f.store.channelStatus('telegram').drainRequested,true);
    assert.throws(()=>f.store.requestChannelDrain('telegram'),/already requested/);
    assert.throws(()=>f.store.reserveChannelCommand('telegram','55',56),/maintenance drain/);
    assert.equal(f.store.getMeta('telegram.inbox_cursor'),null);
    assert.throws(()=>f.store.reserveChatBrowserTurn(f.m.id,f.m.version,'test-reserve','a'.repeat(64)),
      /maintenance drain/);
    assert.throws(()=>f.store.releaseChannelDrain('telegram','wrong'),/lease mismatch/);
    assert.equal(f.store.channelDrainRequested('telegram'),true);
    f.store.releaseChannelDrain('telegram',drainId);
    assert.equal(f.store.channelDrainRequested('telegram'),false);
    assert.equal(f.store.reserveChannelCommand('telegram','55',56),true);
  }finally{f.cleanup();}
});

test('Maintenance drain refuses in-flight Mission, pending reply or reserved browser request',()=>{
  const f=fixture();try{
    f.store.db.prepare("UPDATE missions SET state='RUNNING' WHERE id=?").run(f.m.id);
    assert.throws(()=>f.store.requestChannelDrain('telegram'),/Maintenance deferred/);
    f.store.db.prepare("UPDATE missions SET state='READY' WHERE id=?").run(f.m.id);
    assert.equal(f.store.reserveChannelCommand('telegram','100',101),true);
    assert.throws(()=>f.store.requestChannelDrain('telegram'),/Maintenance deferred/);
    f.store.completeChannelCommand('telegram','100','ok');
    f.store.markChannelDelivered('telegram','100');
    f.store.setMeta('chatgpt.browser.active.synthetic',JSON.stringify({status:'reserved'}));
    assert.throws(()=>f.store.requestChannelDrain('telegram'),/Maintenance deferred/);
    f.store.setMeta('chatgpt.browser.active.synthetic',JSON.stringify({status:'observed'}));
    const key=f.store.requestChannelDrain('telegram');
    f.store.releaseChannelDrain('telegram',key);
  }finally{f.cleanup();}
});

test('Atomic maintenance drain refuses an undelivered Telegram event even after active Mission ends',()=>{
  const f=fixture();try{
    const originalMax=f.store.maxEventId();
    f.store.setMeta('telegram.notifications_cursor',String(originalMax));
    const current=f.store.get(f.m.id);
    f.store.update(current.id,current.version,{state:'PAUSED'},
      'test.final_pi_notification_pending',{});
    assert.equal(f.store.maxEventId(),originalMax+1);
    assert.throws(()=>f.store.requestChannelDrain('telegram'),/Maintenance deferred/);
    assert.equal(f.store.channelDrainRequested('telegram'),false);
    f.store.setMeta('telegram.notifications_cursor',String(f.store.maxEventId()));
    const nonce=f.store.requestChannelDrain('telegram');
    assert.ok(nonce);
    f.store.releaseChannelDrain('telegram',nonce);
    f.store.setMeta('telegram.notifications_cursor','not-an-integer');
    assert.throws(()=>f.store.requestChannelDrain('telegram'),/notifications cursor/);
    assert.equal(f.store.channelDrainRequested('telegram'),false);
  }finally{f.cleanup();}
});

test('A drain acquired during getUpdates leaves fetched Telegram messages unacknowledged',async()=>{
  const f=fixture();try{
    const update=f.message(900,`/status ${f.m.id}`);
    let drainId='';
    f.transport.getUpdates=async()=>{drainId=f.store.requestChannelDrain('telegram');return [update];};
    await f.bridge.pollOnce(0);
    assert.equal(f.store.getMeta('telegram.inbox_cursor'),null);
    assert.equal(f.transport.sent.length,0);
    f.store.releaseChannelDrain('telegram',drainId);
    f.transport.getUpdates=async()=>[update];
    await f.bridge.pollOnce(0);
    assert.equal(f.store.getMeta('telegram.inbox_cursor'),'901');
    assert.equal(f.transport.sent.length,1);
  }finally{f.cleanup();}
});

test('A leased Telegram loop cooperatively exits on a drain and does not replay a command',async()=>{
  const f=fixture();try {
    let drainId='';
    f.transport.getUpdates=async()=>{
      drainId=f.store.requestChannelDrain('telegram');
      return [f.message(991,`/pause ${f.m.id}`)];
    };
    await f.bridge.run();
    assert.equal(f.store.channelStatus('telegram').pollerPresent,false);
    assert.equal(f.store.getMeta('telegram.inbox_cursor'),null);
    assert.equal(f.engine.get(f.m.id).state,'READY');
    f.store.releaseChannelDrain('telegram',drainId);
  }finally{f.cleanup();}
});

test('Channel status reveals no token and reports durable inbox and active poller',()=>{
  const f=fixture();try{
    const lease=f.store.acquireChannelLease('telegram');
    f.store.advanceChannelCursor('telegram',42);
    const status=f.store.channelStatus('telegram');
    assert.equal(status.inboxCursor,42);
    assert.equal(status.pollerPresent,true);
    assert.equal(status.transportHealth,'starting');
    assert.equal(status.lastPollSuccessAt,null);
    assert.equal(status.lastEventId,f.store.maxEventId());
    assert.equal('token' in status,false);
    f.store.releaseChannelLease('telegram',lease);
    assert.equal(f.store.channelStatus('telegram').pollerPresent,false);
    assert.equal(f.store.channelStatus('telegram').transportHealth,'offline');
  }finally{f.cleanup();}
});

test('Telegram transport health follows successful polling, staleness and current lease identity',async()=>{
  const f=fixture();try {
    const lease=f.store.acquireChannelLease('telegram');
    assert.equal(f.store.channelStatus('telegram').transportHealth,'starting');
    await f.bridge.pollOnce(0);
    const healthy=f.store.channelStatus('telegram');
    assert.equal(healthy.transportHealth,'healthy');
    assert.ok(healthy.lastPollSuccessAt && Number.isFinite(Date.parse(healthy.lastPollSuccessAt)));
    f.store.setMeta('telegram.poll_success',JSON.stringify({
      pid:process.pid,at:new Date(Date.now()-180_000).toISOString(),
    }));
    assert.equal(f.store.channelStatus('telegram').transportHealth,'stale');
    f.store.setMeta('telegram.poll_success',JSON.stringify({
      pid:process.pid+1,at:new Date().toISOString(),
    }));
    assert.equal(f.store.channelStatus('telegram').transportHealth,'starting');
    f.store.setMeta('telegram.poll_success','not-json');
    assert.equal(f.store.channelStatus('telegram').transportHealth,'starting');
    f.store.releaseChannelLease('telegram',lease);
    assert.equal(f.store.channelStatus('telegram').transportHealth,'offline');
  }finally{f.cleanup();}
});

test('Telegram transport failure never fabricates a successful API poll',async()=>{
  const f=fixture();try {
    const lease=f.store.acquireChannelLease('telegram');
    f.transport.getUpdates=async()=>{throw new Error('synthetic transport timeout');};
    await assert.rejects(f.bridge.pollOnce(0),/synthetic transport timeout/);
    assert.equal(f.store.channelStatus('telegram').transportHealth,'starting');
    assert.equal(f.store.channelStatus('telegram').lastPollSuccessAt,null);
    f.store.releaseChannelLease('telegram',lease);
  }finally{f.cleanup();}
});

test('The single-process idle-stall watchdog respects time bounds and active work',()=>{
  const now=1_000_000;
  const old=now-TELEGRAM_IDLE_STALL_EXIT_MS;
  assert.equal(stalledPollerMayExit(now,now-TELEGRAM_IDLE_STALL_EXIT_MS+1,false,true),false);
  assert.equal(stalledPollerMayExit(now,old,true,true),false);
  assert.equal(stalledPollerMayExit(now,old,false,false),false);
  assert.equal(stalledPollerMayExit(now,old,false,true),true);
  assert.equal(stalledPollerMayExit(now+30_000,now,false,true),false);
  assert.equal(stalledPollerMayExit(Number.NaN,old,false,true),false);
});

test('Voluntary idle-exit reason is durable, sanitized and refused without a safe lease',()=>{
  const f=fixture();try{
    const now=Date.now(),lastProgress=now-TELEGRAM_IDLE_STALL_EXIT_MS-500;
    assert.equal(f.store.channelStatus('telegram').lastIdleExit,null);
    assert.throws(()=>f.store.recordChannelIdleExit('telegram',lastProgress,now),/safely idle/);
    const lease=f.store.acquireChannelLease('telegram');
    f.store.setMeta('telegram.notifications_cursor',String(f.store.maxEventId()));
    assert.throws(()=>f.store.recordChannelIdleExit('telegram',now-1000,now),/safely idle/);
    f.store.recordChannelIdleExit('telegram',lastProgress,now);
    assert.deepEqual(f.store.channelStatus('telegram').lastIdleExit,{
      at:new Date(now).toISOString(),pid:process.pid,
      elapsedMs:TELEGRAM_IDLE_STALL_EXIT_MS+500,exitCode:75,
    });
    assert.equal(f.store.maxEventId(),1,'An idle-exit diagnostic must not create a Mission event');
    f.store.reserveChannelCommand('telegram','idle-diagnostic-pending',100);
    assert.throws(()=>f.store.recordChannelIdleExit('telegram',lastProgress,now),/safely idle/);
    f.store.releaseChannelLease('telegram',lease);
  }finally{f.cleanup();}
});

test('Idle watchdog cannot exit with a reserved command, mission, browser Send or unsent notification',()=>{
  const f=fixture();try {
    const lease=f.store.acquireChannelLease('telegram');
    assert.equal(f.store.canAbandonStalledChannel('telegram'),false);
    f.store.setMeta('telegram.notifications_cursor',String(f.store.maxEventId()));
    assert.equal(f.store.canAbandonStalledChannel('telegram'),true);

    f.store.reserveChannelCommand('telegram','777',778);
    assert.equal(f.store.canAbandonStalledChannel('telegram'),false);
    f.store.completeChannelCommand('telegram','777','accepted');
    assert.equal(f.store.canAbandonStalledChannel('telegram'),false);
    f.store.markChannelDelivered('telegram','777');
    assert.equal(f.store.canAbandonStalledChannel('telegram'),true);

    const running=f.store.update(f.m.id,f.store.get(f.m.id).version,
      {state:'RUNNING'},'synthetic.running',{});
    assert.equal(f.store.canAbandonStalledChannel('telegram'),false);
    f.store.update(running.id,running.version,{state:'PAUSED'},'synthetic.paused',{});
    assert.equal(f.store.canAbandonStalledChannel('telegram'),false); // New audit event not yet delivered.
    f.store.setMeta('telegram.notifications_cursor',String(f.store.maxEventId()));
    assert.equal(f.store.canAbandonStalledChannel('telegram'),true);

    const url='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174009';
    const linked=f.store.linkChat(f.m.id,url,f.store.get(f.m.id).version).mission;
    const bound=f.store.bindChatBrowser(f.m.id,'install:Chrome:synthetic',linked.version).mission;
    f.store.setMeta('telegram.notifications_cursor',String(f.store.maxEventId()));
    f.store.reserveChatBrowserTurn(f.m.id,bound.version,'stalled-browser-1','b'.repeat(64));
    assert.equal(f.store.canAbandonStalledChannel('telegram'),false);

    f.store.releaseChannelLease('telegram',lease);
    assert.equal(f.store.canAbandonStalledChannel('telegram'),false);
  }finally{f.cleanup();}
});

test('Idle watchdog refuses a maintenance drain, foreign or missing lease and corrupt browser receipt',()=>{
  const f=fixture();try {
    f.store.setMeta('telegram.notifications_cursor',String(f.store.maxEventId()));
    assert.equal(f.store.canAbandonStalledChannel('telegram'),false);
    const lease=f.store.acquireChannelLease('telegram');
    const drain=f.store.requestChannelDrain('telegram');
    assert.equal(f.store.canAbandonStalledChannel('telegram'),false);
    f.store.releaseChannelDrain('telegram',drain);
    assert.equal(f.store.canAbandonStalledChannel('telegram'),true);
    f.store.setMeta('chatgpt.browser.active.invalid','not-json');
    assert.throws(()=>f.store.canAbandonStalledChannel('telegram'),/JSON/);
    f.store.setMeta('chatgpt.browser.active.invalid','{"status":"invented"}');
    assert.throws(()=>f.store.canAbandonStalledChannel('telegram'),/Unknown browser turn state/);
    f.store.setMeta('chatgpt.browser.active.invalid','{"status":"observed"}');
    f.store.setMeta('telegram.notifications_cursor','90071992547409999');
    assert.equal(f.store.canAbandonStalledChannel('telegram'),false);
    f.store.releaseChannelLease('telegram',lease);
  }finally{f.cleanup();}
});

test('Authorized Telegram continue starts a single eligible mission and reports terminal state',async()=>{
  const f=fixture();try{
    f.transport.updates=[f.message(33,`/continue ${f.m.id} v0`)];
    await f.bridge.pollOnce(0);
    for(let attempt=0;attempt<100&&f.engine.get(f.m.id).state!=='COMPLETED';attempt++)
      await new Promise<void>(resolve=>setTimeout(resolve,10));
    const m=f.engine.get(f.m.id);
    assert.equal(m.state,'COMPLETED');
    assert.equal(f.agent.calls,1);
    assert.ok(f.transport.sent.some(x=>/accepted for execution/.test(x)));
    await f.bridge.pollOnce(0);
    assert.equal(f.transport.sent.filter(x=>/COMPLETED/.test(x)).length,1);
    assert.ok(f.transport.sent.some(x=>/verification.accepted/.test(x)));
    await f.bridge.pollOnce(0);
    assert.equal(f.transport.sent.filter(x=>/COMPLETED/.test(x)).length,1);
    assert.equal(f.agent.calls,1);
  }finally{f.cleanup();}
});

test('Native Codex final Telegram notification includes concise independently reviewed findings, not only COMPLETED',async()=>{
  const f=fixture();try{
    await f.bridge.pollOnce(0);
    const secret='sk-proj-'+'A'.repeat(29);
    f.agent.execute=async()=>{
      f.agent.calls++;
      return {status:'candidate_complete',summary:`Reviewed README/STATE; found stale examples ${secret}`,
        next_instruction:'',evidence:['README mismatched']};
    };
    f.agent.verify=async()=>({accepted:true,reason:'Review independently confirmed',
      evidence:['README lacks browser-bind',
        'STATE contains historical CI entries',
        'https://private.example/path?token=sensitive']});
    const m=await f.engine.run(f.m.id);
    assert.equal(m.state,'COMPLETED');
    const event=f.store.events(m.id).find(e=>e.type==='verification.accepted')!;
    const formatted=formatNativeMissionNotification(m,event);
    assert.match(formatted,/COMPLETED/);
    assert.match(formatted,/verification.accepted/);
    assert.match(formatted,/Summary: Reviewed README\/STATE/);
    assert.match(formatted,/README lacks browser-bind/);
    assert.match(formatted,/STATE contains historical CI/);
    assert.match(formatted,/\[REDACTED\]/);
    assert.match(formatted,/\[PRIVATE LINK\]/);
    assert.doesNotMatch(formatted,new RegExp(secret));
    assert.doesNotMatch(formatted,/token=sensitive/);
    assert.ok(formatted.split('\n').length<=9);
    await f.bridge.pollOnce(0);
    assert.equal(f.transport.sent.filter(x=>x.includes('verification.accepted')).length,1);
    assert.equal(f.transport.sent[0],formatted);
    await f.bridge.pollOnce(0);
    assert.equal(f.transport.sent.length,1);
  }finally{f.cleanup();}
});

test('Repeated vendor-neutral Agent message while the first is running reports the active Mission without replay',async()=>{
  const f=fixture();try{
    f.store.setMeta('telegram.agent.workspace',f.dir);
    let finish:(decision:Decision)=>void=()=>{};
    const gate=new Promise<Decision>(resolve=>{finish=resolve;});
    f.agent.execute=async()=>{f.agent.calls++;return gate;};
    const prompt='Agent：只读检查 README.md 和 STATE.md 的差异';
    f.transport.updates=[f.message(850,prompt),f.message(851,prompt)];
    await f.bridge.pollOnce(0);
    const missions=f.engine.list().filter(x=>x.goal.includes('README.md 和 STATE.md'));
    assert.equal(missions.length,1);
    assert.equal(f.agent.calls,1);
    assert.equal(f.engine.get(missions[0]!.id).state,'RUNNING');
    const accepted=f.transport.sent.filter(x=>/Native Agent Mission .* accepted/.test(x));
    assert.equal(accepted.length,1);
    assert.match(accepted[0]!,/Status: \/status/);
    const duplicate=f.transport.sent.find(x=>/This task is already active/.test(x));
    assert.ok(duplicate);
    assert.match(duplicate,/No new execution was submitted/);
    assert.match(duplicate,new RegExp(missions[0]!.id));
    assert.doesNotMatch(duplicate,/Command rejected/);
    finish({status:'candidate_complete',summary:'Documents reviewed',next_instruction:'',evidence:['README']});
    for(let i=0;i<50&&f.engine.get(missions[0]!.id).state!=='COMPLETED';i++)
      await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(f.engine.get(missions[0]!.id).state,'COMPLETED');
    await f.bridge.pollOnce(0);
    assert.equal(f.transport.sent.filter(x=>/verification.accepted/.test(x)).length,1);
    assert.equal(f.agent.calls,1);
    assert.equal(f.engine.list().filter(x=>x.goal.includes('README.md 和 STATE.md')).length,1);
  }finally{f.cleanup();}
});

test('Unknown-state Telegram continue never auto-reconciles an ambiguous mission',async()=>{
  const f=fixture();try{
    const current=f.engine.get(f.m.id);
    f.store.update(current.id,current.version,{state:'NEEDS_RECONCILIATION'},'test.ambiguous');
    f.transport.updates=[f.message(34,`/continue ${f.m.id} v1`)];
    await f.bridge.pollOnce(0);
    assert.equal(f.agent.calls,0);
    assert.equal(f.engine.get(f.m.id).state,'NEEDS_RECONCILIATION');
    assert.match(f.transport.sent[0]!,/Command rejected/);
  }finally{f.cleanup();}
});

test('Unhealthy Codex bridge does not resume a paused Mission',async()=>{
  const f=fixture();try{
    f.engine.pause(f.m.id);
    const bridge=new TelegramBridge(f.store,f.engine,f.transport,1001,2001,
      async()=>({ok:false,source:'codex-user-config',message:'Local bridge unavailable'}));
    f.transport.updates=[f.message(45,`/continue ${f.m.id} v1`)];
    await bridge.pollOnce(0);
    assert.equal(f.engine.get(f.m.id).state,'PAUSED');
    assert.equal(f.agent.calls,0);
    assert.match(f.transport.sent[0]!,/Local bridge unavailable/);
  }finally{f.cleanup();}
});

test('Remote mutation requires the current revision; stale and absent revisions have no side effects',async()=>{
  const f=fixture();try{
    f.transport.updates=[f.message(51,`/instruct ${f.m.id} no-version`),f.message(52,`/instruct ${f.m.id} v9 stale`)];
    await f.bridge.pollOnce(0);
    assert.equal(f.engine.get(f.m.id).state,'READY');
    assert.equal(f.agent.calls,0);
    assert.ok(f.transport.sent.every(x=>/Command rejected/.test(x)));
    f.transport.updates=[f.message(53,`/pause ${f.m.id}`)];
    await f.bridge.pollOnce(0);
    assert.equal(f.engine.get(f.m.id).state,'PAUSED');
    f.transport.updates=[f.message(54,`/resume ${f.m.id} v0`)];
    await f.bridge.pollOnce(0);
    assert.equal(f.engine.get(f.m.id).state,'PAUSED');
    assert.ok(f.transport.sent.some(x=>/State conflict/.test(x)));
  }finally{f.cleanup();}
});

test('Telegram cannot start, resume, or instruct workspace-write missions',async()=>{
  const f=fixture();try{
    const write=f.engine.create({goal:'Sensitive write',acceptance:['tests pass'],workspace:f.dir,
      sandbox:'workspace-write',mode:'autopilot',maxTurns:3,requestKey:'write'});
    f.transport.updates=[f.message(61,`/continue ${write.id} v0`),
      f.message(62,`/instruct ${write.id} v0 change the repo`)];
    await f.bridge.pollOnce(0);
    assert.equal(f.engine.get(write.id).state,'READY');
    assert.equal(f.agent.calls,0);
    assert.equal(f.transport.sent.filter(x=>/workspace-write missions (?:is|are) disabled/.test(x)).length,2);
    f.engine.pause(write.id);
    f.transport.updates=[f.message(63,`/resume ${write.id} v1`)];
    await f.bridge.pollOnce(0);
    assert.equal(f.engine.get(write.id).state,'PAUSED');
    assert.equal(f.agent.calls,0);
  }finally{f.cleanup();}
});

test('Telegram preflight cannot dispatch after the mission revision changes',async()=>{
  const f=fixture();try{
    const bridge=new TelegramBridge(f.store,f.engine,f.transport,1001,2001,
      async()=>{f.engine.instruct(f.m.id,'local operator changed plan');return {ok:true,source:'default',message:'ready'};});
    f.transport.updates=[f.message(71,`/continue ${f.m.id} v0`)];
    await bridge.pollOnce(0);
    assert.equal(f.agent.calls,0);
    assert.equal(f.engine.get(f.m.id).state,'READY');
    assert.match(f.transport.sent[0]!,/revision changed during preflight/);
  }finally{f.cleanup();}
});

test('Emergency pause works on an active mission after executor events advance the revision',async()=>{
  const f=fixture();try{
    const claimed=f.store.acquire(f.m.id);
    f.store.update(claimed.id,claimed.version,{},'executor.event',{type:'turn.started'});
    f.transport.updates=[f.message(81,`/pause ${f.m.id}`)];
    await f.bridge.pollOnce(0);
    const m=f.engine.get(f.m.id);
    assert.equal(m.state,'RUNNING');
    assert.equal(m.stopRequested,true);
    assert.ok(f.transport.sent.some(x=>/Pause recorded/.test(x)));
  }finally{f.cleanup();}
});

test('Malformed Telegram update does not block valid later messages',async()=>{
  const f=fixture();try{
    f.transport.updates=[
      {update_id:91,message:{text:`/cancel ${f.m.id} v0`,chat:null as unknown as {id:number;type:string}}},
      f.message(92,`/status ${f.m.id}`),
    ];
    await f.bridge.pollOnce(0);
    assert.equal(f.engine.get(f.m.id).state,'READY');
    assert.ok(f.transport.sent.some(x=>/READY/.test(x)));
    assert.equal(f.store.getMeta('telegram.inbox_cursor'),'93');
  }finally{f.cleanup();}
});

test('Out-of-order Bot API batch is processed by update ID, never command arrival order',async()=>{
  const f=fixture();try{
    f.transport.updates=[
      f.message(102,`/resume ${f.m.id} v1`),
      f.message(101,`/pause ${f.m.id}`),
    ];
    await f.bridge.pollOnce(0);
    assert.equal(f.engine.get(f.m.id).state,'READY');
    assert.equal(f.store.events(f.m.id).filter(x=>x.type==='mission.paused').length,1);
    assert.equal(f.store.events(f.m.id).filter(x=>x.type==='mission.resumed').length,1);
    assert.equal(f.store.getMeta('telegram.inbox_cursor'),'103');
  }finally{f.cleanup();}
});

test('Telegram handoff and explicit browser preflight failure never invoke Codex or alter Mission state',async()=>{
  const f=fixture();try {
    const url='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174000';
    const linked=f.store.linkChat(f.m.id,url,f.m.version).mission;
    const bound=f.store.bindChatBrowser(f.m.id,'install:Chrome:synthetic',linked.version).mission;
    const bridge=new TelegramBridge(f.store,f.engine,f.transport,1001,2001,
      async()=>({ok:true,source:'default',message:'ready'}),
      async()=>{throw new Error('Playwriter extension is not connected');});
    f.transport.updates=[f.message(111,`/handoff ${f.m.id}`),f.message(112,`/continue ${f.m.id} v${bound.version}`)];
    await bridge.pollOnce(0);
    assert.equal(f.agent.calls,0);
    assert.equal(f.engine.get(f.m.id).state,'READY');
    assert.ok(f.transport.sent.some(x=>x.includes(url)&&x.includes('MANUALLY')));
    assert.ok(f.transport.sent.some(x=>/Playwriter extension is not connected/.test(x)));
  }finally{f.cleanup();}
});

test('Unpinned ChatGPT Mission refuses Telegram continuation without touching Chrome or Codex',async()=>{
  const f=fixture();try {
    const url='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174000';
    const linked=f.store.linkChat(f.m.id,url,f.m.version).mission;
    let browserCalls=0;
    const bridge=new TelegramBridge(f.store,f.engine,f.transport,1001,2001,
      async()=>{throw new Error('Codex must not run');},
      async()=>{browserCalls++;throw new Error('Chrome must not be queried');});
    f.transport.updates=[f.message(119,`/continue ${f.m.id} v${linked.version}`)];
    await bridge.pollOnce(0);
    assert.equal(browserCalls,0);
    assert.equal(f.agent.calls,0);
    assert.equal(f.store.get(f.m.id).state,'READY');
    assert.equal(f.store.get(f.m.id).version,linked.version);
    assert.equal(f.store.events(f.m.id).filter(e=>e.type==='chatgpt.browser_reserved').length,0);
    assert.ok(f.transport.sent.some(x=>/no pinned Chrome profile/.test(x)));
  }finally{f.cleanup();}
});

test('A browser preflight failure is not masked by a secondary session cleanup failure',async()=>{
  const f=fixture();try {
    const url='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174000';
    const linked=f.store.linkChat(f.m.id,url,f.m.version).mission;
    const bound=f.store.bindChatBrowser(f.m.id,'install:Chrome:synthetic',linked.version).mission;
    let closes=0;
    const badPage={url:()=> 'https://example.com/not-authorized'} as unknown as Page;
    const bridge=new TelegramBridge(f.store,f.engine,f.transport,1001,2001,
      async()=>{throw new Error('Codex must not run');},
      async()=>({page:badPage,close:async()=>{closes++;throw new Error('secondary cleanup failure');}}));
    f.transport.updates=[f.message(120,`/continue ${f.m.id} v${bound.version}`)];
    await bridge.pollOnce(0);
    assert.equal(closes,1);
    assert.ok(f.transport.sent.some(x=>/navigated away from the authorized conversation/.test(x)));
    assert.ok(!f.transport.sent.some(x=>/secondary cleanup failure/.test(x)));
    assert.equal(f.store.get(f.m.id).state,'READY');
    assert.equal(f.store.events(f.m.id).filter(e=>e.type==='chatgpt.browser_reserved').length,0);
  }finally{f.cleanup();}
});

test('Telegram /continue uses the linked Playwriter adapter, not Codex, on a synthetic ChatGPT page',async()=>{
  const f=fixture();try{
    const url='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174000';
    const linked=f.store.linkChat(f.m.id,url,f.m.version).mission;
    const bound=f.store.bindChatBrowser(f.m.id,'install:Chrome:synthetic',linked.version).mission;
    let submitted=0,entered='',closed=false;
    const page={
      url:()=>url,isClosed:()=>false,
      getByRole:()=>({
        count:async()=>0,
        first:()=>({isVisible:async()=>false}),
      }),
      locator:(selector:string)=>{
        let role='other';
        if(selector.includes('data-message-author-role="assistant"'))role='assistant';
        else if(selector.includes('data-message-author-role="user"'))role='user';
        else if(selector.includes('prompt-textarea'))role='composer';
        else if(selector.includes('send-button'))role='send';
        const obj:any={
          count:async()=>role==='assistant'||role==='user'?1+submitted:role==='composer'||role==='send'?1:0,
          first:()=>obj,last:()=>obj,isVisible:async()=>role!=='other',
          isEnabled:async()=>Boolean(entered),
          innerText:async()=>role==='user'
            ? submitted?entered:'Previous prompt'
            : submitted?'Verified synthetic response\n[MISSION_RELAY:DONE]':'Previous answer',
          fill:async(value:string)=>{entered=value;},
          click:async()=>{if(!entered)throw new Error('Empty prompt');submitted++;},
        };
        return obj;
      },
    } as unknown as Page;
    const bridge=new TelegramBridge(f.store,f.engine,f.transport,1001,2001,
      async()=>({ok:true,source:'default',message:'ready'}),
      async()=>({page,close:async()=>{closed=true;}}));
    f.transport.updates=[f.message(121,`/continue ${f.m.id} v${bound.version}`)];
    await bridge.pollOnce(0);
    assert.ok(f.transport.sent.some(x=>/bounded ChatGPT browser attempt/.test(x)));
    for(let i=0;i<100&&f.store.get(f.m.id).state!=='PAUSED';i++)
      await new Promise(resolve=>setTimeout(resolve,50));
    assert.equal(f.store.get(f.m.id).state,'PAUSED');
    assert.equal(f.agent.calls,0);
    assert.equal(submitted,1);
    for(let i=0;i<20&&!closed;i++)await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(closed,true);
    await bridge.pollOnce(0);
    assert.ok(f.transport.sent.some(x=>/Verified synthetic response/.test(x)));
    assert.equal(f.store.events(f.m.id).filter(x=>x.type==='chatgpt.browser_run_finished').length,1);
  }finally{f.cleanup();}
});

test('Telegram /continue end-to-end delivers one result after two synthetic browser turns',async()=>{
  const f=fixture();try {
    const url='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174000';
    const linked=f.store.linkChat(f.m.id,url,f.m.version).mission;
    const bound=f.store.bindChatBrowser(f.m.id,'install:Chrome:synthetic',linked.version).mission;
    let submitted=0,entered='',closed=false;
    const page={
      url:()=>url,isClosed:()=>false,
      getByRole:()=>({count:async()=>0,first:()=>({isVisible:async()=>false})}),
      locator:(selector:string)=>{
        let role='other';
        if(selector.includes('data-message-author-role="assistant"'))role='assistant';
        else if(selector.includes('data-message-author-role="user"'))role='user';
        else if(selector.includes('prompt-textarea'))role='composer';
        else if(selector.includes('send-button'))role='send';
        const obj:any={
          count:async()=>role==='assistant'||role==='user'?1+submitted:role==='composer'||role==='send'?1:0,
          first:()=>obj,last:()=>obj,isVisible:async()=>role!=='other',
          isEnabled:async()=>Boolean(entered),
          innerText:async()=>role==='user'
            ?submitted?entered:'Original user prompt'
            :submitted===0?'Original assistant reply'
              :submitted===1?'Telegram-ready summary\nProgress: interim\n[MISSION_RELAY:NEXT]'
              :'Telegram-ready summary\nProgress: final verified\nNext: owner review\n[MISSION_RELAY:DONE]',
          fill:async(value:string)=>{entered=value;},
          click:async()=>{if(!entered)throw new Error('Empty prompt');submitted++;},
        };
        return obj;
      },
    } as unknown as Page;
    const bridge=new TelegramBridge(f.store,f.engine,f.transport,1001,2001,
      async()=>({ok:true,source:'default',message:'ready'}),
      async()=>({page,close:async()=>{closed=true;}}));
    f.transport.updates=[f.message(124,`/continue ${f.m.id} v${bound.version}`)];
    await bridge.pollOnce(0);
    assert.ok(f.transport.sent.some(x=>/accepted for a bounded/.test(x)));
    for(let i=0;i<160&&!closed;i++)
      await new Promise(resolve=>setTimeout(resolve,50));
    assert.equal(closed,true);
    assert.equal(submitted,2);
    await bridge.pollOnce(0);
    const notifications=f.transport.sent.filter(x=>/ChatGPT result \(model-provided/.test(x));
    assert.equal(notifications.length,1);
    assert.match(notifications[0]!,/final verified/);
    assert.doesNotMatch(notifications[0]!,/Progress: interim/);
    assert.ok(notifications[0]!.split('\n').length<=10);
    assert.equal(f.store.events(f.m.id).filter(x=>x.type==='chatgpt.browser_reserved').length,2);
    assert.equal(f.store.events(f.m.id).filter(x=>x.type==='chatgpt.browser_observed').length,2);
    assert.equal(f.store.events(f.m.id).filter(x=>x.type==='chatgpt.browser_run_finished').length,1);
    await bridge.pollOnce(0);
    assert.equal(f.transport.sent.filter(x=>/ChatGPT result \(model-provided/.test(x)).length,1);
  }finally{f.cleanup();}
});

test('Explicit /new creates one isolated ChatGPT tab, commits URL and final SHA, never replays',async()=>{
  const f=fixture();try{
    const anchor='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174000';
    const newUrl='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174001';
    const linked=f.store.linkChat(f.m.id,anchor,f.m.version).mission;
    f.store.bindChatBrowser(f.m.id,'install:Chrome:synthetic',linked.version);
    f.store.setMeta('telegram.chatgpt.anchorUrl',f.store.chatLink(f.m.id)!);
    f.store.setMeta('telegram.chatgpt.browserId',f.store.chatBrowserBinding(f.m.id)!);
    let newPages=0,sends=0,entered='',location='about:blank',closed=false;
    const answer='Telegram-ready summary\nOutcome: synthetic read-only report\n[MISSION_RELAY:DONE]';
    const fakeLocator=(fresh:boolean)=>(selector:string)=>{
      let role='other';
      if(selector.includes('data-message-author-role="assistant"'))role='assistant';
      else if(selector.includes('data-message-author-role="user"'))role='user';
      else if(selector.includes('prompt-textarea'))role='composer';
      else if(selector.includes('send-button'))role='send';
      const obj:any={
        count:async()=>role==='composer'||role==='send'?1:
          role==='assistant'||role==='user'?fresh?(sends?1:0):1:0,
        first:()=>obj,last:()=>obj,isVisible:async()=>role!=='other',
        isEnabled:async()=>Boolean(entered),
        innerText:async()=>role==='assistant'?(fresh?answer:'Anchor answer'):
          (fresh?entered:'Anchor prior prompt'),
        fill:async(text:string)=>{entered=text;},
        click:async()=>{sends++;location=newUrl;},
      };
      return obj;
    };
    const freshPage={
      url:()=>location,isClosed:()=>false,
      goto:async(url:string)=>{location=url;},
      waitForLoadState:async()=>{},
      getByRole:()=>({count:async()=>0,first:()=>({isVisible:async()=>false})}),
      locator:fakeLocator(true),
    } as unknown as Page;
    const oldPage={
      url:()=>anchor,isClosed:()=>false,
      context:()=>({newPage:async()=>{newPages++;return freshPage;}}),
      getByRole:()=>({count:async()=>0,first:()=>({isVisible:async()=>false})}),
      locator:fakeLocator(false),
    } as unknown as Page;
    const bridge=new TelegramBridge(f.store,f.engine,f.transport,1001,2001,
      async()=>{throw new Error('Codex should not run');},
      async(url,options)=>{
        assert.equal(url,anchor);
        assert.equal(options?.browserId,'install:Chrome:synthetic');
        return {page:oldPage,close:async()=>{closed=true;}};
      });
    const task='Find three real NetBox field workflow user problems';
    f.transport.updates=[f.message(501,`/new ${task}`)];
    await bridge.pollOnce(0);
    assert.ok(f.transport.sent.some(x=>/New ChatGPT Mission/.test(x)));
    for(let i=0;i<90&&!closed;i++)await new Promise(resolve=>setTimeout(resolve,50));
    assert.equal(closed,true);
    const mission=f.engine.list().find(x=>x.goal===task);
    assert.ok(mission);
    assert.equal(mission.state,'PAUSED');
    assert.equal(mission.turnCount,1);
    assert.equal(f.store.chatLink(mission.id),newUrl);
    const events=f.store.events(mission.id);
    assert.equal(events.filter(e=>e.type==='chatgpt.browser_reserved').length,1);
    assert.equal(events.filter(e=>e.type==='chatgpt.browser_observed').length,1);
    assert.equal(events.filter(e=>e.type==='chatgpt.browser_run_finished').length,1);
    assert.equal(events.filter(e=>e.type==='chatgpt.browser_migrated').length,1);
    assert.equal(newPages,1);assert.equal(sends,1);
    assert.match(entered,/Complete the following task:\nFind three real NetBox field workflow user problems/);
    assert.doesNotMatch(entered,/Prior conversation handoff/);
    await bridge.pollOnce(0);
    assert.equal(f.transport.sent.filter(x=>/ChatGPT result \(model-provided/.test(x)).length,1);
    assert.ok(f.transport.sent.some(x=>/synthetic read-only report/.test(x)));
    const stateBefore=f.engine.list().length;
    await bridge.pollOnce(0);
    assert.equal(f.engine.list().length,stateBefore);
    assert.equal(newPages,1);assert.equal(sends,1);
  }finally{f.cleanup();}
});

test('Natural-language new chat refuses an absent or nonmatching approved Chrome anchor',async()=>{
  const f=fixture();try{
    const rejected=new TelegramBridge(f.store,f.engine,f.transport,1001,2001,
      async()=>{throw new Error('Codex should not run');},
      async()=>{throw new Error('Should not connect without an anchor');});
    f.transport.updates=[f.message(502,'/new Check NetBox app reviews')];
    await rejected.pollOnce(0);
    assert.ok(f.transport.sent.some(x=>/No owner-approved ChatGPT profile/.test(x)));
    assert.equal(f.engine.list().length,1);
    const url='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174000';
    const linked=f.store.linkChat(f.m.id,url,f.m.version).mission;
    f.store.bindChatBrowser(f.m.id,'install:Chrome:synthetic',linked.version);
    f.store.setMeta('telegram.chatgpt.anchorUrl',f.store.chatLink(f.m.id)!);
    f.store.setMeta('telegram.chatgpt.browserId',f.store.chatBrowserBinding(f.m.id)!);
    const wrongPage={url:()=> 'https://example.com/',isClosed:()=>false} as unknown as Page;
    const wrong=new TelegramBridge(f.store,f.engine,f.transport,1001,2001,
      async()=>{throw new Error('Codex should not run');},
      async()=>({page:wrongPage,close:async()=>{}}));
    f.transport.updates=[f.message(503,'/new Summarize sample topics')];
    await wrong.pollOnce(0);
    assert.ok(f.transport.sent.some(x=>/navigated away from the authorized conversation/.test(x)));
    assert.equal(f.engine.list().length,1);
  }finally{f.cleanup();}
});

test('Telegram /agent requires an approved workspace and runs one read-only native turn',async()=>{
  const f=fixture();try{
    f.transport.updates=[f.message(504,'/agent Review the local project README')];
    await f.bridge.pollOnce(0);
    assert.ok(f.transport.sent.some(x=>/No approved native agent workspace/.test(x)));
    assert.equal(f.agent.calls,0);
    f.store.setMeta('telegram.agent.workspace',f.dir);
    f.transport.updates=[f.message(505,'/agent Review the local project README')];
    await f.bridge.pollOnce(0);
    for(let i=0;i<20&&f.agent.calls===0;i++)await new Promise(resolve=>setTimeout(resolve,10));
    const m=f.engine.list().find(x=>x.goal==='Review the local project README');
    assert.ok(m);
    assert.equal(m.sandbox,'read-only');
    assert.equal(m.workspace,f.dir);
    assert.equal(m.maxTurns,1);
    assert.equal(f.agent.calls,1);
    await f.bridge.pollOnce(0);
    assert.equal(f.transport.sent.filter(x=>/Native Agent Mission/.test(x)).length,1);
  }finally{f.cleanup();}
});

test('Natural-language Agent: prefix deterministically selects the native executor, never Chrome',async()=>{
  const f=fixture();try{
    f.store.setMeta('telegram.agent.workspace',f.dir);
    const bridge=new TelegramBridge(f.store,f.engine,f.transport,1001,2001,
      async()=>({ok:true,source:'default',message:'ready'}),
      async()=>{throw new Error('Chrome must not be contacted');});
    f.transport.updates=[f.message(506,'Agent： Inspect current readme only')];
    await bridge.pollOnce(0);
    const m=f.engine.list().find(x=>x.goal==='Inspect current readme only');
    assert.ok(m);assert.equal(m.sandbox,'read-only');
    assert.equal(f.agent.calls,1);
  }finally{f.cleanup();}
});

test('Legacy vendor-specific commands are not routed to a different Agent',async()=>{
  const f=fixture();try{
    f.store.setMeta('telegram.agent.workspace',f.dir);
    f.transport.updates=[f.message(507,'/codex Inspect source')];
    await f.bridge.pollOnce(0);
    assert.equal(f.agent.calls,0);
    assert.ok(f.transport.sent.some(x=>/Unknown command/.test(x)));
    assert.equal(f.engine.list().length,1,'No Mission for an unrecognized vendor command');
  }finally{f.cleanup();}
});

test('Telegram owner notes attach to a CLI-adopted PI Mission without launching a second task',async()=>{
  const f=fixture();try{
    const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
    const adopted=f.store.adoptHumanChat({goal:'Continue human-started NetBox work',
      acceptance:['Verify VRF handling'],workspace:'',sandbox:'read-only',
      mode:'supervised',maxTurns:8,requestKey:'synthetic-adopted-telegram',checks:[]},
      'https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174099',
      'install:Chrome:synthetic',{userSha256:hash('Human prompt'),
        assistantSha256:hash('Human response'),summary:'Human response'});
    f.store.setMeta(`pi.autopilot.enabled.${adopted.id}`,'1');
    const count=f.engine.list().length;
    f.transport.updates=[f.message(920,'Check duplicate IPs across VRFs in the next PI round')];
    await f.bridge.pollOnce(0);
    assert.equal(f.engine.list().length,count);
    assert.equal(f.agent.calls,0);
    assert.equal(f.store.pendingPiOwnerDirectives(adopted.id).length,1);
    assert.ok(f.transport.sent.some(message=>message.includes(adopted.id)&&/queued/.test(message)));
    assert.equal(f.store.get(adopted.id).turnCount,0);
  }finally{f.cleanup();}
});
