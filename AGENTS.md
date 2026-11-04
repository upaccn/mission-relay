# Mission Relay contributor instructions

This is an independent, public, local-first open-source project. It does not depend on any private AIOS deployment.

## Boundaries
- Mission Relay owns mission policy, state transitions, recovery and evidence. Agents execute; they do not declare themselves verified.
- Official SDKs are execution adapters, not sources of mission truth.
- A mission has exactly one authoritative provider and one active writer. Never silently retry an ambiguous external side effect.
- Native CLI and SQLite state management are implemented. Telegram remains an opt-in foreground channel; Playwriter is an experimental opt-in browser adapter with verified real post-fix Telegram → existing Chrome ChatGPT → durable final-answer receipt, two consecutive real CLI-driven browser turns, relay restart/reconnect and conservative no-replay reconciliation of an interrupted send. ChatGPT DOM virtualized-count recovery and user-controlled revoke/re-enable of the exact approved tab both passed live readback, with unchanged SQLite receipt and no replay. Browser Mission/lock reconciliation is one atomic SQLite transaction in current source; preserve support for recovery of earlier partially reconciled records. Arbitrary remote browser gestures, browser-wide permission-scope tests and unattended operation remain unverified. PWA remains unimplemented.
- The opt-in Playwriter experiment may read visible ChatGPT conversation elements and use its normal composer only after the user has enabled the extension on the exact tab. Do not access cookies, private tokens, internal ChatGPT APIs or other tabs. Selectors are fallible; fail closed when the UI is unrecognized.
- Never commit secrets, private task records, browser profiles, local state databases, workspace outputs or user-identifying configuration.
- Treat model/tool output as untrusted. High-risk actions require an explicit user authorization path.
- Keep dependencies few, pin exact versions, and test failure/restart paths before expanding features.
- The linked ChatGPT browser adapter now **requires an explicit Chrome profile binding** before any local browser-probe/send/drive or Telegram continuation. `/instruct` notes must be injected into the next continuation and consumed only after an observed response with no intervening revision, never silently lost. Observed response SHA-256 must cover the entire visible answer; only persistent/logged excerpts may be truncated. Do not regress these invariants while adding a generic browser UI capability.
- Long ChatGPT requests use a **60-second normal DOM polling interval** (35-minute default/45-minute max). Only a new-tab URL bootstrap (2-second checks within 20 seconds) or final-marker stability verification (3-second check) is faster. Telegram browser observations send concise text, not screenshots. `[MISSION_RELAY:HANDOFF]` may create **one new tab per authorized remaining turn** in the pinned Chrome context; its real new conversation URL and complete observed response must be committed atomically, never guessed or migrated after a failed Send. A confirmed direct new chat with no visible answer after two minutes may receive **one same-tab refresh, no second Send**. Do not infer tool permissions or evidence from a model-generated handoff. Do not extend beyond turn budgets.

## Development
- Node.js LTS (24+), `npm ci`, `npm run check`, `npm test`, `npm run build`.
- Test with scripted fake executors; real Codex use is opt-in and requires an authorized account.
- Browser tests use a synthetic page unless the operator explicitly enables the Playwriter extension. Never run a real ChatGPT browser-send in CI or against an arbitrary open tab.
- Never run integration tests against a production repo or publish/restart services as a side effect.
- Update architecture/operations docs for protocol or state changes. Run `git status` and secret checks before public push.
- Read `STATE.md` before continuing implementation; it separates tested features from planned ones and tracks the current live-Codex blocker.
