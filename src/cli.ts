#!/usr/bin/env node
import { randomUUID, createHash } from 'node:crypto';
import {MAX_RELAY_CHAT_TURNS} from './core/chat-limits.js';
import {withReadOnlyDeadline} from './core/read-only-deadline.js';
import { join, resolve } from 'node:path';
import { statSync, readFileSync } from 'node:fs';
import { Engine } from './core/engine.js';
import { Store } from './core/store.js';
import {inspectPiEvidence,inspectPiChainEvidence} from './core/pi-evidence.js';
import {LazyExecutor,registerExecutorPlugin,registeredExecutorPlugins,defaultExecutorId,
  setDefaultExecutor,removeExecutorPlugin,executorPreflight} from './core/executor-plugins.js';
import { TelegramBridge, TelegramHttpTransport } from './plugins/telegram.js';
import { stateHome } from './core/paths.js';
import { renderChatGPTHandoff, normalizeChatGPTUrl } from './core/chatgpt-handoff.js';
import { connectChatPage, inspectChatPage, matchesSubmittedUserPrompt, matchesReservedPromptHash, lastVisibleUserPrompt, lastVisibleUserPromptSha256, listConnectedChatCandidates, withBrowserSession } from './plugins/chatgpt-browser.js';
import { executeBrowserTurn, driveChatConversation, browserDecision, browserRolloverRecoveryPrompt, browserRolloverPiPlan, browserNewChatPrompt, browserContinuationPrompt } from './core/browser-controller.js';
import {AiosPiPlanner,validatePictlRemoteConfig,validateRemoteProjectPath} from './core/pi-planner.js';
import {adoptConnectedConversation} from './core/chat-adoption.js';
import {watchedBrowser,enableBrowserWatch,disableBrowserWatch} from './core/browser-watch.js';
import { listBrowsers } from 'playwriter';
import type { CreateMission, Sandbox } from './core/types.js';
import type { VerificationCheck } from './core/types.js';

function flags(argv: string[]): Record<string,string[]> {
  const out: Record<string,string[]> = {};
  for (let i=0;i<argv.length;i++) {
    const key = argv[i];
    if (!key?.startsWith('--')) throw new Error(`Unexpected argument: ${key}`);
    const value = argv[i+1];
    if (!value || value.startsWith('--')) {
      if (key === '--acknowledge-side-effects') { out[key] = ['true']; continue; }
      throw new Error(`Missing value for ${key}`);
    }
    (out[key] ??= []).push(value);
    i++;
  }
  return out;
}
function option(f:Record<string,string[]>,name:string,defaultValue?:string):string {
  const values = f['--'+name];
  if (!values?.length) {
    if (defaultValue !== undefined) return defaultValue;
    throw new Error(`Missing --${name}`);
  }
  if (values.length !== 1) throw new Error(`Duplicate --${name}`);
  return values[0]!;
}
function help():void {
  console.log(`Mission Relay v0.2 alpha
Commands:
  doctor                Check installed optional executor, if any
  plugin-register --path <absolute .mjs/.js>  Register a trusted native executor plugin
  plugin-list           List installed native executor (none required for ChatGPT)
  plugin-default --id <executor.id>  Optional override when several plugins exist
  plugin-remove --id <executor.id>   Remove one registration (no user files deleted)
  telegram              Run an optional Telegram channel in the foreground (owner allowlist)
  channel-drain-request  Request a local SQLite-fenced, idle-only Telegram maintenance drain
  channel-drain-status   Inspect the local maintenance receipt for failed-launch recovery
  channel-drain-release --id <drain-id>  Release only the matching maintenance fence
  telegram-anchor <mission-id>|--clear  Locally approve/revoke the exact pinned new-chat source tab
  telegram-agent-workspace --workspace <dir>|--clear  Optional native executor workspace approval
  telegram-pi-config --ssh-host <alias> --project <remote-absolute-path> | --clear
                      Configure tool-free PI inference through the existing SSH connection
  telegram-build-project --project <remote-absolute-path> | --clear
                      Operator approval of one repository for /build (must equal configured PI project)
  telegram-identify     Inspect local /start sender IDs before owner authorization
  channel-status        Inspect durable Telegram delivery cursor and poller status (no secrets)
  pi-health             Inspect active PI/browser requests, observed turns and wait age (no content, no Send)
  pi-evidence <mission-id>  Audit real event/PI SHA correlation and 5-send chat segmentation (no content, no Send)
  pi-chain-evidence <mission-id>  Verify durable 32-turn successor lineage and inherited scope (no Send)
  create --goal <text> --accept <criterion> [--accept <criterion>...] --workspace <path>
         [--sandbox read-only|workspace-write] [--mode supervised|autopilot]
         [--max-turns 10] [--request-key <stable key>] [--checks-file <path>]
  run <id>              Execute one supervised turn or a bounded autopilot
  show <id>             Read authoritative mission state
  list                  List complete Mission ledger (including archives)
  archive-settled       Locally archive only settled history; preserve all audit records
  events <id>           Read append-only mission events
  link-chat <id> --url <ChatGPT conversation URL> --revision <version>
  chat-create --goal <text> --accept <criterion> --url <ChatGPT conversation URL>
             [--accept <criterion>...] [--request-key <stable key>]
  chat-adopt --url <exact ChatGPT conversation URL> --browser-id <approved Chrome ID>
             [--goal <text>] [--start true]
             Register a stable existing human chat; optional PI continuation in SAME tab
  chat-adopt-start <mission-id>    Start PI on an already-adopted idle human conversation
  handoff <id>          Show existing ChatGPT chat link and manual continuation prompt
  browser-list          List connected Playwriter browser IDs (no profile emails)
  browser-candidates --browser-id <approved Chrome ID>   Read-only connected ChatGPT URL inventory
  browser-watch --browser-id <approved Chrome ID>  Opt in to new Playwriter-connected ChatGPT chats
  browser-watch --clear  Stop discovery and prevent watched Missions from further turns
  browser-watch-status   Show the pinned profile and whether discovery is enabled
  browser-bind <id> --browser-id <id> --revision <n>   Pin a mission to one Chrome profile
  browser-probe <id> [--browser-id <id>]   Read a Playwriter-enabled ChatGPT tab
  browser-send <id> --revision <n> --request-key <key> --prompt-file <file>
         [--browser-id <id>] [--timeout-ms 3600000]  Submit once; never blind-retry
  browser-drive <id> --revision <n> --request-prefix <key> [--turns 3]
         [--browser-id <id>] [--timeout-ms 3600000]  Bounded ChatGPT multi-turn loop
  browser-reconcile <id> --acknowledge-side-effects  Manual ambiguous-turn recovery
  browser-recover-turn <id> --revision <n> --acknowledge-side-effects
         Verify an uncertain reply or a dead-owner reserved existing-chat reply;
         never replay or credit an unmarked/incomplete response
  browser-correct-attribution <id> --revision <n> --acknowledge-side-effects
         Independently re-observe an incorrectly credited latest PI answer; append correction,
         preserve old events and require new PI review before any further Send
  browser-recover-rollover <id> --revision <n> --new-url <exact new chat URL>
         --acknowledge-side-effects  Read-only inspect old/new chats, then atomic observed recovery
  instruct <id> --text <instruction>
  pause <id> | resume <id> | cancel <id>
  reconcile <id> --acknowledge-side-effects

Environment: MISSION_RELAY_HOME, MISSION_RELAY_TELEGRAM_BOT_TOKEN,
MISSION_RELAY_TELEGRAM_USER_ID, MISSION_RELAY_TELEGRAM_CHAT_ID.
Each optional native executor manages its own configuration and credentials.
Telegram is an opt-in foreground channel. Playwriter requires the operator-enabled Chrome extension; no background service or PWA is installed.`);
}

export async function main(argv=process.argv.slice(2)): Promise<void> {
  const [command, id, ...rest] = argv;
  if (!command || ['help','--help','-h'].includes(command)) return help();
  const home = stateHome();
  const diagnostic=['pi-health','pi-evidence','pi-chain-evidence'].includes(command);
  const store = new Store(join(home,'missions.sqlite'),{readOnly:diagnostic});
  const engine = new Engine(store,new LazyExecutor(store));
  try {
    let result: unknown;
    if (command === 'create') {
      // create has no positional id; include all arguments in flags.
      const f = flags(argv.slice(1));
      const workspace = resolve(option(f,'workspace'));
      if (!statSync(workspace).isDirectory()) throw new Error('Workspace must be a directory');
      const sandbox = option(f,'sandbox','read-only');
      const mode = option(f,'mode','supervised');
      if (!['read-only','workspace-write'].includes(sandbox)) throw new Error('Invalid sandbox');
      if (!['supervised','autopilot'].includes(mode)) throw new Error('Invalid mode');
      const request:CreateMission = {
        goal:option(f,'goal'),acceptance:f['--accept'] || [],workspace,
        sandbox:sandbox as Sandbox,mode:mode as CreateMission['mode'],
        maxTurns:Number(option(f,'max-turns','10')),
        requestKey:option(f,'request-key',randomUUID()),
        checks:f['--checks-file'] ? JSON.parse(readFileSync(resolve(option(f,'checks-file')),'utf8')) as VerificationCheck[] : [],
      };
      if(!Array.isArray(request.checks)) throw new Error('Checks file must contain an array of verification checks');
      result = engine.create(request);
    } else if (command === 'chat-create') {
      const f=flags(argv.slice(1));
      const url=normalizeChatGPTUrl(option(f,'url'));
      const mission=engine.create({
        goal:option(f,'goal'),acceptance:f['--accept']||[],
        workspace:'',sandbox:'read-only',mode:'supervised',
        maxTurns:Number(option(f,'max-turns','30')),
        requestKey:option(f,'request-key',randomUUID()),checks:[],
      });
      const previous=store.chatLink(mission.id);
      if(previous && previous!==url) throw new Error('Idempotency key already belongs to a different ChatGPT conversation');
      const linked=store.linkChat(mission.id,url,mission.version);
      result={...linked,handoff:renderChatGPTHandoff(linked.mission,linked.url)};
    } else if (command === 'chat-adopt') {
      const f=flags(argv.slice(1));
      const url=normalizeChatGPTUrl(option(f,'url'));
      const browserId=option(f,'browser-id');
      const start=option(f,'start','false');
      if(!['true','false'].includes(start))throw new Error('--start must be true or false');
      const goal=f['--goal']?option(f,'goal'):undefined;
      let planner:AiosPiPlanner|undefined;
      if(start==='true'){
        const sshHost=store.getMeta('telegram.pi.sshHost');
        const project=store.getMeta('telegram.pi.project');
        if(!sshHost||!project)throw new Error('PI route is not configured; no adoption performed');
        planner=new AiosPiPlanner({sshHost,project});
        await planner.preflight();
      }
      const session=await connectChatPage(url,{browserId});
      result=await withBrowserSession(session,async page=>{
        const recorded=await adoptConnectedConversation(store,page,url,browserId,{
          goal,piEnabled:Boolean(planner),
        });
        return {missionId:recorded.missionId,state:store.get(recorded.missionId).state,
          adoptedAnswerSha256:recorded.adoptedAnswerSha256,
          nativeExecutorRequired:false,piQueued:Boolean(planner),
          foregroundPollerPresent:store.channelStatus('telegram').pollerPresent,
          note:planner?'Existing human reply recorded with zero sends; Telegram foreground controller will claim the queued PI Mission (no CLI browser writer).':
            'Existing human reply was read, not submitted by Relay; zero turns credited.'};
      });
    } else if(command==='chat-adopt-start'&&id){
      const m=store.get(id),adopted=store.chatAdoption(id);
      const url=store.chatLink(id),browserId=store.chatBrowserBinding(id);
      if(!adopted||m.turnCount!==0||m.state!=='PAUSED'||!url||!browserId||
         store.piPlan(id)||m.stopRequested)
        throw new Error('Mission must have an unreviewed, unstarted human ChatGPT adoption checkpoint');
      const sshHost=store.getMeta('telegram.pi.sshHost');
      const project=store.getMeta('telegram.pi.project');
      if(!sshHost||!project)throw new Error('PI route is not configured; no browser Send attempted');
      const planner=new AiosPiPlanner({sshHost,project});
      await planner.preflight();
      store.setMeta(`pi.autopilot.enabled.${id}`,'1');
      result={missionId:id,state:m.state,piQueued:true,
        foregroundPollerPresent:store.channelStatus('telegram').pollerPresent,
        note:'The foreground Telegram controller is the sole PI/browser writer. It will verify the exact original tab and review the human answer before sending.'};
    } else if (command === 'telegram-anchor' && id === '--clear') {
      store.setMeta('telegram.chatgpt.anchorMissionId','');
      result={configured:false,note:'The Telegram fresh-chat launcher has been locally revoked.'};
    } else if (command === 'telegram-anchor' && id) {
      const url=store.chatLink(id);
      const browserId=store.chatBrowserBinding(id);
      if(!url||!browserId)throw new Error('Anchor requires an existing ChatGPT mission with an explicitly pinned Chrome profile');
      const session=await connectChatPage(url,{browserId});
      const snapshot=await withBrowserSession(session,page=>inspectChatPage(page,url));
      if(!snapshot.composerReady||snapshot.generating)
        throw new Error('Anchor ChatGPT tab must be idle with a visible composer');
      store.setMeta('telegram.chatgpt.anchorMissionId',id);
      result={configured:true,anchorMissionId:id,chatUrl:url,
        note:'Explicitly approved source tab only; future Telegram tasks create separate new tabs, never send in this old conversation.'};
    } else if (command === 'telegram-agent-workspace' && id === '--clear') {
      store.setMeta('telegram.agent.workspace','');
      result={configured:false,note:'Native executor workspace authorization revoked.'};
    } else if (command === 'telegram-agent-workspace') {
      const f=flags(argv.slice(1));
      const workspace=resolve(option(f,'workspace'));
      if(!statSync(workspace).isDirectory())throw new Error('Approved native executor workspace must exist');
      store.setMeta('telegram.agent.workspace',workspace);
      result={configured:true,workspace,mode:'read-only',
        note:'Native executor is optional; verify the selected plugin enforces read-only tools independently.'};
    } else if (command === 'plugin-register') {
      const f=flags(argv.slice(1));
      result=await registerExecutorPlugin(store,option(f,'path'));
    } else if (command === 'plugin-list') {
      result={default:defaultExecutorId(store),installed:registeredExecutorPlugins(store)};
    } else if (command === 'plugin-default') {
      setDefaultExecutor(store,option(flags(argv.slice(1)),'id'));
      result={default:defaultExecutorId(store)};
    } else if (command === 'plugin-remove') {
      const pluginId=option(flags(argv.slice(1)),'id');
      removeExecutorPlugin(store,pluginId);
      result={removed:pluginId,note:'Registration cleared, external files and prior mission bindings unchanged.'};
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
    } else if (command === 'telegram-build-project' && id === '--clear') {
      store.setMeta('telegram.build.project','');
      result={configured:false,note:'No future /build command may start until locally re-approved.'};
    } else if (command === 'telegram-build-project') {
      const project=validateRemoteProjectPath(option(flags(argv.slice(1)),'project'));
      if(!store.getMeta('telegram.pi.sshHost')||project!==store.getMeta('telegram.pi.project'))
        throw new Error('Build project must exactly match the configured PI remote project');
      store.setMeta('telegram.build.project',project);
      result={configured:true,project,note:'The owner may opt into project changes with /build. This is a ChatGPT authorization prompt, not an operating-system sandbox.'};
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
      const bridge=new TelegramBridge(store,engine,new TelegramHttpTransport(token),owner,chat,
        (missionId)=>executorPreflight(store,missionId));
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
    } else if (command === 'channel-status') {
      result=store.channelStatus('telegram');
    } else if (command === 'pi-health') {
      if(id||rest.length)throw new Error('pi-health takes no arguments');
      result=store.piHealth();
    } else if (command === 'pi-evidence') {
      if(!id||!/^[0-9a-f-]{36}$/i.test(id)||rest.length)
        throw new Error('Provide exactly one PI Mission UUID');
      result=inspectPiEvidence(store,id);
    } else if (command === 'pi-chain-evidence') {
      if(!id||!/^[0-9a-f-]{36}$/i.test(id)||rest.length)
        throw new Error('Provide exactly one PI Mission UUID');
      result=inspectPiChainEvidence(store,id);
    } else if (command === 'doctor') {
      result=await executorPreflight(store);
      if (!(result as {ok:boolean}).ok) process.exitCode=2;
    }
    else if (command === 'list') result = engine.list();
    else if (command === 'archive-settled') {
      if(id||rest.length)throw new Error('archive-settled takes no arguments');
      result={...store.archiveSettledMissions(),mode:'non-destructive',
        note:'Mission records and all audit events remain available via list/show/events.'};
    }
    else if (command === 'browser-list') {
      const browsers=await listBrowsers();
      result=browsers.map(b=>({id:b.id,browser:b.browser,activeTabs:b.activeTabs,playwriterVersion:b.playwriterVersion}));
    } else if (command==='browser-watch-status') {
      result={enabled:Boolean(watchedBrowser(store)),browserId:watchedBrowser(store),
        note:'Only Playwriter-enabled ChatGPT tabs in this profile are discoverable; no tab-group requirement.'};
    } else if (command==='browser-watch'&&id==='--clear') {
      const browserId=watchedBrowser(store);
      const paused=store.atomic(()=>{
        disableBrowserWatch(store);
        let count=0;
        for(const m of store.list()){
          if(store.getMeta(`browser.watch.mission.${m.id}`)!==browserId||!browserId||
             m.stopRequested||['CANCELLED','COMPLETED'].includes(m.state))continue;
          if(!store.events(m.id).some(e=>e.type==='pi.autopilot_finished')){
            store.update(m.id,m.version,{stopRequested:true},'mission.pause_requested',
              {reason:'Chrome profile watch revoked'});
            count++;
          }
        }
        return count;
      });
      result={enabled:false,paused,note:'No new watched Mission will be adopted or sent after revocation.'};
    } else if (command==='browser-watch') {
      const browserId=option(flags(argv.slice(1)),'browser-id');
      const browsers=await listBrowsers();
      if(!browsers.some(browser=>browser.id===browserId))
        throw new Error('The requested Chrome profile is not Playwriter-connected');
      const sshHost=store.getMeta('telegram.pi.sshHost');
      const project=store.getMeta('telegram.pi.project');
      if(!sshHost||!project)throw new Error('Configure PI before enabling automatic Chrome adoption');
      const planner=new AiosPiPlanner({sshHost,project});
      await planner.preflight();
      const candidates=await listConnectedChatCandidates(browserId);
      const enabled=enableBrowserWatch(store,browserId,candidates);
      result={enabled:true,...enabled,
        note:'Existing connected conversations are baselined, not auto-started. The existing Telegram foreground controller watches newly changed Playwriter-enabled ChatGPT tabs.'};
    } else if (command === 'browser-candidates') {
      result={scope:'selected Playwriter-connected Chrome profile',
        warning:'Only enabled tabs are observable; inventory does not require or imply any tab-group membership.',
        candidates:await listConnectedChatCandidates(option(flags(argv.slice(1)),'browser-id'))};
    }
    else if (command === 'show' && id) result = engine.get(id);
    else if (command === 'events' && id) result = store.events(id);
    else if (command === 'link-chat' && id) {
      const f=flags(rest);
      result=store.linkChat(id,option(f,'url'),Number(option(f,'revision')));
    }
    else if (command === 'handoff' && id) {
      const url=store.chatLink(id);
      if(!url) throw new Error('No linked ChatGPT conversation; use link-chat locally first');
      result={conversationUrl:url,handoff:renderChatGPTHandoff(engine.get(id),url)};
    }
    else if (command === 'browser-bind' && id) {
      const f=flags(rest);
      const browserId=option(f,'browser-id');
      const browsers=await listBrowsers();
      if(!browsers.some(b=>b.id===browserId))
        throw new Error('Selected browser ID is not connected to the local Playwriter relay');
      result=store.bindChatBrowser(id,browserId,Number(option(f,'revision')));
    }
    else if (command === 'browser-probe' && id) {
      const url=store.chatLink(id);
      if(!url) throw new Error('Mission has no linked ChatGPT conversation');
      const f=flags(rest);
      const bound=store.chatBrowserBinding(id);
      if(!bound) throw new Error('Pin this ChatGPT Mission to an explicitly approved Chrome profile with browser-bind before probing');
      const selection=f['--browser-id']?option(f,'browser-id'):bound??undefined;
      if(bound && selection!==bound) throw new Error('Browser override conflicts with the bound Mission Chrome profile');
      const session=await connectChatPage(url,{browserId:selection});
      result=await withBrowserSession(session,async page=>{
        const snapshot=await inspectChatPage(page,url);
        return {...snapshot,lastAssistant:snapshot.lastAssistant.slice(-600),
          lastAssistantSha256:createHash('sha256').update(snapshot.lastAssistant).digest('hex'),
          missionId:id};
      });
    }
    else if (command === 'browser-send' && id) {
      const f=flags(rest);
      const url=store.chatLink(id);
      if(!url) throw new Error('Mission has no linked ChatGPT conversation');
      const revision=Number(option(f,'revision'));
      const requestKey=option(f,'request-key');
      const prompt=readFileSync(resolve(option(f,'prompt-file')),'utf8').trim();
      if(!prompt || prompt.length>12000) throw new Error('Browser prompt must contain 1–12000 characters');
      const timeoutMs=Number(option(f,'timeout-ms','3600000'));
      const bound=store.chatBrowserBinding(id);
      if(!bound) throw new Error('Pin this ChatGPT Mission to an explicitly approved Chrome profile with browser-bind before sending');
      const browserId=f['--browser-id']?option(f,'browser-id'):bound??undefined;
      if(bound && browserId!==bound) throw new Error('Browser override conflicts with the bound Mission Chrome profile');
      const session=await connectChatPage(url,{browserId});
      result=await withBrowserSession(session,async page=>{
        const receipt=await executeBrowserTurn({store,missionId:id,revision,requestKey,
          page,url,prompt,timeoutMs});
        const {lastAssistant: _fullText,...safeReceipt}=receipt;
        return safeReceipt;
      });
    }
    else if (command === 'browser-drive' && id) {
      const f=flags(rest);
      const url=store.chatLink(id);
      if(!url) throw new Error('Mission has no linked ChatGPT conversation');
      const turns=Number(option(f,'turns','3'));
      if(!Number.isInteger(turns)||turns<1||turns>MAX_RELAY_CHAT_TURNS)
        throw new Error(`Drive turns must be 1–${MAX_RELAY_CHAT_TURNS}`);
      const prefix=option(f,'request-prefix');
      if(!/^[\w.-]{1,120}$/.test(prefix)) throw new Error('Request prefix must be 1–120 safe characters');
      const timeoutMs=Number(option(f,'timeout-ms','3600000'));
      const bound=store.chatBrowserBinding(id);
      if(!bound) throw new Error('Pin this ChatGPT Mission to an explicitly approved Chrome profile with browser-bind before continuing');
      const browserId=f['--browser-id']?option(f,'browser-id'):bound??undefined;
      if(bound && browserId!==bound) throw new Error('Browser override conflicts with the bound Mission Chrome profile');
      const revision=Number(option(f,'revision'));
      const session=await connectChatPage(url,{browserId});
      result=await withBrowserSession(session,async page=>{
        const outcome=await driveChatConversation({store,missionId:id,revision,
          requestPrefix:prefix,turns,page,url,timeoutMs});
        return {missionId:id,...outcome,
          note:'Flow markers are untrusted hints; no claim of independent completion verification.'};
      });
    }
    else if (command === 'browser-reconcile' && id) {
      if(!flags(rest)['--acknowledge-side-effects']) throw new Error('Explicit --acknowledge-side-effects is required');
      if(!['reserved','uncertain'].includes(store.chatBrowserTurn(id)?.status??''))
        throw new Error('No interrupted browser turn to reconcile');
      const m=store.reconcileChatBrowserTurn(id);
      result={...m,note:'Original browser request will never be replayed; inspect the chat before issuing a NEW request key.'};
    }
    else if (command === 'browser-recover-turn' && id) {
      const f=flags(rest);
      if(!f['--acknowledge-side-effects'])
        throw new Error('Explicit --acknowledge-side-effects is required after inspecting the real ChatGPT conversation');
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
    else if (command === 'browser-correct-attribution' && id) {
      const f=flags(rest);
      if(!f['--acknowledge-side-effects'])
        throw new Error('Explicit --acknowledge-side-effects is required for immutable attribution correction');
      const revision=Number(option(f,'revision'));
      const m=store.get(id),record=store.chatBrowserTurn(id),url=store.chatLink(id);
      const bound=store.chatBrowserBinding(id),plan=store.piPlan(id);
      if(m.version!==revision||m.state!=='PAUSED'||m.stopRequested||
        record?.status!=='observed'||!url||!bound||!plan||
        plan.round!==m.turnCount||plan.responseSha256!==record.assistantSha256)
        throw new Error('Attribution correction requires the original latest PI observed receipt and exact revision');
      const session=await withReadOnlyDeadline(connectChatPage(url,{browserId:bound}),
        30_000,late=>late.close());
      const answer=await withBrowserSession(session,async page=>{
        const first=await withReadOnlyDeadline(inspectChatPage(page,url));
        if(first.generating||!first.composerReady||
          !['DONE','NEXT','BLOCKED','HANDOFF'].includes(browserDecision(first.lastAssistant))||
          !matchesReservedPromptHash(await withReadOnlyDeadline(lastVisibleUserPromptSha256(page)),record.promptSha256))
          throw new Error('Live ChatGPT does not show a complete reply to the original reserved request');
        const firstSha=createHash('sha256').update(first.lastAssistant).digest('hex');
        if(firstSha===record.assistantSha256)
          throw new Error('Live assistant answer matches the original receipt; there is no proven attribution error');
        await new Promise(resolve=>setTimeout(resolve,3000));
        const second=await withReadOnlyDeadline(inspectChatPage(page,url));
        if(second.generating||!second.composerReady||
          second.lastAssistant!==first.lastAssistant||
          !matchesReservedPromptHash(await withReadOnlyDeadline(lastVisibleUserPromptSha256(page)),record.promptSha256))
          throw new Error('Corrected answer did not remain stable on the exact original request');
        return second.lastAssistant;
      });
      const assistantSha256=createHash('sha256').update(answer).digest('hex');
      const corrected=store.correctPiBrowserAttribution(id,revision,{
        requestPromptSha256:record.promptSha256,assistantSha256,summary:answer,
      });
      result={missionId:id,state:corrected.state,revision:corrected.version,
        round:corrected.turnCount,assistantSha256,
        note:'Historical browser/PI events preserved. No new Send or turn credited. Original PI decision is invalid until corrected answer is independently re-reviewed.'};
    }
    else if (command === 'browser-recover-rollover' && id) {
      const f=flags(rest);
      if(!f['--acknowledge-side-effects'])
        throw new Error('Explicit --acknowledge-side-effects is required after reviewing both browser conversations');
      const revision=Number(option(f,'revision'));
      const newUrl=normalizeChatGPTUrl(option(f,'new-url'));
      const m=store.get(id),oldUrl=store.chatLink(id),record=store.chatBrowserTurn(id);
      const bound=store.chatBrowserBinding(id);
      if(!oldUrl||!bound||m.version!==revision||m.state!=='NEEDS_RECONCILIATION'||
        record?.status!=='uncertain'||newUrl===oldUrl)
        throw new Error('No eligible uncertain, bound browser rollover at this Mission revision');
      const oldSession=await connectChatPage(oldUrl,{browserId:bound});
      const prompt=await withBrowserSession(oldSession,async page=>{
        const source=await inspectChatPage(page,oldUrl);
        if(source.generating||!source.composerReady)
          throw new Error('Original ChatGPT source tab is not idle');
        const parent=store.piChainParent(id);
        return browserRolloverRecoveryPrompt({
          goal:m.goal,acceptance:m.acceptance,sandbox:m.sandbox,workspace:m.workspace,
          nextInstruction:m.nextInstruction,turnCount:m.turnCount,
          missionRequestKey:m.requestKey,reservedRequestKey:record.requestKey,
          sourceAnswer:source.lastAssistant,adopted:store.chatAdoption(id)!==null,
          chainParent:parent!==null,
          piManaged:store.getMeta(`pi.autopilot.enabled.${id}`)==='1',
          piPlan:browserRolloverPiPlan(store,id),
        });
      });
      const promptSha256=createHash('sha256').update(prompt.trim()).digest('hex');
      if(promptSha256!==record.promptSha256)
        throw new Error('Reconstructed handoff prompt hash differs from the durable reserved request');
      const newSession=await connectChatPage(newUrl,{browserId:bound});
      const answer=await withBrowserSession(newSession,async page=>{
        const first=await inspectChatPage(page,newUrl);
        if(first.generating||!['DONE','NEXT','BLOCKED'].includes(browserDecision(first.lastAssistant))||
          !matchesSubmittedUserPrompt(await lastVisibleUserPromptSha256(page),prompt))
          throw new Error('New conversation is not a complete reply to the exact reserved prompt');
        await new Promise(resolve=>setTimeout(resolve,2600));
        const second=await inspectChatPage(page,newUrl);
        if(second.generating||second.lastAssistant!==first.lastAssistant||
          !matchesSubmittedUserPrompt(await lastVisibleUserPromptSha256(page),prompt))
          throw new Error('New ChatGPT reply was not stable or its submitted prompt changed');
        return second.lastAssistant;
      });
      const assistantSha256=createHash('sha256').update(answer).digest('hex');
      const recovered=store.recoverObservedBrowserRollover(id,revision,{
        requestPromptSha256:promptSha256,newChatUrl:newUrl,assistantSha256,summary:answer,
      });
      result={...recovered,assistantSha256,verifiedNewUrl:newUrl,
        note:'Reconciled after independent old/new page readback; prior request was not replayed.'};
    }
    else if (command === 'run' && id) {
      if(store.chatLink(id)) throw new Error('Mission is linked to ChatGPT; use browser control, not a native executor');
      const preflight=await executorPreflight(store,id);
      if(!preflight.ok) throw new Error(preflight.message);
      result = await engine.run(id);
    }
    else if (command === 'pause' && id) result = engine.pause(id);
    else if (command === 'resume' && id) result = engine.resume(id);
    else if (command === 'cancel' && id) result = engine.cancel(id);
    else if (command === 'instruct' && id) result = engine.instruct(id,option(flags(rest),'text'));
    else if (command === 'reconcile' && id) {
      if(store.chatLink(id) && ['reserved','uncertain'].includes(store.chatBrowserTurn(id)?.status??''))
        throw new Error('Interrupted ChatGPT browser dispatch requires browser-reconcile, which clears the Mission and conversation lock atomically');
      result=engine.reconcile(id,Boolean(flags(rest)['--acknowledge-side-effects']));
    }
    else throw new Error('Unknown command or missing mission ID; run help');
    console.log(JSON.stringify(result,null,2));
    if (command === 'run' && (result as {state?:string})?.state === 'NEEDS_RECONCILIATION') process.exitCode = 2;
  } finally { store.close(); }
}

main().catch(error=>{console.error(`mission-relay: ${error instanceof Error ? error.message : String(error)}`);process.exitCode=1;});
