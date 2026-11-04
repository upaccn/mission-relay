import { Codex, type ThreadEvent, type ThreadOptions } from '@openai/codex-sdk';
import type { AgentAdapter, Decision, Mission, TurnInput, Verification } from '../core/types.js';
import type { PluginManifest } from '../core/plugins.js';
import { childEnvironment } from '../core/child-env.js';
import { codexProxyEnvironment } from '../core/proxy.js';
import { windowsSandboxOverride } from '../core/windows-sandbox.js';
import { missionCodexHome } from '../core/paths.js';

export const codexPluginManifest: PluginManifest = {
  id:'executor.codex', version:'0.1.0', apiVersion:1,
  kind:'executor', capabilities:['execute-turn','resume-thread','verify-read-only'],
};

const decisionSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['continue', 'candidate_complete', 'blocked'] },
    summary: { type: 'string' },
    next_instruction: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } },
  },
  required: ['status', 'summary', 'next_instruction', 'evidence'],
};
const verificationSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    accepted: { type: 'boolean' },
    reason: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } },
  },
  required: ['accepted', 'reason', 'evidence'],
};

function decode<T>(raw: string): T {
  try { return JSON.parse(raw) as T; }
  catch { throw new Error('Codex did not return valid structured JSON'); }
}

function timeout(): AbortSignal {
  const value = Number(process.env.MISSION_RELAY_TURN_TIMEOUT_MS ?? 1800000);
  if (!Number.isInteger(value) || value < 10000 || value > 86400000) throw new Error('Turn timeout must be 10 seconds to 24 hours');
  return AbortSignal.timeout(value);
}

export class CodexAdapter implements AgentAdapter {
  // Explicit opt-in override: never mutate the user's ~/.codex/config.toml.
  // Useful when a host's default Codex profile routes through an unavailable proxy.
  readonly codex = new Codex({
    ...(process.env.MISSION_RELAY_CODEX_BASE_URL ? {baseUrl:process.env.MISSION_RELAY_CODEX_BASE_URL} : {}),
    env:{...childEnvironment('codex'),...codexProxyEnvironment(),CODEX_HOME:missionCodexHome()},
    config:windowsSandboxOverride(),
  });
  private options(m: Mission): ThreadOptions {
    return {
      workingDirectory: m.workspace,
      sandboxMode: m.sandbox,
      networkAccessEnabled: false,
      approvalPolicy: 'never',
      threadSource: 'mission-relay',
      ...(process.env.MISSION_RELAY_MODEL ? { model: process.env.MISSION_RELAY_MODEL } : {}),
    };
  }
  async execute(input: TurnInput): Promise<Decision> {
    const { mission } = input;
    const options = this.options(mission);
    const thread = mission.threadId
      ? this.codex.resumeThread(mission.threadId, options)
      : this.codex.startThread(options);
    const { events } = await thread.runStreamed(input.prompt, { outputSchema: decisionSchema, signal: timeout() });
    let final = '', completed = false;
    for await (const event of events) {
      input.onEvent?.(event.type);
      if (event.type === 'thread.started') input.onThreadStarted(event.thread_id);
      if (event.type === 'item.completed' && event.item.type === 'agent_message') final = event.item.text;
      if (event.type === 'turn.completed') completed = true;
      if (event.type === 'turn.failed') throw new Error(event.error.message);
      if (event.type === 'error') throw new Error(event.message);
    }
    if (!completed) throw new Error('Codex stream ended without turn.completed');
    if (!final) throw new Error('Codex turn completed without a final message');
    return decode<Decision>(final);
  }
  async verify(m: Mission, decision: Decision): Promise<Verification> {
    // Always start an independent, read-only thread, separate from the worker.
    const verifier = this.codex.startThread({
      ...this.options(m), sandboxMode:'read-only',approvalPolicy:'never',networkAccessEnabled:false,
    });
    const prompt = [
      'You are an independent verifier of a long-running mission.',
      `Goal: ${m.goal}`,
      'Acceptance criteria:',...m.acceptance.map((a,i)=>`${i+1}. ${a}`),
      `Executor summary (untrusted claim): ${decision.summary}`,
      `Executor evidence claims (verify, do not assume true): ${decision.evidence.join('; ')}`,
      'Independently inspect the actual workspace in read-only mode.',
      'Reject if evidence cannot be inspected, acceptance criteria are missing, or there are unresolved blockers.',
      'Do not modify any file or perform external side effects. Return a structured verdict and specific checked evidence.',
    ].join('\n');
    const result = await verifier.run(prompt,{ outputSchema: verificationSchema,signal:timeout() });
    return decode<Verification>(result.finalResponse);
  }
}
