import {createHash} from 'node:crypto';
import {Store} from './store.js';
import {GoalLedger} from './goal-store.js';
import {validateRemoteProjectPath,type PiPlanner,type StagedPiInferenceEvidence} from './pi-planner.js';

const sha=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const REVIEW_TTL_MS=15*60_000;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH=/^[a-f0-9]{64}$/;
export const STAGED_BASELINE_SOURCES={
  controller:'sqlite-controller',git:'github-main',ci:'github-actions',
  worker:'leased-gmk-worker',sqlite:'independent-sqlite',
  chrome:'connected-playwriter',pi:'pictl-default-invocation',
} as const;
export type StageBaselineDimensions={
  [K in keyof typeof STAGED_BASELINE_SOURCES]:{
    source:(typeof STAGED_BASELINE_SOURCES)[K];evidenceSha256:string;
  }
};
export interface StageOperationalBaseline {
  checkpointSha256:string;capturedAt:string;
  dimensions:StageBaselineDimensions;baselineSha256:string;
}

export interface StagedGoalRecord {
  goalId:string;missionId:string;ownerId:number;commandId:string;
  payloadSha256:string;anchorId:string;anchorUrlSha256:string;browserId:string;
  workspace:string;missionVersion:number;goalVersion:number;
  createdAt:string;checkpointSha256:string;
}
interface StageReview {
  checkpointSha256:string;baselineSha256:string;
  verdict:'APPROVE'|'REJECT';summary:string;
  reviewerResultSha256:string;reviewedAt:string;
  inference:StagedPiInferenceEvidence;
}
export interface StageReadback {
  record:StagedGoalRecord;currentSha256:string;unchanged:boolean;
  goalStatus:string;missionState:string;turnCount:number;
  browserReservations:number;parentId:string|null;review:StageReview|null;
  baseline:StageOperationalBaseline|null;activated:boolean;
}

/** Stage approval is a short-lived authorization to activate, not a durable
 * PASS. Use the same clock window in the owner command and PI controller so
 * an expired APPROVE cannot strand a held Goal behind a misleading response. */
export function isFreshStagedApproval(review:StageReadback['review'],
  now=Date.now()):boolean {
  if(review?.verdict!=='APPROVE'||!Number.isFinite(now))return false;
  const reviewedAt=Date.parse(review.reviewedAt);
  return Number.isFinite(reviewedAt)&&now>=reviewedAt&&
    now-reviewedAt<=REVIEW_TTL_MS;
}
export interface StageOwnerRequest {
  ownerId:number;commandId:string;objective:string;workspace:string;
}

/** All four transitions use the original SQLite writer. Staging is allowed
 * alongside a live old Mission, but it has no Chat link, no browser Send and
 * no dispatch eligibility until the independent reviewed checkpoint passes
 * a fresh activation gate. Never put a live URL or request body in Git. */
export class StagedGoalIntake {
  constructor(private readonly store:Store){}
  private record(goalId:string):StagedGoalRecord {
    if(!UUID.test(goalId))throw new Error('Expected complete staged Goal UUID');
    const raw=this.store.getMeta(`goal.stage.record.${goalId}`);
    if(!raw)throw new Error('Unknown staged Goal');
    return JSON.parse(raw) as StagedGoalRecord;
  }
  private review(goalId:string):StageReview|null {
    const value=this.store.getMeta(`goal.stage.review.${goalId}`);
    if(!value)return null;
    const review=JSON.parse(value) as StageReview;
    const event=new GoalLedger(this.store).graph(goalId).events
      .filter(e=>e.type==='goal.stage_pi_reviewed').at(-1);
    if(!event||event.createdAt!==review.reviewedAt||
      event.payload.checkpointSha256!==review.checkpointSha256||
      event.payload.baselineSha256!==review.baselineSha256||
      event.payload.verdict!==review.verdict||
      event.payload.reviewerResultSha256!==review.reviewerResultSha256||
      JSON.stringify(event.payload.inference)!==JSON.stringify(review.inference))
      throw new Error('Staged PI review no longer matches its immutable audit event');
    return review;
  }
  private baseline(goalId:string):StageOperationalBaseline|null {
    const raw=this.store.getMeta(`goal.stage.baseline.${goalId}`);
    if(!raw)return null;
    const value=JSON.parse(raw) as StageOperationalBaseline;
    const expected=sha({checkpointSha256:value.checkpointSha256,
      capturedAt:value.capturedAt,dimensions:value.dimensions});
    const event=new GoalLedger(this.store).graph(goalId).events
      .filter(e=>e.type==='goal.stage_baseline_attested').at(-1);
    if(!event||event.createdAt!==value.capturedAt||
      event.payload.baselineSha256!==value.baselineSha256||
      event.payload.checkpointSha256!==value.checkpointSha256||
      JSON.stringify(event.payload.dimensions)!==JSON.stringify(value.dimensions)||
      expected!==value.baselineSha256||!HASH.test(expected)||
      !Object.keys(STAGED_BASELINE_SOURCES).every(key=>{
        const k=key as keyof StageBaselineDimensions;
        return value.dimensions?.[k]?.source===STAGED_BASELINE_SOURCES[k]&&
          HASH.test(value.dimensions[k].evidenceSha256);
      })||Object.keys(value.dimensions??{}).length!==7)
      throw new Error('Staged seven-dimensional baseline does not match immutable audit custody');
    return value;
  }
  /** Historical Mission events cannot be substituted by a newly written
   * record. Capture the entire pre-dispatch event chain for this one root. */
  private snapshot(record:StagedGoalRecord):string {
    const ledger=new GoalLedger(this.store);
    const goal=ledger.getGoal(record.goalId),mission=this.store.get(record.missionId);
    const graph=ledger.graph(record.goalId);
    return sha({
      record:{...record,checkpointSha256:undefined},
      goal:{id:goal.id,requestKey:goal.requestKey,objective:goal.objective,
        priority:goal.priority,status:goal.status,version:goal.version},
      mission,missionEvents:this.store.events(mission.id),
      goalEvents:graph.events.filter(e=>
        e.type!=='goal.stage_pi_reviewed'&&e.type!=='goal.stage_baseline_attested'),
      plans:graph.plans,items:graph.items,acceptance:graph.acceptance,
      binding:ledger.missionGoalId(mission.id),
      parent:this.store.piChainParent(mission.id),
      piEnabled:this.store.getMeta(`pi.autopilot.enabled.${mission.id}`),
      hold:this.store.getMeta(`goal.stage.hold.${mission.id}`),
      chatLink:this.store.chatLink(mission.id),
      browserBinding:this.store.chatBrowserBinding(mission.id),
      browserReceipt:this.store.chatBrowserTurn(mission.id),
      originalAnchorId:this.store.getMeta('telegram.chatgpt.anchorMissionId'),
      originalAnchorUrlSha256:sha(this.store.chatLink(record.anchorId)),
      originalAnchorBrowserId:this.store.chatBrowserBinding(record.anchorId),
    });
  }
  stage(input:StageOwnerRequest):StageReadback {
    if(!Number.isSafeInteger(input.ownerId)||input.ownerId<=0||
      !/^\d+$/.test(input.commandId)||input.commandId.length>30)
      throw new Error('Staging requires an authenticated owner and Telegram update ID');
    const objective=input.objective.trim();
    if(!objective||objective.length>4000)
      throw new Error('Staged Goal must contain 1–4000 characters');
    if(input.workspace){
      validateRemoteProjectPath(input.workspace);
      if(this.store.getMeta('telegram.build.project')!==input.workspace||
        this.store.getMeta('telegram.pi.project')!==input.workspace)
        throw new Error('Staged write scope requires existing matching local approval');
    }
    const anchorId=this.store.getMeta('telegram.chatgpt.anchorMissionId');
    if(!anchorId)throw new Error('Approved Chrome anchor missing; staging refused');
    const anchorUrl=this.store.chatLink(anchorId);
    const browserId=this.store.chatBrowserBinding(anchorId);
    if(!anchorUrl||!browserId)throw new Error('Approved Chrome anchor binding missing');
    const requestKey=`telegram-goal-stage-${input.commandId}`;
    const payloadSha256=sha({
      ownerId:input.ownerId,commandId:input.commandId,objective,
      workspace:input.workspace,anchorId,anchorUrlSha256:sha(anchorUrl),browserId,
    });
    return this.store.atomic(()=>{
      if(this.store.channelDrainRequested('telegram'))
        throw new Error('Maintenance drain blocks staging');
      const ledger=new GoalLedger(this.store);
      const existing=ledger.listGoals().find(g=>g.requestKey===requestKey);
      if(existing) {
        const record=this.record(existing.id);
        if(record.payloadSha256!==payloadSha256||record.ownerId!==input.ownerId)
          throw new Error('Staging idempotency key reused with different owner or intent');
        return this.readback(existing.id);
      }
      const mission=this.store.create({
        goal:objective,
        acceptance:[input.workspace?
          'Implement only the approved Goal scope, with independent tests, CI and review':
          'Provide independent evidence for the approved owner Goal without external writes'],
        workspace:input.workspace,sandbox:input.workspace?'workspace-write':'read-only',
        mode:'supervised',maxTurns:32,requestKey:`${requestKey}-mission`,checks:[],
      });
      // A staged Mission is PAUSED with a durable hold and PI ownership.
      // Generic resume, native run, browser reserve and recovery all fail
      // closed, including after a Worker restart.
      this.store.setMeta(`pi.autopilot.enabled.${mission.id}`,'1');
      this.store.setMeta(`goal.stage.hold.${mission.id}`,'1');
      const held=this.store.update(mission.id,mission.version,{state:'PAUSED'},
        'goal.stage_held',{commandId:input.commandId,noDispatch:true});
      const goal=ledger.createGoal({requestKey,objective,priority:50});
      ledger.bindPiMission(goal.id,held.id,held.version,`stage-bind-${input.commandId}`);
      const record:StagedGoalRecord={
        goalId:goal.id,missionId:held.id,ownerId:input.ownerId,
        commandId:input.commandId,payloadSha256,anchorId,
        anchorUrlSha256:sha(anchorUrl),browserId,workspace:input.workspace,
        missionVersion:held.version,goalVersion:goal.version,
        createdAt:new Date().toISOString(),checkpointSha256:'',
      };
      this.store.setMeta(`goal.stage.record.${goal.id}`,JSON.stringify(record));
      record.checkpointSha256=this.snapshot(record);
      this.store.setMeta(`goal.stage.record.${goal.id}`,JSON.stringify(record));
      return this.readback(goal.id);
    });
  }
  readback(goalId:string):StageReadback {
    const record=this.record(goalId);
    const mission=this.store.get(record.missionId),ledger=new GoalLedger(this.store);
    const currentSha256=this.snapshot(record);
    return {
      record,currentSha256,unchanged:currentSha256===record.checkpointSha256,
      goalStatus:ledger.getGoal(goalId).status,missionState:mission.state,
      turnCount:mission.turnCount,
      browserReservations:this.store.events(mission.id).filter(
        e=>e.type==='chatgpt.browser_reserved').length,
      parentId:this.store.piChainParent(mission.id),review:this.review(goalId),
      baseline:this.baseline(goalId),
      activated:this.store.getMeta(`goal.stage.activated.${goalId}`)!==null,
    };
  }
  /** Independent on-disk verification cannot accidentally mutate the live
   * writer connection. The existing Store read-only constructor additionally
   * enables PRAGMA query_only and never runs migrations or journal changes. */
  verifyReadOnly(goalId:string):StageReadback {
    const paths=this.store.db.prepare('PRAGMA database_list').all() as
      {name:string;file:string}[];
    const filename=paths.find(p=>p.name==='main')?.file;
    if(!filename)throw new Error('Independent staged verification requires persisted SQLite');
    const observer=new Store(filename,{readOnly:true});
    try{return new StagedGoalIntake(observer).readback(goalId);}
    finally{observer.close();}
  }
  /** Receives exclusively first-party independent probe outputs from the
   * authenticated owner controller. Never expose a CLI/Telegram JSON upload
   * that can impersonate these seven sources. This append-only receipt does
   * not mutate the original zero-turn stage checkpoint. */
  recordOperationalBaseline(goalId:string,ownerId:number,
    dimensions:StageBaselineDimensions,capturedAt=new Date().toISOString()):StageReadback {
    const expectedKeys=Object.keys(STAGED_BASELINE_SOURCES);
    if(!Number.isFinite(Date.parse(capturedAt))||
      Object.keys(dimensions).length!==expectedKeys.length||
      !expectedKeys.every(key=>{
        const k=key as keyof StageBaselineDimensions;
        return dimensions[k]?.source===STAGED_BASELINE_SOURCES[k]&&
          HASH.test(dimensions[k]?.evidenceSha256??'');
      }))throw new Error('Seven distinct, authenticated baseline probe receipts required');
    return this.store.atomic(()=>{
      const current=this.readback(goalId),old=current.baseline;
      if(current.record.ownerId!==ownerId||current.activated||!current.unchanged||
        current.missionState!=='PAUSED'||current.turnCount!==0||
        current.browserReservations!==0||current.parentId!==null)
        throw new Error('Changed or unowned staged checkpoint cannot be baselined');
      const value:StageOperationalBaseline={
        checkpointSha256:current.currentSha256,capturedAt,dimensions,
        baselineSha256:sha({checkpointSha256:current.currentSha256,capturedAt,dimensions}),
      };
      if(old?.baselineSha256===value.baselineSha256)return current;
      const prior=current.review;
      // Preserve the stronger baseline-mutation fence for a future-dated
      // review: clock skew must not permit replacement of its evidence.
      if(prior?.verdict==='APPROVE'&&Date.now()-Date.parse(prior.reviewedAt)<=REVIEW_TTL_MS)
        throw new Error('Cannot replace baseline during a fresh approved PI review');
      this.store.setMeta(`goal.stage.baseline.${goalId}`,JSON.stringify(value));
      this.store.db.prepare(
        'INSERT INTO goal_events(goal_id,created_at,type,payload_json) VALUES(?,?,?,?)'
      ).run(goalId,capturedAt,'goal.stage_baseline_attested',JSON.stringify({
        missionId:current.record.missionId,checkpointSha256:current.currentSha256,
        baselineSha256:value.baselineSha256,dimensions,noDispatch:true,
      }));
      return this.readback(goalId);
    });
  }
  /** The PI call itself is tool-free and never authorizes Send. Its response
   * is rechecked against the same immutable SQLite checkpoint before commit. */
  async reviewByPi(goalId:string,ownerId:number,planner:PiPlanner,
    now=Date.now()):Promise<StageReadback>{
    if(!Number.isSafeInteger(now)||now<=0)
      throw new Error('Staged review requires a valid timestamp');
    const start=this.verifyReadOnly(goalId);
    const baseline=start.baseline;
    const prior=start.review;
    if(start.record.ownerId!==ownerId||start.activated||!start.unchanged||
      start.missionState!=='PAUSED'||start.turnCount!==0||start.browserReservations!==0||
      start.parentId!==null||isFreshStagedApproval(prior,now))
      throw new Error('Staged checkpoint is changed, reviewed, or not owned by caller');
    if(!baseline||baseline.checkpointSha256!==start.currentSha256||
      now-Date.parse(baseline.capturedAt)>REVIEW_TTL_MS||
      now<Date.parse(baseline.capturedAt)-60_000)
      throw new Error('Fresh seven-dimensional operational baseline is required for PI review');
    if(!planner.reviewStagedGoal)
      throw new Error('Configured PI does not support staged zero-turn review');
    const result=await planner.reviewStagedGoal({
      goalId,missionId:start.record.missionId,
      objective:new GoalLedger(this.store).getGoal(goalId).objective,
      checkpointSha256:start.currentSha256,workspace:start.record.workspace,
      baselineSha256:baseline.baselineSha256,baselineEvidence:baseline.dimensions,
      browserIdSha256:sha(start.record.browserId),
    });
    if(!['APPROVE','REJECT'].includes(result.verdict)||
      typeof result.summary!=='string'||!result.summary.trim()||
      result.summary.length>600)
      throw new Error('PI returned an invalid staged review');
    const invocationPolicy=planner.invocationPolicy?.();
    const inference=result.inference;
    if(!inference||
      !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(inference.observedModel)||
      !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(inference.observedProvider)||
      !HASH.test(inference.responseSha256)||!HASH.test(inference.argvSha256)||
      inference.modelOverride!==false||inference.providerOverride!==false||
      inference.thinkingOverride!==false||
      !invocationPolicy||
      invocationPolicy.argvSha256!==inference.argvSha256||
      invocationPolicy.modelOverride!==false||
      invocationPolicy.providerOverride!==false||
      invocationPolicy.thinkingOverride!==false)
      throw new Error('PI review lacks real model identity, fixed default argv or inference receipt');
    return this.store.atomic(()=>{
      const latest=this.readback(goalId);
      if(latest.record.ownerId!==ownerId||latest.activated||!latest.unchanged||
        latest.currentSha256!==start.currentSha256||
        latest.baseline?.baselineSha256!==baseline.baselineSha256||
        JSON.stringify(latest.review)!==JSON.stringify(prior))
        throw new Error('PI review checkpoint became stale; no approval recorded');
      const review:StageReview={
        checkpointSha256:start.currentSha256,baselineSha256:baseline.baselineSha256,
        verdict:result.verdict,
        summary:result.summary.trim(),reviewerResultSha256:sha(result),
        reviewedAt:new Date(now).toISOString(),inference,
      };
      this.store.setMeta(`goal.stage.review.${goalId}`,JSON.stringify(review));
      this.store.db.prepare(
        'INSERT INTO goal_events(goal_id,created_at,type,payload_json) VALUES(?,?,?,?)'
      ).run(goalId,review.reviewedAt,'goal.stage_pi_reviewed',JSON.stringify({
        missionId:start.record.missionId,checkpointSha256:start.currentSha256,
        baselineSha256:baseline.baselineSha256,
        verdict:review.verdict,reviewerResultSha256:review.reviewerResultSha256,
        inference,notReleaseAcceptance:true,
      }));
      return this.readback(goalId);
    });
  }
  /** This method is invoked only from the authenticated owner Telegram
   * command. It only enables the existing single Worker recovery loop after
   * all conflict checks commit. No PI or Chrome calls occur here. */
  activate(goalId:string,ownerId:number,expectedSha256:string,
    commandId:string,now=Date.now()):StageReadback {
    if(!HASH.test(expectedSha256)||!/^\d+$/.test(commandId))
      throw new Error('Activation requires the exact reviewed SHA and owner command ID');
    return this.store.atomic(()=>{
      const record=this.record(goalId);
      if(record.ownerId!==ownerId)
        throw new Error('Staged Goal belongs to another owner');
      const previous=this.store.getMeta(`goal.stage.activated.${goalId}`);
      if(previous){
        if(expectedSha256!==record.checkpointSha256)
          throw new Error('Activation checkpoint mismatch');
        return this.readback(goalId);
      }
      const checkpoint=this.readback(goalId),review=checkpoint.review;
      if(!checkpoint.unchanged||expectedSha256!==checkpoint.currentSha256||
        !review||review.verdict!=='APPROVE'||
        review.checkpointSha256!==expectedSha256||
        !checkpoint.baseline||review.baselineSha256!==checkpoint.baseline.baselineSha256||
        !Number.isFinite(Date.parse(checkpoint.baseline.capturedAt))||
        now<Date.parse(checkpoint.baseline.capturedAt)||
        now-Date.parse(checkpoint.baseline.capturedAt)>REVIEW_TTL_MS||
        !HASH.test(review.reviewerResultSha256)||
        !HASH.test(review.inference?.argvSha256??'')||
        !HASH.test(review.inference?.responseSha256??'')||
        !review.inference?.observedModel||!review.inference?.observedProvider||
        review.inference?.modelOverride!==false||
        review.inference?.providerOverride!==false||
        review.inference?.thinkingOverride!==false||
        !Number.isFinite(Date.parse(review.reviewedAt))||
        !Number.isFinite(now)||now<Date.parse(review.reviewedAt)||
        now-Date.parse(review.reviewedAt)>REVIEW_TTL_MS)
        throw new Error('Activation refused: absent, rejected, altered or expired PI review');
      const mission=this.store.get(record.missionId);
      if(mission.state!=='PAUSED'||mission.turnCount!==0||mission.stopRequested||
        mission.lastError||checkpoint.parentId||
        checkpoint.browserReservations!==0||
        this.store.getMeta(`goal.stage.hold.${mission.id}`)!=='1'||
        this.store.channelDrainRequested('telegram'))
        throw new Error('Activation blocked by stopped, mutated or drained staged Mission');
      if(mission.sandbox==='workspace-write'&&
        (this.store.getMeta('telegram.build.project')!==record.workspace||
         this.store.getMeta('telegram.pi.project')!==record.workspace))
        throw new Error('Staged write workspace approval changed');
      if(this.store.getMeta('telegram.chatgpt.anchorMissionId')!==record.anchorId||
        sha(this.store.chatLink(record.anchorId))!==record.anchorUrlSha256||
        this.store.chatBrowserBinding(record.anchorId)!==record.browserId)
        throw new Error('Approved Chrome anchor changed since PI review');
      // No global alternate PI, unsettled browser Send or undelivered owner
      // command may be hidden by a historical PAUSED/stop flag.
      for(const other of this.store.list()) {
        if(other.id===mission.id)continue;
        const pending=this.store.chatBrowserTurn(other.id);
        if(pending&&['reserved','uncertain'].includes(pending.status))
          throw new Error('Activation blocked by original unresolved browser request');
        if(['RUNNING','VERIFYING','NEEDS_RECONCILIATION'].includes(other.state)||
          other.state==='READY'&&this.store.getMeta(`pi.autopilot.enabled.${other.id}`)==='1')
          throw new Error('Activation blocked by active or PI-ready Mission');
        if(other.state==='PAUSED'&&!other.stopRequested&&!other.lastError&&
          other.turnCount<other.maxTurns&&
          this.store.getMeta(`pi.autopilot.enabled.${other.id}`)==='1'&&
          this.store.getMeta(`goal.stage.hold.${other.id}`)!=='1'&&
          !this.store.events(other.id).some(e=>e.type==='pi.autopilot_finished'))
          throw new Error('Activation blocked by pending PI checkpoint');
      }
      const replies=this.store.db.prepare(
        "SELECT external_id FROM channel_commands WHERE source='telegram' AND status!='delivered'"
      ).all() as {external_id:string}[];
      if(replies.some(r=>r.external_id!==commandId))
        throw new Error('Activation blocked by an unacknowledged Telegram command');
      const linked=this.store.linkChat(mission.id,this.store.chatLink(record.anchorId)!,
        mission.version).mission;
      const bound=this.store.bindChatBrowser(mission.id,record.browserId,linked.version).mission;
      this.store.setMeta(`goal.stage.hold.${mission.id}`,'0');
      this.store.update(mission.id,bound.version,{state:'READY'},'goal.stage_activated',{
        checkpointSha256:expectedSha256,commandId,
        baselineSha256:review.baselineSha256,
        reviewSha256:review.reviewerResultSha256,noBrowserSend:true,
      });
      this.store.setMeta(`goal.stage.activated.${goalId}`,JSON.stringify({
        commandId,at:new Date(now).toISOString(),checkpointSha256:expectedSha256,
      }));
      return this.readback(goalId);
    });
  }
}
