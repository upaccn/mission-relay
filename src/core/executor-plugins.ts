import {existsSync,realpathSync,statSync} from 'node:fs';
import {isAbsolute,extname} from 'node:path';
import {pathToFileURL} from 'node:url';
import type {AgentAdapter,Decision,Mission,TurnInput,Verification} from './types.js';
import type {Store} from './store.js';
import {PluginRegistry,type PluginManifest} from './plugins.js';

/** Native executors are installed separately and explicitly registered locally.
 * Browser-first operation has no native-model dependency or provider preference. */
export const EXECUTOR_PLUGIN_META='executor.plugins';
export interface PreflightResult{
  ok:boolean;source:string;message:string;localEndpoint?:string;reachable?:boolean;
}
export interface ExecutorRegistration{id:string;path:string}
export type ExecutorPlugin={manifest:PluginManifest;createExecutor:()=>AgentAdapter;
  preflight?:()=>Promise<{ok:boolean;message:string}>};

function assertPluginFile(path:string):string {
  if(!isAbsolute(path)||!['.js','.mjs'].includes(extname(path))||!existsSync(path)||
     !statSync(path).isFile())throw new Error('Executor plugin must be an existing absolute .js or .mjs file');
  return realpathSync(path);
}
function isAdapter(value:unknown):value is AgentAdapter {
  return typeof value==='object'&&value!==null&&
    typeof (value as AgentAdapter).execute==='function'&&
    typeof (value as AgentAdapter).verify==='function';
}
export async function inspectExecutorPlugin(path:string):Promise<{path:string;plugin:ExecutorPlugin}>{
  const file=assertPluginFile(path);
  // Import executes trusted code; only an explicit local operator registration
  // or a previously registered path may call this function.
  const module=await import(pathToFileURL(file).href) as Partial<ExecutorPlugin>;
  if(!module.manifest||typeof module.createExecutor!=='function')
    throw new Error('Executor plugin must export manifest and createExecutor()');
  const registry=new PluginRegistry<unknown>();
  registry.register(module.manifest,null);
  if(module.manifest.kind!=='executor'||!module.manifest.capabilities.includes('execute-turn')||
    !module.manifest.capabilities.includes('verify-read-only'))
    throw new Error('Plugin must declare executor/execute-turn/verify-read-only capabilities');
  return {path:file,plugin:module as ExecutorPlugin};
}
export function registeredExecutorPlugins(store:Store):ExecutorRegistration[]{
  const source=store.getMeta(EXECUTOR_PLUGIN_META);
  if(!source){
    // Compatibility with an older single-plugin registration, if present.
    const legacy=store.getMeta('executor.plugin.path');
    return legacy?[{id:'executor.legacy',path:legacy}]:[];
  }
  const values=JSON.parse(source) as unknown;
  if(!Array.isArray(values)||values.some(value=>!value||typeof value!=='object'||
    typeof (value as ExecutorRegistration).id!=='string'||
    typeof (value as ExecutorRegistration).path!=='string'))
    throw new Error('Invalid registered executor plugin catalog');
  return values as ExecutorRegistration[];
}
export async function registerExecutorPlugin(store:Store,path:string):Promise<{id:string;path:string}>{
  const verified=await inspectExecutorPlugin(path);
  const adapter=verified.plugin.createExecutor();
  if(!isAdapter(adapter))throw new Error('Executor factory returned an invalid AgentAdapter');
  const existing=registeredExecutorPlugins(store);
  const previous=existing.find(item=>item.id===verified.plugin.manifest.id);
  if(previous&&previous.path!==verified.path)
    throw new Error('An executor with this ID already exists; remove it explicitly before replacing');
  if(!previous){
    store.setMeta(EXECUTOR_PLUGIN_META,JSON.stringify([...existing,{
      id:verified.plugin.manifest.id,path:verified.path}]));
    if(!store.getMeta('executor.plugin.default'))
      store.setMeta('executor.plugin.default',verified.plugin.manifest.id);
  }
  return {id:verified.plugin.manifest.id,path:verified.path};
}
export function defaultExecutorId(store:Store):string|null{
  const entries=registeredExecutorPlugins(store);
  if(!entries.length)return null;
  const chosen=store.getMeta('executor.plugin.default')||entries[0]!.id;
  if(!entries.some(item=>item.id===chosen))
    throw new Error('Default executor is not installed; select an installed plugin');
  return chosen;
}
export function setDefaultExecutor(store:Store,id:string):void{
  if(!registeredExecutorPlugins(store).some(item=>item.id===id))
    throw new Error('Cannot select an executor that is not installed');
  store.setMeta('executor.plugin.default',id);
}
export function removeExecutorPlugin(store:Store,id:string):void{
  const entries=registeredExecutorPlugins(store);
  if(!entries.some(item=>item.id===id))throw new Error('Executor plugin is not registered');
  // Never rewrite bindings for already-started native missions. Removing a
  // plugin may intentionally leave those missions paused until restored.
  store.setMeta(EXECUTOR_PLUGIN_META,JSON.stringify(entries.filter(item=>item.id!==id)));
  if(store.getMeta('executor.plugin.default')===id)
    store.setMeta('executor.plugin.default',entries.find(item=>item.id!==id)?.id||'');
}
export async function configuredExecutor(store:Store,id?:string):Promise<ExecutorPlugin|null> {
  const selected=id||defaultExecutorId(store);
  if(!selected)return null;
  const entry=registeredExecutorPlugins(store).find(item=>item.id===selected);
  if(!entry)throw new Error(`Required native executor is not installed: ${selected}`);
  const plugin=(await inspectExecutorPlugin(entry.path)).plugin;
  if(plugin.manifest.id!==selected && selected!=='executor.legacy')
    throw new Error('Installed executor manifest identity changed unexpectedly');
  return plugin;
}
/** Lazily load the native adapter only when someone actually invokes it.
 * This permits ChatGPT, Telegram, and PI to work without any coding agent. */
export class LazyExecutor implements AgentAdapter {
  private readonly agents=new Map<string,AgentAdapter>();
  constructor(private readonly store:Store){}
  private async get(m:Mission):Promise<AgentAdapter>{
    const bound=this.store.getMeta(`executor.mission.${m.id}`);
    const id=bound||defaultExecutorId(this.store);
    if(!id)throw new Error('No native executor plugin installed; browser-first ChatGPT tasks remain available');
    const plugin=await configuredExecutor(this.store,id);
    if(!plugin)throw new Error('No native executor plugin installed; browser-first ChatGPT tasks remain available');
    if(!bound){
      this.store.bindNativeExecutor(m.id,id);
    }
    // Every Mission must be pinned, even when its executor instance was
    // already cached for another Mission. Otherwise a later default change
    // could silently migrate an in-progress Mission to a different provider.
    if(this.agents.has(id))return this.agents.get(id)!;
    const agent=plugin.createExecutor();
    if(!isAdapter(agent))throw new Error('Configured native executor plugin returned an invalid AgentAdapter');
    this.agents.set(id,agent);
    return agent;
  }
  async execute(input:TurnInput):Promise<Decision>{return (await this.get(input.mission)).execute(input);}
  async verify(m:Mission,d:Decision):Promise<Verification>{return (await this.get(m)).verify(m,d);}
}
export async function executorPreflight(store:Store,missionId?:string):Promise<PreflightResult>{
  try {
    const bound=missionId?store.getMeta(`executor.mission.${missionId}`):null;
    const plugin=await configuredExecutor(store,bound||undefined);
    if(!plugin)return {ok:false,source:'default',message:'No native executor plugin installed. Register one when needed; ChatGPT works without it.'};
    const result=plugin.preflight?await plugin.preflight():{ok:true,message:`Installed native executor: ${plugin.manifest.id}`};
    return {...result,source:'default'};
  }catch(error){return {ok:false,source:'default',message:error instanceof Error?error.message:'Executor plugin inspection failed'};}
}
