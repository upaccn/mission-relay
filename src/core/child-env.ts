/** Deliberately do not forward Mission Relay Bot tokens or arbitrary host secrets to agent/tool subprocesses. */
const BASE_KEYS=new Set([
  'PATH','HOME','USERPROFILE','HOMEDRIVE','HOMEPATH','SYSTEMROOT','WINDIR','COMSPEC',
  'PATHEXT','TEMP','TMP','TMPDIR','APPDATA','LOCALAPPDATA',
  'XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','LANG','LC_ALL',
]);
const CODEX_KEYS=new Set([
  ...BASE_KEYS,'CODEX_HOME','CODEX_SQLITE_HOME','CODEX_API_KEY','OPENAI_API_KEY',
  'HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','SSL_CERT_FILE','CODEX_CA_CERTIFICATE',
]);

export function childEnvironment(kind:'codex'|'check',source:NodeJS.ProcessEnv=process.env):Record<string,string> {
  const allowed=kind==='codex'?CODEX_KEYS:BASE_KEYS;
  const env:Record<string,string>={};
  for(const [key,value] of Object.entries(source)) {
    if(value!==undefined && allowed.has(key.toUpperCase())) env[key]=value;
  }
  return env;
}
