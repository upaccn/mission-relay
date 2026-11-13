# Operations

## Multiple-Goal production gate (v1.2.0)

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

## One-time reset before the first formal project

Only the authenticated owner may explicitly authorize a complete removal of
pre-production Mission and Goal history. This is a **destructive operational
reset**, separate from a normal software upgrade or Git history rewrite.
First qualify and deploy the exact SHA containing the reset implementation;
confirm one healthy enrolled Worker, an idle restart preflight and no pending
Telegram replies, browser reservations or unsent notifications.

On the original enrolled Windows interactive-user host, run:

```powershell
pwsh -NoProfile -NonInteractive -File scripts/windows/telegram-task.ps1 -Action ResetProjects -ConfirmResetProjects
```

The controller acquires the original SQLite maintenance fence, stops the
Worker and recurring recovery trigger, captures a verified private SQLite
backup and isolated restore, creates an empty database with the existing
schema, and copies only the Bot API inbox cursor, PI configuration, approved
build scope and Chrome launcher URL/profile. It does **not** copy old Mission,
Goal, plan, approval, browser request, audit event or command rows. Any
failure before admission restores the verified original state under the same
maintenance fence. The replacement must attest its exact installed source
SHA, unique Worker identity and healthy Bot API transport before the drain is
released. A source upgrade alone never triggers project reset.

After success, verify `channel-status`, `pi-health`, `list`, `/list`,
`PRAGMA integrity_check` and `PRAGMA foreign_key_check`; counts of
`missions`, `goals`, `events` and `channel_commands` must be zero. The
private backup contains the retired records for disaster recovery only and
must never be restored into normal production or committed to Git. The old
ChatGPT conversation URL is retained **only** as the approved browser launch
source; the Relay never sends into that conversation.

## One-time pre-fenced GMK migration (source-only implementation)

The observed deployed GMK release `df3044eb2dc787236391918c2b7730b9b9407b8b`
has an original, byte-identified CLI and Telegram module that **cannot**
restart while a maintenance drain is held and cannot perform verified atomic
drain release. Do not run the old checkout's `-Action Upgrade` as a substitute
for the current reviewed upgrade script. Normal future releases must continue
to use the existing fenced `Upgrade` path without `-LegacyMigration`.

The current reviewed script supports **only this particular old SHA** and
original compiled CLI/module hashes. It is staged into the private
`%LOCALAPPDATA%\MissionRelay\telegram-task` folder from the exact GitHub
`main` candidate, without editing GMK source before maintenance. The
`-BootstrapRoot` mode byte-compares itself to the Git object at that exact
candidate SHA. The bootstrap **does not grant maintenance access**: it
still requires a clean `main` checkout, the original enrolled single-Worker
task, exact source/runtime provenance, read-only restart preflight exit zero,
no pending requests or notifications, and the original atomic drain receipt.

For a separately authorized maintenance window, after independently verifying
the candidate's **own** GitHub main Node 24 CI, stage the source exactly once
on the GMK host in PowerShell 7 (without invoking the upgrade yet):

```powershell
$root = (Get-Location).Path # Run from the checkout root; do not hard-code a private host path
$sha = '<independently-verified-final-main-sha>'
if ($sha -cnotmatch '^[0-9a-f]{40}$') { throw 'Exact candidate SHA required' }
git -C $root fetch origin main
if ($LASTEXITCODE -ne 0) { throw 'Git fetch failed' }
$head = (git -C $root rev-parse refs/remotes/origin/main).Trim()
if ($head -cne $sha) { throw 'Candidate differs from GitHub main' }
$folder = Join-Path $env:LOCALAPPDATA 'MissionRelay\telegram-task'
$staged = Join-Path $folder ('reviewed-upgrade-' + $sha + '.ps1')
if (Test-Path -LiteralPath $staged) { throw 'Do not replace a staged bootstrap' }
git -C $root show ('' + $sha + ':scripts/windows/telegram-task.ps1') > $staged
if ($LASTEXITCODE -ne 0) { throw 'Cannot stage exact reviewed script' }
& pwsh -NoProfile -NonInteractive -File $staged -Action Compatibility -ExpectedSha $sha -BootstrapRoot $root -LegacyMigration
```

`Compatibility` is **read-only**; its positive result certifies only the
old compiled bytes, not an idle maintenance gate. After the original browser
Send is naturally settled and a fresh independent preflight passes, the
explicit one-time execution command is:

```powershell
& pwsh -NoProfile -NonInteractive -File $staged -Action Upgrade -ExpectedSha $sha -BootstrapRoot $root -LegacyMigration
```

After drain, the verified new Worker starts **inside** the original fence;
its SHA, one-PID lease, Telegram transport, SQLite rows and request hashes are
verified before its final atomic drain release. If the candidate fails,
rollback first restores the original clean Git HEAD, full hash-verified
compiled image and SQLite continuity **under that drain**. Because this
specific legacy Worker cannot start inside the fence, its recovery uses a
separately journaled **release-before-start** of the original drain token,
followed by *only* the enrolled old task and fresh Worker/version/health
checks. There is a short interval when Telegram updates may queue while the
Worker restarts; this path cannot truthfully claim the modern atomic fenced
rollback guarantee. If health cannot be verified after release, do not
automatically interrupt newly admitted work or replay requests: escalate the
explicit `legacy_rollback_drain_released` receipt for supervised recovery.
This mode is never enabled automatically or reused for a different old build.

A failed or incomplete legacy migration journal can **never** certify
the `maintenance-resume` ReleaseProbe. Only a completed, exact-SHA upgrade
with original backup, verified isolated restoration, compiled rollback bytes,
healthy replacement and finalized drain admission may PASS.

**Audited GMK upgrade evidence (candidate, validate on its own CI SHA):**
The Windows `scripts/windows/telegram-task.ps1 -Action Upgrade -ExpectedSha <sha>`
now creates a private `%LOCALAPPDATA%\MissionRelay\telegram-task\upgrade-audit-<uuid>`
directory **after** the idle preflight, and journals fixed, hash-linked,
durably flushed stage receipts. The sequence records the exact old/new SHAs,
read-only preflight exit 0 with notification/Worker cursors, the real atomic
drain receipt SHA-256 and drain-status readback, enrolled Worker stop, a
consistent drained SQLite `missions.sqlite` snapshot with integrity, counts
and SHA-256, **a separate `isolated-restore.sqlite` recovery using SQLite's
backup API before any source change**, whole-table equality, integrity,
foreign-key validation and an independently hashed `sqlite_restore_verified`
receipt. The release inspector verifies different native filesystem identities
for the backup and recovered database; a hard-link alias is not a separate
restore, even if its SHA-256 and table contents match. The entire original
`dist` rollback copy must independently match
the verified old Worker source/compiled JS tree and per-file hashes; the
`compiled_rollback_saved` receipt records that verified copy, not just its
location. The copy is retained under the restricted private audit folder at
`rollback/dist` after successful promotion (no longer deleted from a temporary
folder). The final independent maintenance ReleaseProbe re-opens both private
databases, compares all table rows and their receipt digests, and separately
re-hashes the retained compiled rollback tree, its complete file inventory,
old Worker provenance manifest and CLI bytes. Its atomic-drain witness also
cross-checks the preflight Worker PID, notification cursor, empty reply queue,
original drain identity and stopped Worker stage. Missing, altered or
inconsistent rollback/restore/drain evidence rejects PASS. Old journals
without a retained original image cannot be upgraded into valid evidence.
The sequence then records GitHub fetch, fast-forward-only pull and the checked
build manifest. The replacement Worker starts **behind the original drain**:
it holds the unique SQLite lease and checks Telegram connectivity without
dispatching/acknowledging new commands, running PI or sending to Chrome.
Only after its enrolled-task identity, new PID, startup-bound source/compiled
hashes, drained SQLite events, full Mission rows, browser request receipts,
integrity and foreign keys are verified does the script append the
`fenced_acceptance_verified` receipt and release the drain. ReleaseProbe
validation requires this **pre-release ordering**, not a post-release
`worker_healthy` claim. A failed candidate validation stops the fenced
replacement and restores the exact prior clean HEAD and byte-verified compiled
tree; recovery must itself pass SQLite and Worker validation before releasing
maintenance. A failed rollback verification **leaves the original drain held**
and requires operator recovery. Older installed Worker builds without fenced
startup support cannot reliably restart behind the drain during rollback;
`Assert-RollbackStandbyCapability` now checks the byte-verified old Worker
**before requesting maintenance**, rejecting the upgrade without stopping it
when this support is absent. The old compiled CLI must also support atomic
verified drain release, since rollback invokes that OLD CLI after restoration.
Legacy deployments therefore require a separately
reviewed, safe migration path before using this fenced protocol; never bypass
the pre-drain compatibility gate just to force the first promotion.
Immediately before final release, `channel-drain-release-verified` additionally
rechecks **inside the SQLite transaction that deletes the original drain**:
the exact lease PID and Worker source SHA, a successful Telegram probe no older
than 15 seconds, no newer failed probe (malformed failure metadata fails
closed), empty replies/notifications/active requests, and the original drain
token. The final transaction additionally matches the private lease-generation
fingerprint and previously verified runtime attestation, then samples the
actual enrolled Windows Scheduled Task and Worker process creation times
before deleting its fence. A recycled PID, stale attestation, ambiguous
equal-millisecond process birth, wrong parent or missing CIM identity must
leave the drain intact. The subprocess channel-status and channel-drain-status
commands open SQLite query-only so this readback can execute while the
transaction holds the write fence without an implicit schema write. A failed
atomic admission leaves the drain intact and goes through the
existing candidate-failure rollback. Both successful upgrade and verified
rollback use this atomic admission; ordinary idle task restart retains its
separate, original non-release drain command.
Any post-release uncertainty must not interrupt newly admitted work merely to
retry a rollback. Optional precisely gated PI resume is a separate action.
When an owner-approved `-ResumeMissionId` is supplied, the original physical
Chrome binding is inspected **inside the pre-release fenced validation**;
missing or nonexclusive binding causes rollback without invoking `pi-resume`.
The original revision-gated PI resume runs only after verified drain release,
not before the source and physical Chrome evidence pass.
The journal is private: neither a drain credential nor a ChatGPT request key,
answer, full URL, Telegram token or owner message is published. An incomplete
journal or failed build remains evidence of a failed or partial promotion,
**not** authorization to bypass the drain or replay a request. Never backfill
historic journal entries for older deployments.

**Trusted v1 ReleaseProbe ownership (code-linked):**

| Requirement | Existing first-party implementation | Raw evidence needed for PASS |
| --- | --- | --- |
| Chrome tenth → eleventh Send | `goal-release-chrome-probes.ts`, `goal-release-chrome-history.ts` | Per-rollover original reservation, both physical Target/prompt/answer witnesses, new Chat URL hash and PI decision |
| Mission 32 → successor | `goal-release-successor-probe.ts` | Exactly 32 committed parent turns, reciprocal zero-turn child, immutable original child request, physical successor witness and independent child PI review |
| Tab custody/retirement | `goal-release-chrome-probes.ts` | Original controller retirement event, before/after physical tab inventory and owner-tab preservation |
| Maintenance/recovery | `goal-release-maintenance-probe.ts`, `telegram-task.ps1` | Hash-linked original drain, restored SQLite snapshot, original compiled rollback bytes, fenced Worker/SQLite validation and live Chrome readback |
| Independent acceptance | `goal-release-work-probe.ts`, `goal-release-remote.ts` | Operator-owned criterion/test mapping, original PI-reviewed request and actual SHA-bound test execution receipt |

All five inspectors already exist, including the **fenced upgrade and
rollback evidence checks**; none is a model-to-PASS shortcut. The
production adapters require matching compiled target SHA and original state.
Chrome ten-to-eleven, successor, tab retirement and maintenance/recovery
inspections additionally require a live, enrolled single Windows Worker
whose SQLite channel lease, PID, compiled tree/CLI/manifest, Telegram
notification cursor and task identity agree with the target SHA both before
and after evidence inspection. The independent read-only operator CLI has
its **own PID**; it verifies the distinct enrolled Worker rather than
impersonating that process. The maintenance inspector also uses its own
`maintenance-readback` source, not a generic Chrome-only evidence source.
A standalone matching checkout without a healthy enrolled Worker, stale
heartbeat, changed Worker or model-reported success cannot produce a
production adapter PASS. Inspection receipts include their exact scenario,
expected/observed outcome and verified runtime identity. Independent
criterion receipts bind the approved original answer and authenticated SSH
test-execution session instead of claiming a Windows runtime observation.
These checks do not invoke maintenance or browser Send;
isolated synthetic tests cannot grant a production Gate PASS. Every real
10→11 (plus prior Chat rollover), 32→child, tab, recovery and business criterion still requires its own
unfabricated physical/execution evidence for the deployed exact SHA.

Each generated private trusted-probe inspection receipt now identifies the
`requirement`, exact `targetSha`, `expectedOutcome`, `observedOutcome` and
`evidenceProvenance`. Content-addressed raw witness, audit, test or live
readback digests remain in the same receipt. These outcome fields are written
**only after** the source-specific validator succeeds; an absent original
observation, missing independently reviewed request, or contradictory record
cannot be converted into a PASS by supplying these fields in an external file.

`npm run build` now emits untracked `dist/build-provenance.json` describing
the exact checkout HEAD and SHA-256 tree digest of **every compiled JS file**.
The single actual Telegram Worker verifies this manifest against its compiled
entrypoint, the installed JS tree, a clean Git checkout and HEAD at startup.
Only the process holding the real SQLite channel lease can atomically record
`telegram.runtime_provenance`; `channel-status.runtimeProvenance` returns it
only while the original lease PID and lease-key digest still match. A separate
diagnostic CLI cannot overwrite the proof. This ties a local, verified build
identity to the Worker that owns the polling lease; it is not hardware/remote
attestation of immutable in-memory bytes. A newer source SHA requires its own
GitHub `CI` push/main Windows/macOS/Ubuntu success before a future promotion.
Local build or a successful old SHA is insufficient. An active Send always
blocks maintenance even if the current compiled/runtime identity is healthy.

**First audited promotion from an older installed script:** Once the new
commit and exact-SHA CI are verified, `git fetch origin main` on GMK may
obtain its commit object **without checking out or modifying** the active
runtime. The audited version of `scripts/windows/telegram-task.ps1` can be
extracted from that *exact* commit to an owner-private temporary path and
invoked with `-Action Upgrade -ExpectedSha <new_SHA>
-BootstrapRoot <existing_GMK_checkout>`. The script's existing
`Assert-ReviewedBootstrapScript` byte-compares its own file to the fetched
commit before any maintenance action and still checks the registered original
task path. Do not replace the enrolled Worker script while it is running,
invent a new upgrade helper, use a different task identity or invoke this
bootstrap unless the target SHA has passed its own CI. Once activated, future
upgrades use the installed canonical script without a bootstrap. When the
existing owner enrollment specifies a local `http://127.0.0.1:<port>` proxy,
the Upgrade process routes only its GitHub fetch/pull through the matching
`socks5h://127.0.0.1:<port>` listener by process-scoped `GIT_CONFIG_*`
environment variables. No system or repository proxy settings are changed,
and an unavailable or malformed proxy must fail before unsafe promotion.

For recovery, keep the final private SQLite snapshot, its hash, the old
reviewed HEAD, the retained private compiled rollback image and the journal.
A failed upgrade can only restore the previous HEAD/verified compiled `dist`
under the script's existing controlled rollback.
If that check fails, the drain must stay held; do not launch an unverified
Worker. A later source rollback requires a reviewed operator-managed host revert or fix,
new GitHub main/CI and another safe pull-only Upgrade, not a Windows local
reset. Restoring SQLite from a historical snapshot requires first preserving
the latest live database/WAL/SHM and accounting for all subsequent events;
never overwrite active data to reconstruct a missing receipt.

**Worker restart and recovery classification (2026-11-08):** There is one
owner-bound, interactive Telegram Worker, monitored by the existing Windows
repeating Scheduled Task (single-instance IgnoreNew). A crash between an
observed answer and a PI decision can be recovered only through the existing
single-controller SQLite scan and independent, read-only exact Chrome
prompt/answer recheck. A crash with an original Send still `reserved` or
`uncertain` is not proof the Send failed: preserve the original request,
block re-send, and use the documented guarded original-response recovery
only when the same authorized tab supplies independent evidence.

**One-shot, target-scoped PI recovery connection drill (source capability):**
`node dist/cli.js pi-drill-status <mission-id>` is a read-only inspection.
`node dist/cli.js pi-drill-connection <mission-id> --revision <current>
--ttl-seconds 90 --acknowledge-side-effects` is a local, explicit operator
action, **not** an instruction to send a prompt, kill a Worker or disable
Chrome networking. It only arms a previously observed/reconciled, unpaused,
error-free, nonterminal PI Mission at a PAUSED checkpoint when **no Mission**
is RUNNING/VERIFYING and the Telegram maintenance drain is absent. It refuses
a stale revision, repeated arm, exhausted Mission, owner pause or active Send.
The marker binds one original request key, prompt and answer SHA-256, Chat URL
hash and pinned Chrome-profile hash and expires automatically after 5–120
seconds. The normal controller must first connect to that **exact original**
tab in the pinned profile. Only then may it consume the marker transactionally
and close its own newly acquired Playwriter recovery client session using the
adapter's non-tab-closing `close()`. No browser tab, extension permission,
network adapter, unrelated session or original request is touched. Next
recovery uses the normal persisted request-bound Chrome retry/backoff and a
fresh independent session, without repeating Send. Private append-only
`pi.recovery_connection_drill_armed`, `..._triggered`, and
`..._client_closed` distinguish intent, consumption and an acknowledged
connection close; an unacknowledged close is **not** proof of disconnection.
The lack of a `..._client_closed` event, a marker that expired without trigger,
or failed source tests cannot be described as a live successful drill. This
tests a **client-session disconnect**, not a host-wide network outage. Run it
on a qualified deployed Worker only when a genuine settled checkpoint and
the maintenance gate allow it; an active `reserved` new-chat Send is not a
safe point. The arming marker is strictly one-use and passive expiration needs
no Worker, daemon or scheduled cleanup.

Narrowly classified temporary PI inference failures and read-only Chrome
connection/timeout failures after the same settled answer share the durable
keys `pi.retry.request.<mission>`, `pi.retry.sha.<mission>`,
`pi.retry.count.<mission>` and `pi.retry.after.<mission>`. An append-only
`pi.autopilot_retry_deferred` or `pi.browser_read_retry_deferred` event
identifies the cause, exact original browser request, full assistant SHA,
attempt and next eligible time. Delay doubles from 60s to a 15min ceiling;
a different original request with even identical answer text resets the
counter. The read-only `pi-health` phase
`pi_browser_read_retry_deferred_no_send` means only a later **read-only**
browser check is scheduled; it is not permission for another Send or
GMK deployment. The retry ledger persists through Worker and SQLite reopen.
No separate polling daemon, Worker or browser replay is introduced.

Invalid/mismatched Chrome evidence, missing browser authorization, a manual
pause, a terminal PI BLOCKED or an unreconciled request is not a transient
failure. Preserve all evidence and stop automatic dispatch until the
original binding/permissions are independently restored and the existing
authorized recovery pathway is applicable. Do not reset `last_error`,
revise old PI decisions or migrate old BLOCKED Goals automatically.
For **new** Goal work reviews, ordinary test/build/CI failures must retain a
scoped FAIL/PARTIAL repair or REPLAN; terminal BLOCKED requires a typed
external barrier, PI-reported evidence and a concrete release condition
in the append-only Goal and PI audit. This classification still does not
constitute independent evidence that the external blocker exists or has
later cleared. Existing Goal release criteria remain fail-closed.
After two PARTIAL/FAIL reviews of an equivalent normalized acceptance
obligation, the controller rejects another editorial PARTIAL/FAIL before
committing PI NEXT. PI must use a genuinely new evidence-acquisition REPLAN
or PASS supported by newly observed evidence. Renaming an equivalent work
item cannot reset this audit budget; SQLite persists it across restarts.
The guard also applies when selecting work after a different package passes,
so deferring an exhausted equivalent acceptance behind another item or
dependency cannot silently authorize another browser Send. It rejects the
entire attempted PI decision transaction without changing the original
settled browser observation; PI must explicitly replan evidence acquisition.
Non-convergence does not invent a terminal external BLOCKED reason.

**Normal PI review checkpoint vs. an actual stalled Mission:**
`finishChatBrowserTurn` atomically changes a verified `RUNNING` browser
request to `PAUSED` with its **one** `chatgpt.browser_observed` event and a
complete answer SHA. For a PI-managed Mission with `stopRequested=false`
and no `lastError`, this can be the normal, *temporary* checkpoint awaiting
PI's own decision, not an owner pause or an automatic-resume failure. The
controller must commit a `pi.decision` for the **same round and answer SHA**
before `NEXT`/`HANDOFF` can reserve one *new* browser request, which changes
the Mission back to `RUNNING`. Recheck `pi-evidence`, `pi-health`, exact
Goal↔Mission binding and adjacent append-only event IDs before intervening.
Never manually call `resume`/`pi-resume`, clear stop/error metadata, invoke a
second PI controller or re-send an existing reservation merely because an
intermediate status read showed `PAUSED`. A pending original Send, owner
pause, denied workspace approval, terminal PI decision, wrong visible
user/answer SHA or historical interrupted checkpoint still fails closed.

**Settled-answer PI inference retries (2026-11-08):** An explicitly classified
temporary operator-managed host PI inference timeout, transport disruption or invalid model
response after a durably observed browser answer records an append-only
`pi.autopilot_retry_deferred` event and SQLite backoff for that exact answer
SHA (60 seconds, doubling up to 15 minutes). `pi-health` reports
`pi_inference_retry_deferred_no_send` during this delay. On the existing single
interactive Worker, the next eligible recovery pass first re-opens the original
pinned ChatGPT conversation *read-only*, checks the exact last user prompt
and full assistant-answer SHA, and only then repeats PI inference. No browser
Send or new conversation is authorized by the retry itself. Evidence mismatch,
access denial, owner pause, an uncertain or still reserved Send, or a previously
interrupted historic Mission is **not** eligible. Do not clear SQLite errors or
retry timestamps to force dispatch; a passing source test is not live GMK
deployment or independent Goal acceptance.

**PI capacity-busy interruption and recovery (source behavior; independently verify installed SHA):**
An exact `pictl infer` SSH exit 2 whose structured error is
`Pi maintenance or a global task is active` means the operator-managed host PI global
execution slot was occupied, not that the ChatGPT Send failed. New controllers
classify ONLY this exact typed response as `RetryablePiError`, deferring the
**same observed answer** through the existing SQLite-bound 60s–15min PI
backoff; the original browser Send is never replayed. Other exit-2 messages,
owner stops, tampered Chrome answers and lack of project approval stay blocked.
The currently installed old Windows controller could instead persist the
capacity refusal as `pi.autopilot_interrupted` with `lastError`, permanently
excluding the otherwise settled Mission from automatic recovery.

For **only that recorded old-controller capacity failure**, once a qualified
new source has been safely installed, use the *operator-only*, no-Send command
`node dist/cli.js pi-recheck-capacity <mission-id> --revision <current>
--acknowledge-side-effects`. It requires no owner stop, active drain or in-flight
request, the original exact `chatgpt.browser_observed` →
`pi.default_model_invocation_intent` → `pi.autopilot_interrupted` chain,
matching prompt/reply hashes, unchanged Goal and local project approval.
Before any SQLite mutation it twice observes the **same pinned physical
ChatGPT page**, its latest original user-prompt SHA and complete final-marked
answer SHA. An attested match atomically appends
`pi.autopilot_capacity_revalidated` and clears ONLY the historical `lastError`;
it does not create a PI decision, release an owner pause, reserve a Send,
retry a browser click or switch models. The existing single Worker must
perform its own fresh browser check and then retry PI; on renewed global
capacity contention the durable backoff handles it without manual recovery.
A missing tab, malformed event chain, mismatched SHA, changed Goal, stale
revision or any owner stop must fail closed and keep the original error.

**Atomic, explicit Windows pull-only promotion (new):** After a cooperative
owner pause has settled its original browser Send, and after exact GitHub
`main` SHA plus matching three-platform CI have been verified, the existing
enrolled interactive-user task supports `-Action Upgrade -ExpectedSha <sha>`.
The upgrade coordinator itself may run in a remote Session 0 because it
never launches Chrome; it verifies the existing Scheduled Task uses an
interactive-user, limited-privilege principal. The Worker *must* run in
Session 1 or another interactive desktop session and refuses Session 0.
If the owner-paused Mission should continue after promotion, add
`-ResumeMissionId <uuid>`. This action is intentionally **not** scheduled: it
rejects a still-running Mission or reserved Send, acquires the existing
SQLite maintenance drain, waits for the single task to exit, then fetches
only `origin/main`, rejects an unexpected commit or non-fast-forward, pulls
and rebuilds without destructive `npm ci`. It verifies the replacement
worker's successful Bot API polling and changed PID before any optional
`pi-resume` (which itself validates exact observed evidence, revision and
workspace approval). Only a verified clean rollback may restore the prior
Git HEAD and backed-up `dist` on failure. Failed rollback leaves the drain
held, with no new worker launched, for explicit repair. It neither migrates
private SQLite nor sends a ChatGPT message; CI and tests cannot replace a
real GMK task/Chrome/readback acceptance.

**Compact cross-Chat handoff (source enhancement, not a live acceptance claim):**
The controller retains the full owner goal, validated execution scope, PI's
at-most-1000-character evidence summary and next directive, but passes no more
than 800 characters of the previous assistant answer into the new ChatGPT
conversation. PI-managed rotations additionally carry the exact reviewed
round and full-answer SHA-256. This is a correlation receipt, not proof of
repository changes: independently recheck Git HEAD, CI, and runtime after the
new Chat binds. PI receives the full source answer while reviewing that turn;
SQLite retains the exact SHA-256 and bounded excerpts, not the full transcript.
The source ChatGPT conversation remains the full transcript. For a pre-upgrade
uncertain new-tab reservation, the **read-only manual** rollover recovery path
compares the reconstructed compact prompt's SHA against the original request,
then also permits the previous legacy format only when its exact SHA matches.
Neither format replays a browser Send. A Windows Scheduled Task worker in
Session 0 is rejected before loading credentials or running Telegram; operate
the existing user-bound interactive task, not a service-launched browser.

**New-chat intent vs. observed result:** The read-only `pi-health.browserNewChatReserved`, `pi-evidence.pendingNewChatReservation` and authenticated Telegram `/status` distinguish an unresolved *new-conversation reservation* from an ordinary same-chat continuation. They never certify an actual new tab, URL migration or final answer. A browser page that appears complete while its original observer has not committed the receipt remains in-flight: do not replay, replace its request key, restart the active controller or bypass the maintenance drain.

**One-shot pre-Send new-chat origin-navigation recovery:** A narrowly scoped operator-only `browser-retry-pre-send-rollover <id> --revision <exact> --acknowledge-side-effects` exists for the **specific** historic `page.goto: Timeout 30000ms exceeded` while navigating a freshly created tab to `https://chatgpt.com/` with `waitUntil: domcontentloaded`. In the reviewed `submitNewChatTurn()` source, this is the very first action: no composer fill or Send click has yet occurred. This exception does **not** apply to a Send-click timeout, response timeout, wrong source prompt, unknown navigation failure, still-owned reservation or an unseen original conversation. The original Mission must be `NEEDS_RECONCILIATION` with exactly one original `uncertain` new-chat reservation, its exact private versioned prompt snapshot and single source URL lock, one coherent preceding PI-reviewed five-turn Chat segment, unrevoked scope and no owner pause or maintenance drain. The CLI re-reads the pinned previous user/assistant SHA twice, inspects enabled Chrome tabs for an existing matching original prompt, and **first** loads an operator-owned blank ChatGPT tab read-only, checking hydration without filling the composer. If this preflight fails, close only that new unsent tab; the original uncertain receipt stays untouched and no one-shot intent is consumed. Only then atomically append `chatgpt.browser_pre_send_retry_intent` against the **original** request key and original prior observation. From this point there is **one possible** first actual Send, using the same private prompt on the already prepared blank page. If a complete terminal-marked answer appears, `recoverObservedBrowserRollover()` atomically credits the original request, retaining the original uncertain event and complete historical audit; the sole Worker must still PI-review it before another round. If the Send, observation or settlement becomes ambiguous, do **not** run this command again: the existing one-shot event forbids it. Inspect the resulting actual new URL and use the ordinary **read-only** `browser-recover-rollover` command if that original message demonstrably completed. A newly created URL is never invented or inferred from an origin load. The Chrome extension only inventories its own enabled tabs; unexposed tabs cannot be used as proof of absence. This exceptional path is not a generic Retry API and must never run automatically on a network timeout.

**Misattributed, already-credited PI answer recovery:** If an old ChatGPT browser observation was credited to the wrong assistant turn, do **not** manually edit SQLite events, reset the current request key, rerun that prompt, or trust `pi-evidence.ledgerConsistent` alone: old paired browser/PI SHA values can agree with each other while both point to the *wrong* answer. First review the original Mission's `pi-evidence`, the exact linked Chrome conversation and the active production Send inventory. Only after a stable complete latest answer with the original reserved **latest** user prompt can be independently reproduced, run `browser-correct-attribution <id> --revision <current> --acknowledge-side-effects` on a qualified runtime. The command sends nothing and appends a one-shot `chatgpt.browser_attribution_corrected` event referencing the original observation and PI decision; it updates only the active checkpoint hash/summary and marks PI re-review pending. The original browser and PI events stay in SQLite. `pi-evidence` shows the old and corrected hashes and rejects the correction as complete until PI records `pi.decision_attribution_corrected`. After a controller restart, the PI recovery path independently re-reads the corrected full answer before any future Send. If the exact original tab, user prompt, answer or revision is unavailable, leave the Mission PAUSED and start a separately authorized fresh Mission to continue outstanding business, never forge a seventh-turn receipt. A test-passed source implementation is not a live correction or safe production deployment.

The correction additionally refuses to modify SQLite if its original `chatgpt.browser_reserved` event is missing, duplicated or has a different prompt hash, if the original `pi.decision` SHA is inconsistent, or if reservation/observation/decision IDs are out of chronological order. These pre-commit checks are separate from independent Chrome evidence and from the post-write `pi-evidence` audit; none authorizes bypassing the existing maintenance gate.

**Bounded safe preflight:** Connection acquisition and DOM transcript checks performed *before* PI continuation reservations now have a 30-second deadline. Failure leaves the last observed checkpoint, original request and browser link untouched; the PI controller logs its interruption for evidence-based recovery. If a connector resolves after the timeout, only that acquired session is closed (no tab navigation or Send). The deadline must not be applied around the actual browser Send/Retry or a PI model call. Do not misinterpret a timeout as proof that ChatGPT never processed a prior request.

**Corrected checkpoint followed by NEXT:** A legitimate eighth-round reserved request replaces the completed seventh-round corrected browser receipt. The independent `pi-evidence` reader must follow the original append-only correction and PI re-review events, then attribute the later active `reserved` request to its *own* event and prompt hash, ordered after that corrected NEXT/HANDOFF decision. It does not compare a pending answer to the preceding correction or count the reserved request as an observed turn. Mismatched event linkage still fails closed. The running production Send continues to bar maintenance; do not use this read-only diagnostic fix to justify a restart.

**Ambiguous Send-click and missing exact tab:** On original ChatGPT Mission `c3574261…`, eighth-round reservation #318 completed as observed #319, with PI NEXT #320. Ninth reservation #321 subsequently yielded uncertain #322 after the Playwriter Send button `locator.click: Timeout 10000ms exceeded`. This is an unknown external side effect, **not** proof no Send occurred. An independent pinned Chrome inventory exposed another ChatGPT URL but not the original Mission's linked URL. Use `browser-binding-health <mission-id>` on an activated build to diagnose exact-tab exposure and (when available) the current user SHA; it does not infer whether the tab is closed, navigated or extension-disabled, and it never reads unrelated chats. Do not bootstrap a replacement, replay #321 or reconcile without separately verifying its exact original response and operator acknowledgement. Maintenance preflight returning zero on an already uncertain receipt does not itself establish that the external message was never submitted.

**Dead-owner reserved Send (manual, no replay):** A worker can exit after the original browser Send but before it writes an uncertain event. The old SQLite record can remain `RUNNING + reserved`; it is *not idle* and maintenance must continue to refuse a restart while the owner is alive. On the qualified source build, `pi-health.phase=dead_owner_reserved_inspect_only_do_not_resend` identifies only a **same-host definitely exited original owner PID** for a same-conversation Send; unknown/foreign/alive owners and new-chat reservations remain blocked. If the exact pinned ChatGPT conversation still contains the original latest user prompt and a stable, complete final-marked assistant reply, `browser-recover-turn <id> --revision <current> --acknowledge-side-effects` can append a single `chatgpt.browser_turn_recovered` event **without inserting a fictional uncertainty event, resending, rewriting the original reservation or incrementing more than one turn**. It rejects stale previous-assistant bytes, missing final markers, wrong prompt/SHA, broken original lock, and invalid revisions. The new PI review of that receipt is still required; model-provided DONE never substitutes for independent business acceptance. A live `RUNNING + reserved` Mission with a displayed *unmarked* reply must be observed by its existing controller, not manually credited or retried. The other recovery path for an abandoned fresh-chat reservation requires distinct URL evidence and remains separate.

**Dead-owner first Send into a NEW Chat (qualified later source build only):**
When the original same-host Worker PID is definitely exited and the immutable
new-chat reservation remains `RUNNING + reserved` without an uncertainty
event, `pi-health.phase=dead_owner_new_chat_reserved_inspect_only_do_not_resend`
identifies only an inspect-only candidate. The operator CLI
`browser-recover-rollover <id> --revision <current> --new-url <exact new ChatGPT conversation URL> --acknowledge-side-effects`
accepts a strictly independently inspected recovery candidate. The linked
prior Chat must still be uniquely connected, the original prompt must
reconstruct to the exact reserved SHA, and the distinct new Chat must show
the exact latest user prompt plus the same complete, final-marked answer on
two stable observations. The store atomically revalidates dead-owner custody,
original reservation, hash, live source lock and destination exclusivity;
it appends `chatgpt.browser_rollover_recovered` with
`recoverySource=dead-owner-reserved`, adds ONE credited round and releases
only the original source Chat lock. No second Send, invented uncertain event,
recreated Mission or resumed PI decision occurs within recovery. Existing
owner pause remains effective. A live/foreign/unknown PID, changed reply,
missing original source Chat, invalid prompt, already spent key or failed
audit insert means **no recovery**. The existing uncertain-rollover path
remains separate. If the Worker is still alive, leave its Send untouched
even if the browser displays a complete answer; do not hot-swap its code,
skip the SQLite drain or force a timeout. A dead-owner reserved Send also
continues to block maintenance until original custody is safely settled;
an older GMK runtime without this path cannot claim its tests as a live
recovery.

**Cooperative PI maintenance pause and return:** The existing local `pause <id>` on a RUNNING Mission only appends `mission.pause_requested` and sets `stopRequested=true`; the current original browser Send remains owned by the existing worker and must be allowed to settle under the same request key. Neither that pause event nor an idle Telegram Bot API heartbeat permits Windows deployment. Re-run the exact SQLite restart preflight until it returns success and inspect browser/PI event cursors before draining/restarting the *existing* Scheduled Task. After an eligible observed reply, the Mission stays PAUSED with its original full hash and original pause flag, and no new PI step is dispatched. Following a verified deployment, generic `Engine.resume` and CLI `resume` explicitly **refuse PI Missions**, because changing PAUSED to READY would break exact-checkpoint recovery. Use the new local-only `pi-resume <id> --revision <current> --acknowledge-side-effects` instead: it atomically appends one `pi.pause_released` event, changes only the pause flag/revision, and leaves the exact recorded answer and PAUSED state intact. On its normal poll the single Telegram controller independently re-reads the pinned Chrome last user-prompt and full assistant SHA before asking PI to decide any remaining work. Stale revision, active Send, missing/uncertain receipt, no remaining turn budget, terminal PI decision, unresolved error or revoked build approval are refused without effect. If the original Send is uncertain, manual reconciliation **preserves** the stop flag and does not manufacture turn credit; full evidence recovery must precede an eligible resume.

**Historical successor false-mismatch repair (only after the fixed runtime is deployed):** A successor's first unsent turn inherits the parent's last observed checkpoint, but **all later turns must be checked against that successor's own most recent observed receipt**. A previous controller version mistakenly compared a settled successor reply to its parent's distinct final reply after a Worker restart. If and only if the child is PAUSED with `stopRequested=false`, the exact recorded error `PI recovery refused: current Chrome user/assistant turns differ from the last durable receipt`, and an already observed/reconciled child request, use the local operator-only `node dist/cli.js pi-recheck-successor <child-id> --revision <current-version> --acknowledge-side-effects`. This command connects to the **existing bound Chrome tab**, verifies the latest original user prompt and complete terminal-marked assistant reply **twice** against their separate durable SHA-256s, and atomically clears only that known false interruption under the expected Mission revision. It appends `pi.autopilot_checkpoint_revalidated`, never changes a pause flag, sends a message, credits a turn or fabricates PI review. The original single Worker then independently rechecks the browser a third time before PI review and any subsequent Send. The command refuses missing browser access, changed user or assistant content, other error types, a still-paused owner, inactive Goal, incorrect scope or stale revision. Never use it to recover a genuinely changed browser history or a reserved/uncertain Send.

**Maintenance notification gate (source fix):** In addition to Mission states,
original reserved Sends and undelivered `channel_commands`, a restart must
not proceed if the initialized `telegram.notifications_cursor` is behind the
current maximum SQLite event ID. The worker must finish scanning the pending
events; an observed answer or pause event alone is not proof that its Telegram
notification has been processed. Both the read-only Windows preflight and the
transactional channel drain enforce this rule. Missing notification cursor
means a not-yet-initialized channel (first poll baselines existing history),
while malformed or future cursors fail closed. Preflight logs only blocker
counts, never owner goals, raw events, browser URLs or credentials. Do not
pause an already-in-flight `/build` merely to obtain a successful preflight:
cooperative pause is a separate deliberate operational act that must allow the
original Send to settle, and subsequent `pi-resume` needs exact evidence.

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

The trusted Chrome 10-to-11 ReleaseProbe requires an independently captured
physical source/destination witness for **every** Goal-bound tenth-to-eleventh
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

The controller's ten-Send rollover check is backed by the same SQLite transaction that reserves a request key: an eleventh request directed at the unchanged conversation fails **before** an external Send. An explicit new-tab reservation records its intent, and an observed answer cannot be credited until that reservation migrates to a different direct ChatGPT URL. After a crash or browser disconnect, do not bypass the ceiling by issuing a raw `browser-send` into the old conversation or by reconstructing a different prompt for an uncertain new-tab Send. Inspect the original reservation and use exact-prompt supported recovery only.

**Relay-owned tab retirement after successful handoff:** Playwriter's connection deliberately sets `closeTabsOnEnd:false`; otherwise connection cleanup could close a verified active destination or a user tab. To reduce the cost of repeated long-task handoffs, the continuous PI and browser-drive controllers separately remember only new tabs they themselves opened. Following a *later* fully observed, atomically committed destination, a bounded best-effort cleanup closes the previously created superseded tab, provided its URL still matches the old approved ChatGPT conversation. Never close the user's initial tab, the newly active tab, or a page whose URL changed. A browser-close exception is logged without changing the durable answer or authorizing a resend. No global tab sweeper, profile takeover, or cross-process ownership inference exists. Test coverage uses distinct synthetic tabs, consecutive handoffs, thrown close, and changed URL. A previous GMK Chat rollover was observed, but this is not evidence for a current 10→11 release; **Chrome memory reduction remains unmeasured**, and a stored tab-retirement receipt alone is not physical closure evidence.

PI rotation performs the source transcript exact-SHA check twice: first before choosing the next action, then in `executeBrowserRollover` immediately before reserving the new-tab Send. The second check receives the last durable user prompt and full assistant answer digests, so a changed source after the earlier browser read cannot authorize a fresh Send. An explicit test changes the source assistant response between those reads; it must fail with **zero new reservations and zero new tabs**. This test does not replace observing the actual tenth-to-eleventh live handoff on GMK.

Ordinary PI `NEXT` into the same existing ChatGPT conversation now performs the analogous second source-hash verification in `executeBrowserTurn` immediately before SQLite reservation, covering a human/browser change during PI planning. Sequential `browser-drive` batches likewise recheck the previous observed exchange at the boundary before their next intra-batch Send or explicit HANDOFF new-tab Send. The check covers both latest canonical user prompt SHA-256 and complete assistant-answer SHA-256; changed DOM state fails with **no new request key, tab or Send**. A first manually instructed browser Send in a separate batch retains its existing explicit-command and SQLite authorization; these checks do not claim browser control is an OS-enforced sandbox. Tests inject changes between preflight reads and test invalid user/assistant hashes; live Chrome acceptance remains required.

A chained PI Mission has an additional first-Send guard inside the reservation transaction: its parent must still have a verified, unpaused continuing 32/32 checkpoint and reciprocal successor link, and its first Send must request a distinct new ChatGPT conversation. A raw CLI browser Send to the inherited parent link is rejected without creating a request key. The GMK parent→child 32/33 lineage and the first child destination/answer/PI decision were independently cross-checked in the production SQLite and Chrome; reverify the current chain before applying this conclusion to a later Mission.

`pi-evidence` independently validates browser migration attribution, not just a count of migration markers. Normal migration must carry a valid, distinct pair of hashed URLs and an already reserved request key that matches the immediately following observed response. A dangling or unrelated migration is an audit failure and cannot establish independent Chrome rollover acceptance. Recovered rollovers use their separate independently inspected recovery event. The report reveals only event identifiers and digests, not the conversation URLs or request keys.

For current 10→11 and prior Chat rollover autonomous Chat rotations, the read-only ledger rejects **broken URL-hash lineage**: once a first destination is known, the previous-URL SHA-256 of every next normal/recovered migration must equal that last recorded destination SHA-256. Previously, an unrelated but syntactically valid source hash could reset the observed chat-turn count without violating the migration's individual two-URL inequality. The first source Chat may be owner-provided and is not independently attested by an earlier migration event. Adversarial tests tamper with migrations and recovered rollovers; both must yield `migration_source_url_discontinuity`. This is a detection hardening, not proof of a real browser switch or faithful context inheritance; validate the live browser and linked reply separately.

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
acceptance, but a Goal's missing 10→11 / prior Chat rollover / 32→successor witness is **not**
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
   evidence. The separate trusted 10→11 (prior Chat rollover), 32→child, maintenance/restore,
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

Run `node dist/cli.js pi-health` in the **existing GMK checkout** to see bounded, secret-free in-flight PI Mission IDs, observed browser rounds, current-chat 10-Send budget, PI decision/round, request reservation age and an explicit request phase. The same phase and request age appear in authenticated Telegram `/status [mission-id]`. `pi-health`, `pi-evidence` and `pi-chain-evidence` open existing SQLite schema **v3, v4 or v5** in **read-only mode with `PRAGMA query_only`**; Goal ledger and release-gate commands require **v5**. These diagnostics refuse unsupported schemas without creating or upgrading them. They do not attach to Playwriter, inspect conversations, read credentials, modify Mission records, send messages or start a second worker. The report omits owner goals, raw prompts, response text, browser URLs and Chrome identities. PI evidence reports may include SHA-256 digests and event IDs, never answer bodies. A `browser_answer_pending_do_not_resend` phase means a request is still reserved and its final answer **has not been credited**, not that the browser is frozen or that a resend is permitted. A healthy Telegram `getUpdates` heartbeat proves transport connectivity only. When the phase becomes `reconciliation_required_do_not_resend`, independently inspect the exact original request and browser answer before any acknowledged recovery. Do not bypass the existing channel-drain maintenance gate for deployment.

After a turn is credited, `node dist/cli.js pi-evidence <mission-id>` produces a content-free event correlation report. Use `rounds[].observedEventId`, `reservedEventId`, `answerSha256`, `decisionEventId` and `decisionShaMatches` to verify real ChatGPT → PI linkage. `chatSegments`, `maxObservedTurnsInOneChat` and `currentChatObservedTurns` expose any violation of the ten-Send-per-Chat ceiling; `pendingPiReviewRounds` is valid while PI inference is unfinished. `ledgerConsistent` only means no detected event-counter/hash violations, **not** that code, tests, deployment or business acceptance passed. Missing or ambiguous browser observations remain unresolved without the existing operator-confirmed recovery. This audit does not send new ChatGPT prompts or publish Telegram messages.

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

Model-only completion is still allowed for `read-only` missions, but should be treated as a model review rather than a deterministic proof. A write-capable mission with zero configured checks pauses instead of reporting completion. Historical SQLite v1/v2 databases migrate to v3 on first open; maintain a copy of critical state before deploying a new release.

## Recovery

**New Chat origin Send-button hydration (after the production #1177/#1178 incident):** A new tab can expose a visible composer before its Send control is enabled. After filling the originally reserved prompt once, Relay may wait up to eight seconds, checking only the same authorized empty `https://chatgpt.com/` origin for the visible enabled button. It does **not** press Enter or refill the prompt. A navigated tab, visible submitted user message or still-disabled button fails closed as an ambiguous original reservation. Inspect the exact new conversation before using the existing one-time `browser-recover-rollover` or, if it has no valid complete marked answer, the explicit `browser-reconcile` operation. Reconcile preserves the original event and consumes its request key without crediting a turn. It never authorizes replay or a fabricated PI PASS.

**Permanent long-task browser transport handling:** `Connection interrupted. Waiting for the complete answer` is a *wait* state, not evidence that the committed request failed. Preserve the tab and observe the original response. The default 60-minute browser window gains one bounded two-hour grace period when this banner appears, never exceeding four hours from Send; an explicitly chosen shorter timeout is respected. `Message delivery timed out. Please try again.` with a visible, uniquely identified `Retry` button allows **one UI Retry for the existing submitted message** in the same exact Chrome conversation, only when the latest visible user prompt SHA-256 still matches the SQLite reservation. The existing-chat controller writes an immutable request-scoped SQLite Retry intent *before* clicking. If the Worker dies after that intent, it must not click again, even if it cannot tell whether the first click succeeded. A single enrolled Worker also inspects an original same-chat request that entered `NEEDS_RECONCILIATION` **specifically from the normal response-observation timeout**. It can perform its one guarded UI Retry (never composer Send) if no intent exists, or observe the existing Retry outcome. Only a stable complete answer with the exact original prompt, original unspent reservation/lock and a distinct final assistant SHA is credited; PI then reviews it before the next Send. This recovery is not permitted for other ambiguous failures, new-chat origin Sends, changed Chrome/tab ownership, owner pauses, or an active maintenance drain. The exact `Show more`/`Show less` transcript controls are not user-authored prompt bytes; strip them before computing the latest user SHA. If a different uncertain request lacks these conditions, use explicit operator-inspected `browser-recover-turn` / `browser-recover-rollover`, never replay Send. If a Retry control disappears or fails, keep the consumed intent and existing uncertain reservation for further read-only inspection; never issue a second click. See [Playwriter evaluation](playwriter-evaluation.md).

**DOM read timeout versus submission failure:** A real production PI-controlled continuation became uncertain when Playwriter timed out reading an accessible `ChatGPT said:` reply node after Send. The current source retries **only** the exact `locator.innerText: Timeout ... exceeded` text-read error twice with a short delay after the Send, discards any partial stability candidate, and refuses repeated Send. Three consecutive failures or an unknown error still fail closed. A source-level synthetic one-time failure is recoverable, but this does not validate the historical uncertain request. The real original tab must be accessible with an exact last-user prompt and stable marked answer before `browser-recover-turn` can safely credit it. Opening a blank new tab at the same URL is **not** proof of that answer. Keep the original uncertain SQLite event and request lock until explicit recovery or reviewed reconciliation.

If execution stops or the process crashes, inspect `show` and `events`. When state is `NEEDS_RECONCILIATION`, inspect the workspace and actual external side effects before using `reconcile`. Reconcile does not replay the interrupted turn; it only permits a new, explicitly requested continuation.

Do not run multiple `run` commands for one mission. The database lease blocks parallel workers, but only one process should own the executor session.

**ChatGPT stream-error Retry (v1.1.2):** In addition to the existing delivery-timeout Retry, the single Worker recognizes exact visible `Error in message stream` (optional trailing period) **in the same two-level DOM control group** as its unique `Retry` button. A quoted phrase in assistant prose, a generic Retry elsewhere, a changed original user SHA, or a changed conversation URL does not authorize this action. The original existing-chat Send and a first Send in a newly created Chat both consume the same per-request SQLite one-shot Retry intent *before* clicking; after interruption, never click that message again. The Worker may reconcile a stable original same-chat answer after an observation timeout, with the original-request/lock/PI gates. Do not automatically adopt an ambiguous new-chat origin without independent evidence. `Connection interrupted` remains wait-only, not a Retry trigger.

## Future remote control

Telegram remains an opt-in channel; see [Telegram setup](telegram.md). Without owner enrollment it runs in the foreground, with an optional enrolled Windows interactive task to start at login and recover from a bounded number of crashes. Playwriter remains a separate component. A running CLI **does not hot reload** after build: use a gated restart through the enrolled task, or stop/restart the original private foreground terminal. Do not re-send previously accepted `/continue`; compare `channel-status`, mission `show`/`events` and a read-only `browser-probe` before any new dispatch.
