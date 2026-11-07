import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalGithubRepository,githubReleaseRunCommand,
  githubReleaseProbe} from '../src/core/goal-release-github.js';

test('GitHub release repository must come from one canonical origin',()=>{
  assert.equal(canonicalGithubRepository('https://github.com/upaccn/mission-relay.git'),
    'upaccn/mission-relay');
  assert.equal(canonicalGithubRepository('git@github.com:upaccn/mission-relay.git'),
    'upaccn/mission-relay');
  for(const invalid of [
    'https://evil.example/upaccn/mission-relay.git',
    'https://github.com/upaccn/mission-relay.git#fragment',
    'https://github.com/upaccn/mission-relay/other',
    'https://github.com/upaccn/../other',
    'file:///srv/repo','https://github.com/one',
    'https://github.com/upaccn/mission-relay?token=x',
  ])assert.throws(()=>canonicalGithubRepository(invalid),/origin|canonical/);
});

test('GitHub readback receives fixed read-only args and rejects an untrusted run id',()=>{
  assert.deepEqual(githubReleaseRunCommand('upaccn/mission-relay','42366651487'),
    ['run','view','42366651487','--repo','upaccn/mission-relay',
      '--json','databaseId,workflowName,event,headBranch,headSha,status,conclusion,url,jobs']);
  for(const bad of ['0','-1','abc','42366; rm -rf /','42366651487 --repo other']){
    assert.throws(()=>githubReleaseRunCommand('upaccn/mission-relay',bad),
      /Invalid GitHub Actions release run id/);
  }
  assert.throws(()=>githubReleaseProbe('other/../../repo','42366651487'),
    /canonical/);
});

test('unsupported non-source release requirements fail before any gh call',async()=>{
  const probe=githubReleaseProbe('upaccn/mission-relay','42366651487');
  assert.equal(probe.source,'github-actions');
  for(const requirement of ['gmk-production-readback','maintenance-resume',
    'relay-tab-retirement','mission-32-successor','chrome-5-to-6',
    'criterion:forged']){
    await assert.rejects(probe.inspect(requirement,'a'.repeat(40)),
      /cannot attest/);
  }
});
