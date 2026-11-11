import {spawnSync} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {childEnvironment} from './child-env.js';
import {validatePictlRemoteConfig,type PictlRemoteConfig} from './pi-planner.js';
import {assessGitHubActionsReadback} from './goal-release-probes.js';
import {canonicalGithubRepository} from './goal-release-github.js';
import type {EvidenceReadback,ReleaseProbe} from './goal-release.js';

/** GMK runs the authoritative private Goal SQLite. The approved code
 * workspace is on operator-managed host, NOT a Windows-local checkout. Reuse its existing
 * SSH alias without copying credentials or creating another code authority. */
type CommandResult={status:number|null;stdout:string;stderr:string;error?:Error};
export interface RemoteWorkTestResult {
  stdout:string;stderr:string;exit:number;
  execution:{executor:'approved-operator-ssh';sessionId:string;
    remoteHostAlias:string;remoteProject:string;remoteHostname:string;shellPid:number;
    commandSha256:string;sourceSha:string;testFile:string;
    startedAt:string;finishedAt:string};
}
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const commit=/^[a-f0-9]{40}$/;
const scripts=new Set(['check','privacy-check','test','build']);
const approvedTestFile=/^tests\/[a-z0-9][a-z0-9-]{0,99}\.test\.ts$/;
/** A release-reviewed test identifier is never interpolated as a shell path
 * unless it is a strict basename inside the tracked tests directory. */
export function approvedWorkTestPath(relative:string):string{
  if(!approvedTestFile.test(relative))throw new Error('Unapproved release test source path');
  return relative;
}

/** Only fixed command fragments and a validated operator-owned remote
 * directory may be sent through the SSH remote shell; no model-supplied
 * command, PATH override, URL or arbitrary shell argument is accepted. */
export function remoteReleaseCommand(config:PictlRemoteConfig,operation:
  'head'|'branch'|'status'|'origin'|'repo'|'test'|'ci'|'work-test',
  argument?:string,sessionId?:string):string{
  const remote=validatePictlRemoteConfig(config);
  const fixed:Record<'head'|'branch'|'status'|'origin'|'repo',string>={
    head:'git rev-parse HEAD',
    branch:'git branch --show-current',
    status:'git status --porcelain',
    origin:'git ls-remote origin refs/heads/main',
    repo:'git remote get-url origin',
  };
  let command:string;
  if(operation==='test'){
    if(!argument||!scripts.has(argument))throw new Error('Unapproved release test script');
    command=`npm run ${argument}`;
  }else if(operation==='work-test'){
    if(!argument)throw new Error('Missing independently selected test file');
    const file=approvedWorkTestPath(argument);
    if(!sessionId||!/^[a-f0-9]{32}$/.test(sessionId))
      throw new Error('Remote test execution requires a fresh bounded session identity');
    // An authenticated SSH shell emits the session/host/PID BEFORE the test.
    // The exact same nonce must be returned in original stderr; TAP text alone
    // cannot create an independent execution receipt.
    command=`git ls-files --error-unmatch ${file} >/dev/null && `+
      `printf 'MR_WORK_TEST_SESSION_V1\\t%s\\t%s\\t%s\\n' ${sessionId} "$(hostname)" "$$" >&2 && `+
      `node --import tsx --test --test-reporter=tap ${file}`;
  }else if(operation==='ci'){
    if(!argument||!/^[1-9][0-9]{4,19}$/.test(argument))
      throw new Error('Invalid GitHub Actions run id');
    command=`gh run view ${argument} --json databaseId,workflowName,event,headBranch,headSha,status,conclusion,url,jobs`;
  }else command=fixed[operation];
  return `cd ${remote.project} && ${command}`;
}

function ssh(config:PictlRemoteConfig,operation:
  'head'|'branch'|'status'|'origin'|'repo'|'test'|'ci'|'work-test',
  argument?:string,sessionId?:string):CommandResult{
  const {sshHost}=validatePictlRemoteConfig(config);
  const command=remoteReleaseCommand(config,operation,argument,sessionId);
  const env=childEnvironment('check');
  if(process.env.SSH_AUTH_SOCK)env.SSH_AUTH_SOCK=process.env.SSH_AUTH_SOCK;
  if(process.platform==='win32'&&process.env.ProgramData)
    env.ProgramData=process.env.ProgramData;
  const result=spawnSync('ssh',['-T','-o','BatchMode=yes','-o',
    'ConnectTimeout=8',sshHost,command],{
      shell:false,windowsHide:true,env,encoding:'utf8',
      timeout:['test','work-test'].includes(operation)?10*60_000:30_000,maxBuffer:32*1024*1024,
  });
  return {status:result.status,stdout:result.stdout??'',
    // Never propagate arbitrary remote stderr to an operator/Telegram log.
    stderr:result.stderr??'',error:result.error};
}
function checked(config:PictlRemoteConfig,operation:
  'head'|'branch'|'status'|'origin'|'repo'|'ci',argument?:string):string{
  const result=ssh(config,operation,argument);
  if(result.error||result.status!==0){
    if(/permission denied/i.test(result.stderr))
      throw new Error('Approved SSH identity cannot read the operator-managed host source directory; no privilege change attempted');
    throw new Error(`operator-managed host release ${operation} readback unavailable (SSH status ${result.status}); no evidence recorded`);
  }
  return result.stdout.trim();
}
/** Independent, repeated local+remote comparison. A dirty checkout, wrong
 * branch, offline SSH transport or unverified origin is a hard failure. */
export function readRemoteGitMainSha(config:PictlRemoteConfig):string{
  const head=checked(config,'head');
  if(!commit.test(head)||checked(config,'branch')!=='main'||
    checked(config,'status')!=='')
    throw new Error('Remote release checkout is dirty, not on main or has an invalid HEAD');
  const origin=checked(config,'origin').split(/\s+/)[0];
  if(!origin||!commit.test(origin)||origin!==head)
    throw new Error('Remote operator-managed host HEAD and GitHub origin/main differ');
  return head;
}
function originalLog(directory:string,log:string):string{
  const proof=sha(log),dir=resolve(directory);
  mkdirSync(dir,{recursive:true,mode:0o700});
  const file=join(dir,`${proof}.log`);
  try{writeFileSync(file,log,{flag:'wx',mode:0o600});}
  catch(error){
    if((error as NodeJS.ErrnoException).code!=='EEXIST'||
      readFileSync(file,'utf8')!==log)throw error;
  }
  return proof;
}
/** Fixed deterministic checks run on the ONE approved operator-managed host source checkout.
 * The private GMK evidence log contains the original stdout/stderr and exit
 * status, never a model summary. Only the same target SHA can be credited. */
export function remoteReleaseProbe(config:PictlRemoteConfig,
  privateEvidenceDirectory:string):ReleaseProbe{
  const remote=validatePictlRemoteConfig(config);
  return {source:'local-command',inspect:async(requirement,targetSha)=>{
    if(!scripts.has(requirement))throw new Error('Unsupported release check script');
    if(readRemoteGitMainSha(remote)!==targetSha)
      throw new Error('Remote release probe differs from current approved main');
    const observed=ssh(remote,'test',requirement);
    // SSH 255 and locally failed spawns are NOT a failed test receipt: the
    // command might never have run on operator-managed host at all.
    if(observed.error||observed.status===null||observed.status===255)
      throw new Error('Remote test transport was uncertain; no evidence recorded');
    const after=readRemoteGitMainSha(remote);
    if(after!==targetSha)throw new Error('operator-managed host main changed during release test');
    const log=`revision=${targetSha}\nscript=${requirement}\nexit=${observed.status}\n`+
      `stdout:\n${observed.stdout}\nstderr:\n${observed.stderr}\n`;
    const proof=originalLog(privateEvidenceDirectory,log);
    return {state:observed.status===0?'PASS':'FAIL',reference:`remote-run://${proof}`,
      proofSha256:proof,observedSha:after} satisfies EvidenceReadback;
  }};
}
export function remoteActionsReleaseProbe(config:PictlRemoteConfig,
  runId:string):ReleaseProbe{
  const remote=validatePictlRemoteConfig(config);
  return {source:'github-actions',inspect:async(requirement,targetSha)=>{
    if(readRemoteGitMainSha(remote)!==targetSha)
      throw new Error('Remote CI readback differs from current approved main');
    const repo=canonicalGithubRepository(checked(remote,'repo'));
    const raw=checked(remote,'ci',runId);
    const result=assessGitHubActionsReadback(raw,requirement,targetSha,repo);
    if(readRemoteGitMainSha(remote)!==targetSha)
      throw new Error('operator-managed host main changed during release CI readback');
    return result;
  }};
}

/** Execute one release-reviewed tracked test file in the ONE operator-managed host source
 * checkout. No model-defined commands or new process authority on GMK. */
export function independentlyRunRemoteWorkTest(config:PictlRemoteConfig,
  targetSha:string,testFile:string):RemoteWorkTestResult{
  const file=approvedWorkTestPath(testFile);
  if(readRemoteGitMainSha(config)!==targetSha)
    throw new Error('Independent work test target differs from approved operator-managed host main');
  const sessionId=randomBytes(16).toString('hex');
  const command=remoteReleaseCommand(config,'work-test',file,sessionId);
  const startedAt=new Date().toISOString();
  const result=ssh(config,'work-test',file,sessionId);
  const finishedAt=new Date().toISOString();
  if(result.error||result.status===null||result.status===255)
    throw new Error('Independent work test transport is uncertain; cannot claim PASS');
  const marker=result.stderr.split(/\r?\n/)
    .filter(line=>line.startsWith('MR_WORK_TEST_SESSION_V1\t'));
  const match=marker.length===1?
    /^MR_WORK_TEST_SESSION_V1\t([a-f0-9]{32})\t([a-zA-Z0-9._-]{1,255})\t([1-9][0-9]{0,9})$/.exec(marker[0]!):null;
  if(!match||match[1]!==sessionId||!Number.isSafeInteger(Number(match[3])))
    throw new Error('Remote test lacks its unique authenticated executor session');
  if(readRemoteGitMainSha(config)!==targetSha)
    throw new Error('operator-managed host main changed while independently testing this work criterion');
  return {stdout:result.stdout,stderr:result.stderr,exit:result.status,
    execution:{executor:'approved-operator-ssh',sessionId,
      remoteHostAlias:validatePictlRemoteConfig(config).sshHost,
      remoteProject:validatePictlRemoteConfig(config).project,
      remoteHostname:match[2]!,shellPid:Number(match[3]),
      commandSha256:sha(command),sourceSha:targetSha,testFile:file,
      startedAt,finishedAt}};
}
