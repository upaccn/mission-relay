import type { Mission } from './types.js';

/** An explicit, human-managed ChatGPT conversation link, never an automation API. */
export function normalizeChatGPTUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error('Invalid ChatGPT conversation URL'); }
  if (url.protocol !== 'https:' || url.hostname !== 'chatgpt.com' ||
    url.username || url.password || url.port || url.search || url.hash ||
    !/^\/(?:c\/[A-Za-z0-9-]{20,}|g\/[A-Za-z0-9_-]+\/c\/[A-Za-z0-9-]{20,})\/?$/.test(url.pathname)) {
    throw new Error('Provide a direct https://chatgpt.com/c/<conversation-id> URL (no credentials, queries or fragments)');
  }
  return url.origin + url.pathname.replace(/\/$/, '');
}

export function renderChatGPTHandoff(m: Mission, conversationUrl: string): string {
  const short=(value:string,max:number)=>value.length>max?value.slice(0,max-1)+'…':value;
  const criteria = m.acceptance.slice(0,8).map((item, i) => `${i + 1}. ${short(item,180)}`).join('\n');
  return [
    `Mission ${m.id} [${m.state}] v${m.version}`,
    `Open your existing ChatGPT conversation: ${conversationUrl}`,
    'Suggested message to send MANUALLY in that conversation:',
    `Continue the existing work toward: ${short(m.goal,300)}`,
    'Acceptance criteria:', criteria,
    'Review the last result and current evidence first. Select the next smallest verifiable action. Continue only within existing permissions; stop for approvals and ambiguity.',
    'When the context is too long, prepare a concise handoff of confirmed facts, remaining work, evidence and blockers for a new conversation.',
    'Without an explicitly enabled Playwriter extension this is a manual handoff. With Playwriter enabled, Mission Relay can observe visible replies, but never treats a browser reply as independent proof of completion.',
  ].join('\n');
}
