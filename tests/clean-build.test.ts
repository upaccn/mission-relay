import assert from 'node:assert/strict';
import {existsSync,mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join,parse,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import test from 'node:test';
import {cleanBuildOutput} from '../scripts/clean-build.mjs';

test('build cleanup removes stale generated files without touching source',()=>{
  const root=mkdtempSync(join(tmpdir(),'mission-relay-build-'));
  try {
    const stale=join(root,'dist','src','removed-module.js');
    const source=join(root,'src','current-module.ts');
    mkdirSync(join(root,'dist','src'),{recursive:true});
    mkdirSync(join(root,'src'),{recursive:true});
    writeFileSync(stale,'stale output');
    writeFileSync(source,'export {};');

    cleanBuildOutput(root);

    assert.equal(existsSync(join(root,'dist')),false);
    assert.equal(existsSync(source),true);
  } finally {
    rmSync(root,{recursive:true,force:true});
  }
});

test('build cleanup refuses a filesystem root',()=>{
  assert.throws(()=>cleanBuildOutput(parse(resolve('/')).root),/filesystem root/);
});
