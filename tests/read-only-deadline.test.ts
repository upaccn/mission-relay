import test from 'node:test';
import assert from 'node:assert/strict';
import {withReadOnlyDeadline} from '../src/core/read-only-deadline.js';

test('a hung read-only Chrome preflight terminates without a Send or retry',async()=>{
  let opened=0;
  const never=new Promise<string>(()=>{opened++;});
  await assert.rejects(withReadOnlyDeadline(never,20),
    /Read-only Chrome preflight timed out; no browser Send was authorized/);
  assert.equal(opened,1);
});

test('a late-created preflight connector is disposed after timeout',async()=>{
  let resolve!: (session:{close:()=>Promise<void>})=>void;
  const connection=new Promise<{close:()=>Promise<void>}>(r=>{resolve=r;});
  let closed=0;
  await assert.rejects(withReadOnlyDeadline(connection,20,session=>session.close()),/timed out/);
  resolve({close:async()=>{closed++;}});
  await new Promise(r=>setTimeout(r,0));
  assert.equal(closed,1,'Late-created Playwriter session must not be leaked');
});

test('healthy preflight values and errors retain their original semantics',async()=>{
  assert.equal(await withReadOnlyDeadline(Promise.resolve('unchanged'),50),'unchanged');
  await assert.rejects(withReadOnlyDeadline(Promise.reject(new Error('DOM changed')),50),
    /DOM changed/);
  await assert.rejects(withReadOnlyDeadline(Promise.resolve('ignored'),0),
    /Invalid read-only browser preflight timeout/);
});
