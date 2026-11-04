# Telegram (experimental, optional)

The Telegram adapter is a single-user **foreground process**. It uses the official Bot API's long polling and requires no public webhook or inbound port. It is not enabled by default. Telegram Bot chats are not end-to-end encrypted; do not send tokens, customer records, browser sessions or confidential model output to this channel.

## Setup (manual, local)

1. Create a private bot with Telegram's official `@BotFather` and obtain its Bot API token. **Never commit the token or paste it into chat.**
2. Send `/start` to your bot from your own Telegram account.
3. Set `MISSION_RELAY_TELEGRAM_BOT_TOKEN` privately in the process environment and run `node dist/cli.js telegram-identify`. Identify your private `userId` and `chatId` (both positive numeric identifiers). Do not trust a user name or forwarded message to establish ownership.
   In PowerShell 7, use `$env:MISSION_RELAY_TELEGRAM_BOT_TOKEN = (Read-Host 'Bot token' -AsSecureString | ConvertFrom-SecureString -AsPlainText)` to avoid entering the token in shell history. Keep this local to the intended terminal session.
4. Set `MISSION_RELAY_TELEGRAM_USER_ID` and `MISSION_RELAY_TELEGRAM_CHAT_ID` to those numbers. Ensure no other bot poller is running.
5. Run `node dist/cli.js telegram` in a terminal. Keep the terminal/session running. Use `/help` in the private Telegram bot chat.

From another terminal you can run `node dist/cli.js channel-status` to verify the poller's process is present, the last durable Telegram update cursor and the last notification event cursor **without printing the Bot Token**.

If the computer uses a local HTTP proxy for Codex's WebSocket traffic, first set `MISSION_RELAY_CODEX_PROXY` in this same terminal (for example `http://127.0.0.1:20808`). The Telegram process forwards it **only** to its Codex subprocess. Restarting the foreground Telegram channel is necessary after changing this setting; no system-wide proxy change is needed.

Do not enable a startup service or publish credentials before an end-to-end mobile test. The current bridge is opt-in, not an unattended-production setup.

## Supported commands

`/list`, `/status <uuid>`, `/handoff <uuid>`, `/continue <uuid> v<revision>`, `/pause <uuid>`, `/resume <uuid> v<revision>`, `/instruct <uuid> v<revision> <text>`, `/cancel <uuid> v<revision>`.

`/handoff` returns a locally linked ChatGPT conversation URL and a manual continuation prompt. `/continue` on a linked Mission executes an optional **Playwriter browser continuation** (up to three turns) in that exact operator-enabled Chrome tab; on an unlinked Mission, it uses the existing Codex executor. There is never silent fallback between the two. **Before remote browser continuation, bind the intended Chrome profile locally using `browser-list` then `browser-bind`; an unbound Mission is rejected without querying Chrome.** See [ChatGPT browser control](playwriter-evaluation.md).

**Revision required:** All mutating commands **except emergency `/pause`** require the current mission revision (for example, `/continue 123e4567-e89b-42d3-a456-426614174000 v0`). First issue `/status <uuid>`; it prints the current revision as `v0`, `v1`, etc. After any state/event change, retrieve the latest revision again. A stale or missing revision is rejected, rather than reinterpreted against a changed mission. `/list` also shows the current revision. `/pause <uuid>` intentionally remains revision-free so a stop request works even while turn events are advancing the revision. This is an intentional protocol change from the initial phone acceptance trial; upgrade the foreground poller before using the new syntax.

**Remote execution is read-only only:** Telegram `/continue`, `/resume` and `/instruct` reject all `workspace-write` missions, including tasks created locally. Use the local CLI for those tasks after reviewing workspace, acceptance checks and Codex sandbox settings. Telegram `/pause` and `/cancel` remain usable to stop eligible write-capable missions, but cannot grant write permission.

For a ChatGPT-linked Mission, `read-only` is a native-engine compatibility field rather than a security boundary in the browser. Playwriter's ordinary Send click can instruct ChatGPT to use the tools already granted to that conversation. Keep the experiment on a designated test chat, do not assume browser sandbox isolation, and use `/pause` to prevent subsequent turns.

`/continue` starts only a READY mission or a manually PAUSED mission. Blocked and ambiguous missions require local inspection. There is **no remote reconciliation or high-risk approval command**.

For linked ChatGPT Missions, `/instruct <uuid> vN <text>` is honored in the *next* continuation prompt rather than silently ignored. The instruction is consumed once only after a complete observed reply, unless another operator revision occurred during dispatch; a newer or repeated instruction remains pending. A failed/ambiguous send preserves instructions. Keep notes under 1,500 characters.

**Compact result feedback:** A linked browser turn sends one text notification of at most ten lines: mission/turn, evidence disclaimer, up to six actionable lines, final flow marker and status command. If the assistant provided a `Telegram-ready summary` heading (including Markdown headings), its progress/evidence/blocker/next-action lines are preferred over arbitrary last lines; otherwise a bounded reply tail is used. Common token patterns and secret-bearing URLs are redacted; this is **not** independent verification. The complete answer stays in ChatGPT. No ChatGPT screenshots are automatically uploaded to Telegram: screenshots have higher disclosure risk, are less searchable and create media-upload state and cleanup complexity. Any future screenshot transport should be strictly opt-in, tab-scoped and private-chat-only.

**Long tasks:** The browser observer runs locally and reduces its DOM-read frequency over time; it does not call ChatGPT again to check whether generation has stopped. The default per-turn timeout is 35 minutes, maximum 45. A bounded `[MISSION_RELAY:HANDOFF]` can open a new ChatGPT tab in the same pinned Chrome browser and move the Mission link only after a complete reply is observed there. Any failure after reservation is ambiguous, requiring operator reconciliation; neither existing tools nor permissions are automatically inherited by the new conversation. The currently running foreground Telegram process must be restarted to load new code.

For a completed externally observed new-chat rollover that local observation missed, `browser-recover-rollover <mission-id> --revision <v> --new-url <exact-direct-chat-URL> --acknowledge-side-effects` inspects both approved Chrome conversations (and their prompt/answer hashes) without sending again, then atomically records the validated new conversation and turn. Use it only after inspecting the corresponding ambiguous history; ordinary `browser-reconcile` remains the conservative choice if the new answer cannot be verified.

## Delivery and recovery

- Only messages in the allowlisted private chat from the allowlisted numeric Telegram user ID are accepted.
- A Bot API batch is processed in update-ID order. Malformed messages with a valid update ID are skipped and their cursor advanced instead of blocking all later commands.
- Each Telegram update ID is reserved in SQLite **before** any action, so duplicates cannot trigger a second mission run.
- After a crash between reservation and action, the command is marked uncertain and reported; it is not replayed. An interrupted command **may already have caused side effects**. Inspect authoritative status and external effects before issuing another command.
- Replies are persisted and retried until acknowledged by the Bot API. Telegram delivery can still be duplicated if the process dies after sending but before marking the reply delivered; the *command* remains at-most-once.
- Terminal mission states are notified on a best-effort basis. Messages contain task IDs and status, not full tool output.
- The initial live pilot emitted both a direct `COMPLETED` reply and a `verification.accepted` notification; this redundancy has been removed. After a new code version is loaded, terminal status is reported **once from the durable event stream**. Historical messages remain unchanged. Since a message send and the local cursor update cannot be committed atomically with Telegram, rare duplicate notifications remain possible after a crash, but never duplicate a command.
- Disconnecting Telegram never grants the model additional permissions or changes the mission's authoritative state.
- Channel credentials are not propagated to Codex or verification subprocesses. Child environments intentionally allowlist only necessary operating-system variables and (for Codex) explicit Codex authentication variables.

Telegram is a control channel: it does not receive browser JavaScript, ChatGPT cookies or raw session data. The optional linked browser executor runs on the GMK3 Chrome host.
