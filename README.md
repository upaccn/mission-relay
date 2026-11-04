# Mission Relay

**Telegram natural language:** After a local `telegram-anchor` binds an existing owner-enabled Playwriter ChatGPT tab, sending ordinary text or `/new <task>` to the owner-only Telegram bot starts one **new read-only ChatGPT conversation in a fresh Chrome tab** (one turn, durable request/response receipt). The old `/continue <mission-id> v<revision>` still resumes an existing chat with the longer controller-authored prompt. An explicit `/codex <task>` can instead run the existing Codex SDK in one locally approved read-only workspace; authentication and real execution require separate validation. See [Telegram](docs/telegram.md). These routes do not grant generic browser control, arbitrary model-provider switching or unattended write permissions.

**Local-first mission control and handoff for long-running AI work.** Open source under Apache-2.0.

Mission Relay turns a goal and explicit acceptance criteria into a durable mission. It uses an existing AI agent for work, saves checkpoints, determines whether another turn is needed, and independently verifies a candidate result **for supported native executors**. It does **not** reimplement an agent runtime, copy browser profiles, or extract ChatGPT credentials or internal APIs. The opt-in ChatGPT adapter reads visible UI text; a browser reply alone does not constitute independent mission verification.

> **Status: early v0.1 development.** Native CLI, Codex adapter, Telegram and an optional Playwriter ChatGPT browser adapter exist. On the operator-enabled existing Chrome test conversation, **post-fix Telegram → Playwriter → ChatGPT → SQLite receipt** passed, including a final-answer SHA-256 match and no duplicate sends. Real bounded CLI multi-turn (NEXT → DONE), local relay restart/reconnect and ambiguous in-flight relay failure with manual reconciliation passed. **User-disabled/re-enabled Playwriter access on the exact test tab passed**, with a failed-closed probe while disabled and unchanged state after reconnect. The controller handles ChatGPT's virtualized DOM counts without prematurely acknowledging streamed replies. Browser reconciliation uses one SQLite transaction, with rollback/fail-closed tests; 60-second observation, fresh-tab rendering, final-only Telegram browser notifications and stale-load-error recovery passed **109 tests on GitHub Actions Ubuntu/Windows/macOS** (run `41839783004`), with a fresh 109-test Windows/Linux local recheck. General mobile remote browser gestures, browser-wide permission scope and unattended operations are **not verified**. PWA and external AIOS missions are not implemented. Do not use this version unattended on sensitive projects.

**Latest attended acceptance and reliability recheck (2026-11-04):** The owner initiated a real Telegram command from a phone and confirmed receipt of the final notification after one authorized Chrome ChatGPT turn; the complete visible answer hash matched SQLite's reserved/observed/finished audit trail with no replay. A fresh **112-test Linux suite passed completely; Windows passed 111, with one documented POSIX-only inherited-pipe case skipped**, and both platforms passed TypeScript, build, and privacy checks. Operator-configured deterministic checks now have a hard failure deadline, including inherited-pipe hangs; POSIX uses a dedicated process group and Windows attempts native tree cleanup. This is **not** permission to run untrusted verifier commands or a guarantee that Windows can clean descendants of a parent that has already exited. New CI results may lag runner availability; browser-observed model `DONE` remains distinct from independent business verification.

**Primary direction:** Resume an existing ChatGPT conversation inside the operator's Chrome browser. `chat-create` / `link-chat` registers the conversation; `browser-bind` explicitly pins its approved Chrome instance before any browser probe, Send, Drive or Telegram continuation. Playwriter `browser-probe` reads the visible UI; `browser-send` / `browser-drive` submit bounded turns after explicit extension enablement. Telegram `/continue` routes a linked Mission to Playwriter instead of Codex, and `/instruct` supplies a one-turn owner instruction without sacrificing new instructions added during execution. Browser replies are observed using **one local DOM check per 60 seconds during normal generation** (35-minute default timeout, 45-minute maximum), not by calling the model again. New-tab URL initialization and final-response stability use separate short bounded checks. A `HANDOFF` flow signal can migrate a long conversation into a new Chrome tab, send a compact context handoff and atomically replace the registered conversation URL after verified reply observation. A Telegram-initiated browser continuation emits **one final compact decision summary per bounded batch**, not notifications for each intermediate turn; full per-turn receipts remain in SQLite. A pre-existing ChatGPT load-error reply is never treated as proof that the newly submitted turn failed; if a historical uncertain turn is later confirmed complete, `browser-recover-turn` independently checks the original prompt and stable reply, then commits one recovered turn with no new Send. Browser response observation is **not** independent acceptance verification. See [ChatGPT browser control](docs/playwriter-evaluation.md) and [ChatGPT handoff](docs/chatgpt-handoff.md).

**Evidence level:** The previous Telegram→Chrome one-shot instruction was verified live. A separate bounded real two-turn pilot demonstrated autonomous `HANDOFF`→new Chrome tab→new ChatGPT direct conversation→final `DONE` receipt with no replay, correct SHA-256 and atomic Mission link. When the new tab navigates through transient URLs or ChatGPT fails to load its answer, the controller waits briefly or fails conservatively. An explicit read-only `browser-recover-rollover` path can reconcile an already completed new-chat answer after independently verifying both source and destination; it never repeats the Send. Unattended production use remains out of scope.

**Live-readiness evidence:** An authenticated native Codex Mission on Windows completed a read-only source/doc audit with a fresh independent verifier and persisted same-thread recovery after a Windows sandbox failure. A separate phone-triggered real read-only Mission executed via Telegram and reached independent `verification.accepted`, delivered to the same Telegram chat. This is not production/unattended write-readiness.

**Remote-control safety (current source):** Telegram requires a fresh `v<revision>` from `/status` for state-changing commands other than emergency `/pause`, and refuses remote start/resume/instruction of all `workspace-write` missions. The initial live phone pilot used an earlier command format; see [Telegram setup](docs/telegram.md) before restarting a previously launched poller.

## Requirements

- Node.js 24 LTS or newer (Node 24 and 26 are targeted). Local state uses Node's bundled `node:sqlite`, avoiding native addon builds.
- A local project workspace, preferably a Git repository.
- For real execution: a working official Codex authentication/configuration. `npm ci` installs the official SDK; the CLI's own authorization remains with Codex.

**Executor isolation:** Mission Relay uses its own private `CODEX_HOME` under the application state directory by default. Run `node dist/cli.js codex-init`, then authorize that directory via the official `codex login` process (see [operations](docs/operations.md)). This prevents importing your everyday Codex profile's custom model routes, MCP servers and tools. No credentials or sessions are copied from `~/.codex`.

## Quick start

```sh
git clone https://github.com/upaccn/mission-relay.git
cd mission-relay
npm ci
npm run build
node dist/cli.js create --goal "Review the codebase and propose fixes" \
  --accept "Written findings with specific evidence" --workspace /absolute/path/to/repo
node dist/cli.js list
node dist/cli.js run <mission-id>
node dist/cli.js show <mission-id>
node dist/cli.js events <mission-id>
```

To create a ChatGPT-linked Mission in one command **without starting Codex**:

```sh
node dist/cli.js chat-create --goal "Continue the research" --accept "Verify conclusions" --url https://chatgpt.com/c/<conversation-id>
```

Or link an already-existing Mission, using the current revision from `show`:

```sh
node dist/cli.js link-chat <mission-id> --url https://chatgpt.com/c/<conversation-id> --revision <version>
node dist/cli.js handoff <mission-id>
```

Experimental browser operations (only with the **Playwriter extension enabled on the exact ChatGPT tab**):

```sh
node dist/cli.js browser-probe <mission-id>
node dist/cli.js browser-drive <mission-id> --revision <current-version> --request-prefix local-pilot-001 --turns 3
```

Use `browser-send` with a reviewed `--prompt-file` for a specific one-turn instruction. Browser actions require a foreground local process, not a second daemon or a public tunnel. See the [browser operations guide](docs/playwriter-evaluation.md).

To permit `workspace-write` missions to reach `COMPLETED`, provide explicit **operator-defined deterministic checks**, such as `--checks-file /path/to/checks.json`. See [examples/checks.json](examples/checks.json). These checks run as local commands after a candidate completion and before independent model verification. They may execute project scripts and are **not** a security sandbox. Review their effects before enabling them. Without checks, a write-capable mission pauses rather than declaring itself complete.

The default execution sandbox is `read-only`. Explicitly opt in to `--sandbox workspace-write` at creation time for tasks that genuinely require code changes. Remote production actions and unrestricted system access are not supported by the built-in engine.

`MISSION_RELAY_HOME` can change the state directory (default: OS user-data directory). The SQLite DB and local model execution history must remain private. Run `node dist/cli.js doctor` before an initial mission to check whether a configured local Codex bridge is listening.

## Design boundaries

- One authoritative task record, one lease, append-only events, bounded turns.
- New turns reuse their executor's thread; resume never assumes interrupted tool calls are safe to replay.
- A **fresh read-only verifier** reviews candidate completion separately from the executor. The verifier is still model-based; independent deterministic tests must be supplied for higher assurance.
- `NEEDS_RECONCILIATION` is a first-class safety state after ambiguous interruptions.
- External missions, Telegram, browser control and full desktop control belong behind versioned adapter contracts.

See [architecture](docs/architecture.md), [plugin API](docs/plugin-api.md), [operations](docs/operations.md), [Telegram setup](docs/telegram.md), and [security](SECURITY.md).

## Roadmap

1. **v0.1** Native missions, SQLite, Codex adapter, durable CLI, Telegram and human-operated ChatGPT conversation handoff.
2. **v0.2** Real Chrome Playwriter handshake, first live ChatGPT turn, bounded multi-turn recovery and Telegram acceptance on an operator-enabled conversation (**achieved for attended text-only pilots; not a general production release**).
3. **v0.3** Harden browser session lifecycle, recovery notices and independent outcome verification; optional mobile UI/desktop handoff and native ChatGPT scheduling only where independently useful.
4. **v0.4** External Mission Providers (including AIOS) and plugin contract tests; Playwriter tab permission stays operator-enabled, while bounded text-only ChatGPT HANDOFF already supports attended automatic new-tab migration.
5. **v1.0** Cross-platform recovery, security and maintenance gates.

Contributions welcome after the initial core stabilizes. See [CONTRIBUTING.md](CONTRIBUTING.md).
