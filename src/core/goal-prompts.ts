import type {Store,PiPlan} from './store.js';
import {createHash} from 'node:crypto';
import {GoalLedger} from './goal-store.js';
import {validateRemoteProjectPath} from './pi-planner.js';
import {CI_EXECUTOR_POLICY} from './ci-policy.js';

/** WP3 executor-only projection. Owner goals, PI policies, browser budgets,
 * handoff summaries and prior model answers remain in the trusted controller,
 * never in a Goal-bound follow-up Send. The initial Goal turn uses read-only
 * browserGoalPlanningPrompt until PI selects an approved work package. */
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
  const active=graph.items.filter(x=>['IN_PROGRESS','REVIEW'].includes(x.status));
  if(active.length!==1)throw new Error('Exactly one active Goal work package is required');
  const item=active[0]!;
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
    'Current instruction:',
    plan.nextPrompt.trim(),
    ...(writeWorkspace?CI_EXECUTOR_POLICY:[]),
    'Execute only this package. Check actual outcomes and report evidence, unresolved work and blockers.',
    'End with one standalone [MISSION_RELAY:NEXT], [MISSION_RELAY:HANDOFF], [MISSION_RELAY:DONE] or [MISSION_RELAY:BLOCKED].',
  ].join('\n');
  if(!prompt.trim()||prompt.length>12000)
    throw new Error('Goal work package prompt exceeds the 12000-character browser prompt limit');
  return {prompt,format:'goal-work-v1',
    binding:{goalId,planId:item.planId,itemId:item.id,itemVersion:item.version,
      piResponseSha256:plan.responseSha256,
      piPlanSha256:createHash('sha256').update(JSON.stringify(plan)).digest('hex')}};
}
