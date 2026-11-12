# Telegram (optional)

**WP6.1 release evidence update:** The owner-only Goal release CLI may
read GitHub `main` and an exact Actions run directly through the
already-installed `gh` binary. A `--run-id` on
`goal-release-verify` uses same-commit CI evidence for the source
script and platform gates even when the configured operator-managed host SSH identity
cannot read the private workspace. No new authentication or Telegram
command is introduced. Browser, business and GMK release gates remain
independent and cannot be marked PASS by GitHub CI evidence.

**WP5 release status:** Owner `/goal-status <UUID>` shows whether independent
release verification is targeted, how many separately verified requirements
exist, and current blockers. The underlying CLI
`goal-release-status <UUID>` reads this evidence without performing a
browser Send or upgrading an old database. Source/CI release attestation
commands remain local-operator-only and require the existing approved
repository; Telegram is not a free-form PASS/DONE certification channel.
Real GMK/Chrome proof remains a separate WP6 production release gate.
WP6 corrects the Windows/Linux boundary for operator-only release
commands: the already approved PI SSH alias and operator-managed host project are used
for fixed source/CI checks. No new login or SSH credentials are collected;
inaccessible remote directories fail closed rather than altering host
permissions or trusting a model-provided test result.

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

If a management shell dies after requesting maintenance, `node dist/cli.js channel-drain-status` displays the **local-only** outstanding receipt. Do not start an additional controller or blindly clear the fence. Inspect the task process, `channel-status`, in-flight mission and browser state; after confirming no active work, use `node dist/cli.js channel-drain-release --id <exact-drain-id>` and then `-Action Start` if needed. A mismatching receipt is rejected. These safeguards protect the Telegram lease, SQLite reservations and the supported browser Send path; they do **not** freeze arbitrary external plugins or installed ChatGPT connectors. Automatic task crash restart is separate from deploying a new build.

The task manages **Telegram only**, not the separate Playwriter relay server. A Sharp DLL held by Playwriter can still prevent `npm ci`; stop/reconnect that specific relay under a separate safe preflight, or install dependencies in an isolated checkout. Do not use a global `taskkill /IM node.exe`.

Native coding-agent plugins configure their own network and authentication. The base Telegram controller does not install or configure a Codex subprocess, require its SDK or set a system-wide proxy.

The bridge is opt-in and intended for an owner-controlled interactive Windows session. Its enrolled Scheduled Task can keep the single Worker running while that user is logged on; it is not a Session 0 service and does not run when the owner is logged off.

### In-process idle-stall recovery (v0.2)

The existing Node controller checks ordinary control-loop progress every 30 seconds. After five minutes without progress it exits code 75 **only** when its own SQLite lease is current, there are no RUNNING/VERIFYING Missions, reserved browser Sends, pending Telegram replies or notifications, and no maintenance drain. The enrolled repeating Windows Scheduled Task then restarts this same single controller; no additional task, watcher or daemon is installed. Bounded transport-error retries and active long ChatGPT turns do not qualify. This does not fix an entirely blocked JavaScript event loop, which cannot execute its own timer. The fail-closed logic has synthetic tests; naturally occurring production stalls remain unverified.

## Supported commands

### Goal-driven owner commands (WP4)

The private, authenticated Owner may send `/goal <long-term objective>` for
**read-only** PI-managed Goal development, or `/goal-build <long-term objective>`
for development **only inside** the repository already approved through the
existing local `telegram-pi-config` and `telegram-build-project` workflow.
No task breakdown, planning fields, plugin selection or additional scheduler
are required from the Owner; the existing PI proposes and approves a
versioned, dependency-ordered Work Item plan after the first observed browser
analysis, then selects and reviews each package. Status is available via
`/goals [page]`, `/goal-status <complete UUID>`, or the linked Mission
`/status <mission UUID>`. Goal status is independent of each Chat and
Mission; PI continuations and successive Missions inherit the same Goal.
Only the Owner's explicitly chosen `/goal-build` is workspace-write; `/goal`
never gains write access by virtue of a configured build project.

The initial creation uses a single durable SQLite transaction for Goal,
fresh PI Mission, approved Chrome binding, and Goal↔Mission association.
An accepted but unsubmitted READY Goal after a controller restart may be
recovered using the same approved browser anchor and original request key.
If a browser Send has already been reserved or is uncertain, the channel
does **not** duplicate or silently reconcile it; the original evidence
must be inspected through the existing controlled recovery flow. Telegram
updates are idempotent; repeated update IDs do not create competing Goals.
The channel does not backfill old `/auto`, `/build`, plain-text or
one-turn `/new` requests. Current model-reported Work Item PASS or a
terminal Mission is **not** independent business verification or Goal DONE.
WP5/6 release gates and real GMK smoke testing remain separate.

The vendor-neutral optional native route is `/agent <task>` or `Agent: <task>`, and requires an independently installed executor plugin plus a locally approved `telegram-agent-workspace`. Plain text and `ChatGPT:` remain browser-first without native executor selection. Vendor-specific aliases (`/codex`, `Codex:`) are **not** supported by the new CLI; they were used in earlier prototypes. See [plugin API](plugin-api.md).

`/list [page]`, `/history [page]`, `/status [uuid]`, `/handoff <uuid>`, `/continue <uuid> v<revision>`, `/pause [uuid]`, `/resume <uuid> v<revision>`, `/instruct <uuid> v<revision> <text>`, `/cancel <uuid> v<revision>`.

For convenience, `/status` without an ID selects the latest non-archived
Mission. `/pause` without an ID targets the sole eligible active Mission;
when more than one task could be affected, specify its UUID. Neither command
requires copying a revision number.

`/list` presents **actionable** Missions in eight-item pages. Ambiguous Sends and `NEEDS_RECONCILIATION` come before ordinary RUNNING, BLOCKED and READY tasks, regardless of age. `/list 2` and the Previous/Next inline buttons expose older actionable records, including paused PI checkpoints. `/history` and `/history 2`, etc., page the **entire** Mission ledger newest-first, including live and unresolved records, with archival labels; history is not a business-completion verdict. Each entry includes its version and full `/status` link. Task messages and notifications have **read-only Telegram inline buttons** for viewing or refreshing status, moving between pages, returning to Tasks, and opening History. Callback actions use the same authenticated owner and private chat restrictions and the existing deduplicated Telegram update ledger. They cannot approve, restart, delete or reconcile a Mission. This is an inline-keyboard UI, not a custom Telegram Mini App or editable HTML card.

To clear safely settled historical Missions from the owner inbox, the operator may run `node dist/cli.js archive-settled` **locally**. The command is idempotent and non-destructive: all Mission rows, append-only events, receipts and historical CLI `list` output remain available. It refuses uncertain requests, interrupted PI work and other unresolved states. In particular, a PI `LIMIT` event at 32/32 with `NEXT/HANDOFF` does **not** prove completion and cannot archive the parent, whether or not a successor READY Mission has already been created. For PAUSED PI Missions, the latest committed PI `DONE/BLOCKED` verdict is required. This change does not retroactively delete or unarchive any historic records. No automatic deletion or background cleanup is performed. See [product UX decisions](product-ux.md).

### Natural-language tasks and fresh ChatGPT tabs

An older PI Mission that is PAUSED with a durable `pi.autopilot_interrupted` error no longer blocks **new independent** owner tasks when there is no reserved or uncertain browser Send. Its prior request, evidence and error remain unchanged; the old Mission is never replayed. An ambiguous prior Send or a fully observed response awaiting its first PI decision still blocks the new-task route. `/status <id>` shows the recorded controller error, while recovery of that old Mission still requires exact-checkpoint validation.

An owner may send **ordinary text**, `ChatGPT: <task>` or `/auto <task>` for PI-controlled automatic continuation (with no fixed Mission turn ceiling and no more than **5 Relay-submitted turns per ChatGPT conversation**). The first turn creates one fresh Chrome ChatGPT tab from the explicitly approved anchor; the original anchor is not sent any message. After five observed sends in the same conversation, a PI `NEXT` automatically becomes a fresh-chat rollover, without changing the durable PI decision or reusing a request key. An explicit PI `HANDOFF` may roll over sooner. For a legacy finite-limit Mission, a verified PI `NEXT/HANDOFF` at the saved 32-turn boundary can still create one successor with the original scope. This successor begins in a *new* ChatGPT conversation only after rechecking the exact latest parent prompt and complete response SHA-256; it cannot replay an uncertain prior Send. The SQLite parent/child record is atomic and idempotent across controller restarts. PI `DONE/BLOCKED` stops the chain; a changed parent tab, revoked write approval, or failed browser preflight blocks continuation rather than fabricating success. On each complete observed reply, Mission Relay sends the result and pending authenticated owner notes to operator-managed host PI using **tool-free** `pictl infer`, then validates PI's strict `NEXT/DONE/BLOCKED/HANDOFF` decision before considering another browser Send. PI receives the full observed answer up to 100,000 characters (larger answers explicitly mark omitted middle content), while Telegram receives compact notifications. A ChatGPT `DONE` marker is not itself the PI verdict. Telegram receives a **bounded progress notification for each PI NEXT/HANDOFF**, a legacy successor Mission ID only when applicable and one final PI result on DONE/BLOCKED; full SHA-256 receipts are durable, but the full answer text remains in ChatGPT, not the local SQLite event payload. `/new <task>` preserves the previous **one-turn without PI** path. Cross-Mission automation has synthetic coverage but has not completed unattended live acceptance.

**Owner updates at a legacy bounded-Mission handoff:** If the first Send of a READY successor has not been reserved, authenticated Telegram text (and `/instruct <successor-id> v<revision> <note>`) is queued against that successor even after controller restart. PI evaluates the notes against the independently observed parent answer, saves its revised child preflight decision and acknowledges exactly the notes reviewed. A note racing the final SQLite reservation causes local PI re-planning without duplicating a Send. PI may choose BLOCKED/DONE before any new tab is created. If the new-tab Send becomes uncertain, `browser-recover-rollover` reconstructs the persisted child plan (not the stale parent plan) and still requires exact visible prompt/answer verification and operator acknowledgement. Revoking `telegram-build-project` during PI inference also blocks the eventual reservation.

Configure the exact owner-approved anchor once in the local project (after enabling Playwriter on that tab):

```powershell
node .\dist\cli.js browser-probe <previously-approved-chat-mission-id>
node .\dist\cli.js telegram-anchor --url <approved-idle-ChatGPT-conversation-URL> --browser-id <approved-Chrome-profile-ID>
```

The CLI checks the exact authorized tab and stores only the anchor Mission ID in the **local SQLite database**, not in Git. Once that Chrome profile is approved, a **new** owner-authenticated `/build`, `/auto`, plain-text ChatGPT or `/new` task no longer needs to keep the historical anchor tab enabled: if missing, the controller opens a new Playwriter-controlled source tab inside the same approved Chrome profile, navigates only to the original approved ChatGPT URL to verify an idle composer, and then opens a separate new ChatGPT conversation for the actual task. It closes its temporary source, never sends a message to the historical conversation, and never enables or reads unrelated inaccessible tabs. The first Send still has the original SQLite reservation/no-replay rules. An unplugged or absent extension browser, an unavailable authenticated composer, or multiple ambiguous matching tabs fail without Send. Recovery of an uncertain request and continuation of an existing Mission **still require the exact original tab**, never a fresh substitute. The Bot sends one concise final result; `/handoff <new-mission-id>` returns the resulting private ChatGPT URL. `/new` is capped at **one** read-only-prompt turn; PI-managed plain-text/`/auto` Missions have no fixed Mission turn ceiling, but remain capped at **5 observed Relay sends per Chat**. Saved legacy bounded Missions retain their original successor protocol. `/status <id>` displays its predecessor or successor Mission ID. No generic browser gestures or external writes are granted.

Configure a separate operator-managed host PI inference route locally, reusing the existing **authenticated SSH** path (no PI install or OAuth copy onto the Chrome host):

```powershell
node .\dist\cli.js telegram-pi-config --ssh-host operator --project /srv/projects/mission-relay
```

The route is persisted **only in local SQLite** and can be revoked with `node .\dist\cli.js telegram-pi-config --clear`. These host/path values are examples for the owner's environment, **not public repository defaults**. Mission Relay invokes only `ssh -T <approved-host> sudo -n /usr/local/bin/pictl infer --stdin --json` with a fixed bounded argument vector and the model task passed as stdin. operator-managed host `pictl infer` runs without filesystem, browser, web, extension, subagent, or other tools; it returns a JSON decision rather than taking actions. The remote SSH login/sudo permission must already exist and should be restricted to this operation for higher-assurance environments; this pilot currently reuses a more privileged existing operator SSH account. No generic remote-command or arbitrary Pi tool API is exposed to Telegram.

For **real project implementation**, the local operator can additionally approve exactly the same PI project path:

```powershell
node .\dist\cli.js telegram-build-project --project /srv/projects/mission-relay
```

Then the authenticated Telegram owner sends `/build <specific implementation task>`. That Mission is recorded as `workspace-write`; ChatGPT gets explicit permission to change the approved source repository, run tests and use its existing connected GitHub/deployment tools to complete the task. PI stays tool-free and decides NEXT/HANDOFF/DONE/BLOCKED after each observed answer. It does not stop merely because routine source writes are necessary. `/auto` and ordinary chat messages remain read-only. Fresh ChatGPT task goals accept **1–4000 characters** (Telegram's single-message limit is 4096 including the `/build ` prefix); this is distinct from **1–1500 characters** for individual `/instruct` notes and PI `nextPrompt` instructions. For long goals, Chat rollover preserves the complete owner goal and PI instruction by bounding the optional previous-answer excerpt within the 12000-character browser prompt limit. `/build` has no fixed Mission turn ceiling, retains the 5-Send-per-Chat limit and supports `/pause` and owner notes; `/instruct` may also enqueue owner notes for an active PI-owned `/build` Mission. Emergency `/pause <id>` propagates to any already-created successors of that Mission so a READY child cannot launch after the original has been stopped. An in-flight remote Send still needs ordinary observation or reconciliation. Local `telegram-build-project --clear` revokes new `/build` creation and stops further browser sends on an active build at its next checkpoint. The approved path must exactly match the configured `telegram-pi-config` project. This is **prompt-level authorization rather than an independent filesystem sandbox**: the owner must have already enabled genuine code-access tools in the ChatGPT conversation. Without usable tools, the executor should report BLOCKED rather than pretend to implement. The private allowlist, request-key idempotency and ambiguous-Send reconciliation remain mandatory.

The first browser dispatch also requires a successful bounded, non-model `pictl doctor --json` preflight over the same SSH path. This checks health but **does not** certify the subsequent model call or every future network request. Each PI inference is separately bounded (120-second remote inference, 135-second SSH deadline). PI is a coordinator, not an independent tool-based verifier of external business outcomes.

### Optional Chrome-profile adoption watch (v0.2 development)

The operator may locally authorize all **Playwriter-enabled ChatGPT tabs in one exact Chrome profile**, without any Chrome tab-group or tag requirement:

```powershell
node .\dist\cli.js browser-list
node .\dist\cli.js browser-watch --browser-id <approved-Chrome-id>
node .\dist\cli.js browser-watch-status
node .\dist\cli.js browser-watch --clear
```

The first enable establishes a local baseline and does **not** launch earlier conversations. The existing leased Telegram foreground poller then checks for newly connected ChatGPT conversations or newly submitted human prompts about every 15 seconds when no other Mission is active. It checks for duplicate URLs and a stable existing answer before a zero-Send adoption. PI reviews that original human response, and only PI NEXT may authorize an additional ChatGPT Send in the same tab. Multiple eligible chats are serialized; a paused or uncertain Send is never repeated.

Disabling the watch also requests a stop before subsequent turns on watch-created Missions. Chrome disconnects are isolated from the Telegram transport: they should not prevent the bot from accepting pause or status messages. **Two isolated real-Chrome plus real-PI NEXT → Send → DONE trials and one fresh production-controller real-Chrome → PI → Telegram Bot API notification acceptance passed.** The live notification cursor reached the Mission terminal event and no replies were pending; this is not an independent observation of the owner's phone UI or proof of external business outcomes. Playwriter's public extension API exposes only enabled tabs, not every ordinary Chrome tab; a new tab that was never enabled cannot be detected merely from profile-level authorization.

While the PI Mission is active, ordinary Telegram text is queued as authenticated owner guidance **for PI**, not sent into an in-progress ChatGPT response. The controller persists every update ID and includes queued notes in the next PI decision; if a new note arrives while PI is thinking, the controller re-plans before the next browser Send. `/status <id>` reports the PI decision and pending note count. `/pause <id>` prevents further turns; if you explicitly want to handle the next step yourself, tell PI in natural language or issue `/pause` for deterministic stopping. `/continue` and native `/resume` cannot bypass PI planning on a PI-owned Mission.

After a foreground restart, a PI Mission with a **fully observed** prior ChatGPT response, including an explicitly adopted zero-Send human conversation, is recovered only after checking the exact approved tab's latest user-prompt SHA and full assistant-answer SHA against SQLite. A durable PI `NEXT` decision can then resume the next unsent turn; if PI had not yet reviewed the initial answer, it reviews the existing human reply first without a synthetic browser Send. Any missing tab, changed history, ambiguous Send, unavailable PI, or missing authorization **fails closed** and informs the owner; there is no automatic replay. After a crash, inspect `/status` and do not submit the original task again.

The ChatGPT read-only restriction is **prompt-level**, not a technical sandbox for connectors already installed in the owner's ChatGPT account. Mission Relay does not invoke external connector writes itself, but cannot independently constrain what tools ChatGPT may have available in that conversation. Keep write-capable connected apps disabled or separately approval-gated for high-risk use. A model-produced `DONE` marker is an observed response, not an independently verified real-world result.

To revoke the owner-approved source, run `node .\dist\cli.js telegram-anchor --clear` locally. The optional native executor workspace can be revoked with `telegram-agent-workspace --clear`. Disabling Playwriter on the original tab also prevents the new-chat operation from proceeding.

For an independently installed **native executor plugin**, locally authorize one workspace using:

```powershell
node .\dist\cli.js telegram-agent-workspace --workspace 'C:\path\to\approved\project'
node .\dist\cli.js doctor
```

Then `/agent <natural-language task>` runs one supervised, read-only native turn, without opening Chrome or silently switching providers. The plugin must handle authentication and enforce its own read-only tools; `doctor` does **not** prove that external connectors cannot write. An agent runtime and its model provider are separate choices.

For conversational input without a slash command, `Agent: <task>` and `ChatGPT: <task>` select native plugin or browser-first routes. Plain text defaults to PI-managed ChatGPT; unrecognized vendor-specific slash commands fail closed.

After updating code, `npm run build` and restart the existing foreground Telegram session to load these commands. No new server or Telegram webhook is required.

`/handoff` returns a locally linked ChatGPT conversation URL and a manual continuation prompt. `/continue` on a linked Mission executes a **Playwriter browser continuation** (up to three turns) in that exact operator-enabled Chrome tab; on an unlinked Mission, it requires a separately installed native executor plugin. There is never silent fallback. **Before browser continuation, bind the intended Chrome profile locally using `browser-list` then `browser-bind`.** See [ChatGPT browser control](playwriter-evaluation.md).

**Revision required:** Mutating continuation commands such as `/continue`,
`/resume`, `/instruct` and `/cancel` require the current Mission revision
(for example, `/continue 123e4567-e89b-42d3-a456-426614174000 v0`). Issue
`/status [uuid]` to read it. A stale or missing revision is rejected rather
than reinterpreted against a changed Mission. `/pause [uuid]` intentionally
remains revision-free so an emergency stop works while turn events are
advancing the revision; omitting its UUID is allowed only when one eligible
task is unambiguous.

**Legacy remote continuation is read-only:** Telegram `/continue` and `/resume` reject all `workspace-write` missions, including locally created native-engine tasks. The separate owner-authorized `/build` route is PI-owned, and accepts queued owner `/instruct` notes only within the original approved source scope; it never falls back to the legacy `/continue` driver. Telegram `/pause` and `/cancel` remain available as stop controls and cannot expand write permissions.

For a ChatGPT-linked Mission, neither `read-only` nor `workspace-write` enforces a technical sandbox on the external browser's connectors. Playwriter's ordinary Send click can instruct ChatGPT to use tools already available to that conversation; `/build` does not create those tools or execute arbitrary SSH commands itself. Confirm actual code/tool readbacks before considering a development Mission completed; use `/pause` to prevent subsequent turns.

`/continue` starts only a READY mission or a manually PAUSED mission. Blocked and ambiguous missions require local inspection. There is **no remote reconciliation or high-risk approval command**.

For linked ChatGPT Missions, `/instruct <uuid> vN <text>` is honored in the *next* continuation prompt rather than silently ignored. The instruction is consumed once only after a complete observed reply, unless another operator revision occurred during dispatch; a newer or repeated instruction remains pending. A failed/ambiguous send preserves instructions. Keep notes under 1,500 characters.

**Compact result feedback:** A Telegram-initiated linked browser **continuation batch** now sends **one final text notification**, not a message after each intermediate `NEXT`/`HANDOFF`. Each individual turn still has a complete `chatgpt.browser_observed` audit event and SHA-256; the final `chatgpt.browser_run_finished` event is committed **atomically** with the last observed turn and any new-conversation link migration. A capped Mission whose last permitted turn returns `NEXT` still receives a final notification; an ambiguous turn reports uncertainty instead of success. Legacy/local CLI browser sends retain their earlier per-observation notifications. A final notification contains at most ten lines: mission/turn, evidence disclaimer, up to six actionable lines, final flow marker and status command. If the assistant provided a `Telegram-ready summary` heading (including Markdown headings), its progress/evidence/blocker/next-action lines are preferred over arbitrary last lines; otherwise a bounded reply tail is used. Common token patterns and secret-bearing URLs are redacted; this is **not** independent verification. The complete answer stays in ChatGPT. No ChatGPT screenshots are automatically uploaded to Telegram: screenshots have higher disclosure risk, are less searchable and create media-upload state and cleanup complexity. Any future screenshot transport should be strictly opt-in, tab-scoped and private-chat-only.

**Long tasks:** Normal post-Send Playwriter observation is **once every 60 seconds** (local DOM reads, not additional ChatGPT model calls). An apparent final marker is re-read after 3 seconds to confirm stable text. The narrow initial new-tab URL/SPA bootstrap phase checks every 2 seconds for up to 20 seconds; this is not a 60-second model-generation poll. The default per-turn timeout is **60 minutes**, with a **4-hour absolute maximum** and one bounded grace extension only when a visible connection-interrupted banner occurs during a default-length turn. A matching delivery-timeout banner allows at most one click of its exact existing-message Retry button after exact prompt/URL validation and a durable one-shot intent, never a second Send. After an ordinary existing-chat observation timeout, the single Telegram Worker may automatically inspect the original uncertain request once per 60 seconds, Retry it once if still eligible, and recover only a stable final reply independently verified against the original prompt and lock; PI reviews it before further Sends. Unrelated ambiguous failures remain blocked for operator inspection. A bounded `[MISSION_RELAY:HANDOFF]` can open a new ChatGPT tab in the same pinned Chrome browser and move the Mission link only after a complete reply is observed there. For a direct new-chat URL that shows no answer after two minutes and no visible generation or interruption banner, the controller may **refresh that exact new tab once**, never re-click Send. Neither existing tools nor permissions are automatically inherited by the new conversation. A foreground Telegram process started before a new build must be restarted through the maintenance gate to load that build.

For a completed externally observed new-chat rollover that local observation missed, `browser-recover-rollover <mission-id> --revision <v> --new-url <exact-direct-chat-URL> --acknowledge-side-effects` inspects the exact pinned source/destination Chrome conversations and verifies the reserved prompt SHA, stable final assistant marker, complete answer SHA and destination URL **without sending again**. It supports both the first new-chat Send of an owner-created `/build` or `/auto` Mission and later PI-controlled HANDOFF/5-turn rollover (rebuilding the prompt from its persisted PI decision). A changed prompt or another active Mission owning the destination blocks recovery. ChatGPT may decorate long visible user messages with an expanded `Show less` or collapsed `Show more` control; these exact UI controls are stripped before comparing SHA-256, but user-authored text changes still fail the comparison. If a first Send is uncertain, the Chrome watcher must not adopt its unlinked answer into a separate read-only Mission; resolve the original owner Mission first. Use recovery only after inspecting the corresponding ambiguous history; ordinary `browser-reconcile` remains the conservative choice if the new answer cannot be verified.

For an **existing ChatGPT conversation** whose Send succeeded but a previously displayed `This response couldn’t load` message caused an observer error, use `browser-recover-turn <mission-id> --revision <v> --acknowledge-side-effects` only **after** confirming that this exact authorized chat shows the expected newly submitted user prompt and a fully stable marked assistant reply. The CLI reconstructs the reserved prompt and compares its SHA-256 to the durable reservation; it separately reads the actual answer twice, verifies the final marker, and commits an observed recovered turn plus audit evidence in one SQLite transaction. The original uncertain event and request key remain intact. It cannot trigger a new Send or fabricate task completion. If the visible reply is absent, the prompt mismatches, or the answer is incomplete, recovery refuses; do not bypass the lock or blindly re-run `/continue`. A recovered-turn notification corrects the earlier uncertainty notice. This path was applied to one real Telegram-triggered ModelGain research task whose full final answer existed in Chrome, without replay.

## Delivery and recovery

**Native Codex final results:** A successful supervised Codex Mission may run through a separate read-only model verifier before publishing a single `verification.accepted` event. The Telegram notification now includes the bounded model summary and up to three verifier evidence statements, explicitly labeled as **model-reviewed, not deterministic proof**. An initial `accepted` message means work started, not that work completed. If the owner sends the same task again while it is active, the Bot returns the active Mission ID and `/status` command rather than triggering another execution. Do not resend while waiting for the final notification. This is separate from duplicate Bot API update-ID protection; intentional repeated tasks after completion are still new commands.

- Only messages in the allowlisted private chat from the allowlisted numeric Telegram user ID are accepted.
- A Bot API batch is processed in update-ID order. Malformed messages with a valid update ID are skipped and their cursor advanced instead of blocking all later commands.
- Each Telegram update ID is reserved in SQLite **before** any action, so duplicates cannot trigger a second mission run.
- After a crash between reservation and action, the command is marked uncertain and reported; it is not replayed. An interrupted command **may already have caused side effects**. Inspect authoritative status and external effects before issuing another command.
- Replies and final browser notifications are persisted and retried on transport failure until locally acknowledged. Telegram delivery can still be duplicated if the process dies after Telegram accepts a message but before the local delivery cursor advances; the *command* remains at-most-once. A crash between intermediate browser turns can leave the Mission PAUSED with no batch-final notification; inspect `/status` and SQLite evidence rather than assuming the missing notification means a retry is safe.
- Terminal mission states are notified on a best-effort basis. Messages contain task IDs and status, not full tool output.
- The initial live pilot emitted both a direct `COMPLETED` reply and a `verification.accepted` notification; this redundancy has been removed. After a new code version is loaded, terminal status is reported **once from the durable event stream**. Historical messages remain unchanged. Since a message send and the local cursor update cannot be committed atomically with Telegram, rare duplicate notifications remain possible after a crash, but never duplicate a command.
- Disconnecting Telegram never grants the model additional permissions or changes the mission's authoritative state.
- Channel credentials are not propagated to Codex or verification subprocesses. Child environments intentionally allowlist only necessary operating-system variables and (for Codex) explicit Codex authentication variables.

Telegram is a control channel: it does not receive browser JavaScript, ChatGPT cookies or raw session data. The optional linked browser executor runs on the GMK3 Chrome host.
