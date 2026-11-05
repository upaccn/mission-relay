# Mission Relay

**Browser-first, vendor-neutral by default.** With local `telegram-anchor` and `telegram-pi-config`, ordinary Telegram text, `ChatGPT: <task>` or `/auto <task>` starts a fresh ChatGPT Chrome conversation. After each fully observed answer, tool-free PI proposes a bounded NEXT/DONE/BLOCKED/HANDOFF decision. Existing human-created conversations can now be explicitly **adopted** (see below) with zero artificial turns. No coding agent, Codex SDK or model-provider choice is required for this path. Native execution remains an optional, separately installed plugin. **ChatGPT connected apps are not technically sandboxed by these prompts.** See [Telegram](docs/telegram.md).

An explicit `Agent: <task>` or `/agent <task>` uses an installed native executor only if one has been configured. Plain Telegram text defaults to PI-coordinated ChatGPT. There are no vendor-specific command prefixes in Core.

**Local-first mission control and handoff for long-running AI work.** Open source under Apache-2.0.

**Source/deployment discipline:** The owner deployment uses one durable Linux development checkout (AIOS), GitHub as the reviewed synchronization record, and a pull-only Windows Chrome/Telegram execution checkout (GMK). Runtime SQLite, ChatGPT profile authorization and DPAPI secrets remain on the Windows node. There is no bidirectional source synchronization or second Mission controller. See [operations](docs/operations.md#canonical-development-checkout-and-local-execution-node).

Mission Relay turns a goal and explicit acceptance criteria into a durable mission. It uses an existing AI agent for work, saves checkpoints, determines whether another turn is needed, and independently verifies a candidate result **for supported native executors**. It does **not** reimplement an agent runtime, copy browser profiles, or extract ChatGPT credentials or internal APIs. The opt-in ChatGPT adapter reads visible UI text; a browser reply alone does not constitute independent mission verification.

**Windows process lifecycle:** An optional interactive-user Scheduled Task can manage the single Telegram poller after one-time owner-only DPAPI credential enrollment. It offers bounded crash restart, an in-process five-minute idle-loop soft-stall exit after strict SQLite safety checks, and a gated idle restart after a new build; no task is created by installing Mission Relay. A completely blocked JS event loop cannot self-exit. Playwriter is an independent process. See [Telegram task lifecycle](docs/telegram.md#optional-windows-task-lifecycle-requires-local-owner-enrollment).

**Telegram connection health:** `node dist/cli.js channel-status` distinguishes `pollerPresent` from `transportHealth`. A live PID is not sufficient: `healthy` requires a successful Bot API `getUpdates` call by that specific leased process within 90 seconds; the timestamp is visible without exposing credentials or messages. The Windows task waits for this fresh heartbeat after a start/restart.

**Observed Windows lifecycle behavior (November 2026):** The enrolled Task Scheduler job uses a daily two-minute repeating trigger with `IgnoreNew` and its original login trigger; a separate secret-free test task recovered after a deliberate exit-code-23 failure, whereas `RestartOnFailure` alone did not in the owner-host tests. For code upgrades, an idle-checked SQLite maintenance fence now prevents new Telegram intake and browser Send reservations; a real new-version worker stopped cooperatively and restarted with a new healthy Bot API poll, preserving message cursors. This is not a process-hang watchdog and not a security boundary for external ChatGPT connectors. See [operations](docs/operations.md).

> **Status: v0.2 Alpha; a new post-fix real Chrome Watch → tool-free PI → ChatGPT → Telegram two-stage acceptance passed on 2026-11-05.** An owner-authorized text-only first message in a fresh Playwriter tab was observed and auto-adopted with zero Relay Sends. PI persisted `NEXT`, reserved and observed exactly one subsequent browser Send, and persisted `DONE` with one final audit event. Exact latest-user-prompt and full-assistant SHA-256 readback matched the actual Chrome transcript; the Telegram notification cursor reached the terminal event with no pending replies. A cooperative production controller restart subsequently preserved the exact same one-Send/one-answer/one-final-decision counts without replay. The dedicated test tab was closed afterward; the local Mission audit and actual ChatGPT conversation remain available. The owner phone screen was not independently inspected. This supersedes the earlier pre-fix observer-race limitation; it does **not** certify unattended connector writes, arbitrary browser gestures, hard-hang recovery or independent business-goal completion. Only Playwriter-enabled ChatGPT tabs are visible. See [STATE.md](STATE.md).

**Attended acceptance and reliability history (2026-11-04):** The owner initiated a real Telegram command from a phone and confirmed receipt of the final notification after one authorized Chrome ChatGPT turn; the complete visible answer hash matched SQLite's reserved/observed/finished audit trail with no replay. At that *earlier verifier-timeout milestone*, the suite had 112 Linux tests / 111 Windows passes with one POSIX-only case skipped; these figures are **historical**, not the current test count. Operator-configured deterministic checks now have a hard failure deadline, including inherited-pipe hangs; POSIX uses a dedicated process group and Windows attempts native tree cleanup. This is **not** permission to run untrusted verifier commands or a guarantee that Windows can clean descendants of a parent that has already exited. Browser-observed model `DONE` remains distinct from independent business verification.

**Primary direction:** Resume an existing ChatGPT conversation inside the operator's Chrome browser. `chat-create` / `link-chat` registers the conversation; `browser-bind` pins the approved Chrome instance. Playwriter `browser-probe` reads visible UI, while `browser-send` / `browser-drive` submit bounded turns after explicit extension enablement. Telegram `/continue` routes a browser-linked Mission to Playwriter; a separately installed native Mission uses its configured executor plugin. `/instruct` supplies a one-turn owner instruction without losing updates made during execution.

Browser replies use **one local DOM check every 60 seconds during normal generation** (60-minute default timeout, four-hour maximum), not additional model calls. `Connection interrupted. Waiting for the complete answer` is a waiting state: the same reply is observed, with a one-time bounded wait extension for default-length turns. `Message delivery timed out. Please try again.` allows one click on its exact visible `Retry` button for the already-reserved message, after verifying the pinned conversation and original user-prompt hash; it does **not** permit another composer Send. New-tab initialization and final-response stability use short bounded checks. `HANDOFF` may open a new Chrome tab and atomically update the Mission link after a complete observed response. A Telegram-initiated batch emits **one final compact summary** while retaining every turn receipt in SQLite. Pre-existing ChatGPT load errors do not prove a newly submitted turn failed; `browser-recover-turn` can re-observe a complete original-chat reply without resending. Browser observation is **not** independent business verification. See [ChatGPT browser control](docs/playwriter-evaluation.md) and [ChatGPT handoff](docs/chatgpt-handoff.md).

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
