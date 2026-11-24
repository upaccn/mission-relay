import {createHash,randomUUID} from 'node:crypto';
import type {Store} from './store.js';

/** PI work acceptance is a reported claim; Goal DONE is separately
 * derived from the immutable, independently verified v5 release ledger. */
export type GoalStatus='DRAFT'|'ACTIVE'|'PAUSED'|'BLOCKED'|'DONE';
export type GoalPlanStatus='DRAFT'|'APPROVED'|'SUPERSEDED'|'CANCELLED';
export type GoalWorkStatus='PENDING'|'READY'|'IN_PROGRESS'|'REVIEW'|'PASSED'|'BLOCKED'|'FAILED';
export type GoalAcceptanceStatus='PENDING'|'PASS'|'PARTIAL'|'FAIL'|'BLOCKED';
export interface Goal {
  id:string;requestKey:string;objective:string;priority:number;status:GoalStatus;
  version:number;createdAt:string;updatedAt:string;
}
export interface GoalPlan {
  id:string;goalId:string;requestKey:string;ordinal:number;summary:string;
  status:GoalPlanStatus;version:number;createdAt:string;updatedAt:string;
}
export interface GoalWorkItem {
  id:string;goalId:string;planId:string;key:string;title:string;description:string;
  priority:number;status:GoalWorkStatus;evidenceRefs:string[];version:number;
  createdAt:string;updatedAt:string;
}
export interface GoalAcceptance {
  id:string;itemId:string;criterion:string;status:GoalAcceptanceStatus;
  evidenceRefs:string[];version:number;createdAt:string;updatedAt:string;
}
export interface GoalEvent {
  id:number;goalId:string;createdAt:string;type:string;payload:Record<string,unknown>;
}
export interface GoalGraph {
  goal:Goal;plans:GoalPlan[];items:GoalWorkItem[];dependencies:{itemId:string;dependsOnId:string}[];
  acceptance:GoalAcceptance[];events:GoalEvent[];
}
export interface CreateGoal {requestKey:string;objective:string;priority:number}
export interface PlannedWork {
  key:string;title:string;description?:string;priority:number;
  dependsOn?:string[];acceptance:string[];
}
export interface CreateGoalPlan {requestKey:string;summary:string;items:PlannedWork[]}

type GoalRow={id:string;request_key:string;objective:string;priority:number;
  status:GoalStatus;version:number;created_at:string;updated_at:string};
type PlanRow={id:string;goal_id:string;request_key:string;ordinal:number;summary:string;
  status:GoalPlanStatus;version:number;created_at:string;updated_at:string};
type WorkRow={id:string;goal_id:string;plan_id:string;item_key:string;title:string;description:string;
  priority:number;status:GoalWorkStatus;evidence_json:string;version:number;
  created_at:string;updated_at:string};
type AcceptanceRow={id:string;item_id:string;criterion:string;status:GoalAcceptanceStatus;
  evidence_json:string;version:number;created_at:string;updated_at:string};
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const now=()=>new Date().toISOString();
const reqKey=(value:string)=>{
  if(typeof value!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value))
    throw new Error('Invalid idempotency request key');
  return value;
};
const content=(value:string,max:number,name:string)=>{
  if(typeof value!=='string'||!value.trim()||value.length>max)
    throw new Error(`Invalid ${name}`);
  return value.trim();
};
const priority=(value:number)=>{
  if(!Number.isInteger(value)||value<0||value>100)
    throw new Error('Priority must be an integer between 0 and 100');
  return value;
};
const evidence=(refs:string[]):string[]=>{
  if(!Array.isArray(refs)||refs.length>30||
    refs.some(x=>typeof x!=='string'||!x.trim()||x.length>512)||
    new Set(refs).size!==refs.length)
    throw new Error('Evidence references must be distinct nonempty bounded pointers');
  return [...refs];
};
const requireVersion=(actual:number,expected:number)=>{
  if(!Number.isSafeInteger(expected)||actual!==expected)
    throw new Error(`Optimistic version conflict (expected ${expected}, actual ${actual})`);
};
const toGoal=(r:GoalRow):Goal=>({
  id:r.id,requestKey:r.request_key,objective:r.objective,priority:r.priority,status:r.status,
  version:r.version,createdAt:r.created_at,updatedAt:r.updated_at,
});
const toPlan=(r:PlanRow):GoalPlan=>({
  id:r.id,goalId:r.goal_id,requestKey:r.request_key,ordinal:r.ordinal,summary:r.summary,
  status:r.status,version:r.version,createdAt:r.created_at,updatedAt:r.updated_at,
});
const toWork=(r:WorkRow):GoalWorkItem=>({
  id:r.id,goalId:r.goal_id,planId:r.plan_id,key:r.item_key,title:r.title,
  description:r.description,priority:r.priority,status:r.status,
  evidenceRefs:JSON.parse(r.evidence_json) as string[],
  version:r.version,createdAt:r.created_at,updatedAt:r.updated_at,
});
const toAcceptance=(r:AcceptanceRow):GoalAcceptance=>({
  id:r.id,itemId:r.item_id,criterion:r.criterion,status:r.status,
  evidenceRefs:JSON.parse(r.evidence_json) as string[],version:r.version,
  createdAt:r.created_at,updatedAt:r.updated_at,
});

/** The one executable work item of a Goal: an IN_PROGRESS/REVIEW item of the
 * current APPROVED plan. Items left active in a SUPERSEDED plan (for example
 * after /goal-continue) are history, never selectable. With no approved plan
 * the Goal awaits PI plan approval and has no active work. */
export function activeWorkItem(graph:GoalGraph):GoalWorkItem|null{
  const approved=graph.plans.filter(p=>p.status==='APPROVED');
  if(approved.length>1)throw new Error('Multiple approved Goal plans are unsafe');
  const plan=approved[0];
  if(!plan)return null;
  const active=graph.items.filter(x=>x.planId===plan.id&&
    (x.status==='IN_PROGRESS'||x.status==='REVIEW'));
  if(active.length>1)throw new Error('Multiple active Goal work packages are unsafe');
  return active[0]??null;
}

export class GoalLedger {
  constructor(private readonly store:Store){
    const schema=store.db.prepare('SELECT value FROM meta WHERE key=?').get('schema_version') as
      {value:string}|undefined;
    if(schema?.value!=='5')throw new Error('Goal ledger requires SQLite schema v5');
  }
  private event(goalId:string,type:string,payload:Record<string,unknown>):void{
    this.store.db.prepare('INSERT INTO goal_events(goal_id,created_at,type,payload_json) VALUES(?,?,?,?)')
      .run(goalId,now(),type,JSON.stringify(payload));
  }
  /** A repeated request returns its original result without a second mutation
   * even after other updates. A changed request with the same key is rejected. */
  private once<T>(goalId:string,key:string,input:unknown,write:()=>T):T{
    return this.store.atomic(()=>{
      reqKey(key);
      const digest=hash(input);
      const previous=this.store.db.prepare(
        'SELECT request_sha256,result_json FROM goal_operations WHERE goal_id=? AND operation_key=?'
      ).get(goalId,key) as {request_sha256:string;result_json:string}|undefined;
      if(previous){
        if(previous.request_sha256!==digest)
          throw new Error('Idempotency key reused with different intent');
        return JSON.parse(previous.result_json) as T;
      }
      if(this.store.db.prepare('SELECT 1 FROM goal_completions WHERE goal_id=?')
        .get(goalId))throw new Error('Completed Goal is immutable');
      const result=write();
      this.store.db.prepare(
        'INSERT INTO goal_operations(goal_id,operation_key,request_sha256,result_json) VALUES(?,?,?,?)'
      ).run(goalId,key,digest,JSON.stringify(result));
      return result;
    });
  }
  createGoal(input:CreateGoal):Goal{
    reqKey(input.requestKey);
    const objective=content(input.objective,4000,'goal objective');
    priority(input.priority);
    return this.store.atomic(()=>{
      const previous=this.store.db.prepare('SELECT * FROM goals WHERE request_key=?')
        .get(input.requestKey) as GoalRow|undefined;
      if(previous){
        if(previous.objective!==objective||previous.priority!==input.priority)
          throw new Error('Idempotency key reused with different goal');
        return this.getGoal(previous.id);
      }
      const id=randomUUID(),at=now();
      this.store.db.prepare(`INSERT INTO goals
        (id,request_key,objective,priority,status,version,created_at,updated_at)
        VALUES(?,?,?,?,'DRAFT',1,?,?)`)
        .run(id,input.requestKey,objective,input.priority,at,at);
      this.event(id,'goal.created',{priority:input.priority,objectiveSha256:hash(objective)});
      return this.getGoal(id);
    });
  }
  getGoal(id:string):Goal{
    const r=this.store.db.prepare(`SELECT g.*,
      CASE WHEN c.goal_id IS NULL THEN g.status ELSE 'DONE' END AS status
      FROM goals g LEFT JOIN goal_completions c ON c.goal_id=g.id
      WHERE g.id=?`).get(id) as GoalRow|undefined;
    if(!r)throw new Error('Unknown goal');
    return toGoal(r);
  }
  listGoals():Goal[]{
    return (this.store.db.prepare(`SELECT g.*,
      CASE WHEN c.goal_id IS NULL THEN g.status ELSE 'DONE' END AS status
      FROM goals g LEFT JOIN goal_completions c ON c.goal_id=g.id
      ORDER BY g.created_at,g.id`).all() as GoalRow[])
      .map(toGoal);
  }
  /** Bind one unstarted PI Mission to its Goal. Existing Mission records,
   * Chat URLs and request receipts are untouched. */
  bindPiMission(goalId:string,missionId:string,expectedMissionVersion:number,
    operationKey:string):string{
    return this.once(goalId,operationKey,{missionId,expectedMissionVersion},()=>{
      const goal=this.getGoal(goalId),mission=this.store.get(missionId);
      requireVersion(mission.version,expectedMissionVersion);
      if(mission.turnCount!==0||!['READY','PAUSED'].includes(mission.state)||
        this.store.chatBrowserTurn(missionId)||
        this.store.getMeta(`pi.autopilot.enabled.${missionId}`)!=='1'||
        mission.goal.trim()!==goal.objective)
        throw new Error('Goal binding requires an unstarted PI Mission with the exact owner goal');
      if(this.store.getMeta(`goal.pi.binding.${missionId}`))
        throw new Error('PI Mission is already bound to another Goal');
      // A Goal cannot be driven by two independent live Missions.
      const others=this.store.db.prepare(
        "SELECT key FROM meta WHERE key LIKE 'goal.pi.binding.%' AND value=?"
      ).all(goalId) as {key:string}[];
      for(const other of others){
        const rootId=other.key.slice('goal.pi.binding.'.length);
        const parent=this.store.get(rootId);
        const plan=this.store.piPlan(rootId);
        const pending=this.store.chatBrowserTurn(rootId);
        // A PAUSED root whose PI decision is terminal (BLOCKED/DONE) with no
        // reserved/uncertain Send is settled even if the owner also paused it;
        // its stop flag and history stay untouched.
        if(!['COMPLETED','CANCELLED','BLOCKED'].includes(parent.state) &&
           (parent.state!=='PAUSED'||
            pending?.status==='reserved'||pending?.status==='uncertain'||
            !plan||['NEXT','HANDOFF'].includes(plan.action)))
          throw new Error('Goal already has a live PI Mission root');
      }
      this.store.setMeta(`goal.pi.binding.${missionId}`,goalId);
      this.event(goalId,'goal.pi_mission_bound',{missionId,missionVersion:mission.version});
      return goalId;
    });
  }
  /** PI accepted the final work package and no work remains: the Goal is
   * DONE (owner decision 2026-11-22). Requires an approved plan whose every
   * item PASSED. Written once; afterwards every Goal write and browser
   * reservation for this Goal is refused. */
  completeGoal(goalId:string,missionId:string,responseSha256:string,summary:string):void{
    if(!/^[a-f0-9]{64}$/.test(responseSha256))throw new Error('Goal completion requires the reviewed answer SHA');
    const text=content(summary,1000,'Goal completion summary');
    this.store.atomic(()=>{
      if(this.missionGoalId(missionId)!==goalId)throw new Error('Mission is not bound to this Goal');
      if(this.store.db.prepare('SELECT 1 FROM goal_completions WHERE goal_id=?').get(goalId))
        throw new Error('Goal already completed');
      const plan=this.store.db.prepare(
        "SELECT id FROM goal_plans WHERE goal_id=? AND status='APPROVED'").get(goalId) as {id:string}|undefined;
      if(!plan)throw new Error('Goal completion requires an approved plan');
      const open=this.store.db.prepare(
        "SELECT 1 FROM goal_work_items WHERE plan_id=? AND status!='PASSED' LIMIT 1").get(plan.id);
      if(open)throw new Error('Goal completion requires every approved work item PASSED');
      this.event(goalId,'goal.completed',{missionId,planId:plan.id,responseSha256,summarySha256:hash(text)});
      this.store.db.prepare(`INSERT INTO goal_completions
        (goal_id,mission_id,plan_id,response_sha256,summary,completed_at) VALUES(?,?,?,?,?,?)`)
        .run(goalId,missionId,plan.id,responseSha256,text,now());
    });
  }
  goalCompletion(goalId:string):{summary:string;completedAt:string}|null{
    const r=this.store.db.prepare('SELECT summary,completed_at FROM goal_completions WHERE goal_id=?')
      .get(goalId) as {summary:string;completed_at:string}|undefined;
    return r?{summary:r.summary,completedAt:r.completed_at}:null;
  }
  /** Missions explicitly bound to this Goal. */
  goalRootMissions(goalId:string):string[]{
    return (this.store.db.prepare(
      "SELECT key FROM meta WHERE key LIKE 'goal.pi.binding.%' AND value=? ORDER BY key"
    ).all(goalId) as {key:string}[]).map(x=>x.key.slice('goal.pi.binding.'.length));
  }
  /** Owner-authorized continuation of a BLOCKED Goal after its external
   * condition changed. Supersedes the stopped plan (history kept) and moves
   * the Goal to PAUSED so the next bound Mission's PI review can approve a
   * fresh plan; earlier PASSED work is carried forward by that review.
   * Never touches an existing Mission, receipt or stop flag. */
  reopenBlockedGoal(goalId:string,expectedVersion:number,noteSha256:string,
    operationKey:string):Goal{
    if(!/^[a-f0-9]{64}$/.test(noteSha256))throw new Error('Continuation note digest required');
    return this.once(goalId,operationKey,{expectedVersion,noteSha256},()=>{
      const goal=this.getGoal(goalId);
      requireVersion(goal.version,expectedVersion);
      if(goal.status!=='BLOCKED')throw new Error('Only a BLOCKED Goal can be continued');
      const approved=this.store.db.prepare(
        "SELECT id FROM goal_plans WHERE goal_id=? AND status='APPROVED'").get(goalId) as
        {id:string}|undefined;
      if(approved){
        const plan=this.getPlan(goalId,approved.id);
        this.setPlanStatus(goalId,plan.id,plan.version,'SUPERSEDED',`${operationKey}:supersede`);
      }
      const current=this.getGoal(goalId);
      const paused=this.setGoalStatus(goalId,current.version,'PAUSED',`${operationKey}:pause`);
      this.event(goalId,'goal.owner_continued',{supersededPlanId:approved?.id??null,
        noteSha256,previousVersion:goal.version,newVersion:paused.version});
      return paused;
    });
  }
  missionGoalId(missionId:string):string|null{
    const mission=this.store.get(missionId);
    const found=this.store.getMeta(`goal.pi.binding.${missionId}`);
    if(!found)return null;
    if(mission.goal.trim()!==this.getGoal(found).objective)
      throw new Error('PI Mission Goal binding scope changed');
    return found;
  }
  /** PI review is an attributable decision, not independent evidence proof. */
  recordPiReview(goalId:string,missionId:string,itemId:string,round:number,
    answerSha256:string,verdict:'PASS'|'PARTIAL'|'FAIL'|'REPLAN'|'BLOCKED'|'WAIT',
    evidenceRefs:string[],summary:string,operationKey:string):void {
    if(!/^[a-f0-9]{64}$/.test(answerSha256)||!Number.isInteger(round)||round<0)
      throw new Error('PI Goal review requires a verified browser answer SHA and round');
    evidence(evidenceRefs);
    content(summary,1000,'PI work review summary');
    this.once(goalId,operationKey,{missionId,itemId,round,answerSha256,verdict,evidenceRefs,summary},()=>{
      if(this.missionGoalId(missionId)!==goalId||this.getWork(goalId,itemId).status==='PASSED')
        throw new Error('PI review is not linked to the current work package');
      this.event(goalId,'goal.pi_review',{missionId,itemId,round,answerSha256,verdict,
        evidenceRefs:[...evidenceRefs],summary});
      return true;
    });
  }
  recordPiPlanReview(goalId:string,missionId:string,planId:string,round:number,
    answerSha256:string,operationKey:string):void{
    if(!/^[a-f0-9]{64}$/.test(answerSha256)||!Number.isInteger(round)||round<0)
      throw new Error('PI plan review requires a verified browser answer and round');
    this.once(goalId,operationKey,{missionId,planId,round,answerSha256},()=>{
      const plan=this.getPlan(goalId,planId);
      if(this.missionGoalId(missionId)!==goalId||plan.status!=='APPROVED')
        throw new Error('PI plan review must cite a linked, approved plan');
      this.event(goalId,'goal.pi_plan_reviewed',{missionId,planId,planVersion:plan.version,
        round,answerSha256});
      return true;
    });
  }
  getPlan(goalId:string,planId:string):GoalPlan{
    const row=this.store.db.prepare('SELECT * FROM goal_plans WHERE goal_id=? AND id=?')
      .get(goalId,planId) as PlanRow|undefined;
    if(!row)throw new Error('Unknown plan for goal');
    return toPlan(row);
  }
  getWork(goalId:string,itemId:string):GoalWorkItem{
    const row=this.store.db.prepare('SELECT * FROM goal_work_items WHERE goal_id=? AND id=?')
      .get(goalId,itemId) as WorkRow|undefined;
    if(!row)throw new Error('Unknown work item for goal');
    return toWork(row);
  }
  getAcceptance(goalId:string,checkId:string):GoalAcceptance{
    const row=this.store.db.prepare(`SELECT a.* FROM goal_acceptance a
      JOIN goal_work_items w ON w.id=a.item_id WHERE w.goal_id=? AND a.id=?`)
      .get(goalId,checkId) as AcceptanceRow|undefined;
    if(!row)throw new Error('Unknown acceptance criterion for goal');
    return toAcceptance(row);
  }
  /** Validate all references and the full dependency DAG before inserting any
   * plan rows. The database additionally enforces same-goal/same-plan FKs. */
  createPlan(goalId:string,goalVersion:number,input:CreateGoalPlan):GoalPlan{
    reqKey(input.requestKey);
    const summary=content(input.summary,5000,'plan summary');
    if(!Array.isArray(input.items)||input.items.length<1||input.items.length>50)
      throw new Error('Plan must contain 1–50 work items');
    const keys=new Set<string>(),edges=new Map<string,string[]>();
    for(const item of input.items){
      reqKey(item.key);content(item.title,300,'work item title');
      if(item.description!==undefined&&
        (typeof item.description!=='string'||item.description.length>5000))
        throw new Error('Invalid work item description');
      priority(item.priority);
      if(keys.has(item.key))throw new Error('Duplicate work item key');
      keys.add(item.key);
      if(!Array.isArray(item.acceptance)||!item.acceptance.length||item.acceptance.length>20)
        throw new Error('Each work item requires 1–20 acceptance criteria');
      const criteria=item.acceptance.map(x=>content(x,1000,'acceptance criterion'));
      if(new Set(criteria).size!==criteria.length)
        throw new Error('Duplicate acceptance criterion');
      if(item.dependsOn!==undefined&&(!Array.isArray(item.dependsOn)||item.dependsOn.length>50||
        new Set(item.dependsOn).size!==item.dependsOn.length))
        throw new Error('Invalid dependencies');
      edges.set(item.key,item.dependsOn??[]);
    }
    const visited=new Set<string>(),visiting=new Set<string>();
    const visit=(key:string):void=>{
      if(visiting.has(key))throw new Error('Cyclic work item dependency');
      if(visited.has(key))return;
      if(!keys.has(key))throw new Error('Unknown work item dependency');
      visiting.add(key);
      for(const dep of edges.get(key)??[])visit(dep);
      visiting.delete(key);visited.add(key);
    };
    for(const key of keys)visit(key);
    return this.once(goalId,`plan:${input.requestKey}`,{goalVersion,input},()=>{
      const goal=this.getGoal(goalId);
      requireVersion(goal.version,goalVersion);
      if(goal.status==='BLOCKED')throw new Error('Blocked goal cannot create a plan');
      const ordinal=(this.store.db.prepare(
        'SELECT COALESCE(MAX(ordinal),0)+1 AS next FROM goal_plans WHERE goal_id=?'
      ).get(goalId) as {next:number}).next;
      const id=randomUUID(),at=now();
      this.store.db.prepare(`INSERT INTO goal_plans
        (id,goal_id,request_key,ordinal,summary,status,version,created_at,updated_at)
        VALUES(?,?,?,?,?,'DRAFT',1,?,?)`)
        .run(id,goalId,input.requestKey,ordinal,summary,at,at);
      const ids=new Map(input.items.map(item=>[item.key,randomUUID()]));
      for(const item of input.items){
        const itemId=ids.get(item.key)!;
        this.store.db.prepare(`INSERT INTO goal_work_items
          (id,goal_id,plan_id,item_key,title,description,priority,status,version,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,'PENDING',1,?,?)`)
          .run(itemId,goalId,id,item.key,item.title.trim(),item.description??'',item.priority,at,at);
        for(const criterion of item.acceptance){
          this.store.db.prepare(`INSERT INTO goal_acceptance
            (id,item_id,criterion,status,version,created_at,updated_at)
            VALUES(?,?,?,'PENDING',1,?,?)`)
            .run(randomUUID(),itemId,criterion.trim(),at,at);
        }
      }
      for(const item of input.items)for(const dependsOn of item.dependsOn??[])
        this.store.db.prepare(`INSERT INTO goal_dependencies
          (goal_id,plan_id,item_id,depends_on_id) VALUES(?,?,?,?)`)
          .run(goalId,id,ids.get(item.key)!,ids.get(dependsOn)!);
      const changed=this.store.db.prepare(`UPDATE goals SET version=version+1,updated_at=?
        WHERE id=? AND version=?`).run(at,goalId,goalVersion);
      if(changed.changes!==1)throw new Error('Goal version changed during plan creation');
      this.event(goalId,'goal.plan_created',{planId:id,ordinal,
        itemCount:input.items.length,planSha256:hash(input)});
      return this.getPlan(goalId,id);
    });
  }
  setPlanStatus(goalId:string,planId:string,expectedVersion:number,
    status:GoalPlanStatus,operationKey:string):GoalPlan{
    if(!['APPROVED','SUPERSEDED','CANCELLED'].includes(status))
      throw new Error('Invalid plan transition');
    return this.once(goalId,operationKey,{planId,expectedVersion,status},()=>{
      const plan=this.getPlan(goalId,planId);
      requireVersion(plan.version,expectedVersion);
      if(!((plan.status==='DRAFT'&&['APPROVED','CANCELLED'].includes(status))||
        (plan.status==='APPROVED'&&status==='SUPERSEDED')))
        throw new Error('Invalid plan lifecycle transition');
      const at=now();
      this.store.db.prepare('UPDATE goal_plans SET status=?,version=version+1,updated_at=? WHERE id=?')
        .run(status,at,planId);
      this.event(goalId,'goal.plan_status',{planId,from:plan.status,to:status,
        previousVersion:plan.version,newVersion:plan.version+1});
      return this.getPlan(goalId,planId);
    });
  }
  setGoalStatus(goalId:string,expectedVersion:number,status:GoalStatus,
    operationKey:string):Goal{
    if(!['ACTIVE','PAUSED','BLOCKED'].includes(status))
      throw new Error('Invalid goal state transition');
    return this.once(goalId,operationKey,{expectedVersion,status},()=>{
      const goal=this.getGoal(goalId);
      requireVersion(goal.version,expectedVersion);
      if(goal.status===status)throw new Error('Goal state did not change');
      if(status==='ACTIVE'&&!this.store.db.prepare(
        "SELECT 1 FROM goal_plans WHERE goal_id=? AND status='APPROVED'"
      ).get(goalId))throw new Error('Active goal requires an approved plan');
      const at=now();
      this.store.db.prepare('UPDATE goals SET status=?,version=version+1,updated_at=? WHERE id=?')
        .run(status,at,goalId);
      this.event(goalId,'goal.status',{from:goal.status,to:status,
        previousVersion:goal.version,newVersion:goal.version+1});
      return this.getGoal(goalId);
    });
  }
  recordAcceptance(goalId:string,checkId:string,expectedVersion:number,
    status:GoalAcceptanceStatus,evidenceRefs:string[],operationKey:string):GoalAcceptance{
    if(!['PASS','PARTIAL','FAIL','BLOCKED','PENDING'].includes(status))
      throw new Error('Invalid acceptance status');
    evidence(evidenceRefs);
    if(status==='PASS'&&!evidenceRefs.length)
      throw new Error('PASS requires evidence references, not a model assertion alone');
    return this.once(goalId,operationKey,{checkId,expectedVersion,status,evidenceRefs},()=>{
      const check=this.getAcceptance(goalId,checkId);
      requireVersion(check.version,expectedVersion);
      const work=(this.store.db.prepare('SELECT status FROM goal_work_items WHERE id=?')
        .get(check.itemId) as {status:GoalWorkStatus}).status;
      if(work==='PASSED')throw new Error('Passed work item acceptance is immutable');
      if(check.status===status&&JSON.stringify(check.evidenceRefs)===JSON.stringify(evidenceRefs))
        throw new Error('Acceptance did not change');
      const at=now();
      this.store.db.prepare(`UPDATE goal_acceptance SET status=?,evidence_json=?,
        version=version+1,updated_at=? WHERE id=?`)
        .run(status,JSON.stringify(evidenceRefs),at,checkId);
      this.event(goalId,'goal.acceptance_recorded',{checkId,itemId:check.itemId,
        from:check.status,to:status,previousVersion:check.version,newVersion:check.version+1,
        evidenceRefs:[...evidenceRefs],evidenceSha256:hash(evidenceRefs)});
      return this.getAcceptance(goalId,checkId);
    });
  }
  setWorkStatus(goalId:string,itemId:string,expectedVersion:number,
    status:GoalWorkStatus,evidenceRefs:string[],operationKey:string):GoalWorkItem{
    if(!['READY','IN_PROGRESS','REVIEW','PASSED','BLOCKED','FAILED'].includes(status))
      throw new Error('Invalid work item status');
    evidence(evidenceRefs);
    const transitions:Record<GoalWorkStatus,GoalWorkStatus[]>={
      PENDING:['READY','BLOCKED'],READY:['IN_PROGRESS','BLOCKED'],
      IN_PROGRESS:['REVIEW','FAILED','BLOCKED'],
      REVIEW:['IN_PROGRESS','PASSED','FAILED','BLOCKED'],
      FAILED:['READY','BLOCKED'],BLOCKED:['READY'],PASSED:[],
    };
    return this.once(goalId,operationKey,{itemId,expectedVersion,status,evidenceRefs},()=>{
      const item=this.getWork(goalId,itemId);
      requireVersion(item.version,expectedVersion);
      if(!transitions[item.status].includes(status))
        throw new Error('Invalid work item lifecycle transition');
      if(['READY','IN_PROGRESS','REVIEW','PASSED'].includes(status)){
        if(this.getPlan(goalId,item.planId).status!=='APPROVED')
          throw new Error('Work item cannot advance without an approved plan');
        const incomplete=this.store.db.prepare(`SELECT 1 FROM goal_dependencies d
          JOIN goal_work_items w ON w.id=d.depends_on_id
          WHERE d.item_id=? AND w.status!='PASSED' LIMIT 1`).get(itemId);
        if(incomplete)throw new Error('Work item dependencies have not passed');
      }
      if(status==='PASSED'){
        const checks=this.store.db.prepare(
          'SELECT status FROM goal_acceptance WHERE item_id=?'
        ).all(itemId) as {status:GoalAcceptanceStatus}[];
        if(!checks.length||checks.some(x=>x.status!=='PASS')||!evidenceRefs.length)
          throw new Error('PASSED requires every acceptance PASS and evidence references');
      }
      const at=now();
      this.store.db.prepare(`UPDATE goal_work_items SET status=?,evidence_json=?,
        version=version+1,updated_at=? WHERE id=?`)
        .run(status,JSON.stringify(evidenceRefs),at,itemId);
      this.event(goalId,'goal.work_status',{itemId,planId:item.planId,from:item.status,
        to:status,previousVersion:item.version,newVersion:item.version+1,
        evidenceRefs:[...evidenceRefs],evidenceSha256:hash(evidenceRefs)});
      return this.getWork(goalId,itemId);
    });
  }
  /** REPLAN must not silently reset already-passed obligations. Carry one
   * earlier PASSED item of the SAME Goal (a superseded plan) into a PENDING
   * item of the current approved plan, reusing its original evidence
   * references. This is PI-reported work progress only; independent Goal
   * release acceptance is unchanged. Dependencies must already be PASSED. */
  carryForwardPassed(goalId:string,itemId:string,sourceItemId:string,
    operationKey:string):GoalWorkItem{
    return this.once(goalId,operationKey,{itemId,sourceItemId},()=>{
      const item=this.getWork(goalId,itemId),source=this.getWork(goalId,sourceItemId);
      if(item.status!=='PENDING')throw new Error('Only a pending work item can inherit a PASS');
      if(source.status!=='PASSED'||source.planId===item.planId)
        throw new Error('Carry-forward requires a PASSED item from an earlier plan of this Goal');
      if(this.getPlan(goalId,item.planId).status!=='APPROVED')
        throw new Error('Work item cannot advance without an approved plan');
      const incomplete=this.store.db.prepare(`SELECT 1 FROM goal_dependencies d
        JOIN goal_work_items w ON w.id=d.depends_on_id
        WHERE d.item_id=? AND w.status!='PASSED' LIMIT 1`).get(itemId);
      if(incomplete)throw new Error('Work item dependencies have not passed');
      const refs=[...new Set([...source.evidenceRefs,`carried-from:${source.id}`])].slice(-20);
      evidence(refs);
      const at=now();
      this.store.db.prepare(`UPDATE goal_acceptance SET status='PASS',evidence_json=?,
        version=version+1,updated_at=? WHERE item_id=?`).run(JSON.stringify(refs),at,itemId);
      this.store.db.prepare(`UPDATE goal_work_items SET status='PASSED',evidence_json=?,
        version=version+1,updated_at=? WHERE id=?`).run(JSON.stringify(refs),at,itemId);
      this.event(goalId,'goal.work_carried_forward',{itemId,planId:item.planId,
        sourceItemId,sourcePlanId:source.planId,key:item.key,
        previousVersion:item.version,newVersion:item.version+1,
        evidenceRefs:refs,evidenceSha256:hash(refs)});
      return this.getWork(goalId,itemId);
    });
  }
  /** PI WAIT: the active package is waiting for a time-bound process it
   * already started (a long device run, a scheduled job). It returns to READY
   * with a not-before time, so the single active slot is free for independent
   * work and nothing re-dispatches it early. Not a review verdict on its own. */
  deferWork(goalId:string,itemId:string,expectedVersion:number,notBefore:string,
    resumePrompt:string,round:number,operationKey:string):GoalWorkItem{
    if(!Number.isFinite(Date.parse(notBefore))||!Number.isInteger(round)||round<0)
      throw new Error('Work deferral requires a valid time and round');
    const prompt=content(resumePrompt,1500,'work deferral resume instruction');
    return this.once(goalId,operationKey,{itemId,expectedVersion,notBefore,prompt,round},()=>{
      const item=this.getWork(goalId,itemId);
      requireVersion(item.version,expectedVersion);
      if(item.status!=='IN_PROGRESS')throw new Error('Only the active work item can be deferred');
      if(this.getPlan(goalId,item.planId).status!=='APPROVED')
        throw new Error('Work item cannot be deferred outside its approved plan');
      this.store.db.prepare(`UPDATE goal_work_items SET status='READY',version=version+1,
        updated_at=? WHERE id=?`).run(now(),itemId);
      this.event(goalId,'goal.work_deferred',{itemId,planId:item.planId,key:item.key,round,
        notBefore,resumePrompt:prompt,previousVersion:item.version,newVersion:item.version+1});
      return this.getWork(goalId,itemId);
    });
  }
  graph(goalId:string):GoalGraph{
    const goal=this.getGoal(goalId),db=this.store.db;
    const plans=(db.prepare('SELECT * FROM goal_plans WHERE goal_id=? ORDER BY ordinal')
      .all(goalId) as PlanRow[]).map(toPlan);
    const items=(db.prepare('SELECT * FROM goal_work_items WHERE goal_id=? ORDER BY plan_id,priority DESC,item_key')
      .all(goalId) as WorkRow[]).map(toWork);
    const dependencies=(db.prepare(`SELECT item_id AS itemId,depends_on_id AS dependsOnId
      FROM goal_dependencies WHERE goal_id=? ORDER BY item_id,depends_on_id`)
      .all(goalId) as {itemId:string;dependsOnId:string}[]);
    const acceptance=(db.prepare(`SELECT a.* FROM goal_acceptance a
      JOIN goal_work_items w ON w.id=a.item_id WHERE w.goal_id=? ORDER BY a.rowid`)
      .all(goalId) as AcceptanceRow[]).map(toAcceptance);
    const events=(db.prepare('SELECT * FROM goal_events WHERE goal_id=? ORDER BY id')
      .all(goalId) as {id:number;goal_id:string;created_at:string;type:string;payload_json:string}[])
      .map(e=>({id:e.id,goalId:e.goal_id,createdAt:e.created_at,type:e.type,
        payload:JSON.parse(e.payload_json) as Record<string,unknown>}));
    return {goal,plans,items,dependencies,acceptance,events};
  }
}

/** Open PI WAIT deferrals by stable work key: the latest `goal.work_deferred`
 * of a key that no later PI review of the same key has consumed. */
export function openWorkDeferrals(graph:GoalGraph):Map<string,{notBefore:number;resumePrompt:string}>{
  const keyOf=new Map(graph.items.map(x=>[x.id,x.key]));
  const open=new Map<string,{notBefore:number;resumePrompt:string}>();
  for(const event of graph.events){
    const key=keyOf.get(String(event.payload.itemId));
    if(!key)continue;
    if(event.type==='goal.work_deferred')open.set(key,{
      notBefore:Date.parse(String(event.payload.notBefore)),
      resumePrompt:String(event.payload.resumePrompt??'')});
    else if(event.type==='goal.pi_review'&&event.payload.verdict!=='WAIT')open.delete(key);
  }
  return open;
}
