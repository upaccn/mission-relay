import {createHash,randomUUID} from 'node:crypto';
import type {Store} from './store.js';

/** WP1: durable goal/plan/work-item facts, not a second execution scheduler.
 * Acceptance records are claims with evidence pointers; independent release
 * verification and the PI review protocol belong to later work packages. */
export type GoalStatus='DRAFT'|'ACTIVE'|'PAUSED'|'BLOCKED';
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

export class GoalLedger {
  constructor(private readonly store:Store){
    const schema=store.db.prepare('SELECT value FROM meta WHERE key=?').get('schema_version') as
      {value:string}|undefined;
    if(schema?.value!=='4')throw new Error('Goal ledger requires SQLite schema v4');
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
        return toGoal(previous);
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
    const r=this.store.db.prepare('SELECT * FROM goals WHERE id=?').get(id) as GoalRow|undefined;
    if(!r)throw new Error('Unknown goal');
    return toGoal(r);
  }
  listGoals():Goal[]{
    return (this.store.db.prepare('SELECT * FROM goals ORDER BY created_at,id').all() as GoalRow[])
      .map(toGoal);
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
