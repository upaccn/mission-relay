import { mkdirSync, chmodSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, resolve } from 'node:path';

export function stateHome(env:NodeJS.ProcessEnv=process.env):string {
  if(env.MISSION_RELAY_HOME) return resolve(env.MISSION_RELAY_HOME);
  if(platform()==='win32') return join(env.LOCALAPPDATA || join(homedir(),'AppData','Local'),'MissionRelay');
  if(platform()==='darwin') return join(homedir(),'Library','Application Support','MissionRelay');
  return join(env.XDG_STATE_HOME || join(homedir(),'.local','state'),'mission-relay');
}

/** Separate Codex configuration/auth/session root; never clone or modify ~/.codex. */
export function missionCodexHome(env:NodeJS.ProcessEnv=process.env):string {
  return resolve(env.MISSION_RELAY_CODEX_HOME || join(stateHome(env),'codex-home'));
}

export function initializeCodexHome(env:NodeJS.ProcessEnv=process.env):string {
  const directory=missionCodexHome(env);
  mkdirSync(directory,{recursive:true,mode:0o700});
  if(process.platform!=='win32') chmodSync(directory,0o700);
  return directory;
}
