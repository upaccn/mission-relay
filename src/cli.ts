#!/usr/bin/env node
import { randomUUID, createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { statSync, readFileSync } from 'node:fs';
import { Engine } from './core/engine.js';
import { Store } from './core/store.js';
import { PluginRegistry } from './core/plugins.js';
import { CodexAdapter, codexPluginManifest } from './plugins/codex.js';
import { TelegramBridge, TelegramHttpTransport } from './plugins/telegram.js';
import { stateHome, initializeCodexHome } from './core/paths.js';
import { codexPreflight } from './core/preflight.js';
import { renderChatGPTHandoff, normalizeChatGPTUrl } from './core/chatgpt-handoff.js';
import { connectChatPage, inspectChatPage, lastVisibleUserContainsPrompt, withBrowserSession } from './plugins/chatgpt-browser.js';
import { executeBrowserTurn, driveChatConversation, browserDecision, browserNewChatPrompt, browserContinuationPrompt } from './core/browser-controller.js';
import {validatePictlRemoteConfig} from './core/pi-planner.js';
import { listBrowsers } from 'playwriter';
import type { AgentAdapter, CreateMission, Sandbox } from './core/types.js';
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
  console.log(`Mission Relay v0.1 alpha
Commands:
  doctor                Check the configured local Codex bridge without starting a mission
  codex-init            Create an isolated Codex config/auth directory (never copies credentials)
  telegram              Run an optional Telegram channel in the foreground (owner allowlist)
  telegram-anchor <mission-id>|--clear  Locally approve/revoke the exact pinned new-chat source tab
  telegram-codex-workspace --workspace <dir>|--clear  Locally approve/revoke the read-only Codex work directory
  telegram-pi-config --ssh-host <alias> --project <remote-absolute-path> | --clear
                      Configure tool-free PI inference through the existing SSH connection
  telegram-identify     Inspect local /start sender IDs before owner authorization
  channel-status        Inspect durable Telegram delivery cursor and poller status (no secrets)
  create --goal <text> --accept <criterion> [--accept <criterion>...] --workspace <path>
         [--sandbox read-only|workspace-write] [--mode supervised|autopilot]
         [--max-turns 10] [--request-key <stable key>] [--checks-file <path>]
  run <id>              Execute one supervised turn or a bounded autopilot
  show <id>             Read authoritative mission state
  list                  List missions
  events <id>           Read append-only mission events
  link-chat <id> --url <ChatGPT conversation URL> --revision <version>
  chat-create --goal <text> --accept <criterion> --url <ChatGPT conversation URL>
             [--accept <criterion>...] [--request-key <stable key>]
  handoff <id>          Show existing ChatGPT chat link and manual continuation prompt
  browser-list          List connected Playwriter browser IDs (no profile emails)
  browser-bind <id> --browser-id <id> --revision <n>   Pin a mission to one Chrome profile
  browser-probe <id> [--browser-id <id>]   Read a Playwriter-enabled ChatGPT tab
  browser-send <id> --revision <n> --request-key <key> --prompt-file <file>
         [--browser-id <id>] [--timeout-ms 2100000]  Submit once; never blind-retry
  browser-drive <id> --revision <n> --request-prefix <key> [--turns 3]
         [--browser-id <id>] [--timeout-ms 2100000]  Bounded ChatGPT multi-turn loop
  browser-reconcile <id> --acknowledge-side-effects  Manual ambiguous-turn recovery
  browser-recover-turn <id> --revision <n> --acknowledge-side-effects
         Verify a complete reply in the original chat without resending, then credit its observed turn
  browser-recover-rollover <id> --revision <n> --new-url <exact new chat URL>
         --acknowledge-side-effects  Read-only inspect old/new chats, then atomic observed recovery
  instruct <id> --text <instruction>
  pause <id> | resume <id> | cancel <id>
  reconcile <id> --acknowledge-side-effects

Environment: MISSION_RELAY_HOME, MISSION_RELAY_CODEX_HOME, MISSION_RELAY_MODEL,
MISSION_RELAY_CODEX_BASE_URL, MISSION_RELAY_TURN_TIMEOUT_MS,
MISSION_RELAY_CODEX_PROXY (optional, applies to Codex child only),
MISSION_RELAY_WINDOWS_SANDBOX (elevated default; unelevated fallback),
MISSION_RELAY_TELEGRAM_BOT_TOKEN, MISSION_RELAY_TELEGRAM_USER_ID, MISSION_RELAY_TELEGRAM_CHAT_ID.
Telegram is an opt-in foreground channel. Playwriter requires the operator-enabled Chrome extension; no background service or PWA is installed.`);
}

export async function main(argv=process.argv.slice(2)): Promise<void> {
  const [command, id, ...rest] = argv;
  if (!command || ['help','--help','-h'].includes(command)) return help();
  const home = stateHome();
  const store = new Store(join(home,'missions.sqlite'));
  const adapters = new PluginRegistry<AgentAdapter>();
  adapters.register(codexPluginManifest,new CodexAdapter());
  const engine = new Engine(store,adapters.get('executor.codex','executor'));
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
    } else if (command === 'telegram-codex-workspace' && id === '--clear') {
      store.setMeta('telegram.codex.workspace','');
      result={configured:false,note:'The Telegram remote Codex work directory has been locally revoked.'};
    } else if (command === 'telegram-codex-workspace') {
      const f=flags(argv.slice(1));
      const workspace=resolve(option(f,'workspace'));
      if(!statSync(workspace).isDirectory())throw new Error('Approved Codex workspace must be an existing directory');
      store.setMeta('telegram.codex.workspace',workspace);
      result={configured:true,workspace,mode:'read-only',
        note:'Telegram /codex is limited to one supervised turn. This filesystem sandbox does not constrain external MCP permissions; use an isolated Codex profile without write-capable MCP tools.'};
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
    } else if (command === 'codex-init') {
      result={codexHome:initializeCodexHome(),
        next:'Authorize this isolated CODEX_HOME using the official codex login command, then run mission-relay doctor.'};
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
      const bridge=new TelegramBridge(store,engine,new TelegramHttpTransport(token),owner,chat);
      const controller=new AbortController();
      const shutdown=()=>controller.abort();
      process.once('SIGINT',shutdown);
      process.once('SIGTERM',shutdown);
      console.log('Telegram channel running with an explicit owner allowlist. Ctrl+C stops polling.');
      try{await bridge.run(controller.signal);}finally{
        process.removeListener('SIGINT',shutdown);process.removeListener('SIGTERM',shutdown);
      }
      return;
    } else if (command === 'channel-status') {
      result=store.channelStatus('telegram');
    } else if (command === 'doctor') {
      result=await codexPreflight();
      if (!(result as {ok:boolean}).ok) process.exitCode=2;
    }
    else if (command === 'list') result = engine.list();
    else if (command === 'browser-list') {
      const browsers=await listBrowsers();
      result=browsers.map(b=>({id:b.id,browser:b.browser,activeTabs:b.activeTabs,playwriterVersion:b.playwriterVersion}));
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
      const timeoutMs=Number(option(f,'timeout-ms','2100000'));
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
      if(!Number.isInteger(turns)||turns<1||turns>8) throw new Error('Drive turns must be 1–8');
      const prefix=option(f,'request-prefix');
      if(!/^[\w.-]{1,120}$/.test(prefix)) throw new Error('Request prefix must be 1–120 safe characters');
      const timeoutMs=Number(option(f,'timeout-ms','2100000'));
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
      if(!url||!bound||m.version!==revision||m.state!=='NEEDS_RECONCILIATION'||
        record?.status!=='uncertain')
        throw new Error('No eligible uncertain, bound existing ChatGPT conversation turn at this revision');
      // Reconstruction must match the *original reserved* request hash. A
      // concurrent instruction or different browser prompt fails closed.
      const candidates=[true,false].map(first=>
        browserContinuationPrompt(m.goal,m.acceptance,first,m.nextInstruction));
      const prompt=candidates.find(value=>createHash('sha256').update(value.trim()).digest('hex')===record.promptSha256);
      if(!prompt)throw new Error('Cannot reconstruct the original reserved continuation prompt exactly');
      const session=await connectChatPage(url,{browserId:bound});
      const answer=await withBrowserSession(session,async page=>{
        const first=await inspectChatPage(page,url);
        if(first.generating||!first.lastAssistant.trim()||
          !['DONE','NEXT','BLOCKED','HANDOFF'].includes(browserDecision(first.lastAssistant))||
          !await lastVisibleUserContainsPrompt(page,prompt.trim()))
          throw new Error('Original chat does not show the exact reserved user request and a complete marked assistant reply');
        await new Promise(resolve=>setTimeout(resolve,3000));
        const second=await inspectChatPage(page,url);
        if(second.generating||second.lastAssistant!==first.lastAssistant||
          !await lastVisibleUserContainsPrompt(page,prompt.trim()))
          throw new Error('Original ChatGPT reply was unstable or no longer corresponds to the reserved request');
        return second.lastAssistant;
      });
      const assistantSha256=createHash('sha256').update(answer).digest('hex');
      const recovered=store.recoverObservedBrowserTurn(id,revision,{
        requestPromptSha256:record.promptSha256,assistantSha256,summary:answer,
      });
      result={...recovered,assistantSha256,verifiedDecision:browserDecision(answer),
        note:'Recovered the observed original-chat reply with no new Send. Historical uncertain event preserved; model DONE is not independent verification.'};
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
        if(source.generating||browserDecision(source.lastAssistant)!=='HANDOFF')
          throw new Error('Original conversation does not contain a complete HANDOFF response');
        return browserNewChatPrompt(m.goal,m.acceptance,source.lastAssistant,m.nextInstruction);
      });
      const promptSha256=createHash('sha256').update(prompt.trim()).digest('hex');
      if(promptSha256!==record.promptSha256)
        throw new Error('Reconstructed handoff prompt hash differs from the durable reserved request');
      const newSession=await connectChatPage(newUrl,{browserId:bound});
      const answer=await withBrowserSession(newSession,async page=>{
        const first=await inspectChatPage(page,newUrl);
        if(first.generating||!['DONE','NEXT','BLOCKED'].includes(browserDecision(first.lastAssistant))||
          !await lastVisibleUserContainsPrompt(page,prompt.trim()))
          throw new Error('New conversation is not a complete reply to the exact reserved prompt');
        await new Promise(resolve=>setTimeout(resolve,2600));
        const second=await inspectChatPage(page,newUrl);
        if(second.generating||second.lastAssistant!==first.lastAssistant||
          !await lastVisibleUserContainsPrompt(page,prompt.trim()))
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
      if(store.chatLink(id)) throw new Error('Mission is linked to ChatGPT; use handoff, not Codex run');
      const preflight=await codexPreflight();
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
