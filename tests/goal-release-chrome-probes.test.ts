import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Page} from 'playwriter';
import {Store} from '../src/core/store.js';
import {GoalLedger} from '../src/core/goal-store.js';
import {inspectPiEvidence} from '../src/core/pi-evidence.js';
import {captureGoalChromeBoundary,retireGoalOwnedTab,
  validateChromeWitness,inspectStoredChromeWitnesses} from '../src/core/goal-release-chrome-probes.js';

const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const SOURCE=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const url=(n:number)=>`https://chatgpt.com/c/123e4567-e89b-42d3-a456-${String(n).padStart(12,'0')}`;
const prompt=(n:number)=>`Synthetic prompt ${n}`;
const answer=(n:number)=>`Synthetic reply ${n}\n[MISSION_RELAY:NEXT]`;
const target=(n:number)=>`FAKE-CHROME-TARGET-${String(n).padStart(8,'0')}`;
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'relay-chrome-ten-'));
  const store=new Store(join(dir,'state.sqlite')),ledger=new GoalLedger(store);
  const goal=ledger.createGoal({requestKey:'synthetic-goal',
    objective:'Isolated browser witness',priority:90});
  const plan=ledger.createPlan(goal.id,goal.version,{requestKey:'synthetic-plan',
    summary:'Validate original Chrome witness',items:[{key:'test',title:'Witness',
      priority:90,acceptance:['No forged observations']}]});
  ledger.setPlanStatus(goal.id,plan.id,plan.version,'APPROVED','approve');
  ledger.setGoalStatus(goal.id,ledger.getGoal(goal.id).version,'ACTIVE','activate');
  const m=store.create({goal:goal.objective,acceptance:['synthetic'],
    workspace:'',sandbox:'read-only',mode:'supervised',maxTurns:0,
    requestKey:'synthetic-mission',checks:[]});
  const linked=store.linkChat(m.id,url(1),m.version).mission;
  const bound=store.bindChatBrowser(m.id,'synthetic-browser',linked.version).mission;
  store.setMeta(`pi.autopilot.enabled.${bound.id}`,'1');
  ledger.bindPiMission(goal.id,bound.id,bound.version,'bind');
  const observe=(n:number,newChat=false,review=true)=>{
    const key=`synthetic-${n}`;
    store.reserveChatBrowserTurn(bound.id,store.get(bound.id).version,key,sha(prompt(n)),
      newChat?{newConversation:true}:{});
    store.finishChatBrowserTurn(bound.id,key,{kind:'observed',
      assistantSha256:sha(answer(n)),summary:answer(n),
      ...(newChat?{newChatUrl:url(n+1),newChatTargetSha256:sha(target(n))}:{})});
    if(review)store.commitPiPlan(bound.id,sha(answer(n)),[],{
      action:'NEXT',summary:'Continue',nextPrompt:'Another synthetic task'});
  };
  const firstTen=()=>{for(let n=1;n<=10;n++)observe(n,n===1);};
  return {dir,store,goalId:goal.id,missionId:bound.id,observe,firstTen,
    close:()=>{store.close();rmSync(dir,{recursive:true,force:true});}};
}
type Fake=Page&{_test:{setPrompt:(s:string)=>void;setAnswer:(s:string)=>void;closed:()=>boolean}};
function physicalPages(){
  const pages:Fake[]=[];
  const make=(id:string,tabUrl:string,user:string,assistant:string):Fake=>{
    let isClosed=false,promptText=user,replyText=assistant;
    const empty={count:async()=>0};
    const composer={count:async()=>1,isVisible:async()=>true};
    const field=(kind:'user'|'assistant')=>{
      const obj={count:async()=>1,last:()=>obj,first:()=>obj,
        innerText:async()=>kind==='user'?promptText:replyText,
        getAttribute:async()=>`synthetic-${kind}`};
      return obj;
    };
    const page={
      get _targetId(){return id;},url:()=>tabUrl,isClosed:()=>isClosed,
      context:()=>({pages:()=>[...pages]}),
      close:async()=>{isClosed=true;},
      locator:(selector:string)=>selector.includes('data-message-author-role="user"')
        ?field('user'):selector.includes('data-message-author-role="assistant"')
        ?field('assistant'):selector.includes('prompt-textarea')?composer:empty,
      getByRole:()=>empty,
      _test:{setPrompt:(s:string)=>{promptText=s;},
        setAnswer:(s:string)=>{replyText=s;},closed:()=>isClosed},
    } as unknown as Fake;
    pages.push(page);return page;
  };
  return {make,pages};
}
async function witness(f:ReturnType<typeof fixture>,pages=physicalPages()){
  const source=pages.make(target(1),url(2),prompt(10),answer(10));
  const destination=pages.make(target(11),url(12),prompt(11),answer(11));
  const digest=await captureGoalChromeBoundary({store:f.store,goalId:f.goalId,
    missionId:f.missionId,sourcePage:source,destinationPage:destination,
    sourceUrl:url(2),destinationUrl:url(12),sourceSha:SOURCE,privateRoot:f.dir});
  const file=join(f.dir,'chrome-custody',f.goalId,`ten-to-eleven-${digest}.json`);
  return {source,destination,digest,file,
    content:JSON.parse(readFileSync(file,'utf8')) as Parameters<typeof validateChromeWitness>[3]};
}

test('ten Sends share one conversation; the eleventh requires a new URL and PI review',async()=>{
  const f=fixture();try{
    f.firstTen();
    assert.equal(inspectPiEvidence(f.store,f.missionId).maxObservedTurnsInOneChat,10);
    assert.throws(()=>f.store.reserveChatBrowserTurn(f.missionId,f.store.get(f.missionId).version,
      'illegal-11',sha('illegal')),/10 observed|new conversation/);
    f.observe(11,true,false);
    const p=await witness(f);
    assert.throws(()=>validateChromeWitness(f.store,f.goalId,SOURCE,p.content),/unreviewed/);
    f.store.commitPiPlan(f.missionId,sha(answer(11)),[],{
      action:'NEXT',summary:'Observed eleventh',nextPrompt:'Continue'});
    assert.doesNotThrow(()=>validateChromeWitness(f.store,f.goalId,SOURCE,p.content));
    const receipt=inspectStoredChromeWitnesses(f.store,f.goalId,f.dir,'chrome-10-to-11',SOURCE);
    assert.equal(receipt.state,'PASS');
    assert.equal(f.store.get(f.missionId).turnCount,11);
    assert.equal(inspectPiEvidence(f.store,f.missionId).chatSegments,2);
  }finally{f.close();}
});

test('physical evidence is content-addressed, cannot be forged or substituted by a model claim',async()=>{
  const f=fixture();try{
    f.firstTen();f.observe(11,true,false);
    const pages=physicalPages(),p=await witness(f,pages);
    p.source._test.setAnswer('Tampered assistant text');
    assert.throws(()=>validateChromeWitness(f.store,f.goalId,SOURCE,{
      ...p.content,source:{...p.content.source,assistantTurnSha256:sha('tampered')}}));
    f.store.commitPiPlan(f.missionId,sha(answer(11)),[],{
      action:'NEXT',summary:'PI reviewed',nextPrompt:'Continue'});
    // Original captured content remains immutable even if live tab prose
    // changes later. This test must not mutate the owner/retirement journal.
    assert.equal(f.store.events(f.missionId).filter(e=>
      e.type==='chatgpt.browser_tab_retired').length,0);
    const original=readFileSync(p.file,'utf8');
    writeFileSync(p.file,original.replace(SOURCE,'f'.repeat(40)));
    assert.throws(()=>inspectStoredChromeWitnesses(f.store,f.goalId,f.dir,
      'chrome-10-to-11',SOURCE),/digest mismatch/);
    assert.equal(f.store.get(f.missionId).turnCount,11);
  }finally{f.close();}
});

test('physical tab retirement preserves owner tabs and requires its own independent witness',async()=>{
  const f=fixture();try{
    f.firstTen();f.observe(11,true,false);
    const pages=physicalPages(),p=await witness(f,pages);
    const owner=pages.make('OWNER-PRESERVE','https://example.org','owner','owner');
    assert.equal(await retireGoalOwnedTab({store:f.store,goalId:f.goalId,
      missionId:f.missionId,sourcePage:p.source,destinationPage:p.destination,
      sourceUrl:url(2),destinationUrl:url(12),sourceSha:SOURCE,privateRoot:f.dir}),true);
    f.store.commitPiPlan(f.missionId,sha(answer(11)),[],{
      action:'NEXT',summary:'PI reviewed',nextPrompt:'Continue'});
    assert.equal(p.source._test.closed(),true);
    assert.equal(p.destination._test.closed(),false);
    assert.equal(owner._test.closed(),false);
    const receipt=inspectStoredChromeWitnesses(f.store,f.goalId,f.dir,
      'relay-tab-retirement',SOURCE);
    assert.equal(receipt.state,'PASS');
    assert.match(receipt.proofSha256,/^[a-f0-9]{64}$/);
    const stored=join(f.dir,'chrome-custody',f.goalId,`inspection-${receipt.proofSha256}.json`);
    assert.equal(existsSync(stored),true);
  }finally{f.close();}
});

test('an unreviewed or unsettled eleventh request never grants a Chrome ReleaseProbe PASS',async()=>{
  const f=fixture();try{
    f.firstTen();
    f.store.reserveChatBrowserTurn(f.missionId,f.store.get(f.missionId).version,
      'pending-new-chat',sha('new prompt'),{newConversation:true});
    assert.throws(()=>inspectStoredChromeWitnesses(f.store,f.goalId,f.dir,
      'chrome-10-to-11',SOURCE),/settled|unreviewed/);
    assert.equal(f.store.get(f.missionId).turnCount,10);
  }finally{f.close();}
});
