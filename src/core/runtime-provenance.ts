import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,readdirSync,realpathSync} from 'node:fs';
import {dirname,join,relative,resolve} from 'node:path';

export interface RuntimeProvenance {
  sourceSha:string;
  compiledTreeSha256:string;
  cliSha256:string;
  manifestSha256:string;
  fileCount:number;
}

const sha256=(bytes:Buffer|string):string=>createHash('sha256').update(bytes).digest('hex');

/** Verify an installed build against the actual entrypoint the Node process
 * launched. This proof is bound to the live SQLite channel lease separately.
 * It is an owner-local build/process identity, not remote secure attestation. */
export function verifiedRuntimeProvenance(entry=process.argv[1]):RuntimeProvenance {
  if(!entry)throw new Error('No worker entrypoint');
  const cli=realpathSync(resolve(entry));
  const dist=dirname(cli),root=dirname(dist);
  if(cli!==realpathSync(join(dist,'cli.js')))
    throw new Error('Worker entrypoint is not the compiled project CLI');
  const bytes=readFileSync(join(dist,'build-provenance.json'));
  const parsed:unknown=JSON.parse(bytes.toString('utf8'));
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))
    throw new Error('Invalid build provenance');
  const v=parsed as Record<string,unknown>;
  if(v.format!==1||typeof v.sourceSha!=='string'||!/^[0-9a-f]{40}$/.test(v.sourceSha)||
     typeof v.cliSha256!=='string'||typeof v.treeSha256!=='string'||
     !/^[0-9a-f]{64}$/.test(v.cliSha256)||!/^[0-9a-f]{64}$/.test(v.treeSha256)||
     !Number.isSafeInteger(v.fileCount)||Number(v.fileCount)<1)
    throw new Error('Invalid build provenance schema');
  const git=(...args:string[]):string=>execFileSync('git',['-C',root,...args],
    {encoding:'utf8',timeout:10000}).trim();
  if(git('rev-parse','HEAD')!==v.sourceSha||git('status','--porcelain=v1','--untracked-files=all'))
    throw new Error('Worker checkout differs from the compiled source SHA or is dirty');
  const files:string[]=[];
  const walk=(folder:string):void=>{
    for(const file of readdirSync(folder,{withFileTypes:true})){
      const abs=join(folder,file.name);
      if(file.isDirectory())walk(abs);
      else if(file.isFile()&&file.name.endsWith('.js'))
        files.push(relative(dist,abs).replaceAll('\\','/'));
    }
  };
  walk(dist);
  files.sort();
  if(files.length!==v.fileCount||!files.includes('cli.js'))
    throw new Error('Compiled file set changed after build');
  const digest=createHash('sha256');
  for(const file of files)
    digest.update(file+'\0'+sha256(readFileSync(join(dist,file)))+'\n');
  const cliSha256=sha256(readFileSync(cli));
  if(digest.digest('hex')!==v.treeSha256||cliSha256!==v.cliSha256)
    throw new Error('Compiled worker files changed after build');
  return {
    sourceSha:v.sourceSha,compiledTreeSha256:v.treeSha256,
    cliSha256,manifestSha256:sha256(bytes),fileCount:files.length,
  };
}
