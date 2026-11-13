# Mission Relay — public maintainer state

## Release boundaries

- Current package version: `1.2.0` (source candidate). The last inspected GMK Worker still ran `1.1.5` and had a live original browser reservation, so this is **not** a production deployment or live multi-Goal acceptance.
- GitHub `main` is the published software source boundary. Run `software-release-status --sha <exact-main-SHA> --run-id <CI-run>` to independently qualify the three-platform Node.js CI **without a Goal, PI or local SQLite database**.
- A successful CI qualification alone does not deploy software. Runtime promotion separately requires a clean target checkout, zero in-flight requests, an atomic maintenance drain, independently restored database backup, previous compiled rollback image, verified single Worker and source SHA, and drain release.
- Goal work is an independent business acceptance process. PI automatically reviews each answer and validates plans and work items; the user does not approve staged Goal checkpoints. Separate `goal-release-*` probes remain operator-only for independent business evidence, not a software-build prerequisite.
- Only operator-private files and host-side audit receipts may contain production identity, request details, private paths and checkpoint evidence; do not place them in this public repository.

## Operational invariants

- One Windows interactive-user Worker with Playwriter/Chrome access and a user-scoped, optionally hidden Telegram Scheduled Task. A session-0 service cannot substitute for an interactive Chrome Worker.
- The two-minute daily Windows recovery trigger MUST set `Repetition.StopAtDurationEnd=false`; the default `true` killed the running Worker at the repetition boundary even when execution time was unlimited. `UpgradeSchedule` must correct legacy existing triggers without restarting the active Worker.
- New PI Missions have no turn ceiling (stored `max_turns=0`); each Chat permits ten observed Relay Sends and rotates before an eleventh. Never resend an uncertain original request. Owner pauses survive restart.
- Multiple Goal-bound Missions are independently bound to their original repositories, work plans and Chrome conversations in the existing SQLite. One leased Worker rotates at settled PI checkpoints; a reserved/uncertain Send prevents all new browser dispatch but does not prevent independently scoped Goal intake. Local operator approvals are per repository. The PI inference host/project remains a separate tool-free route.
- Original existing-chat delivery timeouts allow one SQLite-audited UI Retry of the **same already submitted message**, with intent durably committed before the click. A timed-out, uncertain original same-chat request may be automatically inspected by the single Worker; a complete, twice-verified reply can be reconciled and PI-reviewed without a new Send. Unrelated uncertainty, changed prompt/tab or revoked scope remains blocked.
- The same one-shot Retry budget now also covers the actual ChatGPT `Error in message stream` control adjacent to its unique Retry button. New-chat first Sends gain the same durable intent protection while still owned; unbound new-chat uncertainty is not automatically adopted or replayed.
- Telegram's normal messages show task names, readable progress, and an `All Done` task summary without UUIDs, internal event names or controller revisions; `/status`, `/list`, `/goal-status` and unambiguous `/pause` require no IDs. Internal audit identity and the separate approved Chrome launch URL/profile remain stable.
- One-time pre-production `ResetProjects -ConfirmResetProjects` safely replaces old business records after a verified backup and maintenance drain, preserving connection configuration and the Bot API cursor. Production data is never reset as a side effect of upgrading source.
- The remote PI adapter inherits its operator-configured default model, provider and thinking settings. Its SSH project and host are configured privately rather than embedded in source.
- Source-controlled old audit snapshots are retired from the public tree. The authoritative private production database and its recovery materials are not deleted as part of a Git history cleanup.

Read [operations](docs/operations.md), [architecture](docs/architecture.md) and [contributor rules](AGENTS.md) for the current supported behavior.
