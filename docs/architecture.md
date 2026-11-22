# Architecture

## Execution system — current responsibility boundaries

Mission Relay has **one state machine**, not multiple vendor-specific execution cores:

| Component | File ownership | Authority |
| --- | --- | --- |
| Mission engine + durable reservation/lease | `src/core/engine.ts`, `store.ts`, `goal-store.ts` | SQLite state, exact request identity, idempotency and transition audit |
| PI planning, recovery, Goal reviews | `pi-planner.ts`, `pi-autopilot.ts`, `goal-pi.ts` | Tool-free proposals and exact observed-answer reviews; no execution permissions |
| ChatGPT browser execution | `browser-controller.ts`, `src/plugins/chatgpt-browser.ts` | Bound Playwriter Chrome and one reserved Send, never arbitrary tab control |
| Owner channel | `src/plugins/telegram.ts` | Authenticated Telegram inbox, current single-Worker lease and bounded notifications |
| Optional native code execution | `executor-plugins.ts`, `plugins.ts`, `checks.ts` | Explicit trusted JS plugin and operator-chosen deterministic checks; not a sandbox |
| Audit and software release | `request-ledger.ts`, `pi-evidence.ts`, `software-release.ts`, `github-ci.ts` | Read-only request/PI custody audits and exact-SHA three-platform CI qualification |

The production import graph has no confirmed orphan modules. The native PluginRegistry validates manifests while executor-plugins explicitly loads trusted local modules; these are different layers, not redundant providers. Browser, native and PI execution remain distinct. The compiler rejects unused locals and parameters. Operator-specific historical milestone narratives are not part of the public v1.0 source history. An npm production-dependency audit found seven moderate advisories transitively linked to pinned Playwriter 0.9.0 (none high/critical). A suggested downgrade to 0.5.0 is not a compatible security fix without separate extension, Chrome-target, and recovery tests. Do not change the pinned browser integration merely to silence a package advisory.

## System of record

A **Mission Provider** is the only authority for a given mission. The native provider stores mission state in SQLite through Node's bundled `node:sqlite` API (Node 24+); future external providers (e.g., operator-managed host) remain authoritative for their own missions. Never copy editable states into a competing database.

The native engine is not an Agent Runtime. It orchestrates bounded turns through an optional **Executor plugin**, with no required coding-agent SDK or model vendor. Agent credentials and actual sandbox enforcement stay with the installed executor, not Mission Relay.

## State and safety

`READY -> RUNNING -> (PAUSED | BLOCKED | NEEDS_RECONCILIATION | VERIFYING | COMPLETED)`

- Transactional optimistic revisions prevent stale operator commands from changing a mission; a mission transition and its audit event commit together. The native running-state lease blocks duplicate dispatch.
- Every turn records intent, thread/session IDs, result summary and events.
- An interrupted active turn is *not* retried automatically. Reconciliation requires a deliberate operator action.
- Browser-linked Missions require a **pinned** operator-approved Playwriter Chrome instance before even a read-only probe. State-changing browser turns durably reserve the request hash and normalized URL lock. Once the complete assistant answer is observed, SHA-256 covers the **full visible text** while persisted excerpts remain short. Owner `/instruct` notes are injected once into browser continuation and consumed atomically only if unchanged after the dispatch revision; concurrent notes remain pending.
- Browser observation uses a 60-second normal local DOM polling interval with a 60-minute default and four-hour upper timeout, not model inference or recurring LLM API requests. A visible `Connection interrupted. Waiting for the complete answer` is nonterminal, extends the default observation once by up to 120 minutes (four hours absolute cap) and never causes a second Send. A matching `Message delivery timed out. Please try again.` banner permits one **exact visible UI `Retry` click** for the already-submitted message, only after verifying original prompt SHA and pinned URL; this is not an unbounded request replay. Explicit shorter deadlines are preserved. Short checks are reserved for new-tab bootstrap, reply-load errors, the single UI retry and final-marker stability. A Telegram-triggered bounded browser batch emits **one** final compact owner notification, while each intermediate observed turn remains audited in SQLite; ambiguous turns are separately reported. A bounded model-proposed HANDOFF can reserve another turn, open a new tab inside the pinned Playwriter browser context, send a concise new-chat prompt, and atomically update the linked conversation URL together with the observed receipt. A failed migration retains the old link and an uncertain lock, requiring explicit reconciliation; the original chat tab remains untouched.
- PI DONE/BLOCKED, owner pause, explicit permissions and evidence-gated Sends govern continuation. New PI Missions have no fixed Mission turn ceiling.
- Previously created finite-limit PI Missions retain their original 32-turn limit for historical compatibility; new PI Missions continue beyond round 32 in the same Mission (stored max_turns=0). A PI decision of NEXT/HANDOFF at that exact limit is a *continuation*, not owner-goal completion: the controller atomically records one child Mission, parent/child IDs and a deterministic successor key; the child inherits the original mission goal, acceptance, scope and Chrome binding but starts with zero turns. After restart the same successor is reused rather than generated again. Before the child opens its first new ChatGPT tab, the previous conversation's latest user prompt and full assistant answer must match the source Mission's independently observed SQLite hashes across a stability read. On missing/changed evidence or revoked workspace-write approval the child blocks without a Send. Model DONE/BLOCKED does not chain. This is tested with synthetic Chrome pages, not yet with an unattended production 32-turn rollover.
- A READY successor's first Send is an additional PI planning boundary: authenticated owner notes arriving after the parent reached turn 32 are evaluated against the exact parent's observed answer. The child's zero-turn PI preflight decision and consumed note IDs are committed atomically; this is *not* a credited browser Send. Changes during PI inference cause a bounded replan; changes during new-tab DOM inspection reject the SQLite reservation and only retry local planning. The exact parent prompt and full answer SHA-256 are checked again immediately after PI inference, at the final browser read before reserving the child Send. A changed parent refuses the request before any new tab. A terminal PI decision stops before any new-tab Send. For an interrupted first Send, recovery reconstructs the child's saved revised prompt, not the stale parent plan. An owner revocation of the exact `/build` path is enforced again inside the atomic browser reservation. A failed/uncertain external Send is never retried on this path.
- The executor may nominate candidate completion, but a separate read-only verifier must accept it.
- The verifier can still be wrong; model judgment is not a substitute for project-specific deterministic checks.
- Operator-defined checks run as explicit executable/argument arrays (`shell: false`) with a bounded timeout. A write-capable mission cannot reach `COMPLETED` with zero checks or any failing check. Receipts record status and output hashes instead of raw secret-bearing logs. This guarantees only that the configured checks succeeded, **not** that every acceptance criterion was deterministically proven.
- A check's timeout is a **hard failure deadline**, including when its original process exits but a descendant holds inherited stdout/stderr handles open. On timeout the verifier fails closed and stops waiting on the pipes; on POSIX it kills the dedicated verifier process group, and on Windows it requests native `taskkill /T /F` tree termination (then attempts direct termination). Windows cannot reliably discover descendants if their parent has already exited; orphan cleanup is best-effort, not a guaranteed sandbox boundary. This does not authorize running untrusted verifier commands or claims of unattended Windows process isolation.
- SQLite schema v2 adds checks configuration; v3 adds durable channel command de-duplication; v4 adds the Goal → Plan → Work Item → Acceptance ledger; and **v5** adds the independent Goal release target, verification receipts and immutable DONE completion record. Writable Store openings migrate older schemas transactionally without replaying existing Missions, requests, events or prompt snapshots. Read-only diagnostics support existing v3–v5 databases without migration, while Goal ledger/release actions require schema v5.

### Durable Goal ledger (schema v5)

The optional `GoalLedger` in `src/core/goal-store.ts` operates **on the same Store/SQLite connection and transaction primitive**. Each Goal has an owner-supplied idempotency key, objective, priority (0–100), lifecycle status and optimistic version. Plans are ordered per Goal and initially `DRAFT`; a partial unique index allows at most one `APPROVED` plan. Plans contain stable-key Work Items with priorities, statuses, acceptance criteria and same-plan dependencies. Work item dependencies must form a DAG, and both application checks and composite SQLite foreign keys reject missing/cross-plan dependencies. A Work Item cannot advance to `READY` without an approved plan, become `PASSED` without all of its Acceptance records marked `PASS` and evidence references, or advance while prerequisites remain incomplete.

All state-changing operations use `Store.atomic()` and durable idempotency keys. Repeated keyed mutations return the original result without another write; repeated Goal creation returns the existing Goal's *current* version. Changed intent using a reused key fails. Optimistic versions reject stale changes, including across separate connections. A separate append-only `goal_events` sequence records lifecycle, plan creation, status, historical evidence references and digests; SQL triggers reject updates and deletes. Versioned Goal/Plan/Work/Acceptance data remains accessible after a restart without any Chat/Mission record. This does **not** migrate historical Missions into invented Goals or modify the existing PI planner, Playwriter, Send, or recovery paths.

**Evidence boundary:** `PASS` and `PASSED` are persisted *PI-reported statuses*, not independent business completion. Goal creation and status are now available through authenticated Telegram owner commands, but only the separate SHA-bound `GoalReleaseGate` can certify immutable DONE, after all independent requirements pass. Neither a Goal API nor synthetic tests prove a software release or business completion. Never migrate an active GMK database outside the original SQLite idle/drain, backup and pull-only upgrade gates.

### Multiple independent Goals, one browser Worker

An authenticated `/goal-build` creates a **new** Goal, request-keyed
Mission, approved per-repository write scope and Chrome-profile binding in
the original SQLite, even while another Goal is running or an original Send
is unsettled. Intake never sends to Chrome and never turns Goal B into
Goal A's owner note. The legacy `/build` path remains single-task.

The original leased Telegram Worker selects eligible Goals with a durable
round-robin cursor. It yields only **after** an entire browser Send has been
observed and its matching PI decision committed, and only if another Goal
is runnable. On resume it independently verifies the precise linked Chat
URL, original prompt SHA, complete assistant SHA and PI decision. Reserved
or uncertain Sends globally prohibit switching, though independent Goal
intake remains available. Request keys, conversation locks, one-shot Retry,
eight-Send Chat rollover and durable original prompt snapshots are enforced.
Only one browser Worker, one SQLite and one inbox/queue are used.

The Worker control cycle has three ordered phases: authenticated Telegram
inbox intake, durable Mission/Goal recovery and dispatch, then best-effort
outbound reply/notification delivery. The first phase must succeed before new
browser side effects so a queued owner pause is applied first. Outbound
`sendMessage` failures leave the original reply or event cursor pending but
cannot skip the scheduler; a failed inbound `getUpdates` call still defers
dispatch because unseen owner commands may exist. Startup recovery follows
the same order. This reuses the existing lease and SQLite state machine rather
than introducing a second scheduler or queue.

Per-path operator permissions use
`telegram.build.allow.<SHA256(absolute path)>` in private SQLite.
Legacy single-project approval is compatible, but PI's separate tool-free
inference project no longer determines the repository of every Goal. Each
Mission's original `workspace` and `sandbox` are checked again before
every Send, including after revocation and restart. This controls the
controller's authorization and work-package prompt scope, **not** the OS
permissions of ChatGPT's independently connected tools.

### Goal work Prompt isolation (WP3)

The first new owner-requested, Goal-bound Chat retains the full Goal **only as read-only discovery context**. `browserGoalPlanningPrompt` removes any write/deploy authorization from the first Send even when the Goal's eventual workspace is writable, and asks for bounded work packages, evidence gaps and recovery checks. Its answer is planning evidence, never an executed work item or independent PASS. PI must approve a durable Goal Plan and select one Work Item before the second, executable Send. For a **bound, active Goal** with an approved plan and exactly one dependency-ready `IN_PROGRESS`/`REVIEW` Work Item, `goalWorkPrompt` projects just the work title/key, description, numbered acceptance criteria, current PI-selected instruction, minimal approved workspace/read-only scope and the output marker contract. It excludes owner-wide Goal text, original overall acceptance, PI planning summary/decision policy, browser Send limits, previous model answers and handoff excerpts. This applies to ordinary same-Chat work, 8→9 new Chat, and an inherited legacy finite-limit successor Mission first Send; unbound legacy PI Missions continue using their **unchanged** older prompt builders.

The existing `executeBrowserTurn` and `executeBrowserRollover` reserve the `goal-work-v1` text and SHA in the **same SQLite transaction** as the original browser request, after checking current approved Goal/Plan/Work version, PI decision digest and pending owner notes. Its append-only `chatgpt.browser_reserved` event includes the format, Goal/Plan/Work IDs and work/PI versions/hashes, not the prompt body. The full exact prompt snapshot lives only in the private SQLite meta key keyed by original Mission/request. Changes during the preflight fail *before* Send; after an uncertain Send, later Goal changes cannot alter its original bytes.

The explicit, existing `browser-recover-rollover` recovery command reads the immutable versioned snapshot and validates its original reserved SHA. A present malformed/mismatched snapshot **fails closed**, never falls back. For a new Goal-bound *first* reservation without a snapshot, recovery determines Goal ownership from SQLite and tries the new planning-only prompt, then the pre-upgrade fresh-task format, against its frozen SHA. Unbound first-Send and later compact/legacy reconstruction stay backward-compatible; mismatch refuses recovery. No recovery path authorizes an unsanctioned duplicate Send or Retry. The narrow native maximum-length exception permits exactly one first Send of the SHA-matched unsent draft with a separate durable intent; it never replays a sent draft. Isolated fixtures cannot prove production 8→9 or GMK acceptance. Legacy 32→successor evidence is no longer required for new release targets.

### PI Goal management (WP2)

Goal enrollment is opt-in. The authenticated Telegram `/goal` or
`/goal-build` creates the Goal, one original request-keyed PI Mission and
its repository/profile binding in a single SQLite transaction. Queued Goal
intake never requires an earlier Goal's browser Send to settle; the
single Worker **dispatch** does. A repeated authenticated update with the
same active objective and repository reuses that Goal rather than creating
another; the same objective in a different independently approved repository
is a separate Goal. Only original, zero-Send Goal dispatch may safely
bootstrap a missing approved ChatGPT launch tab; continuation, ambiguous
Send recovery and successor handoff must use their exact original tab.
The underlying `GoalLedger.bindPiMission` still refuses a second live
independent root for the **same** Goal. Preexisting Missions are not
backfilled, and finite-limit historical successors keep their inherited
association without any request replay.

After the first **fully observed** browser answer, the existing `reviewPiRound` dispatches a Goal-bound Mission to the project's PI planning/review methods. PI proposes a bounded dependency-DAG plan, which is validated and persisted; the plan is approved before a work item may leave PENDING. The highest-priority eligible item is selected, and its work directive becomes the `NEXT` instruction under the original PI `commitPiPlan` and browser Controller. Subsequent answers are reviewed as `PASS/PARTIAL/FAIL/REPLAN/BLOCKED`: PASS records a *PI-reported* acceptance and chooses the next eligible item; PARTIAL/FAIL keep the same item in scope; REPLAN supersedes the prior plan without discarding history, and carries any new item whose key or exact acceptance obligation already PASSED in this Goal forward as PASSED (in dependency order, with its original evidence references) rather than scheduling it again; BLOCKED retains evidence and uses the existing PI terminal action. When PI passes the last package of the approved plan (its review is told that this PASS completes the whole owner Goal, and to REPLAN instead if anything is missing), the controller writes one immutable `goal_completions` row and commits PI action DONE; the Goal is DONE and every later Goal write or browser Send for it is refused. A ChatGPT `[MISSION_RELAY:DONE]` marker alone never completes a Goal. After the owner fixes an external blocker, `/goal-continue` binds a fresh Mission to the same Goal (old Mission untouched); its first read-only discovery turn and the next PI plan reuse every PASSED item. A PI-requested context rollover maps to HANDOFF, obeying the eight-Send-per-Chat limit; old finite-limit Missions and original append-only browser history remain intact.

Goal planning and plan approval are internal PI/controller operations, with no user-visible stage, review or activation ceremony. Work review receives prior verdicts for the **same active item** from the append-only PI ledger. After repeated PARTIAL/FAIL, PI is directed to seek real evidence or REPLAN a missing prerequisite rather than request another editorial rewrite; this does not automatically pass work, replace missing evidence or allow a second Send. The controller owns all persistence and execution authority.

The Goal state changes, PI plan approval/review event, full browser answer SHA, acceptance versions and the **same** `Store.commitPiPlan` decision are atomic. A failed or stale commitment rolls back all Goal mutations; no separate scheduler or second browser Send path exists. Recovery uses the existing durable PI plan and original browser receipt, not a model replay. Owner notes submitted after plan approval but before execution can revise the current PI NEXT without mistaking the old planning response for a package PASS. Subsequent Goal-bound browser Sends now contain the scoped work-item-only `goal-work-v1` prompt and immutable reservation snapshot; old prompts retain exact legacy reconstruction. PI is tool-free and reported evidence remains untrusted until the independent release checks. Synthetic driver tests are **not** unattended real Chrome production acceptance.

## Adapters

The built-in engine and Telegram channel share the current SQLite Mission
state. Codex is an optional separately installed executor plugin, not a core
dependency. Future adapters must use versioned contracts without bypassing
core state transitions:

- `Executor`: initialize/resume a session, run a turn, receive events.
- `MissionProvider`: retrieve, watch and command native or external missions.
- `Channel`: receive authenticated human commands with request IDs and expected mission revisions, enforce risk restrictions and publish notifications.
- `ComputerUse`: start/revoke interactive browser or desktop handoff.
- `Verifier`: provide trusted deterministic evidence and/or independent model review.

The public package has no operator-managed host dependency. operator-managed host is an optional provider and should not duplicate its authoritative state.
