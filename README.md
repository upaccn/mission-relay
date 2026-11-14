# Mission Relay

Mission Relay coordinates long-running AI work across independently scoped projects. It combines persistent Goals, AI-assisted planning, ChatGPT browser execution and a single reliable task controller, with Telegram as the primary owner interface.

**Node.js 24+ · TypeScript · SQLite · Apache-2.0**

## Features

- **Long-running Goals:** persistent plans, work packages, acceptance criteria, PI review decisions and resumable execution history. Missions have no fixed turn ceiling.
- **Independent project workspaces:** each writable Goal must specify an explicitly approved `--repo` path. Different approved repository roots cannot overlap, and every browser Send rechecks the Goal's immutable repository scope.
- **Multi-Goal scheduling:** multiple Goals remain active or queued, each with its own Mission and ChatGPT conversation. One leased Worker dispatches browser work sequentially at safe checkpoints.
- **PI-driven execution:** the configured PI agent plans and reviews the work; ChatGPT carries out the current approved work package in the owner's Playwriter-enabled Chrome tab. PI inherits its configured default model.
- **Conversation handoff:** after 10 verified Relay sends in one ChatGPT conversation, further work uses a new conversation while retaining the Mission's durable context.
- **Safe delivery and recovery:** exact request IDs, prompt and answer hashes, browser/tab binding, at-most-once sends, bounded existing-message UI Retry, owner pause/resume and recovery of verified replies.
- **Operational controls:** SQLite-backed audit events, GitHub CI qualification, maintenance-gated Windows upgrades, recoverable database backups and runtime SHA verification.
- **CI-conscious autonomy:** routine iterations prefer local/approved native-host validation and batch metered CI pushes; private-repository workflow triggers are checked before pushes. Required release CI is still independently verified, not replaced by local-only assertions.
- **Optional executor plugins:** add trusted native executors without bundling vendor SDKs or credentials into Core.

## Install

```bash
git clone https://github.com/upaccn/mission-relay.git
cd mission-relay
npm ci
npm run check
npm test
npm run build
node dist/cli.js help
```

The CLI uses Node's built-in SQLite; no external database, message broker or separate queue service is required. State lives in the OS user state directory by default and can be relocated with `MISSION_RELAY_HOME`.

`npm run check` includes a read-only repository-state gate. It verifies the
package, lockfile, [STATE](STATE.md) and changelog versions, local documentation
links, CI checks and top-level project isolation. Run `npm run state-check` to
check these invariants independently of TypeScript compilation.

## Configure your workflow

1. Set up a private, owner-allowlisted Telegram channel and the approved PI connection using [Telegram setup](docs/telegram.md).
2. Install and enable [Playwriter](docs/playwriter-evaluation.md) on the exact ChatGPT tabs you want Mission Relay to use, and bind the correct Chrome profile.
3. Approve each writable project repository from the local operator environment:

   ```bash
   node dist/cli.js telegram-build-project --allow /srv/projects/product-a
   node dist/cli.js telegram-build-project --allow /srv/projects/product-b
   node dist/cli.js telegram-build-project --list
   ```

4. In Telegram, create independently scoped Goals:

   ```text
   /goal-build --repo /srv/projects/product-a Implement and test feature A
   /goal-build --repo /srv/projects/product-b Review and improve feature B
   ```

   Use `/goal <objective>` for a read-only Goal, or `/build <task>` for a task in the configured single-repository workspace.

5. Use `/list`, `/status 2`, `/pause 2` and `/resume 2` to inspect and control work. Goal identifiers remain independent; the Telegram interface can use convenient numeric selectors.

The repository approval governs Mission Relay's own authorization and prompts. It does **not** install an OS-level filesystem sandbox around ChatGPT or other executors; configure their filesystem permissions separately.

## Browser and operations

```bash
node dist/cli.js browser-list
node dist/cli.js browser-candidates --browser-id YOUR_CHROME_ID
node dist/cli.js pi-health
node dist/cli.js channel-status
```

Mission Relay retains the original request if ChatGPT delivery is ambiguous; it never submits a fresh copy simply because a response timed out. A Playwriter tab count of zero means no tabs are currently attached to the extension, not necessarily that Chrome tabs have closed.

For a cooperatively paused request that ended in an uncertain original ChatGPT delivery, the operator can use the revision-gated `browser-resume-pending-retry` command **after** an audited maintenance upgrade. It only releases the paused original message for inspection by the enrolled Worker; any UI Retry consumes the same durable one-shot budget and never replays a composer Send.

For Windows scheduled-task deployment, SQLite maintenance, backup and rollback, see [Operations](docs/operations.md). For CI and software release qualification, run:

```bash
node dist/cli.js software-release-status --sha <main-commit-sha> --run-id <github-actions-run>
```

Source checkout, GitHub release, and installed GMK Worker are separate
boundaries. An active or uncertain browser Send blocks maintenance; a new
source commit does not prove it has been deployed. Compare the installed
source SHA through `channel-status` and use the guarded Windows upgrade only
after its independent idle preflight.

## Documentation

- [Architecture](docs/architecture.md) — controller, Goal ledger, browser and executor boundaries
- [Telegram](docs/telegram.md) — channel configuration and commands
- [Browser integration](docs/playwriter-evaluation.md) — Playwriter setup and safe recovery
- [Operations](docs/operations.md) — Windows Worker lifecycle, upgrades and backups
- [Plugin API](docs/plugin-api.md) — optional native executors
- [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [License](LICENSE)
