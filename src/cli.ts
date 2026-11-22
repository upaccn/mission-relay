#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {readFileSync} from 'node:fs';
import {withReadOnlyDeadline} from './core/read-only-deadline.js';
import {Store} from './core/store.js';
import {GoalLedger} from './core/goal-store.js';
import {inspectSoftwareReleaseCandidate} from './core/software-release.js';
import {enrolledTaskStatus} from './core/windows-task.js';
import {githubRepositoryForRuntime} from './core/github-ci.js';
import {inspectPiEvidence} from './core/pi-evidence.js';
import {inspectGoalRequestLedger} from './core/request-ledger.js';
import {inspectBrowserBinding} from './core/browser-binding-diagnostic.js';
import {TelegramBridge,TelegramHttpTransport} from './plugins/telegram.js';
import {stateHome} from './core/paths.js';
import {verifiedRuntimeProvenance} from './core/runtime-provenance.js';
import {normalizeChatGPTUrl} from './core/chatgpt-handoff.js';
import {setTelegramChatAnchor} from './core/chat-anchor.js';
import {connectChatPage,inspectChatPage,matchesSubmittedUserPrompt,matchesReservedPromptHash,
  lastVisibleUserPromptSha256,listConnectedChatCandidates,withBrowserSession} from './plugins/chatgpt-browser.js';
import {MAX_RELAY_CHAT_TURNS} from './core/chat-limits.js';
import {browserDecision,reservedRequestPrompt} from './core/browser-controller.js';
import {validatePictlRemoteConfig,validateRemoteProjectPath} from './core/pi-planner.js';
import {approveBuildRepository,revokeBuildRepository,approvedBuildRepositories} from './core/build-scopes.js';
import {listBrowsers} from 'playwriter';

const packageVersion=(JSON.parse(readFileSync(
  new URL('../package.json',import.meta.url),'utf8')) as {version:string}).version;
const BOOLEAN_FLAGS=new Set(['--accept-reply','--retry','--abandon']);

function flags(argv:string[]):Record<string,string[]> {
  const out:Record<string,string[]>={};
  for(let i=0;i<argv.length;i++){
    const key=argv[i];
    if(!key?.startsWith('--'))throw new Error(`Unexpected argument: ${key}`);
    if(BOOLEAN_FLAGS.has(key)){out[key]=['true'];continue;}
    const value=argv[i+1];
    if(!value||value.startsWith('--'))throw new Error(`Missing value for ${key}`);
    (out[key]??=[]).push(value);
    i++;
  }
  return out;
}
function option(f:Record<string,string[]>,name:string,defaultValue?:string):string {
  const values=f['--'+name];
  if(!values?.length){
    if(defaultValue!==undefined)return defaultValue;
    throw new Error(`Missing --${name}`);
  }
  if(values.length!==1)throw new Error(`Duplicate --${name}`);
  return values[0]!;
}
const uuid=(id:string|undefined,what:string)=>{
  if(!id||!/^[0-9a-f-]{36}$/i.test(id))throw new Error(`Provide one ${what} UUID`);
  return id;
};
function help():void {
  console.log(`Mission Relay v${packageVersion}

Run
  telegram                         Run the single Worker (owner-allowlisted Telegram)

Setup (local, once)
  browser-list                     Connected Playwriter Chrome profiles
  telegram-anchor --url <ChatGPT chat> --browser-id <id> | --clear
                                   Chrome profile in which new Goal Chats are opened
  telegram-pi-config --ssh-host <alias> --project <path> | --clear
                                   Tool-free PI route (SSH -> pictl infer)
  telegram-build-project --allow <path> | --revoke <path> | --list
                                   Repositories a /goal-build may change
  telegram-identify                Show /start sender IDs before enrolment

Inspect (read-only)
  list | show <mission> | events <mission>
  channel-status                   Worker, Telegram delivery and drain state
  pi-health                        Requests in flight and PI reviews pending
  pi-evidence <mission>            Request/PI SHA correlation audit
  goal-request-ledger <goal>       Goal -> Mission -> Chat -> request audit
  browser-binding-health <mission> Exact pinned tab check (no Send)

Recover a stuck task (always inspect first)
  recover <mission>                Diagnose; prints the one safe next action
  recover <mission> --accept-reply --revision <n> [--new-url <chat>]
                                   Credit a complete reply ChatGPT already shows (read twice)
  recover <mission> --retry --revision <n>
                                   Clear an error at a settled step after two matching reads
  recover <mission> --abandon --revision <n>
                                   Give up an unverifiable request: no credit, no resend;
                                   the Goal becomes blocked for /goal-continue

Maintenance and release
  channel-drain-request | channel-drain-status | channel-drain-release --id <id>
  channel-drain-release-verified --id <id> --expected-sha <sha> --expected-pid <pid> --expected-attested-at <iso>
  software-release-status --sha <main SHA> --run-id <Actions run>

A Goal Chat carries at most ${MAX_RELAY_CHAT_TURNS} Relay Sends, then continues in a fresh Chat.

Environment: MISSION_RELAY_HOME, MISSION_RELAY_TELEGRAM_BOT_TOKEN,
MISSION_RELAY_TELEGRAM_USER_ID, MISSION_RELAY_TELEGRAM_CHAT_ID.`);
}

type Store_=Store;
/** Read the pinned tab twice; both reads must be idle, complete and equal. */
async function stableRead(store:Store_,id:string,url:string,browserId:string,
  check:(answer:string,userSha:string|null)=>void):Promise<{answer:string;userSha:string|null}>{
  const session=await withReadOnlyDeadline(connectChatPage(url,{browserId}),30_000,late=>late.close());
  return withBrowserSession(session,async page=>{
    const read=async()=>{
      const snap=await withReadOnlyDeadline(inspectChatPage(page,url));
      const userSha=await withReadOnlyDeadline(lastVisibleUserPromptSha256(page));
      if(snap.generating||!snap.composerReady||!snap.lastAssistant.trim()||
        !['DONE','NEXT','BLOCKED','HANDOFF'].includes(browserDecision(snap.lastAssistant)))
        throw new Error('ChatGPT does not show an idle, complete, marked reply');
      check(snap.lastAssistant,userSha);
      return {answer:snap.lastAssistant,userSha};
    };
    const first=await read();
    await new Promise(r=>setTimeout(r,3000));
    const second=await read();
    if(first.answer!==second.answer||first.userSha!==second.userSha)
      throw new Error('ChatGPT reply changed between the two reads');
    void store;void id;
    return second;
  });
}

function diagnose(store:Store_,id:string){
  const m=store.get(id),receipt=store.chatBrowserTurn(id),plan=store.piPlan(id);
  const pending=receipt&&['reserved','uncertain'].includes(receipt.status);
  const deadOwner=store.isAbandonedBrowserReservation(id)||store.isAbandonedBrowserRolloverReservation(id);
  const action=m.stopRequested?'Owner pause: resume from Telegram with /resume':
    pending&&(receipt.status==='uncertain'||deadOwner)?
      (receipt.newConversation
        ?'Request outcome unknown in a new Chat: if ChatGPT shows its reply, recover --accept-reply --new-url <chat>; otherwise recover --abandon'
        :'Request outcome unknown: if the pinned Chat shows the complete reply, recover --accept-reply; otherwise recover --abandon'):
    pending?'A Send is in progress under a live Worker: wait':
    m.state==='PAUSED'&&m.lastError?'Stopped by an error at a settled step: fix the cause, then recover --retry':
    m.state==='READY'?'Queued for the Worker: nothing to do':
    ['DONE','BLOCKED'].includes(plan?.action??'')?`PI decided ${plan!.action}; nothing to recover`:
    'No recovery needed';
  return {missionId:id,revision:m.version,state:m.state,round:m.turnCount,
    stopRequested:m.stopRequested,lastError:m.lastError,
    request:receipt?{status:receipt.status,newConversation:receipt.newConversation===true,deadOwner}:null,
    piDecision:plan?{round:plan.round,action:plan.action}:null,
    goalId:new GoalLedger(store).missionGoalId(id),nextAction:action};
}

export async function main(argv=process.argv.slice(2)):Promise<void> {
  const [command,id,...rest]=argv;
  if(!command||['help','--help','-h'].includes(command))return help();
  if(command==='software-release-status'){
    const f=flags(argv.slice(1));
    if(Object.keys(f).length!==2||!f['--sha']||!f['--run-id'])
      throw new Error('Usage: software-release-status --sha <SHA> --run-id <Actions ID>');
    console.log(JSON.stringify(await inspectSoftwareReleaseCandidate(githubRepositoryForRuntime(),
      option(f,'sha'),option(f,'run-id')),null,2));
    return;
  }
  const home=stateHome();
  const readOnly=['channel-status','channel-drain-status','pi-health','pi-evidence',
    'browser-binding-health','goal-request-ledger','list','show','events'].includes(command)||
    (command==='recover'&&rest.length===0);
  const store=new Store(join(home,'missions.sqlite'),{readOnly});
  try{
    let result:unknown;
    if(command==='list')result=store.list();
    else if(command==='show')result=store.get(uuid(id,'Mission'));
    else if(command==='events')result=store.events(uuid(id,'Mission'));
    else if (command === 'telegram-anchor' && id === '--clear') {
      store.setMeta('telegram.chatgpt.anchorUrl','');
      store.setMeta('telegram.chatgpt.browserId','');
      result={configured:false,note:'The Telegram fresh-chat launcher has been locally revoked.'};
    } else if (command === 'telegram-anchor') {
      const f=flags(argv.slice(1));
      const url=normalizeChatGPTUrl(option(f,'url'));
      const browserId=option(f,'browser-id');
      const session=await connectChatPage(url,{browserId});
      const snapshot=await withBrowserSession(session,page=>inspectChatPage(page,url));
      if(!snapshot.composerReady||snapshot.generating)
        throw new Error('Anchor ChatGPT tab must be idle with a visible composer');
      setTelegramChatAnchor(store,url,browserId);
      result={configured:true,note:'Approved browser launch profile saved. New tasks create separate fresh Chats; the source tab is never sent a message.'};
    } else if (command === 'telegram-pi-config' && id === '--clear') {
      store.setMeta('telegram.pi.sshHost','');
      store.setMeta('telegram.pi.project','');
      result={configured:false,note:'PI coordinator SSH route revoked locally; no other execution routes changed.'};
    } else if (command === 'telegram-pi-config') {
      const f=flags(argv.slice(1));
      const config=validatePictlRemoteConfig({
        sshHost:option(f,'ssh-host'),project:option(f,'project'),
      });
      store.setMeta('telegram.pi.sshHost',config.sshHost);
      store.setMeta('telegram.pi.project',config.project);
      result={configured:true,route:config,
        note:'PI uses a fixed SSH → sudo pictl infer --stdin --json command with no tools. No credentials stored here; requires pre-authorized SSH and remote pictl.'};
    } else if (command === 'telegram-build-project' && id === '--allow') {
      if(rest.length!==1||!store.getMeta('telegram.pi.sshHost'))
        throw new Error('A configured PI route and exactly one --allow path are required');
      result={approved:approveBuildRepository(store,option(flags(argv.slice(1)),'allow')),
        repositories:approvedBuildRepositories(store)};
    } else if (command === 'telegram-build-project' && id === '--revoke') {
      if(rest.length!==1)throw new Error('Supply exactly one --revoke path');
      const project=validateRemoteProjectPath(option(flags(argv.slice(1)),'revoke'));
      revokeBuildRepository(store,project);
      result={revoked:project,repositories:approvedBuildRepositories(store),
        note:'Future Sends into this repository are refused; existing requests and receipts were not altered.'};
    } else if (command === 'telegram-build-project' && id === '--list') {
      if(rest.length!==0)throw new Error('No arguments allowed with --list');
      result={repositories:approvedBuildRepositories(store)};
    } else if (command === 'telegram-identify') {
      const token=process.env.MISSION_RELAY_TELEGRAM_BOT_TOKEN;
      if(!token) throw new Error('Set MISSION_RELAY_TELEGRAM_BOT_TOKEN privately in the local process environment');
      const updates=await new TelegramHttpTransport(token).getUpdates(0,4);
      result=updates.filter(x=>x.message?.text?.trim()==='/start' && x.message.chat.type==='private')
        .map(x=>({userId:x.message?.from?.id,chatId:x.message?.chat.id}));
    } else if (command === 'telegram') {
      const token=process.env.MISSION_RELAY_TELEGRAM_BOT_TOKEN;
      if(!token) throw new Error('MISSION_RELAY_TELEGRAM_BOT_TOKEN is required');
      const owner=Number(process.env.MISSION_RELAY_TELEGRAM_USER_ID);
      const chat=Number(process.env.MISSION_RELAY_TELEGRAM_CHAT_ID);
      const runtimeProof=verifiedRuntimeProvenance();
      const bridge=new TelegramBridge(store,new TelegramHttpTransport(token),owner,chat,
        undefined,undefined,undefined,runtimeProof);
      const controller=new AbortController();
      const shutdown=()=>controller.abort();
      process.once('SIGINT',shutdown);
      process.once('SIGTERM',shutdown);
      console.log('Telegram channel running with an explicit owner allowlist. Ctrl+C stops polling.');
      try{await bridge.run(controller.signal);}finally{
        process.removeListener('SIGINT',shutdown);process.removeListener('SIGTERM',shutdown);
      }
      return;
    } else if (command === 'channel-drain-request') {
      result={drainId:store.requestChannelDrain('telegram'),requested:true};
    } else if (command === 'channel-drain-status') {
      result={drainId:store.channelDrainId('telegram'),
        requested:store.channelDrainRequested('telegram'),
        pollerPresent:store.channelStatus('telegram').pollerPresent};
    } else if (command === 'channel-drain-release') {
      const drainId=option(flags(argv.slice(1)),'id');
      store.releaseChannelDrain('telegram',drainId);
      result={released:true};
    } else if (command === 'channel-drain-release-verified') {
      const arguments_=flags(argv.slice(1));
      const drainId=option(arguments_,'id');
      const expectedSha=option(arguments_,'expected-sha');
      const pidText=option(arguments_,'expected-pid');
      const expectedAttestedAt=option(arguments_,'expected-attested-at');
      if(!/^[1-9]\d*$/.test(pidText))
        throw new Error('Expected positive verified Worker PID');
      const leaseFingerprint=store.channelLeaseFingerprint('telegram');
      store.releaseVerifiedChannelDrain('telegram',drainId,expectedSha,Number(pidText),{
        leaseFingerprint:leaseFingerprint??'',
        expectedAttestedAt,
        // A separate Windows CIM readback is performed *inside* the atomic
        // SQLite drain release, not trusted from an earlier model/CLI claim.
        inspectProcess:()=>{
          if(process.platform!=='win32'||!process.argv[1])
            throw new Error('Windows enrolled Worker identity unavailable');
          const task=enrolledTaskStatus(process.argv[1]);
          return {taskVerified:task.taskVerified,taskState:task.taskState,
            pollerPid:task.pollerPid,
            workerProcessVerified:task.workerProcessVerified===true,
            workerProcessStartedAt:task.workerProcessStartedAt??null,
            workerParentStartedAt:task.workerParentStartedAt??null};
        },
      });
      result={released:true,verified:true,sourceSha:expectedSha};
    } else if (command === 'channel-status') {
      result=store.channelStatus('telegram');
    } else if (command === 'pi-health') {
      if(id||rest.length)throw new Error('pi-health takes no arguments');
      result=store.piHealth();
    } else if (command === 'pi-evidence') {
      if(!id||!/^[0-9a-f-]{36}$/i.test(id)||rest.length)
        throw new Error('Provide exactly one PI Mission UUID');
      result=inspectPiEvidence(store,id);
    } else if (command === 'goal-request-ledger') {
      if(!id||!/^[0-9a-f-]{36}$/i.test(id)||rest.length)
        throw new Error('Provide exactly one Goal UUID');
      result=inspectGoalRequestLedger(store,id);
    } else if (command === 'browser-binding-health' && id) {
      if(!/^[0-9a-f-]{36}$/i.test(id)||rest.length)
        throw new Error('Provide exactly one bound Mission UUID');
      const linkedUrl=store.chatLink(id),browserId=store.chatBrowserBinding(id);
      if(!linkedUrl||!browserId)
        throw new Error('Mission has no existing linked ChatGPT URL and approved Chrome binding');
      // Never bootstrap a tab, open the linked conversation, change SQLite,
      // click Send/Retry or interpret candidate assistant response text.
      const candidates=await listConnectedChatCandidates(browserId,linkedUrl);
      const mission=store.get(id);
      result=inspectBrowserBinding({
        missionId:id,missionState:mission.state,turnCount:mission.turnCount,
        linkedUrl,receipt:store.chatBrowserTurn(id),
        enabledChatCandidates:candidates,
      });
    } else if (command === 'browser-list') {
      const browsers=await listBrowsers();
      result=browsers.map(b=>({id:b.id,browser:b.browser,activeTabs:b.activeTabs,playwriterVersion:b.playwriterVersion}));
    } else if (command==='recover'){
      const id=uuid(argv[1],'Mission');
      const f=flags(rest);
      const modes=['--accept-reply','--retry','--abandon'].filter(k=>f[k]);
      if(modes.length===0){
        if(Object.keys(f).length)throw new Error('Diagnosis takes no options');
        result=diagnose(store,id!);
      }else if(modes.length>1)throw new Error('Choose exactly one of --accept-reply, --retry, --abandon');
      else if(modes[0]==='--abandon'){
        result={...diagnose(store,store.abandonUncertainRequest(id!,Number(option(f,'revision'))).id),
          note:'No answer credited and nothing resent. Continue the Goal from Telegram with /goal-continue.'};
      }else if(modes[0]==='--retry'){
        const revision=Number(option(f,'revision'));
        const m=store.get(id!),receipt=store.chatBrowserTurn(id!);
        const url=store.chatLink(id!),browserId=store.chatBrowserBinding(id!);
        if(m.version!==revision||!receipt||!['observed','reconciled'].includes(receipt.status)||
          !url||!browserId||!m.lastError)
          throw new Error('Retry needs a Mission stopped by an error at a settled step (see recover <mission>)');
        const read=await stableRead(store,id!,url,browserId,(answer,userSha)=>{
          if(userSha!==receipt.promptSha256||
            createHash('sha256').update(answer).digest('hex')!==receipt.assistantSha256)
            throw new Error('Live Chat does not match the settled request and reply');
        });
        const cleared=store.clearSettledPiInterruption(id!,revision,{
          requestPromptSha256:read.userSha!,
          assistantSha256:createHash('sha256').update(read.answer).digest('hex')});
        result={...diagnose(store,cleared.id),note:'Error cleared; the Worker re-reads the Chat before any next step.'};
      }else if(f['--new-url']){
        const revision=Number(option(f,'revision'));
        const newUrl=normalizeChatGPTUrl(option(f,'new-url'));
        const m=store.get(id),oldUrl=store.chatLink(id),record=store.chatBrowserTurn(id);
        const bound=store.chatBrowserBinding(id);
        const uncertain=m.state==='NEEDS_RECONCILIATION'&&record?.status==='uncertain';
        const abandoned=store.isAbandonedBrowserRolloverReservation(id);
        if(!oldUrl||!bound||!record||m.version!==revision||(!uncertain&&!abandoned)||
          newUrl===oldUrl)
          throw new Error('No eligible uncertain or dead-owner reserved new-chat rollover at this Mission revision; a live owner must settle its original Send');
        const oldSession=await withReadOnlyDeadline(connectChatPage(oldUrl,{browserId:bound}),
          30_000,late=>late.close());
        const prompt=await withBrowserSession(oldSession,async page=>{
          const source=await withReadOnlyDeadline(inspectChatPage(page,oldUrl));
          if(source.generating||!source.composerReady)
            throw new Error('Original ChatGPT source tab is not idle');
          // Inspection only: the reserved prompt is never sent again.
          return reservedRequestPrompt(store,id,record.requestKey);
        });
        const promptSha256=createHash('sha256').update(prompt.trim()).digest('hex');
        if(promptSha256!==record.promptSha256)
          throw new Error('Reconstructed handoff prompt hash differs from the durable reserved request');
        const newSession=await withReadOnlyDeadline(connectChatPage(newUrl,{browserId:bound}),
          30_000,late=>late.close());
        const answer=await withBrowserSession(newSession,async page=>{
          const first=await withReadOnlyDeadline(inspectChatPage(page,newUrl));
          if(first.generating||!['DONE','NEXT','BLOCKED','HANDOFF'].includes(browserDecision(first.lastAssistant))||
            !matchesSubmittedUserPrompt(await withReadOnlyDeadline(lastVisibleUserPromptSha256(page)),prompt))
            throw new Error('New conversation is not a complete reply to the exact reserved prompt');
          await new Promise(resolve=>setTimeout(resolve,2600));
          const second=await withReadOnlyDeadline(inspectChatPage(page,newUrl));
          if(second.generating||second.lastAssistant!==first.lastAssistant||
            !matchesSubmittedUserPrompt(await withReadOnlyDeadline(lastVisibleUserPromptSha256(page)),prompt))
            throw new Error('New ChatGPT reply was not stable or its submitted prompt changed');
          return second.lastAssistant;
        });
        const assistantSha256=createHash('sha256').update(answer).digest('hex');
        const recovered=store.recoverObservedBrowserRollover(id,revision,{
          requestPromptSha256:promptSha256,newChatUrl:newUrl,assistantSha256,summary:answer,
        });
        result={...recovered,assistantSha256,verifiedNewUrl:newUrl,
          note:abandoned?
            'Recovered a dead-owner reserved new-chat response after independent old/new page readback; no second Send and no invented uncertainty event. PI review remains required.':
            'Reconciled after independent old/new page readback; prior request was not replayed.'};
      }else{
        const revision=Number(option(f,'revision'));
        const m=store.get(id),url=store.chatLink(id),record=store.chatBrowserTurn(id);
        const bound=store.chatBrowserBinding(id);
        const uncertain=m.state==='NEEDS_RECONCILIATION'&&record?.status==='uncertain';
        const abandoned=store.isAbandonedBrowserReservation(id);
        if(!url||!bound||!record||m.version!==revision||(!uncertain&&!abandoned)||
          record.newConversation===true)
          throw new Error('No eligible uncertain or dead-owner reserved existing-chat turn; a live owner must finish its own Send');
        // PI-authored continuations cannot be reconstructed from the mission goal.
        // The original exact submitted prompt hash is already durable in SQLite.
        // Compare it with the latest visible user turn; never accept a quote of
        // an earlier prompt or replay the uncertain Send.
        const session=await withReadOnlyDeadline(connectChatPage(url,{browserId:bound}),
          30_000,late=>late.close());
        const answer=await withBrowserSession(session,async page=>{
          const first=await withReadOnlyDeadline(inspectChatPage(page,url));
          if(first.generating||!first.composerReady||!first.lastAssistant.trim()||
            !['DONE','NEXT','BLOCKED','HANDOFF'].includes(browserDecision(first.lastAssistant))||
            !matchesReservedPromptHash(await withReadOnlyDeadline(lastVisibleUserPromptSha256(page)),record.promptSha256))
            throw new Error('Original chat does not show the exact reserved user request and a complete marked assistant reply');
          await new Promise(resolve=>setTimeout(resolve,3000));
          const second=await withReadOnlyDeadline(inspectChatPage(page,url));
          if(second.generating||!second.composerReady||second.lastAssistant!==first.lastAssistant||
            !matchesReservedPromptHash(await withReadOnlyDeadline(lastVisibleUserPromptSha256(page)),record.promptSha256))
            throw new Error('Original ChatGPT reply was unstable or no longer corresponds to the reserved request');
          return second.lastAssistant;
        });
        const assistantSha256=createHash('sha256').update(answer).digest('hex');
        const recovered=store.recoverObservedBrowserTurn(id,revision,{
          requestPromptSha256:record.promptSha256,assistantSha256,summary:answer,
        });
        result={...recovered,assistantSha256,verifiedDecision:browserDecision(answer),
          note:abandoned?
            'Recovered a dead-owner original reservation after independent read-only browser verification. No second Send; old reservation preserved; PI still must review this answer.':
            'Recovered the observed original-chat reply with no new Send. Historical uncertain event preserved; model DONE is not independent verification.'};
      }
    }
    else throw new Error('Unknown command or missing argument; run help');
    console.log(JSON.stringify(result,null,2));
  }finally{store.close();}
}

main().catch(error=>{console.error(`mission-relay: ${error instanceof Error?error.message:String(error)}`);process.exitCode=1;});
