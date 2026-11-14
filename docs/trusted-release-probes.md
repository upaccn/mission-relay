# Trusted ReleaseProbes — reproducible source contract

This describes source-level tests and evidence requirements, **not** an
assertion of production acceptance. Do not create or restage a Goal to run
these tests. Do not point test fixtures at the production GMK SQLite database,
the owner's Playwriter profile or an original browser reservation.

## Deterministic source verification

Run on the operator-managed host canonical checkout with the installed project dependencies:

```sh
git rev-parse HEAD
npm run check
node --import tsx --test \
  tests/goal-release-chrome-probes.test.ts \
  tests/goal-release-successor-probe.test.ts \
  tests/goal-release-maintenance-probe.test.ts \
  tests/goal-release-work-probe.test.ts \
  tests/goal-release-runtime.test.ts
npm run privacy-check
npm test
npm run build
git diff --check
```

Use an isolated SQLite fixture, synthetic physical `Page` objects, private
temporary witness folders and immutable SHA inputs. The five targeted suites
must exit **0** with zero failed, cancelled or skipped assertions. The full
Linux suite may legitimately skip Windows-only Scheduled Task/PowerShell
checks; record each skip and require a separate exact-SHA Windows CI run to
exercise supported Windows coverage before release. Capture the exact
checkout SHA, command, exit status and original TAP output rather than
transcribing its reported pass count. `MR_PROBE_RECEIPT=` diagnostics are
**synthetic fixture summaries**, not a trusted production Release Gate PASS.

| Requirement | Deterministic input and source/test | Expected positive observation | Mandatory negative outcome |
| --- | --- | --- | --- |
| `chrome-10-to-11` | Ten original same-Chat reservations/answers followed by one eleventh reservation, a **different** observed Chat URL/physical Target, exact user-prompt/full-reply hashes and PI review. `goal-release-chrome-probes.ts`; `tests/goal-release-chrome-probes.test.ts` | Eleven settled rounds across two Chat segments, at most ten observed Sends per Chat, independently captured source/destination witnesses for **every** required rollover | An eleventh same-Chat Send, duplicated original request, missing physical witness, reused Target, stale SHA, wrong prompt/reply or unreviewed pending request must not PASS |
| `mission-32-successor` (legacy only) | Synthetic 32 complete/PI-reviewed parent turns with its saved Chat limits, one reciprocal zero-turn child, first child request in a new Chat, full reply and later matching PI review. `goal-release-successor-probe.ts`; `tests/goal-release-successor-probe.test.ts` | Exactly one linked successor; child first turn is credited only once, its witnessed physical Target matches the original request and approved work scope | Owner pause, wrong parent/scope, duplicate child, uncertain original Send, missing PI review or stale/forged physical witness must not PASS or dispatch again |
| `maintenance-resume` | Isolated SQLite backup, hash-linked enrolled Upgrade journal, real atomic drain stage, verified isolated restore, retained compiled rollback image and a single new Worker. `goal-release-maintenance-probe.ts`; `tests/goal-release-maintenance-probe.test.ts` | All stages in order; backup/restore integrity and foreign keys valid; original protected events, stop flags and receipts unchanged | RUNNING/READY work, reserved Sends, undelivered commands, conflicting leases, corrupted restore/rollback, incomplete/forged journal or failed recovery must not PASS |
| `relay-tab-retirement` | Owned source/destination physical Targets plus before/after full enabled-target inventories; same Chrome fixture/test as 10-to-11 | Only a proven Relay-created superseded tab retires; active destination and human tabs remain | Unowned, moved, duplicated or unidentifiable Targets; failed close; missing witness; or changed inventory must not PASS |
| `criterion:<UUID>` | Operator-private criterion mapping with exact approved work item/criterion, original request and matching PI decision; one real tracked test launched through authenticated operator-managed host SSH. `goal-release-work-probe.ts`; `tests/goal-release-work-probe.test.ts` | Exit 0, unique named passing assertion in complete TAP, matching actual SSH session identity and source/command digests, original response unchanged | PI/model claims alone, fake/truncated TAP, skipped cases, wrong/stale/duplicate SSH marker, changed mapping, changed work-item key or untracked test path must not PASS |
| `gmk-production-readback` | Enrolled Windows task, independently observed Node Worker process birth and exact PowerShell task parent, verified compiled/runtime SHA, single channel lease, SQLite integrity/foreign keys and double exact physical Chrome readback. `goal-release-runtime.ts`, `telegram-task.ps1`; `tests/goal-release-runtime.test.ts` | Identical exact-SHA source and Worker manifest; same OS process incarnation before/after readback, healthy unchanged channel and enrolled task, stable original prompt/reply | Wrong platform or compiled revision, reused Worker PID with later process creation, competing/changed Worker, drain/pending reply, missing task proof, corrupted SQLite or stale/unstable browser must not PASS |

## Evidence boundaries and production invocation

The controller's existing `goal-release-probe-diagnose` is a **read-only**
diagnostic and distinguishes `PASS`, `FAIL` and `INSUFFICIENT_EVIDENCE`.
`goal-release-verify` additionally writes a release receipt only after the
same trusted probe succeeds under the immutable target. Both require a
separately authorized, eligible Goal; neither CLI argument is permission to
manufacture a witness, replay Send, create a successor or bypass maintenance.
The read-only `goal-release-coverage` index and the evidence-writing gate use
the same exact requirement-to-source validator: `maintenance-resume` accepts
only `maintenance-readback`, Chrome and tab custody accept
`chrome-readback`, and unknown or malformed requirement IDs cannot inherit
a default Chrome or independent-work source. A wrong-source or audit-mismatched
stored `PASS` is reported as `UNVERIFIED`, not as an independent receipt.

Real Chrome observations live under the private
`MISSION_RELAY_HOME/chrome-custody/<goal-id>/` tree as write-once,
SHA-256-named witnesses and readback receipts. The registered Windows Upgrade
generates private `upgrade-audit-<uuid>/receipts.jsonl`, drained SQLite
backup, isolated restoration and retained compiled rollback image.
Independent work receipts and raw TAP/SSH stderr are stored under
`MISSION_RELAY_HOME/goal-release-evidence/`. These private artifacts must
not be copied to public Git or replaced by synthetic test output.

Successful private inspection receipts use explicit `requirement`,
`targetSha`, `probeVersion=1`, `expectedOutcome=PASS`,
`observedOutcome=PASS` and
`evidenceProvenance` fields alongside content-addressed original witness,
SQLite, journal or test/executor digests. The independent-work receipt also
retains its legacy `source` field. Production Chrome, successor, tab and
maintenance receipts now identify the specific `scenario` and include a
`runtimeIdentity` binding to the exact installed SHA, compiled tree,
CLI/manifest, enrolled task and original Worker lease PID. That identity
must be independently read **both before and after** inspection; an offline
matching checkout is not a live Worker. The operator's read-only CLI is
distinct from the leased Worker and should not claim the Worker's own PID.
The stable-Worker identity also binds the existing lease-backed runtime
attestation timestamp (`workerAttestedAt`). Missing, malformed, more than
30 seconds future-dated, or changed timestamps fail closed even when PID and
notification cursors match (the 30-second allowance is for local clock skew).
The enrolled Windows `Status` readback additionally obtains the actual Node
process creation time and its PowerShell Scheduled Task parent through read-only
`Win32_Process` queries. It checks the exact installed Node executable,
`dist/cli.js telegram` command line, canonical `-Action Worker` script and
PowerShell 7 parent identity. The Node process must have been born **strictly
before** the original lease attestation to millisecond precision (an equal
millisecond is deliberately rejected), and the parent strictly earlier than the Node
process. These process-incarnation times participate in the before/after
identity comparison. A recycled numeric PID with retained stale lease and
heartbeat therefore cannot validate. Missing/inaccessible process metadata
fails closed for ReleaseProbes, while ordinary read-only task Status still
reports available task health. This is an OS-local, sampled identity check;
it is not hardware attestation or a guarantee of process survival after readback.
The `gmk-production-readback` gate uses this **same** strict lease-attestation
validator rather than accepting a PID/tree match without a valid attestation.
It also independently rechecks the enrolled Scheduled Task and Worker
identity *after* physical Chrome inspection; a replaced or unverified task
cannot be certified by its earlier healthy snapshot.
Neither the private SQLite lease key nor its digest is exposed. This is local
readback verification, not proof against a same-millisecond lease replacement.
Each successful top-level receipt also includes `eventReferences` derived
from the validated original SQLite event IDs: Chrome boundary/retirement
events, parent/child successor events with the reviewed first child decision,
the maintenance backup's historical event watermarks, the current GMK
checkpoint or the original independent-work reservation/observation/decision.
Witness files and original ledger hashes remain mandatory. These fields are
for audit navigation; an external event-ID claim cannot create a PASS.
Maintenance uses a separate `maintenance-readback` source, so Chrome-only
proof cannot stand in for a completed recovery journal. The independently executed work
criterion instead binds its original PI decision to the authenticated SSH
executor session and uniquely passing named test. A rejected or incomplete probe yields
no fabricated successful receipt; the read-only diagnostic instead reports
`FAIL` or `INSUFFICIENT_EVIDENCE` without changing the Goal ledger.

A production PASS additionally requires the actual installed exact SHA,
settled original request custody, independent current Chrome and Worker
observations, the approved Goal/PI state and the required private receipts.
Even all source tests passing does **not** prove a live 10→11 or legacy 32→child
transition, completed maintenance, browser custody or criterion acceptance.
Original uncertain requests and owner pauses always retain their recorded
SQLite state; release probes must never retry or rewrite them to create proof.
