import {createHash} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import type {EvidenceReadback,ReleaseProbe} from './goal-release.js';

/** Readback adapters for WP5 source + GitHub CI gates. The other release
 * gates deliberately require WP6 independent runtime probes: a model's
 * statement that Chrome/GMK succeeded never substitutes for a readback. */
const sha40=/^[a-f0-9]{40}$/;
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
function run(binary:string,args:string[],cwd:string,timeout=30_000):string{
  return execFileSync(binary,args,{cwd,timeout,encoding:'utf8',maxBuffer:16*1024*1024}).trim();
}
/** Refuse uncommitted work, checked-out non-main, or a stale local main.
 * This is not called by mere status/list operations. */
export function readGitMainSha(repository:string):string{
  const cwd=resolve(repository),head=run('git',['rev-parse','HEAD'],cwd);
  if(!sha40.test(head)||run('git',['branch','--show-current'],cwd)!=='main'||
    run('git',['status','--porcelain'],cwd))
    throw new Error('Release Git readback requires a clean, checked-out main');
  const advertised=run('git',['ls-remote','origin','refs/heads/main'],cwd).split(/\s+/)[0];
  if(!advertised||!sha40.test(advertised)||advertised!==head)
    throw new Error('Release Git readback disagrees with origin/main');
  return head;
}
export function localReleaseProbe(input:{
  repository:string;privateEvidenceDirectory:string;
}):ReleaseProbe{
  const repository=resolve(input.repository),dir=resolve(input.privateEvidenceDirectory);
  return {source:'local-command',inspect:async(requirement,targetSha)=>{
    const commands:Record<string,string>={
      check:'check','privacy-check':'privacy-check',test:'test',build:'build',
    };
    const script=commands[requirement];
    if(!script)throw new Error('Unsupported local release gate');
    if(readGitMainSha(repository)!==targetSha)
      throw new Error('Local release test cannot run on a different revision');
    const result=spawnSync('npm',['run',script],{
      cwd:repository,encoding:'utf8',timeout:10*60_000,maxBuffer:32*1024*1024,
      shell:false,
    });
    const log=`revision=${targetSha}\nscript=${script}\nexit=${String(result.status)}\n`+
      `signal=${String(result.signal)}\nstdout:\n${result.stdout??''}\nstderr:\n${result.stderr??''}\n`;
    const proof=sha(log);
    mkdirSync(dir,{recursive:true,mode:0o700});
    const file=join(dir,`${proof}.log`);
    try{writeFileSync(file,log,{flag:'wx',mode:0o600});}
    catch(error){
      if((error as NodeJS.ErrnoException).code!=='EEXIST'||readFileSync(file,'utf8')!==log)
        throw error;
    }
    return {state:result.status===0&&!result.error?'PASS':'FAIL',
      reference:`local-run://${proof}`,proofSha256:proof,
      observedSha:readGitMainSha(repository)} satisfies EvidenceReadback;
  }};
}
interface GitHubRun {
  headSha:string;status:string;conclusion:string;url:string;
  jobs:{name:string;status:string;conclusion:string;
    steps:{name:string;conclusion:string}[]}[];
}
/** GitHub's completed, exact-SHA three-platform workflow is read directly
 * with gh, never inferred from a ChatGPT/PI report or a run number alone. */
export function githubActionsReleaseProbe(repository:string,runId:string):ReleaseProbe{
  if(!/^[1-9][0-9]{4,19}$/.test(runId))throw new Error('Invalid GitHub Actions run id');
  const cwd=resolve(repository);
  return {source:'github-actions',inspect:async(requirement,targetSha)=>{
    if(!/^ci-(ubuntu|macos|windows)$/.test(requirement))
      throw new Error('Unsupported GitHub Actions release gate');
    if(readGitMainSha(cwd)!==targetSha)
      throw new Error('CI release verification requires the exact checked-out main');
    const raw=run('gh',['run','view',runId,'--json',
      'headSha,status,conclusion,url,jobs'],cwd);
    const result=JSON.parse(raw) as GitHubRun;
    if(result.headSha!==targetSha||result.status!=='completed'||
      result.conclusion!=='success'||!/^https:\/\/github\.com\//.test(result.url))
      throw new Error('GitHub Actions run is incomplete, failed or for another SHA');
    const platform=requirement.slice(3);
    const jobs=result.jobs.filter(job=>job.name===`test (${platform}-latest, 24)`);
    if(jobs.length!==1)throw new Error('Missing or duplicate CI platform job');
    const job=jobs[0]!;
    const steps=['Run npm ci','Run npm run privacy-check','Run npm run check',
      'Run npm test','Run npm run build'];
    const matched=steps.every(name=>job.steps.some(s=>s.name===name&&s.conclusion==='success'));
    const successful=job.status==='completed'&&job.conclusion==='success'&&matched;
    return {state:successful?'PASS':'FAIL',reference:result.url,
      proofSha256:sha(raw),observedSha:result.headSha} satisfies EvidenceReadback;
  }};
}
