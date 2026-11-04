# Playwriter → existing Chrome ChatGPT conversation (experimental)

Status: **attended browser adapter passed real post-fix Telegram → Chrome ChatGPT → complete durable receipt with matching final response hash**. Real browser two-turn CLI NEXT/DONE, post-send foreground restart, local relay reconnect, manual recovery from an in-flight relay failure and **owner-disabled/re-enabled Playwriter tab permission with fail-closed access** also passed. Browser reconciliation is a single atomic SQLite transaction with failure-injection regression tests. The broad issue's separate arbitrary remote click/type/scroll and browser-wide permission-scope aspirations are not claimed tested. Unattended production operation and independent business-goal verification are **not** certified. The user's specific test target is not embedded in this public document. No credentials, browser profiles, real prompts or private task records belong in Git.

## Architecture and upstream

Playwriter is a **pinned package dependency** (`playwriter@0.9.0` from npm), but the browser integration is optional to **activate** and never starts when running ordinary native/Codex missions. This avoids npm silently omitting the module on Windows. It connects to the **already running Chrome** via the official extension, local loopback relay, and `connectViaExtension()`. No patched Playwriter fork, browser-profile copy, public tunnel, second database or bespoke automation daemon.

Upstream:

- <https://playwriter.dev/docs/installation>
- <https://github.com/remorses/playwriter>
- <https://chromewebstore.google.com/detail/playwriter/jfeammnjpkecdekppnclgkkffahnhfhe>

The browser adapter is independent of Codex. The Mission SQLite store owns request reservation, revision checks, bounded turns and recovery. Playwriter only performs visible page operations. Telegram `/continue <id> vN` routes linked missions to Playwriter and unlinked missions to the Codex adapter.

## Architecture decision: scoped ChatGPT continuation versus generic remote gestures

Verified against Playwriter's [installation](https://playwriter.dev/docs/installation), [Remote control security](https://playwriter.dev/docs/remote-control) and [remote access](https://playwriter.dev/docs/remote-access) documentation, and Microsoft's [Playwright MCP security guidelines](https://learn.microsoft.com/en-us/azure/app-testing/playwright-cloud-browsers/how-to-playwright-workspaces-remote-mcp):

| Path | What it actually solves | Decision |
| --- | --- | --- |
| **Pinned local `connectViaExtension()` plus Mission SQLite** | Existing authenticated ChatGPT tab, one-shot Send, durable receipt, bounded NEXT/DONE, manual reconciliation and Telegram owner controls | **Chosen** for Mission Relay's actual primary goal; does not add a second relay or browser runtime |
| **Playwriter's own Remote control** | Operator-initiated, secret-link remote access to an enabled tab including click, type, scroll and screenshots | **Reuse upstream** for occasional general-purpose remote gestures, only after separate explicit sharing approval; the link is a credential and the remote viewer may see tab data, network and storage. Not a replacement for Mission Relay's durable at-most-once mission semantics |
| **Expose the full Playwriter relay over a tunnel** | External client control over every enabled tab with relay credentials | **Not enabled** in this project; expands the browser authority and network attack surface without solving any current ChatGPT continuation acceptance gate |
| **Build Telegram `/click`, `/type`, `/scroll` / arbitrary selector or JS commands** | Generic browser automation from chat without a dedicated Playwriter remote session | **Defer**: duplicates upstream, introduces separate selector/state/permission policy and weakens exact-conversation authority; no verified user requirement presently warrants the added component |

The early broad GitHub issue #3 mentioned mobile click/type/scroll and browser-wide permission analysis. The evidence here validates the **pinned existing-ChatGPT route and revocation of its exact authorized tab**, not generic gestures nor all-browser permission semantics. Keep those broader assertions explicitly unverified until a separately authorized native Remote control pilot is observed. Any future generic command bridge requires a distinct threat model, explicit action-level authorization and post-action verification before implementation; do not silently broaden `/continue`.

## GMK3 initial setup

1. Keep the existing GMK3 Chrome user session; do **not** copy browser profiles or restart Chrome with remote debugging.
2. Install the official Playwriter Chrome extension (one-time human confirmation from the Web Store). On the intended ChatGPT conversation tab, click its icon so the tab is enabled / icon turns green. You must enable **this tab** rather than a random Chrome tab.
3. In the Mission Relay checkout: `npm ci && npm run build`.
   On the tested GMK3 host, stale npm proxy configuration used port 10808 while the real loopback proxy listened on 20808. For that host, use per-invocation flags rather than modifying global npm configuration:

   ```powershell
   npm ci --proxy=http://127.0.0.1:20808 --https-proxy=http://127.0.0.1:20808 --no-audit --no-fund
   npm run build
   ```
4. No additional Playwriter service is necessary: the official client starts its own local loopback relay if needed. The adapter sets `PLAYWRITER_AUTO_ENABLE=false`, so an unattached Chrome window does **not** receive a newly controlled blank tab.
5. **Always bind a browser profile before any ChatGPT browser read or send**, including on single-profile hosts. Never assume the correct account from a profile email or let a Telegram command implicitly choose a different Chrome profile.

   Explicitly bind the verified profile to the Mission so that **Telegram and local commands are equally constrained**:

   ```powershell
   node .\dist\cli.js browser-list
   node .\dist\cli.js browser-bind <mission-id> --browser-id <listed-id> --revision <current-version>
   ```

   `browser-list` only reports browser ID, brand, active tab count, and extension version; it never prints profile emails. `browser-bind` requires the selected ID to be connected, records a revisioned audit event, and refuses rebinding during an interrupted browser send. **Unpinned local browser-probe/send/drive and Telegram /continue now fail closed before accessing Chrome.** Bound operations remain pinned after extension reconnects.

## Configure one existing ChatGPT conversation

Create a Mission with an explicit URL (example placeholder only):

```powershell
node .\dist\cli.js chat-create --goal "Continue the current project" --accept "Produce inspected evidence and clear next steps" --url "https://chatgpt.com/c/<conversation-id>" --max-turns 30
```

Record the resulting Mission UUID. Then:

```powershell
# Required once for each Mission before any browser operation
node .\dist\cli.js browser-list
node .\dist\cli.js browser-bind <mission-id> --browser-id <approved-browser-id> --revision <current-version>

# Read-only: confirms the exact URL, visible message counts and composer state
node .\dist\cli.js browser-probe <mission-id>

# A reviewed one-shot prompt, sent at most once for this request key
node .\dist\cli.js browser-send <mission-id> --revision <current-version> --request-key pilot-001 --prompt-file ".\prompt.txt" --timeout-ms 180000

# Bounded repeated continuation in the SAME ChatGPT conversation
node .\dist\cli.js browser-drive <mission-id> --revision <current-version> --request-prefix pilot-002 --turns 3
```

From the owner-allowlisted Telegram chat: `/status <mission-id>`, then `/continue <mission-id> v<revision>` initiates up to three sequential browser turns. `/pause <mission-id>` prevents dispatch of a *subsequent* turn; it cannot forcibly cancel a ChatGPT turn already sent.

`/instruct <mission-id> v<revision> <text>` inserts a **single-turn** owner instruction into the next browser-drive prompt. When the response is durably observed and no newer Mission revision was issued in the meantime, the injected note is consumed atomically with the observed receipt. An instruction added or repeated during an in-flight browser turn is **preserved** for subsequent execution. A raw `browser-send` does not silently consume instructions it never injected. An ambiguous dispatch never consumes an instruction. Owner notes longer than 1,500 characters and browser prompts longer than 12,000 characters are rejected before browser reservation.

The default continuation prompt asks the ChatGPT conversation to conclude each answer with exactly one of `[MISSION_RELAY:NEXT]`, `[MISSION_RELAY:BLOCKED]`, or `[MISSION_RELAY:DONE]`. These are **flow-control hints**, not verifiable proof. Any missing or blocked marker stops the loop. `DONE` also stops, leaving the Mission `PAUSED`, not `COMPLETED`, until acceptance evidence is independently reviewed.

### Long-running replies and new-conversation rollover

- Browser completion is observed by **local Playwriter DOM polling**, not by repeatedly asking ChatGPT to regenerate or summarizing text through a second AI model. The original 650-millisecond interval was replaced with adaptive observation: 1 second initially, then 2.5/5/10/15-second checks as execution exceeds 10 seconds, 1, 5 and 15 minutes. Once a plausible complete answer and final marker are visible, checks accelerate to 650 milliseconds for a stable 2.5-second final observation. Individual turns default to **35 minutes**, configurable up to **45 minutes**. This decreases the number of browser inspections for 5–30-minute tasks without introducing a new service. If the extension disconnects after Send, the outcome is ambiguous and will never be blindly replayed.
- When the existing context is too long, the assistant may return a self-contained, evidence-aware summary ending with `[MISSION_RELAY:HANDOFF]`. If the current command **and Mission turn budgets allow another turn**, the controller reserves a second unique request key, uses Playwriter `context.newPage()` in the existing pinned Chrome profile, opens the ChatGPT home page in that new tab, and sends a compact continuation prompt including goal, acceptance criteria, prior handoff and fresh permission limits. It follows the **actual ChatGPT-generated new conversation URL**, waits for its complete final reply, and atomically writes the newly observed exact URL plus reply receipt to the Mission SQLite record. The previous browser tab remains open. Neither the model's desire for handoff nor its asserted facts grant new tool permissions.
- If the extension cannot open the new tab, the first prompt is already submitted but the new chat cannot be confirmed, or the relay disconnects, the Mission enters `NEEDS_RECONCILIATION`; the current linked URL remains unchanged and the original request key cannot be reused. If the turn budget is exhausted, the controller reports `HANDOFF` without opening a tab. For an ambiguous migration whose reply **did complete externally**, the local `browser-recover-rollover` command requires explicit side-effect acknowledgement and independently checks both old and new authorized conversations, reconstructs the original reserved prompt SHA and the visible new user text, verifies a stable final assistant answer, then atomically updates the Mission link, round and final SHA; it cannot replay. An actual Chrome pilot confirmed this recovery path. The live observer also tolerates up to 20 seconds of read-only transitional new-chat URL states (no off-origin DOM access or new Send) and detects a stable ChatGPT response-load failure. After that fix, **a separate real two-turn HANDOFF → automatic new Chrome ChatGPT tab → final DONE reply succeeded without recovery**, with two unique reserved+observed request keys, one atomic migration event, exact new URL and matching independent full-response SHA. This is an attended, bounded text-only test—not unattended production-ready or proof that a model-proposed handoff is factually correct.
- The owner-only Telegram notification includes the Mission ID, observed turn number and the last 8 short nonblank lines from the recorded reply, plus `/status`. The prompt requests a short end-of-response progress/evidence/blocker/next-step summary before its final flow marker. Recognizable credential patterns are redacted. This avoids screenshot permissions and preserves searchable text. **Screenshots are not sent automatically:** a screenshot may expose unrelated on-screen personal content and Telegram bot chats are not end-to-end encrypted; use a separately approved, opt-in image workflow if necessary.

## Exact behavior / recovery

- The adapter does not create, navigate or close browser tabs. It finds exactly one enabled tab matching the locally registered full ChatGPT URL, otherwise refuses execution. No generic eval JavaScript, arbitrary browser script from Telegram, hidden API calls or cookie reads.
- It observes the existing assistant/user message counts, a single visible composer, and generation-stop button. It submits through the normal composer and Send button, then waits for a new assistant message to stabilize and generation to stop. For Mission-generated continuation prompts that demand a final status marker, it also requires the final `[MISSION_RELAY:NEXT]`, `[MISSION_RELAY:BLOCKED]` or `[MISSION_RELAY:DONE]` line. This is a **stream-completion heuristic**, not independent acceptance verification; a missing marker causes an ambiguous observation requiring inspection, not a blind resend.
- ChatGPT can virtualize old messages in the DOM as a conversation grows, and the visible number of user/assistant headings can **decrease** between sending and observing. The observer therefore correlates the newest visible user message with the exact submitted prompt, and checks that the newest assistant text changed and stabilized with the final marker; counts are still diagnostic but no longer required to grow. This was fixed after a real Telegram-originated message received a complete ChatGPT answer but timed out under the old count-based logic. The failed Mission was manually reconciled rather than resent. A separate real CLI-driven turn with the updated adapter passed and matched its final receipt hash.
- Chrome's current ChatGPT UI differs from older tutorials: authenticated Playwriter inspection on GMK3 found accessible headings `You said:` and `ChatGPT said:`, one `textbox "Ask ChatGPT"`, and no `data-message-author-role` or `#prompt-textarea`. The adapter supports both DOM variants. The dynamic Send button was exercised successfully via the actual Telegram-to-Playwriter route, resulting in one new user message and one new assistant message. The original observed hash was from **partial streaming content**, which later differed from the final stable page; hence the stricter final-marker guard and regression test.
- Before clicking Send it durably reserves `requestKey` and the SHA-256 of the prompt. Each request key is permanently single-use for that Mission. It calculates the observed response SHA-256 from the **complete visible reply** (not merely its last 4,000 characters). SQLite summaries and CLI excerpts remain bounded; it never stores raw browser credentials. Deterministically invalid prompt length and timeout fail before reservation.
- Read-only `browser-probe` now also exposes `lastAssistantSha256` over the **complete** current answer while limiting `lastAssistant` to its last 600 characters. An operator can independently compare this hash to the Mission's saved `chatgpt.browser_observed` event without disclosing the full model response.
- An atomic lock keyed by the normalized conversation URL prevents **multiple Missions from writing to the same ChatGPT conversation simultaneously**. The lock releases on an observed reply, or after explicit reconciliation of an ambiguous send; process crashes cannot silently unlock it.
- If the connection fails **before** reservation, no Mission state changes. If there is any failure **after** reservation, state becomes `NEEDS_RECONCILIATION` or stays `RUNNING` after a process crash, and no retry occurs. Inspect the actual conversation and external side effects; then use `browser-reconcile <mission-id> --acknowledge-side-effects`. It never resubmits the previous request.
- The explicit browser-reconcile command now performs the Mission pause, status reconciliation, conversation-lock release and two audit events **atomically**. An injected SQLite event-write failure must roll back the entire operation, retaining the uncertain state and lock. Older Missions left PAUSED by a pre-upgrade interrupted two-step reconciliation can still be finalized. Never manually clear the lock or call generic Mission reconciliation to bypass the browser-specific flow.
- Only the current operator-approved revision can start a turn. A Telegram request reserves its own update ID; new requests do not reuse prior dispatch IDs.
- UI changes may invalidate selectors. Fail closed and update tested selectors; do not loosen URL scope or access a private API as a workaround.
- Browser control cannot grant the ChatGPT conversation new permissions. Actual high-risk actions still need explicit operator authorization.

### Attended local relay recovery

The official Playwriter relay runs on the same host as Chrome and can be restarted independently; the extension reconnects to a newly available relay. A verified GMK3 smoke stopped **only the confirmed project-owned relay process** on local port 19988 while all Missions were inactive, then used `browser-list` to auto-start a new relay. A read-only probe recovered the original bound Chrome tab with its message counts and durable Mission state intact. Never use a broad process-kill command or stop the Telegram poller/Chrome for this recovery. First confirm the exact owning PID and command line, absence of running browser Missions, and the expected listening port; after restarting, inspect `browser-list`, `browser-probe`, `channel-status`, `show` and `events` before dispatching any turn. This is not a test of manually disabling/revoking the browser extension during an in-flight send.

One separate, intentional **in-flight** failure test stopped that project-owned relay *after the new user message appeared in the actual test chat*. The controller saved `NEEDS_RECONCILIATION` and a durable uncertain event rather than resending. After a fresh read-only probe verified the visible assistant's final answer, the operator invoked `browser-reconcile --acknowledge-side-effects` once. The original request key and uncertain event remain auditable; the chat did not receive a duplicate prompt. In the original CLI process, an additional failed `session.close()` had overwritten the useful dispatch error with `fetch failed`. The current source treats cleanup as best-effort and preserves the primary exception, tested with a synthetic regression. This **does not** establish behavior for Chrome extension permission revocation or whole-browser exit.

### Completed operator-mediated extension revocation test

This acceptance gate cannot be substituted with a relay restart or a wrong-URL test. Playwriter's [official installation guide](https://playwriter.dev/docs/installation) states that only explicitly enabled tabs are controllable, and its [session guide](https://playwriter.dev/docs/sessions) describes disconnecting a tab by dragging it out of the Playwriter tab group.

1. With **no Mission in RUNNING** and no pending Telegram replies, record `channel-status`, `browser-list`, `browser-probe <test-mission-id>`, `show` and `events`. Do **not** send or resume any Mission during the test.
2. The operator, in the previously approved Chrome test conversation, disables Playwriter for **only that tab** using the extension icon, or drags the tab out of its Playwriter group. Do not uninstall the extension, touch Chrome profiles, or disable another user's tab.
3. Run `browser-list` and the same read-only `browser-probe`. **Required result:** the exact target tab is no longer accessible; the probe fails closed and neither a ChatGPT message nor a Mission reservation/event is created. If the old authorized tab is still accessible, record the incident and stop; do not send a prompt.
4. The operator re-enables Playwriter on the same test tab. Re-run `browser-list` and `browser-probe`, comparing browser identity, exact ChatGPT URL, visible last reply, event count and Mission version to the baseline. Require restored access with **zero** unsolicited submissions. The CLI may start a local relay; this is not permission to auto-enable other tabs.
5. Record the actual before/disabled/re-enabled readbacks in the private local evidence and mark the gate passed only when every observation matches. Only then consider a distinct explicitly authorized benign send with a fresh request key; never replay a historical request.

**Actual 2026-11-04 readback:** Before disable, the target conversation was accessible with one enabled tab, a stable finished answer and PAUSED v4/turnCount 1. Immediately after the operator disabled Playwriter, `browser-list` reported zero enabled tabs and `browser-probe` failed nonzero (`found 0`). After the operator re-enabled the same target tab, the exact conversation became probe-accessible again, with 5 visible user and 5 assistant turns and an unchanged final-answer hash matching the previously persisted receipt. At both checkpoints, Mission version, turn count, all five events, Telegram cursor and pending replies were unchanged; no new send was attempted. The first post-reenable list showed a transient count of two enabled tabs; a repeat list showed one. No other tab was opened or inspected. This confirms target-tab revoke/re-enable and no-replay behavior, **not browser-wide scope for other tabs**.

## Test gates

| Gate | Status |
| --- | --- |
| Optional client module compiles | Tested locally |
| Synthetic page composer and response observation | Tested |
| Durable request reservation, crash/restart and no duplicate sends | Tested |
| Single writer across different Missions targeting the same chat | Tested |
| Loop marker stop/continue behavior | Tested |
| GMK3 Windows and VPS Linux builds / isolated smoke | **82 tests passed on both hosts; three-OS CI passed for c1181f4 and 0fb8e6d** |
| Existing GMK3 Chrome Playwriter extension handshake | **Passed, target Chrome profile selected** |
| Read-only probe of exact target ChatGPT conversation | **Passed, real messages and ready composer observed** |
| One actual ChatGPT prompt and observed reply | **Passed once via Telegram; original early receipt defect found and fixed in new source** |
| Updated final-marker guard with a simulated long stream pause and missing-marker failure | **Passed regression tests; updated local CLI exercised on real Chrome** |
| Readback of the historical saved receipt vs full final reply | **Hash mismatch confirmed; historical event preserved** |
| SQLite close/reopen of observed receipt and no-replay key | **Passed automated test and separate local CLI readback** |
| Post-send Telegram foreground restart without replay | **Passed; original event/revision and browser message counts preserved** |
| Two or more consecutive real turns without duplicate messages | **Passed via local CLI: NEXT then DONE, distinct durable receipts** |
| Post-run response hash, at-most-once request key, and final page counts | **Passed on live tab; duplicate key rejected with no state change** |
| Wrong bound browser profile, stale revision and wrong exact URL | **All rejected in live environment; no send or state change** |
| Project-owned local Playwriter relay restart and Chrome reconnect | **Passed; new relay PID, same bound authorized tab, unchanged message/event state** |
| Real post-send relay failure and conservative manual reconciliation | **Passed; user message observed, durable uncertain state, complete visible reply, no replay, manual unlock** |
| Browser cleanup error preserves primary dispatch failure | **Passed synthetic regression test; updated error display not yet re-fault-injected** |
| Telegram dispatch after process restart | **Real send/reply reached ChatGPT; old observer false-timed-out due decreasing DOM counts, reconciled without replay** |
| Observer handles shrinking DOM turn counts | **Synthetic regression test passed; subsequent real CLI send/receive observed and hashed** |
| Post-fix Telegram-originated durable complete reply | **Passed live: one reservation and observed event, final assistant SHA-256 matches page, no replay** |
| Atomic browser reconciliation, CLI guard and injected SQLite failure rollback | **Four targeted tests, full 72-test suite and 3-OS CI passed** |
| User-disabled/re-enabled Playwriter on exact authorized Chrome tab | **Passed live: 1→0→1 enabled tabs, target probe denied then restored, DB events/hash unchanged** |
| Pinned profile required for all browser reads/sends and Telegram browser continuation | **Synthetic/CLI tests pass on Windows/Linux; requires next foreground Telegram reload for live enforcement** |
| One-shot owner instruction and concurrent-new-instruction preservation | **Synthetic regressions and live owner-triggered Telegram→Chrome single-turn test passed; exact reply SHA matched and instruction cleared once** |
| Full-length reply SHA-256; bounded stored excerpt and hash-only readback | **Long-answer regression passes Windows/Linux and three-OS CI; read-only live probe hash matches historical receipt** |
| Adaptive observation and 35–45-minute single-turn timeout | New deterministic interval tests; full multi-minute real browser task not yet completed |
| Telegram reply-tail notifications | New fake-channel tests for last-eight-line text, no repeat, and obvious credential redaction; live foreground Telegram reload still required |
| HANDOFF → new tab → new ChatGPT reply → atomic Mission link migration | **Synthetic success/failure/budget/rollback and fully automatic real two-turn test passed** |
| Bounded transitional new-tab URLs and reply-load failure | Synthetic tests passed; first two live attempts exposed transient failures and conservative no-replay recovery |
| Independent completed new-chat receipt recovery | Passed live: original request SHA, exact new user prompt, stable final reply, atomic URL update, two rounds, no replay |
| Fully automatic old-chat HANDOFF → new ChatGPT conversation DONE | **Passed live:** two reservations, two observations, one migrated URL, final SHA matches read-only new tab, no manual recovery |
| Generic Telegram-driven arbitrary click/type/scroll and browser-wide permission-scope tests | Not implemented or verified as general capabilities; outside the validated ChatGPT continuation path |

The bounded **attended** Telegram-to-Chrome ChatGPT continuation path has real acceptance evidence, including permission revoke/re-enable, conservative ambiguous-reply recovery and no-replay guards. **Do not label it general-purpose browser remote control, independently verified mission completion or unattended production-ready.**
