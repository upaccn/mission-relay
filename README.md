# Mission Relay

Mission Relay is a local-first, Node.js 24+ Mission controller for long-running AI work. It persists goals, plans, unbounded PI Missions, browser requests, independent review decisions and audit evidence in SQLite. Each Chat is limited to ten durably observed Relay Sends; new PI Missions have no fixed turn ceiling. The default path is **Telegram → tool-free PI planning → a user-approved ChatGPT Chrome tab**. An optional, separately installed native executor plugin provides a different execution route; Codex is not bundled with Core.

**Version: v1.2.0.** Local-first production operation requires an exact-SHA GitHub CI qualification, a maintenance-gated Windows promotion and independent runtime readback. Package version and CI do not establish that an individual Goal has independently passed its release gate; inspect the current deployed source and [current state](STATE.md) before declaring any Goal DONE.

## Installation and read-only inspection

    git clone https://github.com/upaccn/mission-relay.git
    cd mission-relay
    npm ci
    npm run check
    npm run privacy-check
    npm test
    npm run build
    node dist/cli.js help
    node dist/cli.js list
    node dist/cli.js pi-health
    node dist/cli.js channel-status

The CLI uses Node's built-in SQLite; there is no required database server, broker or native agent SDK. Private state defaults to the OS user state directory and can be relocated with MISSION_RELAY_HOME. Never store live SQLite, bot credentials, ChatGPT URLs or Chrome profiles in Git.

## Execution paths

In Telegram, send a normal message for PI-coordinated read-only work, or use `/build <task>` for an approved repository. `/help` shows the daily commands; `/help advanced` lists infrequent and legacy operations.

**Browser / PI (primary):** Telegram is owner-allowlisted, and the interactive-user Windows Worker is a single, SQLite-leased controller. PI inference uses a separately configured SSH host and project with its own default model and no model/provider/effort override or agent tools. ChatGPT executes only the currently approved task/work package using the user's own Playwriter-enabled Chrome profile. A new PI Mission has **no fixed turn ceiling**. Ten **observed** Relay sends per Chat are enforced; further work uses a verified fresh Chat inside the same Mission. Multiple Goal-bound Missions may be queued and take turns at fully settled PI checkpoints on this same Worker. An unsettled Send blocks scheduling but not intake; no second daemon or queue exists. PI may stop on DONE/BLOCKED, and the owner can pause. Pre-v1 bounded Missions and their cross-Mission successor receipts remain readable without modifying their history. Model NEXT/DONE/BLOCKED markers are hints, not independent evidence of task or Goal completion.

For multi-repository Goals, the local operator explicitly approves each source path:

```sh
node dist/cli.js telegram-build-project --allow /srv/projects/product-a
node dist/cli.js telegram-build-project --allow /srv/projects/product-b
node dist/cli.js telegram-build-project --list
```

Then send `/goal-build --repo /srv/projects/product-a <objective>` and `/goal-build --repo /srv/projects/product-b <objective>` in the authenticated Telegram chat. These approvals persist in the existing private SQLite; the `--repo` argument is **never** selected by PI/model text. Mission Relay constrains its own Send authorization and prompt scope, **not** the independent ChatGPT executor's operating-system filesystem permissions. Review actual Git changes in each repository before considering either Goal complete. `/list`, `/status 2`, `/goals`, `/pause 2`, and `/resume 2` use everyday numeric task selectors; the underlying audit retains exact original IDs.

**Native executor (optional):** A trusted local JS module must explicitly be registered, provide an executor manifest, implement execute/verify and manage its own credentials and privileges. The local Mission Engine pins an executor identity and performs configured deterministic checks before it can accept write-capable completion. The checks run operator-defined commands: they are not a sandbox. Native execution does not inherit browser or Telegram write authority.

**Existing human ChatGPT conversations:** A pinned tab can be linked or adopted without a new Send. Adoption records stable user/assistant SHA-256 snapshots and starts at zero Relay turns. A separately opted-in profile watcher observes newly changed Playwriter-enabled ChatGPT dialogs, not arbitrary Chrome tabs.

## Example browser workflow

Enable Playwriter on the exact intended ChatGPT tab in the approved Chrome profile, then inspect before dispatch:

    node dist/cli.js browser-list
    node dist/cli.js browser-candidates --browser-id YOUR_APPROVED_CHROME_ID
    node dist/cli.js chat-create --goal "Continue a scoped task" --accept "Verify the result" --url "https://chatgpt.com/c/YOUR_CONVERSATION_UUID"
    node dist/cli.js show YOUR_MISSION_ID
    node dist/cli.js browser-bind YOUR_MISSION_ID --browser-id YOUR_APPROVED_CHROME_ID --revision YOUR_CURRENT_REVISION
    node dist/cli.js browser-probe YOUR_MISSION_ID

For an existing human-created conversation, use chat-adopt rather than chat-create. For deliberate local browser operations use browser-send or browser-drive only after reading their exact CLI arguments with node dist/cli.js help. Browser Send is **at most once** per original reserved request; a completed visible answer without a persisted receipt does not authorize a second Send.

Read-only diagnostics:

    node dist/cli.js pi-evidence YOUR_MISSION_ID
    node dist/cli.js pi-chain-evidence YOUR_MISSION_ID
    node dist/cli.js goal-request-ledger YOUR_GOAL_ID
    node dist/cli.js goal-release-status YOUR_GOAL_ID

If a Send is ambiguous, preserve the original request and inspect the actual linked browser conversations before using the separate, explicitly acknowledged recovery commands. Never equate healthy Telegram polling with browser-request progress.

## Source, production and release boundary

Maintain a single operator-selected development checkout. GitHub [upaccn/mission-relay](https://github.com/upaccn/mission-relay) main plus its **same-SHA** CI push/main Windows/macOS/Ubuntu success is the source-promotion boundary. Runtime machines are **pull-only** deployment targets; it must not create competing source commits.

Before a GMK upgrade, require a genuinely idle SQLite maintenance preflight, no active/reserved browser Send, a drained single Worker, recoverable private SQLite snapshot, checked upgrade script and verified exact target SHA. The upgrade must read back installed build provenance and real Worker PID. An active original Send blocks a deployment even if CI is green. Goal DONE independently requires verified business acceptance; it is separate from software release qualification; PI's work-item PASS cannot replace it.

## Developer commands and quality gates

Software qualification does **not** require an owner Goal, PI agent, Telegram
credentials or a local SQLite database. For a verified GitHub main revision,
run:

```sh
node dist/cli.js software-release-status --sha <exact-main-commit> --run-id <successful-push-ci-run>
```

This reads the three original GitHub Actions platform receipts, rejects changed
GitHub main and returns `qualified` separately from
`productionVerified: false`. Deployment and rollback remain guarded Windows
operations; Goal acceptance is independently verified on its own timeline.

For a Windows interactive-user Telegram installation, use the optional
`telegram-task.ps1 -Action HideWorker` followed by an idle-gated `-Action
Restart` to apply hidden PowerShell startup. The user-session Chrome/Playwriter
binding remains available. `Hidden` refers to the process window; it does
not create a Session-0 service or disable normal recovery.

    npm ci
    npm run check
    npm run privacy-check
    npm test
    npm run build
    git diff --check

The TypeScript build rejects unused local imports/parameters; run targeted tests after a scoped change and then the full suite. Windows-only and Unix-only tests may be explicitly skipped on other platforms. The Playwriter test suite uses synthetic pages and isolated databases, never actual account Sends.

## Documentation map

- [AGENTS.md](AGENTS.md) — durable contributor invariants; read first.
- [STATE.md](STATE.md) — concise latest observed state and current release boundaries.
- [CHANGELOG.md](CHANGELOG.md) — versioned product changes and known limitations.
- [Architecture](docs/architecture.md) — execution boundaries, Goal ledger, PI and independent release gates.
- [Operations](docs/operations.md) — GMK upgrades, SQLite maintenance, recovery and diagnostics.
- [Telegram](docs/telegram.md) and [browser operations](docs/playwriter-evaluation.md) — configuration and existing user-facing workflows.
- [Plugin API](docs/plugin-api.md) and [optional Codex adapter](examples/executors/codex/README.md) — separately installed native execution.
- [Trusted release probes](docs/trusted-release-probes.md) — runtime and Goal acceptance evidence, distinct from software CI qualification.
- [Security](SECURITY.md), [Contributing](CONTRIBUTING.md), [Product decisions](docs/product-ux.md), [manual handoff](docs/chatgpt-handoff.md).

The public repository starts from a reviewed v1.0 baseline. Older operator-specific
working history is not part of the supported source history; keep any required
recovery evidence in access-controlled private storage, never in the public tree.
