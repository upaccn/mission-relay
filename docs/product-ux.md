# Mission Relay — product interaction contract

Mission Relay is a single-owner task controller: the person states an outcome,
PI coordinates the approved work, ChatGPT/Playwriter executes, and deterministic
checks plus independently retrieved evidence determine whether it is finished.
One SQLite database and one Windows interactive-user Telegram Worker own all
request, progress, restart and notification state. No web dashboard, approval
queue, second agent scheduler or separate service is necessary.

## Human-facing contract

| Owner action | What happens |
| --- | --- |
| Ordinary Telegram message | Start a read-only PI-coordinated task in a new Chat |
| `/build <task>` | Start a write-capable task in the previously approved repository |
| `/goal <objective>` | Persist a long-term goal and let PI create/approve its work plan |
| `/goal-build <objective>` | Persist an independent Goal in the legacy approved default repository |
| `/goal-build --repo /approved/path <objective>` | Persist a separate Goal with its own explicitly approved repository, work and ChatGPT conversation |
| `/list` | Show tasks requiring attention, with history accessible from the inbox |
| `/status` or `/status 2` | Show the current task or select a numbered task from `/list` |
| `/pause` or `/pause 2` | Stop the current or selected Goal at the next safe checkpoint |
| `/resume 2` | Resume an explicitly paused, settled and independently verified Goal without replaying its prior Send |
| `/goals` and `/goal-status 2` | Use a stable Goal number to read the second Goal, without copying its internal UUID |
| `/help` | Show only common actions; `/help advanced` lists optional diagnostics |

A task description plus its operator-approved repository is the authorization context. The system never treats
untrusted ChatGPT response text as new authority. When a task is active,
additional ordinary owner text is queued for the next PI decision, not submitted as
another browser Send. A new `/goal-build` is instead a **new independent Goal**;
it is durable while another Goal runs, and the single Worker rotates only
after a complete observed Send and committed PI decision. An unresolved
Send blocks switching, never independent intake. Repeating the same active
objective/repository is treated as a duplicate; two approved repositories
can have the same objective without being merged.

## System-owned planning and review

The owner does **not** stage, verify, review or activate the same Goal manually.
Goal intake, first planning observation, PI plan validation, work-item selection,
acceptance review and bounded replanning are internal controller operations.
PI's PASS is a reported assessment, not a production receipt. Business DONE
requires independent evidence and applicable release checks; missing
permissions, unsafe side effects or genuinely unavailable evidence become
an explicit BLOCKED condition, not an endless series of review requests.

A Mission has no fixed turn ceiling. Every Chat is limited to ten durably
observed Relay Sends, requiring an independently verified different conversation
before an eleventh. An ambiguous Send is never reissued automatically. The owner
can pause at any time; in-flight work is observed/reconciled before its lock
is released. Network and model inference retries are local to the existing
observed checkpoint, not permission to duplicate a browser request.

Telegram's default interface is task-first, not an operator console: `/status`
shows the current task and its readable waiting/reviewing/blocked state, round
count, and current Chat budget without identifiers. `/list` uses numbered
task names, read-only pagination and buttons; `/goal-status` defaults to the
latest Goal. Progress is reported after the first and every fifth PI-reviewed
round. A genuinely finished PI task receives one **All Done** message with a
bounded summary; a blocked/paused/unfinished Goal never does. Business release
verification remains explicitly separate. UUIDs, revisions, hashes and raw
errors remain in operator CLI diagnostics and private SQLite audit only.

## Status and notification design

The default view should answer: **What is running? What has been achieved?
What is blocking it? Is a user decision needed?** The Telegram reply carries
a short human summary and a task reference, not a raw audit dump. Technical
SHA-256, event IDs, browser custody, provenance, replays and repair commands
stay in the local CLI or the advanced view. Do not infer progress from a
Telegram poller's heartbeat or a model's claimed DONE.

## Fresh-project baseline

Before first formal use, the operator runs the dedicated
`ResetProjects -ConfirmResetProjects` maintenance action only after an idle
preflight and an atomic drain. It captures a verified private SQLite backup,
stops the enrolled worker and recurring recovery trigger, builds a new database
using the same schema, and migrates only the existing Telegram inbox cursor,
PI host/project, approved write scope and independent ChatGPT launch URL/profile.
All historical Mission/Goal/Plan/Acceptance/Event/command rows are excluded.
A new worker must attest the exact installed SHA and healthy transport under
the original fence before admission. Failure restores the verified original
database; the old snapshot remains private and is never copied into Git.

The browser source is a **configuration**, not a historical Mission. It is
never sent a new request: each accepted owner task opens its own new Chat.
The CLI can re-enroll it with `telegram-anchor --url ... --browser-id ...`.

## Scope control and deliberate omissions

Keep only one writer, one database, one Telegram channel, the configured PI
default model, and replaceable execution adapters. Multi-Goal **cooperative
interleaving** is supported; parallel browser Sends, blind replay, silent
write escalation, password handling in Telegram, or human micro-approvals for
ordinary PI planning are not. Optional native
executor and historical diagnostics need not appear in everyday help.
User-visible complexity is a product defect unless it materially improves
safety or task success.

## Acceptance checklist

- A fresh project starts with zero business records and preserves the Bot API
  cursor, private enrollment, PI route and approved browser profile.
- One normal message can create a read-only task; one `/build` can start a
  code task in the already approved path.
- `/status` and `/pause` work without copying a UUID when unambiguous.
- Five same-Chat Sends are enforced; a 36-turn Mission can continue across Chats.
- A failed reset or upgrade keeps the original project recovery snapshot and
  never releases the maintenance fence without a verified Worker.
- Independent tests, exact-SHA CI on Windows/macOS/Linux, GMK pull-only
  promotion, SQLite integrity and real Telegram health are required before
  claiming production-ready.
