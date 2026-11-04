import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/core/store.js';
import { Engine } from '../src/core/engine.js';
import { TelegramBridge, formatBrowserResultNotification, type TelegramUpdate, type TelegramTransport } from '../src/plugins/telegram.js';
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
  sent:string[]=[];
  failSend=false;
  async getUpdates(offset:number):Promise<TelegramUpdate[]> {return this.updates.filter(x=>x.update_id>=offset);}
  async sendMessage(_chatId:number,text:string):Promise<void> {
    if(this.failSend) {this.failSend=false;throw new Error('simulated network drop');}
    this.sent.push(text);
  }
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

test('Channel status reveals no token and reports durable inbox and active poller',()=>{
  const f=fixture();try{
    const lease=f.store.acquireChannelLease('telegram');
    f.store.advanceChannelCursor('telegram',42);
    const status=f.store.channelStatus('telegram');
    assert.equal(status.inboxCursor,42);
    assert.equal(status.pollerPresent,true);
    assert.equal(status.lastEventId,f.store.maxEventId());
    assert.equal('token' in status,false);
    f.store.releaseChannelLease('telegram',lease);
    assert.equal(f.store.channelStatus('telegram').pollerPresent,false);
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
