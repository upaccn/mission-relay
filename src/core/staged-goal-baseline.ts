import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {Store} from './store.js';
import {StagedGoalIntake,STAGED_BASELINE_SOURCES,
  type StageBaselineDimensions} from './staged-goal-intake.js';
import {githubRepositoryForRuntime,readGithubReleaseMainSha,
  githubReleaseProbe} from './goal-release-github.js';
import {verifiedRuntimeProvenance} from './runtime-provenance.js';
import {enrolledTaskStatus} from './goal-release-runtime.js';
import {SshPiPlanner,type PiPlanner} from './pi-planner.js';
import {childEnvironment} from './child-env.js';
import {listConnectedChatCandidates} from '../plugins/chatgpt-browser.js';
import {inspectBrowserBinding} from './browser-binding-diagnostic.js';
import {stateHome} from './paths.js';

const sha=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Read-only, first-party seven-source probe: no caller-supplied PASS flags,
 * arbitrary JSON receipts, browser navigation, PI model override or Send.
 * Store the redacted source observations in private files; the Goal audit
 * contains only their digests and the combined baseline hash. */
export async function collectStagedGoalBaseline(store:Store,goalId:string,
  planner:PiPlanner,entry=process.argv[1]):Promise<StageBaselineDimensions>{
  if(process.platform!=='win32'||!entry||!(planner instanceof SshPiPlanner))
    throw new Error('Seven-dimensional baseline requires original GMK Worker and configured operator-managed host PI');
  const start=new StagedGoalIntake(store).verifyReadOnly(goalId);
  if(!start.unchanged||start.activated||start.missionState!=='PAUSED'||
    start.turnCount!==0||start.browserReservations!==0||start.parentId!==null)
    throw new Error('Cannot attest a nonzero or altered staged Goal');
  const record=start.record,channel=store.channelStatus('telegram');
  if(!channel.pollerPresent||!channel.runtimeProvenance||channel.drainRequested||
    channel.transportHealth!=='healthy')
    throw new Error('Original single Telegram Worker lease is not healthy');

  const local=verifiedRuntimeProvenance(entry);
  const worker=channel.runtimeProvenance,task=enrolledTaskStatus(entry);
  if(JSON.stringify(local)!==JSON.stringify({
    sourceSha:worker.sourceSha,compiledTreeSha256:worker.compiledTreeSha256,
    cliSha256:worker.cliSha256,manifestSha256:worker.manifestSha256,
    fileCount:worker.fileCount})||worker.pid!==channel.pollerPid||
    !task.installed||!task.taskVerified||task.taskState!=='Running'||
    !task.recoverySchedule||!task.pollerPresent||task.pollerPid!==worker.pid)
    throw new Error('Installed source, compiled Worker and enrolled task disagree');

  const repository=githubRepositoryForRuntime(),main=readGithubReleaseMainSha(repository);
  if(main!==local.sourceSha)
    throw new Error('GMK source is not the independently verified GitHub main');
  const runList=execFileSync('gh',['run','list','--repo',repository,'--branch','main',
    '--event','push','--limit','10','--json','databaseId,headSha,status,conclusion'],{
    encoding:'utf8',timeout:35_000,windowsHide:true,maxBuffer:128*1024,
    env:childEnvironment('check'),
  });
  const runs=JSON.parse(runList) as Array<{
    databaseId:number;headSha:string;status:string;conclusion:string;
  }>;
  const matches=runs.filter(run=>run.headSha===main&&run.status==='completed'&&
    run.conclusion==='success'&&Number.isSafeInteger(run.databaseId));
  if(matches.length!==1)
    throw new Error('No unique completed push/main CI run for the actual Worker SHA');
  const runId=String(matches[0]!.databaseId);
  const ciProbe=githubReleaseProbe(repository,runId);
  const jobs=await Promise.all(['ci-ubuntu','ci-windows','ci-macos'].map(
    requirement=>ciProbe.inspect(requirement,main)));
  if(jobs.some(j=>j.state!=='PASS'||j.observedSha!==main))
    throw new Error('Exact-SHA three-platform GitHub CI does not qualify the Worker');

  const paths=store.db.prepare('PRAGMA database_list').all() as
    {name:string;file:string}[];
  const file=paths.find(p=>p.name==='main')?.file;
  if(!file)throw new Error('Independent SQLite file path unavailable');
  const readOnly=new Store(file,{readOnly:true});
  let sqlite:unknown;
  try{
    readOnly.db.exec('BEGIN');
    const all=(sql:string)=>readOnly.db.prepare(sql).all();
    const integrity=all('PRAGMA integrity_check') as {integrity_check:string}[];
    const foreignKeys=all('PRAGMA foreign_key_check');
    if(integrity.length!==1||integrity[0]?.integrity_check!=='ok'||foreignKeys.length)
      throw new Error('GMK SQLite integrity or foreign key readback failed');
    sqlite={integrity:'ok',foreignKeyViolations:0,
      goals:all('SELECT id,status FROM goals ORDER BY id'),
      missions:all('SELECT id,state,turn_count,stop_requested FROM missions ORDER BY id'),
      originalMissionEventsSha256:sha(all('SELECT * FROM events ORDER BY id')),
      originalGoalEventsSha256:sha(all('SELECT * FROM goal_events ORDER BY id')),
      originalRequestEvidenceSha256:sha(all(
        "SELECT mission_id,payload_json FROM events WHERE type='chatgpt.browser_reserved' ORDER BY id")),
      maxEventId:readOnly.maxEventId(),
    };
    readOnly.db.exec('COMMIT');
  }catch(e){readOnly.db.exec('ROLLBACK');throw e;}
  finally{readOnly.close();}

  const anchorUrl=store.chatLink(record.anchorId);
  if(!anchorUrl||!record.browserId||
    store.chatBrowserBinding(record.anchorId)!==record.browserId)
    throw new Error('Original Chrome anchor custody changed');
  const candidates=await listConnectedChatCandidates(record.browserId,anchorUrl);
  const original=store.get(record.anchorId);
  const chrome=inspectBrowserBinding({missionId:record.anchorId,
    missionState:original.state,turnCount:original.turnCount,
    linkedUrl:anchorUrl,receipt:store.chatBrowserTurn(record.anchorId),
    enabledChatCandidates:candidates});
  if(chrome.binding!=='exact_connected'||chrome.matchingLinkedTabs!==1)
    throw new Error('Approved source Chrome tab lacks unique physical read-only custody');
  await planner.preflight();
  const policy=planner.invocationPolicy();
  if(policy.modelOverride!==false||policy.providerOverride!==false||
    policy.thinkingOverride!==false||!/^[a-f0-9]{64}$/.test(policy.argvSha256))
    throw new Error('operator-managed host PI default inference invocation was overridden');
  if(readGithubReleaseMainSha(repository)!==main||
    JSON.stringify(store.channelStatus('telegram').runtimeProvenance)!==JSON.stringify(worker)||
    new StagedGoalIntake(store).verifyReadOnly(goalId).currentSha256!==start.currentSha256)
    throw new Error('Seven-dimensional readbacks changed during observation');

  const observed={controller:{goalId,missionId:record.missionId,
    stageSha256:start.currentSha256,ownerId:record.ownerId,
    hold:true,turns:start.turnCount,noReservations:start.browserReservations===0},
  git:{repository,main,installedSha:local.sourceSha},
  ci:{runId,targetSha:main,jobs},
  worker:{local,worker,task:{installed:task.installed,taskVerified:task.taskVerified,
    taskState:task.taskState,recoverySchedule:task.recoverySchedule,pollerPid:task.pollerPid}},
  sqlite,chrome:{...chrome,anchorId:record.anchorId},
  pi:{doctorOk:true,argvSha256:policy.argvSha256,modelOverride:false,
    providerOverride:false,thinkingOverride:false}};
  const dimensions=Object.fromEntries(Object.entries(STAGED_BASELINE_SOURCES)
    .map(([key,source])=>[key,{source,
      evidenceSha256:sha(observed[key as keyof typeof observed])}])) as StageBaselineDimensions;
  const manifest={format:1,goalId,stageSha256:start.currentSha256,
    observedAt:new Date().toISOString(),observed,dimensions};
  const body=JSON.stringify(manifest),proof=sha(manifest);
  const dir=resolve(join(stateHome(),'stage-baseline-evidence'));
  mkdirSync(dir,{recursive:true,mode:0o700});
  const target=join(dir,`${proof}.json`);
  try{writeFileSync(target,body,{flag:'wx',mode:0o600});}
  catch(error){
    if((error as NodeJS.ErrnoException).code!=='EEXIST'||
      readFileSync(target,'utf8')!==body)throw error;
  }
  return dimensions;
}
