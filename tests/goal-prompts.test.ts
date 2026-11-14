import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/core/store.js';
import {GoalLedger} from '../src/core/goal-store.js';
import {goalWorkPrompt} from '../src/core/goal-prompts.js';
import {browserFreshTaskPrompt,browserGoalPlanningPrompt,browserNewChatPrompt,browserRolloverRecoveryPrompt,
  exactReservedRolloverPrompt} from '../src/core/browser-controller.js';

const sha=(value:string)=>createHash('sha256').update(value.trim()).digest('hex');
const URL='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174000';
const ownerGoal='OWNER LONG-TERM GOAL: build a robust private service with many coordinator rules';
const ownerAcceptance='Independent release acceptance requires observed production evidence';

test('initial Goal browser Send is planning-only even with a previously approved write workspace',()=>{
  const workspace='/srv/projects/mission-relay';
  const owner='Implement Mission Relay v1.0 and deploy it now.';
  const prompt=browserGoalPlanningPrompt(owner,['Prove production recovery'],workspace);
  assert.match(prompt,/INITIAL READ-ONLY DISCOVERY/);
  assert.match(prompt,/Implement Mission Relay v1.0/);
  assert.match(prompt,/Prove production recovery/);
  assert.match(prompt,/Candidate implementation repository \(reference only\)/);
  assert.match(prompt,/Task scope: read-only/);
  assert.match(prompt,/do not edit code or files, run tests/);
  assert.match(prompt,/PI controller will independently approve/);
  assert.doesNotMatch(prompt,/Task scope: implement and test code in/);
  assert.doesNotMatch(prompt,/Use available tools to inspect and edit/);
  assert.notEqual(prompt,browserFreshTaskPrompt(owner,workspace),
    'Non-Goal owner /build retains execution capability; initial Goal cannot inherit it');
  assert.throws(()=>browserGoalPlanningPrompt(' ',[],workspace),/1–4000/);
  assert.throws(()=>browserGoalPlanningPrompt('a'.repeat(4001),[],workspace),/1–4000/);
  assert.throws(()=>browserGoalPlanningPrompt(owner,['a'.repeat(12000)],workspace),
    /12000 characters/);
});

test('new Goal planning rollover reconstructs both current and pre-upgrade reservations without replay',()=>{
  const owner='Plan Mission Relay v1.0 acceptance and safe deployment';
  const workspace='/srv/projects/mission-relay';
  const args={goal:owner,acceptance:['PI-independent review'],
    sandbox:'workspace-write' as const,workspace,nextInstruction:null,turnCount:0,
    missionRequestKey:'goal-stage-new',reservedRequestKey:'goal-stage-new-1',
    sourceAnswer:'unrelated old anchor reply',adopted:false,chainParent:false,
    piManaged:true,piPlan:null,goalBound:true};
  const planning=browserGoalPlanningPrompt(owner,args.acceptance,workspace);
  const legacy=browserFreshTaskPrompt(owner,workspace);
  assert.equal(browserRolloverRecoveryPrompt(args),planning);
  assert.equal(browserRolloverRecoveryPrompt(args,true),legacy);
  assert.deepEqual(exactReservedRolloverPrompt(args,sha(planning)),
    {prompt:planning,format:'compact'});
  assert.deepEqual(exactReservedRolloverPrompt(args,sha(legacy)),
    {prompt:legacy,format:'legacy'});
  assert.throws(()=>exactReservedRolloverPrompt(args,sha('Unrelated content')),
    /Neither compact nor legacy/);
  assert.equal(browserRolloverRecoveryPrompt({...args,goalBound:false}),legacy);
});

function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'mission-relay-wp3-'));
  const file=join(dir,'state.sqlite');
  const store=new Store(file),ledger=new GoalLedger(store);
  const goal=ledger.createGoal({requestKey:'long-term-owner-goal',
    objective:ownerGoal,priority:95});
  const created=store.create({goal:ownerGoal,acceptance:[ownerAcceptance],checks:[],
    workspace:'',sandbox:'read-only',mode:'supervised',maxTurns:32,requestKey:'wp3-goal-mission'});
  const linked=store.linkChat(created.id,URL,created.version).mission;
  const bound=store.bindChatBrowser(created.id,'install:Chrome:fake',linked.version).mission;
  store.setMeta(`pi.autopilot.enabled.${bound.id}`,'1');
  ledger.bindPiMission(goal.id,bound.id,bound.version,'bind-owner-goal');
  const plan=ledger.createPlan(goal.id,goal.version,{requestKey:'plan-one',summary:'Internal PI roadmap',
    items:[{key:'isolated-wp',title:'Build the persistence adapter',
      description:'Implement a narrowly scoped read-only validation of adapter behavior.',
      priority:100,dependsOn:[],acceptance:[
        'Prove a stable SHA-256 test fixture','Confirm no unexpected browser Send',
      ]}]});
  ledger.setPlanStatus(goal.id,plan.id,plan.version,'APPROVED','approve-plan-one');
  ledger.setGoalStatus(goal.id,ledger.getGoal(goal.id).version,'ACTIVE','activate-goal');
  const item=ledger.graph(goal.id).items[0]!;
  const ready=ledger.setWorkStatus(goal.id,item.id,item.version,'READY',[],'ready-first');
  ledger.setWorkStatus(goal.id,item.id,ready.version,'IN_PROGRESS',[],'start-first');
  const previousPrompt='First-round full owner goal and plan proposal';
  const previousAnswer='PI reviewed an initial analysis; work package not yet executed';
  store.reserveChatBrowserTurn(bound.id,store.get(bound.id).version,'original-1',
    sha(previousPrompt),{newConversation:true});
  store.finishChatBrowserTurn(bound.id,'original-1',{kind:'observed',newChatUrl:
    'https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174001',
    assistantSha256:sha(previousAnswer),summary:previousAnswer});
  const piPlan=store.commitPiPlan(bound.id,sha(previousAnswer),[],{
    action:'NEXT',summary:'PI INTERNAL ONLY: multi-stage plan and browser budget',
    nextPrompt:'Validate the persistence adapter and provide checkable results',
  });
  return {dir,file,store,ledger,goal,itemId:item.id,missionId:bound.id,piPlan,
    close:()=>{store.close();rmSync(dir,{recursive:true,force:true});}};
}

test('Goal-bound same-chat and new-chat prompts contain ONLY current work, scope and acceptance',()=>{
  const f=fixture();
  try{
    for(const fresh of [false,true]){
      const result=goalWorkPrompt(f.store,f.missionId,f.piPlan,null,fresh);
      const p=result.prompt;
      assert.equal(result.format,'goal-work-v1');
      assert.match(p,/Build the persistence adapter/);
      assert.match(p,/Prove a stable SHA-256 test fixture/);
      assert.match(p,/Confirm no unexpected browser Send/);
      assert.doesNotMatch(p,/CI budget: avoid metered GitHub Actions/,
        'Read-only investigation does not need a write-oriented CI spending policy');
      assert.match(p,/Scope: read-only investigation/);
      assert.match(p,/Validate the persistence adapter and provide checkable results/);
      assert.ok(p.startsWith(fresh?'Start this work package in a new conversation.':
        'Continue this work package in the current conversation.'));
      for(const forbidden of [
        ownerGoal,ownerAcceptance,'PI INTERNAL ONLY','Internal PI roadmap',
        'turnCount','maxTurns','5 Relay Sends','32 turns','PI strategy',
        'Previous conversation checkpoint','Previous ChatGPT answer evidence excerpt',
        'GitHub main','Connection interrupted','Retry',
      ])assert.ok(!p.includes(forbidden),`Leaked controller/owner-level context: ${forbidden}`);
      assert.ok(!p.includes('https://chatgpt.com'));
      assert.equal(p.match(/Work package:/g)?.length,1);
    }
    assert.equal(f.store.events(f.missionId).filter(e=>e.type==='chatgpt.browser_reserved').length,1,
      'Preparing prompts must not reserve or send browser requests');
  }finally{f.close();}
});

test('versioned prompt is saved atomically with one browser reservation and reopens byte-for-byte',()=>{
  const f=fixture();
  let reader:Store|undefined;
  try{
    const item=goalWorkPrompt(f.store,f.missionId,f.piPlan,null,true);
    const at=f.store.get(f.missionId).version;
    f.store.reserveChatBrowserTurn(f.missionId,at,'goal-work-2',sha(item.prompt),{
      newConversation:true,promptSnapshot:{format:item.format,prompt:item.prompt},
      goalBinding:item.binding,
    });
    const reserved=f.store.chatBrowserTurn(f.missionId)!;
    assert.equal(reserved.status,'reserved');
    assert.equal(reserved.promptSha256,sha(item.prompt));
    assert.deepEqual(f.store.reservedBrowserPrompt(f.missionId,'goal-work-2'),{
      format:'goal-work-v1',prompt:item.prompt,
    });
    reader=new Store(f.file,{readOnly:true});
    assert.deepEqual(reader.reservedBrowserPrompt(f.missionId,'goal-work-2'),{
      format:'goal-work-v1',prompt:item.prompt,
    },'Read-only process restart must reconstruct exact bytes without schema writes');
    assert.throws(()=>reader!.reserveChatBrowserTurn(f.missionId,at,
      'goal-work-2',sha(item.prompt)),/READONLY|readonly|State conflict/);
    assert.throws(()=>f.store.reserveChatBrowserTurn(f.missionId,at,
      'goal-work-2',sha(item.prompt)),/State conflict|already used/);
    assert.equal(f.store.events(f.missionId).filter(e=>e.type==='chatgpt.browser_reserved').length,2);
    assert.equal(f.store.events(f.missionId).at(-1)?.type,'chatgpt.browser_reserved');
    assert.equal((f.store.events(f.missionId).at(-1)?.payload as {promptFormat?:string})
      ?.promptFormat,'goal-work-v1');
    assert.equal((f.store.events(f.missionId).at(-1)?.payload as {workItemVersion?:number})
      ?.workItemVersion,item.binding.itemVersion);
    // An original reserved prompt remains reconstructable if the Goal later
    // pauses or its active work/version changes. Do not regenerate from live
    // mutable planning data to inspect a possibly submitted browser message.
    f.ledger.setGoalStatus(f.goal.id,f.ledger.getGoal(f.goal.id).version,
      'PAUSED','goal-paused-after-original-reservation');
    assert.throws(()=>goalWorkPrompt(f.store,f.missionId,f.piPlan,null,true),
      /Goal must be active/);
    assert.deepEqual(f.store.reservedBrowserPrompt(f.missionId,'goal-work-2'),{
      format:'goal-work-v1',prompt:item.prompt,
    });
  }finally{reader?.close();f.close();}
});

test('a changed work version or PI decision refuses the new snapshot before reservation',()=>{
  for(const mode of ['work','pi','owner-note'] as const){
    const f=fixture();
    try{
      const selected=goalWorkPrompt(f.store,f.missionId,f.piPlan,null,false);
      if(mode==='work'){
        const work=f.ledger.getWork(f.goal.id,f.itemId);
        f.ledger.setWorkStatus(f.goal.id,f.itemId,work.version,'REVIEW',[],'changed-item');
      }else if(mode==='pi'){
        f.store.setMeta(`pi.plan.${f.missionId}`,JSON.stringify({
          ...f.piPlan,nextPrompt:'Changed PI directive before reservation',
        }));
      }else{
        f.store.queuePiOwnerDirective(f.missionId,'909','A new owner note before Send');
      }
      assert.throws(()=>f.store.reserveChatBrowserTurn(f.missionId,
        f.store.get(f.missionId).version,'goal-work-2',sha(selected.prompt),{
          promptSnapshot:{format:'goal-work-v1',prompt:selected.prompt},
          goalBinding:selected.binding,
        }),/Goal work package or PI checkpoint changed/);
      assert.equal(f.store.chatBrowserTurn(f.missionId)?.status,'observed');
      assert.equal(f.store.getMeta(`chatgpt.browser.prompt.${f.missionId}.goal-work-2`),null);
      assert.equal(f.store.events(f.missionId).filter(e=>e.type==='chatgpt.browser_reserved').length,1);
    }finally{f.close();}
  }
});

test('corrupted present snapshot fails closed and cannot fall back to rewritten Goal state',()=>{
  const f=fixture();
  try{
    const item=goalWorkPrompt(f.store,f.missionId,f.piPlan,null,true);
    f.store.reserveChatBrowserTurn(f.missionId,f.store.get(f.missionId).version,
      'goal-work-2',sha(item.prompt),{newConversation:true,
        promptSnapshot:{format:item.format,prompt:item.prompt},goalBinding:item.binding});
    const key=`chatgpt.browser.prompt.${f.missionId}.goal-work-2`;
    f.store.setMeta(key,JSON.stringify({format:'goal-work-v1',prompt:'TAMPERED text'}));
    assert.throws(()=>f.store.reservedBrowserPrompt(f.missionId,'goal-work-2'),
      /does not match original reservation SHA/);
    f.store.setMeta(key,'NOT JSON');
    assert.throws(()=>f.store.reservedBrowserPrompt(f.missionId,'goal-work-2'),
      /invalid JSON/);
    assert.equal(f.store.chatBrowserTurn(f.missionId)?.status,'reserved');
  }finally{f.close();}
});

test('bad versioned payload, fake Goal association or trigger failure never partially reserve a Send',()=>{
  const f=fixture();
  try{
    const item=goalWorkPrompt(f.store,f.missionId,f.piPlan,null,false);
    const version=f.store.get(f.missionId).version;
    assert.throws(()=>f.store.reserveChatBrowserTurn(f.missionId,version,
      'goal-work-2',sha(item.prompt),{
        promptSnapshot:{format:item.format,prompt:'fake wrong prompt'},goalBinding:item.binding,
      }),/must match its exact reserved SHA/);
    assert.throws(()=>f.store.reserveChatBrowserTurn(f.missionId,version,
      'goal-work-2',sha(item.prompt),{
        promptSnapshot:{format:item.format,prompt:item.prompt},
        goalBinding:{...item.binding,goalId:'fake-id'},
      }),/Goal work package or PI checkpoint changed/);
    assert.equal(f.store.chatBrowserTurn(f.missionId)?.status,'observed');
    f.store.db.exec(`CREATE TRIGGER reject_goal_reserved
      BEFORE INSERT ON events WHEN NEW.type='chatgpt.browser_reserved'
      BEGIN SELECT RAISE(ABORT,'injected reservation audit failure'); END;`);
    assert.throws(()=>f.store.reserveChatBrowserTurn(f.missionId,version,
      'goal-work-2',sha(item.prompt),{
        promptSnapshot:{format:item.format,prompt:item.prompt},goalBinding:item.binding,
      }),/injected reservation audit failure/);
    assert.equal(f.store.getMeta(`chatgpt.browser.prompt.${f.missionId}.goal-work-2`),null);
    assert.equal(f.store.getMeta(`chatgpt.browser.request.${f.missionId}.goal-work-2`),null);
    assert.equal(f.store.chatBrowserTurn(f.missionId)?.status,'observed');
    assert.equal(f.store.get(f.missionId).version,version);
  }finally{f.close();}
});

test('pre-WP3 historical compact/legacy/fresh prompt hashes stay frozen and reconstructable',()=>{
  const owner='Legacy owner objective';
  const prior='Earlier completed research\n[MISSION_RELAY:NEXT]';
  const plan={action:'NEXT' as const,summary:'PI reviewed summary',
    nextPrompt:'Inspect next stage',round:5,responseSha256:sha(prior),
    reviewedDirectiveIds:[]};
  const args={goal:owner,acceptance:['Check evidence'],sandbox:'read-only' as const,
    workspace:'',nextInstruction:null,turnCount:5,missionRequestKey:'legacy-mission',
    reservedRequestKey:'legacy-mission-6',sourceAnswer:prior,
    adopted:false,chainParent:false,piManaged:true,piPlan:plan};
  const historical=[
    {format:'compact',sha:'9a889a631641dc1cf0e8db4bae304b80c7c3a67898239e027977ad3539a67f04'},
    {format:'legacy',sha:'8e735f9f87ee613cb8efc0948f8b04df13bd33c7befe3e164827cfcb29d9493f'},
  ] as const;
  for(const old of historical){
    const recovered=exactReservedRolloverPrompt(args,old.sha);
    assert.equal(recovered.format,old.format);
    assert.equal(sha(recovered.prompt),old.sha);
    assert.equal(recovered.prompt,browserRolloverRecoveryPrompt(args,old.format==='legacy'));
    assert.equal(recovered.prompt,browserNewChatPrompt(owner,['Check evidence'],
      plan.summary,plan.nextPrompt,prior,null,
      old.format==='legacy'?undefined:{round:5,responseSha256:sha(prior)},
      old.format==='legacy'));
  }
  assert.equal(sha(browserFreshTaskPrompt(owner)),
    '0fe6dfd9d2d0dd59f26aa641a9bcb900421feed668cd54860347c297143686b4');
  assert.throws(()=>exactReservedRolloverPrompt(args,'f'.repeat(64)),
    /Neither compact nor legacy handoff matches/);
  assert.throws(()=>exactReservedRolloverPrompt(args,'not-a-hash'),/Invalid stored/);
});

test('original unversioned reserved requests remain unmodified and have no inferred snapshots',()=>{
  const f=fixture();
  try{
    assert.equal(f.store.reservedBrowserPrompt(f.missionId,'original-1'),null);
    assert.equal(f.store.getMeta(`chatgpt.browser.prompt.${f.missionId}.original-1`),null);
    assert.equal(f.store.events(f.missionId)
      .filter(e=>e.type==='chatgpt.browser_reserved').length,1);
  }finally{f.close();}
});
