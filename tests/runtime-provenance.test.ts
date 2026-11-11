import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {verifiedRuntimeProvenance} from '../src/core/runtime-provenance.js';
import {Store} from '../src/core/store.js';

const hash=(s:string):string=>createHash('sha256').update(s).digest('hex');

test('compiled runtime proof verifies exact clean Git checkout, manifest and every JS byte',()=>{
  const root=mkdtempSync(join(tmpdir(),'mission-relay-provenance-'));
  const cli=join(root,'dist','cli.js');
  const script=resolve('scripts/write-build-provenance.mjs');
  const git=(...args:string[])=>execFileSync('git',['-C',root,...args],{encoding:'utf8'});
  try{
    mkdirSync(join(root,'dist'));
    writeFileSync(cli,'console.log("test-worker");\n');
    writeFileSync(join(root,'source.txt'),'approved source\n');
    writeFileSync(join(root,'.gitignore'),'dist/\n');
    git('init','-b','main');
    git('add','source.txt','.gitignore');
    git('-c','user.email=ci@example.invalid','-c','user.name=CI','commit','-qm','fixture');
    const built=spawnSync(process.execPath,[script],{cwd:root,encoding:'utf8',timeout:10000});
    assert.equal(built.status,0,built.stderr);
    const first=verifiedRuntimeProvenance(cli);
    assert.equal(first.sourceSha,git('rev-parse','HEAD').trim());
    assert.equal(first.cliSha256,hash('console.log("test-worker");\n'));
    assert.match(first.compiledTreeSha256,/^[a-f0-9]{64}$/);
    assert.equal(first.fileCount,1);

    writeFileSync(cli,'console.log("tampered worker");\n');
    assert.throws(()=>verifiedRuntimeProvenance(cli),/Compiled worker files changed/);
    writeFileSync(cli,'console.log("test-worker");\n');
    writeFileSync(join(root,'source.txt'),'uncommitted edit\n');
    assert.throws(()=>verifiedRuntimeProvenance(cli),/dirty/);
    writeFileSync(join(root,'source.txt'),'approved source\n');
    const manifest=join(root,'dist','build-provenance.json');
    const previous=readFileSync(manifest,'utf8');
    const incorrect={...JSON.parse(previous) as Record<string,unknown>,sourceSha:'a'.repeat(40)};
    writeFileSync(manifest,JSON.stringify(incorrect));
    assert.throws(()=>verifiedRuntimeProvenance(cli),/differs from the compiled source SHA/);
    writeFileSync(manifest,previous);
    assert.equal(verifiedRuntimeProvenance(cli).sourceSha,first.sourceSha);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('worker runtime identity is lease-bound, cannot be spoofed, and never survives a new lease',()=>{
  const root=mkdtempSync(join(tmpdir(),'mission-relay-worker-proof-'));
  const store=new Store(join(root,'missions.sqlite'));
  const proof={sourceSha:'a'.repeat(40),compiledTreeSha256:hash('tree'),
    cliSha256:hash('entry'),manifestSha256:hash('manifest'),fileCount:3};
  try{
    const first=store.acquireChannelLease('telegram');
    assert.equal(store.channelStatus('telegram').runtimeProvenance,null);
    assert.throws(()=>store.recordChannelRuntime('telegram','wrong-lease',proof),/current worker lease/);
    store.recordChannelRuntime('telegram',first,proof);
    const observed=store.channelStatus('telegram').runtimeProvenance;
    assert.equal(observed?.sourceSha,proof.sourceSha);
    assert.equal(observed?.pid,process.pid);
    assert.equal('leaseKeySha256' in (observed??{}),false,'Do not expose lease proof in channel-status');
    store.releaseChannelLease('telegram',first);
    assert.equal(store.channelStatus('telegram').runtimeProvenance,null);
    const second=store.acquireChannelLease('telegram');
    assert.notEqual(second,first);
    assert.equal(store.channelStatus('telegram').runtimeProvenance,null,
      'A stale proof for the same PID cannot falsely identify a new lease');
    store.recordChannelRuntime('telegram',second,proof);
    assert.equal(store.channelStatus('telegram').runtimeProvenance?.sourceSha,proof.sourceSha);
    store.releaseChannelLease('telegram',second);
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

test('competing SQLite handles and foreign Worker custody cannot steal a live channel lease',()=>{
  const root=mkdtempSync(join(tmpdir(),'mission-relay-competing-worker-'));
  const file=join(root,'missions.sqlite');
  const owner=new Store(file),rival=new Store(file);
  try{
    const lease=owner.acquireChannelLease('telegram');
    const saved=owner.db.prepare(
      'SELECT owner_pid,owner_host,lease_key FROM channel_leases WHERE source=?'
    ).get('telegram');
    assert.throws(()=>rival.acquireChannelLease('telegram'),/already running/);
    assert.deepEqual(owner.db.prepare(
      'SELECT owner_pid,owner_host,lease_key FROM channel_leases WHERE source=?'
    ).get('telegram'),saved,'Refused competing Worker must not replace the owner');
    const proof={sourceSha:'a'.repeat(40),compiledTreeSha256:hash('tree'),
      cliSha256:hash('entry'),manifestSha256:hash('manifest'),fileCount:3};
    assert.throws(()=>rival.recordChannelRuntime('telegram','foreign-lease',proof),
      /current worker lease/);
    assert.equal(owner.channelStatus('telegram').runtimeProvenance,null);

    owner.db.prepare('UPDATE channel_leases SET owner_host=? WHERE source=?')
      .run('foreign-host.example.invalid','telegram');
    assert.throws(()=>rival.acquireChannelLease('telegram'),/another host/);
    assert.equal((owner.db.prepare(
      'SELECT lease_key FROM channel_leases WHERE source=?'
    ).get('telegram') as {lease_key:string}).lease_key,lease);
    owner.db.prepare('UPDATE channel_leases SET owner_host=? WHERE source=?')
      .run((saved as {owner_host:string}).owner_host,'telegram');
    owner.releaseChannelLease('telegram',lease);
    const next=rival.acquireChannelLease('telegram');
    assert.notEqual(next,lease,'Only a clean release permits new ownership');
    rival.releaseChannelLease('telegram',next);
    assert.equal(owner.channelStatus('telegram').pollerPid,null);
  }finally{rival.close();owner.close();rmSync(root,{recursive:true,force:true});}
});
