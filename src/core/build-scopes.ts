import {createHash} from 'node:crypto';
import type {Store} from './store.js';
import {validateRemoteProjectPath} from './pi-planner.js';

/** Operator-granted repository scopes live in the existing private SQLite.
 * An explicit revocation (empty value) overrides the legacy default. */
function scopeKey(project:string):string {
  return `telegram.build.allow.${createHash('sha256').update(project).digest('hex')}`;
}

export function approveBuildRepository(store:Store,project:string):string {
  const path=validateRemoteProjectPath(project);
  store.setMeta(scopeKey(path),path);
  return path;
}

export function revokeBuildRepository(store:Store,project:string):void {
  const path=validateRemoteProjectPath(project);
  store.setMeta(scopeKey(path),'');
  if(store.getMeta('telegram.build.project')===path)
    store.setMeta('telegram.build.project','');
}

export function isApprovedBuildRepository(store:Store,project:string):boolean {
  const path=validateRemoteProjectPath(project);
  const explicit=store.getMeta(scopeKey(path));
  if(explicit!==null)return explicit===path;
  // Existing deployments keep their original exact-match approval until the
  // operator explicitly grants or revokes it. PI's inference route is not an
  // execution-repository grant for newly approved, independent Goals.
  return store.getMeta('telegram.build.project')===path&&
    store.getMeta('telegram.pi.project')===path;
}

export function approvedBuildRepositories(store:Store):string[] {
  const rows=store.db.prepare(
    "SELECT value FROM meta WHERE key LIKE 'telegram.build.allow.%' AND value!='' ORDER BY value"
  ).all() as {value:string}[];
  const legacy=store.getMeta('telegram.build.project');
  const entries=rows.map(row=>row.value);
  if(legacy&&isApprovedBuildRepository(store,legacy))entries.push(legacy);
  return [...new Set(entries)].sort();
}
