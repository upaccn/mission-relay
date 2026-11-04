import { connect } from 'node:net';

/** Explicit executor-only HTTP proxy; never change machine/user networking. */
export function codexProxyUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.MISSION_RELAY_CODEX_PROXY?.trim();
  if (!raw) return undefined;
  let parsed: URL;
  try { parsed = new URL(raw); }
  catch { throw new Error('MISSION_RELAY_CODEX_PROXY must be an HTTP(S) URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password ||
      (parsed.pathname !== '/' && parsed.pathname !== '') || parsed.search || parsed.hash) {
    throw new Error('MISSION_RELAY_CODEX_PROXY must be an HTTP(S) proxy URL without credentials, paths or query parameters');
  }
  return parsed.origin;
}

export function codexProxyEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const proxy = codexProxyUrl(env);
  return proxy ? { HTTP_PROXY: proxy, HTTPS_PROXY: proxy } : {};
}

export async function localProxyPreflight(env: NodeJS.ProcessEnv = process.env): Promise<{
  ok: boolean; message: string; endpoint?: string;
}> {
  const proxy = codexProxyUrl(env);
  if (!proxy) return { ok: true, message: 'No explicit Codex proxy configured' };
  const parsed = new URL(proxy);
  const host = parsed.hostname.toLowerCase();
  if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) {
    return { ok: true, message: 'Explicit non-local Codex proxy configured; live transport is not preverified' };
  }
  const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
  const hostname = host === '[::1]' ? '::1' : host;
  const reachable = await new Promise<boolean>(resolve => {
    const socket = connect({ host: hostname, port });
    let finished = false;
    const done = (ok: boolean) => { if (finished) return; finished = true; socket.destroy(); resolve(ok); };
    socket.setTimeout(1200, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
  return { ok: reachable, endpoint: `${hostname}:${port}`,
    message: reachable ? 'Configured local Codex proxy is accepting connections' :
      'MISSION_RELAY_CODEX_PROXY points to an unavailable local proxy. The mission was not dispatched.' };
}
