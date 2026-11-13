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
| Independent Goal release | `goal-release*.ts`, `request-ledger.ts`, `pi-evidence.ts` | Source/CI/prod evidence checks, independent of model success claims |

The production import graph has no confirmed orphan modules. The native PluginRegistry validates manifests while executor-plugins explicitly loads trusted local modules; these are different layers, not redundant providers. Browser, native and PI execution remain distinct. The compiler rejects unused locals and parameters. Operator-specific historical milestone narratives are not part of the public v1.0 source history. An npm production-dependency audit found seven moderate advisories transitively linked to pinned Playwriter 0.9.0 (none high/critical). A suggested downgrade to 0.5.0 is not a compatible security fix without separate extension, Chrome-target, and recovery tests. Do not change the pinned browser integration merely to silence a package advisory.

## Goal release gate (WP5)

**WP6.1 GitHub-native release proof:** When the existing GMK SSH identity
cannot read operator-managed host's private repository, the already-installed `gh` CLI
uses the GMK checkout's original GitHub `origin` only for repository
identity; the current GitHub `main` SHA and exact Actions run are fetched
fresh from GitHub with a minimal subprocess environment. The verifier
checks the run belongs to the exact repository and revision and that the
mandatory `npm ci`, `privacy-check`, `check`, `test`, and `build`
steps all succeeded. The four source-script Goal gates may be satisfied
by their independently observed CI outcomes, but a green workflow does
not grant the separate Chrome, Mission 32→successor, tab retirement,
maintenance, GMK deployment or owner-business Goal criteria. The
existing operator-managed host SSH fixed-command probe remains opt-in, never escalates
permissions or changes another service. Source-only verification is not
a production release.

**WP6 cross-host implementation:** The release CLI is hosted beside the
private Goal SQLite and real Chrome on Windows. `telegram.build.project`
is the **approved remote operator-managed host path**, not a Windows-local directory. To
avoid duplicating source checkouts, the release SHA/CI/check adapters use
the existing validated `telegram.pi.sshHost` and exact remote project,
with fixed, bounded SSH commands. Clean `main`, remote HEAD and
`origin/main` must match before and after verification. SSH permission
errors are blockers; no automatic sudo/ACL/group change is authorized.
These tool readbacks must not be inferred from the old GMK checkout or
from a PI work-item report. An in-flight production Send still forbids
the maintenance drain and any GMK runtime promotion.

The Goal ledger uses additive SQLite schema **v5**. `GoalReleaseGate` is an
evidence verifier, not a PI dispatcher. It creates an exact Git SHA release
target only after the approved plan's Work Items and their criteria all have
PI-*reported* PASS; that report never counts as independent acceptance.
Eleven current-Goal release gates cover check, privacy, full tests, build,
Ubuntu/macOS/Windows CI, live 10→11, maintenance recovery,
tab retirement and GMK readback. Every work criterion adds its own independent
evidence requirement. A verified receipt records source, original proof
digest, reference, target SHA, observed time and bounded freshness. Every
target change invalidates prior current receipts while retaining historical
append-only audit events. Changed Goal/plan/work versions, missing/expired
evidence, source/receipt audit mismatch, failed verification, or wrong main
SHA deny DONE. Completion is an immutable row with an append-only audit
event, exposed as logical Goal `DONE`; the old v4 `goals.status` CHECK
constraint and historical rows remain untouched.

Only an independent probe supplied by the trusted controller can record
verification; there is no free-form `mark PASS` endpoint. First-party
local command probes run only fixed npm scripts against a clean, currently
checked-out `main` matching `origin/main`, keep original run logs outside
the repo with SHA-256 references, and directly inspect GitHub Actions
exact-head, per-platform step outcomes via `gh`. Local CLI mutation commands
require the existing locally approved build project and do not run any
ChatGPT Send, Retry, Chrome action or GMK update. The Chrome/GMK/criteria
probes are deliberately restricted to independently observed evidence. The
first-party `gmk-production-readback` adapter now checks the installed
Worker/compiled manifest, original enrolled Scheduled Task, SQLite and pinned
Chrome read-only, but it remains **unverified in production** until a safe
exact-SHA checkpoint. The first-party Chrome 10→11 (legacy 5→6) and same-Mission Relay tab-retirement probes now
capture two stable, hashed physical Target/Chat transcripts **before** old-tab
cleanup, then compare the enabled physical Target inventory before and after
closure, without reading unrelated tab contents. Original witnesses are
private, write-once, content-addressed, source-SHA-bound and captured
within a bounded window of the original event; historical witnesses do not
expire after 24 hours, but newly issued Release Gate receipts still do.
The original hashes must later reconcile with requests and independent
PI decisions. The release
CLI verifies them only under the compiled, clean runtime's exact SHA.
Historical event indexes alone never substitute for a captured physical
witness, and a failed close or absent witness never becomes PASS. The tab
release check also refuses any additional Goal-bound logical retirement
without its own independent physical witness. The separate first-party
**Legacy 32→successor** probe preserves a stable physical snapshot of both the
parent's final reply and the child's first fully observed reply before either
tab can be discarded. It validates the complete 32/32 parent ledger, five
Sends per parent Chat, one reciprocal zero-turn successor, exact Goal/work
binding, the child's first reserved prompt, different Chat URLs and Chrome
Targets, and the first matching child PI decision. Witnesses are private,
content-addressed and source-SHA-bound; a missing original physical Target,
recovered logical rollover without a new physical migration, duplicate
successor or changed answer fails closed. In Goal-bound successor rollover
the parent tab is retained instead of creating an unverifiable cross-Mission
tab-retirement claim; unbound legacy cleanup retains its previous behavior.
These probes have **synthetic test coverage only** until deployed and
exercised on an owner-approved *nonhistorical* real Chrome Mission.
Existing historical evidence cannot retroactively become live Chrome proof.
The maintenance-resume probe now checks the owner-enrolled Windows
Upgrade journal SHA-256 chain, actual drained SQLite backup, integrity,
original event prefix, Mission preservation, source/compiled Worker,
restart PID, and fresh physical Chrome/PI custody. Missing evidence,
failed restart or rollback is never production PASS.
The backup-to-live comparison also checks each preexisting Mission's
immutable scope/identity, and requires errored or owner-stopped PAUSED
Missions and completed/cancelled Missions to retain their state, turn count,
stop flag, error and exact original browser receipt. New, unprotected work
may advance after the upgrade; its mutable turn counters are not treated
as a historical freeze. All checks are read-only and use the original
consistent SQLite snapshot, never a reconstructed or replayed request.

Independent-work requires an operator-reviewed PRIVATE mapping of the
exact Goal acceptance criterion to a tracked executable test, original
reviewed browser evidence and a PI decision. On the single approved operator-managed host
main checkout it runs only the mapped test file and requires one uniquely
passing named TAP assertion. Raw logs and exact-SHA receipts stay private.
Green CI, a model PASS or a generic test unrelated to the criterion
does not automatically establish a business outcome. Every unmapped
criterion remains PENDING; this is not a general semantic oracle.
The gate stays fail-closed without every independent receipt.
Never confuse a green synthetic test, stored receipt, or source-only DONE
algorithm with an actual software release and independent business acceptance.

## System of record

A **Mission Provider** is the only authority for a given mission. The native provider stores mission state in SQLite through Node's bundled `node:sqlite` API (Node 24+); future external providers (e.g., operator-managed host) remain authoritative for their own missions. Never copy editable states into a competing database.

The native engine is not an Agent Runtime. It orchestrates bounded turns through an optional **Executor plugin**, with no required coding-agent SDK or model vendor. Agent credentials and actual sandbox enforcement stay with the installed executor, not Mission Relay.

An operator may register or adopt a ChatGPT conversation against a native Mission. This link and audit event never reassign ChatGPT's own state authority. Linked Missions refuse native executor dispatch, but an explicit **Playwriter browser turn** can reserve a local Mission turn, submit through the exact authorized Chrome tab, observe a reply, and pause for human verification. Consequential ambiguity becomes `NEEDS_RECONCILIATION` with no automatic replay. Chrome page text and model-provided flow markers are untrusted; browser observation alone cannot mark `COMPLETED`.

An existing human-started conversation can instead be *adopted*: the latest visible user prompt and answer are read twice to establish a stable initial SHA-256 checkpoint, recorded as `chatgpt.browser_adopted` with **zero Relay sends and zero credited turns**. PI can decide DONE/BLOCKED immediately, or authorize the first Relay Send in the **same** existing tab. There must be exactly one approved Chrome profile, an exact canonical chat URL, no generation, and no other active Mission owning the URL. This does not authorize a generic page click or a new provider.

Playwriter's connected-tab listing is **not evidence of Chrome tab-group membership**. This is no longer a requirement: a locally enabled, profile-pinned browser watcher baselines already-connected ChatGPT dialogs and detects subsequent new/changed human ChatGPT requests, independent of any tag/group. It reuses the single Telegram controller process and existing PI/SQLite infrastructure, and never scans DOM content outside recognized canonical ChatGPT conversation URLs. Only Playwriter-enabled tabs are visible, not every Chrome tab. The watcher is opt-in, not enabled by installation. On the owner host it has been explicitly enabled and a distinct *post-fix* real Chrome → PI → Telegram two-stage Send acceptance passed, including exact request/reply hashes and no-replay controller restart. Neither deployment nor a model flow marker is proof of unattended arbitrary browser or connector work.

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

### Goal work Prompt isolation (WP3)

The first new owner-requested, Goal-bound Chat retains the full Goal **only as read-only discovery context**. `browserGoalPlanningPrompt` removes any write/deploy authorization from the first Send even when the Goal's eventual workspace is writable, and asks for bounded work packages, evidence gaps and recovery checks. Its answer is planning evidence, never an executed work item or independent PASS. PI must approve a durable Goal Plan and select one Work Item before the second, executable Send. For a **bound, active Goal** with an approved plan and exactly one dependency-ready `IN_PROGRESS`/`REVIEW` Work Item, `goalWorkPrompt` projects just the work title/key, description, numbered acceptance criteria, current PI-selected instruction, minimal approved workspace/read-only scope and the output marker contract. It excludes owner-wide Goal text, original overall acceptance, PI planning summary/decision policy, browser Send limits, previous model answers and handoff excerpts. This applies to ordinary same-Chat work, 5→6 new Chat, and an inherited 32→successor Mission first Send; unbound legacy PI Missions continue using their **unchanged** older prompt builders.

The existing `executeBrowserTurn` and `executeBrowserRollover` reserve the `goal-work-v1` text and SHA in the **same SQLite transaction** as the original browser request, after checking current approved Goal/Plan/Work version, PI decision digest and pending owner notes. Its append-only `chatgpt.browser_reserved` event includes the format, Goal/Plan/Work IDs and work/PI versions/hashes, not the prompt body. The full exact prompt snapshot lives only in the private SQLite meta key keyed by original Mission/request. Changes during the preflight fail *before* Send; after an uncertain Send, later Goal changes cannot alter its original bytes.

The explicit, existing `browser-recover-rollover` recovery command reads the immutable versioned snapshot and validates its original reserved SHA. A present malformed/mismatched snapshot **fails closed**, never falls back. For a new Goal-bound *first* reservation without a snapshot, recovery determines Goal ownership from SQLite and tries the new planning-only prompt, then the pre-upgrade fresh-task format, against its frozen SHA. Unbound first-Send and later compact/legacy reconstruction stay backward-compatible; mismatch refuses recovery. No recovery path authorizes a second Send or Retry. Isolated fixtures cannot prove production 5→6 or GMK acceptance. Legacy 32→successor evidence is no longer required for new release targets.

### PI Goal management (WP2)

Goal enrollment is opt-in: the existing authenticated Telegram `/goal` or `/goal-build` path creates a durable Goal, an unstarted PI Mission and one exact browser binding transactionally after owner/browser/PI preflights. The underlying `GoalLedger.bindPiMission` API retains the same strict scope and unstarted-Mission checks. Existing Missions are not backfilled, and a live independently bound second Mission root for the same Goal is refused. A historical 32-turn successor resolves the binding through the existing reciprocal PI parent chain, without changing the owning Goal. Before a fresh owner Goal can start, the controller checks *all* previous PI Missions for a reserved or uncertain original browser Send, **including those with an owner pause flag**. An owner pause is not a request settlement. Once that original Send is durably observed and the owner pause remains in force, a separate fresh Goal can start without unpausing, replaying or inheriting the previous Mission or its work.

After the first **fully observed** browser answer, the existing `reviewPiRound` dispatches a Goal-bound Mission to the project's PI planning/review methods. PI proposes a bounded dependency-DAG plan, which is validated and persisted; the plan is approved before a work item may leave PENDING. The highest-priority eligible item is selected, and its work directive becomes the `NEXT` instruction under the original PI `commitPiPlan` and browser Controller. Subsequent answers are reviewed as `PASS/PARTIAL/FAIL/REPLAN/BLOCKED`: PASS records a *PI-reported* acceptance and chooses the next eligible item; PARTIAL/FAIL keep the same item in scope; REPLAN supersedes the prior plan without discarding history; BLOCKED retains evidence and uses the existing PI terminal action. When no work remains, the existing PI action is BLOCKED pending independent release verification, not Goal DONE. A PI-requested context rollover maps to HANDOFF, obeying the ten-Send-per-Chat limit; old finite-limit Missions and 5→6 history remain compatible.

Goal planning and plan approval are internal PI/controller operations, with no user-visible stage, review or activation ceremony. Work review receives prior verdicts for the **same active item** from the append-only PI ledger. After repeated PARTIAL/FAIL, PI is directed to seek real evidence or REPLAN a missing prerequisite rather than request another editorial rewrite; this does not automatically pass work, replace missing evidence or allow a second Send. The controller owns all persistence and execution authority.

The Goal state changes, PI plan approval/review event, full browser answer SHA, acceptance versions and the **same** `Store.commitPiPlan` decision are atomic. A failed or stale commitment rolls back all Goal mutations; no separate scheduler or second browser Send path exists. Recovery uses the existing durable PI plan and original browser receipt, not a model replay. Owner notes submitted after plan approval but before execution can revise the current PI NEXT without mistaking the old planning response for a package PASS. Subsequent Goal-bound browser Sends now contain the scoped work-item-only `goal-work-v1` prompt and immutable reservation snapshot; old prompts retain exact legacy reconstruction. PI is tool-free and reported evidence remains untrusted until the independent release checks. Synthetic driver tests are **not** unattended real Chrome production acceptance.

## Adapters

The built-in engine and experimental Telegram channel retain evidence from the historical 2026-11-04 read-only Codex pilot, but Codex is now an optional separate plugin. Future adapters implement versioned contracts without modifying core state transitions:

- `Executor`: initialize/resume a session, run a turn, receive events.
- `MissionProvider`: retrieve, watch and command native or external missions.
- `Channel`: receive authenticated human commands with request IDs and expected mission revisions, enforce risk restrictions and publish notifications.
- `ComputerUse`: start/revoke interactive browser or desktop handoff.
- `Verifier`: provide trusted deterministic evidence and/or independent model review.

The public package has no operator-managed host dependency. operator-managed host is an optional provider and should not duplicate its authoritative state.
