# Changelog

## 1.3.1 — 2026-11-22

- Windows maintenance: the final verified drain release now retries the same
  atomic check up to six times (3 s apart) when only the transport sample or
  heartbeat window refused it, and reports the exact refusal reason. The
  expected Worker PID, source SHA and attestation are unchanged across
  attempts, so a retry can never admit a different Worker. Observed on GMK:
  `ResetProjects` restarted the Worker within seconds and its first release
  check was refused; the reset rolled back safely.

## 1.3.0 — 2026-11-22

- **Goal-only executor.** Every task is a PI-controlled Goal executed by
  ChatGPT. Removed the native/Codex executor, plugin registry, deterministic
  check runner and Mission engine (`engine.ts`, `executor-plugins.ts`,
  `plugins.ts`, `checks.ts`), manual Chat handoff and the legacy
  non-Goal PI loop. Plain text, `/goal` and `/goal-build` all queue a Goal;
  the single Worker dispatches it. `pollOnce` now runs the Worker's full
  ordered cycle.
- **Retired the 32-turn successor chain and Mission `max_turns`.** One Mission
  serves its Goal for as long as it runs; each Chat still carries at most 8
  Relay Sends before a fresh Chat. Removed successor creation, chain
  pause/resume, chain evidence and successor tab retirement.
- **One recovery command.** `recover <mission>` diagnoses read-only and prints
  the single safe next action; `--accept-reply [--new-url]`, `--retry` and
  `--abandon` (all revision-gated, none ever resends) replace fourteen
  per-incident repair commands (`reconcile`, `browser-reconcile`,
  `browser-recover-turn`, `browser-recover-rollover`, `pi-resume`, four
  `pi-recheck-*`, `browser-correct-attribution`,
  `browser-retry-pre-send-rollover`, `browser-start-new-chat`,
  `browser-send-native-draft`, `browser-resume-pending-retry`).
  `--abandon` blocks the Goal so the owner continues it with `/goal-continue`.
- **Telegram help is one Goal menu** (`/note`, `/goal`, `/goal-build`,
  `/goal-continue`, `/goals`, `/goal-status`, `/list`, `/status`, `/pause`,
  `/resume`, `/history`). Removed `/build`, `/auto`, `/new`, `/agent`,
  `/handoff`, `/continue`, `/instruct`, `/cancel` and the `ChatGPT:`/`Agent:`
  prefixes.
- **No compatibility baggage.** Production restarts from an owner-authorized
  fresh project database, so legacy prompt reconstruction, 10-Send history
  tolerance, answer-attribution correction, human-Chat adoption, pre-Send
  one-shot rollover and paused-Retry release paths are removed. A reserved
  prompt is reconstructed only from its immutable `goal-work-v1` snapshot or
  the deterministic first planning prompt.
- Source drops from 10,622 to 7,692 lines and CLI commands from 59 to 20; docs
  rewritten for the Goal-only contract (`plugin-api.md` and
  `chatgpt-handoff.md` removed).

## 1.2.28 — 2026-11-22

- Give Goals a reachable finish line (owner decision). Production had 0
  release targets, checks or completions across 14 Goals, so every successful
  Goal ended BLOCKED. Now, when PI passes the final package of the approved
  plan, the Goal is DONE: that review is told PASS completes the whole owner
  Goal and to REPLAN if anything is missing. One immutable `goal_completions`
  row is written; later Goal writes and browser Sends are refused.
  `/goal-status` shows the result.
- Remove paths with zero production use: the independent release-gate
  subsystem (`goal-release*`, ~3,100 lines, 9 CLI commands), the PI connection
  drill, Chrome-profile browser-watch and `chat-adopt`. CLI commands drop from
  69 to 55. Kept and moved: provenance-checked Relay tab retirement
  (`relay-tabs.ts`), GitHub CI readback for `software-release-status`
  (`github-ci.ts`) and the enrolled Windows task readback used by the
  verified drain release (`windows-task.ts`). Historical SQLite rows and the
  empty v5 release tables stay readable; read-side adoption guards remain.

## 1.2.27 — 2026-11-22

- Stop re-executing passed work after a PI REPLAN. Production evidence: about a
  third of 459 PI reviews (11-11 to 11-22) were spent on work-item keys that had
  already passed in the same Goal, because every new plan started PENDING. A new
  plan item whose key or exact acceptance obligation already PASSED is now
  carried forward as PASSED (dependency order, original evidence references,
  append-only `goal.work_carried_forward`). PI sees the latest outcome per key
  across all plans instead of the last 20 rows.
- Give the ChatGPT executor a bounded *Established context* section with PI
  PASS summaries and still-open external blockers of the Goal, so it reuses
  accepted results instead of re-auditing baselines. Raw prior answers stay out.
- Add `/goal-continue <n|id> <what changed>` to continue a BLOCKED Goal after
  its external condition is fixed, instead of opening a new Goal that re-plans
  from scratch. No old Mission, receipt or stop flag is changed and no Send is
  replayed. `/goal-status` for a blocked Goal shows the blocked packages and the
  command.
- Documentation: align the AGENTS existing-message Retry contract with the
  code (one initial plus at most two existing-chat follow-ups), move completed
  one-time procedures to `docs/operations-history.md`, remove version labels
  from current runbook headings.

## 1.2.26 — 2026-11-21

- Handle ChatGPT's simultaneous hidden home composer and visible conversation
  composer by requiring exactly one **visible** editable and exactly one
  visible submit control. Two visible editors or controls remain ambiguous and
  cannot reserve or send a request. Live GMK DOM inspection demonstrated the
  hidden-home/visible-thread case in a settled NetBox NEXT checkpoint.
- Allow the existing revision-gated `pi-recheck-browser` read-only operator
  recovery for the exact previously persisted pre-Send mismatch interruption,
  after two matching user/assistant SHA-256 reads and the original PI decision,
  browser binding, repository grant and at-most-once receipt are verified.
  No automatic historical replay, SQLite migration or parallel Worker.

## 1.2.25 — 2026-11-21

- Fix Chinese long-message controls `显示更多`, `收起` and
  `显示更少` in exact ChatGPT prompt reconstruction. A live 2026-11-21
  Chinese session showed a completed first-turn reply while the deployed
  English-only parser treated the transcript as empty; the existing pending
  request is preserved, not replayed.
- Keep matching conservative: stripping an exact UI suffix never authorizes
  an incomplete collapsed prompt, and no Send, Retry, SQLite or scheduler
  semantics change.

## 1.2.24 — 2026-11-21

- Recognize Chinese ChatGPT transcript headings `你说：` and `ChatGPT 说：`
  alongside the English accessible headings, preserving exact prompt and
  assistant-answer SHA correlation in localized UI.
- Extend the localized browser-controller regression through a complete
  single-Send/observed-answer flow, including the ProseMirror composer and
  language-independent form submit control.

## 1.2.23 — 2026-11-21

- Support ChatGPT's localized ProseMirror composer through a unique semantic
  contenteditable textbox and the unique composer-form submit control, while
  retaining legacy selectors as the preferred path. The existing exact-chat
  binding and durable at-most-once Send reservation are unchanged.
- Add an end-to-end browser-controller regression using Chinese accessible
  labels and no legacy prompt/send selectors.

## 1.2.22 — 2026-11-20

- Run the existing Windows production build stages directly through the exact
  enrolled Node LTS executable instead of `npm.cmd run build`. This removes
  the SSH `cmd.exe`/npm run-script PATH dependency while preserving the same
  clean → TypeScript compile → provenance sequence.
- Keep the change inside the existing fenced Upgrade/rollback path; no Mission,
  SQLite, Worker, browser Send or scheduling semantics changed.

## 1.2.21 — 2026-11-20

- Make the Windows maintenance script prepend its exact enrolled Scoop Node
  LTS directory to the process-local `PATH` before running npm scripts, and
  verify `node.exe` resolves to that same runtime. SSH-launched upgrades no
  longer depend on an interactive login's inherited PATH; persistent user
  environment is unchanged.
- Add a source regression for the Node/npm runtime binding. No Mission,
  SQLite, Worker, browser Send or scheduling semantics changed.

## 1.2.20 — 2026-11-20

- Clean the generated `dist/` directory before every TypeScript build so
  removed or relocated modules cannot survive into a later production bundle.
- Add regression coverage proving build cleanup preserves project sources and
  refuses a filesystem-root target. No Mission, SQLite or Worker semantics
  changed.

## 1.2.19 — 2026-11-20

- Derive the operator CLI help version from `package.json`, eliminating the
  stale hard-coded `v1.0` banner. Keep the help text aligned with the current
  eight-Send-per-Chat policy.
- Correct operational descriptions of the eighth-to-ninth Chat rollover.
  Preserve the stable legacy `chrome-10-to-11` evidence identifier and all
  historical ten-Send SQLite records unchanged.
- No Mission scheduling, browser Send/Retry, SQLite schema or Worker
  lifecycle semantics changed.

## 1.2.18 — 2026-11-20

- Separate the single Worker's control cycle into authenticated owner intake,
  durable Mission/Goal recovery and dispatch, then best-effort outbound
  Telegram delivery. A pending `/pause` is observed before new browser work;
  a Telegram `sendMessage` failure can no longer skip the scheduler or strand
  the next eligible Goal. Inbound polling failures still defer dispatch.
- Retain failed replies and notification cursors for at-least-once delivery,
  isolate reply and notification failures, and perform startup recovery only
  after the first successful owner-inbox poll. No new daemon, database, queue,
  browser Send path or relaxation of uncertain-request/owner-pause fences.
- Add a single-Worker regression proving a failed terminal notification does
  not prevent dispatch of the next queued Goal, and update retry tests to
  verify durable outbound delivery without repeating owner commands.

## 1.2.17 — 2026-11-20

- Fix a reproduced production stall where ChatGPT's rendered final marker
  contained two zero-width spaces (`U+200B`) inside `MISSION_RELAY`. The strict
  standalone final-line parser now tolerates at most four such characters
  inside the marker only; original answer bytes and SHA-256 remain unchanged.
- Apply the same parser to first/new-chat observation, normal continuation,
  uncertain-answer recovery, store recovery gates, Telegram summaries and
  release Chrome probes. New versioned Goal work prompts explicitly require
  literal ASCII markers; legacy unversioned prompt builders remain byte-stable
  so already-reserved requests can still be reconstructed exactly.
- Add regressions for the exact rendered marker, bounded normalization and
  automatic dispatch of the next queued Goal after a prior terminal Mission.

## 1.2.16 — 2026-11-18

- Fix production ChatGPT delivery-timeout stalls after the first recorded UI
  Retry. For an unchanged uncertain existing-chat original request, permit up
  to two additional unique, durable same-message Retry intents, each at least
  two minutes after the preceding clicked attempt. No composer Send is
  repeated, no intent can be consumed a second time after ambiguous failure,
  and owner pauses, changed tab/prompt or active maintenance veto all retries.
- Apply the same bounded follow-ups during an already-running original
  browser observer, rather than waiting for the long observation timeout
  before trying again. Keep first-new-chat retry semantics unchanged.
- Notify the Telegram owner exactly once when three guarded attempts have
  failed; preserve the original request lock and unresolved Mission instead
  of silently continuing or inventing a completed reply.
- Independently recover a genuine final-marked existing-chat answer after a
  prior UI Retry, subject to the prior PI checkpoint, exact original prompt,
  stable SHA and no stale previous assistant reuse. Add targeted red/green
  tests for repeated banners, attempt exhaustion, pause, wrong request and
  completed-answer recovery.

## 1.2.15 — 2026-11-17

- Preserve a verified external work-item blocker without unnecessarily
  terminating the entire Goal. After PI marks that item BLOCKED, select a
  different approved, dependency-independent work item inside the same SQLite
  transaction. When no independent work remains, mark the Goal BLOCKED; never
  imply the blocked requirement or publication gate passed.
- Supply PI with recent durable PASSED/BLOCKED work outcomes, and prefer
  production changes, focused source-delta tests, native UX and licensed
  sandbox verification over repeated report-only or renamed feasibility work.
- Add deterministic regression covering independent delivery behind a real
  security blocker and terminal HOLD after the other lanes finish. Retain
  source/GMK separation, owner contract, one-Worker custody and original
  at-most-once browser Send handling.

## 1.2.14 — 2026-11-17

- Treat the exact Playwriter `locator.count: Target page, context or browser has
  been closed` failure **after an already observed PI NEXT** as a transient
  browser read/connection problem only when the last request is settled,
  the PI decision and full answer SHA match and no owner pause exists.
  Reuse the existing persistent request-bound 60-second-to-15-minute read-only
  reconnect backoff. Do not replay or reserve the prior browser Send.
- Add local `pi-recheck-browser` for an already-interrupted legacy checkpoint.
  Require an exact, revision-gated original error/event/decision chain and
  two stable independent reads of the same pinned Chrome user and final
  assistant SHA before clearing only the interruption. Leave original receipts,
  PI decision, pending work, owner stops and all audit history intact.
- Regression-test a real synthetic controller exit and SQLite reopen/reconnect,
  wrong hashes, stale revision, terminal decisions, owner pause and unresolved
  request. No new worker, scheduler, browser profile, permission or SQLite reset.

## 1.2.13 — 2026-11-16

- Classify the operator-managed PI host's exact structured 120-second model
  inference timeout as a transient PI-only failure, with existing durable
  request/SHA-scoped backoff. Never replay the already observed ChatGPT Send.
- Add revision-gated `pi-recheck-timeout` for previously stopped checkpoints.
  Independently verify the same pinned Chrome user and full assistant hashes
  twice before clearing only the PI error; retain original events, owner
  stop flags and browser receipts. A different error or changed tab fails closed.
- No change to PI model/provider/thinking selection, approved SSH 120-second
  infer timeout, single Worker, remote browser identity or deployment gates.

## 1.2.12 — 2026-11-15

- Add non-destructive, hourly in-Worker housekeeping for Missions with a
  confirmed settled result older than 24 hours. Retain complete SQLite
  records, original browser receipts and immutable audit events.
- Automatic archival excludes PI BLOCKED owner-action checkpoints, active
  Goals, unfinished NEXT/HANDOFF/LIMIT work, explicit owner pauses and
  uncertain or reserved browser Sends. The existing local `archive-settled`
  command remains available for operator-reviewed terminal BLOCKED history.
- Make archival idempotent, isolated from Telegram polling failures and
  disabled during maintenance; keep the single enrolled Worker and existing
  Windows restart schedule. Correct the 8-send policy in owner-visible help
  and public README without modifying any historical Mission.

## 1.2.11 — 2026-11-14

- Lower the operational per-ChatGPT-conversation Relay Send ceiling from 10
  to **8** (automatic 8→9 new-chat handoff). The unbounded Mission budget and
  preserved historical SQLite request/CI evidence are unchanged.
- Support ChatGPT's native maximum-length **prefilled, unsent** new Chat: find
  the unique empty origin in the approved Chrome profile, double-check the
  complete drafted prompt against the original durable SHA-256, and record a
  single original-request-bound Send intent **before** clicking Send. No
  duplicate composer fill or repeated Send is permitted after ambiguity.
- In unpaused Missions, the single enrolled Worker automatically follows
  its verified native Start-new-chat click with this one-time exact-draft Send.
  An owner pause blocks background Send; the operator may explicitly
  authorize the original draft after guarded deployment.
- Independently verify a complete final-marked reply in the unique distinct
  Chat URL, atomically credit and migrate the original uncertain request, and
  then pass the recovered checkpoint to PI. On unverifiable output keep
  original uncertain state and refuse additional Sends.
- Preserve cooperative pause, workflow isolation, private request data,
  maintenance gates and exact-SHA release/production attestation. Add
  synthetic UI, SQLite, interrupted-click and recovery regression tests.

## 1.2.10 — 2026-11-14

- Detect ChatGPT's actual maximum-conversation-length banner and unique
  adjacent native `Start new chat` button. Treat this as terminal UI capacity
  rather than a response, ordinary connection interruption or Retry banner.
- Add original-request, SQLite-backed one-shot `Start new chat` click intent
  and audit. Normal enrolled-Worker recovery may click after an unpaused,
  settled-uncertain original Send; for an owner-paused request, the operator
  can use `browser-start-new-chat` after the guarded GMK upgrade. This
  command checks the exact tab, original user SHA and stable native UI twice
  before persisting intent, then clicks at most once.
- Preserve original uncredited requests, scope approvals, PI evidence,
  conversation lock and historical audit. Do not turn native UI navigation
  into a fabricated complete answer, silently replay a composer Send or
  claim automatic cross-chat context migration without independent evidence.
- Add positive and negative synthetic browser/SQLite recovery tests.
- Restrict the existing public CI matrix to `main` Push and Pull Requests,
  avoiding a redundant six-job run when an already qualified release tag
  is published.

## 1.2.9 — 2026-11-14

- Remove an unrelated third-party browser-extension archive from the source
  checkout without deleting the original bytes. Current public documentation
  now describes the supported browser interface rather than dated exploratory
  experiments; obsolete historical Mission instructions and outdated Chat/SQLite
  limits are no longer presented as current rules.
- Add a read-only source consistency gate: enforce package/lock/STATE/CHANGELOG
  version alignment, validate local Markdown links, refuse unexpected top-level
  cross-project files, and ensure CI continues to run its safety checks.
  Include regression tests and execute the gate as part of `npm run check`.
- Keep all runtime state, protected reservations, legacy compatibility
  modules, local GMK copy and recovery assets unchanged. A source commit/CI
  does not itself deploy a new Windows Worker.

## 1.2.8 — 2026-11-14

- Default to economical execution for metered/private GitHub Actions. PI and approved browser work-package prompts now check repository workflow triggers, prefer local or approved native-host tests for intermediate work, batch pushes at meaningful milestones, and reserve paid CI for explicit critical/release gates. Explicit acceptance requirements and release verification remain binding; this does not modify other repositories' workflows or automatically disable their push triggers.
- When an owner pauses an in-flight Send, defer its existing-message UI Retry without consuming the one-shot intent or converting the pause into a misleading exception. Add narrowly scoped, revision-gated owner release for an already-uncertain existing-chat Retry, including historical paused-claim failures, while preserving original prompt/URL identity, repository approvals, maintenance fencing and no-composer-resend semantics.
- Keep legacy reserved browser prompt reconstruction byte-compatible; add regression coverage for paused existing/new-chat Retry and CI prompt behavior.

## 1.2.7 — 2026-11-14

- Refresh the public README to document current Goal, repository isolation, PI, browser execution, recovery and deployment features without incident history or private production state. No changes to scheduler, credentials, browser requests or the SQLite schema.

## 1.2.6 — 2026-11-14

- Recover the exact bytes of user-authored ChatGPT prompts from the current accessible transcript paragraph. ChatGPT's inline URL widgets can insert extra visual line breaks into parent `innerText`, causing the unchanged original request SHA to appear different and triggering a false ambiguous-Send stop. Preserve actual HTML line breaks, recurse through link text and exclude only UI nodes explicitly marked `data-markdown-copy=exclude`; use the original strict fallback if the new paragraph structure is not uniquely present.
- Regression tests verify a link-wrapped prompt's original exact SHA and reject treating a genuinely newline-separated prompt as the same bytes. This changes read-only message attribution only: no automatic resend, fabricated receipt, changed write scope or concurrency.


## 1.2.5 — 2026-11-14

- Repair the owner-local `telegram-build-project --allow <path>` and `--revoke <path>` CLI branches: one required flag value was incorrectly rejected as an extra argument. The documented multi-repository approval and revocation commands were unusable despite lower-level tests passing.
- Add end-to-end subprocess/SQLite tests for explicit sibling repository grants, duplicated grants, overlapping/aliased paths, exact revocation/reapproval and invalid argument counts. Never touch Mission/Goal requests during a local grant change.


## 1.2.4 — 2026-11-14

- Require an explicit `--repo <approved-root>` on **every** `/goal-build`, including the first Goal: the global legacy `/build` default is not a multi-project authorization. Keep existing `/build` behavior for single-project tasks.
- Refuse overlapping (parent/child) repository grants, redundant path separators and legacy overlaps already present in SQLite; recheck exact scope and declared source identity before recovery, dispatch and the atomic final browser Send reservation. No silent rebind, implicit access expansion, historical replay or new daemon.
- Existing X-to-Markdown-Copier and Field Companion are distinct Git roots on the approved operator host; prior X Mission's *authorization metadata*, not the source tree, was mismatched. It remains protected, never reassigned to another repository automatically.

## 1.2.3 — 2026-11-14

- Recover an existing-chat continuation whose original Send outlived the one-hour browser observer and later produced a complete answer **without** showing a Retry button. A previously verified PI NEXT/HANDOFF checkpoint, unchanged last user-prompt SHA, exact pinned conversation, a distinct terminal-marked reply and two stable inspections are required before the original request is credited. No composer Send or Retry click is performed.
- Preserve the existing one-shot Retry flow for actual delivery/stream errors and keep first-turn/new-chat recovery conservative. Tests reject stale prior assistant rerenders and first-turn recovery without prior PI custody.
- The previously repaired Windows midnight scheduling termination is not this incident: the observed production task remained running with `StopAtDurationEnd=false`; a separate browser observer reached its one-hour deadline. When the approved Chrome profile exposes no Playwriter-enabled ChatGPT tab, recovery still requires restoring the original conversation binding; neither source release nor a worker restart can fabricate that evidence.
- Reject new write-enabled Goals when their explicitly declared source repository differs from the approved destination; also fail closed at checkpoint scheduling and inside the atomic Send reservation for existing misbound Goals. Do not alter historic Goal/SQLite identity or grant another repository implicitly.

## 1.2.2 — 2026-11-13

- Repair recovery for an original **new-chat** browser Send that completed navigation but timed out before its final reply was observed. A unique Playwriter-enabled destination must match the original immutable user-message SHA; the predecessor Chat and PI decision remain independently checked. No second composer Send is ever authorized.
- Reuse the existing per-request, SQLite-persisted single UI Retry budget for eligible `Message delivery timed out` / `Error in message stream` controls even after the new-chat observer has stopped. Verify unchanged request and original destination before retrying; a missing, duplicate or wrong tab remains unresolved.
- Preserve owner pause during source release and GMK maintenance. The narrowly scoped `browser-resume-pending-retry` command explicitly releases only the exact stopped, uncertain new-chat request **after** deployment; the command itself does not touch Chrome. Only the existing enrolled Worker may subsequently click the already-submitted message's Retry and reconcile a twice-verified complete reply before PI continues.
- Add isolated regression tests for owner pause, wrong/duplicate destination, one-shot click, original request custody and automatic new-chat reconciliation. Real production Retry and Goal acceptance remain separately verifiable runtime steps.


## 1.2.1 — 2026-11-13

- Fix queued Goal bootstrap when the original approved ChatGPT launcher tab is absent; only zero-Send Goal intake can use the approved-profile fallback, while all existing conversation recovery still requires the exact original tab.
- De-duplicate accidentally resent live Goal requests by objective and approved repository without merging distinct repositories; retain original durable request identities.
- Keep explicitly owner-paused queued Goals in the actionable Telegram list so numeric status/resume selectors work without UUIDs.
- Resolve `/goal-status` to the newest Goal and support stable numbered `/goal-status N` from `/goals`, rather than silently displaying the oldest Goal.
- Preserve independently approved repository grants and explicit revocation tombstones across the optional, safely fenced pre-production project reset, with hash validation and isolated database round-trip tests.
- Align architecture, Telegram operations and user-facing product documentation with single-Worker multi-Goal checkpoint scheduling, removing contradictory pre-v1.2 instructions. Real two-Goal GMK execution remains a separate deployment acceptance requirement.

## 1.2.0 — 2026-11-13

- Accept independent authenticated `/goal-build` requests into the existing SQLite while another Goal is running, paused or awaiting its original Send; never treat a fresh Goal as an instruction to the previous one.
- Scope each Goal-bound Mission to its own immutable repository and browser identity. Local operator approval supports multiple explicit repositories with `telegram-build-project --allow/--revoke/--list`, and Telegram selects with `/goal-build --repo <approved path> <objective>`. Existing single-project approval is honored until explicitly revoked.
- Use the one leased Telegram Worker to rotate active Goals at **fully observed Send + committed PI decision** checkpoints; never preempt or resend an unsettled request. Preserve the existing ten-Send Chat limit, prompt snapshots, original Retry/recovery and one-worker SQLite locks.
- Present running/queued/paused/needs-attention/PI-completed states in `/list`, `/status` and `/goals`; numeric selectors permit owner pause and explicit safe resume without routinely exposing internal UUIDs.
- Extend synthetic SQLite/Playwriter regression coverage for two repository-separated Goals progressing A→B→A→B, restarted controller custody, persistence, authorization revocation, duplicate intake, owner pause and unsettled-Send safety. These tests are **not** live GMK concurrent acceptance.

## 1.1.5 — 2026-11-13

- Redesign owner-facing Telegram: task titles, readable progress, pagination and status without UUIDs, a concise **All Done** completion summary and actionable paused/blocked messages.
- Report PI progress on the first and every fifth reviewed turn, rather than dumping internal events and hashes each round. Do not equate a PI task's DONE with independent business release verification.
- Remove the obsolete 5→6-only Chrome ReleaseProbe, CLI history reader and special pre-Send recovery exception. Ten observed Sends per Chat remains the runtime boundary. Immutable SQLite requests, audit history, no-replay and general recovery protections remain intact.
- Preserve the existing cooperative maintenance, isolated SQLite restore, verified rollback and exact-SHA single-Worker GMK promotion path.

## 1.1.4 — 2026-11-13

- Increase per-ChatGPT-conversation capacity from five to ten durably observed Relay Sends; the eleventh must open a distinct observed Chat URL, retaining no-replay and PI review protections.
- Align independent Chrome rollover verification with 10→11 while retaining read-only legacy 5→6 custody evidence.
- Preserve the existing cooperative pause, atomic maintenance drain, isolated SQLite restore and rollback requirements for GMK deployment.

## 1.1.3 — 2026-11-13

- Fix a long-running Windows Task Scheduler defect discovered from repeated 00:04 Event 111 task terminations: a daily two-minute recovery trigger inherited `StopAtDurationEnd=true` despite `ExecutionTimeLimit=PT0S`. Explicitly set `StopAtDurationEnd=false` to keep the enrolled Worker running through midnight.
- Make `UpgradeSchedule` migrate existing tasks with an unsafe stop-at-duration-end flag even if their two-minute trigger already exists; validate the updated trigger, unchanged Worker PID, and recovery schedule in read-only Status output.
- Protect already-submitted Mission turns: repairing the scheduled task never sends, retries, deletes, or modifies the original browser reservation. Use the existing guarded Chrome recovery route to inspect any previously stranded new-chat request.

## 1.1.2 — 2026-11-12

- Recognize ChatGPT's actual `Error in message stream` UI control (including its optional period) only in the exact visible Retry control group, rather than from generated prose.
- Use the same SQLite one-shot Retry intent for both stream errors and delivery timeouts, including a new ChatGPT conversation's first message. Never retry the composer Send; interrupted or uncertain first-new-chat Sends remain fail-closed.
- Extend the single enrolled Worker's timed-out original-chat recovery to stream errors, with prompt hash, exact URL, unspent reservation, stable final answer and PI review gates unchanged.
- Regressions cover successful Retry, cross-error one-shot deduplication, wrong/quoted UI refusals, original-message and new-chat pathways.

## 1.1.1 — 2026-11-12

- Persist a single original-request delivery Retry intent before clicking ChatGPT's exact visible `Retry` button. Worker crashes, reattachment and ambiguous click completion cannot trigger another Retry or composer Send.
- For a timed-out original same-chat Send, the enrolled Telegram Worker can read the original pinned tab, retry that submitted message once if eligible, and independently recover its twice-stable final-marked answer before PI continues. Wrong tabs, changed prompts, unrelated failures and maintenance drains remain blocked.
- Add deterministic positive and negative regression tests for retry intent deduplication, original-answer recovery and changed-prompt refusal. Software release still requires exact-SHA CI; GMK promotion remains subject to its independent maintenance gates.

## 1.1.0 — 2026-11-11

### Product and workflow

- New PI Missions have no fixed Mission-level turn ceiling. The five-observed-Send limit per Chat remains enforced; legacy finite-limit Missions retain their saved behavior.
- Goal planning, plan validation, work-item selection and PI review are system-owned. The former user-facing stage/verify/review/activate workflow is removed.
- Telegram `/status` defaults to the latest non-archived Mission. `/pause` can omit its UUID only when one eligible active Mission is unambiguous.
- The approved ChatGPT launch URL and Chrome profile are stored independently from any Mission, so a fresh project does not depend on historical task records.

### Operations and recovery

- Adds the explicit, one-time Windows `ResetProjects -ConfirmResetProjects` operation for pre-production history cleanup. It requires an idle preflight and atomic drain, captures a private SQLite backup, independently restores it, rebuilds the same supported schema without project rows, preserves owner connection configuration and the Telegram inbox cursor, then verifies the replacement Worker before releasing maintenance.
- The reset refuses unsupported SQLite schema objects and checks every Mission, Goal, Acceptance, dependency, release, owner-directive and command table for emptiness.
- Documents the human-facing interaction contract and the safe first-project baseline.

### Compatibility and quality

- CI now tests Node.js 24 and 26 on Ubuntu, Windows and macOS (six matrix jobs).
- Runtime remains Node.js 24+; the GMK deployment runs Node.js 26.
- Legacy finite-limit Mission records and their historical successor evidence remain readable.

### Known dependency audit

- At release qualification, `npm audit --omit=dev` reports seven **moderate** transitive advisories in the pinned Playwriter 0.9.0 dependency tree; no high or critical advisories were reported.
- The suggested Playwriter 0.5.0 downgrade is a breaking browser-integration change, not a safe patch. The pinned integration is retained until an upstream-compatible update can be qualified against the actual Chrome extension, tab custody and recovery paths. Re-run the dependency audit when updating Playwriter.

## 1.0.0 — 2026-11-11

- Initial public v1.0 baseline and exact-SHA, three-platform release qualification.
