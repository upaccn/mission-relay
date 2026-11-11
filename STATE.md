# Mission Relay — public maintainer state

## Release boundaries

- Current package version: `1.0.0`. This is the software version, not proof that every operator Goal has finished.
- GitHub `main` is the published software source boundary. Run `software-release-status --sha <exact-main-SHA> --run-id <CI-run>` to independently qualify the three-platform Node.js CI **without a Goal, PI or local SQLite database**.
- A successful CI qualification alone does not deploy software. Runtime promotion separately requires a clean target checkout, zero in-flight requests, an atomic maintenance drain, independently restored database backup, previous compiled rollback image, verified single Worker and source SHA, and drain release.
- Goal work is an independent business acceptance process. Existing `goal-release-*` commands remain for legacy Goals, but must not block the software version from being built, verified or released.
- Only operator-private files and host-side audit receipts may contain production identity, request details, private paths and checkpoint evidence; do not place them in this public repository.

## Operational invariants

- One Windows interactive-user Worker with Playwriter/Chrome access and a user-scoped, optionally hidden Telegram Scheduled Task. A session-0 service cannot substitute for an interactive Chrome Worker.
- New PI Missions have no turn ceiling (stored `max_turns=0`); the five-observed-Send limit per Chat is unchanged. Previously created bounded Missions retain their saved limits and historical successor evidence. Never resend an uncertain original request. Owner pauses and historic events remain immutable unless a separately authorized, verified state transition occurs.
- Telegram uses a short daily `/help` menu and an opt-in `/help advanced` reference; low-frequency legacy routes remain available without advertising them as the default user experience.
- The remote PI adapter inherits its operator-configured default model, provider and thinking settings. Its SSH project and host are configured privately rather than embedded in source.
- Source-controlled old audit snapshots are retired from the public tree. The authoritative private production database and its recovery materials are not deleted as part of a Git history cleanup.

Read [operations](docs/operations.md), [architecture](docs/architecture.md) and [contributor rules](AGENTS.md) for the current supported behavior.
