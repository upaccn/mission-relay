import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import type {Page} from 'playwriter';
import {Store} from '../src/core/store.js';
import {drivePiAutopilot,pauseFailedPiPlanning} from '../src/core/pi-autopilot.js';
import {browserFreshTaskPrompt,browserNewChatPrompt,browserRolloverRecoveryPrompt,
  browserRolloverPiPlan} from '../src/core/browser-controller.js';
import type {PiPlanner,PiTurnContext} from '../src/core/pi-planner.js';

const SOURCE='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174000';
const DEST='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174001';
const DEST2='https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174002';

test('initial and new-chat PI prompts admit all four completion/continuation markers',()=>{
  const first=browserFreshTaskPrompt('Perform a three-stage, read-only audit');
  const next=browserNewChatPrompt('Complete audit',['Check all stages'],'Prior evidence','Inspect next stage');
  for(const prompt of [first,next]) {
    for(const marker of ['NEXT','HANDOFF','DONE','BLOCKED'])
      assert.ok(prompt.includes(`[MISSION_RELAY:${marker}]`));
    assert.match(prompt,/read-only|without specific authorization/);
  }
});

function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'relay-pi-autopilot-'));
  const store=new Store(join(dir,'db.sqlite'));
  const created=store.create({goal:'Audit NetBox IP lookup',
    acceptance:['Explain source and evidence gaps'],workspace:'',
    sandbox:'read-only',mode:'supervised',maxTurns:3,checks:[],requestKey:'pi-fake'});
  const linked=store.linkChat(created.id,SOURCE,created.version).mission;
  const mission=store.bindChatBrowser(linked.id,'install:Chrome:fake',linked.version).mission;
  let currentUrl='about:blank',sends=0,newPages=0,latestPrompt='',baseTurns=0;
  const fresh={
    url:()=>currentUrl,isClosed:()=>false,
    context:()=>({newPage:async()=>{newPages++;return fresh;}}),
    goto:async(url:string)=>{currentUrl=url;},
    waitForLoadState:async()=>{},
    getByRole:()=>({count:async()=>0,first:()=>({isVisible:async()=>false})}),
    locator:(selector:string)=>{
      let role='other';
      if(selector.includes('data-message-author-role="assistant"'))role='assistant';
      if(selector.includes('data-message-author-role="user"'))role='user';
      if(selector.includes('prompt-textarea'))role='composer';
      if(selector.includes('send-button'))role='send';
      const obj:any={
        count:async()=>['composer','send'].includes(role)?1:baseTurns+sends>0?1:0,
        first:()=>obj,last:()=>obj,isVisible:async()=>role!=='other',
        isEnabled:async()=>Boolean(latestPrompt),
        innerText:async()=>role==='user'?latestPrompt:
          baseTurns+sends===1?'First NetBox research answer\n[MISSION_RELAY:DONE]':
            `NetBox research with VRF evidence, observed round ${baseTurns+sends}\n[MISSION_RELAY:DONE]`,
        fill:async(value:string)=>{latestPrompt=value;},
        click:async()=>{sends++;currentUrl=newPages>1?DEST2:DEST;},
      };
      return obj;
    },
  } as unknown as Page;
  const anchor={
    url:()=>SOURCE,isClosed:()=>false,
    context:()=>({newPage:async()=>{newPages++;return fresh;}}),
    getByRole:()=>({count:async()=>0,first:()=>({isVisible:async()=>false})}),
    locator:(selector:string)=>{
      const role=selector.includes('prompt-textarea')?'composer':
        selector.includes('data-message-author-role="assistant"')?'assistant':
          selector.includes('data-message-author-role="user"')?'user':'other';
      const obj:any={
        count:async()=>role==='other'?0:1,
        first:()=>obj,last:()=>obj,isVisible:async()=>role!=='other',
        innerText:async()=>role==='assistant'?'Prior anchor response':'Prior anchor user turn',
      };
      return obj;
    },
  } as unknown as Page;
  return {dir,store,mission,anchor,fresh,
    primeRecovered:()=>{currentUrl=DEST;baseTurns=1;latestPrompt='Previously submitted user prompt';},
    modifyVisibleUser:(value:string)=>{latestPrompt=value;},
    results:()=>({sends,newPages,latestPrompt}),
    cleanup:()=>{store.close();rmSync(dir,{recursive:true,force:true});}};
}

test('exhausted 32-turn PI NEXT creates one durable successor and continues in a fresh chat',async()=>{
  const f=fixture();try{
    const parent=f.store.create({goal:'Complete a multi-mission source audit',
      acceptance:['Verify every outstanding requirement'],workspace:'',
      sandbox:'read-only',mode:'supervised',maxTurns:32,checks:[],requestKey:'chain-root'});
    const linked=f.store.linkChat(parent.id,SOURCE,parent.version).mission;
    const bound=f.store.bindChatBrowser(parent.id,'install:Chrome:fake',linked.version).mission;
    f.store.setMeta(`pi.autopilot.enabled.${parent.id}`,'1');
    const nearLimit=f.store.update(parent.id,bound.version,{state:'PAUSED',turnCount:31},
      'test.prior_verified_rounds');
    const originalPrompt='Prior anchor user turn', originalAnswer='Prior anchor response';
    const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
    f.store.reserveChatBrowserTurn(parent.id,nearLimit.version,'chain-original-32',sha(originalPrompt));
    f.store.finishChatBrowserTurn(parent.id,'chain-original-32',{
      kind:'observed',assistantSha256:sha(originalAnswer),summary:originalAnswer,
      telegramBatch:{terminal:true,flowSignal:'NEXT',piManaged:true},
    });
    f.store.commitPiPlan(parent.id,sha(originalAnswer),[],{
      action:'NEXT',summary:'31 checks done; final requirement remains',
      nextPrompt:'Verify final requirement and report evidence',
    });
    assert.equal(f.store.events(parent.id).find(e=>e.type==='pi.autopilot_finished')?.payload &&
      (f.store.events(parent.id).find(e=>e.type==='pi.autopilot_finished')!.payload as {action:string}).action,'LIMIT');
    const child=f.store.createPiSuccessor(parent.id);
    assert.ok(child);
    assert.equal(f.store.createPiSuccessor(parent.id)?.id,child.id);
    assert.equal(f.store.piChainParent(child.id),parent.id);
    assert.equal(f.store.piChainSuccessor(parent.id),child.id);
    assert.equal(child.turnCount,0);
    assert.equal(child.state,'READY');
    assert.equal(f.store.chatLink(child.id),SOURCE);
    assert.equal(f.store.events(parent.id).filter(e=>e.type==='pi.chain_successor').length,1);
    const planner:PiPlanner={decide:async context=>{
      assert.equal(context.turnCount,1);
      assert.match(context.lastAssistant,/First NetBox research answer/);
      return {action:'DONE',summary:'Independently checked last requirement',nextPrompt:''};
    }};
    const changedSource={...f.anchor,locator:(selector:string)=>{
      const original=f.anchor.locator(selector);
      if(!selector.includes('data-message-author-role="user"'))return original;
      const fake:any={...original,innerText:async()=> 'Another user changed the parent conversation'};
      fake.last=()=>fake;fake.first=()=>fake;
      return fake;
    }} as unknown as Page;
    await assert.rejects(drivePiAutopilot({store:f.store,planner,missionId:child.id,
      revision:child.version,requestPrefix:child.requestKey,page:changedSource,url:SOURCE}),
    /parent ChatGPT conversation changed/);
    assert.equal(f.results().sends,0);
    assert.equal(f.store.chatBrowserTurn(child.id),null);
    await drivePiAutopilot({store:f.store,planner,missionId:child.id,
      revision:child.version,requestPrefix:child.requestKey,page:f.anchor,url:SOURCE});
    assert.equal(f.results().sends,1);
    assert.equal(f.results().newPages,1);
    assert.equal(f.store.get(child.id).turnCount,1);
    assert.equal(f.store.chatLink(child.id),DEST);
    assert.equal(f.store.piPlan(child.id)?.action,'DONE');
    assert.equal(f.store.events(child.id).filter(e=>e.type==='chatgpt.browser_reserved').length,1);
    assert.equal(f.store.events(child.id).filter(e=>e.type==='pi.autopilot_finished').length,1);
    assert.equal(f.store.createPiSuccessor(child.id),null);
  }finally{f.cleanup();}
});

function readySuccessor(f:ReturnType<typeof fixture>,key:string){
  const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
  const parent=f.store.create({goal:'Finish a 32-turn mission without ignoring owner updates',
    acceptance:['Complete the remaining verification'],workspace:'',sandbox:'read-only',
    mode:'supervised',maxTurns:32,checks:[],requestKey:key});
  const linked=f.store.linkChat(parent.id,SOURCE,parent.version).mission;
  const bound=f.store.bindChatBrowser(parent.id,'install:Chrome:fake',linked.version).mission;
  f.store.setMeta(`pi.autopilot.enabled.${parent.id}`,'1');
  const near=f.store.update(parent.id,bound.version,{state:'PAUSED',turnCount:31},'test.prior_rounds');
  f.store.reserveChatBrowserTurn(parent.id,near.version,`${key}-last`,sha('Prior anchor user turn'));
  f.store.finishChatBrowserTurn(parent.id,`${key}-last`,{kind:'observed',
    assistantSha256:sha('Prior anchor response'),summary:'Prior anchor response',
    telegramBatch:{terminal:true,flowSignal:'NEXT',piManaged:true}});
  f.store.commitPiPlan(parent.id,sha('Prior anchor response'),[],{
    action:'NEXT',summary:'Parent evidence verified; more work remains',nextPrompt:'Check the final stage'});
  const child=f.store.createPiSuccessor(parent.id);
  assert.ok(child);
  return {parent,child,sha};
}

test('PI reviews changing owner notes before the first successor Send and persists one revised prompt',async()=>{
  const f=fixture();try{
    const {child,sha}=readySuccessor(f,'preflight-update');
    f.store.queuePiOwnerDirective(child.id,'1981','Also check rollback requirements');
    assert.throws(()=>f.store.reserveChatBrowserTurn(child.id,child.version,'unsafe-early',
      sha('should not send')),/owner notes/);
    assert.equal(f.store.chatBrowserTurn(child.id),null);
    let calls=0;
    const planner:PiPlanner={decide:async context=>{
      if(context.turnCount===0){
        calls++;
        assert.equal(context.responseSha256,sha('Prior anchor response'));
        assert.equal(context.lastAssistant,'Prior anchor response');
        if(calls===1){
          assert.equal(context.ownerDirectives.length,1);
          f.store.queuePiOwnerDirective(child.id,'1982','Also check Windows CI');
          return {action:'NEXT',summary:'First owner note only',nextPrompt:'Check rollback'};
        }
        assert.equal(context.ownerDirectives.length,2);
        return {action:'NEXT',summary:'Both owner notes accepted',
          nextPrompt:'Check rollback requirements and Windows CI before further work'};
      }
      assert.equal(context.turnCount,1);
      return {action:'DONE',summary:'Final stage verified',nextPrompt:''};
    }};
    await drivePiAutopilot({store:f.store,planner,missionId:child.id,
      revision:child.version,requestPrefix:child.requestKey,page:f.anchor,url:SOURCE});
    assert.equal(calls,2);
    assert.equal(f.results().sends,1);
    assert.match(f.results().latestPrompt,/Check rollback requirements and Windows CI/);
    assert.equal(f.store.pendingPiOwnerDirectives(child.id).length,0);
    assert.equal(f.store.events(child.id).filter(e=>e.type==='pi.chain_preflight_decision').length,1);
    assert.equal(f.store.events(child.id).filter(e=>e.type==='chatgpt.browser_reserved').length,1);
    assert.equal(f.store.piPlan(child.id)?.action,'DONE');
  }finally{f.cleanup();}
});

test('a late owner note racing the successor reservation is automatically re-planned without a duplicate Send',async()=>{
  const f=fixture();try{
    const {child}=readySuccessor(f,'preflight-reservation-race');
    const original=f.store.reserveChatBrowserTurn.bind(f.store);
    let injected=false,piPreflightCalls=0;
    f.store.reserveChatBrowserTurn=(id,revision,key,sha)=>{
      if(id===child.id&&!injected){
        injected=true;
        f.store.queuePiOwnerDirective(child.id,'1993','Add the final security regression');
      }
      return original(id,revision,key,sha);
    };
    const planner:PiPlanner={decide:async context=>{
      if(context.turnCount===0){
        piPreflightCalls++;
        assert.equal(context.ownerDirectives.length,1);
        return {action:'NEXT',summary:'Owner security request reviewed',
          nextPrompt:'Run the final security regression before completion'};
      }
      return {action:'DONE',summary:'Security regression confirmed',nextPrompt:''};
    }};
    await drivePiAutopilot({store:f.store,planner,missionId:child.id,
      revision:child.version,requestPrefix:child.requestKey,page:f.anchor,url:SOURCE});
    assert.equal(injected,true);
    assert.equal(piPreflightCalls,1);
    assert.equal(f.results().sends,1);
    assert.match(f.results().latestPrompt,/Run the final security regression/);
    assert.equal(f.store.events(child.id).filter(e=>e.type==='chatgpt.browser_reserved').length,1);
    assert.equal(f.store.events(child.id).filter(e=>e.type==='chatgpt.browser_uncertain').length,0);
    assert.equal(f.store.pendingPiOwnerDirectives(child.id).length,0);
  }finally{f.cleanup();}
});

test('successor rechecks its parent answer after PI inference and refuses a changed tab before reservation',async()=>{
  const f=fixture();try{
    const {child}=readySuccessor(f,'preflight-parent-change');
    f.store.queuePiOwnerDirective(child.id,'1994','Check an extra quality gate');
    let changed=false;
    const changedPage={...f.anchor,locator:(selector:string)=>{
      const original=f.anchor.locator(selector);
      if(!changed||!selector.includes('data-message-author-role="assistant"'))return original;
      const altered:any={...original,innerText:async()=> 'Another agent changed the parent reply'};
      altered.last=()=>altered;altered.first=()=>altered;
      return altered;
    }} as unknown as Page;
    const planner:PiPlanner={decide:async context=>{
      if(context.turnCount===0){
        changed=true; // Simulate a real browser change while PI is thinking.
        return {action:'NEXT',summary:'Owner note included',
          nextPrompt:'Verify the extra quality gate'};
      }
      return {action:'DONE',summary:'Gate checked',nextPrompt:''};
    }};
    await assert.rejects(drivePiAutopilot({store:f.store,planner,missionId:child.id,
      revision:child.version,requestPrefix:child.requestKey,page:changedPage,url:SOURCE}),
    /Source ChatGPT history changed before new-tab Send reservation/);
    assert.equal(f.results().sends,0);
    assert.equal(f.store.chatBrowserTurn(child.id),null);
    assert.equal(f.store.piPlan(child.id)?.round,0);
    changed=false;
    await drivePiAutopilot({store:f.store,planner,missionId:child.id,
      revision:child.version,requestPrefix:child.requestKey,page:f.anchor,url:SOURCE});
    assert.equal(f.results().sends,1);
    assert.equal(f.store.piPlan(child.id)?.action,'DONE');
  }finally{f.cleanup();}
});

test('PI may halt a successor after new owner notes without reserving a browser Send',async()=>{
  const f=fixture();try{
    const {child}=readySuccessor(f,'preflight-stop');
    f.store.queuePiOwnerDirective(child.id,'1991','Stop because a human check is required');
    const planner:PiPlanner={decide:async context=>{
      assert.equal(context.turnCount,0);
      assert.equal(context.ownerDirectives.length,1);
      return {action:'BLOCKED',summary:'Owner human checkpoint required',nextPrompt:''};
    }};
    await drivePiAutopilot({store:f.store,planner,missionId:child.id,
      revision:child.version,requestPrefix:child.requestKey,page:f.anchor,url:SOURCE});
    assert.equal(f.results().sends,0);
    assert.equal(f.store.chatBrowserTurn(child.id),null);
    assert.equal(f.store.get(child.id).state,'BLOCKED');
    assert.equal(f.store.piPlan(child.id)?.action,'BLOCKED');
    assert.equal(f.store.pendingPiOwnerDirectives(child.id).length,0);
    assert.equal(f.store.events(child.id).filter(e=>e.type==='pi.autopilot_finished').length,1);
  }finally{f.cleanup();}
});

test('uncertain successor first-Send recovery reconstructs the owner-revised PI prompt, never its stale parent prompt',()=>{
  const f=fixture();try{
    const {parent,child,sha}=readySuccessor(f,'preflight-recovery');
    f.store.queuePiOwnerDirective(child.id,'1992','Prioritize a Windows deployment gate');
    const directives=f.store.pendingPiOwnerDirectives(child.id);
    const revised={action:'NEXT' as const,summary:'Owner changed release priority',
      nextPrompt:'Verify the Windows deployment gate before changing any runtime process'};
    f.store.commitPiChainPreflight(child.id,sha('Prior anchor response'),
      directives.map(d=>d.id),revised);
    const selected=browserRolloverPiPlan(f.store,child.id);
    assert.equal(selected?.nextPrompt,revised.nextPrompt);
    const args={goal:child.goal,acceptance:child.acceptance,
      sandbox:child.sandbox,workspace:child.workspace,nextInstruction:null,
      turnCount:0,missionRequestKey:child.requestKey,
      reservedRequestKey:`${child.requestKey}-1`,sourceAnswer:'Prior anchor response',
      adopted:false,chainParent:true,piManaged:true};
    const submitted=browserNewChatPrompt(child.goal,child.acceptance,
      revised.summary,revised.nextPrompt,'Prior anchor response',null);
    const recovered=browserRolloverRecoveryPrompt({...args,piPlan:selected});
    assert.equal(recovered,submitted);
    assert.notEqual(recovered,browserRolloverRecoveryPrompt({...args,
      piPlan:f.store.piPlan(parent.id)}));
    f.store.reserveChatBrowserTurn(child.id,child.version,args.reservedRequestKey,sha(submitted.trim()));
    f.store.finishChatBrowserTurn(child.id,args.reservedRequestKey,{kind:'uncertain',
      error:'Synthetic Chrome observer disconnect after an unconfirmed new-tab Send'});
    assert.equal(f.store.chatBrowserTurn(child.id)?.status,'uncertain');
    assert.equal(f.store.chatBrowserTurn(child.id)?.promptSha256,sha(recovered.trim()));
    assert.throws(()=>f.store.reserveChatBrowserTurn(child.id,f.store.get(child.id).version,
      `${child.requestKey}-2`,sha('different message')),/Cannot run browser turn|Previous browser turn/);
  }finally{f.cleanup();}
});

test('a PI NEXT after eight observed sends starts exactly one fresh chat and preserves its Mission',async()=>{
  const f=fixture();try{
    const created=f.store.create({goal:'Long-running staged evidence audit',
      acceptance:['Gather nine independently checked rounds'],workspace:'',
      sandbox:'read-only',mode:'supervised',maxTurns:10,checks:[],requestKey:'pi-long'});
    const linked=f.store.linkChat(created.id,SOURCE,created.version).mission;
    const bound=f.store.bindChatBrowser(linked.id,'install:Chrome:fake',linked.version).mission;
    const planner:PiPlanner={decide:async input=>input.turnCount<9
      ?{action:'NEXT',summary:'Evidence still pending',nextPrompt:'Review another evidence item'}
      :{action:'DONE',summary:'Nine rounds checked',nextPrompt:''}};
    await drivePiAutopilot({store:f.store,planner,missionId:bound.id,
      revision:bound.version,requestPrefix:'pi-rotate',page:f.anchor,url:SOURCE});
    const m=f.store.get(bound.id);
    assert.equal(m.turnCount,9);
    assert.equal(f.results().sends,9);
    assert.equal(f.results().newPages,2);
    assert.equal(f.store.piChatObservedTurns(m.id),1);
    assert.equal(f.store.chatLink(m.id),DEST2);
    assert.equal(f.store.events(m.id).filter(x=>x.type==='chatgpt.browser_migrated').length,2);
    assert.equal(f.store.events(m.id).filter(x=>x.type==='chatgpt.browser_reserved').length,9);
    assert.equal(f.store.events(m.id).filter(x=>x.type==='pi.autopilot_finished').length,1);
  }finally{f.cleanup();}
});

test('PI independently keeps ChatGPT running after model DONE, reviews queued owner changes and emits one final result',async()=>{
  const f=fixture();try{
    const inputs:PiTurnContext[]=[];
    let call=0;
    const planner:PiPlanner={decide:async input=>{
      inputs.push(input);
      if(++call===1){
        assert.equal(input.turnCount,1);
        f.store.queuePiOwnerDirective(f.mission.id,'901','Need to check VRF too');
        return {action:'NEXT',summary:'More VRF evidence needed',nextPrompt:'Check VRF mapping'};
      }
      if(call===2){
        assert.equal(input.ownerDirectives.length,1);
        assert.equal(input.ownerDirectives[0]?.text,'Need to check VRF too');
        return {action:'NEXT',summary:'Review queued VRF instruction',nextPrompt:'Include VRF evidence'};
      }
      assert.equal(input.turnCount,2);
      return {action:'DONE',summary:'NetBox read-only research completed',nextPrompt:''};
    }};
    await drivePiAutopilot({store:f.store,planner,missionId:f.mission.id,
      revision:f.mission.version,requestPrefix:'pi-tst',page:f.anchor,url:SOURCE});
    const end=f.store.get(f.mission.id);
    assert.equal(end.state,'PAUSED');
    assert.equal(end.turnCount,2);
    assert.equal(f.results().sends,2);
    assert.equal(f.results().newPages,1);
    assert.match(f.results().latestPrompt,/Include VRF evidence/);
    for(const marker of ['NEXT','HANDOFF','DONE','BLOCKED'])
      assert.ok(f.results().latestPrompt.includes(`[MISSION_RELAY:${marker}]`));
    assert.equal(f.store.chatLink(end.id),DEST);
    assert.equal(f.store.pendingPiOwnerDirectives(end.id).length,0);
    assert.equal(f.store.piPlan(end.id)?.action,'DONE');
    const e=f.store.events(end.id);
    assert.equal(e.filter(x=>x.type==='chatgpt.browser_reserved').length,2);
    assert.equal(e.filter(x=>x.type==='chatgpt.browser_observed').length,2);
    assert.equal(e.filter(x=>x.type==='pi.decision').length,2);
    assert.equal(e.filter(x=>x.type==='pi.autopilot_finished').length,1);
    assert.equal(e.filter(x=>x.type==='chatgpt.browser_run_finished').length,0);
    assert.throws(()=>f.store.queuePiOwnerDirective(end.id,'902','A late instruction'),/terminal decision/);
    assert.equal(inputs.length,3); // Replanned on newly arrived owner message.
  }finally{f.cleanup();}
});

test('PI safely reviews a fully observed but not yet PI-reviewed turn after a crash without a duplicate browser Send',async()=>{
  const f=fixture();try{
    const answer='Recovered answer with concrete evidence';
    const sha=createHash('sha256').update(answer).digest('hex');
    const m=f.store.reserveChatBrowserTurn(f.mission.id,f.mission.version,
      'pi-recover-1','b'.repeat(64));
    f.store.finishChatBrowserTurn(m.id,'pi-recover-1',{kind:'observed',
      assistantSha256:sha,summary:'Previous answer',newChatUrl:DEST,
      telegramBatch:{terminal:false,flowSignal:'DONE',piManaged:true}});
    f.primeRecovered();
    const planner:PiPlanner={decide:async context=>{
      assert.equal(context.turnCount,1);
      assert.equal(context.lastAssistant,'Recovered answer with concrete evidence');
      return {action:'DONE',summary:'Earlier browser response is complete',nextPrompt:''};
    }};
    await drivePiAutopilot({store:f.store,planner,missionId:m.id,
      revision:f.store.get(m.id).version,requestPrefix:'pi-recover',
      page:f.fresh,url:DEST,recoveredAnswer:{
        responseSha256:sha,lastAssistant:answer,
      }});
    assert.equal(f.results().sends,0);
    assert.equal(f.store.piPlan(m.id)?.action,'DONE');
    assert.equal(f.store.events(m.id).filter(e=>e.type==='pi.autopilot_finished').length,1);
  }finally{f.cleanup();}
});

test('PI accepts an independently inspected recovered rollover, without replay or false completion',async()=>{
  const f=fixture();try{
    const answer='First NetBox research answer\n[MISSION_RELAY:DONE]';
    const promptSha='b'.repeat(64);
    const sha=createHash('sha256').update(answer).digest('hex');
    const reserved=f.store.reserveChatBrowserTurn(f.mission.id,f.mission.version,
      'pi-recovered-rollover-1',promptSha);
    f.store.finishChatBrowserTurn(reserved.id,'pi-recovered-rollover-1',{
      kind:'uncertain',error:'Observer lost the browser after Send',
    });
    f.store.recoverObservedBrowserRollover(reserved.id,
      f.store.get(reserved.id).version,{
        requestPromptSha256:promptSha,newChatUrl:DEST,
        assistantSha256:sha,summary:answer,
      });
    assert.equal(f.store.chatBrowserTurn(reserved.id)?.status,'reconciled');
    assert.equal(f.store.hasVerifiedPiBrowserCheckpoint(reserved.id),true);
    f.primeRecovered();
    const planner:PiPlanner={decide:async input=>{
      assert.equal(input.turnCount,1);
      assert.equal(input.lastAssistant,answer);
      return {action:'DONE',summary:'Recovered response reviewed',nextPrompt:''};
    }};
    await drivePiAutopilot({store:f.store,planner,missionId:reserved.id,
      revision:f.store.get(reserved.id).version,requestPrefix:'pi-recovered-rollover',
      page:f.fresh,url:DEST,recoveredAnswer:{responseSha256:sha,lastAssistant:answer},
    });
    assert.equal(f.results().sends,0);
    assert.equal(f.store.piPlan(reserved.id)?.action,'DONE');
    assert.equal(f.store.events(reserved.id).filter(x=>x.type==='chatgpt.browser_reserved').length,1);
    assert.equal(f.store.events(reserved.id).filter(x=>x.type==='pi.autopilot_finished').length,1);
  }finally{f.cleanup();}
});

test('PI rejects an operator-acknowledged ambiguous Send without independently recovered answer evidence',async()=>{
  const f=fixture();try{
    const promptSha='b'.repeat(64);
    const reserved=f.store.reserveChatBrowserTurn(f.mission.id,f.mission.version,
      'pi-manual-only-1',promptSha);
    f.store.finishChatBrowserTurn(reserved.id,'pi-manual-only-1',{
      kind:'uncertain',error:'Original outcome unknown',
    });
    f.store.reconcileChatBrowserTurn(reserved.id);
    assert.equal(f.store.chatBrowserTurn(reserved.id)?.status,'reconciled');
    assert.equal(f.store.hasVerifiedPiBrowserCheckpoint(reserved.id),false);
    assert.throws(()=>f.store.commitPiPlan(reserved.id,'a'.repeat(64),[],{
      action:'DONE',summary:'Unsupported conclusion',nextPrompt:'',
    }),/PI decision requires one matching/);
    const planner:PiPlanner={decide:async()=>{throw new Error('PI must not infer');}};
    await assert.rejects(drivePiAutopilot({store:f.store,planner,
      missionId:reserved.id,revision:f.store.get(reserved.id).version,
      requestPrefix:'pi-manual-only',page:f.fresh,url:DEST,
      recoveredAnswer:{responseSha256:'a'.repeat(64),lastAssistant:'Unverified'},
    }),/unstarted READY|fully observed browser checkpoint/);
    assert.equal(f.results().sends,0);
    assert.equal(f.store.events(reserved.id).filter(x=>x.type==='pi.decision').length,0);
  }finally{f.cleanup();}
});

test('PI refuses recovery when the latest observed receipt is missing or uncertain',async()=>{
  const f=fixture();try{
    const planner:PiPlanner={decide:async()=>({action:'NEXT',summary:'continue',nextPrompt:'Check VRF'})};
    const claimed=f.store.reserveChatBrowserTurn(f.mission.id,f.mission.version,
      'pi-uncertain-1','b'.repeat(64));
    f.store.finishChatBrowserTurn(claimed.id,'pi-uncertain-1',{
      kind:'uncertain',error:'Browser replied ambiguously'});
    f.primeRecovered();
    await assert.rejects(drivePiAutopilot({store:f.store,planner,missionId:claimed.id,
      revision:f.store.get(claimed.id).version,requestPrefix:'pi-uncertain',
      page:f.fresh,url:DEST,recoveredAnswer:{responseSha256:'a'.repeat(64),lastAssistant:'Invalid'},
    }),/unstarted READY|fully observed/);
    assert.equal(f.results().sends,0);
  }finally{f.cleanup();}
});

test('PI decision transaction never consumes owner instructions on stale SHA or queue mismatch',()=>{
  const f=fixture();try{
    const m=f.store.reserveChatBrowserTurn(f.mission.id,f.mission.version,'pi-rollback-1',
      'b'.repeat(64));
    f.store.finishChatBrowserTurn(m.id,'pi-rollback-1',{kind:'observed',
      assistantSha256:'a'.repeat(64),summary:'A completed read-only browser reply',
      telegramBatch:{terminal:false,flowSignal:'DONE',piManaged:true}});
    f.store.queuePiOwnerDirective(m.id,'108','Please check VRF before finishing');
    const done={action:'DONE' as const,summary:'Answer reviewed',nextPrompt:''};
    assert.throws(()=>f.store.commitPiPlan(m.id,'b'.repeat(64),[1],done),/fully observed/);
    assert.throws(()=>f.store.commitPiPlan(m.id,'a'.repeat(64),[],done),/instructions changed/);
    assert.equal(f.store.pendingPiOwnerDirectives(m.id).length,1);
    assert.equal(f.store.events(m.id).filter(e=>e.type==='pi.decision').length,0);
    const ids=f.store.pendingPiOwnerDirectives(m.id).map(x=>x.id);
    f.store.commitPiPlan(m.id,'a'.repeat(64),ids,done);
    assert.equal(f.store.pendingPiOwnerDirectives(m.id).length,0);
    assert.equal(f.store.events(m.id).filter(e=>e.type==='pi.decision').length,1);
  }finally{f.cleanup();}
});

test('PI may revise a NEXT decision when a new Telegram instruction arrives after checkpoint, without duplicating a browser turn',()=>{
  const f=fixture();try{
    const m=f.store.reserveChatBrowserTurn(f.mission.id,f.mission.version,
      'pi-replan-1','b'.repeat(64));
    f.store.finishChatBrowserTurn(m.id,'pi-replan-1',{kind:'observed',
      assistantSha256:'a'.repeat(64),summary:'First browser reply',
      telegramBatch:{terminal:false,flowSignal:'DONE',piManaged:true}});
    f.store.commitPiPlan(m.id,'a'.repeat(64),[],{
      action:'NEXT',summary:'Check interface',nextPrompt:'Inspect interface',
    });
    f.store.queuePiOwnerDirective(m.id,'119','Please stop after this review for manual testing');
    const ids=f.store.pendingPiOwnerDirectives(m.id).map(x=>x.id);
    const final=f.store.commitPiPlan(m.id,'a'.repeat(64),ids,{
      action:'BLOCKED',summary:'Owner will test Android manually',nextPrompt:'',
    },true);
    assert.equal(final.action,'BLOCKED');
    assert.equal(f.store.pendingPiOwnerDirectives(m.id).length,0);
    assert.equal(f.store.events(m.id).filter(e=>e.type==='pi.decision_revised').length,1);
    assert.equal(f.store.events(m.id).filter(e=>e.type==='pi.autopilot_finished').length,1);
    assert.equal(f.store.events(m.id).filter(e=>e.type==='chatgpt.browser_reserved').length,1);
  }finally{f.cleanup();}
});

test('PI human-follow-up BLOCKED stops without a second browser send',async()=>{
  const f=fixture();try{
    const planner:PiPlanner={decide:async()=>({
      action:'BLOCKED',summary:'The owner must carry out the next physical Android test',nextPrompt:'',
    })};
    await drivePiAutopilot({store:f.store,planner,missionId:f.mission.id,
      revision:f.mission.version,requestPrefix:'pi-human',page:f.anchor,url:SOURCE});
    assert.equal(f.results().sends,1);
    const finish=f.store.events(f.mission.id).find(x=>x.type==='pi.autopilot_finished');
    assert.equal((finish?.payload as {action?:string}).action,'BLOCKED');
  }finally{f.cleanup();}
});

test('PI failure after a real observed answer fails closed without a second Send',async()=>{
  const f=fixture();try{
    const planner:PiPlanner={decide:async()=>{throw new Error('PI unreachable');}};
    await assert.rejects(drivePiAutopilot({store:f.store,planner,missionId:f.mission.id,
      revision:f.mission.version,requestPrefix:'pi-error',page:f.anchor,url:SOURCE}),/PI unreachable/);
    pauseFailedPiPlanning(f.store,f.mission.id,'PI unreachable');
    assert.equal(f.results().sends,1);
    assert.equal(f.store.get(f.mission.id).state,'PAUSED');
    assert.equal(f.store.events(f.mission.id).filter(x=>x.type==='pi.autopilot_interrupted').length,1);
    assert.equal(f.store.events(f.mission.id).filter(x=>x.type==='pi.autopilot_finished').length,0);
  }finally{f.cleanup();}
});

test('PI refuses to send into a ChatGPT conversation manually altered while PI was planning',async()=>{
  const f=fixture();try{
    const planner:PiPlanner={decide:async()=>{
      f.modifyVisibleUser('A human typed a different user turn during PI planning');
      return {action:'NEXT',summary:'Research could continue',nextPrompt:'Check VRF evidence'};
    }};
    await assert.rejects(drivePiAutopilot({
      store:f.store,planner,missionId:f.mission.id,
      revision:f.mission.version,requestPrefix:'pi-human-changed',
      page:f.anchor,url:SOURCE,
    }),/visible ChatGPT history differs/);
    assert.equal(f.results().sends,1);
    assert.equal(f.store.get(f.mission.id).turnCount,1);
    assert.equal(f.store.events(f.mission.id).filter(e=>e.type==='chatgpt.browser_reserved').length,1);
  }finally{f.cleanup();}
});
