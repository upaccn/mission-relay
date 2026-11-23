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

## Stuck task recovery

Inspect first; every action is revision-gated and never resends:

```sh
node dist/cli.js recover <mission>                         # read-only diagnosis
node dist/cli.js recover <mission> --accept-reply --revision <n> [--new-url <chat>]
node dist/cli.js recover <mission> --retry --revision <n>
node dist/cli.js recover <mission> --abandon --revision <n>
```

- **Outcome unknown** (`NEEDS_RECONCILIATION`, or a dead Worker left a
  request reserved): if the pinned Chat — or, for a new-Chat request, the
  exact new Chat given by `--new-url` — shows the complete marked reply to
  the reserved prompt, `--accept-reply` reads it twice, matches the prompt
  SHA and credits one turn; PI reviews it next. Otherwise `--abandon`.
- **Stopped by an error at a settled step** (PI timeout, closed page, Chat
  read mismatch): fix the cause, then `--retry`. It re-reads the live Chat
  twice and must match the stored receipt; it only clears the error.
- **`--abandon`** reconciles the request without credit or resend, ends the
  Mission and marks its Goal BLOCKED. Continue it from Telegram with
  `/goal-continue <n> <what changed>`.

`<mission>` may be the 8-character prefix that Telegram shows in a
"Task stopped by an error" notification and in `/status`.

The Worker itself handles transient cases without an operator: any PI
failure is retried with backoff (stops after 8); a failure before the Send
click (page load, composer not fillable) releases the request and retries
under a fresh key (stops after 8); the observation window extends while
ChatGPT is still generating (four-hour cap); a
`Connection interrupted` banner is wait-only (bounded grace, four-hour cap);
an exact `Message delivery timed out` or `Error in message stream` banner
permits one same-message UI Retry, plus two spaced follow-ups for an
existing-chat request, each with a durable intent recorded first; typed PI
and browser-read failures back off durably. For ChatGPT's maximum-length
notice an unpaused Worker may click the exact native `Start new chat` once
and submit the exact prefilled original draft once, crediting the original
request only after a complete SHA-matched reply. Owner pause blocks all of
these; a paused request is settled with `recover`.

## Production upgrade gate

Require exact-SHA GitHub `main` with successful same-SHA Ubuntu, Windows and
macOS CI (`software-release-status --sha <sha> --run-id <id>`), then run the
enrolled Windows read-only restart preflight, the SQLite maintenance drain
and `scripts/windows/telegram-task.ps1 -Action Upgrade -ExpectedSha <sha>`.
The upgrade keeps an isolated DB restore drill, backup, compiled rollback and
one-Worker source/PID attestation. Any RUNNING or queued READY Goal, reserved
Send or undelivered notification blocks deployment; never stop the current
Worker or reset its tasks to get past it.

The owner-approved `ResetProjects` action replaces all project records with a
fresh database under the same drain and backup, preserving repository grants
and revocations, the PI route, the Chrome launch profile and the Telegram
cursor. It is for an explicit owner decision to start clean, never a routine
upgrade step.

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
5. Before activating a new build, verify an idle Mission set, no queued Telegram delivery, no reserved browser Send and no queued READY Goal, then use the existing SQLite maintenance drain and the **same** enrolled Windows Telegram Scheduled Task to restart cooperatively. The drain also rejects an unsubmitted PI-ready task; do not bypass this gate by force-killing the worker. Recheck the new process, fresh Bot API `getUpdates` health, preserved cursors, watch profile and private Mission checkpoints. An interrupted deployment is not permission to resend the last ChatGPT request.

**Windows dependency updates are separate from source sync.** Never run destructive `npm ci` against live `node_modules` containing a DLL held by the current worker or Playwriter. Build in a clean isolated checkout first, or arrange an explicitly idle/drained maintenance window. Normal source-only TypeScript changes can use the existing compatible dependencies, but the running worker still must be restarted to load the new `dist` files. Keep the rollback commit and original SQLite state intact until verification succeeds. Avoid automatic Windows-to-Linux pushes, bidirectional file synchronization, another updater daemon or a second writable Mission database.

### Existing worker's bounded soft-stall watchdog

The Telegram worker has a 30-second unreferenced in-process watchdog. After five minutes without ordinary control-loop progress, it may exit code 75 for the already-enrolled repeating Windows Scheduled Task to restart it. Its SQLite fail-closed read requires ownership of the current lease, no running Mission or reserved browser Send, no queued READY Goal, no undelivered command reply or event notification and no maintenance drain. Before the voluntary code-75 exit it records `lastIdleExit` (UTC time, PID, elapsed milliseconds, exit code) in the private SQLite database, exposed read-only by `channel-status`. This does **not** prove the cause of any earlier PID change, nor does absence of the field prove that no other restart occurred. It does not kill another process, resubmit a ChatGPT prompt or introduce another daemon/task. This handles recoverable asynchronous stalls, not blocked JS execution, OS hangs or active side-effect uncertainty. Restart capability is synthetically tested; an observed production PID change without a prior durable exit receipt remains of unknown cause.

## Metered CI

Before pushing iterative changes to a private repository, inspect its
`.github/workflows/` triggers: a push to a watched branch may start a full
metered matrix. Prefer local deterministic checks and the approved native
testing host during iteration, and batch remote pushes at acceptance
boundaries. Exact-SHA release CI is still mandatory. Mission Relay's prompt
policy cannot disable workflows in other repositories.

## PI route

The adapter invokes exactly `pictl infer --project <approved> --stdin
--timeout 120 --json`, with no model, provider or thinking override.
Hash-only `pi.default_model_invocation_intent` events record the invocation
boundary and absent overrides; they do not attest which model the host
selected. Keep model defaults and fallback routing on the PI host.
