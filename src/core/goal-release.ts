import {createHash} from 'node:crypto';
import type {Store} from './store.js';
import {GoalLedger,type GoalGraph} from './goal-store.js';
import {inspectGoalRequestLedger} from './request-ledger.js';

/** WP5 is an independent, fail-closed release gate, NOT a new PI scheduler.
 * All model / PI work-item PASS records remain untrusted claims.
 * Only a caller-owned evidence probe may supply an independently observed
 * receipt. Trusted Chrome, maintenance, GMK and work probes are wired into
 * the operator CLI; there is deliberately
 * no CLI command that accepts a user/model-supplied PASS flag or receipt. */
export const RELEASE_GATES=[
  'check','privacy-check','test','build','ci-ubuntu','ci-macos','ci-windows',
  'chrome-10-to-11','maintenance-resume',
  'relay-tab-retirement','gmk-production-readback',
] as const;
export type ReleaseGate=typeof RELEASE_GATES[number];
export type ReleaseState='PENDING'|'PASS'|'FAIL'|'BLOCKED';
export type ReleaseRequirement=ReleaseGate|`criterion:${string}`;
export interface ReleaseTarget {
  goalId:string;targetSha:string;goalVersion:number;planId:string;
  planVersion:number;graphSha256:string;revision:number;createdAt:string;
}
export interface ReleaseCheck {
  requirement:string;targetSha:string;state:ReleaseState;source:string|null;
  reference:string|null;proofSha256:string|null;verifiedAt:string|null;
  expiresAt:string|null;revision:number;
}
export interface ReleaseReport {
  target:ReleaseTarget|null;checks:ReleaseCheck[];complete:boolean;
  ready:boolean;blockers:string[];
}
export interface EvidenceReadback {
  state:Exclude<ReleaseState,'PENDING'>;
  /** A verifiable tool log or immutable receipt locator, never answer prose. */
  reference:string;
  /** Digest of original raw independent readback, not a model summary. */
  proofSha256:string;
  /** Repository commit or production runtime commit ACTUALLY observed. */
  observedSha:string;
}
/** The source is fixed by the controller rather than claimed by the model. */
export interface ReleaseProbe {
  source:string;
  inspect:(requirement:string,targetSha:string)=>Promise<EvidenceReadback>;
}
/** Missing independent observations are not failures of an observed test.
 * Unlike a forged or contradictory receipt, they leave the release PENDING.
 * This is an internal typed signal, never a model-supplied verdict. */
export class InsufficientReleaseEvidenceError extends Error {
  constructor(message:string){super(message);this.name='InsufficientReleaseEvidenceError';}
}
export type ReleaseProbeOutcome={
  verdict:'PASS'|'FAIL'|'INSUFFICIENT_EVIDENCE';
  requirement:string;targetSha:string;source:string;
  reference?:string;proofSha256?:string;reason?:string;
};
/** Side-effect-free with respect to the release ledger: surface the three
 * machine-readable outcomes without manufacturing a FAIL/PASS receipt for
 * missing evidence. The underlying first-party probe may save private raw
 * readbacks; this function cannot alter Goal acceptance or Mission state. */
export async function inspectReleaseProbeOutcome(requirement:string,targetSha:string,
  probe:ReleaseProbe):Promise<ReleaseProbeOutcome>{
  const base={requirement,targetSha,source:probe.source};
  if(!shaPattern.test(targetSha)||!approvedReleaseEvidenceSource(requirement,probe.source))
    return {...base,verdict:'FAIL',reason:'Unapproved source or target revision'};
  try{
    const evidence=await probe.inspect(requirement,targetSha);
    if(!['PASS','FAIL','BLOCKED'].includes(evidence.state)||
      !proofPattern.test(evidence.proofSha256)||
      typeof evidence.reference!=='string'||evidence.reference.length>512||
      !/^[a-zA-Z0-9][a-zA-Z0-9:./_#?=+%&-]{4,511}$/.test(evidence.reference)||
      !shaPattern.test(evidence.observedSha)||
      evidence.observedSha!==targetSha)
      return {...base,verdict:'FAIL',reason:'Invalid or mismatched independent readback'};
    return {...base,verdict:evidence.state==='PASS'?'PASS':'FAIL',
      reference:evidence.reference,proofSha256:evidence.proofSha256,
      ...(evidence.state==='BLOCKED'?{reason:'Trusted probe reported blocked evidence'}:{})};
  }catch(error){
    return error instanceof InsufficientReleaseEvidenceError
      ?{...base,verdict:'INSUFFICIENT_EVIDENCE',reason:error.message}
      :{...base,verdict:'FAIL',reason:'Trusted probe rejected contradictory or invalid evidence'};
  }
}
type TargetRow={goal_id:string;target_sha:string;goal_version:number;plan_id:string;
  plan_version:number;graph_sha256:string;revision:number;created_at:string};
type CheckRow={requirement:string;target_sha:string;state:ReleaseState;
  source:string|null;reference:string|null;proof_sha256:string|null;
  verified_at:string|null;expires_at:string|null;revision:number};
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const shaPattern=/^[a-f0-9]{40}$/;
const proofPattern=/^[a-f0-9]{64}$/;
const TTL_MS=24*60*60*1000;
const sourceFor=(requirement:string):string|null=>
  /^criterion:[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(requirement)?'independent-work':
  ['check','privacy-check','test','build'].includes(requirement)?'local-command':
  ['ci-ubuntu','ci-macos','ci-windows'].includes(requirement)?'github-actions':
  requirement==='gmk-production-readback'?'gmk-readback':
  requirement==='maintenance-resume'?'maintenance-readback':
  ['chrome-10-to-11','mission-32-successor','relay-tab-retirement'].includes(requirement)
    ?'chrome-readback':null;
/** Shared requirement-to-probe binding for release admission and the
 * read-only coverage index. GitHub CI may additionally attest source
 * check/privacy/test/build scripts, never Chrome, GMK or business gates. */
export const approvedReleaseEvidenceSource=(requirement:string,source:string|null):boolean=>{
  const expected=sourceFor(requirement);
  return expected!==null&&(source===expected||
    (source==='github-actions'&&
      ['check','privacy-check','test','build'].includes(requirement)));
};
const TERMINAL_GATE_KEY='v1-independent-release-gate';
const TERMINAL_PENDING='terminal PI release work or acceptance not yet passed';
/** The release work item must remain open while its independent receipts are
 * collected. Bind its immutable identity and criterion text, but not the
 * PI-controlled status/evidence that is expected to change after bootstrap.
 * All non-terminal work keeps the original strict version/status fence. */
const graphSignature=(graph:GoalGraph,planId:string):string=>digest({
  goalVersion:graph.goal.version,
  plan:graph.plans.filter(x=>x.id===planId).map(x=>[x.id,x.version,x.status]),
  items:graph.items.filter(x=>x.planId===planId)
    .map(x=>x.key===TERMINAL_GATE_KEY
      ?[x.id,x.key,x.title,x.description,x.priority]
      :[x.id,x.version,x.status,x.evidenceRefs]),
  criteria:graph.acceptance.filter(x=>graph.items.some(w=>w.planId===planId&&w.id===x.itemId))
    .map(x=>graph.items.some(w=>w.id===x.itemId&&w.key===TERMINAL_GATE_KEY)
      ?[x.id,x.itemId,x.criterion]
      :[x.id,x.version,x.status,x.evidenceRefs]),
});
const immutableGraph=(graph:GoalGraph)=>{
  const plans=graph.plans.filter(p=>p.status==='APPROVED');
  if(graph.goal.status!=='ACTIVE'||plans.length!==1)
    throw new Error('Release requires one approved, active Goal plan');
  const plan=plans[0]!;
  const items=graph.items.filter(i=>i.planId===plan.id);
  const ids=new Set(items.map(x=>x.id));
  const criteria=graph.acceptance.filter(x=>ids.has(x.itemId));
  const terminal=items.find(x=>x.key===TERMINAL_GATE_KEY);
  if(!items.length||!criteria.length||
    items.some(i=>i!==terminal&&i.status!=='PASSED')||
    criteria.some(c=>c.itemId!==terminal?.id&&c.status!=='PASS')||
    (terminal&&!['IN_PROGRESS','REVIEW','PASSED'].includes(terminal.status)))
    throw new Error('PI work and claimed criteria must pass before independent release verification');
  const terminalCriteria=criteria.filter(c=>c.itemId===terminal?.id);
  if(terminal&&(!terminalCriteria.length||
    terminalCriteria.some(c=>c.status==='FAIL'||c.status==='BLOCKED')||
    (terminal.status==='PASSED'&&terminalCriteria.some(c=>c.status!=='PASS'))))
    throw new Error('Terminal release work or acceptance is inconsistent');
  const terminalReviewed=!terminal||graph.events.some(e=>
    e.type==='goal.pi_review'&&e.payload.itemId===terminal.id&&
    e.payload.verdict==='PASS'&&
    typeof e.payload.answerSha256==='string'&&
    proofPattern.test(e.payload.answerSha256)&&
    terminal.evidenceRefs.length===1&&
    terminal.evidenceRefs[0]===`browser-sha256:${e.payload.answerSha256}`&&
    terminalCriteria.every(c=>c.evidenceRefs.length===1&&
      c.evidenceRefs[0]===`browser-sha256:${e.payload.answerSha256}`));
  return {plan,criteria,signature:graphSignature(graph,plan.id),
    terminalPending:!!terminal&&(terminal.status!=='PASSED'||
      terminalCriteria.some(c=>c.status!=='PASS')||!terminalReviewed)};
};
const checksFor=(graph:GoalGraph):string[]=>{
  const {criteria}=immutableGraph(graph);
  return [...RELEASE_GATES,...criteria.map(x=>`criterion:${x.id}`)];
};
const rowTarget=(r:TargetRow):ReleaseTarget=>({
  goalId:r.goal_id,targetSha:r.target_sha,goalVersion:r.goal_version,
  planId:r.plan_id,planVersion:r.plan_version,graphSha256:r.graph_sha256,
  revision:r.revision,createdAt:r.created_at,
});
const rowCheck=(r:CheckRow):ReleaseCheck=>({
  requirement:r.requirement,targetSha:r.target_sha,state:r.state,
  source:r.source,reference:r.reference,proofSha256:r.proof_sha256,
  verifiedAt:r.verified_at,expiresAt:r.expires_at,revision:r.revision,
});

/** PI's PASS records do not fence an already-reserved browser Send. The
 * independent Goal custodian must see every original request settled, every
 * observation reviewed and the active chain at a quiescent checkpoint before
 * a release can be finalized. This reads durable SQLite only; it neither
 * changes a pause nor interacts with Chrome or Telegram. */
export function goalReleaseCustodyBlockers(store:Store,goalId:string):string[]{
  const custody=inspectGoalRequestLedger(store,goalId);
  const blockers:string[]=[];
  if(!custody.ledgerConsistent||custody.quarantineEventIds.length||
    custody.unattributedEventIds.length)
    blockers.push('Goal request custody audit is inconsistent');
  // A reconciliation marker without a durable, matched original browser
  // observation is not independently proven settlement.
  if(custody.requests.some(r=>r.status!=='observed'))
    blockers.push('unsettled Goal browser request');
  if(custody.requests.some(r=>r.status==='observed'&&r.decisionEventId===null))
    blockers.push('observed Goal answer awaits PI review');
  if(custody.missionIds.some(id=>['READY','RUNNING','VERIFYING'].includes(store.get(id).state)))
    blockers.push('Goal Mission is still executing');
  return blockers;
}
/** Incomplete live work is a missing release observation, not a falsified
 * PASS. Contradictory original request lineage is an actual failed probe. */
export function requireSettledReleaseCustody(store:Store,goalId:string):void{
  const blockers=goalReleaseCustodyBlockers(store,goalId);
  if(blockers.includes('Goal request custody audit is inconsistent'))
    throw new Error('Goal original request custody is contradictory');
  if(blockers.length)
    throw new InsufficientReleaseEvidenceError(
      'Goal lacks settled, PI-reviewed original requests or a quiescent Mission checkpoint');
}

export class GoalReleaseGate {
  private readonly ledger:GoalLedger;
  constructor(private readonly store:Store){this.ledger=new GoalLedger(store);}
  private event(id:string,type:string,payload:Record<string,unknown>):void{
    this.store.db.prepare('INSERT INTO goal_events(goal_id,created_at,type,payload_json) VALUES(?,?,?,?)')
      .run(id,new Date().toISOString(),type,JSON.stringify(payload));
  }
  report(goalId:string):ReleaseReport{
    const goal=this.ledger.getGoal(goalId);
    const graph=this.ledger.graph(goalId);
    const row=this.store.db.prepare('SELECT * FROM goal_release_targets WHERE goal_id=?')
      .get(goalId) as TargetRow|undefined;
    const target=row?rowTarget(row):null;
    const checks=(this.store.db.prepare(
      'SELECT * FROM goal_release_checks WHERE goal_id=? ORDER BY requirement'
    ).all(goalId) as CheckRow[]).map(rowCheck);
    const complete=!!this.store.db.prepare(
      'SELECT 1 FROM goal_release_completion WHERE goal_id=?'
    ).get(goalId);
    const blockers:string[]=[];
    if(!target)blockers.push('no release target');
    else{
      if(!graph.events.some(e=>e.type==='goal.release_target'&&
        e.payload.targetSha===target.targetSha&&
        e.payload.revision===target.revision&&
        e.payload.graphSha256===target.graphSha256&&
        e.payload.goalVersion===target.goalVersion&&
        e.payload.planId===target.planId&&
        e.payload.planVersion===target.planVersion))
        blockers.push('release target has no matching audit event');
      try{
        const {plan,signature,terminalPending}=immutableGraph(
          complete?{...graph,goal:{...graph.goal,status:'ACTIVE'}}:graph);
        if(target.goalVersion!==goal.version||target.planId!==plan.id||
          target.planVersion!==plan.version||target.graphSha256!==signature)
          blockers.push('Goal graph/version changed');
        if(terminalPending)blockers.push(TERMINAL_PENDING);
        const required=checksFor(complete?{...graph,goal:{...graph.goal,status:'ACTIVE'}}:graph);
        const actual=new Set(checks.map(c=>c.requirement));
        if(required.some(id=>!actual.has(id))||checks.some(c=>!required.includes(c.requirement)))
          blockers.push('release requirement set changed');
      }catch{blockers.push('work or acceptance no longer passed');}
      blockers.push(...goalReleaseCustodyBlockers(this.store,goalId));
      const time=Date.now();
      for(const check of checks){
        const last=graph.events.filter(e=>e.type==='goal.release_evidence'&&
          e.payload.requirement===check.requirement&&
          e.payload.revision===check.revision).at(-1);
        const matchesAudit=check.state==='PENDING'?last===undefined:
          last?.payload.state===check.state&&last?.payload.source===check.source&&
          last?.payload.reference===check.reference&&
          last?.payload.proofSha256===check.proofSha256&&
          last?.payload.targetSha===check.targetSha&&
          last?.payload.verifiedAt===check.verifiedAt&&
          last?.payload.expiresAt===check.expiresAt;
        if(!matchesAudit||
          check.targetSha!==target.targetSha||check.revision!==target.revision||
          check.state!=='PASS'||!check.proofSha256||!proofPattern.test(check.proofSha256)||
          !approvedReleaseEvidenceSource(check.requirement,check.source)||
          !check.reference||!check.verifiedAt||!check.expiresAt||
          !Number.isFinite(Date.parse(check.verifiedAt))||
          Date.parse(check.verifiedAt)>time||
          !Number.isFinite(Date.parse(check.expiresAt))||
          Date.parse(check.expiresAt)<=time)
          blockers.push(check.requirement);
      }
    }
    return {target,checks,complete,ready:!!target&&blockers.length===0,blockers};
  }
  /** Establish evidence requirements after non-terminal PI claims pass.
   * The terminal release item remains in progress until independent probes
   * finish; its own PI acceptance MUST pass before the final ready state.
   * Starting a different Git SHA discards the current readiness, not its
   * immutable event history. No old browser Send or Mission is modified. */
  begin(goalId:string,targetSha:string):ReleaseReport{
    if(!shaPattern.test(targetSha))throw new Error('Release target must be an exact Git SHA');
    return this.store.atomic(()=>{
      if(this.ledger.getGoal(goalId).status==='DONE')
        throw new Error('Completed Goal cannot be re-targeted');
      const graph=this.ledger.graph(goalId),{plan,signature}=immutableGraph(graph);
      const previous=this.report(goalId).target;
      if(previous?.targetSha===targetSha&&previous.graphSha256===signature)
        return this.report(goalId);
      const revision=(previous?.revision??0)+1,at=new Date().toISOString();
      this.store.db.prepare(`INSERT INTO goal_release_targets
        (goal_id,target_sha,goal_version,plan_id,plan_version,graph_sha256,revision,created_at)
        VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(goal_id) DO UPDATE SET
          target_sha=excluded.target_sha,goal_version=excluded.goal_version,
          plan_id=excluded.plan_id,plan_version=excluded.plan_version,
          graph_sha256=excluded.graph_sha256,revision=excluded.revision,
          created_at=excluded.created_at`)
        .run(goalId,targetSha,graph.goal.version,plan.id,plan.version,signature,revision,at);
      this.store.db.prepare('DELETE FROM goal_release_checks WHERE goal_id=?').run(goalId);
      for(const requirement of checksFor(graph))
        this.store.db.prepare(`INSERT INTO goal_release_checks
          (goal_id,requirement,target_sha,state,revision) VALUES(?,?,?,'PENDING',?)`)
          .run(goalId,requirement,targetSha,revision);
      this.event(goalId,'goal.release_target',{targetSha,planId:plan.id,
        planVersion:plan.version,goalVersion:graph.goal.version,graphSha256:signature,revision});
      return this.report(goalId);
    });
  }
  /** There is deliberately NO recordPass(status, reference) API. A verified
   * observation must be obtained from the controller's independent probe. */
  async inspect(goalId:string,requirement:string,probe:ReleaseProbe):Promise<ReleaseReport>{
    const before=this.report(goalId);
    const allowedPending=new Set([...goalReleaseCustodyBlockers(this.store,goalId),
      TERMINAL_PENDING]);
    if(!before.target||!before.checks.some(c=>c.requirement===requirement)||
      !before.blockers.every(b=>allowedPending.has(b)||
        before.checks.some(c=>c.requirement===b)))
      throw new Error('Release target or Goal graph invalid; re-plan or re-target first');
    if(!approvedReleaseEvidenceSource(requirement,probe.source))
      throw new Error('Independent evidence source does not match the requirement');
    const receipt=await probe.inspect(requirement,before.target.targetSha);
    if(!['PASS','FAIL','BLOCKED'].includes(receipt.state)||
      typeof receipt.reference!=='string'||receipt.reference.length>512||
      !/^[a-zA-Z0-9][a-zA-Z0-9:./_#?=+%&-]{4,511}$/.test(receipt.reference)||
      !proofPattern.test(receipt.proofSha256)||
      !shaPattern.test(receipt.observedSha)||
      receipt.observedSha!==before.target.targetSha)
      throw new Error('Evidence has no valid independent reference, digest or matching target SHA');
    return this.store.atomic(()=>{
      const after=this.report(goalId);
      if(!after.target||after.target.revision!==before.target!.revision||
        after.target.graphSha256!==before.target!.graphSha256||
        after.target.targetSha!==before.target!.targetSha||
        after.blockers.some(b=>!allowedPending.has(b)&&
          !after.checks.some(c=>c.requirement===b)))
        throw new Error('Goal release target changed while verifying evidence');
      if(after.complete)throw new Error('Completed Goal cannot accept new evidence');
      const at=new Date(),expiry=new Date(at.getTime()+TTL_MS),current=after.checks
        .find(x=>x.requirement===requirement)!;
      this.store.db.prepare(`UPDATE goal_release_checks SET
        state=?,source=?,reference=?,proof_sha256=?,verified_at=?,expires_at=?
        WHERE goal_id=? AND requirement=? AND revision=?`)
        .run(receipt.state,probe.source,receipt.reference,receipt.proofSha256,
          at.toISOString(),expiry.toISOString(),goalId,requirement,current.revision);
      this.event(goalId,'goal.release_evidence',{requirement,targetSha:after.target.targetSha,
        revision:after.target.revision,state:receipt.state,source:probe.source,
        reference:receipt.reference,proofSha256:receipt.proofSha256,
        observedSha:receipt.observedSha,verifiedAt:at.toISOString(),
        expiresAt:expiry.toISOString()});
      return this.report(goalId);
    });
  }
  /** Final readback is mandatory: even all-green stored attestations cannot
   * finalize a different branch head or a changed project version. */
  async finalize(goalId:string,readCurrentMainSha:()=>Promise<string>):Promise<ReleaseReport>{
    const before=this.report(goalId);
    if(before.complete)return before;
    if(!before.ready||!before.target)
      throw new Error('Goal DONE denied: missing, failed, stale or invalid release evidence');
    const actual=await readCurrentMainSha();
    if(!shaPattern.test(actual)||actual!==before.target.targetSha)
      throw new Error('Goal DONE denied: independent main SHA readback differs');
    return this.store.atomic(()=>{
      const after=this.report(goalId);
      if(!after.ready||!after.target||
        after.target.revision!==before.target!.revision||
        after.target.graphSha256!==before.target!.graphSha256||
        after.target.targetSha!==actual)
        throw new Error('Goal DONE denied: evidence changed while finalizing');
      const at=new Date().toISOString();
      const proof=digest(after.checks.map(c=>[c.requirement,c.proofSha256,c.verifiedAt,c.expiresAt]));
      this.store.db.prepare(`INSERT INTO goal_release_completion
        (goal_id,target_sha,graph_sha256,completed_at,evidence_sha256)
        VALUES(?,?,?,?,?)`).run(goalId,actual,after.target.graphSha256,at,proof);
      this.event(goalId,'goal.release_done',{targetSha:actual,
        revision:after.target.revision,graphSha256:after.target.graphSha256,
        evidenceSha256:proof,requirementCount:after.checks.length});
      return this.report(goalId);
    });
  }
}
