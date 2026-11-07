import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {remoteReleaseCommand} from '../src/core/goal-release-remote.js';
import {assessGitHubActionsReadback} from '../src/core/goal-release-probes.js';

const config={sshHost:'AIOS-primary',project:'/srv/ai/workspace/projects/mission-relay'};
const SHA='a'.repeat(40);

test('remote release invokes only fixed commands inside the approved AIOS project',()=>{
  assert.equal(remoteReleaseCommand(config,'head'),
    `cd ${config.project} && git rev-parse HEAD`);
  assert.equal(remoteReleaseCommand(config,'origin'),
    `cd ${config.project} && git ls-remote origin refs/heads/main`);
  assert.equal(remoteReleaseCommand(config,'branch'),
    `cd ${config.project} && git branch --show-current`);
  assert.equal(remoteReleaseCommand(config,'status'),
    `cd ${config.project} && git status --porcelain`);
  for(const script of ['check','privacy-check','test','build'])
    assert.equal(remoteReleaseCommand(config,'test',script),
      `cd ${config.project} && npm run ${script}`);
  assert.equal(remoteReleaseCommand(config,'ci','42365396806'),
    `cd ${config.project} && gh run view 42365396806 --json headSha,status,conclusion,url,jobs`);
});

test('remote release refuses injected host, directory, script, run ID and arbitrary command',()=>{
  assert.throws(()=>remoteReleaseCommand({...config,sshHost:'AIOS; echo secret'},'head'),
    /safe host alias/);
  assert.throws(()=>remoteReleaseCommand({...config,project:'/srv/../private'},'status'),
    /absolute project path|specific safe/);
  assert.throws(()=>remoteReleaseCommand({...config,project:'/srv/ai path'},'head'),
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
    const proof=assessGitHubActionsReadback(raw,`ci-${platform}`,SHA);
    assert.equal(proof.state,'PASS');
    assert.equal(proof.observedSha,SHA);
    assert.equal(proof.proofSha256,
      createHash('sha256').update(raw).digest('hex'));
  }
  assert.equal(assessGitHubActionsReadback(ci(SHA,'windows',false),'ci-windows',SHA)
    .state,'FAIL');
  assert.throws(()=>assessGitHubActionsReadback(ci(SHA,'windows'),'ci-ubuntu',SHA),
    /Missing or duplicate/);
  assert.throws(()=>assessGitHubActionsReadback(ci('b'.repeat(40)),'ci-windows',SHA),
    /another SHA/);
  const incomplete=JSON.parse(ci()) as Record<string,unknown>;
  incomplete.status='in_progress';
  assert.throws(()=>assessGitHubActionsReadback(JSON.stringify(incomplete),'ci-windows',SHA),
    /incomplete/);
});
