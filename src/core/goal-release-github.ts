import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {childEnvironment} from './child-env.js';
import {assessGitHubActionsReadback} from './goal-release-probes.js';
import type {ReleaseProbe} from './goal-release.js';

/** Github is the project's publication boundary. The running GMK checkout
 * supplies ONLY the repository identity, never the canonical source SHA.
 * Neither SSH access to AIOS nor a model-provided repo name is required. */
const runtimeCheckout=resolve(fileURLToPath(new URL('../../',import.meta.url)));
const fullSha=/^[a-f0-9]{40}$/;
const codeSteps:Readonly<Record<string,string>>={
  'check':'Run npm run check',
  'privacy-check':'Run npm run privacy-check',
  'test':'Run npm test',
  'build':'Run npm run build',
};
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
 * AIOS worktree. The latter must be inspected separately before code edits. */
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
    '--json','headSha,status,conclusion,url,jobs'];
}
/** Re-read a specific CI run directly from GitHub and verify per-step
 * success. Unlike a model report, the raw GitHub response is hashed into
 * Goal audit. No local/remote code invocation or secret forwarding. */
export function githubReleaseProbe(repository:string,runId:string):ReleaseProbe{
  const args=githubReleaseRunCommand(repository,runId);
  const repo=canonicalGithubRepository(`https://github.com/${repository}`);
  return {source:'github-actions',inspect:async(requirement,targetSha)=>{
    if(!Object.hasOwn(codeSteps,requirement)&&
      !/^ci-(ubuntu|macos|windows)$/.test(requirement))
      throw new Error('GitHub Actions cannot attest this release requirement');
    if(readGithubReleaseMainSha(repo)!==targetSha)
      throw new Error('GitHub release main changed before CI readback');
    const raw=gh(args);
    const observed=assessGitHubActionsReadback(raw,
      requirement.startsWith('ci-')?requirement:'ci-ubuntu',targetSha);
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
