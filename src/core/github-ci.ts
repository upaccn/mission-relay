import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {childEnvironment} from './child-env.js';

/** Exact-SHA GitHub Actions readback used by `software-release-status`. */
export interface CiReadback {state:'PASS'|'FAIL';reference:string;proofSha256:string;observedSha:string}
export interface CiProbe {source:string;inspect:(requirement:string,targetSha:string)=>Promise<CiReadback>}
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
interface GitHubRun {
  databaseId:number;workflowName:string;event:string;headBranch:string;
  headSha:string;status:string;conclusion:string;url:string;
  jobs:{name:string;status:string;conclusion:string;
    steps:{name:string;conclusion:string}[]}[];
}
export function assessGitHubActionsReadback(raw:string,requirement:string,
  targetSha:string,approvedRepository:string):CiReadback{
  if(!/^ci-(ubuntu|macos|windows)$/.test(requirement))
    throw new Error('Unsupported GitHub Actions release gate');
  if(!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(approvedRepository)||
    approvedRepository.split('/').some(part=>part==='.'||part==='..'))
    throw new Error('Approved GitHub release repository identity is invalid');
  const result=JSON.parse(raw) as GitHubRun;
  if(result.headSha!==targetSha||result.status!=='completed'||
    result.conclusion!=='success'||!/^https:\/\/github\.com\//.test(result.url))
    throw new Error('GitHub Actions run is incomplete, failed or for another SHA');
  // An arbitrary workflow_dispatch or PR workflow can run a job with the
  // same name and steps. Only the published push CI on main is release proof.
  if(result.workflowName!=='CI'||result.event!=='push'||
    result.headBranch!=='main'||!Number.isSafeInteger(result.databaseId)||
    result.databaseId<=0||
    !result.url.endsWith(`/actions/runs/${result.databaseId}`))
    throw new Error('GitHub Actions release workflow provenance is invalid');
  if(result.url!==`https://github.com/${approvedRepository}/actions/runs/${result.databaseId}`)
    throw new Error('GitHub Actions run is for a different release repository');
  const platform=requirement.slice(3);
  const jobs=result.jobs.filter(job=>job.name===`test (${platform}-latest, 24)`);
  if(jobs.length!==1)throw new Error('Missing or duplicate CI platform job');
  const job=jobs[0]!;
  const steps=['Run npm ci','Run npm run privacy-check','Run npm run check',
    'Run npm test','Run npm run build'];
  const matched=steps.every(name=>job.steps.filter(s=>s.name===name&&s.conclusion==='success').length===1&&
    job.steps.filter(s=>s.name===name).length===1);
  const successful=job.status==='completed'&&job.conclusion==='success'&&matched;
  return {state:successful?'PASS':'FAIL',reference:result.url,
    proofSha256:sha(raw),observedSha:result.headSha};
}
/** Github is the project's publication boundary. The running GMK checkout
 * supplies ONLY the repository identity, never the canonical source SHA.
 * Neither SSH access to operator-managed host nor a model-provided repo name is required. */
const runtimeCheckout=resolve(fileURLToPath(new URL('../../',import.meta.url)));
const fullSha=/^[a-f0-9]{40}$/;
function environment():Record<string,string>{
  const env=childEnvironment('check');
  // The GitHub CLI discovers the existing interactive credential store itself.
  // Never pass Telegram, PI or other unrelated application tokens to gh.
  if(process.platform==='win32'&&process.env.ProgramData)
    env.ProgramData=process.env.ProgramData;
  return env;
}
function git(args:string[],cwd:string):string{
  return execFileSync('git',args,{cwd,encoding:'utf8',timeout:15_000,
    maxBuffer:128_000,windowsHide:true,env:environment()}).trim();
}
function gh(args:string[]):string{
  return execFileSync('gh',args,{encoding:'utf8',timeout:35_000,
    maxBuffer:8*1024*1024,windowsHide:true,env:environment()}).trim();
}
export function canonicalGithubRepository(origin:string):string{
  let slug:string;
  if(origin.startsWith('https://github.com/'))
    slug=origin.slice('https://github.com/'.length);
  else if(origin.startsWith('git@github.com:'))
    slug=origin.slice('git@github.com:'.length);
  else throw new Error('Release repository origin must be GitHub.com');
  if(slug.endsWith('.git'))slug=slug.slice(0,-4);
  if(!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}\/[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(slug)||
    slug.split('/').some(part=>part==='.'||part==='..'))
    throw new Error('Release repository origin is not a canonical GitHub repository');
  return slug;
}
export function githubRepositoryForRuntime(checkout=runtimeCheckout):string{
  return canonicalGithubRepository(git(['remote','get-url','origin'],checkout));
}
/** This verifies the public GitHub release boundary, NOT an inaccessible
 * operator-managed host worktree. The latter must be inspected separately before code edits. */
export function readGithubReleaseMainSha(repository:string):string{
  const repo=canonicalGithubRepository(`https://github.com/${repository}`);
  const actual=gh(['api',`repos/${repo}/commits/main`,'--jq','.sha']);
  if(!fullSha.test(actual))
    throw new Error('GitHub main readback missing an exact commit SHA');
  return actual;
}
export function githubReleaseRunCommand(repository:string,runId:string):string[]{
  const repo=canonicalGithubRepository(`https://github.com/${repository}`);
  if(!/^[1-9][0-9]{4,19}$/.test(runId))
    throw new Error('Invalid GitHub Actions release run id');
  return ['run','view',runId,'--repo',repo,
    '--json','databaseId,workflowName,event,headBranch,headSha,status,conclusion,url,jobs'];
}
/** Re-read a specific CI run directly from GitHub and verify per-step
 * success. Unlike a model report, the raw GitHub response is hashed into
 * the release report. No local/remote code invocation or secret forwarding. */
export function githubReleaseProbe(repository:string,runId:string):CiProbe{
  const args=githubReleaseRunCommand(repository,runId);
  const repo=canonicalGithubRepository(`https://github.com/${repository}`);
  return {source:'github-actions',inspect:async(requirement,targetSha)=>{
    if(!/^ci-(ubuntu|macos|windows)$/.test(requirement))
      throw new Error('GitHub Actions cannot attest this release requirement');
    if(readGithubReleaseMainSha(repo)!==targetSha)
      throw new Error('GitHub release main changed before CI readback');
    const raw=gh(args);
    const observed=assessGitHubActionsReadback(raw,
      requirement,targetSha,repo);
    const expectedUrl=`https://github.com/${repo}/actions/runs/${runId}`;
    if(observed.reference!==expectedUrl)
      throw new Error('CI run does not belong to the approved GitHub release repository');
    if(readGithubReleaseMainSha(repo)!==targetSha)
      throw new Error('GitHub release main changed during CI readback');
    // Each source gate is attested by a real, successful CI workflow step,
    // validated above along with all other mandatory workflow steps.
    return observed;
  }};
}
