import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectSoftwareReleaseCandidate} from '../src/core/software-release.js';
import type {ReleaseProbe} from '../src/core/goal-release.js';

const SHA='a'.repeat(40),OTHER='b'.repeat(40);
const digest='c'.repeat(64);

test('source release qualification requires exact CI on all platforms but no Goal',async()=>{
  const visited:string[]=[];
  const probe:ReleaseProbe={source:'github-actions',inspect:async(req,sha)=>{
    visited.push(req);
    return {state:'PASS',observedSha:sha,
      reference:'https://github.com/example/relay/actions/runs/12345',
      proofSha256:digest};
  }};
  let reads=0;
  const result=await inspectSoftwareReleaseCandidate('example/relay',SHA,'12345',
    ()=>{reads++;return SHA;},()=>probe);
  assert.deepEqual(visited,['ci-ubuntu','ci-macos','ci-windows']);
  assert.equal(reads,2);
  assert.equal(result.qualified,true);
  assert.equal(result.productionVerified,false);
  assert.equal(result.goalAcceptanceRequired,false);
  assert.equal(result.platformChecks.length,3);
});

test('source qualification fails closed for a wrong SHA, invalid run, failed job or moving main',async()=>{
  const valid:ReleaseProbe={source:'github-actions',inspect:async(req,sha)=>({
    state:req==='ci-windows'?'FAIL':'PASS',observedSha:sha,
    reference:'https://github.com/example/relay/actions/runs/12345',
    proofSha256:digest})};
  await assert.rejects(inspectSoftwareReleaseCandidate('example/relay',SHA,'12345',
    ()=>OTHER,()=>valid),/differs/);
  await assert.rejects(inspectSoftwareReleaseCandidate('example/relay',SHA,'invalid',
    ()=>SHA,()=>valid),/required/);
  await assert.rejects(inspectSoftwareReleaseCandidate('example/relay',SHA,'12345',
    ()=>SHA,()=>valid),/did not prove/);
  let sample=0;
  const allPass:ReleaseProbe={...valid,inspect:async(req,sha)=>({
    state:'PASS',observedSha:sha,
    reference:'https://github.com/example/relay/actions/runs/12345',
    proofSha256:digest})};
  await assert.rejects(inspectSoftwareReleaseCandidate('example/relay',SHA,'12345',
    ()=>++sample===1?SHA:OTHER,()=>allPass),/changed/);
});
