# Telegram (experimental, optional)

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

Do not enable a startup service or publish credentials before an end-to-end mobile test. The current bridge is opt-in, not an unattended-production setup.

### In-process idle-stall recovery (v0.2)

The existing Node controller checks ordinary control-loop progress every 30 seconds. After five minutes without progress it exits code 75 **only** when its own SQLite lease is current, there are no RUNNING/VERIFYING Missions, reserved browser Sends, pending Telegram replies or notifications, and no maintenance drain. The enrolled repeating Windows Scheduled Task then restarts this same single controller; no additional task, watcher or daemon is installed. Bounded transport-error retries and active long ChatGPT turns do not qualify. This does not fix an entirely blocked JavaScript event loop, which cannot execute its own timer. The fail-closed logic has synthetic tests; naturally occurring production stalls remain unverified.

## Supported commands

The vendor-neutral optional native route is `/agent <task>` or `Agent: <task>`, and requires an independently installed executor plugin plus a locally approved `telegram-agent-workspace`. Plain text and `ChatGPT:` remain browser-first without native executor selection. Vendor-specific aliases (`/codex`, `Codex:`) are **not** supported by the new CLI; they were used in earlier prototypes. See [plugin API](plugin-api.md).

`/list`, `/status <uuid>`, `/handoff <uuid>`, `/continue <uuid> v<revision>`, `/pause <uuid>`, `/resume <uuid> v<revision>`, `/instruct <uuid> v<revision> <text>`, `/cancel <uuid> v<revision>`.

### Natural-language tasks and fresh ChatGPT tabs

An older PI Mission that is PAUSED with a durable `pi.autopilot_interrupted` error no longer blocks **new independent** owner tasks when there is no reserved or uncertain browser Send. Its prior request, evidence and error remain unchanged; the old Mission is never replayed. An ambiguous prior Send or a fully observed response awaiting its first PI decision still blocks the new-task route. `/status <id>` shows the recorded controller error, while recovery of that old Mission still requires exact-checkpoint validation.

An owner may send **ordinary text**, `ChatGPT: <task>` or `/auto <task>` for PI-controlled automatic continuation (up to **32** bounded read-only ChatGPT turns per Mission, no more than **8 Relay-submitted turns per ChatGPT conversation**). The first turn creates one fresh Chrome ChatGPT tab from the explicitly approved anchor; the original anchor is not sent any message. After eight observed sends in the same conversation, a PI `NEXT` automatically becomes a fresh-chat rollover, without changing the durable PI decision or reusing a request key. An explicit PI `HANDOFF` may roll over sooner. This is one Mission across several chats, **not** unbounded cross-Mission continuation: when the 32-turn budget expires, it stops with a limit notice. On each complete observed reply, Mission Relay sends the result and pending authenticated owner notes to AIOS PI using **tool-free** `pictl infer`, then validates PI's strict `NEXT/DONE/BLOCKED/HANDOFF` decision before considering another browser Send. PI receives the full observed answer up to 100,000 characters (larger answers explicitly mark omitted middle content), while Telegram receives compact notifications. A ChatGPT `DONE` marker is not itself the PI verdict. Telegram receives a **bounded progress notification for each PI NEXT/HANDOFF**, and one final PI result on DONE/BLOCKED/turn-budget exhaustion; full SHA-256 receipts are durable, but the full answer text remains in ChatGPT, not the local SQLite event payload. `/new <task>` preserves the previous **one-turn without PI** path.

Configure the exact owner-approved anchor once in the local project (after enabling Playwriter on that tab):

```powershell
node .\dist\cli.js browser-probe <previously-approved-chat-mission-id>
node .\dist\cli.js telegram-anchor <previously-approved-chat-mission-id>
```

The CLI checks the exact authorized tab and stores only the anchor Mission ID in the **local SQLite database**, not in Git. The source tab must remain enabled and idle; an unavailable or wrong tab refuses execution. The Bot sends one concise final result; `/handoff <new-mission-id>` returns the resulting private ChatGPT URL. `/new` is capped at **one** read-only-prompt turn; PI-managed plain-text/`/auto` missions are capped at **32 total sends**, with up to **8 observed Relay sends per chat**. No generic browser gestures or external writes are granted.

Configure a separate AIOS PI inference route locally, reusing the existing **authenticated SSH** path (no PI install or OAuth copy onto the Chrome host):

```powershell
node .\dist\cli.js telegram-pi-config --ssh-host aios --project /srv/ai/workspace/projects/mission-relay
```

The route is persisted **only in local SQLite** and can be revoked with `node .\dist\cli.js telegram-pi-config --clear`. These host/path values are examples for the owner's environment, **not public repository defaults**. Mission Relay invokes only `ssh -T <approved-host> sudo -n /usr/local/bin/pictl infer --stdin --json` with a fixed bounded argument vector and the model task passed as stdin. AIOS `pictl infer` runs without filesystem, browser, web, extension, subagent, or other tools; it returns a JSON decision rather than taking actions. The remote SSH login/sudo permission must already exist and should be restricted to this operation for higher-assurance environments; this pilot currently reuses a more privileged existing operator SSH account. No generic remote-command or arbitrary Pi tool API is exposed to Telegram.

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

**Revision required:** All mutating commands **except emergency `/pause`** require the current mission revision (for example, `/continue 123e4567-e89b-42d3-a456-426614174000 v0`). First issue `/status <uuid>`; it prints the current revision as `v0`, `v1`, etc. After any state/event change, retrieve the latest revision again. A stale or missing revision is rejected, rather than reinterpreted against a changed mission. `/list` also shows the current revision. `/pause <uuid>` intentionally remains revision-free so a stop request works even while turn events are advancing the revision. This is an intentional protocol change from the initial phone acceptance trial; upgrade the foreground poller before using the new syntax.

**Remote execution is read-only only:** Telegram `/continue`, `/resume` and `/instruct` reject all `workspace-write` missions, including tasks created locally. Use the local CLI for those tasks after reviewing workspace, acceptance checks and Codex sandbox settings. Telegram `/pause` and `/cancel` remain usable to stop eligible write-capable missions, but cannot grant write permission.

For a ChatGPT-linked Mission, `read-only` is a native-engine compatibility field rather than a security boundary in the browser. Playwriter's ordinary Send click can instruct ChatGPT to use the tools already granted to that conversation. Keep the experiment on a designated test chat, do not assume browser sandbox isolation, and use `/pause` to prevent subsequent turns.

`/continue` starts only a READY mission or a manually PAUSED mission. Blocked and ambiguous missions require local inspection. There is **no remote reconciliation or high-risk approval command**.

For linked ChatGPT Missions, `/instruct <uuid> vN <text>` is honored in the *next* continuation prompt rather than silently ignored. The instruction is consumed once only after a complete observed reply, unless another operator revision occurred during dispatch; a newer or repeated instruction remains pending. A failed/ambiguous send preserves instructions. Keep notes under 1,500 characters.

**Compact result feedback:** A Telegram-initiated linked browser **continuation batch** now sends **one final text notification**, not a message after each intermediate `NEXT`/`HANDOFF`. Each individual turn still has a complete `chatgpt.browser_observed` audit event and SHA-256; the final `chatgpt.browser_run_finished` event is committed **atomically** with the last observed turn and any new-conversation link migration. A capped Mission whose last permitted turn returns `NEXT` still receives a final notification; an ambiguous turn reports uncertainty instead of success. Legacy/local CLI browser sends retain their earlier per-observation notifications. A final notification contains at most ten lines: mission/turn, evidence disclaimer, up to six actionable lines, final flow marker and status command. If the assistant provided a `Telegram-ready summary` heading (including Markdown headings), its progress/evidence/blocker/next-action lines are preferred over arbitrary last lines; otherwise a bounded reply tail is used. Common token patterns and secret-bearing URLs are redacted; this is **not** independent verification. The complete answer stays in ChatGPT. No ChatGPT screenshots are automatically uploaded to Telegram: screenshots have higher disclosure risk, are less searchable and create media-upload state and cleanup complexity. Any future screenshot transport should be strictly opt-in, tab-scoped and private-chat-only.

**Long tasks:** Normal post-Send Playwriter observation is **once every 60 seconds** (local DOM reads, not additional ChatGPT model calls). An apparent final marker is re-read after 3 seconds to confirm stable text. The narrow initial new-tab URL/SPA bootstrap phase checks every 2 seconds for up to 20 seconds; this is not a 60-second model-generation poll. The default per-turn timeout is **60 minutes**, with a **4-hour absolute maximum** and one bounded grace extension only when a visible connection-interrupted banner occurs during a default-length turn. A matching delivery-timeout banner allows at most one click of its exact existing-message Retry button after exact prompt/URL validation, never a second Send. A bounded `[MISSION_RELAY:HANDOFF]` can open a new ChatGPT tab in the same pinned Chrome browser and move the Mission link only after a complete reply is observed there. For a direct new-chat URL that shows no answer after two minutes and no visible generation or interruption banner, the controller may **refresh that exact new tab once**, never re-click Send. Any failure after reservation is ambiguous, requiring operator reconciliation; neither existing tools nor permissions are automatically inherited by the new conversation. A foreground Telegram process started before a new build must be restarted to load that build.

For a completed externally observed new-chat rollover that local observation missed, `browser-recover-rollover <mission-id> --revision <v> --new-url <exact-direct-chat-URL> --acknowledge-side-effects` inspects both approved Chrome conversations (and their prompt/answer hashes) without sending again, then atomically records the validated new conversation and turn. Use it only after inspecting the corresponding ambiguous history; ordinary `browser-reconcile` remains the conservative choice if the new answer cannot be verified.

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
