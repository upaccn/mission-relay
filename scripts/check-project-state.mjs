// Read-only, deterministic repository hygiene gate. This verifies source
// documentation and checkout layout, never external GMK production health.
import {existsSync,readFileSync,readdirSync,statSync} from 'node:fs';
import {resolve,dirname,relative,isAbsolute,sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT_FILES=[
  '.github','.git','.gitignore','AGENTS.md','CHANGELOG.md','CONTRIBUTING.md',
  'LICENSE','README.md','SECURITY.md','STATE.md','docs','examples','scripts',
  'src','tests','tsconfig.json','package.json','package-lock.json',
];
const IGNORED_RUNTIME=[
  'node_modules','dist','coverage','runtime','logs','.evidence','.codex',
  '.mission-relay','.env','.DS_Store',
];
const ROOT_MARKDOWN=['AGENTS.md','CHANGELOG.md','CONTRIBUTING.md','README.md','SECURITY.md','STATE.md'];

/** Never infer installed GMK SHA from Git HEAD; this only checks public
 * source documents and accidentally mixed top-level assets. */
export function checkProjectState(root){
  const errors=[];
  const read=(name)=>{
    try{return readFileSync(resolve(root,name),'utf8');}
    catch{errors.push(`Missing/read-error: ${name}`);return '';}
  };
  let manifest,lock;
  try{manifest=JSON.parse(read('package.json'));}catch{errors.push('Invalid package.json');}
  try{lock=JSON.parse(read('package-lock.json'));}catch{errors.push('Invalid package-lock.json');}
  const version=manifest?.version;
  if(!/^\d+\.\d+\.\d+$/.test(version??''))
    errors.push('Package version must be a valid three-part release number');
  if(version&&lock&&(lock.version!==version||lock.packages?.['']?.version!==version))
    errors.push('Package version differs from root package-lock versions');
  const state=read('STATE.md');
  const current=/Current source package version: `([^\x60]+)`/.exec(state)?.[1];
  if(version&&current!==version)
    errors.push('STATE.md current source package version differs from package.json');
  const changes=read('CHANGELOG.md');
  if(version&&!changes.includes(`## ${version} —`))
    errors.push('CHANGELOG.md lacks an entry for the current source version');
  const roots=new Set([...ROOT_FILES,...IGNORED_RUNTIME]);
  for(const entry of readdirSync(root,{withFileTypes:true})){
    if(roots.has(entry.name)||entry.name.startsWith('.env.'))continue;
    errors.push(`Unexpected root entry (possible cross-project artifact): ${entry.name}`);
  }
  let links=0;
  const mdFiles=[...ROOT_MARKDOWN];
  const docs=resolve(root,'docs');
  if(!existsSync(docs))errors.push('Missing docs directory');
  else for(const entry of readdirSync(docs,{withFileTypes:true})){
    if(!entry.isFile()||!entry.name.endsWith('.md'))continue;
    mdFiles.push(`docs/${entry.name}`);
  }
  for(const filename of mdFiles){
    const content=read(filename);
    for(const match of content.matchAll(/\[[^\]]+\]\(([^\s)]+)(?:\s+[^)]*)?\)/g)){
      const href=match[1];
      if(!href||/^(?:#|[a-z][a-z\d+.-]*:|\/\/)/i.test(href))continue;
      let path;
      try{path=decodeURIComponent(href.split(/[?#]/)[0]);}
      catch{errors.push(`Invalid URL encoding in ${filename}`);continue;}
      if(!path)continue;
      const dest=resolve(dirname(resolve(root,filename)),path);
      const rel=relative(root,dest);
      links++;
      if(isAbsolute(rel)||rel==='..'||rel.startsWith('..'+sep))
        errors.push(`Local Markdown link escapes repository: ${filename} -> ${href}`);
      else if(!existsSync(dest)||!statSync(dest).isFile())
        errors.push(`Broken local Markdown link: ${filename} -> ${href}`);
    }
  }
  const ci=read('.github/workflows/ci.yml');
  if(!ci.includes('npm run check')||!ci.includes('npm run privacy-check'))
    errors.push('CI must run source-drift and privacy checks');
  // A release tag must not rerun six OS/Node matrix jobs after main SHA
  // already passed them. GitHub release tags are separately attested.
  if(!/\bpush:\s*\n\s*branches:\s*\[main\]/.test(ci))
    errors.push('CI must restrict push runs to main rather than release tags');
  return {version:version??null,checkedMarkdownLinks:links,errors};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const result=checkProjectState(process.cwd());
  if(result.errors.length){
    for(const error of result.errors)console.error('Repository drift: '+error);
    process.exitCode=1;
  }else{
    console.log(`Source state consistent: v${result.version}, ${result.checkedMarkdownLinks} local Markdown links checked; no unexpected root entries.`);
  }
}
