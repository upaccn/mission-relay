import type { AgentAdapter, CreateMission, Decision, Mission, Verification } from './types.js';
import { Store } from './store.js';
import { runChecks } from './checks.js';

function compactError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000);
}

export class Engine {
  constructor(readonly store: Store, readonly agent: AgentAdapter) {}

  create(input: CreateMission): Mission { return this.store.create(input); }
  get(id: string): Mission { return this.store.get(id); }
  list(): Mission[] { return this.store.list(); }

  private prompt(m: Mission): string {
    const instruction = m.nextInstruction ?? 'Start working toward the goal.';
    return [
      'You are an AI executor working under a durable external Mission Controller.',
      `Mission ID: ${m.id}`, `Goal: ${m.goal}`,
      'Acceptance criteria:', ...m.acceptance.map((a,i) => `${i+1}. ${a}`),
      `Current turn: ${m.turnCount + 1} of ${m.maxTurns}`,
      `Instruction for this turn: ${instruction}`,
      'Work only in the authorized workspace and within the configured sandbox.',
      'Do not deploy to production, spend money, delete external resources, or expand permissions.',
      'Provide a structured decision: continue, candidate_complete, or blocked.',
      'Use candidate_complete only with specific, inspectable evidence that the full goal is met.',
      'When continuing, include a concrete next_instruction. Never invent verification results.',
    ].join('\n');
  }

  run(id: string, expectedVersion?: number): Promise<Mission> {
    if(this.store.chatLink(id)) throw new Error('Mission is linked to an external ChatGPT conversation; use the browser adapter, not a native executor');
    // Claim synchronously so a command channel never acknowledges an unclaimed task.
    const claimed = this.store.acquire(id, expectedVersion);
    return this.runClaimed(claimed);
  }

  private async runClaimed(m: Mission): Promise<Mission> {
    const id = m.id;
    try {
      while (m.state === 'RUNNING') {
        m = this.store.get(id);
        if (m.stopRequested) return this.stop(m, 'Operator requested pause');
        if (m.turnCount >= m.maxTurns) return this.stop(m, 'Turn budget exhausted');
        const dispatchedInstruction = m.nextInstruction;
        const prompt = this.prompt(m);
        this.store.update(id,m.version,{},'turn.dispatched',{turn: m.turnCount+1, threadId:m.threadId, sandbox:m.sandbox});
        let decision: Decision;
        decision = await this.agent.execute({
          mission: this.store.get(id), prompt,
          onThreadStarted: threadId => {
            const latest = this.store.get(id);
            if (latest.threadId !== threadId) this.store.update(id,latest.version,{threadId},'executor.thread_started',{threadId});
          },
          onEvent: type => {
            if (type === 'turn.started' || type === 'turn.completed' || type === 'turn.failed') {
              const latest = this.store.get(id);
              this.store.update(id,latest.version,{},'executor.event',{type});
            }
          },
        });
        if (!['continue','candidate_complete','blocked'].includes(decision.status) || !decision.summary.trim() || !Array.isArray(decision.evidence)) {
          throw new Error('Executor returned an invalid decision');
        }
        m = this.store.get(id);
        const pendingOperatorInstruction = m.nextInstruction !== dispatchedInstruction ? m.nextInstruction : null;
        // Operator notes are committed independently. A note sent during a turn takes
        // priority over the executor's suggested next step on the following turn.
        const next = pendingOperatorInstruction
          ? pendingOperatorInstruction : decision.next_instruction.trim() || null;
        m = this.store.update(id,m.version,{
          turnCount:m.turnCount+1,lastSummary:decision.summary,nextInstruction:next,
        },'turn.completed',{status:decision.status,summary:decision.summary,evidence:decision.evidence});
        if (m.stopRequested) return this.stop(m,'Operator requested pause');
        if (decision.status === 'blocked') {
          return this.store.update(id,m.version,{state:'BLOCKED',ownerPid:null,ownerHost:null},'mission.blocked',{reason:decision.summary});
        }
        if (decision.status === 'candidate_complete') {
          if (m.sandbox === 'workspace-write' && m.checks.length === 0) {
            m=this.store.update(id,m.version,{
              state:'PAUSED',ownerPid:null,ownerHost:null,
              lastError:'Workspace-write missions require an operator-configured deterministic check before completion.',
            },'verification.checks_required',{});
            return m;
          }
          m = this.store.update(id,m.version,{state:'VERIFYING'},'verification.started',{});
          const receipts=await runChecks(m);
          m=this.store.get(id);
          this.store.update(id,m.version,{},'verification.check_receipts',{receipts});
          if(receipts.some(x=>!x.passed)) {
            m=this.store.get(id);
            m=this.store.update(id,m.version,{
              state:'RUNNING',nextInstruction:'Operator-defined verification check failed. Examine the specific test and repair before proposing completion.',
            },'verification.rejected',{reason:'Deterministic check failed',receipts});
            if(m.mode === 'supervised') return this.stop(m,'Supervised mode: check failed');
            continue;
          }
          const verdict: Verification = await this.agent.verify(m,decision);
          if (typeof verdict.accepted !== 'boolean' || !verdict.reason.trim() || !Array.isArray(verdict.evidence)) {
            throw new Error('Verifier returned an invalid result');
          }
          m = this.store.get(id);
          if (m.stopRequested) return this.stop(m,'Operator requested pause during verification');
          if (verdict.accepted) {
            return this.store.update(id,m.version,{
              state:'COMPLETED',ownerPid:null,ownerHost:null,nextInstruction:null,
            },'verification.accepted',{reason:verdict.reason,evidence:verdict.evidence});
          }
          m = this.store.update(id,m.version,{
            state:'RUNNING',nextInstruction:`Independent verification rejected completion: ${verdict.reason}. Address the missing evidence or blockers.`,
          },'verification.rejected',{reason:verdict.reason,evidence:verdict.evidence});
        }
        if (m.mode === 'supervised') return this.stop(m,'Supervised mode: one completed turn');
      }
      return this.store.get(id);
    } catch (error) {
      const latest = this.store.get(id);
      // An executor error is ambiguous: a tool may have already modified the workspace.
      // Do not replay a turn or invent success. The user must reconcile first.
      if (latest.state === 'RUNNING' || latest.state === 'VERIFYING') {
        return this.store.update(id,latest.version,{
          state:'NEEDS_RECONCILIATION',lastError:compactError(error),ownerPid:null,ownerHost:null,
        },'mission.ambiguous_failure',{error:compactError(error)});
      }
      throw error;
    }
  }

  private stop(m: Mission, reason: string): Mission {
    return this.store.update(m.id,m.version,{state:'PAUSED',ownerPid:null,ownerHost:null,stopRequested:false},'mission.paused',{reason});
  }
  private expectVersion(m: Mission, expectedVersion?: number): void {
    if (expectedVersion !== undefined && m.version !== expectedVersion)
      throw new Error(`State conflict for ${m.id}: expected ${expectedVersion}, got ${m.version}`);
  }
  pause(id: string, expectedVersion?: number): Mission {
    const m = this.store.get(id);
    this.expectVersion(m, expectedVersion);
    if (m.state === 'RUNNING' || m.state === 'VERIFYING') {
      return this.store.update(id,m.version,{stopRequested:true},'mission.pause_requested',{});
    }
    if (m.state !== 'READY') throw new Error(`Cannot pause ${m.state}`);
    return this.stop(m,'Operator paused mission');
  }
  resume(id: string, expectedVersion?: number): Mission {
    const m = this.store.get(id);
    this.expectVersion(m, expectedVersion);
    if (!['PAUSED','BLOCKED'].includes(m.state)) throw new Error(`Cannot resume ${m.state}`);
    if (m.turnCount >= m.maxTurns) throw new Error('Turn budget exhausted; create a follow-up mission');
    return this.store.update(id,m.version,{state:'READY',lastError:null,stopRequested:false},'mission.resumed',{});
  }
  instruct(id: string, note: string, expectedVersion?: number): Mission {
    if (!note.trim()) throw new Error('Instruction cannot be empty');
    const m = this.store.get(id);
    this.expectVersion(m, expectedVersion);
    if (!['READY','RUNNING','PAUSED','BLOCKED'].includes(m.state)) throw new Error(`Cannot instruct ${m.state}`);
    return this.store.update(id,m.version,{nextInstruction:note.trim()},'mission.instruction_added',{note:note.trim()});
  }
  cancel(id: string, expectedVersion?: number): Mission {
    const m = this.store.get(id);
    this.expectVersion(m, expectedVersion);
    if (!['READY','PAUSED','BLOCKED'].includes(m.state)) throw new Error(`Cannot cancel ${m.state}; pause active work first`);
    return this.store.update(id,m.version,{state:'CANCELLED',ownerPid:null,ownerHost:null},'mission.cancelled',{});
  }
  /** Reconciliation never replays a possibly committed tool action. */
  reconcile(id: string, acknowledged: boolean): Mission {
    if (!acknowledged) throw new Error('Inspect workspace and external side effects before acknowledging reconciliation');
    const m = this.store.get(id);
    if (!['RUNNING','VERIFYING','NEEDS_RECONCILIATION'].includes(m.state)) throw new Error(`Cannot reconcile ${m.state}`);
    if (m.ownerPid && this.store.isOwnerAlive(m)) throw new Error('Execution may still be active. Refusing reconciliation');
    return this.store.update(id,m.version,{
      state:'PAUSED',ownerPid:null,ownerHost:null,stopRequested:false,
      nextInstruction:'Operator reconciled the interrupted turn after inspecting actual side effects. Continue only remaining work.',
    },'mission.reconciled',{acknowledged:true});
  }
}
