# Mission Relay — current public source state

## Release and verification boundaries

- Current source package version: `1.4.4`.
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
- Goal completion and Mission Relay's software CI/runtime promotion are
  separate. A Goal is DONE when PI passes the final package of its approved
  plan: that review is told PASS completes the whole owner Goal and to REPLAN
  if anything is missing. The controller then writes one immutable
  `goal_completions` row and commits PI action DONE; later Goal writes and
  browser Sends for that Goal are refused. A ChatGPT DONE marker alone never
  completes a Goal.

## Active operating contract

- **Goal-only.** Every Mission is a PI-controlled Goal Mission executed by
  ChatGPT in the pinned Chrome profile. There is no native/Codex executor,
  no plugin API, no manual Chat handoff and no human-Chat adoption. Owner
  intake (`/goal`, `/goal-build`, plain message) always queues a Goal; the
  single leased Worker dispatches queued Goals one safe checkpoint at a time.
- One SQLite state machine, one owner-enrolled interactive-user Windows
  Telegram Worker and one leased browser dispatcher. A reserved or uncertain
  Send anywhere prevents dispatch to another Goal; intake is never blocked.
- The Worker control cycle is ordered **authenticated owner inbox → durable
  Goal recovery and dispatch → best-effort outbound Telegram delivery**, and
  `pollOnce` runs exactly that cycle. A failed inbound poll defers new side
  effects (an owner pause may be waiting); failed outbound delivery keeps its
  SQLite cursor and never aborts scheduling.
- **No turn ceiling, no successor chain.** One Mission serves its Goal for as
  long as the Goal runs. Each ChatGPT conversation carries at most **8
  observed Relay Sends**; the ninth (or a PI HANDOFF) opens a fresh Relay
  Chat, retiring only the Relay-created tab it replaces. The former 32-turn
  successor rule and Mission-level `max_turns` are retired.
- First Send is read-only Goal discovery. PI then approves a durable plan and
  selects one work package at a time. A REPLAN carries matching PASSED work
  forward; each work prompt carries a bounded *Established context* list of
  PI-written PASS summaries and recorded blockers (reference, not authority).
- A Goal is DONE when PI passes the final package of its approved plan; the
  controller writes one immutable `goal_completions` row and later Goal
  writes and Sends are refused. A ChatGPT DONE marker never completes a Goal.
  A verified external blocker is scoped to its work item; the Goal becomes
  BLOCKED only when no independent work remains. `/goal-continue <n|id>
  <what changed>` binds a fresh queued Mission to the same Goal without
  touching the old Mission or replaying anything. The only executable work
  item is an IN_PROGRESS/REVIEW item of the current APPROVED plan
  (`activeWorkItem`); items left active in a superseded plan are history, so
  a continuation's discovery round always goes to PI plan approval.
- Each writable Goal requires an explicitly approved, non-overlapping
  `/goal-build --repo` path, rechecked at every reservation. PI inherits the
  operator-managed default model/provider/effort (including host-side
  primary/fallback routing) and remains tool-free.
- **PI reviews on evidence, not on suspicion.** The executor report is the
  evidence; PI accepts concrete, consistent reported facts and PASSes when
  every criterion is met. PARTIAL must name an unmet criterion and one
  concrete action (never re-document or re-prove). REPLAN revises the plan
  and keeps item keys and their review history; the replaced active item is
  FAILED, not BLOCKED. There is no controller repair budget that forces a
  REPLAN or a rename: after two non-pass reviews PI is told to decide on the
  merits. Plan keys are normalized (`[a-z0-9._:-]`, ≤64) and deduped.
- **Waiting is not replanning.** When the remaining evidence comes from an
  already running process or delivery, PI returns WAIT with an optional
  `resumeAt` (default 30 min, clamped to 5 min–12 h) and the instruction to
  collect the result; PI is told that only WAIT holds a dispatch. The
  package keeps its key and history and returns to READY; independent work
  runs first. If only waiting work remains, the decision is fenced: no Send
  before `resumeAt` (`pi-health` phase `pi_wait_scheduled_no_send`). An
  owner note lifts the fence; the fence never blocks maintenance.
- **Every PI failure is retried.** Any failure of PI itself (unreachable,
  timeout, quota, unusable output) happens before a Send; the Worker retries
  it with SHA-bound backoff (1 → 15 min) and stops visibly after 8 attempts.
  Closed-page browser reads use the same backoff. Integrity, permission and
  changed-Chat failures still stop at once. No Send is ever replayed.
- **A Send that was never attempted is not uncertain.** A failure before the
  Send click (page load, composer fill, readiness) releases the reservation
  (`chatgpt.browser_send_aborted`, `noSend`), restores the previous receipt
  and retries with a fresh key (`<key>-a<n>`) after backoff (30 s → 15 min),
  stopping visibly after 8 consecutive attempts. Only a failure at or after
  the click is `uncertain`.
- **Long answers are waited for.** The 60-minute observation window extends
  while ChatGPT is still generating or the answer is changing, up to 4 h.
- All Sends use an immutable request key, prompt SHA, pinned URL/profile and
  SQLite at-most-once reservation. Reconstruction of a reserved prompt uses
  only its immutable `goal-work-v1` snapshot, or the deterministic first
  planning prompt. Browser polling runs every 60 seconds. Delivery-timeout or
  stream-error **UI Retry** has one initial durable allowance plus up to two
  spaced follow-ups on an existing-chat request; never a composer re-Send.
- The ChatGPT maximum-conversation-length UI is a terminal capacity
  condition, not a Retry or HANDOFF. An unpaused Worker may click the exact
  native `Start new chat` once (durable intent first) and submit the exact
  prefilled original draft once; the original request stays uncredited until
  a complete SHA-matched reply is independently observed. Owner pause always
  blocks these background actions.
- **Operator recovery is one command.** `recover <mission>` is read-only and
  prints the single safe next action. Its only mutations, each requiring the
  current revision: `--accept-reply [--new-url]` credits a complete reply
  ChatGPT already shows (read twice, prompt SHA matched); `--retry` clears an
  error at a settled verified checkpoint after two matching live reads;
  `--abandon` settles an unverifiable request with no credit and no resend,
  ends the Mission and blocks its Goal for `/goal-continue`.
- The ChatGPT adapter prefers established selectors, then the localized
  ProseMirror UI through one unique semantic textbox and submit control;
  English and Chinese accessible transcript headings keep exact prompt and
  answer SHA correlation. Ambiguous controls fail closed. The final marker is
  a standalone ASCII line; at most four embedded U+200B are tolerated inside
  it, never normalizing the stored answer or its SHA.
- New or repaired production Workers require a zero-in-flight read-only
  restart preflight, atomic maintenance drain, verified private SQLite backup
  and restore, byte-checked rollback image, exact fetched source SHA, one
  enrolled Worker and verified drain release. Production starts from an
  owner-authorized fresh project database, so the code keeps no
  compatibility paths for retired request formats.
- The Worker archives verified settled history after 24 hours with an hourly
  idle-only check. Blocked, paused and ambiguous work stays visible.

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
