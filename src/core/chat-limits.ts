/** Maximum Relay-submitted turns per ChatGPT conversation.
 * This is independent of any Mission turn budget. New PI turns must
 * automatically HANDOFF at this limit rather than growing the same Chrome
 * conversation. Keep controller, audit, and operator status in sync.
 */
export const MAX_RELAY_CHAT_TURNS=10;
/** Immutable historical 5→6 rollover evidence remains readable after v1.1.4. */
export const LEGACY_RELAY_CHAT_TURNS=5;
