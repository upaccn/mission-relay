/** Maximum Relay-submitted turns per ChatGPT conversation.
 * This is independent of any Mission turn budget. New PI turns must
 * automatically HANDOFF at this limit rather than growing the same Chrome
 * conversation. Keep controller, audit, and operator status in sync.
 */
export const MAX_RELAY_CHAT_TURNS=8;
/** Pre-v1.2.11 durable audit rows may already contain 9–10 successful Sends.
 * The runtime never uses this value to authorize a NEW same-Chat Send. */
export const LEGACY_RELAY_CHAT_TURNS=10;
/** Terminal ChatGPT UI capacity is different from a transient transport
 * error or a model-authored HANDOFF response. Never credit its failed Send. */
export const MAX_CONVERSATION_LENGTH_ERROR=
  'ChatGPT conversation reached its maximum length; original submitted request has no verified final answer';
