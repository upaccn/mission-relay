import { homedir, platform } from 'node:os';
import { join, resolve } from 'node:path';

export function stateHome(env:NodeJS.ProcessEnv=process.env):string {
  if(env.MISSION_RELAY_HOME) return resolve(env.MISSION_RELAY_HOME);
  if(platform()==='win32') return join(env.LOCALAPPDATA || join(homedir(),'AppData','Local'),'MissionRelay');
  if(platform()==='darwin') return join(homedir(),'Library','Application Support','MissionRelay');
  return join(env.XDG_STATE_HOME || join(homedir(),'.local','state'),'mission-relay');
}
