# Operations history

Completed one-time procedures, preserved verbatim for audit. They are not part of
the current runbook in [operations](operations.md); Git holds earlier revisions. The release-gate probes, connection drill, chat adoption and
browser-watch referenced below were removed in 1.2.28.

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
| Chrome eighth → ninth Send (stable legacy gate ID: `chrome-10-to-11`) | `goal-release-chrome-probes.ts`, `goal-release-chrome-history.ts` | Per-rollover original reservation, both physical Target/prompt/answer witnesses, new Chat URL hash and PI decision |
| Mission 32 → successor | `goal-release-successor-probe.ts` | Exactly 32 committed parent turns, reciprocal zero-turn child, immutable original child request, physical successor witness and independent child PI review |
| Tab custody/retirement | `goal-release-chrome-probes.ts` | Original controller retirement event, before/after physical tab inventory and owner-tab preservation |
| Maintenance/recovery | `goal-release-maintenance-probe.ts`, `telegram-task.ps1` | Hash-linked original drain, restored SQLite snapshot, original compiled rollback bytes, fenced Worker/SQLite validation and live Chrome readback |
| Independent acceptance | `goal-release-work-probe.ts`, `goal-release-remote.ts` | Operator-owned criterion/test mapping, original PI-reviewed request and actual SHA-bound test execution receipt |

All five inspectors already exist, including the **fenced upgrade and
rollback evidence checks**; none is a model-to-PASS shortcut. The
production adapters require matching compiled target SHA and original state.
Chrome eight-to-nine, successor, tab retirement and maintenance/recovery
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
8→9 (plus prior Chat rollover), 32→child, tab, recovery and business criterion still requires its own
unfabricated physical/execution evidence for the deployed exact SHA.

Each generated private trusted-probe inspection receipt now identifies the
`requirement`, exact `targetSha`, `expectedOutcome`, `observedOutcome` and
`evidenceProvenance`. Content-addressed raw witness, audit, test or live
readback digests remain in the same receipt. These outcome fields are written
**only after** the source-specific validator succeeds; an absent original
observation, missing independently reviewed request, or contradictory record
cannot be converted into a PASS by supplying these fields in an external file.

`npm run build` first removes the generated `dist/` directory, then compiles
from the current TypeScript source and emits untracked
`dist/build-provenance.json` describing the exact checkout HEAD and SHA-256
tree digest of **every compiled JS file**. This prevents deleted or relocated
modules from surviving in a later bundle.
The Windows Upgrade action adds the exact enrolled Scoop Node LTS directory
to its process-local `PATH`, then runs the three existing build stages
(`clean-build`, TypeScript compilation and provenance generation) directly
through that absolute `node.exe`. It avoids the extra `npm.cmd`/`cmd.exe`
run-script layer that proved unreliable in SSH-launched maintenance and does
not change the user's persistent environment.
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

**Closed-page error after a settled PI NEXT:** A closed Playwriter page can
occur during the next request's *read-only history preflight*, after the
previous answer and PI NEXT were durably committed but before any next Send
reservation. The exact `locator.count: Target page, context or browser has been
closed` error is now eligible for this same request/SHA-scoped backoff **only**
when the last browser receipt is fully verified, PI has a matching NEXT or
HANDOFF decision, the Mission is not owner-paused, and no new Send is pending.
The enrolled Worker reconnects to the original pinned browser/profile and
compares both user and assistant hashes before it can advance to a new request.
If that evidence changes, the controller fails closed. No automatic source
repair may restore an older `pi.autopilot_interrupted` event with `lastError`.

**One-time legacy recovery on v1.2.14 or later:** After a verified idle,
exact-SHA three-platform CI and approved GMK pull-only upgrade, inspect
`pi-health`, `pi-evidence`, `browser-binding-health` and the current Mission
revision. For the **exact** previously persisted closed-page error or the
pre-Send `PI next browser Send refused: visible ChatGPT history differs from the
last observed receipt` error after an observed PI NEXT, the local operator
may run:

```shell
node dist/cli.js pi-recheck-browser <mission-id> --revision <live-revision> --acknowledge-side-effects
```

The command reads the same connected, approved ChatGPT tab twice, compares
the original full user/assistant SHA-256 digests and exact immutable PI
event order, and clears only this exact recorded interruption. A hidden
home composer plus visible thread composer does not weaken prompt/answer
matching. The command cannot retry an original
message, fabricate a PI review, reset a Goal, lift an owner pause or issue
any Send. The existing **single** enrolled Worker then independently rereads
the same receipt. Do not use the generic `resume` or `pi-resume` command for
such an interruption, and do not use this command for a reserved or uncertain
request, a terminal decision, an owner pause or a different browser error.

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

**PI capacity-busy and bounded model-timeout recovery (source behavior; independently verify installed SHA):**
An exact `pictl infer` SSH exit 2 whose structured error is
`Pi maintenance or a global task is active` means the operator-managed host PI global
execution slot was occupied, not that the ChatGPT Send failed. New controllers
also recognize `Model inference timed out after 120 seconds` when returned
as the **exact** `{"ok":false,"error":"..."}` structured exit-2 error.
Both are typed `RetryablePiError`, deferring the
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

For an **old** fully observed PI checkpoint whose last error is the exact
`Model inference timed out after 120 seconds` response, use
`node dist/cli.js pi-recheck-timeout <mission-id> --revision <current>
--acknowledge-side-effects` after a qualified version has deployed.
It inherits the same double-live-browser-read, exact recorded event sequence,
source SHA and owner-stop checks; it writes only
`pi.autopilot_timeout_revalidated` and clears that one known PI inference
failure. It **does not** retry a ChatGPT Send. The existing enrolled Worker
then independently rereads the settled answer and retries only PI under the
durable backoff policy. A different deadline, arbitrary stderr or unverified
browser page is never eligible.

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

**One-shot pre-Send new-chat origin-navigation recovery:** The operator-only
`browser-retry-pre-send-rollover` command covers only a specifically
proven `page.goto` timeout **before** any composer fill or Send click in a
fresh ChatGPT tab. It requires the unchanged original uncertain new-chat
reservation, its immutable prompt snapshot, source URL lock, and a prior
PI-reviewed Chat segment containing exactly **8 observed Relay Sends**
(or the original ten-Send historical boundary for pre-upgrade reservations).
Owner pause, maintenance drain, revoked scope, live owner, other navigation
errors and any potentially already-clicked Send forbid this path.

The command twice rechecks the original user/assistant SHA, rules out any
already-submitted matching request in enabled tabs, and verifies hydration
on a new unsent tab before committing the original-request one-shot
`chatgpt.browser_pre_send_retry_intent`. Thereafter at most one **first**
actual Send may occur. A failed or ambiguous attempt cannot be repeated;
the original uncertain receipt remains intact and must instead be
independently inspected through `browser-recover-rollover` if a complete
response actually exists. The enrolled Worker must PI-review the credited
reply before any later turn. This is never a generic Retry permission.

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
