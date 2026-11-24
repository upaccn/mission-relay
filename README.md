# Mission Relay

Mission Relay runs long-lived AI Goals to a verifiable result. You give it a
Goal in Telegram; a PI agent plans the work and reviews every step; ChatGPT
in your own Chrome executes the current work package; one Worker keeps the
whole loop safe, resumable and auditable.

**Node.js 24+ · TypeScript · SQLite · Apache-2.0**

## How it works

```text
Telegram /goal ──► Goal plan (PI) ──► work package ──► ChatGPT executes
      ▲                                                     │
      └──── result / blocker ◄── PI review: PASS · PARTIAL · REPLAN · BLOCKED · WAIT
```

- **Goal-first.** Every task is a Goal with a durable plan, work packages and
  acceptance criteria. The first ChatGPT turn is read-only discovery; PI then
  approves a plan and selects one package at a time.
- **PI decides, ChatGPT executes.** PI reviews each complete ChatGPT answer.
  Passed work is carried forward across re-plans and given back to ChatGPT as
  *established context*, so verified results are not re-audited.
- **Done means done.** A Goal is DONE only when PI passes the final package
  of its approved plan. A ChatGPT "DONE" marker alone never completes it.
- **Blocked means fixable.** A Goal stops only on a real external barrier;
  after you fix it, `/goal-continue` resumes the same Goal without
  re-planning from scratch.
- **No turn ceiling.** A Goal runs as long as it needs; each ChatGPT
  conversation carries at most 8 Relay Sends, then work continues in a fresh
  conversation.
- **Never a duplicate Send.** Every request is reserved with an exact ID and
  prompt SHA before it is sent. An ambiguous outcome is never resent; it is
  verified or explicitly abandoned.

## Install

```bash
git clone https://github.com/upaccn/mission-relay.git
cd mission-relay
npm ci
npm run check
npm test
npm run build
node dist/cli.js help
```

State lives in Node's built-in SQLite under the OS user state directory
(`MISSION_RELAY_HOME` relocates it). No external database, broker or queue.

## Set up

1. Configure the owner-allowlisted Telegram bot and the PI route — see
   [Telegram setup](docs/telegram.md).
2. Enable [Playwriter](docs/playwriter-evaluation.md) in the Chrome profile
   that runs ChatGPT, then pin it: `telegram-anchor --url <chat> --browser-id <id>`.
3. Approve each repository a Goal may change:

   ```bash
   node dist/cli.js telegram-build-project --allow /srv/projects/product-a
   ```

## Use (Telegram)

```text
/goal <objective>                               read-only Goal
/goal-build --repo /srv/projects/product-a <objective>
<plain message>                                 note for the Goal in progress
/goal-continue 2 <what changed>                 continue a blocked Goal
/list · /status 2 · /pause 2 · /resume 2 · /goals · /history
```

Repository approval governs Mission Relay's own authorization and prompts.
It is not an OS-level sandbox around ChatGPT; configure that separately.

## When something gets stuck

```bash
node dist/cli.js recover <mission>      # read-only diagnosis + the one safe next action
```

`recover` then offers exactly three actions, each requiring the current
revision: `--accept-reply` (credit a complete reply ChatGPT already shows,
read twice), `--retry` (clear an error at a settled step after two matching
reads) and `--abandon` (give up an unverifiable request: no credit, no
resend; the Goal becomes blocked for `/goal-continue`).

## Operations

Source checkout, GitHub release and the installed Worker are separate
boundaries. Qualify a release with
`software-release-status --sha <main-sha> --run-id <actions-run>`; deploy the
Windows Worker only through the guarded upgrade in
[Operations](docs/operations.md), which drains, backs up and verifies SQLite.

## Documentation

- [Architecture](docs/architecture.md) — controller, Goal ledger and browser boundaries
- [Telegram](docs/telegram.md) — setup and commands
- [Product UX](docs/product-ux.md) — what the owner sees
- [Browser integration](docs/playwriter-evaluation.md) — Playwriter setup
- [Operations](docs/operations.md) — Windows Worker lifecycle, upgrades, backups
- [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [License](LICENSE)
