import {createHash} from 'node:crypto';
import type {Store} from './store.js';
import {validateRemoteProjectPath} from './pi-planner.js';

/** Operator-granted repository scopes live in the existing private SQLite.
 * An explicit revocation (empty value) overrides the legacy default. */
function scopeKey(project:string):string {
  return `telegram.build.allow.${createHash('sha256').update(project).digest('hex')}`;
}

/** Two different approved project roots cannot overlap, even when the
 * operator accidentally authorizes a nested checkout. A path grant is never
 * an authorization for a parent/child repository. */
export function repositoriesOverlap(a:string,b:string):boolean {
  const left=validateRemoteProjectPath(a),right=validateRemoteProjectPath(b);
  return left===right||left.startsWith(right+'/')||right.startsWith(left+'/');
}

export function approveBuildRepository(store:Store,project:string):string {
  const path=validateRemoteProjectPath(project);
  for(const existing of approvedBuildRepositories(store)){
    if(existing!==path&&repositoriesOverlap(existing,path))
      throw new Error('Repository isolation refused: approved source roots cannot contain one another');
  }
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

/** Fail closed if an older SQLite deployment already contains overlapping
 * grants. Repeat at every Send reservation, not only at initial approval. */
export function hasIsolatedRepositoryGrant(store:Store,project:string):boolean {
  const path=validateRemoteProjectPath(project);
  return isApprovedBuildRepository(store,path)&&
    approvedBuildRepositories(store).every(other=>
      other===path||!repositoriesOverlap(other,path));
}

/** A Goal's explicitly labeled source directory cannot be silently replaced
 * by the older global /build default. Unlabeled paths elsewhere in the Goal
 * (links, test inputs, exclusions) are not repository declarations. */
export function declaredSourceMatchesScope(goal:string,scope:string):boolean {
  const declarations=[...goal.matchAll(
    /^\s*(?:源码工作目录|Canonical source|Source repository|Repository)\s*[:：]\s*[`"']?(\/[a-zA-Z0-9_./-]+)/gim,
  )].map(match=>match[1]!);
  return declarations.every(path=>path===scope);
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
