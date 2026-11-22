# Operations

## Checkout hygiene and source/runtime drift

Run `npm run state-check` before committing source or changing public
documentation. It checks the package, lock, current STATE and changelog
version, local documentation links, CI checks and unexpected top-level
entries. The normal `npm run check` also invokes it. Keep unrelated app
repositories, downloaded extensions, credentials, temporary tests, private
SQLite backups and recovery images **outside** the Mission Relay checkout.
An unexpected binary or adjacent project is not a Core dependency.

## Worker scheduling and Telegram delivery isolation

The single Worker processes one cycle in this order: authenticated owner
inbox, durable Mission/Goal recovery and dispatch, then outbound Telegram
replies and notifications. This ensures a queued `/pause` is applied before a
new browser Send. A failed outbound `sendMessage` leaves its original SQLite
reply/event cursor pending for a later cycle and must not stop Goal scheduling.
An inbound `getUpdates` failure still defers new dispatch because the Worker
cannot prove that no owner control command is waiting. Startup recovery uses
the same order; never add a separate scheduler or bypass the single Worker.

GitHub `main`, a published release and the installed GMK Worker have
different provenance. After a source change, first qualify the **exact**
main SHA with `software-release-status` and its completed CI run; do not
reuse an earlier green run for a later SHA. On GMK, independently compare
`git rev-parse HEAD` against
`channel-status.runtimeProvenance.sourceSha` and the enrolled task's Worker
identity. A mismatch during a source-only maintenance cycle means
**deployment is outstanding**, not permission for an ad-hoc pull or
restart. Only perform the registered Windows `Upgrade` when the real
SQLite idle preflight is satisfied. An active or uncertain original Send
must settle; never clear its reservation to eliminate version drift.

## ChatGPT conversation maximum length

ChatGPT can display the exact native notice `You've reached the maximum
length for this conversation, but you can keep talking by starting a new
chat.` with a `Start new chat` button. This is not a completed reply,
ordinary transport Retry or a model-suggested handoff. An in-flight observer
records a specific uncertain capacity error, preserving the original Send's
immutable request key, prompt SHA and URL lock. An older installed observer
may instead reach its normal ambiguous response-observation timeout.

The enrolled Worker may inspect an *unpaused* uncertain original Send and
click only the unique adjacent native UI after recording the original
request's one-shot `chatgpt.browser_length_start_intent`. An owner pause
must be respected. When the original Send has ended uncertain, the
source/runtime upgrade is fully verified and the owner explicitly authorizes
the native action, use:

```sh
node dist/cli.js browser-binding-health <mission-id>
node dist/cli.js browser-start-new-chat <mission-id> --revision <current-revision> --acknowledge-side-effects
```

The operator command first double-checks the exact original bound tab, last
submitted user SHA, stable native banner and enabled button. It records one
immutable intent **before** clicking, then appends its click receipt. If a
click fails ambiguously, never run the command again to re-click: inspect
the resulting page and retained evidence. It never clicks Send, credits an
original answer, clears the old conversation lock, releases an owner pause,
guesses a new chat URL, or marks the Mission DONE. Determine the actual
new-chat state and verify pending code/CI/deployment effects before
authorizing **distinct** further work; an automatically migrated context
cannot be inferred from the button label.

**Native prefilled draft (after a verified upgrade only).** The platform
may open a new unsent ChatGPT origin containing the last full command. The
original unsent text is an immutable Goal-bound prompt snapshot in private
SQLite. Do not fill, edit, or re-create it. Read-only preflight confirms
exactly one origin in the approved Chrome profile, no visible submitted
user/assistant turns, and an identical SHA-256 of the entire unsent textbox
on two separate reads. Once the existing native Start click and original
PI/Goal/repository authorization are confirmed, execute:

```sh
node dist/cli.js browser-send-native-draft <mission-id> --revision <current-revision> --acknowledge-side-effects
```

The command records one original-request-bound Send intent **before** one
click. A failed/ambiguous click consumes its allowance; never repeat the
command to click again. The existing enrolled Worker only inspects a single
distinct Chat URL with the same exact submitted prompt, waits for a complete
stable terminal-marked response, and atomically migrates that *original*
uncertain receipt. It does not assume that a new draft is a completed Send.
Only the verified recovered checkpoint may go to PI; unavailable or
ambiguous browser evidence leaves the Mission stopped. Future Chat rollover
uses **8** observed Relay Sends per Chat; archived 10-turn evidence remains
historical, not the current source ceiling.

## Metered CI and native verification

For long-running commercial Goals, a work-item external blocker is not an
automatic stop for independent product work. In v1.2.15, an explicit PI
`BLOCKED` review durably retains that item and its evidence; the same atomic
decision selects the next dependency-independent work item if one exists.
Blocked prerequisites cannot be counted as release PASS. When independent
work is exhausted, the Goal becomes BLOCKED and requires real new capability
evidence or an owner-authorized contract change before resumption. The PI
planning prompt includes recent durable PASSED/BLOCKED item outcomes to avoid
renamed feasibility loops; those outcomes are controller history, not proof
of real Git, device or billing acceptance. Operators should inspect the
existing Goal ledger and source-bound evidence instead of opening another
identical audit work package. Routine patches get affected tests, not a
repeated full CI matrix; final exact-SHA release CI is still mandatory.

Before pushing iterative changes to a private repository, inspect its `.github/workflows/` triggers. A push to a watched branch may automatically start a complete metered matrix. Prefer local deterministic checks and the already approved native testing host (for Android, the established device/emulator/Google Play readiness workflow); batch remote pushes at meaningful acceptance boundaries. Run hosted CI when the actual owner acceptance or high-risk release gate needs independent coverage. The native Play readiness check is not a Play submission or a replacement for mandatory independently evidenced remote release CI. Mission Relay's prompt policy cannot disable GitHub workflows in unrelated repositories; optimize those workflows separately when authorized.

## Paused original-message Retry after maintenance

Owner pause is a stop fence, not permission to click Retry. If an already-submitted original existing-chat request becomes uncertain while an owner pause is in force, keep its immutable browser reservation, prompt hash, tab binding and single Retry allowance. When the read-only maintenance preflight confirms no active Send or pending notifications, perform the normal fenced pull-only upgrade. **After** the newly deployed Worker is independently attested, obtain the current Mission revision and explicitly release only that one original request:

```text
node dist/cli.js browser-resume-pending-retry <mission-id> --revision <current-revision> --acknowledge-side-effects
```

The command performs no Send, UI Retry or browser mutation. The enrolled Worker checks the same tab and exact latest user prompt, the actual delivery/stream-error Retry control, original PI chain and repository authorization, then persists at most one UI Retry intent before clicking. An earlier paused-claim failure is eligible only when its append-only pause predates the original uncertain event; unrelated errors or already-spent intents remain blocked. A complete reply is independently checked twice before PI proceeds. The operator should not repeat the command, clear its receipt or manually send the prompt.

## Timed-out new-chat recovery after a software upgrade

The new-chat origin can already contain the one original Send even when the
observer exits without recording its destination. An error banner in that
new Chat is **not** permission to replay the composer Send. The single enrolled
Worker may discover a unique Playwriter-enabled Chat in its pinned Chrome
profile whose latest user-message SHA matches the reserved original prompt.
It also checks the prior Chat's PI decision before using the existing one-shot
SQLite Retry intent and the exact visible same-message Retry control. A wrong,
duplicated, missing, generating or changed conversation fails closed.

When the owner had paused the Mission, leave it paused through GitHub release,
independent three-platform CI and GMK audited `Upgrade` under the idle
maintenance drain. Never use `-ResumeMissionId` for an uncertain Send. Only
**after** confirming the new Worker SHA, SQLite continuity, single PID,
transport health and released drain, the owner may authorize the original
already-submitted new-chat Retry with:

```text
node dist/cli.js browser-resume-pending-retry <mission-id> --revision <current-revision> --acknowledge-side-effects
```

The CLI records the owner release and changes neither browser nor pending
request; the running Worker subsequently attempts at most one eligible UI
Retry for the original request, and independently verifies a stable final
answer before recording the recovered rollover. Never reset this durable
intent or manually send the prompt again. PI review and subsequent dispatch
remain normal, separately verified steps.


## Multiple-Goal production gate

This release adds no daemon, queue service or destructive SQLite migration.
Goal B may be persisted as READY while Goal A is still running or has an
outstanding original Send. Queued Goal intake is not permission to preempt
Goal A, and every READY Goal also blocks the normal maintenance drain.

Require exact-SHA GitHub main and successful same-SHA Ubuntu, Windows and
macOS CI, then run the enrolled original Windows read-only restart
preflight, real SQLite maintenance drain and the existing
`scripts/windows/telegram-task.ps1 -Action Upgrade -ExpectedSha <sha>`
pull-only upgrade. Preserve its isolated DB restore, backup, compiled
rollback and one-Worker source/PID attestation. When any RUNNING or READY
PI Mission, original reserved Send or undelivered notification remains,
**do not deploy**; never stop the current Worker or reset its tasks.

Live acceptance is separate from CI and synthetic tests: actual Goal A must
remain unfinished while distinct Goal B is accepted; the one Worker must
advance their different approved repositories and physical ChatGPT
conversations in alternating settled checkpoints and deliver two
independent final reports. A simulated browser does not meet this gate.

If the optional, explicitly owner-approved `ResetProjects` action is ever
used on a fresh pre-production environment, the SQLite-only reset must
preserve all exact-path repository grants and explicit revocation tombstones,
alongside the original PI route, legacy default, Telegram inbox cursor and
approved Chrome launch profile. Verify that a previously revoked path stays
revoked and that no old Mission, Goal, browser reservation or queued request
survives the reset. **Never** use project reset as a production upgrade step.

## Completed one-time procedures

The pre-production project reset and the pre-fenced GMK migration are complete.
Their exact procedures are kept for audit in [operations history](operations-history.md);
do not run them as part of a normal upgrade, which always uses the fenced `Upgrade` path.

## Independent release evidence: maintenance and work criteria

**Trusted probe verdicts (read-only diagnostic):** Use
`node dist/cli.js goal-release-probe-diagnose <goal-id> --requirement <gate-or-criterion>`
with the already-approved release target and operator-managed host remote configuration.
It returns `PASS` only for a validated independent source-SHA-bound
readback, `FAIL` for contradictory/invalid evidence or a mismatched SHA,
and `INSUFFICIENT_EVIDENCE` for missing physical witnesses, unmapped
independent work or unfinished original request custody. This diagnostic
does **not** write `goal_release_checks`, grant PI acceptance or authorize
another Send. Only the existing `goal-release-verify` inspection can
record a verified source receipt, and the final Gate still independently
requires every criterion, current main and production health.

Maintenance recovery verifies not only the original Mission rows and
append-only browser events but also existing Goal identities, prior Goal
events and idempotent operations, and Goal bindings belonging to protected
interrupted Missions. Historical paused/blocked Goals and Goals bound to
protected paused Missions must retain their original status and version.
The maintenance receipt also compares the full pre-upgrade SQLite graph of
each protected Goal: plans, work items, dependencies, acceptance criteria,
Goal events and operations, and any release target, checks or completion.
Directly rewriting a work-item/acceptance row without appending an audit
event must fail even if the upgrade journal and Mission event digest agree.
The restored backup is independently checked for all those tables before
release; the live production original is never opened for test writes.
Unprotected active Goals may legitimately continue working after upgrade;
their new events must append without rewriting the pre-upgrade prefix.

The maintenance-resume ReleaseProbe does not stop/restart Worker,
clear a drain, or resume any Mission. The enrolled Windows Upgrade is
still the only source of production mutations. It reads the newest
private upgrade-audit-*/receipts.jsonl under
LOCALAPPDATA/MissionRelay/telegram-task, verifies its SHA-linked stages
and actual private missions.sqlite backup by SHA/integrity/foreign keys,
original event history, exact source/Worker and a live physical Chrome/PI
custody readback. Incomplete/rolled-back upgrades cannot PASS.

The trusted Chrome 8-to-9 ReleaseProbe (stable legacy gate ID:
`chrome-10-to-11`) requires an independently captured physical
source/destination witness for **every** Goal-bound eighth-to-ninth
Chat rollover, not merely one earlier successful rotation. Missing,
duplicate, mismatched-SHA or contradictory witnesses fail closed; a later
rollover cannot inherit an earlier receipt. The 32-turn successor probe
separately requires a distinct, zero-turn successor, an observed first
response with its original request identity and matching PI review.
Neither probe may replay a Send or infer PASS from a model DONE marker.
The physical tab-retirement probe also requires **one uniquely hashed
witness per original retirement event**. Two differently timestamped witness
files for one event are contradictory, not proof of two closed tabs. A
Release Gate additionally requires exact target-SHA identity for *every*
stored outcome, including FAIL and BLOCKED, so stale diagnostic failures
cannot be inserted into the current release evidence ledger.
Reproducible fixture inputs, required negative outcomes and private receipt
boundaries for all trusted ReleaseProbes are indexed in
[trusted release probes](trusted-release-probes.md).

For each approved criterion, an independent operator must privately
create MISSION_RELAY_HOME/goal-release-evidence/independent-work-map.json
on GMK. This is not sourced from PI or ChatGPT PASS. Its JSON fields:
version=1, goalId=<Goal UUID>, sourceSha=<exact release SHA>, criteria[].
Each criterion entry requires acceptanceId, workItemId, criterionSha256
(exact text digest), testFile (tests/example.test.ts), testName
(unique passing Node TAP test), and answerSha256 (original PI-reviewed
complete browser reply). Keep this outside public Git.

An independent reviewer must establish that the mapped assertion really
tests the specified acceptance criterion. The probe checks Goal, Work,
criterion text SHA, original request and PI decision; then invokes only
that tracked test file in the approved operator-managed host checkout via fixed SSH.
The named test must PASS once (not SKIP/TODO), exit zero with no failures.
The TAP root plan must match the number of top-level passing tests, its
aggregate tests/pass counts must match the actual passing TAP assertions,
and fail/cancelled/skipped/todo
counts must all be zero. Missing or repeated TAP summary fields are not
accepted as a complete independent test readback.
The fixed, authenticated operator-managed host SSH command must also emit one unique
`MR_WORK_TEST_SESSION_V1` marker containing its one-time controller nonce,
actual remote hostname and shell PID **before** invoking the tracked Node
test. The marker must match the original captured stderr exactly; missing,
duplicated, stale (over five minutes old) or substituted session markers fail closed even when TAP
looks successful. Original TAP stdout, raw stderr and their SHA receipts are
stored privately. This is SSH-verified process provenance, not hardware
attestation of arbitrary code executed inside a test. The receipt
binds the authoritative work-item **key and ID**, exact source SHA, criterion
digest, original reviewed answer SHA, tracked test path and unique test name,
actual test exit code, SSH executor identity, session nonce, hostname, PID,
recomputed fixed command digest, start/end time and observed `PASS` result.
A work-item key changed
while the test runs invalidates the receipt. Unmapped
standards, untested business outcomes, PI claims and plain CI success
remain PENDING; a generic unit test is not sufficient proof.

## Canonical development checkout and local execution node

For the owner-operated operator-managed host/GMK deployment, the **durable operator-managed host Linux checkout is the only development source**. GitHub `main` is the reviewed, pushed release/synchronization record. The Windows GMK checkout is a **pull-only execution copy**, not an independent branch of product development. This does not make operator-managed host a Mission Provider or move the authoritative local browser-Mission SQLite database to the VPS.

1. Inspect both checkouts' `git status`, `HEAD` and `origin/main`. Fast-forward a clean operator-managed host checkout to the verified upstream head before editing. Never overwrite a dirty tree or perform an implicit merge of competing histories.
2. Edit and test in operator-managed host. Run TypeScript, privacy scan, the complete tests, build and `git diff --check`; review the diff for tokens, private URLs, credentials and platform assumptions before committing and pushing. Verify the remote commit by exact SHA. Prefer the existing CI on Ubuntu, Windows and macOS as a cross-platform release gate.
3. The Windows node runs the **already authenticated, user-session Chrome/Playwriter/Telegram** bridge. Its local SQLite, DPAPI credentials and enabled Chrome tabs stay on Windows and must never be committed, uploaded to GitHub or transplanted to operator-managed host. PI inference may continue to run through the already configured tool-free SSH route.
4. Promote only the exact reviewed GitHub commit to the Windows checkout by fast-forward. A locally modified or divergent Windows checkout is a deployment blocker; inspect and port any legitimate hotfix into operator-managed host first. Do not install a second foreground poller, modify the Chrome profile or reset local Mission records as part of a code upgrade.
5. Before activating a new build, verify an idle Mission set, no queued Telegram delivery, no reserved browser Send and no accepted PI task still in READY before its first Send, then use the existing SQLite maintenance drain and the **same** enrolled Windows Telegram Scheduled Task to restart cooperatively. The drain also rejects an unsubmitted PI-ready task; do not bypass this gate by force-killing the worker. Recheck the new process, fresh Bot API `getUpdates` health, preserved cursors, watch profile and private Mission checkpoints. An interrupted deployment is not permission to resend the last ChatGPT request.

**Windows dependency updates are separate from source sync.** Never run destructive `npm ci` against live `node_modules` containing a DLL held by the current worker or Playwriter. Build in a clean isolated checkout first, or arrange an explicitly idle/drained maintenance window. Normal source-only TypeScript changes can use the existing compatible dependencies, but the running worker still must be restarted to load the new `dist` files. Keep the rollback commit and original SQLite state intact until verification succeeds. Avoid automatic Windows-to-Linux pushes, bidirectional file synchronization, another updater daemon or a second writable Mission database.

### Existing worker's bounded soft-stall watchdog

The Telegram worker has a 30-second unreferenced in-process watchdog. After five minutes without ordinary control-loop progress, it may exit code 75 for the already-enrolled repeating Windows Scheduled Task to restart it. Its SQLite fail-closed read requires ownership of the current lease, no running Mission or reserved browser Send, no unsubmitted PI-ready Mission, no undelivered command reply or event notification and no maintenance drain. Before the voluntary code-75 exit it records `lastIdleExit` (UTC time, PID, elapsed milliseconds, exit code) in the private SQLite database, exposed read-only by `channel-status`. This does **not** prove the cause of any earlier PID change, nor does absence of the field prove that no other restart occurred. It does not kill another process, resubmit a ChatGPT prompt or introduce another daemon/task. This handles recoverable asynchronous stalls, not blocked JS execution, OS hangs or active side-effect uncertainty. Restart capability is synthetically tested; an observed production PID change without a prior durable exit receipt remains of unknown cause.

### Repeatable live acceptance evidence

The cross-Mission controller extension creates one linked READY successor only for a legacy finite-limit PI Mission at a fully observed 32/32-turn checkpoint with a durable `LIMIT` event. New PI Missions have no Mission-level turn ceiling and continue in the same Mission. An idempotent recovery scan fills a missing legacy child after a worker restart, while the child's first Send requires a stable parent-tab exact prompt/answer hash comparison. The first child Send opens a new conversation and remains subject to the existing URL lock and no-replay semantics. `/status` shows predecessor/successor IDs; a legacy `LIMIT` notification with a successor is a *progress* report, never owner-goal completion. No change to the existing Windows Scheduled Task, PI SSH permissions, Playwriter profile or local SQLite path is required. Do not promote or restart the Telegram task while its currently executing `/build` Mission is RUNNING or has a reserved browser Send; wait for a safe idle maintenance gate, then use the existing drain/task. Cross-Mission live acceptance and independent external-code validation remain separate from software release qualification.

The controller's **eight-Send** rollover check is backed by the same SQLite transaction that reserves a request key: a ninth request directed at the unchanged conversation fails **before** an external Send. An explicit new-tab reservation records its intent, and an observed answer cannot be credited until that reservation migrates to a different direct ChatGPT URL. Historical ten-Send rows are accepted as old audit evidence, never as authority for further same-Chat Sends. After a crash or browser disconnect, do not bypass the ceiling by issuing a raw `browser-send` into the old conversation or by reconstructing a different prompt for an uncertain new-tab Send. Inspect the original reservation and use exact-prompt supported recovery only.

**Relay-owned tab retirement after successful handoff:** Playwriter's connection deliberately sets `closeTabsOnEnd:false`; otherwise connection cleanup could close a verified active destination or a user tab. To reduce the cost of repeated long-task handoffs, the continuous PI and browser-drive controllers separately remember only new tabs they themselves opened. Following a *later* fully observed, atomically committed destination, a bounded best-effort cleanup closes the previously created superseded tab, provided its URL still matches the old approved ChatGPT conversation. Never close the user's initial tab, the newly active tab, or a page whose URL changed. A browser-close exception is logged without changing the durable answer or authorizing a resend. No global tab sweeper, profile takeover, or cross-process ownership inference exists. Test coverage uses distinct synthetic tabs, consecutive handoffs, thrown close, and changed URL. A previous GMK Chat rollover was observed, but this is not evidence for a current 8→9 release; **Chrome memory reduction remains unmeasured**, and a stored tab-retirement receipt alone is not physical closure evidence.

PI rotation performs the source transcript exact-SHA check twice: first before choosing the next action, then in `executeBrowserRollover` immediately before reserving the new-tab Send. The second check receives the last durable user prompt and full assistant answer digests, so a changed source after the earlier browser read cannot authorize a fresh Send. An explicit test changes the source assistant response between those reads; it must fail with **zero new reservations and zero new tabs**. This test does not replace observing the actual eighth-to-ninth live handoff on GMK.

Ordinary PI `NEXT` into the same existing ChatGPT conversation now performs the analogous second source-hash verification in `executeBrowserTurn` immediately before SQLite reservation, covering a human/browser change during PI planning. Sequential `browser-drive` batches likewise recheck the previous observed exchange at the boundary before their next intra-batch Send or explicit HANDOFF new-tab Send. The check covers both latest canonical user prompt SHA-256 and complete assistant-answer SHA-256; changed DOM state fails with **no new request key, tab or Send**. A first manually instructed browser Send in a separate batch retains its existing explicit-command and SQLite authorization; these checks do not claim browser control is an OS-enforced sandbox. Tests inject changes between preflight reads and test invalid user/assistant hashes; live Chrome acceptance remains required.

A chained PI Mission has an additional first-Send guard inside the reservation transaction: its parent must still have a verified, unpaused continuing 32/32 checkpoint and reciprocal successor link, and its first Send must request a distinct new ChatGPT conversation. A raw CLI browser Send to the inherited parent link is rejected without creating a request key. The GMK parent→child 32/33 lineage and the first child destination/answer/PI decision were independently cross-checked in the production SQLite and Chrome; reverify the current chain before applying this conclusion to a later Mission.

`pi-evidence` independently validates browser migration attribution, not just a count of migration markers. Normal migration must carry a valid, distinct pair of hashed URLs and an already reserved request key that matches the immediately following observed response. A dangling or unrelated migration is an audit failure and cannot establish independent Chrome rollover acceptance. Recovered rollovers use their separate independently inspected recovery event. The report reveals only event identifiers and digests, not the conversation URLs or request keys.

For current 8→9 and prior Chat rollover autonomous Chat rotations, the read-only ledger rejects **broken URL-hash lineage**: once a first destination is known, the previous-URL SHA-256 of every next normal/recovered migration must equal that last recorded destination SHA-256. Previously, an unrelated but syntactically valid source hash could reset the observed chat-turn count without violating the migration's individual two-URL inequality. The first source Chat may be owner-provided and is not independently attested by an earlier migration event. Adversarial tests tamper with migrations and recovered rollovers; both must yield `migration_source_url_discontinuity`. This is a detection hardening, not proof of a real browser switch or faithful context inheritance; validate the live browser and linked reply separately.

The Windows **read-only restart preflight** now also checks locally marked READY PI Missions. This covers the short interval between Telegram accepting a task and the first browser Send reservation; its earlier active-only query would misleadingly report restart-safe during that interval even though the authoritative drain correctly rejected it. The script also treats an invalid browser receipt as an error, not a quiescent Send. The drain's atomic decision, not the preliminary script or a healthy Bot API heartbeat, is still the final maintenance authority.

When a new owner instruction arrives at an unsent chained child, the Telegram controller queues it against the child. PI reviews it using the parent's durable full-answer SHA and creates an auditable zero-turn preflight plan before first Send. Reconstruct uncertain first-new-tab requests using the *child's* persisted plan if it exists, falling back to the parent only when no revised child plan exists. A last-moment update before reservation triggers bounded local-only re-planning, not a repeated browser Send. A revoked exact build workspace prevents reservation even if PI inference started before revocation. Do not edit parent/child private receipts to force an acceptance.

The owner-authorized text-only two-stage post-fix test on 2026-11-05 used a **new Playwriter tab in the already pinned Chrome profile**, without external app tools or account writes. A stable first reply ending `NEXT` was automatically discovered as an existing conversation and adopted at zero Relay turns. Tool-free PI authorized one follow-up, whose exact latest user-prompt SHA-256 and final assistant SHA-256 were verified against the live browser. The second assistant response ended `DONE`, and PI separately committed one `DONE` plan and one final event. The Telegram event cursor advanced through the final event with no undelivered replies. A real maintenance-drain restart changed only the enrolled Telegram worker PID; the exact Mission event count, reply SHA, reserved request count, final PI result and both Telegram cursors were unchanged. The test tab was then closed through Playwriter and the authorized Chrome profile returned to its previous enabled-tab count. This confirms browser→PI→Bot API workflow and same-Mission restart idempotence, **not** phone UI display, ChatGPT tool-permission isolation or independent business outcomes. Keep exact URLs, private message text and the production SQLite database out of the public repository.

## Installation

### Read-only PI long-task diagnostics

**Bounded Goal continuation and remote PI defaults.** After the tenth
durably observed browser request an eleventh request must reserve a distinct
ChatGPT conversation, never an eleventh Send into the old URL. At 32/32,
only the settled PI LIMIT/NEXT/HANDOFF checkpoint may create one 0-turn
successor. For Goal-bound Missions, a *new* child additionally requires
an ACTIVE Goal with one remaining approved active work package. The
recovery scanner reuses an existing child, retains its Goal ancestry,
and never resumes a historical owner-paused or terminal task. A newly
arrived authenticated note to the completed 32/32 parent is atomically
deduplicated and assigned to the eligible successor for PI review before
its first Send. If Goal release acceptance is still pending, a model's
work-package PASS or a Mission terminal event is not Goal DONE.

The configured remote `pictl infer` adapter uses exactly `infer --project <approved>
--stdin --timeout 120 --json`, with no `--model`, provider or thinking
level options. Source-only, hash-only `pi.default_model_invocation_intent`
events show the invocation boundary and argument digest and explicitly
record absent overrides. They do **not** attest which default model the remote host
selected at runtime, or remote inference success. Preserve operator-set
remote model defaults; never pin one in the relay. Local fault-injection
and CI tests are not actual physical Chrome Send or GMK deployment evidence.

### Independent Goal release and no-in-flight finalization

**Software-version release and Goal completion are distinct processes.**
Use `software-release-status --sha <SHA> --run-id <CI_RUN>` for source
qualification on GitHub main. It requires three complete independent
platform CI receipts and no Goal, plan, PI approval, or SQLite database;
this is a read-only check and it never reports deployment success.
The separately fenced Windows promotion establishes runtime readiness.
Existing `goal-release-*` commands are retained for old Goal business
acceptance, but a Goal's missing 8→9 / prior Chat rollover / 32→successor witness is **not**
an impediment to verifying and shipping an otherwise qualified software
release. Do not migrate or overwrite historic Goal events to simplify
release reporting.

**Hidden Telegram worker console.** An enrolled Windows interactive-user
Scheduled Task may be switched to `-WindowStyle Hidden` using
`telegram-task.ps1 -Action HideWorker`. This validates the same owner SID,
interactive principal, one task and one Worker, fails on an active Mission or
unsettled Send, and changes only the future task action. An existing console
closes only after a separately gated `-Action Restart`; new task starts are
hidden without losing the interactive Chrome session. Do not use a Session-0
service or task `Hidden` metadata as a substitute for the process window flag.

`node dist/cli.js goal-release-matrix <goal-id>` is a **read-only** matrix
of all fixed release requirements and every original Goal acceptance
criterion. For each PI claim it attempts to match the claimed answer digest
to a real, Goal-bound request's original observation event and PI decision.
The output distinguishes these **attributed claims** from separate
independently verified `goal_release_checks`. An observed answer and a
work-item PASS never themselves establish successful business acceptance.
Unsupported requirements remain PENDING, never silently convert to PASS.
Keep original prompts/answers, Chrome URLs, raw SQLite and audit logs private.

Independent `criterion:<id>` receipts require an operator-owned, exact-SHA
mapping to a tracked executable test, the uniquely PI-reviewed original
request, and the named test's actual zero-exit PASS. They now explicitly
distinguish `answerOrigin=direct-browser` from
`answerOrigin=independently-recovered`. A recovered answer must retain the
original reservation, uncertainty (or verified dead-owner branch), matching
reconciliation event, and PI decision; its claimed answer digest or
`independentlyInspected` field alone does not authorize acceptance. Receipts
contain content-free original event IDs and observation hashes. Both the
operator mapping and original Goal/PI/request evidence must remain unchanged
during the independent test. Goal tab retirement similarly refuses a
different Goal identity, invalid source SHA, or changed physical Target
inventory before closing an original Relay-owned tab; a browser URL alone is
not ownership proof.

The normal independent release process is:

1. Inspect GitHub main and successful Ubuntu/macOS/Windows CI at the **same
   exact SHA**, GMK runtime provenance, complete Goal/PI request custody,
   bound original Chrome, safe Worker restart and connection-recovery
   receipts, old owner pauses, docs, and the work/acceptance matrix.
2. Allow the PI controller to finish and independently record every work
   item as PASSED and every associated criterion as PASS. Do not manually
   edit production SQLite or impersonate PI to change a status.
3. On the existing GMK node, `goal-release-target <goal-id> --sha <sha>`
   initializes the requirements only after all claimed work passes and
   GitHub main independently reads back that SHA.
4. `goal-release-verify` may independently record fixed source checks using
   the approved remote repository, or exact-head GitHub CI checks with
   `--run-id <run>`. The `gmk-production-readback` requirement additionally
   has a first-party, read-only Windows probe: it verifies the clean
   installed source/compiled manifest, original live Worker lease and
   installed interactive Scheduled Task identity, SQLite integrity, and two
   exact pinned-Chrome prompt/full-answer snapshots. It requires a fully
   delivered event-notification cursor and checks that Telegram input,
   notification and event cursors remain unchanged across both Chrome reads;
   new commands or events invalidate the observation. It refuses a running
   or owner-paused original request and records only hash-linked private
   evidence. The separate trusted 8→9 (prior Chat rollover; stable legacy gate ID `chrome-10-to-11`), 32→child, maintenance/restore,
   physical tab-retirement and independently executed per-criterion work
   probes exist, but each remains PENDING without its own original,
   complete, exact-SHA production witness. Never script a fake PASS.
5. The release is not ready while **any** Goal request is pending/uncertain,
   an observed response awaits PI review, or a Goal Mission is
   READY/RUNNING/VERIFYING. Wait for original settlement at an idle,
   quiescent checkpoint; never replay an existing request or pause history
   merely to pass the Gate. The final commit also fences future raw browser
   reservations for that completed Goal.
6. Only after every SHA-bound source, CI, production and criterion proof is
   independently PASS, unexpired, and the Goal graph is unchanged, run
   `goal-release-finalize <goal-id>`. It independently reads GitHub main
   again, verifies all receipts in an atomic SQLite transaction and
   writes the single durable completion record. The UI/model's
   `[MISSION_RELAY:DONE]` text is not an independent release receipt.

For ongoing operation retain the enrolled single interactive Windows
Scheduled Task, its original SQLite maintenance drain, the operator's
DPAPI-protected configuration, the immutable Mission/Goal event history
and the private upgrade backup/hash-chain log. For maintenance use the
enrolled `telegram-task.ps1 -Action Upgrade -ExpectedSha <sha>` only after
the read-only preflight returns success and all commands/notification
cursors are settled. An interrupted upgrade follows the task's exact-SHA
compiled rollback and SQLite backup workflow; never restore an older
database over a live newer one. Worker stalls require first rechecking
the lease owner, health, browser reservation and owner-pause flags, not
blindly launching a second worker.

For a schema-v5 Goal, `node dist/cli.js goal-request-ledger <goal-id>` is
strictly read-only and needs no Playwriter connection. It follows the
immutable Goal binding through each PI Mission successor, reconstructs the
Chat URL hash present at each reservation (including migrations), associates
the versioned work-item/PI snapshot, and reports the original reservation,
answer/recovery and PI decision event IDs. The latest unresolved reservation
is **pending**, not a verified Send or answer. `quarantineEventIds` reports
candidate answers rejected by the controller, while
`unattributedEventIds` exposes historical orphan observations needing
manual review; neither grants turn credit. `verifiedTabRetirementEventIds`
is a ledger-only provenance check, not independent Chrome closure proof.
Never use this report to reset, replay or resume an uncertain request, and
do not bypass the existing GMK maintenance drain. The report contains hashes
and UUIDs, not prompt text, answer text, request keys or ChatGPT URLs.

Run `node dist/cli.js pi-health` in the **existing GMK checkout** to see bounded, secret-free in-flight PI Mission IDs, observed browser rounds, current-chat 8-Send budget, PI decision/round, request reservation age and an explicit request phase. The same phase and request age appear in authenticated Telegram `/status [mission-id]`. `pi-health`, `pi-evidence` and `pi-chain-evidence` open existing SQLite schema **v3, v4 or v5** in **read-only mode with `PRAGMA query_only`**; Goal ledger and release-gate commands require **v5**. These diagnostics refuse unsupported schemas without creating or upgrading them. They do not attach to Playwriter, inspect conversations, read credentials, modify Mission records, send messages or start a second worker. The report omits owner goals, raw prompts, response text, browser URLs and Chrome identities. PI evidence reports may include SHA-256 digests and event IDs, never answer bodies. A `browser_answer_pending_do_not_resend` phase means a request is still reserved and its final answer **has not been credited**, not that the browser is frozen or that a resend is permitted. A healthy Telegram `getUpdates` heartbeat proves transport connectivity only. When the phase becomes `reconciliation_required_do_not_resend`, independently inspect the exact original request and browser answer before any acknowledged recovery. Do not bypass the existing channel-drain maintenance gate for deployment.

After a turn is credited, `node dist/cli.js pi-evidence <mission-id>` produces a content-free event correlation report. Use `rounds[].observedEventId`, `reservedEventId`, `answerSha256`, `decisionEventId` and `decisionShaMatches` to verify real ChatGPT → PI linkage. `chatSegments`, `maxObservedTurnsInOneChat` and `currentChatObservedTurns` expose any violation of the eight-Send-per-Chat ceiling; `pendingPiReviewRounds` is valid while PI inference is unfinished. `ledgerConsistent` only means no detected event-counter/hash violations, **not** that code, tests, deployment or business acceptance passed. Missing or ambiguous browser observations remain unresolved without the existing operator-confirmed recovery. This audit does not send new ChatGPT prompts or publish Telegram messages.

For a real 32-turn continuation, run `node dist/cli.js pi-chain-evidence <mission-id>` on the existing, idle-compatible GMK runtime. It traverses the parent and successor IDs and checks each source/child audit event and complete answer hash, the original scope, deterministic child request identity and the first child Send's new-chat migration. `chainConsistent=true` with `missionCount=1` is **not** evidence of a 32-to-1 rollover; require a verified parent/child link and a completed observed child Send. The command does not create Missions, connect to Chrome or send Telegram messages. Do not run newer compiled code inside an old live Node task or fast-forward the runtime before maintenance drain is safely accepted.

1. Use Node.js 24 LTS+ and run `npm ci && npm run build`.
2. The default browser-first workflow only requires an already authenticated Chrome ChatGPT tab with the official Playwriter extension explicitly enabled. **No native coding-agent account is required.** For optional Codex native execution alone, install `examples/executors/codex` independently (`npm ci --prefix examples/executors/codex`), use its own `npm run init --prefix examples/executors/codex` to create an isolated profile, then authorize that profile through the official `codex login` flow. See its dedicated README; do not paste tokens or copy cookies into Mission Relay.
3. Optional native executor plugins are independently installed trusted modules, registered with `plugin-register --path`. ChatGPT/PI/Telegram does not load them. Start with read-only missions in a throwaway Git repository.
4. Store state outside the public checkout: the default platform user-data directory or a private `MISSION_RELAY_HOME`.

On Windows, **do not run `npm ci` in a checkout while a Telegram poller or Playwriter relay is still using native binaries from that same `node_modules` directory**. `npm ci` removes installed files first; a loaded Sharp DLL may produce `EPERM` and leave an incomplete dependency tree. Check both process identities and in-flight Missions, then stop only the affected service or install in an isolated checkout. Never globally kill `node.exe`, copy a Telegram token into public scripts, start a second poller or blindly resend an interrupted ChatGPT request. If a prior install was interrupted, use a separately verified isolated worktree to repair or rebuild the deployment while preserving private SQLite state; confirm `channel-status`, `npm ls --depth=0`, `browser-watch-status`, Git status and the exact visible conversation before any new Send.

For an operator-enrolled interactive Windows Telegram task, use `scripts/windows/telegram-task.ps1 -Action Status|Restart` rather than asking the owner to repeatedly re-enter private credentials. The enrolled current-build task uses a local SQLite maintenance drain that atomically fences **new Telegram intake, browser Send reservations, and watched-chat adoption** before a cooperative restart; it waits for accepted work to settle. The drain does **not** freeze unrelated agents or connector side effects, and an older worker without cooperative support still needs a separate idle check. The task is **not installed automatically**, and it does not manage the separate Playwriter server. See [Telegram task lifecycle](telegram.md#optional-windows-task-lifecycle-requires-local-owner-enrollment).

Windows Task Scheduler `RestartOnFailure` is **not sufficient evidence of restart after an action exits nonzero**. Synthetic tests on the owner Windows host showed no retry for one-time manual or scheduled failure; a repeating trigger with `IgnoreNew` did recover. The same owner-enrolled task now has one daily, every-two-minute repeating trigger in addition to the logon trigger. **Critical v1.1.3 correction:** the daily trigger's `Repetition.StopAtDurationEnd` must be **false**; Windows' `New-ScheduledTaskTrigger` defaults it to true, which terminated the live GMK Worker at 00:04 on consecutive days, even while `Settings.ExecutionTimeLimit=PT0S`. Existing installs use `-Action UpgradeSchedule` to replace the unsafe existing trigger and verify unchanged Worker PID and a healthy trigger readback, not only to add a missing trigger. Do not stop or replay a protected Mission to repair a schedule. The isolated, secret-free acceptance harness is `pwsh -NoProfile -File scripts/windows/verify-task-restart.ps1 -StartMode Repeating`; it creates and removes its own temporary task. Avoid running the failure injection against the real Telegram task.

**Maintenance versus recurring trigger:** The every-two-minute recovery trigger
can restart the *old* compiled Worker between the initial drained stop and the
candidate checkout/build. On 2026-11-11 the Task Scheduler original event
`107` launched the old Worker at 09:06:02 UTC, and event `322` at 09:06:08
refused the explicit candidate start because `IgnoreNew` saw that instance.
The candidate's SHA attestation correctly failed and the automatic rollback
restored the prior healthy release. The reviewed `Upgrade` script therefore
rechecks and, if necessary, stops **only the enrolled recovery Worker under
the same held SQLite drain after candidate compilation, before candidate
start**. A later recovery trigger loads the compiled candidate, not stale
bytes. Tests must cover this race explicitly. Never bypass the SHA fence,
disable recovery on a live worker, or replay browser Sends to pass maintenance.

On this host, the periodic trigger can report `LastTaskResult: 0x800710E0` while the one allowed long-running worker is already active. With `IgnoreNew`, treat that result as a potential **ignored duplicate launch**, not as a health verdict. Inspect task state, the actual current PID and the fresh `channel-status.transportHealth` heartbeat together; investigate if the worker is absent or its Bot API polling is stale.

For deployed **new** CLI builds, `Restart` uses `channel-drain-request` and `channel-drain-release --id` for an SQLite-backed maintenance intake fence. Successful requests reject new Telegram command reservations and new browser Send reservations atomically, wait for the old poller to exit, then release the fence and start a fresh worker. An older already-running process will not cooperate and may need a one-time task-scoped stop after an idle check. **On the owner Windows host, both the older-build fallback and the subsequent new-build fully cooperative restart were accepted by real PID, SQLite cursor, fresh Bot API poll, and unchanged Playwriter listener readback.** Inspect `channel-drain-status` on interrupted management sessions; do not clear a live drain without verifying ongoing work. This does not orchestrate unrelated local CLI/native agents or prevent external connector side effects.

For live health, `node dist/cli.js channel-status` now reports `transportHealth` and `lastPollSuccessAt`. `pollerPresent: true` alone is insufficient, especially when Windows TUN is disabled. `transportHealth: healthy` requires a successful `getUpdates` from the **current lease owner within 90 seconds**; `starting` or `stale` warrants proxy/connection investigation. Task start/restart waits for `healthy` before reporting success. Avoid credential-bearing diagnostics or unbounded health logs.

After disabling a VPN/TUN on a host where Node HTTPS cannot connect directly, verify a local HTTP proxy with `curl.exe -x http://127.0.0.1:<port> https://api.telegram.org` and Node's built-in `--use-env-proxy` before changing the worker. The optional Windows task supports `-Action SetProxy -ProxyUrl 'http://127.0.0.1:<port>'` followed by an idle-gated `-Action Restart`. Inspect the new PID and its outbound loopback connection; neither process liveness nor public Telegram endpoint access confirms authenticated Bot API delivery. Do not set global `HTTP_PROXY` for unrelated processes.

Before running an **optional native** mission, use `node dist/cli.js doctor`. It checks the installed executor's `preflight` when provided; no coding-agent plugin is required for ChatGPT browser tasks. Preflight success is not proof of external tool isolation or model authentication.

For the separate optional Codex plugin, `MISSION_RELAY_CODEX_PROXY` supplies its SDK's HTTP(S) proxy setting. It does not modify Windows proxy or the standard verification environment. Other native plugins own their own network settings.

For the optional Codex plugin on Windows, `MISSION_RELAY_WINDOWS_SANDBOX=unelevated` is an opt-in fallback with **weaker sandbox isolation** than its default elevated backend. Native executor sandbox implementations differ; a generic `read-only` mission setting cannot certify third-party MCP/network tool restrictions.

## Deterministic verification

For an opt-in write-capable mission, explicitly supply `--checks-file /absolute/path/checks.json` when creating the mission. Format: `[ { "argv": ["node", "--test"], "timeoutMs": 30000 } ]`. Commands are executed from the mission workspace **without a shell** and with bounded timeouts. They are trusted *user input*, not generated by an AI response. They are not guaranteed read-only: project test scripts can modify files or services. Never configure production deploy, secrets manipulation or destructive tools as verification commands.

Model-only completion is still allowed for `read-only` missions, but should be treated as a model review rather than a deterministic proof. A write-capable mission with zero configured checks pauses instead of reporting completion. Writable Store openings migrate supported older SQLite schemas transactionally through the current schema v5; maintain a verified private recovery copy of critical state before deploying a new release.

## Recovery

**New Chat origin Send-button hydration (after the production #1177/#1178 incident):** A new tab can expose a visible composer before its Send control is enabled. After filling the originally reserved prompt once, Relay may wait up to eight seconds, checking only the same authorized empty `https://chatgpt.com/` origin for the visible enabled button. It does **not** press Enter or refill the prompt. A navigated tab, visible submitted user message or still-disabled button fails closed as an ambiguous original reservation. Inspect the exact new conversation before using the existing one-time `browser-recover-rollover` or, if it has no valid complete marked answer, the explicit `browser-reconcile` operation. Reconcile preserves the original event and consumes its request key without crediting a turn. It never authorizes replay or a fabricated PI PASS.

**Long-task browser transport handling:** `Connection interrupted. Waiting for the complete answer` is a *wait* state, not evidence that the original request failed. Preserve the tab and observe the original response. The default 60-minute browser window gains one bounded two-hour grace period, never exceeding four hours from Send; an explicitly shorter timeout is respected. An exact visible `Message delivery timed out. Please try again.` or `Error in message stream` plus one enabled platform `Retry` button authorizes an initial **same-message UI Retry only**, after checking the exact linked Chat URL and SHA-256 of the latest user request against its immutable SQLite reservation. Persist the intent before clicking. If that click completed but the original existing-chat request remains uncertain after observation timeout, the same enrolled Worker may perform **up to two additional independently persisted UI Retry attempts**, with at least two minutes between successful click receipts. A crash after an intent is consumed cannot trigger a blind repeat. Owner pause, unrelated Retry, changed prompt/tab, generating assistant, active drain, unknown failure or new-chat origin prohibit follow-up retries. Three failed clicks produce one durable owner-visible Telegram notification; the original unresolved reservation and source lock remain intact. A genuinely completed response after any Retry must independently match the exact original user, stable final marker, different assistant SHA from the previously credited reply and valid PI checkpoint before it is credited. No second composer Send, guessed answer, or fabricated progress is ever allowed. The `Show more`/`Show less` controls are excluded from authored prompt hashes. See [Playwriter evaluation](playwriter-evaluation.md).

**DOM read timeout versus submission failure:** A real production PI-controlled continuation became uncertain when Playwriter timed out reading an accessible `ChatGPT said:` reply node after Send. The current source retries **only** the exact `locator.innerText: Timeout ... exceeded` text-read error twice with a short delay after the Send, discards any partial stability candidate, and refuses repeated Send. Three consecutive failures or an unknown error still fail closed. A source-level synthetic one-time failure is recoverable, but this does not validate the historical uncertain request. The real original tab must be accessible with an exact last-user prompt and stable marked answer before `browser-recover-turn` can safely credit it. Opening a blank new tab at the same URL is **not** proof of that answer. Keep the original uncertain SQLite event and request lock until explicit recovery or reviewed reconciliation.

If execution stops or the process crashes, inspect `show` and `events`. When state is `NEEDS_RECONCILIATION`, inspect the workspace and actual external side effects before using `reconcile`. Reconcile does not replay the interrupted turn; it only permits a new, explicitly requested continuation.

Do not run multiple `run` commands for one mission. The database lease blocks parallel workers, but only one process should own the executor session.

**ChatGPT stream-error Retry control:** The Worker recognizes visible `Error in message stream` (optional trailing period) only in the same two-level DOM control group as its unique `Retry` button; generated text mentioning that error is not a valid control. A new-chat origin Send keeps only its initial one-shot UI Retry; the two bounded follow-up clicks described above apply to *uncertain existing-chat requests only*. `Connection interrupted` remains wait-only.

## Future remote control

Telegram remains an opt-in channel; see [Telegram setup](telegram.md). Without owner enrollment it runs in the foreground, with an optional enrolled Windows interactive task to start at login and recover from a bounded number of crashes. Playwriter remains a separate component. A running CLI **does not hot reload** after build: use a gated restart through the enrolled task, or stop/restart the original private foreground terminal. Do not re-send previously accepted `/continue`; compare `channel-status`, mission `show`/`events` and a read-only `browser-probe` before any new dispatch.
