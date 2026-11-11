# Mission Relay — public maintainer state

## Release boundaries

- Current package version: `1.0.0`. This is the software version, not proof that every operator Goal has finished.
- GitHub `main` is the published software source boundary. Run `software-release-status --sha <exact-main-SHA> --run-id <CI-run>` to independently qualify the three-platform Node.js CI **without a Goal, PI or local SQLite database**.
- A successful CI qualification alone does not deploy software. Runtime promotion separately requires a clean target checkout, zero in-flight requests, an atomic maintenance drain, independently restored database backup, previous compiled rollback image, verified single Worker and source SHA, and drain release.
- Goal work is an independent business acceptance process. PI automatically reviews each answer and validates plans and work items; the user does not approve staged Goal checkpoints. Separate `goal-release-*` probes remain operator-only for independent business evidence, not a software-build prerequisite.
- Only operator-private files and host-side audit receipts may contain production identity, request details, private paths and checkpoint evidence; do not place them in this public repository.

## Operational invariants

- One Windows interactive-user Worker with Playwriter/Chrome access and a user-scoped, optionally hidden Telegram Scheduled Task. A session-0 service cannot substitute for an interactive Chrome Worker.
- New PI Missions have no turn ceiling (stored `max_turns=0`); the five-observed-Send limit per Chat is unchanged. Never resend an uncertain original request. Owner pauses survive restart.
- Telegram uses a short daily `/help`, an advanced reference and zero-ID `/status`/`/pause` for unambiguous tasks. The separate approved Chrome launch URL/profile no longer depends on a historical Mission.
- One-time pre-production `ResetProjects -ConfirmResetProjects` safely replaces old business records after a verified backup and maintenance drain, preserving connection configuration and the Bot API cursor. Production data is never reset as a side effect of upgrading source.
- The remote PI adapter inherits its operator-configured default model, provider and thinking settings. Its SSH project and host are configured privately rather than embedded in source.
- Source-controlled old audit snapshots are retired from the public tree. The authoritative private production database and its recovery materials are not deleted as part of a Git history cleanup.

Read [operations](docs/operations.md), [architecture](docs/architecture.md) and [contributor rules](AGENTS.md) for the current supported behavior.
