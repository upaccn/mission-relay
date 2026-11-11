import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {remoteReleaseCommand} from '../src/core/goal-release-remote.js';
import {assessGitHubActionsReadback} from '../src/core/goal-release-probes.js';

const config={sshHost:'operator-primary',project:'/srv/projects/mission-relay'};
const SHA='a'.repeat(40);
const REPO='upaccn/mission-relay';

test('remote release invokes only fixed commands inside the approved operator-managed host project',()=>{
  assert.equal(remoteReleaseCommand(config,'head'),
    `cd ${config.project} && git rev-parse HEAD`);
  assert.equal(remoteReleaseCommand(config,'origin'),
    `cd ${config.project} && git ls-remote origin refs/heads/main`);
  assert.equal(remoteReleaseCommand(config,'repo'),
    `cd ${config.project} && git remote get-url origin`);
  assert.equal(remoteReleaseCommand(config,'branch'),
    `cd ${config.project} && git branch --show-current`);
  assert.equal(remoteReleaseCommand(config,'status'),
    `cd ${config.project} && git status --porcelain`);
  for(const script of ['check','privacy-check','test','build'])
    assert.equal(remoteReleaseCommand(config,'test',script),
      `cd ${config.project} && npm run ${script}`);
  assert.equal(remoteReleaseCommand(config,'ci','42365396806'),
    `cd ${config.project} && gh run view 42365396806 --json databaseId,workflowName,event,headBranch,headSha,status,conclusion,url,jobs`);
});

test('remote release refuses injected host, directory, script, run ID and arbitrary command',()=>{
  assert.throws(()=>remoteReleaseCommand({...config,sshHost:'operator-managed host; echo secret'},'head'),
    /safe host alias/);
  assert.throws(()=>remoteReleaseCommand({...config,project:'/srv/../private'},'status'),
    /absolute project path|specific safe/);
  assert.throws(()=>remoteReleaseCommand({...config,project:'/srv/invalid path'},'head'),
    /absolute project path|specific safe/);
  for(const script of ['test;curl bad','pretest','--help','','build --silent']){
    assert.throws(()=>remoteReleaseCommand(config,'test',script),/Unapproved/);
  }
  for(const run of ['42365396806;echo x','-1','0','','abc']){
    assert.throws(()=>remoteReleaseCommand(config,'ci',run),/Invalid GitHub Actions run/);
  }
});

const stepNames=['Run npm ci','Run npm run privacy-check','Run npm run check',
  'Run npm test','Run npm run build'];
function ci(sha=SHA,platform='windows',all=true):string{
  return JSON.stringify({
    databaseId:42365396806,workflowName:'CI',event:'push',headBranch:'main',
    headSha:sha,status:'completed',conclusion:'success',
    url:'https://github.com/upaccn/mission-relay/actions/runs/42365396806',
    jobs:[{
      name:`test (${platform}-latest, 24)`,status:'completed',conclusion:'success',
      steps:stepNames.map((name,index)=>({name,
        conclusion:!all&&index===3?'failure':'success'})),
    }],
  });
}
test('remote CI readback must match the exact commit, platform and required steps',()=>{
  for(const platform of ['windows','macos','ubuntu']){
    const raw=ci(SHA,platform);
    const proof=assessGitHubActionsReadback(raw,`ci-${platform}`,SHA,REPO);
    assert.equal(proof.state,'PASS');
    assert.equal(proof.observedSha,SHA);
    assert.equal(proof.proofSha256,
      createHash('sha256').update(raw).digest('hex'));
  }
  assert.equal(assessGitHubActionsReadback(ci(SHA,'windows',false),'ci-windows',SHA,REPO)
    .state,'FAIL');
  assert.throws(()=>assessGitHubActionsReadback(ci(SHA,'windows'),'ci-ubuntu',SHA,REPO),
    /Missing or duplicate/);
  assert.throws(()=>assessGitHubActionsReadback(ci('b'.repeat(40)),'ci-windows',SHA,REPO),
    /another SHA/);
  const incomplete=JSON.parse(ci()) as Record<string,unknown>;
  incomplete.status='in_progress';
  assert.throws(()=>assessGitHubActionsReadback(JSON.stringify(incomplete),'ci-windows',SHA,REPO),
    /incomplete/);
});

test('other workflows, manual/PR runs, foreign branches and run identities cannot attest release',()=>{
  const changes:Record<string,unknown>={
    workflowName:'Other workflow',event:'workflow_dispatch',headBranch:'feature',
    databaseId:42365396807,
    url:'https://github.com/upaccn/mission-relay/actions/runs/42365396807',
  };
  for(const [key,value] of Object.entries(changes)){
    const altered=JSON.parse(ci()) as Record<string,unknown>;
    altered[key]=value;
    assert.throws(()=>assessGitHubActionsReadback(JSON.stringify(altered),'ci-windows',SHA,REPO),
      /provenance/,key);
  }
  const duplicate=JSON.parse(ci()) as {jobs:{steps:{name:string;conclusion:string}[]}[]};
  duplicate.jobs[0]!.steps.push({...duplicate.jobs[0]!.steps[0]!});
  assert.equal(assessGitHubActionsReadback(JSON.stringify(duplicate),'ci-windows',SHA,REPO).state,
    'FAIL');
});

test('CI readback cannot borrow a foreign repository even with identical SHA and steps',()=>{
  const raw=ci();
  const foreign=JSON.parse(raw) as {url:string};
  foreign.url='https://github.com/unrelated/repo/actions/runs/42365396806';
  assert.throws(()=>assessGitHubActionsReadback(JSON.stringify(foreign),
    'ci-windows',SHA,REPO),/different release repository/);
  assert.throws(()=>assessGitHubActionsReadback(raw,'ci-windows',SHA,
    'unrelated/repo'),/different release repository/);
  for(const invalid of ['', '../repo','owner/../repo','owner//repo']){
    assert.throws(()=>assessGitHubActionsReadback(raw,'ci-windows',SHA,invalid),
      /repository identity is invalid/);
  }
});

test('incomplete, missing or duplicated mandatory step cannot be credited by the CI validator',()=>{
  for(const platform of ['ubuntu','macos','windows']){
    for(const badName of stepNames){
      const missing=JSON.parse(ci(SHA,platform)) as {
        jobs:{steps:{name:string;conclusion:string}[]}[];
      };
      missing.jobs[0]!.steps=missing.jobs[0]!.steps.filter(s=>s.name!==badName);
      assert.equal(assessGitHubActionsReadback(JSON.stringify(missing),
        `ci-${platform}`,SHA,REPO).state,'FAIL',`${platform} missing ${badName}`);
      const duplicate=JSON.parse(ci(SHA,platform)) as typeof missing;
      duplicate.jobs[0]!.steps.push({name:badName,conclusion:'success'});
      assert.equal(assessGitHubActionsReadback(JSON.stringify(duplicate),
        `ci-${platform}`,SHA,REPO).state,'FAIL',`${platform} duplicate ${badName}`);
    }
  }
});
