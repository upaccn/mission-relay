// Post-tsc build identity. This is generated in the checkout being built,
// never committed or accepted as proof of GitHub CI by itself.
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,readdirSync,renameSync,writeFileSync} from 'node:fs';
import {join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export function compiledFiles(dir) {
  const files=[];
  const walk=(folder)=>{
    for(const entry of readdirSync(folder,{withFileTypes:true})) {
      const full=join(folder,entry.name);
      if(entry.isDirectory())walk(full);
      else if(entry.isFile()&&entry.name.endsWith('.js'))
        files.push(relative(dir,full).replaceAll('\\','/'));
    }
  };
  walk(dir);
  return files.sort();
}

export function compiledDigest(dir) {
  const files=compiledFiles(dir);
  if(!files.includes('cli.js'))throw new Error('Compiled CLI missing');
  const digest=createHash('sha256');
  for(const name of files){
    const bytes=readFileSync(join(dir,name));
    digest.update(name+'\0'+createHash('sha256').update(bytes).digest('hex')+'\n');
  }
  return {treeSha256:digest.digest('hex'),
    cliSha256:createHash('sha256').update(readFileSync(join(dir,'cli.js'))).digest('hex'),
    fileCount:files.length};
}

export function sourceHead(root) {
  const sha=execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8',timeout:10000}).trim();
  if(!/^[0-9a-f]{40}$/.test(sha))throw new Error('Invalid Git HEAD');
  return sha;
}

export function writeProvenance(root=resolve('.')) {
  const dir=join(root,'dist');
  const content={format:1,sourceSha:sourceHead(root),...compiledDigest(dir)};
  const file=join(dir,'build-provenance.json'),tmp=file+'.tmp-'+process.pid;
  writeFileSync(tmp,JSON.stringify(content)+'\n',{flag:'wx',mode:0o600});
  renameSync(tmp,file);
  return content;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const result=writeProvenance();
  console.log('Built source '+result.sourceSha+'; compiled JS tree '+result.treeSha256);
}
