import type {Store} from './store.js';
import type {listConnectedChatCandidates} from '../plugins/chatgpt-browser.js';

export type ConnectedChatCandidate=Awaited<ReturnType<typeof listConnectedChatCandidates>>[number];
const PROFILE='browser.watch.profile';
const SEEN='browser.watch.seen';
const CURSOR='browser.watch.cursor';

/** The entire explicitly selected Playwriter-connected Chrome profile is
 * eligible; Chrome group membership is deliberately not used. */
export function watchedBrowser(store:Store):string|null {
  return store.getMeta(PROFILE)||null;
}

function seen(store:Store):Record<string,string|null> {
  const raw=store.getMeta(SEEN);
  if(!raw)return {};
  const value:unknown=JSON.parse(raw);
  if(!value||typeof value!=='object'||Array.isArray(value))
    throw new Error('Corrupt browser watch checkpoint; manual review required');
  const values=value as Record<string,unknown>;
  if(Object.entries(values).some(([key,hash])=>!/^[a-f0-9]{64}$/.test(key)||
    (hash!==null && (typeof hash!=='string'||!/^[a-f0-9]{64}$/.test(hash)))))
    throw new Error('Invalid browser watch checkpoint; fail closed');
  return value as Record<string,string|null>;
}

/** On explicit enable, baseline all currently visible ChatGPT conversations.
 * Do not unexpectedly launch historical tabs into a new PI loop. */
export function enableBrowserWatch(store:Store,browserId:string,
  inventory:ConnectedChatCandidate[]):{browserId:string;baseline:number} {
  if(!/^[A-Za-z0-9:._-]{1,200}$/.test(browserId))
    throw new Error('Browser watch requires an explicitly selected Chrome profile');
  const existing=watchedBrowser(store);
  if(existing&&existing!==browserId)
    throw new Error('Browser watch already bound to a different profile; disable first');
  if(existing)return {browserId,baseline:Object.keys(seen(store)).length};
  const baseline:Record<string,string|null>={};
  for(const item of inventory){
    if(item.duplicate)continue;
    baseline[item.urlSha256]=item.lastUserSha256;
  }
  store.setMeta(SEEN,JSON.stringify(baseline));
  store.setMeta(CURSOR,'');
  store.setMeta(PROFILE,browserId);
  return {browserId,baseline:Object.keys(baseline).length};
}

export function disableBrowserWatch(store:Store):void {
  store.setMeta(PROFILE,'');
  store.setMeta(SEEN,'');
  store.setMeta(CURSOR,'');
}

/** Rotate discovery across all connected tabs. A permanently incomplete
 * earlier chat must not starve later chats waiting for adoption. */
export function orderedBrowserWatchCandidates(store:Store,browserId:string,
  inventory:ConnectedChatCandidate[]):ConnectedChatCandidate[]{
  if(watchedBrowser(store)!==browserId)return [];
  const last=store.getMeta(CURSOR);
  const index=inventory.findIndex(item=>item.urlSha256===last);
  return index<0?inventory:[...inventory.slice(index+1),...inventory.slice(0,index+1)];
}

export function recordBrowserWatchAttempt(store:Store,browserId:string,
  item:ConnectedChatCandidate):void {
  if(watchedBrowser(store)!==browserId)
    throw new Error('Chrome profile watch was revoked before discovery');
  store.setMeta(CURSOR,item.urlSha256);
}

/** Never adopt duplicate URLs (two tabs at the same direct URL). New tabs
 * and newly sent human prompts are candidates; the actual reply must still
 * pass a separate stable-read check before a Mission is created. */
export function nextBrowserWatchCandidate(store:Store,browserId:string,
  inventory:ConnectedChatCandidate[]):ConnectedChatCandidate|null {
  if(watchedBrowser(store)!==browserId)return null;
  const prior=seen(store);
  return inventory.find(item=>!item.duplicate&&item.lastUserSha256!==null&&
    prior[item.urlSha256]!==item.lastUserSha256)??null;
}

export function acknowledgeBrowserWatchCandidate(store:Store,browserId:string,
  item:ConnectedChatCandidate):void {
  if(watchedBrowser(store)!==browserId)
    throw new Error('Browser profile watch was revoked before checkpoint; no new Send');
  if(item.duplicate||!item.lastUserSha256)
    throw new Error('Cannot checkpoint an ambiguous or empty browser candidate');
  const values=seen(store);
  values[item.urlSha256]=item.lastUserSha256;
  // Bound local observation history; the authoritative Mission history is
  // separately retained in SQLite and never pruned by this housekeeping.
  const entries=Object.entries(values).slice(-500);
  store.setMeta(SEEN,JSON.stringify(Object.fromEntries(entries)));
}
