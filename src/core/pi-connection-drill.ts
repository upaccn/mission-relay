import {createHash} from 'node:crypto';
import type {Store} from './store.js';

/** Operator-only, one-shot fault of one PI recovery *client connection*.
 * Never changes Chrome permissions, tabs, host routing or the original Send.
 * An expiration is an independent fail-safe even if the Worker never runs. */
interface ArmedDrill {
  revision:number; requestKey:string; promptSha256:string; assistantSha256:string;
  chatUrlSha256:string; browserSha256:string; expiresAt:number;
}
const key=(id:string)=>`pi.recovery.connection_drill.${id}`;
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');

function eligible(store:Store,id:string,revision:number):ArmedDrill {
  const m=store.get(id),r=store.chatBrowserTurn(id);
  const url=store.chatLink(id),browser=store.chatBrowserBinding(id);
  const plan=store.piPlan(id);
  if(m.version!==revision||m.state!=='PAUSED'||m.stopRequested||m.lastError||
     m.ownerPid!==null||m.turnCount<1||m.turnCount>=m.maxTurns||
     store.getMeta(`pi.autopilot.enabled.${id}`)!=='1'||
     !store.hasVerifiedPiBrowserCheckpoint(id)||
     !r||!['observed','reconciled'].includes(r.status)||
     !r.assistantSha256||!url||!browser||
     (plan?.round===m.turnCount&&!['NEXT','HANDOFF'].includes(plan.action))||
     store.channelDrainRequested('telegram')||
     store.list().some(other=>['RUNNING','VERIFYING'].includes(other.state)))
    throw new Error('Scoped connection drill requires a settled, eligible PI checkpoint and zero active Sends');
  return {revision,requestKey:r.requestKey,promptSha256:r.promptSha256,
    assistantSha256:r.assistantSha256,chatUrlSha256:sha(url),
    browserSha256:sha(browser),expiresAt:0};
}

export function armScopedPiConnectionDrill(store:Store,id:string,revision:number,
  ttlSeconds=90,now=Date.now()):{expiresAt:string;requestKey:string;revision:number}{
  if(!Number.isInteger(ttlSeconds)||ttlSeconds<5||ttlSeconds>120)
    throw new Error('Scoped connection drill TTL must be 5–120 seconds');
  return store.atomic(()=>{
    const d=eligible(store,id,revision);
    const prior=store.getMeta(key(id));
    if(prior){
      const previous=JSON.parse(prior) as ArmedDrill;
      if(previous.expiresAt>now)
        throw new Error('A scoped connection drill is already armed');
    }
    d.expiresAt=now+ttlSeconds*1000;
    store.setMeta(key(id),JSON.stringify(d));
    store.db.prepare(`INSERT INTO events(mission_id,created_at,type,payload_json)
      VALUES(?,?,?,?)`).run(id,new Date(now).toISOString(),
        'pi.recovery_connection_drill_armed',JSON.stringify({
          revision,requestKey:d.requestKey,assistantSha256:d.assistantSha256,
          expiresAt:new Date(d.expiresAt).toISOString(),scope:'single recovery client connection',
        }));
    return {expiresAt:new Date(d.expiresAt).toISOString(),requestKey:d.requestKey,revision};
  });
}

/** Called only after opening the *exact pinned* PI recovery session, BEFORE
 * any DOM read or continuation. Consume atomically before closing its own
 * connection; the next controller pass opens a fresh unaffected connection. */
export function consumeScopedPiConnectionDrill(store:Store,id:string,now=Date.now()):boolean {
  // Do not acquire a SQLite write transaction on the default, unarmed path.
  if(!store.getMeta(key(id)))return false;
  return store.atomic(()=>{
    const raw=store.getMeta(key(id));
    if(!raw)return false;
    const d=JSON.parse(raw) as ArmedDrill;
    // A stale marker cannot cause a late outage, even after process restart.
    if(d.expiresAt<=now){
      store.db.prepare('DELETE FROM meta WHERE key=?').run(key(id));
      return false;
    }
    let current:ArmedDrill;
    try { current=eligible(store,id,d.revision); }
    catch { return false; } // Wait for TTL, never fault a changed or active Mission.
    if(current.requestKey!==d.requestKey||current.promptSha256!==d.promptSha256||
       current.assistantSha256!==d.assistantSha256||
       current.chatUrlSha256!==d.chatUrlSha256||
       current.browserSha256!==d.browserSha256)return false;
    store.db.prepare('DELETE FROM meta WHERE key=?').run(key(id));
    store.db.prepare(`INSERT INTO events(mission_id,created_at,type,payload_json)
      VALUES(?,?,?,?)`).run(id,new Date(now).toISOString(),
        'pi.recovery_connection_drill_triggered',JSON.stringify({
          revision:d.revision,requestKey:d.requestKey,assistantSha256:d.assistantSha256,
          scope:'single recovery client connection',
        }));
    return true;
  });
}

/** An arm/consume receipt alone does not prove a Playwriter connection closed.
 * Add the separate close acknowledgement only after BrowserSession.close()
 * fulfilled. A crash or rejected close leaves the attempted drill incomplete. */
export function attestScopedPiConnectionClosed(store:Store,id:string):void {
  store.atomic(()=>{
    const lastTrigger=store.db.prepare(`SELECT id,payload_json FROM events
      WHERE mission_id=? AND type='pi.recovery_connection_drill_triggered'
      ORDER BY id DESC LIMIT 1`).get(id) as
      {id:number;payload_json:string}|undefined;
    const lastClosed=store.db.prepare(`SELECT id FROM events
      WHERE mission_id=? AND type='pi.recovery_connection_drill_client_closed'
      ORDER BY id DESC LIMIT 1`).get(id) as {id:number}|undefined;
    if(!lastTrigger||(lastClosed&&lastClosed.id>lastTrigger.id))
      throw new Error('Connection drill close attestation requires an unacknowledged trigger');
    const evidence=JSON.parse(lastTrigger.payload_json) as
      {requestKey?:string;assistantSha256?:string};
    store.db.prepare(`INSERT INTO events(mission_id,created_at,type,payload_json)
      VALUES(?,?,?,?)`).run(id,new Date().toISOString(),
        'pi.recovery_connection_drill_client_closed',JSON.stringify({
          requestKey:evidence.requestKey,assistantSha256:evidence.assistantSha256,
          scope:'single recovery client connection',
        }));
  });
}

export function scopedPiConnectionDrillStatus(store:Store,id:string,now=Date.now()){
  store.get(id);
  const raw=store.getMeta(key(id));
  if(!raw)return {armed:false,expired:false};
  const {revision,requestKey,expiresAt}=JSON.parse(raw) as ArmedDrill;
  return {armed:expiresAt>now,expired:expiresAt<=now,revision,requestKey,
    expiresAt:new Date(expiresAt).toISOString()};
}
