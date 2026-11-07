# Mission Relay

**GMK pull-only upgrade:** After the original browser Send has settled and an
explicit cooperative maintenance pause has made the SQLite idle gate pass,
`scripts/windows/telegram-task.ps1 -Action Upgrade -ExpectedSha <verified-main-sha>`
uses the **existing** interactive-user Scheduled Task. The maintainer may run
from remote Session 0 because it never launches Chrome; the actual Worker
must remain in a verified interactive, limited-privilege task and refuses
Session 0. It rejects dirty or divergent GMK checkouts, active work, missing local build tools and
an unexpected fetched GitHub SHA. Under the atomic drain it stops the old
worker, fast-forwards only `main`, builds using existing dependencies (never
`npm ci` on a locked DLL), and verifies the restarted single poller. Failed
updates restore the prechecked HEAD and compiled `dist` only when rollback is
verifiable; uncertain recovery retains the drain and stops rather than risk
another browser Send. An optional `-ResumeMissionId <uuid>` invokes the
existing exact-checkpoint `pi-resume` gate after restart. This is a locally
invoked, tested operational action, **not** evidence of an executed GMK
deployment or an automatic release service.
An older GMK checkout may not yet contain the `Upgrade` action; its **first**
promotion must instead bootstrap the same idle-only SQLite drain, verified
fast-forward, rollback and interactive Scheduled Task restart. Never run an
unavailable `Upgrade` command or pull source over a live browser Send.
On that first upgrade only, after a fully settled cooperative pause and
successful local maintenance preflight, fetch the exact reviewed commit into
Git's object database **without modifying checkout files**, extract
`<sha>:scripts/windows/telegram-task.ps1` as raw bytes into a private
temporary `.ps1`, then invoke it with
`-Action Upgrade -BootstrapRoot <existing-GMK-checkout> -ExpectedSha <sha>`
(optionally `-ResumeMissionId <eligible-paused-mission-id>`). The temporary
script's SHA-256 must equal the exact reviewed Git blob or it fails before
draining the worker. It checks the **existing registered Worker path** and
never starts Chrome from Session 0. Delete the temporary script afterward;
future upgrades use the installed `Upgrade` action directly.

**Windows maintenance diagnostics:** The local read-only
`scripts/windows/telegram-restart-check.mjs <absolute-sqlite-path>` reports
sanitized counts for active Missions, unsent PI tasks, undelivered Telegram
command replies, reserved browser Sends and unsent event notifications. The
atomic SQLite channel drain checks the same notification cursor so a paused
Mission with an undelivered result cannot be upgraded prematurely. Exit 3
means restart is forbidden; malformed cursor/receipt or unreadable database
exits 2. Neither diagnostic authorizes a second browser Send or force-stop.

**Unattended recovery after Chrome/Playwriter restart:** An independently
settled PI NEXT/HANDOFF checkpoint remains eligible when the pinned Chrome
connector temporarily fails or its page is still loading/generating. The
single leased Telegram controller retries **read-only** preflight no more
often than once per 60 seconds; it never repeats the previously observed
request. A pinned prompt or assistant SHA mismatch still halts the task for
inspection. Reserved/uncertain original Sends are excluded from this recovery
and must never be replayed. The behavior is separately subject to actual GMK
restart/re-authorization acceptance; synthetic regression is not live proof.

**Read-only pending-request provenance:** `pi-evidence <mission-id>` now
includes `activeRequestEvidence` for a currently `reserved` or `uncertain`
request, containing only the unique original reservation event ID, pending
round, prompt SHA-256, receipt status and new-chat *intent*. The reader
rejects missing, duplicated or mismatching reservations as a ledger violation.
This is not proof that Playwriter clicked Send or received an answer, and does
not reveal prompt text, request keys, URLs or user messages. A completed
request has no active pending evidence; examine `rounds` instead.

**New-chat diagnostic:** `pi-health.browserNewChatReserved` and `pi-evidence.pendingNewChatReservation` identify only the existing SQLite reservation's new-conversation intent. Telegram `/status` labels this *reserved only*; it does not prove the new tab, submitted message, URL migration or answer exists. A 5/5 old-chat count plus an unobserved sixth reservation is not completed rotation evidence.

**Pinned browser binding health:** `browser-binding-health <mission-id>` is a read-only check of the exact linked conversation against the already Playwriter-enabled tabs in its approved Chrome profile. It returns whether exactly one matching tab is exposed and (only for a reserved/uncertain request in that tab) whether the latest user-message hash matches the original request. It never exposes raw Chat URLs, browser IDs, request keys or prompt text, never reads unrelated chat messages, opens a tab or submits Send/Retry, and never treats a matching prompt as proof that the assistant finished.

**Post-correction audit continuity:** After a falsely attributed response is independently amended and PI re-reviews the corrected SHA, `pi-evidence` distinguishes that historical completed answer from the *next* active reserved request. It accepts the pending new reservation only if its exact request key, prompt hash and event ordering link to the corrected PI NEXT/HANDOFF decision. No extra observed round is credited. An unlinked or tampered active receipt remains an integrity violation.

**Chrome recovery preflight deadline:** The read-only transcript and connector checks before a PI continuation or browser Send reservation are bounded to 30 seconds per operation. This also covers both full-page snapshots and latest-user prompt SHA checks in an ordinary `browser-drive` fifth-to-sixth Chat handoff, before the new-tab reservation. On timeout the controller fails closed without a new browser Send; any Playwriter connection arriving after its deadline is closed. This is not a timeout on long-running ChatGPT generation, not a browser Retry, and not automatic recovery of an already ambiguous Send.

**Old Relay-owned tab retirement receipt:** After a successful new Chat URL+answer migration, the same running controller can close only the previous tab that it itself created, and only after the Page reports `isClosed()`. It appends a hashed `chatgpt.browser_tab_retired` event linked to the earlier Relay-created page and completed migration; read-only `pi-evidence.tabRetirementReceipts` validates the event lineage and rejects duplicates/forgeries. Never infer permission to close a user-origin tab, an uncertain Send, or a tab from a previous process. A SQLite close receipt is a controller-reported browser readback, not an independent browser inventory confirmation; a missing receipt cannot prove the old tab remains open. The feature requires a future GMK deployment and does not retroactively certify historical tab closure.

**Owner-facing UX and distribution direction:** [Product decisions](docs/product-ux.md) documents the paginated actionable Telegram inbox (unresolved requests first), complete paginated Mission history, non-destructive archiving, read-only interactive buttons, browser/API separation, and proposed portable binary packaging. These are incremental alpha improvements, not evidence of v1.0 production acceptance.

**Browser-first, vendor-neutral by default.** With local `telegram-anchor` and `telegram-pi-config`, ordinary Telegram text, `ChatGPT: <task>` or `/auto <task>` starts a fresh ChatGPT Chrome conversation. After each fully observed answer, tool-free PI proposes a bounded NEXT/DONE/BLOCKED/HANDOFF decision. Existing human-created conversations can now be explicitly **adopted** (see below) with zero artificial turns. No coding agent, Codex SDK or model-provider choice is required for this path. Native execution remains an optional, separately installed plugin. **ChatGPT connected apps are not technically sandboxed by these prompts.** See [Telegram](docs/telegram.md).

**Long-task bounds:** PI-managed Telegram tasks allow up to 32 observed browser sends **per Mission**. A maximum of 5 Relay sends may be observed in any one ChatGPT conversation; the next PI `NEXT` automatically opens a new chat using the verified prior answer and PI checkpoint. At Mission budget exhaustion, an independently verified PI `NEXT/HANDOFF` automatically creates one durable successor Mission with identical scope and a fresh ChatGPT conversation. A `DONE` or `BLOCKED` decision does not chain. Ambiguous Sends, changed browser answers, revoked write approval and unavailable browser access fail closed without replay. PI reads up to 100,000 characters of the actual answer per decision; Telegram remains compact. PI can still decide `DONE` after one answer when the *requested task* is already complete. The authenticated owner can opt into **actual repository development** with `/build <task>` after locally approving a single remote repository via `telegram-build-project`; `/auto` remains read-only. These are scoped browser prompts, **not** an OS-level filesystem sandbox; actual connected coding-tool permissions must already be available in ChatGPT. Synthetic cross-Mission acceptance is implemented; unattended production multi-Mission acceptance remains unverified.

At the 32-turn crossover, owner notes to a newly created, unsent successor are reviewed by PI before that successor submits its first message. The revised decision and note acknowledgements are durable, and an interrupted new-tab Send can reconstruct the exact revised prompt for read-only-first reconciliation. Approval revocations are also checked atomically at Send reservation, including changes made while PI is planning.

A 32-turn `pi.autopilot_finished` **LIMIT** event means the *per-Mission budget* ended, not that the owner goal finished. `archive-settled` must keep such continuing parent Missions visible; it only archives PAUSED PI Missions with a genuine latest `DONE/BLOCKED` plan. Existing mistaken historical archive flags are preserved pending separate evidence-based repair.

An explicit `Agent: <task>` or `/agent <task>` uses an installed native executor only if one has been configured. Plain Telegram text defaults to PI-coordinated ChatGPT. There are no vendor-specific command prefixes in Core.

**Local-first mission control and handoff for long-running AI work.** Open source under Apache-2.0.

**Source/deployment discipline:** The owner deployment uses one durable Linux development checkout (AIOS), GitHub as the reviewed synchronization record, and a pull-only Windows Chrome/Telegram execution checkout (GMK). Runtime SQLite, ChatGPT profile authorization and DPAPI secrets remain on the Windows node. There is no bidirectional source synchronization or second Mission controller. See [operations](docs/operations.md#canonical-development-checkout-and-local-execution-node).

**Cooperative maintenance of a live PI Mission:** A local `pause <id>` records a stop request but does not cancel an already submitted ChatGPT message. Wait for the original browser reservation to be fully observed or conservatively reconciled and for the Windows SQLite maintenance gate to pass before updating GMK. When a paused PI Mission has a complete, independently auditable reply and remaining work, the new local-only `pi-resume <id> --revision <n> --acknowledge-side-effects` leaves it PAUSED, releases only the stop flag, and allows the single controller to recheck the exact Chrome prompt/full-answer SHA before the next PI decision. Generic `resume` now explicitly refuses PI Missions instead of corrupting an audited checkpoint by changing it to READY. An unresolved or unmarked old Send cannot be resumed or replayed.

**Live diagnostic:** `mission-relay pi-health` reports secret-free browser reservation age, PI checkpoint, per-chat observed turn count and reconciliation status without touching Chrome or resending work. Telegram `/status <mission-id>` displays the matching bounded progress after updating the runtime. An old request that is still reserved is **not** evidence of a stalled browser; use the established maintenance/recovery gates.

**Independent ledger check:** `mission-relay pi-evidence <mission-id>` reconstructs the real event sequence with one entry per observed ChatGPT Send, its request-reservation event ID, answer SHA-256, PI decision event ID and exact SHA correlation. It also counts ChatGPT conversation migrations and identifies any conversation with more than five observed Relay Sends. This command never calls Playwriter or PI and never issues a Send. A consistent event ledger is **not** proof that the assistant's claimed code changes, tests or business goal were independently verified; inspect Git/CI/deployment evidence separately.

The independent reader also rejects browser migration audit events with a missing/used request reservation, invalid or identical URL hashes, an unobserved migration, or a migration belonging to a different reply. These checks prevent an incorrectly attributed migration event from silently resetting the five-Send audit counter; they do not replace observing a real Chrome handoff.

Migration lineage is also checked across consecutive conversations: each later migration must start from the exact SHA-256 destination of the preceding committed migration, including after independently inspected recovery. A disconnected or forged source hash invalidates the ledger even if all PI answer hashes match. The first linked source URL has no earlier migration proof; these hashes do not reveal Chat URLs, and ledger consistency alone is not independent live-browser or business acceptance.

**Five-Send enforcement:** The controller automatically opens a new ChatGPT conversation after five observed Relay Sends in the current one. Independently, the SQLite Send reservation refuses a sixth same-chat dispatch, including raw CLI calls and requests following a restart. A new-conversation reservation can be credited only with a distinct observed ChatGPT URL; failure retains the original uncertain request rather than falling back to the old chat. This is a code-level safety gate, not evidence that a live 5→6 browser transition has occurred.

**Chrome long-task tab footprint:** Once a fresh ChatGPT reply and its distinct URL have been atomically committed, a continuous PI/browser-drive loop may retire its own *previously created* superseded tab after a later successful rollover. It never closes the original user-attached source or active destination; changed URLs and cleanup failures fail safely without modifying reply receipts. It does not close unknown tabs from older processes or promise zero accumulation across separate manual batches. The synthetic cleanup tests are not evidence of real Chrome memory reduction.

**Transient observation failures:** After a real Send, a single accessible assistant-text `locator.innerText` timeout can be a temporary DOM rendering issue, not a failed remote submission. The observation loop retries the same read up to two more times at two-second intervals without a new Send, bounded by the existing deadline. Persistent timeouts and all other unverified failures remain `uncertain` with their original request IDs. An old uncertain request is not automatically repaired by deploying this fix.

**Pre-reservation rollover correlation:** For PI-directed rotation (including the automatic fifth-to-sixth transition), the controller compares both the last visible user prompt and complete assistant response SHA-256 against the durable receipt again immediately before the new-tab Send reservation. If another actor changes the source conversation after the earlier PI preflight, no new browser request or tab is created. This has deterministic race tests; an actual production 5→6 migration still requires independent readback.

**Pre-reservation same-chat correlation:** The same last user-prompt and complete assistant-response hashes are rechecked immediately before an ordinary PI NEXT existing-chat Send, and before sequential manual NEXT/HANDOFF steps. If another actor changes the source after the first preflight, the next Send is refused without creating a request key. This is regression-tested locally; it does not prove live autonomous recovery or multi-turn production success.

**Successor first Send:** A newly created PI child Mission at the 32-turn limit cannot submit its first Send into the predecessor's ChatGPT conversation: SQLite requires a fresh-chat reservation, checks its reciprocal parent link and verified continuing parent checkpoint, and refuses a parent whose owner has paused or whose record has changed. The distinct ChatGPT URL and observed answer still need verification before crediting the child. Synthetic tests establish this gate; real 32→1 production acceptance is a separate requirement.

**Cross-Mission audit:** `mission-relay pi-chain-evidence <mission-id>` follows the existing parent/successor SQLite links without dispatching anything. Each 32-to-1 link must preserve the exact authorized scope, full answer hash and PI NEXT/HANDOFF/LIMIT checkpoint, and the child's **first** observed Send must be in a new ChatGPT conversation. The report does not claim release readiness or business acceptance; a single-node chain means no 32-turn handoff has yet occurred.

Mission Relay turns a goal and explicit acceptance criteria into a durable mission. It uses an existing AI agent for work, saves checkpoints, determines whether another turn is needed, and independently verifies a candidate result **for supported native executors**. It does **not** reimplement an agent runtime, copy browser profiles, or extract ChatGPT credentials or internal APIs. The opt-in ChatGPT adapter reads visible UI text; a browser reply alone does not constitute independent mission verification.

**Windows process lifecycle:** An optional interactive-user Scheduled Task can manage the single Telegram poller after one-time owner-only DPAPI credential enrollment. It offers bounded crash restart, an in-process five-minute idle-loop soft-stall exit after strict SQLite safety checks, and a gated idle restart after a new build; no task is created by installing Mission Relay. A completely blocked JS event loop cannot self-exit. Playwriter is an independent process. See [Telegram task lifecycle](docs/telegram.md#optional-windows-task-lifecycle-requires-local-owner-enrollment).

**Telegram connection health:** `node dist/cli.js channel-status` distinguishes `pollerPresent` from `transportHealth`. A live PID is not sufficient: `healthy` requires a successful Bot API `getUpdates` call by that specific leased process within 90 seconds; the timestamp is visible without exposing credentials or messages. The Windows task waits for this fresh heartbeat after a start/restart.

**Observed Windows lifecycle behavior (November 2026):** The enrolled Task Scheduler job uses a daily two-minute repeating trigger with `IgnoreNew` and its original login trigger; a separate secret-free test task recovered after a deliberate exit-code-23 failure, whereas `RestartOnFailure` alone did not in the owner-host tests. For code upgrades, an idle-checked SQLite maintenance fence now prevents new Telegram intake and browser Send reservations; a real new-version worker stopped cooperatively and restarted with a new healthy Bot API poll, preserving message cursors. This is not a process-hang watchdog and not a security boundary for external ChatGPT connectors. See [operations](docs/operations.md).

> **Status: v0.2 Alpha; a new post-fix real Chrome Watch → tool-free PI → ChatGPT → Telegram two-stage acceptance passed on 2026-11-05.** An owner-authorized text-only first message in a fresh Playwriter tab was observed and auto-adopted with zero Relay Sends. PI persisted `NEXT`, reserved and observed exactly one subsequent browser Send, and persisted `DONE` with one final audit event. Exact latest-user-prompt and full-assistant SHA-256 readback matched the actual Chrome transcript; the Telegram notification cursor reached the terminal event with no pending replies. A cooperative production controller restart subsequently preserved the exact same one-Send/one-answer/one-final-decision counts without replay. The dedicated test tab was closed afterward; the local Mission audit and actual ChatGPT conversation remain available. The owner phone screen was not independently inspected. This supersedes the earlier pre-fix observer-race limitation; it does **not** certify unattended connector writes, arbitrary browser gestures, hard-hang recovery or independent business-goal completion. Only Playwriter-enabled ChatGPT tabs are visible. See [STATE.md](STATE.md).

**Attended acceptance and reliability history (2026-11-04):** The owner initiated a real Telegram command from a phone and confirmed receipt of the final notification after one authorized Chrome ChatGPT turn; the complete visible answer hash matched SQLite's reserved/observed/finished audit trail with no replay. At that *earlier verifier-timeout milestone*, the suite had 112 Linux tests / 111 Windows passes with one POSIX-only case skipped; these figures are **historical**, not the current test count. Operator-configured deterministic checks now have a hard failure deadline, including inherited-pipe hangs; POSIX uses a dedicated process group and Windows attempts native tree cleanup. This is **not** permission to run untrusted verifier commands or a guarantee that Windows can clean descendants of a parent that has already exited. Browser-observed model `DONE` remains distinct from independent business verification.

**Primary direction:** Resume an existing ChatGPT conversation inside the operator's Chrome browser. `chat-create` / `link-chat` registers the conversation; `browser-bind` pins the approved Chrome instance. Playwriter `browser-probe` reads visible UI, while `browser-send` / `browser-drive` submit bounded turns after explicit extension enablement. Telegram `/continue` routes a browser-linked Mission to Playwriter; a separately installed native Mission uses its configured executor plugin. `/instruct` supplies a one-turn owner instruction without losing updates made during execution.

Browser replies use **one local DOM check every 60 seconds during normal generation** (60-minute default timeout, four-hour maximum), not additional model calls. `Connection interrupted. Waiting for the complete answer` is a waiting state: the same reply is observed, with a one-time bounded wait extension for default-length turns. `Message delivery timed out. Please try again.` allows one click on its exact visible `Retry` button for the already-reserved message, after verifying the pinned conversation and original user-prompt hash; it does **not** permit another composer Send. New-tab initialization and final-response stability use short bounded checks. `HANDOFF` may open a new Chrome tab and atomically update the Mission link after a complete observed response. A Telegram-initiated batch emits **one final compact summary** while retaining every turn receipt in SQLite. Pre-existing ChatGPT load errors do not prove a newly submitted turn failed; `browser-recover-turn` can re-observe a complete original-chat reply without resending. A separate `browser-correct-attribution` command repairs a **historically misattributed, already credited** latest PI answer only after independently re-observing the original request and stable full reply; it appends an auditable correction, preserves the old events, and requires a new PI review without an extra Send or credited turn. Its release does not retroactively correct old local SQLite. Browser observation is **not** independent business verification. See [ChatGPT browser control](docs/playwriter-evaluation.md), [ChatGPT handoff](docs/chatgpt-handoff.md) and [operations](docs/operations.md).

**Evidence level:** The previous Telegram→Chrome one-shot instruction was verified live. A separate bounded real two-turn pilot demonstrated autonomous `HANDOFF`→new Chrome tab→new ChatGPT direct conversation→final `DONE` receipt with no replay, correct SHA-256 and atomic Mission link. When the new tab navigates through transient URLs or ChatGPT fails to load its answer, the controller waits briefly or fails conservatively. An explicit read-only `browser-recover-rollover` path can reconcile an already completed new-chat answer after independently verifying both source and destination; it never repeats the Send. Unattended production use remains out of scope.

**Live-readiness evidence:** An authenticated native Codex Mission on Windows completed a read-only source/doc audit with a fresh independent verifier and persisted same-thread recovery after a Windows sandbox failure. A separate phone-triggered real read-only Mission executed via Telegram and reached independent `verification.accepted`, delivered to the same Telegram chat. This is not production/unattended write-readiness.

**Remote-control safety (current source):** Telegram requires a fresh `v<revision>` from `/status` for state-changing commands other than emergency `/pause`, and refuses remote start/resume/instruction of all `workspace-write` missions. The initial live phone pilot used an earlier command format; see [Telegram setup](docs/telegram.md) before restarting a previously launched poller.

## Requirements

- Node.js 24 LTS or newer (Node 24 and 26 are targeted). Local state uses Node's bundled `node:sqlite`, avoiding native addon builds.
- A local project workspace, preferably a Git repository.
- For native agent execution **only**: an operator-installed trusted executor plugin with its own authentication. The base `npm ci` no longer installs Codex.

**Executor isolation:** The Mission state remains owned by SQLite. Native plugins use their own authentication and sandbox rules; installing a plugin does not confer extra Mission Relay permissions. An optional isolated Codex adapter is distributed under `examples/executors/codex`, not imported by the default CLI. See [plugin API](docs/plugin-api.md).

## Quick start

```sh
git clone https://github.com/upaccn/mission-relay.git
cd mission-relay
npm ci
npm run build
node dist/cli.js browser-list
node dist/cli.js plugin-list  # no native executor needed
node dist/cli.js list
```

To create a ChatGPT-linked Mission in one command **without starting Codex**:

```sh
node dist/cli.js chat-create --goal "Continue the research" --accept "Verify conclusions" --url https://chatgpt.com/c/<conversation-id>
```

To adopt a human-created ChatGPT conversation **without replacing it with a new tab**:

```sh
# Enable Playwriter on that exact Chrome tab before these read-only checks.
node dist/cli.js browser-candidates --browser-id <approved-Chrome-id>
node dist/cli.js chat-adopt --url https://chatgpt.com/c/<conversation-id> --browser-id <approved-Chrome-id>
# After PI and a Telegram foreground controller are configured, queue
# chat-adopt-start <returned-mission-id>, or pass --start true initially.
```

`chat-adopt` records the stable latest human user/assistant snapshot and credits **zero** Relay sends. With `--start true`, it queues the Mission for the **existing leased Telegram foreground controller**, which checks the actual answer, invokes PI, and only sends into that **same** tab if PI requests a continuation. A 3-second stable read and exact browser-ID and URL matching are required. The CLI never becomes a competing browser writer.

To opt in to **Chrome-profile watch** (no tab-group restriction), first configure the existing foreground Telegram controller and tool-free PI route. Then use:

```sh
node dist/cli.js browser-list
node dist/cli.js browser-watch --browser-id <approved-Chrome-id>
node dist/cli.js browser-watch-status
# Only newly connected/changed Playwriter-enabled ChatGPT chats are candidates.
# To revoke discovery and stop future turns for watched Missions:
node dist/cli.js browser-watch --clear
```

Enabling creates a baseline of all currently visible ChatGPT conversations and **does not automatically run those existing chats**. Subsequent newly visible chats or new human prompts are read twice for stability, adopted at zero Relay turns, and queued for PI through the **same Telegram controller**, one Mission at a time. Two tabs showing an identical URL are never silently selected. `browser-candidates` is read-only inventory, not evidence that all Chrome tabs are accessible: the user must still enable Playwriter on each tab they want controlled. **Post-fix real production acceptance:** the complete Chrome-watch → PI NEXT → one browser Send → exact SHA receipt → PI DONE → Telegram final-notification flow passed, and a later cooperative controller restart caused no duplicated turns or notifications. This is not certification of arbitrary browser actions, connector writes, unattended operation or phone notification display. See [browser evaluation](docs/playwriter-evaluation.md).

To install an optional native coding agent, install its package separately and register its trusted absolute JS module with `plugin-register --path`, then use `plugin-list`. Multiple plugins may be installed; the first registered is initially the default and existing native Missions remain pinned to their original executor. No agent selection is required for ChatGPT. See [plugin API](docs/plugin-api.md).

Or link an already-existing Mission, using the current revision from `show`:

```sh
node dist/cli.js link-chat <mission-id> --url https://chatgpt.com/c/<conversation-id> --revision <version>
node dist/cli.js handoff <mission-id>
```

Experimental browser operations (only with the **Playwriter extension enabled on the exact ChatGPT tab**):

```sh
node dist/cli.js browser-list
node dist/cli.js browser-bind <mission-id> --browser-id <exact-browser-id-from-browser-list> --revision <current-version-from-show>
node dist/cli.js browser-probe <mission-id>
node dist/cli.js browser-drive <mission-id> --revision <new-version-after-browser-bind> --request-prefix local-pilot-001 --turns 3
```

Read the current Mission version using `show <mission-id>` before binding and again after binding. Browser Send and Drive are refused without that exact locally approved browser profile.

Use `browser-send` with a reviewed `--prompt-file` for a specific one-turn instruction. Browser actions require a foreground local process, not a second daemon or a public tunnel. See the [browser operations guide](docs/playwriter-evaluation.md).

To permit `workspace-write` missions to reach `COMPLETED`, provide explicit **operator-defined deterministic checks**, such as `--checks-file /path/to/checks.json`. See [examples/checks.json](examples/checks.json). These checks run as local commands after a candidate completion and before independent model verification. They may execute project scripts and are **not** a security sandbox. Review their effects before enabling them. Without checks, a write-capable mission pauses rather than declaring itself complete.

The default execution sandbox is `read-only`. Explicitly opt in to `--sandbox workspace-write` at creation time for tasks that genuinely require code changes. Remote production actions and unrestricted system access are not supported by the built-in engine.

`MISSION_RELAY_HOME` changes the private state directory. Run `node dist/cli.js doctor` only when diagnosing an optional native executor. Browser-first ChatGPT and PI do not require a native plugin.

## Design boundaries

- One authoritative task record, one lease, append-only events, bounded turns.
- New turns reuse their executor's thread; resume never assumes interrupted tool calls are safe to replay.
- A **fresh read-only verifier** reviews candidate completion separately from the executor. The verifier is still model-based; independent deterministic tests must be supplied for higher assurance.
- `NEEDS_RECONCILIATION` is a first-class safety state after ambiguous interruptions.
- External missions, Telegram, browser control and full desktop control belong behind versioned adapter contracts.

See [architecture](docs/architecture.md), [plugin API](docs/plugin-api.md), [operations](docs/operations.md), [Telegram setup](docs/telegram.md), and [security](SECURITY.md).

## Roadmap

1. **Current alpha (implemented):** SQLite Mission authority, profile-pinned Playwriter, browser-first zero-Send human-chat adoption, PI orchestration, Telegram commands and opted-in profile-scoped watch. No tab-group membership requirement. A real *post-fix* two-stage Chrome Watch → PI → ChatGPT → Telegram text-only acceptance passed, including one exact correlated browser Send, durable answer and terminal PI decision, followed by a no-replay production controller restart. This does not independently verify business outcomes.
2. **Next reliability gates:** Recovery from a genuinely hung production controller, naturally occurring long-task connection/Retry UI, independently observed phone-side Telegram delivery, and stronger unattended-operation evidence; do not induce disruptive failures while a Mission or Send is active.
3. **Optional extension:** Further native executor adapters and narrowly approved browser gestures only where a real user case requires them. No built-in vendor chooser or plugin marketplace is needed for the browser-first workflow.
4. **v1.0:** Cross-platform restart/recovery, security and operational maintenance gates with real evidence, not just synthetic fixtures.

Contributions welcome after the initial core stabilizes. See [CONTRIBUTING.md](CONTRIBUTING.md).
