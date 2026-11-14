import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {checkProjectState} from '../scripts/check-project-state.mjs';

function fixture(run:(root:string)=>void){
  const dir=mkdtempSync(join(tmpdir(),'mission-relay-state-'));
  try{
    mkdirSync(join(dir,'docs'));
    mkdirSync(join(dir,'.github','workflows'),{recursive:true});
    writeFileSync(join(dir,'package.json'),JSON.stringify({version:'1.2.9'}));
    writeFileSync(join(dir,'package-lock.json'),JSON.stringify({
      version:'1.2.9',packages:{'':{version:'1.2.9'}},
    }));
    writeFileSync(join(dir,'STATE.md'),'Current source package version: `1.2.9`\n');
    writeFileSync(join(dir,'CHANGELOG.md'),'## 1.2.9 — Current\n');
    writeFileSync(join(dir,'README.md'),'[Architecture](docs/architecture.md)\n');
    writeFileSync(join(dir,'docs','architecture.md'),'# Architecture\n');
    writeFileSync(join(dir,'.github','workflows','ci.yml'),
      '- run: npm run check\n- run: npm run privacy-check\n');
    for(const name of ['AGENTS.md','CONTRIBUTING.md','SECURITY.md'])
      writeFileSync(join(dir,name),'# '+name+'\n');
    run(dir);
  }finally{rmSync(dir,{recursive:true,force:true});}
}

test('source state gate accepts matching source docs, lock and local links',()=>fixture(dir=>{
  const result=checkProjectState(dir);
  assert.deepEqual(result.errors,[]);
  assert.equal(result.version,'1.2.9');
  assert.equal(result.checkedMarkdownLinks,1);
  assert.deepEqual(checkProjectState(dir).errors,[],
    'Repeated invocation must not accumulate module-global Markdown paths');
}));

test('source state gate detects package, lock, STATE and CHANGELOG drift',()=>fixture(dir=>{
  writeFileSync(join(dir,'package-lock.json'),JSON.stringify({
    version:'1.2.8',packages:{'':{version:'1.2.8'}},
  }));
  writeFileSync(join(dir,'STATE.md'),'Current source package version: `1.2.8`\n');
  writeFileSync(join(dir,'CHANGELOG.md'),'## 1.2.8 — Old\n');
  const text=checkProjectState(dir).errors.join('\n');
  assert.match(text,/package-lock/);
  assert.match(text,/STATE.md/);
  assert.match(text,/CHANGELOG.md/);
}));

test('source state gate catches broken and escaping Markdown links',()=>fixture(dir=>{
  writeFileSync(join(dir,'README.md'),
    '[missing](docs/absent.md) [escape](../elsewhere.md) [external](https://example.com)\n');
  const result=checkProjectState(dir);
  assert.equal(result.checkedMarkdownLinks,2);
  assert.match(result.errors.join('\n'),/Broken local Markdown link/);
  assert.match(result.errors.join('\n'),/escapes repository/);
}));

test('source state gate refuses unrelated top-level archives and extra project folders',()=>fixture(dir=>{
  mkdirSync(join(dir,'museai'));
  writeFileSync(join(dir,'2.0.65_0.zip'),'unrelated test archive');
  const text=checkProjectState(dir).errors.join('\n');
  assert.match(text,/Unexpected root entry.*museai/);
  assert.match(text,/Unexpected root entry.*2.0.65_0.zip/);
}));

test('source state gate refuses skipped CI and accepts ordinary build output',()=>fixture(dir=>{
  mkdirSync(join(dir,'dist'));
  mkdirSync(join(dir,'node_modules'));
  assert.deepEqual(checkProjectState(dir).errors,[]);
  writeFileSync(join(dir,'.github','workflows','ci.yml'),'jobs: {}\n');
  assert.match(checkProjectState(dir).errors.join('\n'),/CI must run/);
}));
