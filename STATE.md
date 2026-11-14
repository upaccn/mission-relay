# Mission Relay — current public source state

## Release and verification boundaries

- Current source package version: `1.2.10`.
- The canonical authoring checkout and GitHub `main` own source history.
  GitHub Releases are immutable release targets; only exact-main-SHA,
  completed, independently qualified CI can establish a software release.
  Run `software-release-status --sha <sha> --run-id <id>` to validate the
  required Ubuntu, macOS and Windows checks.
- GMK Windows is a **pull-only production runtime**, not another authoring
  checkout. A package version, source commit or green CI does **not** prove
  deployment. Read the actual `channel-status.runtimeProvenance.sourceSha`,
  healthy single Worker, enrolled task, SQLite state and maintenance receipt
  before asserting that a specific SHA runs in production.
- Goal/PI acceptance and commercial or external project release are separate
  from Mission Relay's software CI and runtime promotion. Never interpret a
  model's DONE marker as independent business acceptance.

## Active operating contract

- One SQLite state machine, one owner-enrolled interactive-user Windows
  Telegram Worker and one leased browser dispatcher. Multiple Goals may
  remain independently queued/active, but a browser Send or uncertain original
  request prevents dispatch to another Goal until a safe checkpoint.
- New PI Missions are unbounded (`max_turns=0`); each ChatGPT conversation
  permits at most **10 observed Relay Sends**, then requires a distinct,
  verified conversation. Existing finite-limit Missions keep their stored
  historical successor rules without rewriting requests or audit records.
- Each writable Goal requires an explicitly approved, non-overlapping
  `/goal-build --repo` source path, checked again on every reservation. The
  PI adapter inherits the operator-managed default model/provider/effort and
  remains tool-free; repository approval is not an OS sandbox.
- All original Send requests use immutable identity, prompt SHA, pinned
  browser URL/profile and SQLite-at-most-once reservation. Browser polling
  normally occurs every 60 seconds. A genuine connection interruption waits
  for the original answer; the delivery-timeout or stream-error **UI Retry**
  has one durably persisted allowance per original message and is never a
  second composer Send. Owner pauses defer the click; recovery of a stopped
  uncertain request is revision-gated and owner-authorized. A complete answer
  must be independently correlated before PI proceeds.
- The ChatGPT maximum-conversation-length UI is a distinct terminal capacity
  condition, **not** a network Retry and **not** an assistant HANDOFF. A
  verified exact native `Start new chat` control may be clicked **once**
  only after a durable original-request click intent. The enrolled Worker may
  do so automatically on an unpaused uncertain original request; an
  operator-paused request needs explicit revision-gated approval after a
  verified deployment. Neither path reissues the composer Send, credits the
  unanswered turn, invents a new linked Chat URL or unlocks the original
  reservation. A new chat is not proof that task context migrated; continue
  only after independent new-conversation evidence and recovery authorization.
- New or repaired production Workers require a **zero-in-flight**, read-only
  restart preflight, atomic maintenance drain, verified private SQLite backup
  and independent restore, byte-checked compiled rollback image, exact fetched
  source SHA, one correctly enrolled Worker and verified final drain release.
  No forced promotion of an active/uncertain browser Send. The Windows daily
  repeating recovery trigger must keep
  `Repetition.StopAtDurationEnd=false`; source updates never modify it by
  themselves.

## Source hygiene and drift controls

- `npm run check` performs TypeScript checks **and** a repository-state
  consistency scan: package and lockfile versions, this STATE version, latest
  changelog entry, local Markdown links, CI safety steps and project-root
  ownership. `npm run state-check` runs only the source consistency scan.
- `npm run privacy-check`, `npm test`, `npm run build` and
  `git diff --check` remain separate verification gates. Keep third-party
  archives, host-specific evidence, credentials, SQLite databases, rollback
  materials and browser sessions **outside** the public source tree.
- Routine private-repository Goals prioritize approved local/native-host
  verification and batch metered Actions; inspect existing workflow triggers
  before Push. Critical explicit release and security CI gates remain
  mandatory. This prompt policy does not disable another repository's CI.
- Public STATE describes *source contracts*, not a mutable production
  snapshot. For actual deployed revisions, live task health, current Missions
  and maintenance status, consult the production read-only CLI. Never copy
  private task identities or evidence into Git.

See [architecture](docs/architecture.md), [operations](docs/operations.md),
[browser integration](docs/playwriter-evaluation.md), and
[contributor rules](AGENTS.md).
