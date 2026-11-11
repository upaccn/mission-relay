/** Optional native executor. Install this directory's dependencies yourself;
 * register this absolute path with `mission-relay plugin-register --path ...`.
 * Mission Relay never loads this adapter unless the operator registers it. */
import {Codex} from '@openai/codex-sdk';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';

export const manifest={
  id:'executor.codex',version:'0.1.0',apiVersion:1,kind:'executor',
  capabilities:['execute-turn','resume-thread','verify-read-only'],
};

function home(){
  const env=process.env;
  const base=env.MISSION_RELAY_HOME?resolve(env.MISSION_RELAY_HOME)
    :process.platform==='win32'?join(env.LOCALAPPDATA||join(homedir(),'AppData','Local'),'MissionRelay')
    :process.platform==='darwin'?join(homedir(),'Library','Application Support','MissionRelay')
    :join(env.XDG_STATE_HOME||join(homedir(),'.local','state'),'mission-relay');
  return resolve(env.MISSION_RELAY_CODEX_HOME||join(base,'codex-home'));
}
function environment(){
  const allowed=new Set(['PATH','HOME','USERPROFILE','HOMEDRIVE','HOMEPATH','SYSTEMROOT',
    'WINDIR','COMSPEC','PATHEXT','TEMP','TMP','TMPDIR','APPDATA','LOCALAPPDATA',
    'XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','LANG','LC_ALL',
    'CODEX_HOME','CODEX_SQLITE_HOME','CODEX_API_KEY','OPENAI_API_KEY',
    'HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','SSL_CERT_FILE','CODEX_CA_CERTIFICATE']);
  const output=Object.fromEntries(Object.entries(process.env)
    .filter(([key,value])=>value!==undefined&&allowed.has(key.toUpperCase())));
  if(process.env.MISSION_RELAY_CODEX_PROXY){
    const url=new URL(process.env.MISSION_RELAY_CODEX_PROXY);
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||
      url.pathname!=='/')throw new Error('Invalid Codex proxy URL');
    output.HTTP_PROXY=url.origin;output.HTTPS_PROXY=url.origin;
  }
  return {...output,CODEX_HOME:home()};
}
function sandbox(){
  if(process.platform!=='win32')return {};
  const value=process.env.MISSION_RELAY_WINDOWS_SANDBOX||'elevated';
  if(!['elevated','unelevated'].includes(value))throw new Error('Invalid Windows sandbox backend');
  return {windows:{sandbox:value}};
}
const decisionSchema={type:'object',additionalProperties:false,properties:{
  status:{type:'string',enum:['continue','candidate_complete','blocked']},
  summary:{type:'string'},next_instruction:{type:'string'},
  evidence:{type:'array',items:{type:'string'}},
},required:['status','summary','next_instruction','evidence']};
const verificationSchema={type:'object',additionalProperties:false,properties:{
  accepted:{type:'boolean'},reason:{type:'string'},evidence:{type:'array',items:{type:'string'}},
},required:['accepted','reason','evidence']};
function signal(){
  const ms=Number(process.env.MISSION_RELAY_TURN_TIMEOUT_MS||1_800_000);
  if(!Number.isInteger(ms)||ms<10_000||ms>86_400_000)throw new Error('Invalid turn timeout');
  return AbortSignal.timeout(ms);
}
export function createExecutor(){
  const client=new Codex({
    ...(process.env.MISSION_RELAY_CODEX_BASE_URL?{baseUrl:process.env.MISSION_RELAY_CODEX_BASE_URL}:{}),
    env:environment(),config:sandbox(),
  });
  const options=m=>({workingDirectory:m.workspace,sandboxMode:m.sandbox,
    networkAccessEnabled:false,approvalPolicy:'never',threadSource:'mission-relay',
    ...(process.env.MISSION_RELAY_MODEL?{model:process.env.MISSION_RELAY_MODEL}:{})});
  return {
    async execute({mission,prompt,onThreadStarted,onEvent}){
      const thread=mission.threadId?client.resumeThread(mission.threadId,options(mission)):
        client.startThread(options(mission));
      const {events}=await thread.runStreamed(prompt,{outputSchema:decisionSchema,signal:signal()});
      let final='',complete=false;
      for await(const event of events){
        onEvent?.(event.type);
        if(event.type==='thread.started')onThreadStarted(event.thread_id);
        if(event.type==='item.completed'&&event.item.type==='agent_message')final=event.item.text;
        if(event.type==='turn.completed')complete=true;
        if(event.type==='turn.failed')throw new Error(event.error.message);
        if(event.type==='error')throw new Error(event.message);
      }
      if(!complete||!final)throw new Error('Executor did not finish with a structured response');
      return JSON.parse(final);
    },
    async verify(mission,decision){
      const thread=client.startThread({...options(mission),sandboxMode:'read-only',
        approvalPolicy:'never',networkAccessEnabled:false});
      const prompt=['Independently verify this mission in read-only mode.',
        `Goal: ${mission.goal}`,'Acceptance criteria:',...mission.acceptance,
        `Executor claim: ${decision.summary}`,
        `Evidence claims: ${decision.evidence.join('; ')}`,
        'Inspect the actual workspace, reject unsupported evidence, and do not make changes.'].join('\n');
      const result=await thread.run(prompt,{outputSchema:verificationSchema,signal:signal()});
      return JSON.parse(result.finalResponse);
    },
  };
}

export async function preflight(){
  const {statSync,readFileSync}=await import('node:fs');
  try{if(!statSync(home()).isDirectory())throw new Error('Missing isolated Codex profile');}
  catch{return {ok:false,message:'Create and authorize a dedicated CODEX_HOME before enabling this optional plugin.'};}
  // A tool-capable MCP installation is not proven read-only by the SDK sandbox.
  try{const text=readFileSync(join(home(),'config.toml'),'utf8');
    if(/^\s*\[mcp_servers(?:\.|\])/m.test(text))
      return {ok:false,message:'Codex profile contains MCP servers with unverified permissions'};
  }catch(error){if(error.code!=='ENOENT')throw error;}
  return {ok:true,message:'Isolated Codex profile present; remote authentication must still be verified by a live task.'};
}
