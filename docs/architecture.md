# Architecture

## System of record

A **Mission Provider** is the only authority for a given mission. The native provider stores mission state in SQLite through Node's bundled `node:sqlite` API (Node 24+); future external providers (e.g., AIOS) remain authoritative for their own missions. Never copy editable states into a competing database.

The native engine is not an Agent Runtime. It orchestrates bounded turns through an optional **Executor plugin**, with no required coding-agent SDK or model vendor. Agent credentials and actual sandbox enforcement stay with the installed executor, not Mission Relay.

An operator may register or adopt a ChatGPT conversation against a native Mission. This link and audit event never reassign ChatGPT's own state authority. Linked Missions refuse native executor dispatch, but an explicit **Playwriter browser turn** can reserve a local Mission turn, submit through the exact authorized Chrome tab, observe a reply, and pause for human verification. Consequential ambiguity becomes `NEEDS_RECONCILIATION` with no automatic replay. Chrome page text and model-provided flow markers are untrusted; browser observation alone cannot mark `COMPLETED`.

An existing human-started conversation can instead be *adopted*: the latest visible user prompt and answer are read twice to establish a stable initial SHA-256 checkpoint, recorded as `chatgpt.browser_adopted` with **zero Relay sends and zero credited turns**. PI can decide DONE/BLOCKED immediately, or authorize the first Relay Send in the **same** existing tab. There must be exactly one approved Chrome profile, an exact canonical chat URL, no generation, and no other active Mission owning the URL. This does not authorize a generic page click or a new provider.

Playwriter's connected-tab listing is **not evidence of Chrome tab-group membership**. This is no longer a requirement: a locally enabled, profile-pinned browser watcher baselines already-connected ChatGPT dialogs and detects subsequent new/changed human ChatGPT requests, independent of any tag/group. It reuses the Telegram foreground control process and the existing PI and SQLite infrastructure, and never scans DOM content outside recognized canonical ChatGPT conversation URLs. Only Playwriter-enabled tabs are visible, not every Chrome tab. The watcher is not enabled by default, and this new entrypoint requires real Chrome acceptance before deployment.

## State and safety

`READY -> RUNNING -> (PAUSED | BLOCKED | NEEDS_RECONCILIATION | VERIFYING | COMPLETED)`

- Transactional optimistic revisions prevent stale operator commands from changing a mission; a mission transition and its audit event commit together. The native running-state lease blocks duplicate dispatch.
- Every turn records intent, thread/session IDs, result summary and events.
- An interrupted active turn is *not* retried automatically. Reconciliation requires a deliberate operator action.
- Browser-linked Missions require a **pinned** operator-approved Playwriter Chrome instance before even a read-only probe. State-changing browser turns durably reserve the request hash and normalized URL lock. Once the complete assistant answer is observed, SHA-256 covers the **full visible text** while persisted excerpts remain short. Owner `/instruct` notes are injected once into browser continuation and consumed atomically only if unchanged after the dispatch revision; concurrent notes remain pending.
- Browser observation uses a 60-second normal local DOM polling interval with a 35-minute default and 45-minute upper timeout, not model inference or recurring LLM API requests. Short bounded checks are reserved for new-tab bootstrap, reply-load errors and final-marker stability. A Telegram-triggered bounded browser batch emits **one** final compact owner notification, while each intermediate observed turn remains audited in SQLite; ambiguous turns are separately reported. A bounded model-proposed HANDOFF can reserve another turn, open a new tab inside the pinned Playwriter browser context, send a concise new-chat prompt, and atomically update the linked conversation URL together with the observed receipt. A failed migration retains the old link and an uncertain lock, requiring explicit reconciliation; the original chat tab remains untouched.
- A bounded turn count prevents infinite autonomous loops.
- The executor may nominate candidate completion, but a separate read-only verifier must accept it.
- The verifier can still be wrong; model judgment is not a substitute for project-specific deterministic checks.
- Operator-defined checks run as explicit executable/argument arrays (`shell: false`) with a bounded timeout. A write-capable mission cannot reach `COMPLETED` with zero checks or any failing check. Receipts record status and output hashes instead of raw secret-bearing logs. This guarantees only that the configured checks succeeded, **not** that every acceptance criterion was deterministically proven.
- A check's timeout is a **hard failure deadline**, including when its original process exits but a descendant holds inherited stdout/stderr handles open. On timeout the verifier fails closed and stops waiting on the pipes; on POSIX it kills the dedicated verifier process group, and on Windows it requests native `taskkill /T /F` tree termination (then attempts direct termination). Windows cannot reliably discover descendants if their parent has already exited; orphan cleanup is best-effort, not a guaranteed sandbox boundary. This does not authorize running untrusted verifier commands or claims of unattended Windows process isolation.
- SQLite schema v2 adds checks configuration; schema v3 adds durable channel command de-duplication. Schema v1/v2 are migrated transactionally without discarding existing mission state.

## Adapters

The built-in engine and experimental Telegram channel retain evidence from the historical 2026-11-04 read-only Codex pilot, but Codex is now an optional separate plugin. Future adapters implement versioned contracts without modifying core state transitions:

- `Executor`: initialize/resume a session, run a turn, receive events.
- `MissionProvider`: retrieve, watch and command native or external missions.
- `Channel`: receive authenticated human commands with request IDs and expected mission revisions, enforce risk restrictions and publish notifications.
- `ComputerUse`: start/revoke interactive browser or desktop handoff.
- `Verifier`: provide trusted deterministic evidence and/or independent model review.

The public package has no AIOS dependency. AIOS is an optional provider and should not duplicate its authoritative state.
