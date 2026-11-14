import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/core/store.js';
import {MAX_RELAY_CHAT_TURNS} from '../src/core/chat-limits.js';
import {inspectPiEvidence} from '../src/core/pi-evidence.js';
import {formatMissionTurns,missionTurnLimitReached,missionTurnsRemaining} from '../src/core/mission-turns.js';

const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
const chat=(n:number)=>`https://chatgpt.com/c/123e4567-e89b-42d3-a456-${String(426614174000+n).padStart(12,'0')}`;

test('unbounded PI Mission safely crosses round 32 and 33 without creating a successor',()=>{
  const dir=mkdtempSync(join(tmpdir(),'mission-relay-unbounded-'));
  const store=new Store(join(dir,'state.sqlite'));
  try{
    const m=store.create({goal:'Continue based on observed evidence',
      acceptance:['Check every answer'],workspace:'',sandbox:'read-only',
      mode:'supervised',maxTurns:0,requestKey:'unbounded-pi',checks:[]});
    const linked=store.linkChat(m.id,chat(0),m.version).mission;
    store.bindChatBrowser(m.id,'install:Chrome:unbounded',linked.version);
    store.setMeta(`pi.autopilot.enabled.${m.id}`,'1');
    assert.equal(missionTurnsRemaining(0,32),true);
    assert.equal(missionTurnLimitReached(0,1000),false);
    assert.equal(formatMissionTurns(33,0),'33');
    for(let round=1;round<=36;round++){
      const requestKey=`unbounded-${round}`;
      const promptSha256=sha(`Owner-authorized exact prompt ${round}`);
      const answer=`Observed complete answer ${round}\n[MISSION_RELAY:NEXT]`;
      const rotate=round>1&&(round-1)%MAX_RELAY_CHAT_TURNS===0;
      if(rotate){
        assert.throws(()=>store.reserveChatBrowserTurn(m.id,store.get(m.id).version,
          `illegal-old-tab-${round}`,promptSha256),
          /8 observed|new conversation|already has/i);
      }
      store.reserveChatBrowserTurn(m.id,store.get(m.id).version,
        requestKey,promptSha256,rotate?{newConversation:true}:{});
      store.finishChatBrowserTurn(m.id,requestKey,{
        kind:'observed',assistantSha256:sha(answer),summary:answer,
        ...(rotate?{newChatUrl:chat(round)}:{}),
      });
      store.commitPiPlan(m.id,sha(answer),[],{
        action:'NEXT',summary:`Continue after evidence round ${round}`,
        nextPrompt:`Proceed with approved goal at round ${round+1}`});
    }
    const current=store.get(m.id);
    assert.equal(current.turnCount,36);
    assert.equal(current.maxTurns,0);
    assert.equal(current.state,'PAUSED');
    assert.equal(store.createPiSuccessor(m.id),null);
    assert.equal(store.events(m.id).filter(e=>e.type==='pi.autopilot_finished').length,0);
    const report=inspectPiEvidence(store,m.id);
    assert.equal(report.ledgerConsistent,true,report.violations.join(','));
    assert.equal(report.observedTurns,36);
    assert.equal(report.decisionsVerified,36);
    assert.equal(report.maxObservedTurnsInOneChat,8);
    assert.equal(report.chatSegments,5);
    assert.equal(store.piHealth().missions.some(x=>x.id===m.id),true);
  }finally{
    store.close();
    rmSync(dir,{recursive:true,force:true});
  }
});

test('bounded legacy Missions still stop at their saved limit without rewriting history',()=>{
  assert.equal(missionTurnLimitReached(32,31),false);
  assert.equal(missionTurnLimitReached(32,32),true);
  assert.equal(missionTurnsRemaining(32,32),false);
  assert.equal(formatMissionTurns(10,32),'10/32');
});
