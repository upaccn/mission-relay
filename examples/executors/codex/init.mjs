import {mkdirSync,chmodSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';

const env=process.env;
const base=env.MISSION_RELAY_HOME?resolve(env.MISSION_RELAY_HOME)
  :process.platform==='win32'?join(env.LOCALAPPDATA||join(homedir(),'AppData','Local'),'MissionRelay')
  :process.platform==='darwin'?join(homedir(),'Library','Application Support','MissionRelay')
  :join(env.XDG_STATE_HOME||join(homedir(),'.local','state'),'mission-relay');
const directory=resolve(env.MISSION_RELAY_CODEX_HOME||join(base,'codex-home'));
mkdirSync(directory,{recursive:true,mode:0o700});
if(process.platform!=='win32')chmodSync(directory,0o700);
console.log(`Optional Codex isolated CODEX_HOME: ${directory}`);
console.log('Authorize through the official Codex CLI with CODEX_HOME set to this path; do not copy secrets.');
