# Architecture

Mission Relay has **one execution path**: an owner Goal is planned and
reviewed by PI and executed by ChatGPT in the owner's pinned Chrome profile,
driven by one leased Worker over one SQLite database.

## Components

| Component | Files | Authority |
| --- | --- | --- |
| State machine and request custody | `store.ts`, `goal-store.ts` | SQLite Missions, Goals, exact request identity, idempotency, append-only audit |
| PI planning and review | `pi-planner.ts`, `goal-pi.ts`, `goal-prompts.ts`, `pi-autopilot.ts` | Tool-free plan proposals and reviews of exact observed answers |
| ChatGPT execution | `browser-controller.ts`, `relay-tabs.ts`, `plugins/chatgpt-browser.ts` | One reserved Send at a time in the bound Playwriter Chrome; closes only Relay-created tabs |
| Owner channel and Worker | `plugins/telegram.ts` | Authenticated Telegram inbox, single-Worker lease, queued Goal dispatch, notifications |
| Operator CLI | `cli.ts` | Setup, read-only inspection, `recover`, maintenance drain, release qualification |
| Audit and release | `request-ledger.ts`, `pi-evidence.ts`, `software-release.ts`, `github-ci.ts` | Read-only custody audits; exact-SHA three-platform CI qualification |

There is no native/Codex executor, plugin registry or deterministic-check
runner: ChatGPT is the only executor and PI is the only reviewer. The
compiler rejects unused locals and parameters, and every module is imported.

## The Goal loop

1. **Intake.** `/goal`, `/goal-build --repo <approved>` or a plain message
   creates a Goal, its Mission, the repository scope and the Chrome binding in
   one SQLite transaction. Intake never touches Chrome; every Goal is queued.
2. **Discovery.** The single Worker dispatches the Goal's first Send — a
   read-only planning prompt (`browserGoalPlanningPrompt`) in a fresh Relay
   Chat. Its answer is evidence for planning, never executed work.
3. **Plan.** PI proposes a dependency-DAG plan; the controller validates,
   approves it and selects the highest-priority eligible work package.
4. **Work.** Each later Send is a `goal-work-v1` prompt: the package title,
   description, acceptance, PI's instruction, minimal scope and a bounded
   *Established context* list of PI-written PASS summaries and recorded
   blockers. Owner-wide strategy and raw prior answers are excluded.
5. **Review.** PI reviews each complete answer: PASS records acceptance and
   selects the next package; PARTIAL (a named unmet criterion with one
   concrete action) and FAIL (a real defect) keep the package; REPLAN
   revises the plan, keeps item keys and their review history, marks the
   replaced active item FAILED and carries matching PASSED work forward;
   PI judges the executor report by an explicit evidence standard and there
   is no controller repair budget; BLOCKED
   needs an external cause and a release condition and is scoped to its
   package while independent work remains.
6. **Done.** PASS of the final package (the review is told this completes the
   Goal) writes one immutable `goal_completions` row and PI action DONE; later
   Goal writes and Sends are refused. A ChatGPT DONE marker never completes a
   Goal.
7. **Continue.** After the owner fixes a blocker, `/goal-continue` binds a
   fresh queued Mission to the same Goal; nothing is replayed. The old plan
   is superseded; its items (even ones still IN_PROGRESS/REVIEW) remain as
   audit history and are never selectable. Only an item of the current
   APPROVED plan can be active (`activeWorkItem`, shared by PI review, the
   work prompt, the Send fence and `/goal-status`).

One Mission serves its Goal for as long as it runs — there is no Mission turn
ceiling and no successor chain. A ChatGPT conversation carries at most
**8** observed Relay Sends; the ninth, or a PI HANDOFF, opens a fresh Relay
Chat (`executeBrowserRollover`) and retires only the Relay-created tab it
replaces.

## Request custody

- Every Send reserves an immutable request key and full prompt SHA in SQLite
  **before** the browser side effect; a Goal work prompt's exact text is
  snapshotted in the same transaction. The answer is credited only after the
  latest visible user prompt matches the reservation and the full assistant
  text is stable; its SHA-256 covers the complete visible text.
- Request states are `reserved → observed | uncertain → reconciled`, or
  `reserved → aborted` when the failure provably happened before the Send
  click: the reservation is released, the previous receipt restored and the
  step retried later under a fresh key (`<key>-a<n>`); 8 consecutive aborts
  stop the Mission visibly. An aborted request is audit-only, never pending.
  An uncertain outcome is never resent. The Worker may only observe, use the
  bounded existing-message UI Retry for an exact delivery-timeout or
  stream-error banner, or (unpaused) handle ChatGPT's native maximum-length
  `Start new chat` once with a durable intent.
- Reconstructing a reserved prompt (`reservedRequestPrompt`) uses only its
  immutable snapshot, or the deterministic first planning prompt. Anything
  else is refused — never guessed.
- Before each next Send the source Chat's latest user prompt and assistant
  answer SHAs are re-read; a changed Chat refuses the Send.
- PI reviews only a fully observed answer. Typed temporary PI inference
  failures and closed-page browser reads retry with durable backoff and never
  repeat a Send.

## Worker cycle

`pollOnce` = one ordered cycle: **authenticated owner inbox → durable
recovery and dispatch → best-effort outbound delivery**. A successful
inbound poll is required before new browser side effects, so a queued owner
pause always wins. Outbound failures keep their SQLite cursor and never skip
dispatch. Dispatch rotates between Goals with a durable round-robin cursor,
only after a fully settled Send and committed PI decision; any reserved or
uncertain Send blocks switching (never intake).

## Operator recovery

`recover <mission>` is the single recovery surface. Without flags it is
read-only and prints the one safe next action. The only mutations, each
requiring the current revision:

| Flag | When | Effect |
| --- | --- | --- |
| `--accept-reply [--new-url <chat>]` | Outcome unknown but ChatGPT shows a complete reply | Two stable reads must match the reserved prompt SHA; credits one turn; PI then reviews it |
| `--retry` | Mission stopped by an error at a settled, verified step | Two live reads must match the receipt; clears the error; the Worker re-reads before anything else |
| `--abandon` | The reply cannot be verified | No credit, no resend; Mission ends and its Goal becomes BLOCKED for `/goal-continue` |

## SQLite schema

Schema v5 holds Missions, events, channel state, the Goal → Plan → Work Item
→ Acceptance ledger and `goal_completions`. Goal mutations use
`Store.atomic()` with durable idempotency keys and optimistic versions; the
`goal_events` log is append-only (SQL triggers reject updates and deletes).
`PASS`/`PASSED` are PI-reported statuses, not independent business
acceptance; Goal completion and software release stay separate.

Per-repository write approval uses `telegram.build.allow.<SHA256(path)>` in
private SQLite. Each Mission's `workspace` and `sandbox` are rechecked at
every reservation. This governs the controller's authorization and prompt
scope, not the OS permissions of ChatGPT's connected tools.

Playwriter is pinned at 0.9.0; its transitive moderate advisories are tracked
but not "fixed" by an incompatible downgrade without browser, target and
recovery tests.
