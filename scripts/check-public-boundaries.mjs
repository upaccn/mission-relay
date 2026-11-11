import {execFileSync} from 'node:child_process';
import {readFileSync,existsSync} from 'node:fs';

// Current tracked content only. This intentionally does not claim that old
// GitHub SHA-addressable objects, logs, forks or clones have been purged.
const names=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'])
  .toString('utf8').split('\0').filter((path,index,array)=>path&&array.indexOf(path)===index&&existsSync(path));
const failures=[];
for(const path of names) {
  if(!/\.(?:md|ts|mts|js|mjs|json|yml|yaml|txt)$/.test(path))continue;
  const data=readFileSync(path,'utf8');
  const patterns={
    'private ChatGPT conversation URL':/https:\/\/chatgpt\.com\/c\/([0-9a-fA-F-]{36})/g,
    'private Playwriter Chrome installation ID':/install:Chrome:([a-zA-Z0-9]{12,})/g,
    'high-confidence credential string':/\b(?:sk-proj-|sk-svcacct-|github_pat_|ghp_|gho_|ghu_|ghs_)[A-Za-z0-9_-]{24,}/g,
    'Telegram Bot token':/\b\d{7,11}:[A-Za-z0-9_-]{30,}\b/g,
  };
  for(const [type,pattern] of Object.entries(patterns)){
    const matches=[...data.matchAll(pattern)];
    for(const match of matches){
      if(type==='private ChatGPT conversation URL' && /^(?:123e4567|987e6543)-/.test(match[1]))continue;
      failures.push({path,type});
    }
  }
}
if(failures.length){
  // Never print matched secret values or snippets in public CI logs.
  for(const {path,type} of failures.slice(0,20))console.error(`Public boundary violation: ${type} in ${path}`);
  process.exitCode=1;
}else console.log(`Public boundary scan passed for ${names.length} current tracked/untracked source files.`);
