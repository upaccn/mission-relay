import {rmSync} from 'node:fs';
import {basename,dirname,parse,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export function cleanBuildOutput(projectRoot=resolve('.')) {
  const root=resolve(projectRoot);
  if(root===parse(root).root)
    throw new Error('Refusing to clean build output from a filesystem root');
  const output=resolve(root,'dist');
  if(dirname(output)!==root||basename(output)!=='dist')
    throw new Error('Build output must be the project dist directory');
  rmSync(output,{recursive:true,force:true});
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))
  cleanBuildOutput(resolve(dirname(fileURLToPath(import.meta.url)),'..'));
