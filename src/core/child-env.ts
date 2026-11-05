/** Minimal environment forwarded to user-configured checks and tool-free PI.
 * Native agents own and constrain their own credentials independently. */
const OS_KEYS=new Set([
  'PATH','HOME','USERPROFILE','HOMEDRIVE','HOMEPATH','SYSTEMROOT','WINDIR',
  'COMSPEC','PATHEXT','TEMP','TMP','TMPDIR','APPDATA','LOCALAPPDATA',
  'XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','LANG','LC_ALL',
]);
export function childEnvironment(_kind:'check',source:NodeJS.ProcessEnv=process.env):Record<string,string>{
  const output:Record<string,string>={};
  for(const [key,value] of Object.entries(source)){
    if(value!==undefined&&OS_KEYS.has(key.toUpperCase()))output[key]=value;
  }
  return output;
}
