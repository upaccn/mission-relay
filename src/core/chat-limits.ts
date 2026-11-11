/** Maximum Relay-submitted turns per ChatGPT conversation.
 * This is independent from the 32-send Mission budget. New PI turns must
 * automatically HANDOFF at this limit rather than growing the same Chrome
 * conversation. Keep controller, audit, and operator status in sync.
 */
export const MAX_RELAY_CHAT_TURNS=5;
