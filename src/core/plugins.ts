import { PROTOCOL_VERSION } from './types.js';

export type PluginKind = 'executor' | 'mission-provider' | 'channel' | 'computer-use' | 'verifier';
export interface PluginManifest {
  id: string;
  version: string;
  apiVersion: number;
  kind: PluginKind;
  capabilities: readonly string[];
}

/** Trusted built-ins only in v0.1: dynamic third-party code is not loaded. */
export class PluginRegistry<T> {
  private readonly plugins = new Map<string, {manifest: PluginManifest; adapter: T}>();
  register(manifest: PluginManifest, adapter: T): void {
    if (manifest.apiVersion !== PROTOCOL_VERSION) throw new Error(`Unsupported plugin API version: ${manifest.apiVersion}`);
    if (!/^[a-z][a-z0-9]*(?:[.-][a-z][a-z0-9]*)+$/.test(manifest.id)) throw new Error('Plugin id must be namespaced, such as executor.codex');
    if (!/^\d+\.\d+\.\d+/.test(manifest.version)) throw new Error('Plugin version must use semver');
    if (new Set(manifest.capabilities).size !== manifest.capabilities.length) throw new Error('Duplicate plugin capabilities');
    if (this.plugins.has(manifest.id)) throw new Error(`Plugin already registered: ${manifest.id}`);
    this.plugins.set(manifest.id,{manifest,adapter});
  }
  get(id: string, kind?: PluginKind): T {
    const plugin = this.plugins.get(id);
    if (!plugin) throw new Error(`Unknown plugin: ${id}`);
    if (kind && plugin.manifest.kind !== kind) throw new Error(`Wrong plugin kind for ${id}`);
    return plugin.adapter;
  }
  list(): PluginManifest[] { return [...this.plugins.values()].map(p=>p.manifest); }
}
