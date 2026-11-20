import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const root=fileURLToPath(new URL('../',import.meta.url));
const packageVersion=(JSON.parse(readFileSync(
  new URL('../package.json',import.meta.url),'utf8')) as {version:string}).version;

test('CLI help reports the package version and current eight-Send ceiling',()=>{
  const result=spawnSync(process.execPath,['--import','tsx','src/cli.ts','help'],{
    cwd:root,encoding:'utf8',timeout:15_000,
  });
  assert.equal(result.error,undefined,result.error?.message);
  assert.equal(result.status,0,result.stderr);
  assert.ok(result.stdout.startsWith(`Mission Relay v${packageVersion}\n`));
  assert.match(result.stdout,/current 8-send chat segmentation/);
  assert.doesNotMatch(result.stdout,/10-send chat segmentation/);
});
