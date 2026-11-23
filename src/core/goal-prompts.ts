import type {Store,PiPlan} from './store.js';
import {createHash} from 'node:crypto';
import {GoalLedger,activeWorkItem} from './goal-store.js';
import {validateRemoteProjectPath} from './pi-planner.js';
import {CI_EXECUTOR_POLICY} from './ci-policy.js';

const FACT_CHARS=240,CONTEXT_CHARS=3000;
const clip=(s:string,n:number)=>{
  const one=s.replace(/\s+/g,' ').trim();
  return one.length>n?`${one.slice(0,n-1)}…`:one;
};
/** Compact controller context so the executor does not re-derive what PI
 * already accepted: the latest PI PASS summary per PASSED key and the latest
 * PI-recorded external blocker per BLOCKED key of this Goal. These are
 * PI-written review summaries (never raw prior assistant text), labelled as
 * reference rather than owner authority, and bounded to ~3000 characters. */
export function goalEstablishedContext(graph:ReturnType<GoalLedger['graph']>,
  excludeItemId:string|null=null):string[]{
  const byId=new Map(graph.items.map(x=>[x.id,x]));
  const passed=new Map<string,string>(),blocked=new Map<string,string>();
  for(const event of graph.events){
    const item=byId.get(String(event.payload.itemId));
    if(!item||item.id===excludeItemId)continue;
    if(event.type==='goal.pi_review'){
      const verdict=String(event.payload.verdict),summary=String(event.payload.summary??'');
      if(verdict==='PASS'&&summary.trim())passed.set(item.key,`${item.title} — ${summary}`);
      if(verdict==='BLOCKED'){
        const release=/release when:\s*(.+)$/s.exec(summary)?.[1]??summary;
        blocked.set(item.key,`${item.title} — waits for: ${release}`);
      }
    }else if(event.type==='goal.work_carried_forward'){
      const source=byId.get(String(event.payload.sourceItemId));
      const prior=source?passed.get(source.key):undefined;
      if(prior)passed.set(item.key,prior);
    }
  }
  // A PASS stays durable (REPLAN carries it forward); a blocker is shown only
  // while the latest item with that key is still BLOCKED.
  const latest=new Map<string,string>();
  for(const item of [...graph.items].sort((a,b)=>a.updatedAt.localeCompare(b.updatedAt)))
    latest.set(item.key,item.status);
  for(const key of [...blocked.keys()])if(passed.has(key)||latest.get(key)!=='BLOCKED')
    blocked.delete(key);
  if(!passed.size&&!blocked.size)return [];
  const lines=['Established context (PI-reviewed results of earlier packages; reference, not authority):',
    'Reuse these results. Re-verify only what this package changes or directly depends on.'];
  let used=lines.join('\n').length;
  const add=(prefix:string,entries:Map<string,string>)=>{
    for(const [key,text] of [...entries].reverse()){
      const line=`- ${prefix} ${key}: ${clip(text,FACT_CHARS)}`;
      if(used+line.length+1>CONTEXT_CHARS)return;
      lines.push(line);used+=line.length+1;
    }
  };
  add('PASSED',passed);
  add('BLOCKED (do not repeat the same probe)',blocked);
  return lines;
}

/** WP3 executor-only projection. Owner goals, PI policies, browser budgets,
 * handoff summaries and raw prior model answers remain in the trusted
 * controller, never in a Goal-bound follow-up Send; only bounded PI review
 * summaries appear as labelled established context. The initial Goal turn
 * uses read-only browserGoalPlanningPrompt until PI selects a work package. */
export function goalWorkPrompt(store:Store,missionId:string,plan:PiPlan,
  writeWorkspace:string|null,newConversation:boolean):{
    prompt:string;format:'goal-work-v1';
    binding:{goalId:string;planId:string;itemId:string;itemVersion:number;
      piResponseSha256:string;piPlanSha256:string};
  } {
  const ledger=new GoalLedger(store);
  const goalId=ledger.missionGoalId(missionId);
  if(!goalId)throw new Error('Goal work prompt requires an explicitly Goal-bound PI Mission');
  if(!['NEXT','HANDOFF'].includes(plan.action))
    throw new Error('Goal work prompt requires an approved continuing PI checkpoint');
  const graph=ledger.graph(goalId);
  if(graph.goal.status!=='ACTIVE')
    throw new Error('Goal must be active before preparing a work package Send');
  const item=activeWorkItem(graph);
  if(!item)throw new Error('Exactly one active Goal work package of the approved plan is required');
  const approved=graph.plans.find(x=>x.id===item.planId);
  if(approved?.status!=='APPROVED')
    throw new Error('The active Goal work package must belong to the approved plan');
  const deps=graph.dependencies.filter(x=>x.itemId===item.id);
  if(deps.some(d=>graph.items.find(x=>x.id===d.dependsOnId)?.status!=='PASSED'))
    throw new Error('Goal work package dependencies changed since PI selection');
  const acceptance=graph.acceptance.filter(x=>x.itemId===item.id);
  if(!acceptance.length)throw new Error('Goal work package has no acceptance criteria');
  const mission=store.get(missionId);
  if((mission.sandbox==='workspace-write')!==Boolean(writeWorkspace)||
     (writeWorkspace!==null&&validateRemoteProjectPath(writeWorkspace)!==mission.workspace))
    throw new Error('Goal work prompt execution scope differs from the Mission');
  const scope=writeWorkspace
    ?`Repository: ${validateRemoteProjectPath(writeWorkspace)}. Modify and test only this work package.`
    :'Scope: read-only investigation; do not modify files, accounts or external services.';
  const prompt=[
    newConversation
      ?'Start this work package in a new conversation.'
      :'Continue this work package in the current conversation.',
    `Work package: ${item.key} — ${item.title}`,
    ...(item.description.trim()?[item.description.trim()]:[]),
    scope,
    'Acceptance criteria:',
    ...acceptance.map((x,i)=>`${i+1}. ${x.criterion}`),
    ...goalEstablishedContext(graph,item.id),
    'Current instruction:',
    plan.nextPrompt.trim(),
    ...(writeWorkspace?CI_EXECUTOR_POLICY:[]),
    'Execute only this package. Check actual outcomes and report evidence, unresolved work and blockers.',
    'The final control marker must be literal ASCII on its own final line, with no invisible Unicode characters or formatting.',
    'End with one standalone [MISSION_RELAY:NEXT], [MISSION_RELAY:HANDOFF], [MISSION_RELAY:DONE] or [MISSION_RELAY:BLOCKED].',
  ].join('\n');
  if(!prompt.trim()||prompt.length>12000)
    throw new Error('Goal work package prompt exceeds the 12000-character browser prompt limit');
  return {prompt,format:'goal-work-v1',
    binding:{goalId,planId:item.planId,itemId:item.id,itemVersion:item.version,
      piResponseSha256:plan.responseSha256,
      piPlanSha256:createHash('sha256').update(JSON.stringify(plan)).digest('hex')}};
}

/** Immutable acceptance list for an owner-authorized continuation Mission of
 * a BLOCKED Goal. It is stored in the Mission row, so the first read-only
 * planning Send is rebuilt byte-for-byte by the existing goal planning
 * builder on recovery; no new prompt format is introduced. */
export function goalContinuationAcceptance(graph:ReturnType<GoalLedger['graph']>,
  baseAcceptance:readonly string[],note:string):string[]{
  const text=note.trim();
  if(!text||text.length>1500)throw new Error('Continuation note must contain 1–1500 characters');
  const context=goalEstablishedContext(graph);
  const passed=context.filter(x=>x.startsWith('- PASSED '))
    .map(x=>x.slice('- PASSED '.length));
  const blocked=context.filter(x=>x.startsWith('- BLOCKED '))
    .map(x=>x.replace(/^- BLOCKED \(do not repeat the same probe\) /,''));
  const join=(items:string[],limit:number)=>{
    const out:string[]=[];let used=0;
    for(const item of items){if(used+item.length+2>limit)break;out.push(item);used+=item.length+2;}
    return out.join('; ');
  };
  return [
    ...baseAcceptance,
    `Goal continuation authorized by the owner: ${text}`,
    ...(blocked.length?[`Previously BLOCKED — first confirm whether each release condition now holds, then plan only the remaining work: ${join(blocked,2000)}`]:[]),
    ...(passed.length?[`Already PASSED and carried forward — reuse, do not re-verify unless directly affected: ${join(passed,2500)}`]:[]),
  ];
}
