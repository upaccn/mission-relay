# Telegram (optional)

The Telegram adapter is a single-user **foreground process**. It uses the official Bot API's long polling and requires no public webhook or inbound port. It is not enabled by default. Telegram Bot chats are not end-to-end encrypted; do not send tokens, customer records, browser sessions or confidential model output to this channel.

## Setup (manual, local)

1. Create a private bot with Telegram's official `@BotFather` and obtain its Bot API token. **Never commit the token or paste it into chat.**
2. Send `/start` to your bot from your own Telegram account.
3. Set `MISSION_RELAY_TELEGRAM_BOT_TOKEN` privately in the process environment and run `node dist/cli.js telegram-identify`. Identify your private `userId` and `chatId` (both positive numeric identifiers). Do not trust a user name or forwarded message to establish ownership.
   In PowerShell 7, use `$env:MISSION_RELAY_TELEGRAM_BOT_TOKEN = (Read-Host 'Bot token' -AsSecureString | ConvertFrom-SecureString -AsPlainText)` to avoid entering the token in shell history. Keep this local to the intended terminal session.
4. Set `MISSION_RELAY_TELEGRAM_USER_ID` and `MISSION_RELAY_TELEGRAM_CHAT_ID` to those numbers. Ensure no other bot poller is running.
5. Run `node dist/cli.js telegram` in a terminal. Keep the terminal/session running. Use `/help` in the private Telegram bot chat.

From another terminal you can run `node dist/cli.js channel-status` to verify the poller's process, last durable Telegram update cursor, notification event cursor, and **successful Bot API polling heartbeat** without printing the Bot Token. The `transportHealth` field is `healthy` only when the current leased PID has successfully received a well-formed `getUpdates` result within the last 90 seconds. Otherwise it is `starting`, `stale`, or `offline`; `lastPollSuccessAt` is the UTC timestamp or null. This status proves successful polling, not that any particular owner message was delivered or that ChatGPT/PI execution has finished.

### Optional Windows task lifecycle (requires local owner enrollment)

On a Windows host with an interactive user Chrome/Playwriter session, the **existing Telegram poller** can instead be run by one user-scoped Windows Scheduled Task, with no additional daemon, webhook or bot poller. This is opt-in and is **not activated by cloning or building** the project. From a local PowerShell 7 terminal under the same Windows user who owns Chrome:

```powershell
# Read-only: see whether a foreground poller or a task is present.
pwsh -NoProfile -File .\scripts\windows\telegram-task.ps1 -Action Status

# After ensuring the old poller is stopped: locally enter owner/chat IDs and
# the token once, without typing the token into a command or ChatGPT.
pwsh -NoProfile -File .\scripts\windows\telegram-task.ps1 -Action Enroll

# If direct Node.js HTTPS is unavailable after disabling a host TUN,
# set only this Telegram worker's local HTTP proxy (no system-wide changes):
pwsh -NoProfile -File .\scripts\windows\telegram-task.ps1 -Action SetProxy -ProxyUrl 'http://127.0.0.1:20808'

# Later, after a tested build and when Missions are idle:
pwsh -NoProfile -File .\scripts\windows\telegram-task.ps1 -Action Restart
```

`Enroll` keeps the token **only in a Windows-user DPAPI-encrypted local file** under `%LOCALAPPDATA%\MissionRelay\telegram-task`, stores the numeric owner allowlist locally, and registers one limited-privilege **interactive-logon** task. It then starts the poller and checks the SQLite lease. The task uses Node LTS through the Scoop `current` path and restarts on unexpected exit at most three times with a one-minute interval; it does not restart forever, run when no user is logged on, or grant browser permissions. Task state is observable through `-Action Status` and Windows Task Scheduler. `-Action Start` starts an inactive enrolled task; `-Action Remove` unregisters the task but leaves encrypted credentials intact for intentional re-enrollment. Credentials must be rotated or removed separately when retiring the bot.

**Verified Windows recovery policy:** Do not rely on `RestartOnFailure` alone. On the owner Windows host, isolated failing tasks launched both manually and by a scheduled one-time trigger exited with nonzero result **23** and did **not** restart within 105–115 seconds, despite a configured one-minute retry interval. A separate isolated **repeating trigger** (one-minute cadence, `IgnoreNew`) recovered the same synthetic failure on the next trigger with exit code **0**. The installed Telegram task now combines the original logon trigger with an indefinite daily two-minute repeating trigger (`P1D` duration renewed daily), retaining `IgnoreNew` and without adding another process or scheduled task. `-Action UpgradeSchedule` installs this trigger on already-enrolled hosts, without altering the running Telegram PID. When already running, repeated triggers are ignored. This is **restart after process exit**; a hung but still-live process requires separate health monitoring and cannot be fixed merely with repetition.

`SetProxy` requires an already-enrolled task and only accepts a numeric-port, loopback `http://127.0.0.1:<port>` endpoint. It changes a local non-secret field in the owner's protected settings; the token is not read or rewritten. A subsequent gated `Restart` loads `HTTP_PROXY`, `HTTPS_PROXY`, `NODE_USE_ENV_PROXY=1`, and `NO_PROXY=localhost,127.0.0.1,::1` for the **Telegram worker process only**. This uses Node 24+ built-in environment-proxy handling, without an HTTP client dependency or host-wide proxy setting. It does not alter the Playwriter relay, Chrome or SSH route. Keep the local proxy available whenever the task is running. If it is late to start after login, the existing Telegram transport retries transient network failures with exponential backoff capped at 30 seconds; it will not silently fall back to a blocked direct route. Task Scheduler's separate bounded crash retries apply only if the process exits. A running task and an established proxy TCP connection do not, by themselves, prove Bot API authentication or message receipt.

If direct HTTPS later becomes available without the proxy, `-Action ClearProxy` removes only that local proxy setting; run the same idle-gated `-Action Restart` to activate the change. Neither command changes the DPAPI token or the owner allowlist.

`Restart` first checks that no Mission is RUNNING/VERIFYING, no Telegram reply is undelivered and no browser request remains `reserved`. It then requests an **exclusive SQLite channel-maintenance fence**. Telegram intake and new Playwriter Send reservations are rejected within the same SQLite write-lock transactions and incoming Bot API updates remain unacknowledged for the next worker. The current controller cooperatively stops polling and waits for any already-accepted in-flight task to settle; `Restart` waits for the old lease to disappear, releases only its matching maintenance receipt and starts exactly one replacement. The replacement must perform an actual fresh successful `getUpdates` heartbeat (40-second bound) before reporting success. An **old pre-drain build** cannot observe the fence and may require a one-time task-scoped stop after a second idle check; avoid owner activity during that migration.

If a management shell dies after requesting maintenance, `node dist/cli.js channel-drain-status` displays the **local-only** outstanding receipt. Do not start an additional controller or blindly clear the fence. Inspect the task process, `channel-status`, in-flight mission and browser state; after confirming no active work, use `node dist/cli.js channel-drain-release --id <exact-drain-id>` and then `-Action Start` if needed. A mismatching receipt is rejected. These safeguards protect the Telegram lease, SQLite reservations and the supported browser Send path; they do **not** freeze installed ChatGPT connectors. Automatic task crash restart is separate from deploying a new build.

The task manages **Telegram only**, not the separate Playwriter relay server. A Sharp DLL held by Playwriter can still prevent `npm ci`; stop/reconnect that specific relay under a separate safe preflight, or install dependencies in an isolated checkout. Do not use a global `taskkill /IM node.exe`.

The bridge is opt-in and intended for an owner-controlled interactive Windows session. Its enrolled Scheduled Task can keep the single Worker running while that user is logged on; it is not a Session 0 service and does not run when the owner is logged off.

### In-process idle-stall recovery

The existing Node controller checks ordinary control-loop progress every 30 seconds. After five minutes without progress it exits code 75 **only** when its own SQLite lease is current, there are no RUNNING/VERIFYING Missions, reserved browser Sends, pending Telegram replies or notifications, and no maintenance drain. The enrolled repeating Windows Scheduled Task then restarts this same single controller; no additional task, watcher or daemon is installed. Bounded transport-error retries and active long ChatGPT turns do not qualify. This does not fix an entirely blocked JavaScript event loop, which cannot execute its own timer. The fail-closed logic has synthetic tests; naturally occurring production stalls remain unverified.

## Commands

```text
<plain message>                          note for the single Goal in progress, or a new read-only Goal
/note 2 <text>                           note for a specific task from /list
/goal <objective>                        read-only Goal
/goal-build --repo /approved/path <objective>
/goal-continue 2 <what changed>          continue a BLOCKED Goal after its blocker is fixed
/goals · /goal-status 2                  Goals and their progress
/list · /status 2                        tasks needing attention, and their details
/pause 2 · /resume 2                     stop or resume at a safe point
/history                                 every task, newest first
```

Numbers are the selectors shown by `/list` and `/goals`; UUIDs also work but
are never needed. `/pause` without a number targets the only active task.
`/pause` never needs a revision so an emergency stop always works; a Send
already in ChatGPT finishes first.

### Goals

`/goal` is read-only. `/goal-build --repo <path>` may change exactly that
repository, which must first be approved locally:

```sh
node dist/cli.js telegram-build-project --allow /srv/projects/product-a
node dist/cli.js telegram-build-project --list
node dist/cli.js telegram-build-project --revoke /srv/projects/product-a
```

Nested approvals are refused, and approval is rechecked at every browser
reservation. It governs Relay's authorization and prompts, not the OS
permissions of ChatGPT's connected tools.

Every Goal is queued. The single Worker dispatches it when no other Send is
in flight: the first ChatGPT turn is read-only discovery in a fresh Relay
Chat, then PI approves a plan and drives one work package at a time. There
is no turn ceiling; each Chat carries at most 8 Relay Sends, then work moves
to a fresh Chat. A new Goal is accepted even while another Goal's Send is
unresolved, but it waits for the browser.

A plain message goes to the **one** Goal in progress as an owner note: PI
reads it before the next step, and a note arriving while PI is thinking
triggers a re-plan before any Send. With no Goal in progress a plain message
starts a read-only Goal; with several, use `/note <n>`.

When a Goal is BLOCKED on an external condition (billing, account access, a
tester) and you fix it, send `/goal-continue 2 <what changed>` rather than a
new Goal. PASSED work is reused and only the remaining work is re-planned.
A Goal is DONE only when PI passes the final package of its approved plan.

### Lists, history and archival

`/list` shows actionable tasks in pages of eight, ambiguous Sends first.
`/history` pages the whole ledger. Inline buttons are read-only navigation;
they cannot approve, restart, delete or reconcile anything. The Worker
archives safely settled tasks after 24 hours (hourly, idle only); blocked,
paused, interrupted and ambiguous work stays visible, and archival never
deletes history. See [product UX decisions](product-ux.md).

## Configure the browser and PI

Pin the Chrome profile in which Goal Chats are opened (after enabling
Playwriter on a ChatGPT tab there):

```powershell
node .\dist\cli.js browser-list
node .\dist\cli.js telegram-anchor --url <approved-ChatGPT-conversation-URL> --browser-id <Chrome-profile-ID>
```

If the anchor tab is missing, the first Send of a queued Goal may open a
Playwriter tab in the same approved profile to verify an idle composer, then
opens a separate new Chat; it never sends to the anchor conversation.
`telegram-anchor --clear` revokes it.

Configure the operator-managed PI route over the existing authenticated SSH
path (values here are examples, not defaults):

```powershell
node .\dist\cli.js telegram-pi-config --ssh-host operator --project /srv/projects/mission-relay
```

Mission Relay invokes only `sudo -n /usr/local/bin/pictl infer --project <p>
--stdin --timeout 120 --json` — no model, provider or effort override, task
text on stdin, no arbitrary remote command. PI is tool-free and returns a
JSON decision. `telegram-pi-config --clear` revokes the route.

## Delivery and recovery

- Only the allowlisted numeric user in the allowlisted private chat is
  accepted. Updates are processed in update-ID order; malformed updates are
  skipped and their cursor advanced.
- Each update ID is reserved in SQLite **before** any action, so a duplicate
  never repeats an action. A command interrupted by a crash is reported as
  uncertain and never replayed.
- Replies and notifications are persisted and retried until acknowledged.
  Telegram may rarely deliver a message twice after a crash; a command is
  still at-most-once.
- Progress arrives after the first and every fifth PI-reviewed round; one
  final summary arrives on Goal DONE, or a needs-attention message on
  BLOCKED. Full answers stay in ChatGPT; SQLite keeps SHA-256 receipts.
- After a restart the Worker resumes a Goal only after re-reading the exact
  Chat and matching its latest prompt and answer SHAs; anything else fails
  closed and is reported. Do not resend the original Goal.
- A stuck task is handled locally with `node dist/cli.js recover <mission>`
  (see [Architecture](architecture.md#operator-recovery)). Telegram never
  reconciles an ambiguous Send.

ChatGPT's read-only restriction is prompt-level; Mission Relay cannot
constrain connectors already enabled in the owner's ChatGPT account. Keep
write-capable connected apps disabled or approval-gated for high-risk use.
Telegram never receives browser JavaScript, cookies or raw session data, and
channel credentials are never propagated to child processes.
