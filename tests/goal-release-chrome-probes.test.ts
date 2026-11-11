import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,readdirSync,rmSync,existsSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Page} from 'playwriter';
import {GoalLedger} from '../src/core/goal-store.js';
import {Store} from '../src/core/store.js';
import {GoalReleaseGate} from '../src/core/goal-release.js';
import {inspectPiEvidence} from '../src/core/pi-evidence.js';
import {inspectGoalRequestLedger} from '../src/core/request-ledger.js';
import {captureGoalChromeBoundary,retireGoalOwnedTab,validateChromeWitness,inspectStoredChromeWitnesses} from '../src/core/goal-release-chrome-probes.js';

const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const SOURCE_SHA=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const url=(n:number)=>`https://chatgpt.com/c/123e4567-e89b-42d3-a456-${String(n).padStart(12,'0')}`;
const answer=(n:number)=>`Isolated synthetic round ${n} completed.\n[MISSION_RELAY:NEXT]`;
const prompt=(n:number)=>`Synthetic prompt ${n}`;
const target=(n:number)=>`FAKE-CHROME-TARGET-${String(n).padStart(8,'0')}`;

function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'relay-trusted-chrome-'));
  const store=new Store(join(dir,'isolated.sqlite'));
  const ledger=new GoalLedger(store);
  const goal=ledger.createGoal({requestKey:'synthetic-only-private-goal',
    objective:'Offline Chrome boundary test goal',priority:80});
  const plan=ledger.createPlan(goal.id,goal.version,{requestKey:'synthetic-plan',
    summary:'Test trusted Chrome probes',
    items:[{key:'test-boundary',title:'Test boundary',priority:80,
      acceptance:['Synthetic evidence can be revalidated']}]});
  ledger.setPlanStatus(goal.id,plan.id,plan.version,'APPROVED','approve');
  ledger.setGoalStatus(goal.id,ledger.getGoal(goal.id).version,'ACTIVE','activate');
  const mission=store.create({goal:goal.objective,acceptance:['synthetic'],
    workspace:'',sandbox:'read-only',mode:'supervised',maxTurns:32,
    checks:[],requestKey:'synthetic-mission'});
  const linked=store.linkChat(mission.id,url(1),mission.version).mission;
  const bound=store.bindChatBrowser(mission.id,'fixture-physical-browser',linked.version).mission;
  store.setMeta(`pi.autopilot.enabled.${bound.id}`,'1');
  ledger.bindPiMission(goal.id,bound.id,bound.version,'bind');
  const observe=(n:number,newChat:boolean,review=true)=>{
    const key=`synthetic-key-${n}`;
    store.reserveChatBrowserTurn(bound.id,store.get(bound.id).version,key,sha(prompt(n)),
      newChat?{newConversation:true}:{});
    store.finishChatBrowserTurn(bound.id,key,{kind:'observed',
      assistantSha256:sha(answer(n)),summary:answer(n),
      ...(newChat?{newChatUrl:url(n+1),newChatTargetSha256:sha(target(n))}:{})});
    if(review)store.commitPiPlan(bound.id,sha(answer(n)),[],{
      action:'NEXT',summary:'Synthetic PI decision',nextPrompt:'Next authorized synthetic request'});
  };
  const firstFive=()=>{for(let n=1;n<=5;n++)observe(n,n===1);};
  const six=()=>observe(6,true,false);
  return {dir,store,goalId:goal.id,missionId:bound.id,observe,firstFive,six,
    reviewSix:()=>store.commitPiPlan(bound.id,sha(answer(6)),[],{
      action:'NEXT',summary:'Sixth answer reviewed',nextPrompt:'Continue'}),
    close:()=>{store.close();rmSync(dir,{recursive:true,force:true});}};
}
type Fake=Page&{_test:{setPrompt:(v:string)=>void;setAnswer:(v:string)=>void;
  setTarget:(v:string)=>void;setUrl:(v:string)=>void;setCloseFailure:(v:boolean)=>void;closed:()=>boolean}};
function physicalPages(){
  const all:Fake[]=[];
  const make=(id:string,tabUrl:string,userPrompt:string,assistant:string):Fake=>{
    let closed=false,failClose=false,promptText=userPrompt,answerText=assistant,targetId=id,currentUrl=tabUrl;
    const absent={count:async()=>0};
    const composer={count:async()=>1,isVisible:async()=>true};
    const field=(kind:'user'|'assistant')=>{
      const fieldObj={count:async()=>1,last:()=>fieldObj,
        innerText:async()=>kind==='user'?promptText:answerText,
        getAttribute:async()=>`synthetic-${kind}-turn`};
      return fieldObj;
    };
    const page={
      get _targetId(){return targetId;},
      url:()=>currentUrl,isClosed:()=>closed,
      context:()=>({pages:()=>[...all]}),
      close:async()=>{if(failClose)throw new Error('Synthetic close failure');closed=true;},
      locator:(selector:string)=>selector.includes('data-message-author-role="user"')?
        field('user'):selector.includes('data-message-author-role="assistant"')?
        field('assistant'):selector.includes('prompt-textarea')?composer:absent,
      getByRole:()=>absent,
      _test:{setPrompt:(v:string)=>{promptText=v;},setAnswer:(v:string)=>{answerText=v;},
        setTarget:(v:string)=>{targetId=v;},setUrl:(v:string)=>{currentUrl=v;},setCloseFailure:(v:boolean)=>{failClose=v;},
        closed:()=>closed},
    } as unknown as Fake;
    all.push(page);return page;
  };
  return {make,all};
}
async function captured(f:ReturnType<typeof fixture>,pages:ReturnType<typeof physicalPages>){
  const source=pages.make(target(1),url(2),prompt(5),answer(5));
  const destination=pages.make(target(6),url(7),prompt(6),answer(6));
  const digest=await captureGoalChromeBoundary({store:f.store,goalId:f.goalId,
    missionId:f.missionId,sourcePage:source,destinationPage:destination,
    sourceUrl:url(2),destinationUrl:url(7),sourceSha:SOURCE_SHA,privateRoot:f.dir});
  const content=readFileSync(join(f.dir,'chrome-custody',f.goalId,
    `five-to-six-${digest}.json`),'utf8');
  return {source,destination,digest,witness:JSON.parse(content) as Parameters<typeof validateChromeWitness>[3]};
}
function tamper(f:ReturnType<typeof fixture>,type:string,round:number,
  update:(v:Record<string,unknown>)=>Record<string,unknown>){
  const event=f.store.events(f.missionId).find(e=>e.type===type&&
    (e.payload as {round?:number;requestKey?:string}).round===round||
    e.type===type&&(e.payload as {requestKey?:string}).requestKey===`synthetic-key-${round}`);
  assert.ok(event,`Expected ${type} round ${round}`);
  f.store.db.prepare('UPDATE events SET payload_json=? WHERE id=?')
    .run(JSON.stringify(update(event.payload as Record<string,unknown>)),event.id);
}

test('five original Sends stay in one Chat; sixth is separately reserved and credited only after a new Chat answer and PI review',async t=>{
  const f=fixture();try{
    f.firstFive();
    assert.equal(inspectPiEvidence(f.store,f.missionId).maxObservedTurnsInOneChat,5);
    assert.throws(()=>f.store.reserveChatBrowserTurn(f.missionId,
      f.store.get(f.missionId).version,'forbidden-same-chat',sha('forbidden')),
      /five|chat|limit|rollover/i);
    assert.equal(f.store.get(f.missionId).turnCount,5);
    f.six();
    const report=inspectPiEvidence(f.store,f.missionId);
    assert.equal(report.rounds.at(-1)?.chatTurn,1);
    assert.equal(report.rounds.at(-1)?.chatSegment,2);
    assert.deepEqual(report.pendingPiReviewRounds,[6]);
    const pages=physicalPages();
    const {witness}=await captured(f,pages);
    assert.throws(()=>validateChromeWitness(f.store,f.goalId,SOURCE_SHA,witness),
      /unreviewed original requests/);
    f.reviewSix();
    assert.doesNotThrow(()=>validateChromeWitness(f.store,f.goalId,SOURCE_SHA,witness));
    assert.equal(inspectGoalRequestLedger(f.store,f.goalId).requests.length,6);
    assert.equal(f.store.events(f.missionId).filter(e=>e.type==='chatgpt.browser_reserved').length,6,
      'Neither independent snapshot nor validation sends new messages');
    const witnessed=inspectPiEvidence(f.store,f.missionId);
    t.diagnostic('MR_PROBE_RECEIPT='+JSON.stringify({kind:'chrome-5-to-6',sourceSha:SOURCE_SHA,
      fixture:'isolated-synthetic',observedTurns:witnessed.observedTurns,
      maxSendsPerChat:witnessed.maxObservedTurnsInOneChat,chatSegments:witnessed.chatSegments,
      originalReservations:f.store.events(f.missionId).filter(e=>e.type==='chatgpt.browser_reserved').length,
      pendingPiReviewRounds:witnessed.pendingPiReviewRounds,
      physicalWitnessValidated:true,missingPiReviewRejected:true}));
  }finally{f.close();}
});

test('physical witness rejects changed prompts, altered answers, source/destination Target substitution and forged ledger',async()=>{
  const scenarios=[
    {name:'destination prompt changed',before:(p:ReturnType<typeof physicalPages>,s:Fake,d:Fake)=>d._test.setPrompt('forged destination')},
    {name:'destination answer altered',before:(p:ReturnType<typeof physicalPages>,s:Fake,d:Fake)=>d._test.setAnswer('truncated reply\n[MISSION_RELAY:NEXT]')},
    {name:'source reply changed',before:(p:ReturnType<typeof physicalPages>,s:Fake,d:Fake)=>s._test.setAnswer('stale reply\n[MISSION_RELAY:NEXT]')},
    {name:'source Chat URL spoofed',before:(p:ReturnType<typeof physicalPages>,s:Fake,d:Fake)=>s._test.setUrl(url(999))},
    {name:'source target substituted',before:(p:ReturnType<typeof physicalPages>,s:Fake,d:Fake)=>s._test.setTarget('REOPENED-PHYSICAL-TARGET-0001')},
    {name:'destination target equals source',before:(p:ReturnType<typeof physicalPages>,s:Fake,d:Fake)=>d._test.setTarget(target(1))},
  ];
  for(const c of scenarios){const f=fixture();try{
    f.firstFive();f.six();
    const p=physicalPages(),s=p.make(target(1),url(2),prompt(5),answer(5)),
      d=p.make(target(6),url(7),prompt(6),answer(6));
    c.before(p,s,d);
    await assert.rejects(captureGoalChromeBoundary({store:f.store,goalId:f.goalId,
      missionId:f.missionId,sourcePage:s,destinationPage:d,sourceUrl:url(2),
      destinationUrl:url(7),sourceSha:SOURCE_SHA,privateRoot:f.dir}),undefined,c.name);
    assert.equal(f.store.get(f.missionId).turnCount,6);
  }finally{f.close();}}
  const cases=[
    {name:'modified original response',type:'chatgpt.browser_observed',round:6,
      edit:(x:Record<string,unknown>)=>({...x,assistantSha256:sha('different')})},
    {name:'spoofed destination physical Target',type:'chatgpt.browser_migrated',round:6,
      edit:(x:Record<string,unknown>)=>({...x,newTabTargetSha256:sha('reopened')})},
    {name:'changed PI review SHA',type:'pi.decision',round:6,
      edit:(x:Record<string,unknown>)=>({...x,responseSha256:sha('unreviewed')})},
    {name:'spoofed original request',type:'chatgpt.browser_reserved',round:6,
      edit:(x:Record<string,unknown>)=>({...x,requestKey:'malicious-second-request'})},
  ];
  for(const c of cases){const f=fixture();try{
    f.firstFive();f.six();const {witness}=await captured(f,physicalPages());f.reviewSix();
    tamper(f,c.type,c.round,c.edit);
    assert.throws(()=>validateChromeWitness(f.store,f.goalId,SOURCE_SHA,witness),undefined,c.name);
  }finally{f.close();}}
});

test('retirement of Relay-owned tab checks physical before/after inventory and preserves all owner tabs',async t=>{
  const f=fixture();try{
    f.firstFive();f.six();const p=physicalPages();
    const {source,destination}=await captured(f,p);
    const owner=p.make('OWNER-UNCHANGED-TARGET-00000001','https://example.org/',
      'owner private prompt','owner private answer');
    const ok=await retireGoalOwnedTab({store:f.store,goalId:f.goalId,missionId:f.missionId,
      sourcePage:source,destinationPage:destination,sourceUrl:url(2),
      destinationUrl:url(7),sourceSha:SOURCE_SHA,privateRoot:f.dir});
    assert.equal(ok,true);
    assert.equal(source.isClosed(),true);
    assert.equal(owner.isClosed(),false);
    assert.equal(destination.isClosed(),false);
    f.reviewSix();
    const dir=join(f.dir,'chrome-custody',f.goalId);
    const file=readdirSync(dir).find(x=>x.startsWith('tab-retirement-'))!;
    assert.ok(file);
    const witness=JSON.parse(readFileSync(join(dir,file),'utf8')) as
      Parameters<typeof validateChromeWitness>[3];
    assert.doesNotThrow(()=>validateChromeWitness(f.store,f.goalId,SOURCE_SHA,witness));
    assert.equal(f.store.events(f.missionId).filter(e=>e.type==='chatgpt.browser_tab_retired').length,1);
    assert.ok(!readFileSync(join(dir,file),'utf8').includes('OWNER-UNCHANGED-TARGET'),
      'Owner physical IDs and content must not persist');
    t.diagnostic('MR_PROBE_RECEIPT='+JSON.stringify({kind:'tab-retirement',sourceSha:SOURCE_SHA,
      fixture:'isolated-synthetic',relayTabClosed:source.isClosed(),
      ownerTabPreserved:!owner.isClosed(),destinationTabPreserved:!destination.isClosed(),
      verifiedRetirementEvents:f.store.events(f.missionId).filter(e=>e.type==='chatgpt.browser_tab_retired').length}));
  }finally{f.close();}
});

test('an owner Target replaced after physical close invalidates retirement and cannot issue a custody receipt',async()=>{
  const f=fixture();try{
    f.firstFive();f.six();const p=physicalPages();
    const {source,destination}=await captured(f,p);
    const owner=p.make('ORIGINAL-OWNER-PHYSICAL-TARGET','https://example.net/',
      'private owner text','private owner answer');
    const close=source.close.bind(source);
    source.close=async()=>{
      await close();
      // Simulate an unrelated tab being replaced during the actual close,
      // AFTER both pre-close inventories agreed and before final attestation.
      owner._test.setTarget('REPLACED-OWNER-PHYSICAL-TARGET');
    };
    const retired=await retireGoalOwnedTab({store:f.store,goalId:f.goalId,
      missionId:f.missionId,sourcePage:source,destinationPage:destination,
      sourceUrl:url(2),destinationUrl:url(7),sourceSha:SOURCE_SHA,privateRoot:f.dir});
    assert.equal(retired,false,'The stale pre-close inventory cannot certify a replacement');
    assert.equal(source.isClosed(),true,'The physical close happened once, not replayed');
    assert.equal(owner.isClosed(),false,'Never close an unrelated owner tab');
    assert.equal(destination.isClosed(),false,'Never close the active destination');
    assert.equal(f.store.events(f.missionId).filter(e=>
      e.type==='chatgpt.browser_tab_retired').length,0,
    'A closed Relay tab without stable complete custody must not generate a retirement event');
    const dir=join(f.dir,'chrome-custody',f.goalId);
    assert.equal(readdirSync(dir).filter(x=>x.startsWith('tab-retirement-')).length,0,
      'The inconsistent after-close inventory cannot be persisted as a physical witness');
  }finally{f.close();}
});

test('tab-retirement evidence refuses two different physical witnesses for one original retirement event',async()=>{
  const f=fixture();try{
    f.firstFive();f.six();const pages=physicalPages();
    const {source,destination}=await captured(f,pages);
    assert.equal(await retireGoalOwnedTab({store:f.store,goalId:f.goalId,
      missionId:f.missionId,sourcePage:source,destinationPage:destination,
      sourceUrl:url(2),destinationUrl:url(7),sourceSha:SOURCE_SHA,privateRoot:f.dir}),true);
    f.reviewSix();
    const dir=join(f.dir,'chrome-custody',f.goalId);
    const current=inspectStoredChromeWitnesses(f.store,f.goalId,f.dir,
      'relay-tab-retirement',SOURCE_SHA);
    assert.equal(current.state,'PASS');
    const originalFile=readdirSync(dir).find(x=>x.startsWith('tab-retirement-'))!;
    const original=JSON.parse(readFileSync(join(dir,originalFile),'utf8'));
    const duplicate={...original,observedAt:new Date(
      Date.parse(original.observedAt)+1000).toISOString()};
    const raw=JSON.stringify(duplicate);
    writeFileSync(join(dir,`tab-retirement-${sha(raw)}.json`),raw);
    assert.throws(()=>inspectStoredChromeWitnesses(f.store,f.goalId,f.dir,
      'relay-tab-retirement',SOURCE_SHA),/unique|duplicate|conflict/i);
    assert.equal(f.store.events(f.missionId).filter(e=>
      e.type==='chatgpt.browser_tab_retired').length,1);
  }finally{f.close();}
});

test('failed close, unknown Target, duplicate Target and unowned source never close user tabs or create false receipts',async t=>{
  let refused=0;
  for(const mode of ['throw-close','unknown-target','duplicate-target','not-owned',
    'wrong-goal','invalid-source-sha','changed-inventory-before-close']){
    const f=fixture();try{
      f.firstFive();f.six();const p=physicalPages();
      const {source,destination}=await captured(f,p);
      const owner=p.make('UNRELATED-OWNER-TARGET-0000001','https://example.net/',
        'private user','private answer');
      if(mode==='throw-close')source._test.setCloseFailure(true);
      if(mode==='unknown-target')owner._test.setTarget('bad id spaces');
      if(mode==='duplicate-target')owner._test.setTarget(target(6));
      if(mode==='changed-inventory-before-close'){
        const originalContext=source.context();let inventoryReads=0;
        (source as unknown as {context:()=>typeof originalContext}).context=()=>({
          ...originalContext,pages:()=>{
            inventoryReads++;
            if(inventoryReads===2)owner._test.setTarget('OWNER-NEW-PHYSICAL-TARGET-0001');
            return p.all;
          },
        });
      }
      const unowned=p.make('OWNER-CHAT-TARGET-0000000001',url(2),prompt(5),answer(5));
      const selected=mode==='not-owned'?unowned:source;
      const ok=await retireGoalOwnedTab({store:f.store,
        goalId:mode==='wrong-goal'?'123e4567-e89b-42d3-a456-426614174999':f.goalId,
        missionId:f.missionId,sourcePage:selected,destinationPage:destination,
        sourceUrl:url(2),destinationUrl:url(7),
        sourceSha:mode==='invalid-source-sha'?'unverified':SOURCE_SHA,privateRoot:f.dir});
      assert.equal(ok,false,mode);
      assert.equal(owner.isClosed(),false);
      assert.equal(selected.isClosed(),false);
      assert.equal(f.store.events(f.missionId).filter(e=>e.type==='chatgpt.browser_tab_retired').length,0);
      refused++;
    }finally{f.close();}
  }
  t.diagnostic('MR_PROBE_RECEIPT='+JSON.stringify({kind:'tab-custody-refusals',
    sourceSha:SOURCE_SHA,fixture:'isolated-synthetic',scenariosRefused:refused,
    ownerTabsClosed:0,falseRetirementEvents:0}));
});

test('duplicate original reservations and unsettled requests cannot generate an independent PASS',async t=>{
  const f=fixture();try{
    f.firstFive();f.six();
    const {witness}=await captured(f,physicalPages());f.reviewSix();
    const last=f.store.events(f.missionId).filter(e=>e.type==='chatgpt.browser_reserved').at(-1)!;
    // Explicit test-only corruption in a synthetic isolated SQLite file.
    f.store.db.prepare('INSERT INTO events (mission_id,created_at,type,payload_json) VALUES(?,?,?,?)')
      .run(f.missionId,new Date().toISOString(),last.type,JSON.stringify(last.payload));
    assert.throws(()=>validateChromeWitness(f.store,f.goalId,SOURCE_SHA,witness));
    const other=f.store.events(f.missionId).filter(e=>e.type==='chatgpt.browser_reserved');
    assert.equal(other.length,7);
    assert.equal(f.store.get(f.missionId).turnCount,6);
    t.diagnostic('MR_PROBE_RECEIPT='+JSON.stringify({kind:'chrome-duplicate-original-request',
      sourceSha:SOURCE_SHA,fixture:'isolated-synthetic',reservationsAfterForgery:other.length,
      creditedTurns:f.store.get(f.missionId).turnCount,forgedWitnessRejected:true}));
  }finally{f.close();}
});

test('every five-to-six rotation needs its own independent physical witness, with no duplicate substitution',async t=>{
  const f=fixture();try{
    f.firstFive();f.six();await captured(f,physicalPages());f.reviewSix();
    for(let n=7;n<=10;n++)f.observe(n,false);
    f.observe(11,true,false);
    const pages=physicalPages();
    const source=pages.make(target(6),url(7),prompt(10),answer(10));
    const destination=pages.make(target(11),url(12),prompt(11),answer(11));
    const second=await captureGoalChromeBoundary({store:f.store,goalId:f.goalId,
      missionId:f.missionId,sourcePage:source,destinationPage:destination,
      sourceUrl:url(7),destinationUrl:url(12),sourceSha:SOURCE_SHA,privateRoot:f.dir});
    f.store.commitPiPlan(f.missionId,sha(answer(11)),[],{
      action:'NEXT',summary:'Synthetic round eleven PI review',nextPrompt:'Continue'});
    assert.equal(inspectPiEvidence(f.store,f.missionId).maxObservedTurnsInOneChat,5);
    assert.equal(f.store.get(f.missionId).turnCount,11);
    const root=join(f.dir,'chrome-custody',f.goalId);
    const receipt=inspectStoredChromeWitnesses(f.store,f.goalId,f.dir,
      'chrome-5-to-6',SOURCE_SHA);
    assert.equal(receipt.state,'PASS');
    const original=JSON.parse(readFileSync(join(root,`inspection-${receipt.proofSha256}.json`),'utf8'));
    assert.equal(original.evidence.length,2,'Both independent physical transitions are necessary');
    const missing=join(root,`five-to-six-${second}.json`);
    const raw=readFileSync(missing,'utf8');
    rmSync(missing);
    assert.throws(()=>inspectStoredChromeWitnesses(f.store,f.goalId,f.dir,
      'chrome-5-to-6',SOURCE_SHA),/every Goal five-to-six rollover/i);
    writeFileSync(missing,raw);
    const duplicate=JSON.parse(raw);
    duplicate.observedAt=new Date(Date.parse(duplicate.observedAt)+1000).toISOString();
    const duplicateRaw=JSON.stringify(duplicate);
    writeFileSync(join(root,`five-to-six-${sha(duplicateRaw)}.json`),duplicateRaw);
    assert.throws(()=>inspectStoredChromeWitnesses(f.store,f.goalId,f.dir,
      'chrome-5-to-6',SOURCE_SHA),/every Goal five-to-six rollover/i);
    assert.equal(f.store.events(f.missionId).filter(e=>e.type==='chatgpt.browser_reserved').length,11);
    t.diagnostic('MR_PROBE_RECEIPT='+JSON.stringify({kind:'chrome-missing-or-reused-witness',
      sourceSha:SOURCE_SHA,fixture:'isolated-synthetic',rotationsRequired:2,
      originalReservations:11,missingWitnessRejected:true,duplicateWitnessRejected:true}));
  }finally{f.close();}
});


test('real trusted probe readback returns exact tested SHA, content-addressed original witness and hashed receipt',async()=>{
  const f=fixture();try{
    f.firstFive();f.six();const pages=physicalPages();
    const {source,destination,digest}=await captured(f,pages);
    const user=pages.make('USER-TAB-PRESERVED-000000001','https://example.org/',
      'private', 'private');
    assert.equal(await retireGoalOwnedTab({store:f.store,goalId:f.goalId,
      missionId:f.missionId,sourcePage:source,destinationPage:destination,
      sourceUrl:url(2),destinationUrl:url(7),sourceSha:SOURCE_SHA,privateRoot:f.dir}),true);
    f.reviewSix();
    const root=join(f.dir,'chrome-custody',f.goalId);
    const runtimeIdentity={source:{sourceSha:SOURCE_SHA,compiledTreeSha256:'a'.repeat(64),
      cliSha256:'b'.repeat(64),manifestSha256:'c'.repeat(64),fileCount:42},
    workerPid:12345,workerAttestedAt:'2026-11-08T00:00:00.000Z',
    workerProcessStartedAt:'2026-11-07T23:59:59.000Z',
    workerParentStartedAt:'2026-11-07T23:59:58.000Z',
    inboxCursor:1,notificationsCursor:1,lastEventId:1,
    enrolledTaskVerified:true as const};
    const receipts=['chrome-5-to-6','relay-tab-retirement'].map(requirement=>
      inspectStoredChromeWitnesses(f.store,f.goalId,f.dir,requirement,SOURCE_SHA,
        runtimeIdentity));
    for(const receipt of receipts){
      assert.equal(receipt.state,'PASS');
      assert.equal(receipt.observedSha,SOURCE_SHA);
      assert.match(receipt.reference,/^chrome-readback:\/\/[0-9a-f]{64}$/);
      const file=join(root,`inspection-${receipt.proofSha256}.json`);
      assert.equal(existsSync(file),true);
      const body=readFileSync(file,'utf8');
      assert.equal(sha(body),receipt.proofSha256);
      const structured=JSON.parse(body);
      assert.equal(structured.version,1);
      assert.equal(structured.probeVersion,1);
      assert.equal(structured.targetSha,SOURCE_SHA);
      assert.deepEqual(structured.runtimeIdentity,runtimeIdentity);
      assert.equal(structured.scenario,
        receipt===receipts[0]?'five-to-six':'tab-retirement');
      assert.equal(structured.expectedOutcome,'PASS');
      assert.equal(structured.observedOutcome,'PASS');
      assert.equal(structured.evidenceProvenance,
        'physical-chrome-witnesses-and-original-sqlite-request-ledger');
      assert.ok(structured.evidence.length>0);
      assert.equal(structured.eventReferences.length,1);
      assert.equal(structured.eventReferences[0].missionId,f.missionId);
      assert.ok(structured.evidence.includes(
        structured.eventReferences[0].witnessSha256));
      if(receipt===receipts[0]){
        const refs=structured.eventReferences[0];
        assert.ok(refs.sourceObservationEventId<refs.sourceDecisionEventId);
        assert.ok(refs.destinationReservationEventId<refs.destinationMigrationEventId);
        assert.ok(refs.destinationMigrationEventId<refs.destinationObservationEventId);
      }else{
        const refs=structured.eventReferences[0];
        assert.ok(refs.migrationEventId<refs.retirementEventId);
        assert.ok(refs.observationEventId<refs.retirementEventId);
      }
      assert.match(structured.ledgerDigest,/^[a-f0-9]{64}$/);
      assert.ok(body.includes(digest)||receipt!==receipts[0],
        'Five-to-six receipt must carry independently recorded source/destination fingerprint evidence');
    }
    assert.equal(user.isClosed(),false);
    assert.throws(()=>inspectStoredChromeWitnesses(f.store,f.goalId,f.dir,
      'chrome-5-to-6','b'.repeat(40)),/No independent physical Chrome witness for this source SHA/);
    assert.throws(()=>inspectStoredChromeWitnesses(f.store,f.goalId,f.dir,
      'chrome-5-to-6',SOURCE_SHA,
      {...runtimeIdentity,source:{...runtimeIdentity.source,sourceSha:'0'.repeat(40)}}),
    /different Worker revision/);
    assert.equal(f.store.events(f.missionId).filter(e=>
      e.type==='chatgpt.browser_reserved').length,6,'Probe never creates Send');
  }finally{f.close();}
});

test('original physical witness is immutable: tampered file contents fail closed, including a forged PASS-shaped record',async()=>{
  const f=fixture();try{
    f.firstFive();f.six();const {digest}=await captured(f,physicalPages());f.reviewSix();
    const root=join(f.dir,'chrome-custody',f.goalId);
    const file=join(root,`five-to-six-${digest}.json`),original=readFileSync(file,'utf8');
    writeFileSync(file,original.replace(SOURCE_SHA,'b'.repeat(40)));
    assert.throws(()=>inspectStoredChromeWitnesses(f.store,f.goalId,f.dir,
      'chrome-5-to-6',SOURCE_SHA),/digest mismatch/);
    assert.equal(f.store.events(f.missionId).filter(e=>
      e.type==='chatgpt.browser_reserved').length,6);
  }finally{f.close();}
});


test('real release gate can store only SHA-bound inspected synthetic Chrome evidence, never a PI answer alone',async()=>{
  const f=fixture();try{
    f.firstFive();f.six();const p=physicalPages();
    const {source,destination}=await captured(f,p);
    assert.equal(await retireGoalOwnedTab({store:f.store,goalId:f.goalId,
      missionId:f.missionId,sourcePage:source,destinationPage:destination,
      sourceUrl:url(2),destinationUrl:url(7),sourceSha:SOURCE_SHA,privateRoot:f.dir}),true);
    f.reviewSix();
    const ledger=new GoalLedger(f.store),graph=ledger.graph(f.goalId);
    const item=graph.items[0]!,criterion=graph.acceptance[0]!;
    for(const status of ['READY','IN_PROGRESS','REVIEW'] as const){
      const old=ledger.graph(f.goalId).items[0]!;
      ledger.setWorkStatus(f.goalId,item.id,old.version,status,[],`synthetic-${status}`);
    }
    ledger.recordAcceptance(f.goalId,criterion.id,criterion.version,'PASS',
      [`browser-sha256:${sha(answer(6))}`],'synthetic-criterion');
    const current=ledger.graph(f.goalId).items[0]!;
    ledger.setWorkStatus(f.goalId,item.id,current.version,'PASSED',
      [`browser-sha256:${sha(answer(6))}`],'synthetic-pass');
    const gate=new GoalReleaseGate(f.store);
    const target=gate.begin(f.goalId,SOURCE_SHA);
    assert.equal(target.checks.filter(x=>x.state==='PASS').length,0);
    const inspected={
      source:'chrome-readback',
      inspect:async(requirement:string,sha:string)=>
        inspectStoredChromeWitnesses(f.store,f.goalId,f.dir,requirement,sha),
    };
    for(const req of ['chrome-5-to-6','relay-tab-retirement']){
      const result=await gate.inspect(f.goalId,req,inspected);
      const receipt=result.checks.find(x=>x.requirement===req)!;
      assert.equal(receipt.state,'PASS');
      assert.equal(receipt.targetSha,SOURCE_SHA);
      assert.match(receipt.proofSha256!,/^[a-f0-9]{64}$/);
      assert.ok(receipt.reference?.startsWith('chrome-readback://'));
    }
    assert.equal(gate.report(f.goalId).ready,false,'Other mandatory release gates remain pending');
    assert.equal(f.store.events(f.missionId).filter(e=>
      e.type==='chatgpt.browser_reserved').length,6);
  }finally{f.close();}
});

test('a pending seventh reservation blocks trusted readback even with formerly valid sixth-turn evidence',async()=>{
  const f=fixture();try{
    f.firstFive();f.six();await captured(f,physicalPages());f.reviewSix();
    f.store.reserveChatBrowserTurn(f.missionId,f.store.get(f.missionId).version,
      'synthetic-pending-seven',sha('unsubmitted future prompt'));
    assert.throws(()=>inspectStoredChromeWitnesses(f.store,f.goalId,f.dir,
      'chrome-5-to-6',SOURCE_SHA),/settled|unreviewed/);
    assert.equal(f.store.get(f.missionId).turnCount,6,'Original pending Send receives no credit');
  }finally{f.close();}
});


test('tab release probe refuses historical controller closure receipts lacking a distinct physical witness',async()=>{
  const f=fixture();try{
    f.firstFive();f.six();const pages=physicalPages();
    const {source,destination}=await captured(f,pages);
    assert.equal(await retireGoalOwnedTab({store:f.store,goalId:f.goalId,
      missionId:f.missionId,sourcePage:source,destinationPage:destination,
      sourceUrl:url(2),destinationUrl:url(7),sourceSha:SOURCE_SHA,privateRoot:f.dir}),true);
    f.reviewSix();
    for(let n=7;n<=11;n++)f.observe(n,n===11);
    // A synthetic logical close from an older controller is not independent
    // evidence of a physical Target disappearance or preservation of user tabs.
    assert.equal(f.store.canRetireOwnedChatTab(f.missionId,url(7),url(12)),true);
    f.store.recordOwnedChatTabRetired(f.missionId,url(7),url(12));
    assert.throws(()=>inspectStoredChromeWitnesses(f.store,f.goalId,f.dir,
      'chrome-5-to-6',SOURCE_SHA),/every Goal five-to-six rollover/i,
      'An earlier genuine boundary must not certify a later unwitnessed rollover');
    assert.throws(()=>inspectStoredChromeWitnesses(f.store,f.goalId,f.dir,
      'relay-tab-retirement',SOURCE_SHA),/lacks its own physical Chrome witness/);
  }finally{f.close();}
});

test('historical physical witnesses remain verifiable beyond 24 hours only when captured near their original event',async()=>{
  const f=fixture();try{
    f.firstFive();f.six();const {witness}=await captured(f,physicalPages());f.reviewSix();
    const shift=2*24*60*60*1000;
    const events=f.store.events(f.missionId);
    for(const event of events)f.store.db.prepare('UPDATE events SET created_at=? WHERE id=?')
      .run(new Date(Date.parse(event.createdAt)-shift).toISOString(),event.id);
    const original=f.store.events(f.missionId).find(e=>
      e.id===(witness as {destinationObservationEventId:number}).destinationObservationEventId)!;
    const historic={...witness,observedAt:new Date(
      Date.parse(original.createdAt)+1000).toISOString()};
    assert.doesNotThrow(()=>validateChromeWitness(f.store,f.goalId,SOURCE_SHA,historic),
      'Multi-day Goal evidence should remain valid if the immutable event was witnessed promptly');
    const forgedLate={...historic,observedAt:new Date(
      Date.parse(original.createdAt)+21*60*1000).toISOString()};
    assert.throws(()=>validateChromeWitness(f.store,f.goalId,SOURCE_SHA,forgedLate),
      /not captured at its original physical event/);
  }finally{f.close();}
});
