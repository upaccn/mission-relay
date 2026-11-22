# Mission Relay — current public source state

## Release and verification boundaries

- Current source package version: `1.2.28`.
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
  completes a Goal. The former independent release-gate subsystem was never
  used in production and is removed; its empty v5 tables remain for schema
  compatibility.

## Active operating contract

- One SQLite state machine, one owner-enrolled interactive-user Windows
  Telegram Worker and one leased browser dispatcher. Multiple Goals may
  remain independently queued/active, but a browser Send or uncertain original
  request prevents dispatch to another Goal until a safe checkpoint.
- The Worker control cycle is ordered **authenticated owner inbox → durable
  Mission/Goal recovery and dispatch → best-effort outbound Telegram delivery**.
  A successful inbound poll is required before new browser side effects so a
  queued owner pause is observed first. Failed Telegram replies/notifications
  retain their SQLite reply or event cursor and cannot abort scheduling; an
  inbound `getUpdates` failure still defers dispatch because owner commands
  may be waiting. Startup uses this same cycle rather than dispatching before
  the first owner-inbox read.
- A verified external blocker is scoped first to its work item. PI may mark
  that work BLOCKED and atomically select a different approved independent
  work package instead of terminating the Goal. All blocked release criteria
  remain unmet, and the Goal becomes BLOCKED when no independent work remains.
  PI receives the latest PASSED/BLOCKED outcome per work-item key across all
  of the Goal's plans (up to 40) and is directed toward shipping code, UI,
  native and transaction evidence, not renamed feasibility reports. When PI
  approves a REPLAN, any new PENDING item whose key or exact normalized
  acceptance obligation matches an earlier PASSED item of the same Goal is
  carried forward as PASSED (dependency order, original evidence references
  plus `carried-from:<item>`, append-only `goal.work_carried_forward` event)
  instead of being re-executed.
- Each Goal work prompt carries a bounded (~3000 characters) *Established
  context* section: the latest PI-written PASS summary per passed key and the
  recorded release condition of each still-BLOCKED key, labelled as
  reference rather than authority. Raw prior assistant text is never included.
- A BLOCKED Goal continues through the owner's `/goal-continue <n|id> <what
  changed>`: one SQLite transaction supersedes the stopped plan, moves the Goal
  to PAUSED and binds a fresh queued Mission (same repository and browser
  profile) whose immutable acceptance records the owner note, blocked release
  conditions and carried-forward PASSED work. Its first Send is the ordinary
  read-only Goal discovery turn, rebuilt from the Mission row on recovery; the
  next PI review approves a new plan and carries PASSED work forward. The old
  Mission, its receipts and stop flag are untouched; a terminal (BLOCKED/DONE)
  owner-paused root no longer counts as a live Goal controller.
- New PI Missions are unbounded (`max_turns=0`); each ChatGPT conversation
  permits at most **8 observed Relay Sends**, then requires a distinct,
  verified conversation. Existing finite-limit Missions keep their stored
  historical successor rules without rewriting requests or audit records.
- Each writable Goal requires an explicitly approved, non-overlapping
  `/goal-build --repo` source path, checked again on every reservation. The
  PI adapter inherits the operator-managed default model/provider/effort,
  including any host-side primary/fallback model routing, and remains
  tool-free; repository approval is not an OS sandbox.
- Exact structured PI exit-2 model timeout at 120 seconds and temporary
  global-task capacity refusals retry only PI inference with durable
  60-second-to-15-minute backoff after independently rereading the same
  observed ChatGPT answer. The revision-gated `pi-recheck-timeout` operator
  command can revalidate an older paused timeout once, without replaying Send,
  clearing owner stops or manufacturing a PI decision.
- A closed Playwriter page at the **settled PI NEXT pre-Send read** is treated
  as a recoverable read-only connection failure, with the existing durable
  request/SHA-bound backoff. No browser request is replayed or guessed.
  Historical instances with the exact previously persisted closed-page error
  may use `pi-recheck-browser`, only after two independent matching full
  user/assistant SHA readbacks in the original pinned Chrome conversation.
  Any unresolved Send, owner pause, terminal PI plan, wrong answer, missing
  grant or changed browser binding remains a hard stop.
- All original Send requests use immutable identity, prompt SHA, pinned
  browser URL/profile and SQLite-at-most-once reservation. Browser polling
  normally occurs every 60 seconds. A genuine connection interruption waits
  for the original answer; the delivery-timeout or stream-error **UI Retry**
  has one initial durable allowance per original message, plus up to two
  distinct, independently persisted follow-up attempts while the original
  existing-chat request is still being observed or remains uncertain and the
  identical UI failure is visible after a two-minute cooling period. Never repeat a composer
  Send or an ambiguously attempted UI click. After all three attempts fail,
  emit one owner-visible exhaustion notification and retain original custody.
  Owner pauses defer the click; recovery of a stopped uncertain request is
  revision-gated and owner-authorized. A complete answer is independently
  correlated before PI proceeds, even when an earlier UI Retry was clicked.
- The ChatGPT browser adapter prefers established prompt/send selectors, then
  supports the current localized ProseMirror UI through one unique semantic
  contenteditable textbox and one unique composer-form submit control. This is
  locale-independent; ambiguous or multiple editors/buttons still fail
  closed. Accessible transcript identity recognizes both English
  `You said:` / `ChatGPT said:` and Chinese `你说：` / `ChatGPT 说：`
  headings, preserving exact user-prompt and assistant-answer SHA correlation.
  Chinese `显示更多`, `收起` and `显示更少` controls are removed
  only as anchored transcript decorations. A collapsed excerpt that omits
  authored prompt text still cannot match the reserved complete prompt SHA.
  Conversation binding and the one-shot Send reservation are unchanged.
  When ChatGPT mounts a hidden home composer alongside the visible thread
  composer, only the single visible editable/send control is eligible.
  Multiple visible controls still fail closed. A stopped, settled NEXT
  checkpoint with the historical pre-Send mismatch error may be revalidated
  once via the existing two-read `pi-recheck-browser` operator path; no
  existing Send or PI decision is replayed.
- The final Mission Relay marker remains a standalone exact ASCII final line.
  The shared parser tolerates at most four U+200B characters embedded inside
  that marker only, matching a reproduced ChatGPT transcript-rendering defect;
  the original assistant text and its SHA-256 are never normalized. No other
  invisible characters, indentation or trailing prose are accepted.
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
- The native Start-new-chat action may leave the **exact original prompt as an
  unsent draft** in a separate origin tab. A revision- and scope-gated
  `browser-send-native-draft` checks the unique origin, empty transcript and
  twice-stable original SHA before one persisted Send intent and one click.
  The single Worker later independently observes the new direct conversation,
  credits the original uncertain request only after a complete SHA-matched
  terminal reply, then recovers the PI checkpoint. A click, draft or partial
  reply never counts as a completed turn. New reservations record their
  eight-Send policy; older ten-Send event history stays read-only and valid.
  For future unpaused capacity incidents, the single Worker automatically
  submits the exact prefilled draft once. Owner pause always blocks that
  background action until separately authorized.
- New or repaired production Workers require a **zero-in-flight**, read-only
  restart preflight, atomic maintenance drain, verified private SQLite backup
  and independent restore, byte-checked compiled rollback image, exact fetched
  source SHA, one correctly enrolled Worker and verified final drain release.
  No forced promotion of an active/uncertain browser Send. The Windows daily
  repeating recovery trigger must keep
  `Repetition.StopAtDurationEnd=false`; source updates never modify it by
  themselves.
- The single Worker archives verified settled Mission history after 24 hours
  with an hourly idle-only check; no extra scheduler or DB deletion is added.
  Owner-action BLOCKED, unfinished, explicitly paused and ambiguous Sends
  remain visible. Full /history, evidence and immutable original receipts
  survive archival.

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
