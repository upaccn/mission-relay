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
