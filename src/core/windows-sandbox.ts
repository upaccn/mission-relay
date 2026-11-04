/** Codex's own Windows sandbox backend is independent of per-mission read/write scope. */
export function windowsSandboxOverride(env: NodeJS.ProcessEnv = process.env, platform = process.platform): {
  windows?: { sandbox: 'elevated' | 'unelevated' };
} {
  if (platform !== 'win32') return {};
  const configured = env.MISSION_RELAY_WINDOWS_SANDBOX || 'elevated';
  if (configured !== 'elevated' && configured !== 'unelevated') {
    throw new Error('MISSION_RELAY_WINDOWS_SANDBOX must be elevated or unelevated');
  }
  return { windows: { sandbox: configured } };
}
