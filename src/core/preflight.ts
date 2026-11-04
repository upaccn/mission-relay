import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { connect } from 'node:net';
import { missionCodexHome } from './paths.js';
import { localProxyPreflight } from './proxy.js';
import { windowsSandboxOverride } from './windows-sandbox.js';

export interface PreflightResult {
  ok: boolean;
  source: 'process-override' | 'codex-user-config' | 'default';
  localEndpoint?: string;
  reachable?: boolean;
  message: string;
}

export function configuredBaseUrl(env:NodeJS.ProcessEnv = process.env,home?:string): {
  url?:string;source:PreflightResult['source'];
} {
  const override=env.MISSION_RELAY_CODEX_BASE_URL?.trim();
  if(override) return {url:override,source:'process-override'};
  try {
    // No secrets are loaded or returned. Only Codex's top-level model route matters.
    const directory=home?join(home,'.codex'):missionCodexHome(env);
    const config=readFileSync(join(directory,'config.toml'),'utf8');
    const topLevel=config.split(/^\s*\[/m,1)[0] ?? '';
    const match=topLevel.match(/^\s*openai_base_url\s*=\s*(["'])([^"'\r\n]+)\1\s*(?:#.*)?$/m);
    if(match?.[2]) return {url:match[2],source:'codex-user-config'};
  }catch {/* No Codex config is a supported state for a newly installed client. */}
  return {source:'default'};
}

function loopbackEndpoint(url:string):{host:string;port:number}|undefined {
  let parsed:URL;
  try{parsed=new URL(url);}catch{throw new Error('Configured Codex base URL is invalid');}
  if(!['http:','https:'].includes(parsed.protocol)) throw new Error('Configured Codex base URL must use HTTP(S)');
  if(!['localhost','127.0.0.1','[::1]'].includes(parsed.hostname.toLowerCase())) return undefined;
  return {host:parsed.hostname==='[::1]'?'::1':parsed.hostname,port:Number(parsed.port || (parsed.protocol==='https:'?443:80))};
}

export async function codexPreflight(env:NodeJS.ProcessEnv = process.env,home?:string):Promise<PreflightResult> {
  const proxy=await localProxyPreflight(env);
  if(!proxy.ok) return {ok:false,source:'process-override',message:proxy.message,localEndpoint:proxy.endpoint,reachable:false};
  const backend=windowsSandboxOverride(env);
  const sandboxNote=backend.windows?.sandbox==='unelevated'
    ? ' Windows sandbox backend: unelevated (weaker isolation; a no-model permission probe is required before sensitive work).'
    : backend.windows ? ' Windows sandbox backend: elevated (permission probe still recommended).' : '';
  const proxyNote=env.MISSION_RELAY_CODEX_PROXY ? ` Codex proxy: ${proxy.message}.` : '';
  const isolatedHome=home?join(home,'.codex'):missionCodexHome(env);
  try{if(!statSync(isolatedHome).isDirectory()) throw new Error('not a directory');}
  catch{return {ok:false,source:'default',message:'Mission Relay isolated Codex home is not initialized. Run `mission-relay codex-init` and authorize that CODEX_HOME before executing a mission.'};}
  const configured=configuredBaseUrl(env,home);
  if(!configured.url) return {ok:true,source:'default',message:'No custom Codex base URL; run-time authentication and remote availability must still be tested.'+proxyNote+sandboxNote};
  let target:ReturnType<typeof loopbackEndpoint>;
  try{target=loopbackEndpoint(configured.url);}catch(e){
    return {ok:false,source:configured.source,message:(e as Error).message};
  }
  if(!target) return {ok:true,source:configured.source,message:'Configured remote endpoint is syntactically valid; no authenticated network check performed.'};
  const reachable=await new Promise<boolean>(resolve=>{
    const socket=connect({host:target.host,port:target.port});
    let done=false;
    const finish=(value:boolean)=>{if(done)return;done=true;socket.destroy();resolve(value);};
    socket.setTimeout(1200,()=>finish(false));
    socket.once('connect',()=>finish(true));
    socket.once('error',()=>finish(false));
  });
  return {ok:reachable,source:configured.source,
    localEndpoint:`${target.host}:${target.port}`,reachable,
    message:reachable?'Local Codex bridge is accepting TCP connections; model authentication still needs a live turn.'+proxyNote+sandboxNote:
      'Configured local Codex bridge is not listening. Restart/fix that bridge or use an explicitly supported Codex endpoint. The mission was not dispatched.'};
}
