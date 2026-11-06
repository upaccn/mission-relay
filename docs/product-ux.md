# Mission Relay product decisions (v0.2 hardening -> v1.0)

## Owner, planner and executor

Telegram/ChatGPT prompts express the task directly as an imperative from the person requesting it. A separate PI prompt contains planning policy, tool-free constraints, proof evaluation and NEXT/HANDOFF/DONE/BLOCKED decisions. The entire original owner goal stays in the durable Mission and PI context; an explicitly headed `【执行与自治规则】` section and redundant third-person owner-authorization boilerplate are removed deterministically **only** from ChatGPT executor prompts. Other objective and acceptance sections remain visible. Do not embed a PI control manual in every ChatGPT message or claim that a third party has delegated the task. Keep scope enforcement in the controller and local approval records, not in a model's assertion of provenance. ChatGPT provides inspectable tool output; PI reviews the actual full answer and hashes, not the abbreviated Telegram summary. The controller alone owns reservations, chat rollover, cancellation and audit records.

## Mission lifecycle and Telegram inbox

- `/list` is the **actionable inbox**: READY/RUNNING/VERIFYING/BLOCKED/NEEDS_RECONCILIATION and nonterminal PI checkpoints needing review, at most ten concise entries. Absence of a Chrome tab is not evidence of success; a NEEDS_RECONCILIATION entry is never hidden merely because Chrome is closed.
- `/history` shows recent completed, cancelled, safely paused or archived records without overwhelming the inbox. `/status <full-id>` is always available. Local `mission-relay list` continues to return the full unfiltered ledger.
- `mission-relay archive-settled` is a **local, explicit, non-destructive** maintenance operation. It marks safely settled entries in SQLite metadata and appends an audit event; no Mission, request receipt or event is deleted. READY/RUNNING/VERIFYING, NEEDS_RECONCILIATION, ambiguous Sends, paused errors, owner updates and pending PI continuations are not auto-archived. Idempotent on repeated use.
- Do not equate archived with completed. Historical PAUSED missions may have done only their browser turn, not independent business verification. Archiving only cleans the interface.

## Telegram interaction in v0.2

The first version uses Bot API **inline keyboards** attached to ordinary text, with no new frontend or messaging database. `/list`, `/history`, `/status`, and terminal notifications offer read-only View/Refresh/Tasks/History buttons. Callback data only permits these exact commands, including full UUID for status, and is bound to the same allowlisted owner and private chat; each callback update uses the existing durable inbox cursor and command reservation. Unknown or stale buttons fail closed. The reply text remains canonical, so restart can reconstruct the same keyboard deterministically.

Example visual hierarchy:

    Mission Relay — Attention (3)
    1. Reconcile ChatGPT answer | 3/32
    2. Reconcile ChatGPT answer | 4/32
    3. Interrupted PI checkpoint | 2/8
    [View 1] [View 2] [View 3]
    [Refresh tasks] [History]

Next UX increment, after a real Telegram callback acceptance: one editable live status message per active Mission, explicit revision-bound Pause and Resume buttons, a separate Reconcile-required detail view, and one final notification per Mission. A `Pause` tap must be version-checked and may not pretend an in-flight Send can be undone. Telegram keyboards are not arbitrary native UI cards: avoid presenting an HTML app as if it were embedded in standard bot chat.

## Execution transports: browser versus direct API

The current `chatgpt-browser` adapter depends on a signed-in Chrome window and opt-in Playwriter tab; this is not a requirement of Mission Relay's mission state machine. ChatGPT browser access is a user-visible website adapter, **not** an official private ChatGPT conversation API. A future direct provider adapter may use public supported APIs (e.g. OpenAI Responses/Conversations, or other vendors' official APIs), receive structured result/tool events without browser DOM, and route them into the same PI evidence/checkpoint pipeline. Such an adapter requires separate API credentials, billing, tool provisioning and integration tests; a ChatGPT web subscription must not be misrepresented as API access. Preserve the one-active-writer and no-blind-replay invariants. Keep browser mode for the browser-account workflow, and cap it at five observed Sends per conversation.

## Portable distribution

Target CLI distributions: Windows x64, macOS arm64/x64 and Linux x64/arm64. Node's Single Executable Applications is the preferred proof-of-concept path before considering a rewrite: bundle the Node/TypeScript entrypoint and assets, embed in a platform-specific runtime, sign releases, test fresh-machine launch and upgrades. External Chrome/Playwriter extension, personal login, SQLite state, Telegram setup and native optional agents are still optional runtime dependencies; compiling an `.exe` does not make them disappear. Distribute no user tokens, browser profiles, private state or static credentials in binaries. No binary has yet been built or acceptance-tested.

## Release gates

Source check/build/privacy suite; Linux and Windows regression; exact-main CI; idle/drained GMK activation; locally originated Telegram callback real acceptance; recovering both existing uncertain Sends without replay or formally retaining their blocked evidence; actual 5-to-new-chat and 32-to-successor acceptance; independent business-result readback. v1.0 label requires those gates, not merely more source unit tests.
