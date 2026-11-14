#!/usr/bin/env node
import { randomUUID, createHash } from 'node:crypto';
import {MAX_RELAY_CHAT_TURNS} from './core/chat-limits.js';
import {withReadOnlyDeadline} from './core/read-only-deadline.js';
import {armScopedPiConnectionDrill,scopedPiConnectionDrillStatus} from './core/pi-connection-drill.js';
import { join, resolve } from 'node:path';
import { statSync, readFileSync } from 'node:fs';
import { Engine } from './core/engine.js';
import { Store,PI_SUCCESSOR_CHECKPOINT_MISMATCH } from './core/store.js';
import {GoalLedger} from './core/goal-store.js';
import {GoalReleaseGate,inspectReleaseProbeOutcome} from './core/goal-release.js';
import {inspectSoftwareReleaseCandidate} from './core/software-release.js';
import {gmkProductionReleaseProbe,enrolledTaskStatus} from './core/goal-release-runtime.js';
import {trustedChromeReleaseProbe} from './core/goal-release-chrome-probes.js';
import {trustedSuccessorReleaseProbe} from './core/goal-release-successor-probe.js';
import {maintenanceReleaseProbe} from './core/goal-release-maintenance-probe.js';
import {independentWorkReleaseProbe} from './core/goal-release-work-probe.js';
import {remoteReleaseProbe} from './core/goal-release-remote.js';
import {githubRepositoryForRuntime,readGithubReleaseMainSha,
  githubReleaseProbe} from './core/goal-release-github.js';
import {inspectPiEvidence,inspectPiChainEvidence} from './core/pi-evidence.js';
import {inspectGoalRequestLedger} from './core/request-ledger.js';
import {inspectGoalReleaseMatrix} from './core/goal-release-matrix.js';
import {inspectGoalReleaseCoverage} from './core/goal-release-coverage.js';
import {inspectBrowserBinding} from './core/browser-binding-diagnostic.js';
import {assessPendingBrowserAnswer} from './core/browser-pending-evidence.js';
import {LazyExecutor,registerExecutorPlugin,registeredExecutorPlugins,defaultExecutorId,
  setDefaultExecutor,removeExecutorPlugin,executorPreflight} from './core/executor-plugins.js';
import { TelegramBridge, TelegramHttpTransport } from './plugins/telegram.js';
import { stateHome } from './core/paths.js';
import {verifiedRuntimeProvenance} from './core/runtime-provenance.js';
import { renderChatGPTHandoff, normalizeChatGPTUrl } from './core/chatgpt-handoff.js';
import {setTelegramChatAnchor} from './core/chat-anchor.js';
import { connectChatPage, inspectChatPage, matchesSubmittedUserPrompt, matchesReservedPromptHash, lastVisibleUserPromptSha256, listConnectedChatCandidates, prepareNewChatOrigin, submitNewChatTurn, withBrowserSession,visibleConversationLengthLimit,clickConversationLengthStartOnce } from './plugins/chatgpt-browser.js';
import { executeBrowserTurn, driveChatConversation, browserDecision, exactReservedRolloverPrompt, browserRolloverPiPlan } from './core/browser-controller.js';
import {SshPiPlanner,validatePictlRemoteConfig,validateRemoteProjectPath} from './core/pi-planner.js';
import {approveBuildRepository,revokeBuildRepository,approvedBuildRepositories} from './core/build-scopes.js';
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
  console.log(`Mission Relay v1.0
Commands:
  software-release-status --sha <GitHub main SHA> --run-id <GitHub Actions run>
                       Independently qualify software CI on three platforms without a Goal or SQLite
  doctor                Check installed optional executor, if any
  plugin-register --path <absolute .mjs/.js>  Register a trusted native executor plugin
  plugin-list           List installed native executor (none required for ChatGPT)
  plugin-default --id <executor.id>  Optional override when several plugins exist
  plugin-remove --id <executor.id>   Remove one registration (no user files deleted)
  telegram              Run an optional Telegram channel in the foreground (owner allowlist)
  channel-drain-request  Request a local SQLite-fenced, idle-only Telegram maintenance drain
  channel-drain-status   Inspect the local maintenance receipt for failed-launch recovery
  channel-drain-release --id <drain-id>  Release only the matching maintenance fence
  channel-drain-release-verified --id <drain-id> --expected-sha <sha> --expected-pid <pid> --expected-attested-at <ISO-8601>
                         Atomically admit only the freshly healthy, SHA-bound single Worker
  telegram-anchor --url <ChatGPT conversation> --browser-id <Chrome ID> | --clear
                       Locally approve a browser launch profile, independent of any Mission
  telegram-agent-workspace --workspace <dir>|--clear  Optional native executor workspace approval
  telegram-pi-config --ssh-host <alias> --project <remote-absolute-path> | --clear
                      Configure tool-free PI inference through the existing SSH connection
  telegram-build-project --project <remote-absolute-path> | --clear
                      Legacy default repository for /build (must equal configured PI project)
  telegram-build-project --allow <remote-absolute-path> | --revoke <path> | --list
                      Explicit per-repository approval for independent /goal-build --repo <path>
  telegram-identify     Inspect local /start sender IDs before owner authorization
  channel-status        Inspect durable Telegram delivery cursor and poller status (no secrets)
  pi-health             Inspect active PI/browser requests, observed turns and wait age (no content, no Send)
  pi-drill-status <mission-id>   Read-only one-shot recovery connection drill status
  pi-drill-connection <mission-id> --revision <n> [--ttl-seconds 90]
                       --acknowledge-side-effects  One-shot, single-session PI recovery disconnect;
                       only at a settled idle checkpoint, automatically expires within 120s
  pi-evidence <mission-id>  Audit real event/PI SHA correlation and 10-send chat segmentation (no content, no Send)
  pi-chain-evidence <mission-id>  Verify durable 32-turn successor lineage and inherited scope (no Send)
  goal-request-ledger <goal-id>  Read-only Goal→Mission→Chat→request→browser evidence custody audit
  goal-release-status <goal-id>  Read-only independent Goal release gates, evidence and blockers
  goal-release-matrix <goal-id>  Read-only claim-to-receipt and independent-probe coverage matrix
  goal-release-coverage <goal-id> --sha <candidate SHA>
                       Read-only 39-gate evidence gap index (never grants PASS)
  goal-release-target <goal-id> --sha <reviewed main SHA>
                       Begin independent verification after all PI work reports PASS
  goal-release-verify <goal-id> --requirement <check|privacy-check|test|build|ci-OS|gmk-production-readback>
                       [--run-id <GitHub Actions run>]
                       Verify exact-head GitHub CI steps, or execute a fixed
                       source check via approved SSH when no run-id was given;
                       GMK readback only on original Windows host, with read-only Chrome inspection
  goal-release-probe-diagnose <goal-id> --requirement <gate|criterion:UUID>
                       [--run-id <GitHub Actions run>]
                       Read-only SQLite diagnostic: PASS, FAIL or INSUFFICIENT_EVIDENCE;
                       never writes a release PASS, Mission, Send or PI decision
  goal-release-finalize <goal-id>  DONE only after all evidence and fresh origin/main readback
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
  browser-binding-health <mission-id>  Read-only exact-tab/last-prompt diagnostic (no Send, no raw URL)
  browser-pending-evidence <mission-id>  Read-only double-snapshot pending-answer candidate, never reconciles or resends
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
  pi-resume <id> --revision <n> --acknowledge-side-effects
         Release a settled owner-paused PI checkpoint for independent controller re-readback;
         never change it to READY or replay its previous Send
  pi-recheck-capacity <id> --revision <n> --acknowledge-side-effects
         Double-check the original settled reply after a known PI global-task busy error; no Send
  pi-recheck-successor <id> --revision <n> --acknowledge-side-effects
         For the known parent-vs-child checkpoint bug only: verify original
         successor user/answer SHAs twice in the live pinned ChatGPT tab, then
         clear just the false recovery interruption; no Send or PI decision
  browser-recover-rollover <id> --revision <n> --new-url <exact new chat URL>
         --acknowledge-side-effects  Read-only inspect old/new chats, then atomic observed recovery
  browser-resume-pending-retry <id> --revision <n> --acknowledge-side-effects
         Release an owner-paused, uncertain original existing/new-chat message for ONE enrolled-Worker
  browser-start-new-chat <id> --revision <n> --acknowledge-side-effects
         Click the exact native maximum-length Start new chat button ONCE after maintenance;
         preserve the uncredited original Send and its lock; never replay the composer
         existing-message UI Retry; never perform Retry or composer Send here
  browser-retry-pre-send-rollover <id> --revision <n> --acknowledge-side-effects
         ONE original-reservation first Send only after the exact old page.goto
         origin timeout proved no Send click occurred; audit intent before
         side effects; retain uncertainty and refuse every later retry
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
  if(command==='software-release-status'){
    const f=flags(argv.slice(1));
    if(Object.keys(f).length!==2||!f['--sha']||!f['--run-id'])
      throw new Error('Usage: software-release-status --sha <SHA> --run-id <Actions ID>');
    const report=await inspectSoftwareReleaseCandidate(githubRepositoryForRuntime(),
      option(f,'sha'),option(f,'run-id'));
    console.log(JSON.stringify(report,null,2));
    return;
  }
  const home = stateHome();
  const diagnostic=['channel-status','channel-drain-status',
    'pi-health','pi-evidence','pi-chain-evidence','pi-drill-status','browser-binding-health',
    'browser-pending-evidence','goal-release-status','goal-request-ledger',
    'goal-release-matrix','goal-release-coverage','goal-release-probe-diagnose',
    ].includes(command);
  const store = new Store(join(home,'missions.sqlite'),{readOnly:diagnostic});
  const engine = new Engine(store,new LazyExecutor(store));
  try {
    let result: unknown;
    if(command==='pi-drill-status'&&id){
      if(!/^[0-9a-f-]{36}$/i.test(id)||rest.length)
        throw new Error('Provide exactly one Mission UUID');
      result=scopedPiConnectionDrillStatus(store,id);
    } else if(command==='pi-drill-connection'&&id){
      const f=flags(rest);
      if(f['--acknowledge-side-effects']?.[0]!=='true')
        throw new Error('Explicit --acknowledge-side-effects is required');
      result=armScopedPiConnectionDrill(store,id,Number(option(f,'revision')),
        Number(option(f,'ttl-seconds','90')));
    }
    else if (command === 'create') {
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
      let planner:SshPiPlanner|undefined;
      if(start==='true'){
        const sshHost=store.getMeta('telegram.pi.sshHost');
        const project=store.getMeta('telegram.pi.project');
        if(!sshHost||!project)throw new Error('PI route is not configured; no adoption performed');
        planner=new SshPiPlanner({sshHost,project});
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
      const planner=new SshPiPlanner({sshHost,project});
      await planner.preflight();
      store.setMeta(`pi.autopilot.enabled.${id}`,'1');
      result={missionId:id,state:m.state,piQueued:true,
        foregroundPollerPresent:store.channelStatus('telegram').pollerPresent,
        note:'The foreground Telegram controller is the sole PI/browser writer. It will verify the exact original tab and review the human answer before sending.'};
    } else if (command === 'telegram-anchor' && id === '--clear') {
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
    } else if (command === 'telegram-build-project') {
      const project=validateRemoteProjectPath(option(flags(argv.slice(1)),'project'));
      if(!store.getMeta('telegram.pi.sshHost')||project!==store.getMeta('telegram.pi.project'))
        throw new Error('Build project must exactly match the configured PI remote project');
      store.setMeta('telegram.build.project',project);
      approveBuildRepository(store,project);
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
      const runtimeProof=verifiedRuntimeProvenance();
      const bridge=new TelegramBridge(store,engine,new TelegramHttpTransport(token),owner,chat,
        (missionId)=>executorPreflight(store,missionId),
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
    } else if (command === 'pi-chain-evidence') {
      if(!id||!/^[0-9a-f-]{36}$/i.test(id)||rest.length)
        throw new Error('Provide exactly one PI Mission UUID');
      result=inspectPiChainEvidence(store,id);
    } else if (command === 'goal-request-ledger') {
      if(!id||!/^[0-9a-f-]{36}$/i.test(id)||rest.length)
        throw new Error('Provide exactly one Goal UUID');
      result=inspectGoalRequestLedger(store,id);
    } else if (command === 'goal-release-matrix') {
      if(!id||!/^[0-9a-f-]{36}$/i.test(id)||rest.length)
        throw new Error('Provide exactly one Goal UUID');
      result=inspectGoalReleaseMatrix(store,id);
    } else if (command === 'goal-release-coverage') {
      if(!id||!/^[0-9a-f-]{36}$/i.test(id))
        throw new Error('Provide exactly one Goal UUID');
      const f=flags(rest);
      if(Object.keys(f).length!==1||!f['--sha']||f['--sha'].length!==1)
        throw new Error('Usage: goal-release-coverage <Goal UUID> --sha <candidate SHA>');
      result=inspectGoalReleaseCoverage(store,id,option(f,'sha'));
    } else if (command === 'goal-release-status') {
      if(!id||rest.length)throw new Error('Usage: goal-release-status <goal-id>');
      result=new GoalReleaseGate(store).report(id);
    } else if (['goal-release-target','goal-release-verify','goal-release-probe-diagnose',
      'goal-release-finalize'].includes(command)) {
      if(!id||!/^[0-9a-f-]{36}$/i.test(id))
        throw new Error('Goal release requires an exact Goal UUID');
      const project=store.getMeta('telegram.build.project');
      const sshHost=store.getMeta('telegram.pi.sshHost');
      if(!sshHost||!project||project!==store.getMeta('telegram.pi.project'))
        throw new Error('Goal release requires the existing approved operator-managed host SSH project');
      const remote=validatePictlRemoteConfig({sshHost,project});
      // GitHub main (not GMK's intentionally stale pull-only checkout) is
      // the publication boundary. This read needs no operator-managed host SSH directory
      // permission and cannot modify either host.
      const githubRepository=githubRepositoryForRuntime();
      const gate=new GoalReleaseGate(store),
        mainSha=readGithubReleaseMainSha(githubRepository);
      if(command==='goal-release-target'){
        const f=flags(rest),target=option(f,'sha');
        if(target!==mainSha)throw new Error('Release target differs from independently read origin/main');
        result=gate.begin(id,target);
      }else if(command==='goal-release-verify'||command==='goal-release-probe-diagnose'){
        const f=flags(rest),requirement=option(f,'requirement');
        const runId=f['--run-id']?option(f,'run-id'):null;
        if(runId&&(['gmk-production-readback','chrome-10-to-11',
          'relay-tab-retirement','mission-32-successor','maintenance-resume'].includes(requirement)||
          requirement.startsWith('criterion:')))
          throw new Error('Independent production or work verification cannot use a CI run as evidence');
        const probe=requirement==='gmk-production-readback'
          ?gmkProductionReleaseProbe(store,id,join(home,'goal-release-evidence'))
          :['chrome-10-to-11','relay-tab-retirement'].includes(requirement)
          ?trustedChromeReleaseProbe(store,id)
          :requirement==='mission-32-successor'
          ?trustedSuccessorReleaseProbe(store,id)
          :requirement==='maintenance-resume'
          ?maintenanceReleaseProbe(store,id,join(process.env.LOCALAPPDATA??'','MissionRelay','telegram-task'))
          :requirement.startsWith('criterion:')
          ?independentWorkReleaseProbe(store,id,join(home,'goal-release-evidence'),remote)
          :requirement.startsWith('ci-')||runId
          ?githubReleaseProbe(githubRepository,runId??option(f,'run-id'))
          :remoteReleaseProbe(remote,join(home,'goal-release-evidence'));
        if(command==='goal-release-probe-diagnose'){
          const target=gate.report(id).target;
          result=!target?{
            verdict:'INSUFFICIENT_EVIDENCE',requirement,
            targetSha:null,reason:'No approved immutable release target',
          }:target.targetSha!==mainSha?{
            verdict:'FAIL',requirement,targetSha:target.targetSha,
            reason:'Release target differs from independently read GitHub main',
          }:await inspectReleaseProbeOutcome(requirement,target.targetSha,probe);
        }else result=await gate.inspect(id,requirement,probe);
      }else{
        if(rest.length)throw new Error('goal-release-finalize takes no options');
        result=await gate.finalize(id,async()=>readGithubReleaseMainSha(githubRepository));
      }
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
      const planner=new SshPiPlanner({sshHost,project});
      await planner.preflight();
      const candidates=await listConnectedChatCandidates(browserId);
      const enabled=enableBrowserWatch(store,browserId,candidates);
      result={enabled:true,...enabled,
        note:'Existing connected conversations are baselined, not auto-started. The existing Telegram foreground controller watches newly changed Playwriter-enabled ChatGPT tabs.'};
    } else if (command === 'browser-candidates') {
      result={scope:'selected Playwriter-connected Chrome profile',
        warning:'Only enabled tabs are observable; inventory does not require or imply any tab-group membership.',
        candidates:await listConnectedChatCandidates(option(flags(argv.slice(1)),'browser-id'))};
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
    } else if(command==='browser-pending-evidence'&&id) {
      if(!/^[0-9a-f-]{36}$/i.test(id)||rest.length)
        throw new Error('Provide exactly one bound Mission UUID');
      const mission=store.get(id),receipt=store.chatBrowserTurn(id);
      const linkedUrl=store.chatLink(id),browserId=store.chatBrowserBinding(id);
      const lastReservation=store.events(id).filter(e=>e.type==='chatgpt.browser_reserved').at(-1);
      const rp=lastReservation?.payload as {requestKey?:string;promptSha256?:string}|undefined;
      if(!linkedUrl||!browserId||!receipt||
         !['reserved','uncertain'].includes(receipt.status)||
         receipt.newConversation===true||!lastReservation||
         rp?.requestKey!==receipt.requestKey||rp.promptSha256!==receipt.promptSha256)
        throw new Error('No single linked, original-conversation pending Send with an intact reservation; no browser read attempted');
      const candidates=await withReadOnlyDeadline(
        listConnectedChatCandidates(browserId,linkedUrl));
      const binding=inspectBrowserBinding({missionId:id,missionState:mission.state,
        turnCount:mission.turnCount,linkedUrl,receipt,
        enabledChatCandidates:candidates});
      if(binding.binding!=='exact_connected')
        throw new Error('Original linked browser tab is not uniquely exposed; no browser read attempted');
      const prior=store.events(id).filter(e=>
        ['chatgpt.browser_observed','chatgpt.browser_turn_recovered',
         'chatgpt.browser_rollover_recovered'].includes(e.type)).at(-1);
      const priorPlan=store.piPlan(id);
      const priorAnswerSha=priorPlan?.round===mission.turnCount
        ?priorPlan.responseSha256
        :(prior?.payload as {assistantSha256?:string}|undefined)?.assistantSha256??null;
      const session=await withReadOnlyDeadline(connectChatPage(linkedUrl,{browserId}),
        30_000,late=>late.close());
      result=await withBrowserSession(session,async page=>{
        const first=await withReadOnlyDeadline(inspectChatPage(page,linkedUrl));
        const userSha=await withReadOnlyDeadline(lastVisibleUserPromptSha256(page));
        await new Promise(resolve=>setTimeout(resolve,3000));
        const second=await withReadOnlyDeadline(inspectChatPage(page,linkedUrl));
        const secondUserSha=await withReadOnlyDeadline(lastVisibleUserPromptSha256(page));
        return assessPendingBrowserAnswer({missionId:id,round:mission.turnCount+1,
          reservationEventId:lastReservation.id,
          reservationPromptSha256:receipt.promptSha256,
          latestUserSha256:userSha===secondUserSha?userSha:null,
          lastObservedAnswerSha256:priorAnswerSha,first,second});
      });
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
      result={...m,note:'Original browser request will never be replayed and no answer was credited. PI resume needs a separately verified original checkpoint; merely reconciling an ambiguous Send does not authorize another Send. If no complete answer exists, use a new owner-authorized Goal instead of resetting counters.'};
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
    else if (command === 'browser-retry-pre-send-rollover' && id) {
      const f=flags(rest);
      if(!f['--acknowledge-side-effects']||Object.keys(f).some(
        k=>!['--revision','--acknowledge-side-effects'].includes(k)))
        throw new Error('Explicit acknowledgement and only --revision are required for one-shot pre-Send recovery');
      const revision=Number(option(f,'revision'));
      const m=store.get(id),r=store.chatBrowserTurn(id),url=store.chatLink(id),
        browserId=store.chatBrowserBinding(id),plan=store.piPlan(id);
      if(m.version!==revision||m.state!=='NEEDS_RECONCILIATION'||
        r?.status!=='uncertain'||!r.newConversation||!url||!browserId||
        !plan||plan.round!==m.turnCount)
        throw new Error('No eligible original, uncertain new-chat request at this revision');
      // A Goal-bound Send has immutable private prompt bytes. Never rebuild
      // them from a later, potentially revised PI/Goal instruction.
      const prompt=store.reservedBrowserPrompt(id,r.requestKey)?.prompt;
      if(!prompt||createHash('sha256').update(prompt.trim()).digest('hex')!==r.promptSha256)
        throw new Error('Original private versioned prompt snapshot absent or corrupt; no browser operation');
      const events=store.events(id),prior=events.filter(e=>
        e.type==='chatgpt.browser_observed'&&
        (e.payload as {round?:number}).round===m.turnCount).at(-1);
      const priorKey=(prior?.payload as {requestKey?:string}|undefined)?.requestKey;
      const priorReservation=events.find(e=>e.type==='chatgpt.browser_reserved'&&
        (e.payload as {requestKey?:string}).requestKey===priorKey);
      const expectedUser=(priorReservation?.payload as {promptSha256?:string}|undefined)?.promptSha256;
      const expectedAnswer=(prior?.payload as {assistantSha256?:string}|undefined)?.assistantSha256;
      if(!expectedUser||!expectedAnswer)
        throw new Error('Prior observed source request has no exact original evidence');
      const session=await withReadOnlyDeadline(connectChatPage(url,{browserId}),
        30_000,late=>late.close());
      result=await withBrowserSession(session,async page=>{
        const inspectSource=async()=>{
          const snapshot=await withReadOnlyDeadline(inspectChatPage(page,url));
          const user=await withReadOnlyDeadline(lastVisibleUserPromptSha256(page));
          if(snapshot.generating||!snapshot.composerReady||
            user!==expectedUser||
            createHash('sha256').update(snapshot.lastAssistant).digest('hex')!==expectedAnswer)
            throw new Error('Original source Chrome user/assistant bytes do not match the last observed PI checkpoint');
          return snapshot.lastAssistant;
        };
        const first=await inspectSource();
        await new Promise(resolve=>setTimeout(resolve,2600));
        if(await inspectSource()!==first)
          throw new Error('Source Chrome changed during two independent pre-Send observations');
        // Playwriter can expose only extension-enabled Chrome targets. Any
        // already visible new chat with the same original prompt is a hard
        // reason to stop and use read-only rollover recovery instead.
        const targets=page.context().pages().filter(p=>!p.isClosed());
        for(const candidate of targets){
          if(candidate===page)continue;
          if(candidate.url()==='https://chatgpt.com/'||
            candidate.url()==='https://chatgpt.com'||candidate.url()==='about:blank')
            throw new Error('A possibly unfinished new-chat bootstrap tab exists; inspect it before retry');
          if(candidate.url().startsWith('https://chatgpt.com/c/') &&
            await withReadOnlyDeadline(lastVisibleUserPromptSha256(candidate))===r.promptSha256)
            throw new Error('Original reserved user prompt is already visible in another tab; do not resend');
        }
        // Recheck source immediately before the durable one-shot intent.
        if(await inspectSource()!==first)
          throw new Error('Original source changed immediately before the one-shot intent');
        // Read-only browser bootstrap comes BEFORE the one-shot intent. If
        // network hydration fails again, do not consume the sole authorized
        // Send attempt. Close only this newly created, still-unsent page.
        const newPage=await page.context().newPage();
        let intent:ReturnType<typeof store.authorizePreSendRolloverOnce>;
        try{
          await prepareNewChatOrigin(newPage);
          if(await inspectSource()!==first)
            throw new Error('Original source changed during read-only new-tab bootstrap');
          intent=store.authorizePreSendRolloverOnce(id,revision,{
            originalPromptSha256:r.promptSha256,
            sourcePromptSha256:expectedUser,sourceAnswerSha256:expectedAnswer,
          });
        }catch(error){
          // Page identity is owned by this very invocation; no composer was
          // filled or clicked. Do not touch older/user-created ChatGPT tabs.
          if(!newPage.isClosed())await newPage.close().catch(()=>{});
          throw error;
        }
        // Exactly one Send attempt after the durable intent, reusing the
        // already hydrated owned origin. If any later step fails, keep the
        // original uncertain request and this one-shot intent. An actually
        // sent, uncredited reply needs read-only browser-recover-rollover.
        const output=await submitNewChatTurn(newPage,prompt,undefined,true);
        const latest=await withReadOnlyDeadline(lastVisibleUserPromptSha256(newPage));
        if(latest!==r.promptSha256||output.receipt.generating||
          browserDecision(output.receipt.lastAssistant)==='UNMARKED')
          throw new Error('New-chat response is not independently attributable; original uncertain request preserved');
        const answer=output.receipt.lastAssistant;
        const recovered=store.recoverObservedBrowserRollover(id,revision,{
          requestPromptSha256:r.promptSha256,newChatUrl:output.url,
          assistantSha256:createHash('sha256').update(answer).digest('hex'),
          summary:answer,
        });
        return {missionId:id,state:recovered.state,version:recovered.version,
          observedTurns:recovered.turnCount,intentEventId:intent.intentEventId,
          originalRequestKeyReused:true,originalUncertainEventPreserved:true,
          recoveredAnswerSha256:createHash('sha256').update(answer).digest('hex'),
          note:'One first real Send after proven pre-Send navigation failure, credited to the ORIGINAL reserved request. No duplicate reservation, no second Send. Worker must independently PI-review this reply.'};
      });
    }
    else if(command==='browser-resume-pending-retry'&&id){
      const f=flags(rest);
      if(f['--acknowledge-side-effects']?.[0]!=='true')
        throw new Error('Explicit --acknowledge-side-effects required');
      const revision=Number(option(f,'revision'));
      if(!Number.isSafeInteger(revision)||revision<0)
        throw new Error('Valid Mission revision required');
      const record=store.chatBrowserTurn(id);
      const m=record?.newConversation===true
        ?store.resumeUncertainNewChatRetry(id,revision)
        :store.resumeUncertainExistingChatRetry(id,revision);
      result={missionId:id,revision:m.version,state:m.state,
        stopRequested:m.stopRequested,
        note:'Original request is preserved; only the enrolled Worker may inspect and perform one same-message UI Retry. No Send or Retry was executed by this command.'};
    }
    else if(command==='browser-start-new-chat'&&id){
      const f=flags(rest);
      if(f['--acknowledge-side-effects']?.[0]!=='true')
        throw new Error('Explicit --acknowledge-side-effects required to click the native UI');
      const revision=Number(option(f,'revision'));
      if(!Number.isSafeInteger(revision)||revision<0)
        throw new Error('Valid original Mission revision required');
      const mission=store.get(id),record=store.chatBrowserTurn(id);
      const url=store.chatLink(id),browserId=store.chatBrowserBinding(id);
      if(mission.version!==revision||!mission.stopRequested||
        mission.state!=='NEEDS_RECONCILIATION'||!record||
        record.status!=='uncertain'||record.newConversation===true||
        !url||!browserId)
        throw new Error('Native new-chat recovery needs the original paused, uncertain existing-Chat request');
      const session=await withReadOnlyDeadline(connectChatPage(url,{browserId}),30_000,
        late=>late.close());
      result=await withBrowserSession(session,async page=>{
        const check=async()=>{
          const current=await withReadOnlyDeadline(inspectChatPage(page,url));
          return !current.generating&&current.composerReady&&
            await withReadOnlyDeadline(lastVisibleUserPromptSha256(page))===record.promptSha256&&
            await withReadOnlyDeadline(visibleConversationLengthLimit(page));
        };
        if(!await check())throw new Error('Exact native maximum-length UI or original user prompt not verified');
        await new Promise(resolve=>setTimeout(resolve,1500));
        if(!await check())throw new Error('Maximum-length UI or original request changed during stability check');
        const clicked=await clickConversationLengthStartOnce(page,url,true,
          ()=>store.claimConversationLengthStartIntent(
            id,revision,record.requestKey,record.promptSha256,true));
        if(!clicked)throw new Error('Original native Start new chat button was unavailable or intent already used; do not click twice');
        store.recordConversationLengthStartClicked(id,record.requestKey,record.promptSha256);
        return {missionId:id,originalRequestKey:record.requestKey,
          nativeStartClicked:true,composerSend:false,originalAnswerCredited:false,
          originalReservationPreserved:true,
          note:'Native Start new chat was clicked once. Original uncredited Send remains uncertain and locked; new-chat context and any continued work require separate verified settlement, never an automatic duplicate Send.'};
      });
    }
    else if (command === 'browser-recover-rollover' && id) {
      const f=flags(rest);
      if(!f['--acknowledge-side-effects'])
        throw new Error('Explicit --acknowledge-side-effects is required after reviewing both browser conversations');
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
        const parent=store.piChainParent(id);
        const reconstruct={
          goal:m.goal,acceptance:m.acceptance,sandbox:m.sandbox,workspace:m.workspace,
          nextInstruction:m.nextInstruction,turnCount:m.turnCount,
          missionRequestKey:m.requestKey,reservedRequestKey:record.requestKey,
          sourceAnswer:source.lastAssistant,adopted:store.chatAdoption(id)!==null,
          chainParent:parent!==null,
          piManaged:store.getMeta(`pi.autopilot.enabled.${id}`)==='1',
          piPlan:browserRolloverPiPlan(store,id),
          goalBound:new GoalLedger(store).missionGoalId(id)!==null,
        };
        // New Goal work prompts were snapshot atomically before their Send;
        // render them from the immutable versioned copy, never mutable Goal
        // state. Older compact/legacy reservations have no snapshot and MUST
        // still reconstruct using their original byte-exact, SHA-checked form.
        // This is inspection only: neither path authorizes a new Send/Retry.
        const versioned=store.reservedBrowserPrompt(id,record.requestKey);
        return versioned?.prompt??
          exactReservedRolloverPrompt(reconstruct,record.promptSha256).prompt;
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
    }
    else if (command === 'run' && id) {
      if(store.chatLink(id)) throw new Error('Mission is linked to ChatGPT; use browser control, not a native executor');
      const preflight=await executorPreflight(store,id);
      if(!preflight.ok) throw new Error(preflight.message);
      result = await engine.run(id);
    }
    else if (command === 'pi-resume' && id) {
      const f=flags(rest);
      if(!f['--acknowledge-side-effects'])
        throw new Error('PI autonomous resume needs explicit --acknowledge-side-effects');
      const revision=Number(option(f,'revision'));
      result=store.resumePausedPiCheckpoint(id,revision);
    }
    else if ((command === 'pi-recheck-successor'||command === 'pi-recheck-capacity') && id) {
      const f=flags(rest);
      if(!f['--acknowledge-side-effects'])
        throw new Error('Explicit --acknowledge-side-effects required for PI interruption repair');
      const revision=Number(option(f,'revision'));
      const m=store.get(id),receipt=store.chatBrowserTurn(id);
      const capacity=command==='pi-recheck-capacity';
      const url=store.chatLink(id),browserId=store.chatBrowserBinding(id);
      if(m.version!==revision||m.state!=='PAUSED'||m.stopRequested||
        (!capacity&&m.lastError!==PI_SUCCESSOR_CHECKPOINT_MISMATCH)||
        (capacity&&!m.lastError?.includes('Pi maintenance or a global task is active'))||
        !receipt||!['observed','reconciled'].includes(receipt.status)||
        !url||!browserId||(!capacity&&!store.piChainParent(id))||
        !store.hasVerifiedPiBrowserCheckpoint(id))
        throw new Error('No eligible settled successor false-mismatch interruption at this revision');
      const session=await withReadOnlyDeadline(connectChatPage(url,{browserId}),
        30_000,late=>late.close());
      const independentlyRead=await withBrowserSession(session,async page=>{
        const read=async()=>{
          const snapshot=await withReadOnlyDeadline(inspectChatPage(page,url));
          const promptSha=await withReadOnlyDeadline(lastVisibleUserPromptSha256(page));
          const answerSha=createHash('sha256').update(snapshot.lastAssistant).digest('hex');
          if(snapshot.generating||!snapshot.composerReady||
            !['DONE','NEXT','BLOCKED','HANDOFF'].includes(browserDecision(snapshot.lastAssistant))||
            promptSha!==receipt.promptSha256||answerSha!==receipt.assistantSha256)
            throw new Error('Live successor Chrome does not match the original settled user/answer SHAs');
          return {promptSha,answerSha,answer:snapshot.lastAssistant};
        };
        const first=await read();
        await new Promise(resolve=>setTimeout(resolve,3000));
        const second=await read();
        if(first.answer!==second.answer)
          throw new Error('Live successor answer changed between independent browser reads');
        return {requestPromptSha256:second.promptSha,assistantSha256:second.answerSha};
      });
      const repaired=capacity
        ?store.clearHistoricPiCapacityInterruption(id,revision,independentlyRead)
        :store.clearVerifiedPiSuccessorMismatch(id,revision,independentlyRead);
      result={missionId:id,state:repaired.state,revision:repaired.version,
        round:repaired.turnCount,stopRequested:repaired.stopRequested,
        assistantSha256:independentlyRead.assistantSha256,
        note:capacity?'Original PI capacity interruption revalidated and cleared without Send or PI decision; original Worker must independently reread the settled answer.':
          'One false parent-vs-successor checkpoint interruption cleared. No Send, owner pause release or PI decision. Original Worker must independently re-read the live browser.'};
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
