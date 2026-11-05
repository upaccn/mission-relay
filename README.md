# Mission Relay

**Browser-first, vendor-neutral by default.** With local `telegram-anchor` and `telegram-pi-config`, ordinary Telegram text, `ChatGPT: <task>` or `/auto <task>` starts a fresh ChatGPT Chrome conversation. After each fully observed answer, tool-free PI proposes a bounded NEXT/DONE/BLOCKED/HANDOFF decision. Existing human-created conversations can now be explicitly **adopted** (see below) with zero artificial turns. No coding agent, Codex SDK or model-provider choice is required for this path. Native execution remains an optional, separately installed plugin. **ChatGPT connected apps are not technically sandboxed by these prompts.** See [Telegram](docs/telegram.md).

An explicit `Agent: <task>` or `/agent <task>` uses an installed native executor only if one has been configured. Plain Telegram text defaults to PI-coordinated ChatGPT. There are no vendor-specific command prefixes in Core.

**Local-first mission control and handoff for long-running AI work.** Open source under Apache-2.0.

Mission Relay turns a goal and explicit acceptance criteria into a durable mission. It uses an existing AI agent for work, saves checkpoints, determines whether another turn is needed, and independently verifies a candidate result **for supported native executors**. It does **not** reimplement an agent runtime, copy browser profiles, or extract ChatGPT credentials or internal APIs. The opt-in ChatGPT adapter reads visible UI text; a browser reply alone does not constitute independent mission verification.

> **Status: early alpha; v0.2 Chrome-profile watch passed two isolated real-Chrome pilot runs, but is not yet deployed to the production Telegram controller.** Each pilot created a fresh ChatGPT conversation, discovered and adopted its stable human-origin reply with zero Relay turns, then used the real tool-free AIOS PI planner to choose NEXT and DONE after exactly one Playwriter follow-up Send. The second pilot independently read back the complete final browser answer and matched its SHA-256 to SQLite. Notifications used a **fake in-memory Telegram transport**, not the production Bot API. Native coding-agent plugins have been separated from the default build. Only Playwriter-enabled ChatGPT tabs are visible, not every tab in Chrome. Restart recovery for the v0.2 watcher, real phone notifications after deployment, arbitrary browser gestures and unattended external writes remain unverified. See [STATE.md](STATE.md).

**Attended acceptance and reliability history (2026-11-04):** The owner initiated a real Telegram command from a phone and confirmed receipt of the final notification after one authorized Chrome ChatGPT turn; the complete visible answer hash matched SQLite's reserved/observed/finished audit trail with no replay. At that *earlier verifier-timeout milestone*, the suite had 112 Linux tests / 111 Windows passes with one POSIX-only case skipped; these figures are **historical**, not the current test count. Operator-configured deterministic checks now have a hard failure deadline, including inherited-pipe hangs; POSIX uses a dedicated process group and Windows attempts native tree cleanup. This is **not** permission to run untrusted verifier commands or a guarantee that Windows can clean descendants of a parent that has already exited. Browser-observed model `DONE` remains distinct from independent business verification.

**Primary direction:** Resume an existing ChatGPT conversation inside the operator's Chrome browser. `chat-create` / `link-chat` registers the conversation; `browser-bind` pins the approved Chrome instance. Playwriter `browser-probe` reads visible UI, while `browser-send` / `browser-drive` submit bounded turns after explicit extension enablement. Telegram `/continue` routes a browser-linked Mission to Playwriter; a separately installed native Mission uses its configured executor plugin. `/instruct` supplies a one-turn owner instruction without losing updates made during execution.

Browser replies use **one local DOM check every 60 seconds during normal generation** (35-minute default timeout, 45-minute maximum), not additional model calls. New-tab initialization and final-response stability use short bounded checks. `HANDOFF` may open a new Chrome tab and atomically update the Mission link after a complete observed response. A Telegram-initiated batch emits **one final compact summary** while retaining every turn receipt in SQLite. Pre-existing ChatGPT load errors do not prove a newly submitted turn failed; `browser-recover-turn` can re-observe a complete original-chat reply without resending. Browser observation is **not** independent business verification. See [ChatGPT browser control](docs/playwriter-evaluation.md) and [ChatGPT handoff](docs/chatgpt-handoff.md).

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

Enabling creates a baseline of all currently visible ChatGPT conversations and **does not automatically run those existing chats**. Subsequent newly visible chats or new human prompts are read twice for stability, adopted at zero Relay turns, and queued for PI through the **same Telegram foreground process**, one Mission at a time. Two tabs showing an identical URL are never silently selected. `browser-candidates` is read-only inventory, not evidence that all Chrome tabs are accessible: the user must still enable Playwriter on each tab they want controlled. This watcher is source-implemented and synthetic-tested, **not yet accepted against the live Chrome/Telegram runtime**. See [browser evaluation](docs/playwriter-evaluation.md).

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

1. **v0.1** Existing experimental SQLite, Playwriter, Telegram and PI orchestration (attended text-only pilots).
2. **v0.2** Browser-first human conversation adoption; **automatic tab-group membership discovery is pending an upstream-capability solution and real Chrome acceptance**.
3. **v0.3** Simplify Telegram controls, restart/recovery lifecycle and mission-specific executor binding.
4. **v0.4** Formalize optional native executor/other adapter packages, without requiring a coding agent for browser-first use.
5. **v1.0** Cross-platform recovery, security and maintenance gates.

Contributions welcome after the initial core stabilizes. See [CONTRIBUTING.md](CONTRIBUTING.md).
