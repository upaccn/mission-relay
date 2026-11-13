# Changelog

## 1.1.4 — 2026-11-13

- Increase per-ChatGPT-conversation capacity from five to ten durably observed Relay Sends; the eleventh must open a distinct observed Chat URL, retaining no-replay and PI review protections.
- Align independent Chrome rollover verification with 10→11 while retaining read-only legacy 5→6 custody evidence.
- Preserve the existing cooperative pause, atomic maintenance drain, isolated SQLite restore and rollback requirements for GMK deployment.

## 1.1.3 — 2026-11-13

- Fix a long-running Windows Task Scheduler defect discovered from repeated 00:04 Event 111 task terminations: a daily two-minute recovery trigger inherited `StopAtDurationEnd=true` despite `ExecutionTimeLimit=PT0S`. Explicitly set `StopAtDurationEnd=false` to keep the enrolled Worker running through midnight.
- Make `UpgradeSchedule` migrate existing tasks with an unsafe stop-at-duration-end flag even if their two-minute trigger already exists; validate the updated trigger, unchanged Worker PID, and recovery schedule in read-only Status output.
- Protect already-submitted Mission turns: repairing the scheduled task never sends, retries, deletes, or modifies the original browser reservation. Use the existing guarded Chrome recovery route to inspect any previously stranded new-chat request.

## 1.1.2 — 2026-11-12

- Recognize ChatGPT's actual `Error in message stream` UI control (including its optional period) only in the exact visible Retry control group, rather than from generated prose.
- Use the same SQLite one-shot Retry intent for both stream errors and delivery timeouts, including a new ChatGPT conversation's first message. Never retry the composer Send; interrupted or uncertain first-new-chat Sends remain fail-closed.
- Extend the single enrolled Worker's timed-out original-chat recovery to stream errors, with prompt hash, exact URL, unspent reservation, stable final answer and PI review gates unchanged.
- Regressions cover successful Retry, cross-error one-shot deduplication, wrong/quoted UI refusals, original-message and new-chat pathways.

## 1.1.1 — 2026-11-12

- Persist a single original-request delivery Retry intent before clicking ChatGPT's exact visible `Retry` button. Worker crashes, reattachment and ambiguous click completion cannot trigger another Retry or composer Send.
- For a timed-out original same-chat Send, the enrolled Telegram Worker can read the original pinned tab, retry that submitted message once if eligible, and independently recover its twice-stable final-marked answer before PI continues. Wrong tabs, changed prompts, unrelated failures and maintenance drains remain blocked.
- Add deterministic positive and negative regression tests for retry intent deduplication, original-answer recovery and changed-prompt refusal. Software release still requires exact-SHA CI; GMK promotion remains subject to its independent maintenance gates.

## 1.1.0 — 2026-11-11

### Product and workflow

- New PI Missions have no fixed Mission-level turn ceiling. The five-observed-Send limit per Chat remains enforced; legacy finite-limit Missions retain their saved behavior.
- Goal planning, plan validation, work-item selection and PI review are system-owned. The former user-facing stage/verify/review/activate workflow is removed.
- Telegram `/status` defaults to the latest non-archived Mission. `/pause` can omit its UUID only when one eligible active Mission is unambiguous.
- The approved ChatGPT launch URL and Chrome profile are stored independently from any Mission, so a fresh project does not depend on historical task records.

### Operations and recovery

- Adds the explicit, one-time Windows `ResetProjects -ConfirmResetProjects` operation for pre-production history cleanup. It requires an idle preflight and atomic drain, captures a private SQLite backup, independently restores it, rebuilds the same supported schema without project rows, preserves owner connection configuration and the Telegram inbox cursor, then verifies the replacement Worker before releasing maintenance.
- The reset refuses unsupported SQLite schema objects and checks every Mission, Goal, Acceptance, dependency, release, owner-directive and command table for emptiness.
- Documents the human-facing interaction contract and the safe first-project baseline.

### Compatibility and quality

- CI now tests Node.js 24 and 26 on Ubuntu, Windows and macOS (six matrix jobs).
- Runtime remains Node.js 24+; the GMK deployment runs Node.js 26.
- Legacy finite-limit Mission records and their historical successor evidence remain readable.

### Known dependency audit

- At release qualification, `npm audit --omit=dev` reports seven **moderate** transitive advisories in the pinned Playwriter 0.9.0 dependency tree; no high or critical advisories were reported.
- The suggested Playwriter 0.5.0 downgrade is a breaking browser-integration change, not a safe patch. The pinned integration is retained until an upstream-compatible update can be qualified against the actual Chrome extension, tab custody and recovery paths. Re-run the dependency audit when updating Playwriter.

## 1.0.0 — 2026-11-11

- Initial public v1.0 baseline and exact-SHA, three-platform release qualification.
