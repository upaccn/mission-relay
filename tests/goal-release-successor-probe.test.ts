import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Page} from 'playwriter';
import {Store} from '../src/core/store.js';
import {GoalLedger} from '../src/core/goal-store.js';
import {GoalReleaseGate} from '../src/core/goal-release.js';
import {goalWorkPrompt} from '../src/core/goal-prompts.js';
import {inspectGoalRequestLedger} from '../src/core/request-ledger.js';
import {inspectPiChainEvidence} from '../src/core/pi-evidence.js';
import {captureGoalSuccessorBoundary,validateSuccessorWitness,
  inspectStoredGoalSuccessorWitnesses,type SuccessorChromeWitness}
  from '../src/core/goal-release-successor-probe.js';

const sha=(v:string)=>createHash('sha256').update(v).digest('hex');
const SRC_SHA=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const url=(n:number)=>'https://chatgpt.com/c/123e4567-e89b-42d3-a456-'+String(n).padStart(12,'0');
const answer=(n:number)=>'Full synthetic parent answer '+n+'\n[MISSION_RELAY:NEXT]';
const prompt=(n:number)=>'Private synthetic parent user prompt '+n;
const target=(n:number)=>'SYNTHETIC-CHROME-TARGET-'+String(n).padStart(8,'0');
const childAnswer='Complete synthetic child first answer\n[MISSION_RELAY:NEXT]';

function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'relay-successor-probe-'));
  const store=new Store(join(dir,'private.sqlite')),ledger=new GoalLedger(store);
  const goal=ledger.createGoal({requestKey:'synthetic-successor-goal',
    objective:'Synthetic offline 32-to-successor verification',priority:100});
  const plan=ledger.createPlan(goal.id,goal.version,{requestKey:'synthetic-goal-plan',
    summary:'Verify scope retained across 32-turn Mission limit',
    items:[{key:'successor-check',title:'Synthetic isolated continuation test',
      priority:100,acceptance:['Complete answer and PI review remain attributable']}]});
  ledger.setPlanStatus(goal.id,plan.id,plan.version,'APPROVED','plan-approved');
  ledger.setGoalStatus(goal.id,ledger.getGoal(goal.id).version,'ACTIVE','goal-active');
  const item=ledger.graph(goal.id).items[0]!;
  const ready=ledger.setWorkStatus(goal.id,item.id,item.version,'READY',[],'work-ready');
  ledger.setWorkStatus(goal.id,item.id,ready.version,'IN_PROGRESS',[],'work-in-progress');
  const created=store.create({goal:goal.objective,acceptance:['synthetic review'],
    workspace:'',sandbox:'read-only',mode:'supervised',maxTurns:32,checks:[],
    requestKey:'synthetic-private-parent'});
  const linked=store.linkChat(created.id,url(1),created.version).mission;
  const bound=store.bindChatBrowser(created.id,'test:Chrome:synthetic',
    linked.version).mission;
  store.setMeta('pi.autopilot.enabled.'+bound.id,'1');
  ledger.bindPiMission(goal.id,bound.id,bound.version,'bind-goal-root');
  const parentId=bound.id;
  function observeParent(n:number){
    const migration=n===1||n%5===1;
    const key='synthetic-request-'+n;
    store.reserveChatBrowserTurn(parentId,store.get(parentId).version,
      key,sha(prompt(n)),migration?{newConversation:true}:{});
    store.finishChatBrowserTurn(parentId,key,{kind:'observed',
      assistantSha256:sha(answer(n)),summary:answer(n),
      ...(migration?{newChatUrl:url(n+1),newChatTargetSha256:sha(target(n))}:{})});
    store.commitPiPlan(parentId,sha(answer(n)),[],{
      action:'NEXT',summary:'Verified synthetic parent round '+n,nextPrompt:'Continue'});
  }
  const finishParent=()=>{for(let n=1;n<=32;n++)observeParent(n);};
  const createChild=()=>{
    const child=store.createPiSuccessor(parentId);
    assert.ok(child,'Synthetic 32-turn parent must create successor');
    return child;
  };
  function firstChild(){
    const child=createChild();
    const parentPlan=store.piPlan(parentId)!;
    const built=goalWorkPrompt(store,child.id,parentPlan,null,true);
    const key='synthetic-child-first';
    store.reserveChatBrowserTurn(child.id,store.get(child.id).version,key,
      sha(built.prompt.trim()),{newConversation:true,
        promptSnapshot:{format:built.format,prompt:built.prompt},goalBinding:built.binding});
    store.finishChatBrowserTurn(child.id,key,{kind:'observed',
      assistantSha256:sha(childAnswer),summary:childAnswer,
      newChatUrl:url(100),newChatTargetSha256:sha(target(100))});
    return {childId:child.id,firstPrompt:built.prompt};
  }
  return {dir,store,ledger,goalId:goal.id,parentId,finishParent,createChild,firstChild,
    reviewChild:(id:string)=>store.commitPiPlan(id,sha(childAnswer),[],{
      action:'NEXT',summary:'Synthetic full child reply independently reviewed',nextPrompt:'Continue'}),
    close:()=>{store.close();rmSync(dir,{recursive:true,force:true});}};
}
function page(targetId:string,tabUrl:string,userText:string,assistantText:string){
  let currentTarget=targetId, currentUrl=tabUrl, currentUser=userText,
    currentAssistant=assistantText,closed=false;
  const absent={count:async()=>0};
  const composer={count:async()=>1,isVisible:async()=>true};
  const turn=(kind:'user'|'assistant')=>{
    const obj={count:async()=>1,last:()=>obj,
      innerText:async()=>kind==='user'?currentUser:currentAssistant,
      getAttribute:async()=>kind==='assistant'?'synthetic-turn-id':null};
    return obj;
  };
  const fake={
    get _targetId(){return currentTarget;},url:()=>currentUrl,isClosed:()=>closed,
    close:async()=>{closed=true;},
    locator:(selector:string)=>selector.includes('data-message-author-role="user"')?
      turn('user'):selector.includes('data-message-author-role="assistant"')?
        turn('assistant'):selector.includes('prompt-textarea')?composer:absent,
    getByRole:()=>absent,
  } as unknown as Page;
  return {fake,setTarget:(v:string)=>{currentTarget=v;},
    setUrl:(v:string)=>{currentUrl=v;},
    setAnswer:(v:string)=>{currentAssistant=v;},
    setUser:(v:string)=>{currentUser=v;},
    closed:()=>closed};
}
function pair(firstPrompt:string){
  return {parent:page(target(31),url(32),prompt(32),answer(32)),
    child:page(target(100),url(100),firstPrompt,childAnswer)};
}
async function capture(f:ReturnType<typeof fixture>,childId:string,
  pages:ReturnType<typeof pair>){
  const digest=await captureGoalSuccessorBoundary({store:f.store,goalId:f.goalId,
    parentId:f.parentId,childId,sourcePage:pages.parent.fake,
    destinationPage:pages.child.fake,sourceUrl:url(32),destinationUrl:url(100),
    sourceSha:SRC_SHA,privateRoot:f.dir});
  const file=join(f.dir,'chrome-custody',f.goalId,
    'mission-32-successor-'+digest+'.json');
  return {digest,file,witness:JSON.parse(readFileSync(file,'utf8')) as SuccessorChromeWitness};
}
function change(f:ReturnType<typeof fixture>,missionId:string,type:string,
  id:number,changes:Record<string,unknown>){
  const event=f.store.events(missionId).find(e=>e.id===id&&e.type===type);
  assert.ok(event);
  f.store.db.prepare('UPDATE events SET payload_json=? WHERE id=?')
    .run(JSON.stringify({...event.payload,...changes}),id);
}

test('32 real atomic observations, at most five per Chat, create exactly one zero-turn reciprocal successor preserving Goal work and default PI model',t=>{
  const f=fixture();try{
    f.finishParent();
    const p=inspectPiChainEvidence(f.store,f.parentId);
    assert.equal(p.missions[0]?.turnCount,32);
    assert.equal(p.missions[0]?.decisionsVerified,32);
    assert.equal(p.missions[0]?.maxObservedTurnsInOneChat,5);
    assert.equal(f.store.get(f.parentId).turnCount,32);
    assert.throws(()=>f.store.reserveChatBrowserTurn(f.parentId,
      f.store.get(f.parentId).version,'unauthorized-33',sha('forbidden'),{
        newConversation:true}),/turn budget exhausted/);
    const before=f.store.events(f.parentId).length;
    const child=f.createChild();
    assert.equal(child.turnCount,0);
    assert.equal(child.state,'READY');
    assert.equal(f.store.chatBrowserTurn(child.id),null);
    assert.equal(f.store.piChainSuccessor(f.parentId),child.id);
    assert.equal(f.store.piChainParent(child.id),f.parentId);
    assert.equal(f.ledger.missionGoalId(child.id),f.goalId);
    assert.deepEqual([child.goal,child.workspace,child.sandbox,child.acceptance],
      [f.store.get(f.parentId).goal,f.store.get(f.parentId).workspace,
        f.store.get(f.parentId).sandbox,f.store.get(f.parentId).acceptance]);
    assert.equal(f.createChild().id,child.id,'Duplicate rollover returns same ID');
    f.store.auditPiDefaultModelInvocation(child.id,0,sha(answer(32)),{
      argvSha256:sha('approved pictl infer default-model invocation'),
      modelOverride:false,providerOverride:false,thinkingOverride:false});
    const intent=f.store.events(child.id).find(e=>e.type==='pi.default_model_invocation_intent');
    assert.ok(intent,'Child zero-turn PI planning retains the operator-managed host configured default');
    assert.deepEqual(intent.payload&&Object.fromEntries(
      ['modelOverride','providerOverride','thinkingOverride'].map(k=>[
        k,(intent.payload as Record<string,unknown>)[k]])),{
      modelOverride:false,providerOverride:false,thinkingOverride:false});
    assert.equal(f.store.events(f.parentId).filter(e=>e.type==='pi.chain_successor').length,1);
    assert.equal(f.store.events(child.id).filter(e=>e.type==='pi.chain_started').length,1);
    assert.equal(f.store.events(f.parentId).length,before+1);
    assert.ok(!JSON.stringify(f.store.events(child.id)).includes('"model":"'),
      'The successor never replaces the operator-managed host default PI model');
    t.diagnostic('MR_PROBE_RECEIPT='+JSON.stringify({kind:'mission-32-to-successor',
      sourceSha:SRC_SHA,fixture:'isolated-synthetic',parentTurns:p.missions[0]?.turnCount,
      parentDecisions:p.missions[0]?.decisionsVerified,
      maxSendsPerChat:p.missions[0]?.maxObservedTurnsInOneChat,
      successorCount:f.store.events(f.parentId).filter(e=>e.type==='pi.chain_successor').length,
      successorInitialTurns:child.turnCount,
      successorOriginalReservations:f.store.events(child.id).filter(e=>e.type==='chatgpt.browser_reserved').length,
      reciprocalBindingVerified:f.store.piChainParent(child.id)===f.parentId,
      piModelOverridesAbsent:true}));
  }finally{f.close();}
});

test('independently witnessed child first reply cannot PASS before its matching PI decision; later exact readback creates SHA-bound receipt',async t=>{
  const f=fixture();try{
    f.finishParent();const {childId,firstPrompt}=f.firstChild();
    const physical=pair(firstPrompt);
    const {digest,file,witness}=await capture(f,childId,physical);
    assert.match(digest,/^[a-f0-9]{64}$/);
    assert.ok(readFileSync(file,'utf8').includes(SRC_SHA));
    assert.throws(()=>validateSuccessorWitness(f.store,f.goalId,SRC_SHA,witness),
      /matching independent PI decision/);
    assert.throws(()=>inspectStoredGoalSuccessorWitnesses(f.store,f.goalId,f.dir,SRC_SHA),
      /reviewed original requests/);
    f.reviewChild(childId);
    validateSuccessorWitness(f.store,f.goalId,SRC_SHA,witness);
    const runtimeIdentity={source:{sourceSha:SRC_SHA,compiledTreeSha256:'a'.repeat(64),
      cliSha256:'b'.repeat(64),manifestSha256:'c'.repeat(64),fileCount:42},
    workerPid:12345,workerAttestedAt:'2026-11-08T00:00:00.000Z',
    workerProcessStartedAt:'2026-11-07T23:59:59.000Z',
    workerParentStartedAt:'2026-11-07T23:59:58.000Z',
    inboxCursor:1,notificationsCursor:1,lastEventId:1,
    enrolledTaskVerified:true as const};
    const receipt=inspectStoredGoalSuccessorWitnesses(
      f.store,f.goalId,f.dir,SRC_SHA,runtimeIdentity);
    assert.deepEqual([receipt.state,receipt.observedSha],['PASS',SRC_SHA]);
    assert.match(receipt.proofSha256,/^[a-f0-9]{64}$/);
    assert.equal(sha(readFileSync(join(f.dir,'chrome-custody',f.goalId,
      'inspection-'+receipt.proofSha256+'.json'),'utf8')),receipt.proofSha256);
    const structured=JSON.parse(readFileSync(join(f.dir,'chrome-custody',f.goalId,
      'inspection-'+receipt.proofSha256+'.json'),'utf8'));
    assert.equal(structured.requirement,'mission-32-successor');
    assert.equal(structured.probeVersion,1);
    assert.equal(structured.targetSha,SRC_SHA);
    assert.equal(structured.scenario,'32-to-successor-first-observed-reply');
    assert.deepEqual(structured.runtimeIdentity,runtimeIdentity);
    assert.throws(()=>inspectStoredGoalSuccessorWitnesses(
      f.store,f.goalId,f.dir,SRC_SHA,
      {...runtimeIdentity,source:{...runtimeIdentity.source,sourceSha:'0'.repeat(40)}}),
    /different Worker revision/);
    assert.deepEqual([structured.expectedOutcome,structured.observedOutcome],['PASS','PASS']);
    assert.equal(structured.evidenceProvenance,
      'physical-parent-child-chrome-and-original-sqlite-pi-chain');
    assert.deepEqual(structured.witnessDigests,[digest]);
    assert.equal(structured.eventReferences.length,1);
    const refs=structured.eventReferences[0];
    assert.equal(refs.witnessSha256,digest);
    assert.equal(refs.parentId,f.parentId);
    assert.equal(refs.childId,childId);
    assert.ok(refs.limitEventId<refs.successorEventId);
    assert.ok(refs.startedEventId<refs.childReservationEventId);
    assert.ok(refs.childReservationEventId<refs.childMigrationEventId);
    assert.ok(refs.childMigrationEventId<refs.childObservationEventId);
    assert.ok(refs.childObservationEventId<refs.childDecisionEventId);
    assert.equal(f.store.events(childId).filter(e=>e.type==='chatgpt.browser_reserved').length,1);
    assert.equal(f.store.get(childId).turnCount,1);
    assert.equal(physical.parent.closed(),false,'Witness must not close parent tab');
    t.diagnostic('MR_PROBE_RECEIPT='+JSON.stringify({kind:'successor-first-request',
      sourceSha:SRC_SHA,fixture:'isolated-synthetic',firstChildTurns:f.store.get(childId).turnCount,
      originalReservations:f.store.events(childId).filter(e=>e.type==='chatgpt.browser_reserved').length,
      receiptSha256:receipt.proofSha256,physicalParentPreserved:!physical.parent.closed(),
      unreviewedResponseRejected:true,reviewedReceiptState:receipt.state}));
  }finally{f.close();}
});

test('forged physical Target, changed prompt/answer or substituted Chat URL cannot be captured',async t=>{
  let rejected=0;
  for(const mode of ['parent-target','child-target','same-target','parent-answer',
    'child-answer','child-user','child-chat']){
    const f=fixture();try{
      f.finishParent();const {childId,firstPrompt}=f.firstChild(),p=pair(firstPrompt);
      if(mode==='parent-target')p.parent.setTarget('SPOOFED-OLD-TARGET-000000');
      if(mode==='child-target')p.child.setTarget('SPOOFED-NEW-TARGET-000000');
      if(mode==='same-target')p.child.setTarget(target(31));
      if(mode==='parent-answer')p.parent.setAnswer('Changed old answer\n[MISSION_RELAY:NEXT]');
      if(mode==='child-answer')p.child.setAnswer('Changed new answer\n[MISSION_RELAY:NEXT]');
      if(mode==='child-user')p.child.setUser('Different submitted prompt');
      if(mode==='child-chat')p.child.setUrl(url(999));
      await assert.rejects(capture(f,childId,p),undefined,mode);
      assert.equal(f.store.events(childId).filter(e=>e.type==='chatgpt.browser_reserved').length,1);
      assert.equal(f.store.get(childId).turnCount,1);
      rejected++;
    }finally{f.close();}
  }
  t.diagnostic('MR_PROBE_RECEIPT='+JSON.stringify({kind:'successor-physical-refusals',
    sourceSha:SRC_SHA,fixture:'isolated-synthetic',scenariosRejected:rejected,
    parentOriginalRequestPreserved:true,childExtraSends:0}));
});

test('changed PI reply, original child reservation, predecessor Target or duplicate successor events invalidate a once-valid witness',async()=>{
  const scenarios:Array<{name:string;mission:'parent'|'child';type:string;
    select:(w:SuccessorChromeWitness)=>number;changes:Record<string,unknown>}>= [
    {name:'PI mismatched answer',mission:'child',type:'pi.decision',select:w=>w.childObservationEventId+1,
      changes:{responseSha256:sha('not reviewed')}},
    {name:'spoofed reservation',mission:'child',type:'chatgpt.browser_reserved',
      select:w=>w.childReservationEventId,changes:{requestKey:'another-child-request'}},
    {name:'fake new target',mission:'child',type:'chatgpt.browser_migrated',
      select:w=>w.childMigrationEventId,changes:{newTabTargetSha256:sha('unrelated target')}},
    {name:'duplicate parent successor',mission:'parent',type:'pi.chain_successor',
      select:w=>w.successorEventId,changes:{successorId:'123e4567-e89b-42d3-a456-426614174123'}},
  ];
  for(const scenario of scenarios){const f=fixture();try{
    f.finishParent();const {childId,firstPrompt}=f.firstChild();
    const {witness}=await capture(f,childId,pair(firstPrompt));
    f.reviewChild(childId);
    const id=scenario.select(witness),missionId=scenario.mission==='parent'?f.parentId:childId;
    const ev=f.store.events(missionId).find(e=>e.id===id&&e.type===scenario.type);
    assert.ok(ev,scenario.name);
    change(f,missionId,scenario.type,id,scenario.changes);
    assert.throws(()=>validateSuccessorWitness(f.store,f.goalId,SRC_SHA,witness),
      undefined,scenario.name);
  }finally{f.close();}}
});

test('crash after reservation preserves exactly one child and one spent request, never retries or claims PI/physical PASS',t=>{
  const f=fixture();try{
    f.finishParent();const child=f.createChild();
    const plan=f.store.piPlan(f.parentId)!;
    const built=goalWorkPrompt(f.store,child.id,plan,null,true);
    const key='original-ambiguous-child';
    f.store.reserveChatBrowserTurn(child.id,child.version,key,sha(built.prompt.trim()),{
      newConversation:true,promptSnapshot:{format:'goal-work-v1',prompt:built.prompt},
      goalBinding:built.binding});
    const at=f.store.maxEventId();
    assert.equal(f.createChild().id,child.id,
      'A crash after reservation must reuse the same successor without new Send');
    assert.throws(()=>f.store.reserveChatBrowserTurn(child.id,
      f.store.get(child.id).version,key,sha(built.prompt.trim()),{newConversation:true}));
    assert.equal(f.store.maxEventId(),at,'No retry reservation or new event');
    assert.throws(()=>inspectStoredGoalSuccessorWitnesses(f.store,f.goalId,f.dir,SRC_SHA));
    f.store.finishChatBrowserTurn(child.id,key,{kind:'uncertain',error:'simulated crash'});
    assert.equal(f.createChild().id,child.id);
    assert.equal(f.store.events(child.id).filter(e=>e.type==='chatgpt.browser_reserved').length,1);
    assert.equal(f.store.get(child.id).turnCount,0);
    assert.throws(()=>inspectStoredGoalSuccessorWitnesses(f.store,f.goalId,f.dir,SRC_SHA));
    t.diagnostic('MR_PROBE_RECEIPT='+JSON.stringify({kind:'successor-interrupted-original',
      sourceSha:SRC_SHA,fixture:'isolated-synthetic',childTurns:f.store.get(child.id).turnCount,
      childOriginalReservations:f.store.events(child.id).filter(e=>e.type==='chatgpt.browser_reserved').length,
      duplicateReserveRejected:true,missingPhysicalWitnessRejected:true}));
  }finally{f.close();}
});

test('owner pause blocks a zero-turn child Send, successor creation and any recorded physical acceptance',()=>{
  const f=fixture();try{
    f.finishParent();f.store.pausePiChain(f.parentId);
    assert.equal(f.store.createPiSuccessor(f.parentId),null);
    assert.equal(f.store.events(f.parentId).filter(e=>e.type==='pi.chain_successor').length,0);
  }finally{f.close();}
  {const f=fixture();try{
    f.finishParent();const child=f.createChild();
    f.store.pausePiChain(f.parentId);
    assert.equal(f.store.createPiSuccessor(f.parentId),null,
      'Paused lineage must not be reactivated by a duplicate successor creation');
    assert.throws(()=>f.store.reserveChatBrowserTurn(child.id,
      f.store.get(child.id).version,'after-pause',sha('cannot send'),{
        newConversation:true}),/pause request|approved/);
    assert.equal(f.store.events(child.id).filter(e=>e.type==='chatgpt.browser_reserved').length,0);
  }finally{f.close();}}
});

test('tampered independent witness and stale release SHA never produce a usable receipt',async()=>{
  const f=fixture();try{
    f.finishParent();const {childId,firstPrompt}=f.firstChild();
    const {file,witness}=await capture(f,childId,pair(firstPrompt));f.reviewChild(childId);
    assert.throws(()=>inspectStoredGoalSuccessorWitnesses(f.store,f.goalId,f.dir,
      'b'.repeat(40)),/Each 32-turn successor/);
    const original=readFileSync(file,'utf8');
    writeFileSync(file,original.replace(SRC_SHA,'b'.repeat(40)));
    assert.throws(()=>inspectStoredGoalSuccessorWitnesses(f.store,f.goalId,f.dir,SRC_SHA),
      /Tampered successor physical witness digest/);
    assert.equal(f.store.get(childId).turnCount,1);
    assert.equal(new GoalReleaseGate(f.store).report(f.goalId).target,null,
      'Fixture without a release target is not production PASS');
    assert.equal(witness.sourceSha,SRC_SHA);
  }finally{f.close();}
});

test('a failed matching PI review cannot authorize a second Send or retroactively certify stale child text',async()=>{
  const f=fixture();try{
    f.finishParent();const {childId,firstPrompt}=f.firstChild();
    const {witness}=await capture(f,childId,pair(firstPrompt));
    assert.throws(()=>f.store.commitPiPlan(childId,sha('stale response'),[],{
      action:'NEXT',summary:'invalid',nextPrompt:'still pending'}),
    /matching|verified|browser/i);
    assert.throws(()=>validateSuccessorWitness(f.store,f.goalId,SRC_SHA,witness));
    assert.equal(f.store.events(childId).filter(e=>e.type==='chatgpt.browser_reserved').length,1);
    assert.equal(f.store.events(childId).filter(e=>e.type==='pi.decision').length,0);
  }finally{f.close();}
});

test('recovering the original uncertain child first Send preserves request once and cannot invent missing physical Target proof',async()=>{
  const f=fixture();try{
    f.finishParent();const child=f.createChild();
    const built=goalWorkPrompt(f.store,child.id,f.store.piPlan(f.parentId)!,null,true);
    const key='single-uncertain-first-send';
    f.store.reserveChatBrowserTurn(child.id,child.version,key,sha(built.prompt.trim()),{
      newConversation:true,promptSnapshot:{format:'goal-work-v1',prompt:built.prompt},
      goalBinding:built.binding});
    f.store.finishChatBrowserTurn(child.id,key,{kind:'uncertain',
      error:'Synthetic post-click observation timed out'});
    const repaired=f.store.recoverObservedBrowserRollover(child.id,
      f.store.get(child.id).version,{
        requestPromptSha256:sha(built.prompt.trim()),newChatUrl:url(100),
        assistantSha256:sha(childAnswer),summary:childAnswer});
    assert.equal(repaired.turnCount,1);
    assert.equal(f.store.events(child.id).filter(e=>e.type==='chatgpt.browser_reserved').length,1);
    assert.equal(f.store.events(child.id).filter(e=>e.type==='chatgpt.browser_rollover_recovered').length,1);
    assert.equal(f.store.createPiSuccessor(f.parentId)?.id,child.id);
    assert.throws(()=>f.store.recoverObservedBrowserRollover(child.id,
      f.store.get(child.id).version,{
        requestPromptSha256:sha(built.prompt.trim()),newChatUrl:url(100),
        assistantSha256:sha(childAnswer),summary:childAnswer}),/Only an uncertain|unspent/);
    // A recovered logical URL link is NOT a physical Chrome Target witness.
    await assert.rejects(captureGoalSuccessorBoundary({store:f.store,goalId:f.goalId,
      parentId:f.parentId,childId:child.id,
      sourcePage:pair(built.prompt).parent.fake,destinationPage:pair(built.prompt).child.fake,
      sourceUrl:url(32),destinationUrl:url(100),sourceSha:SRC_SHA,privateRoot:f.dir}));
    assert.throws(()=>inspectStoredGoalSuccessorWitnesses(f.store,f.goalId,f.dir,SRC_SHA));
  }finally{f.close();}
});

test('duplicated successor audit linkage, changed Goal scope or revoked work plan never validate an old physical witness',async()=>{
  for(const scenario of ['duplicate-link','work-plan-revoked','child-scope-changed']){
    const f=fixture();try{
      f.finishParent();const {childId,firstPrompt}=f.firstChild();
      const {witness}=await capture(f,childId,pair(firstPrompt));f.reviewChild(childId);
      if(scenario==='duplicate-link'){
        const row=f.store.events(f.parentId).find(e=>e.id===witness.successorEventId)!;
        f.store.db.prepare('INSERT INTO events(mission_id,created_at,type,payload_json) VALUES(?,?,?,?)')
          .run(f.parentId,new Date().toISOString(),row.type,JSON.stringify(row.payload));
      }else if(scenario==='child-scope-changed'){
        f.store.db.prepare('UPDATE missions SET goal=? WHERE id=?')
          .run('synthetic altered owner scope',childId);
      }else{
        f.store.db.prepare('UPDATE goal_plans SET status=? WHERE id=?')
          .run('SUPERSEDED',witness.planId);
      }
      assert.throws(()=>validateSuccessorWitness(f.store,f.goalId,SRC_SHA,witness),undefined,
        scenario);
    }finally{f.close();}
  }
});

test('GoalReleaseGate stores only a verified successor source-SHA receipt and cannot claim entire release complete',async()=>{
  const f=fixture();try{
    f.finishParent();const {childId,firstPrompt}=f.firstChild();
    await capture(f,childId,pair(firstPrompt));f.reviewChild(childId);
    const graph=f.ledger.graph(f.goalId),item=graph.items[0]!,criterion=graph.acceptance[0]!;
    const reviewing=f.ledger.setWorkStatus(f.goalId,item.id,item.version,
      'REVIEW',[],'synthetic-review');
    f.ledger.recordAcceptance(f.goalId,criterion.id,criterion.version,
      'PASS',['browser-sha256:'+sha(childAnswer)],'synthetic-criterion-reviewed');
    f.ledger.setWorkStatus(f.goalId,item.id,reviewing.version,'PASSED',
      ['browser-sha256:'+sha(childAnswer)],'synthetic-work-passed');
    const gate=new GoalReleaseGate(f.store),begin=gate.begin(f.goalId,SRC_SHA);
    assert.equal(begin.target?.targetSha,SRC_SHA);
    assert.equal(begin.checks.find(x=>x.requirement==='mission-32-successor'),undefined,
      'new release targets do not require a historical 32-turn handoff');
    // Legacy persisted witnesses remain independently verifiable and immutable.
    const evidence=await inspectStoredGoalSuccessorWitnesses(f.store,f.goalId,f.dir,SRC_SHA);
    assert.equal(evidence.state,'PASS');
    assert.match(evidence.proofSha256,/^[a-f0-9]{64}$/);
    await assert.rejects(gate.inspect(f.goalId,'mission-32-successor',{
      source:'chrome-readback',inspect:async()=>evidence,
    }),/requirement|target|registered/i);
    assert.equal(begin.ready,false);
    assert.equal(begin.complete,false);
    await assert.rejects(gate.finalize(f.goalId,async()=>SRC_SHA),/missing|failed|stale/);
    assert.equal(f.store.events(childId).filter(e=>e.type==='chatgpt.browser_reserved').length,1);
  }finally{f.close();}
});


test('production-only adapter refuses a synthetic witness when no verified compiled Worker binary exists',async()=>{
  const f=fixture();try{
    f.finishParent();const {childId,firstPrompt}=f.firstChild();
    await capture(f,childId,pair(firstPrompt));f.reviewChild(childId);
    const {trustedSuccessorReleaseProbe}=await import('../src/core/goal-release-successor-probe.js');
    await assert.rejects(
      trustedSuccessorReleaseProbe(f.store,f.goalId,f.dir,
        join(f.dir,'not-an-enrolled-worker.js')).inspect('mission-32-successor',SRC_SHA),
      /ENOENT|not found|no such file|entrypoint|enrolled Windows Worker/i);
    assert.equal(new GoalReleaseGate(f.store).report(f.goalId).target,null);
  }finally{f.close();}
});
