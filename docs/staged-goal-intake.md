# Independent Goal intake — staged, zero-turn, owner-gated

This describes the **source implementation** in `src/core/staged-goal-intake.ts`,
`src/core/staged-goal-baseline.ts`, `src/plugins/telegram.ts`, `src/core/pi-planner.ts`, and the independent
negative tests in `tests/staged-goal-intake.test.ts`. It does **not** authorize
a GMK deployment, restore historic PAUSED Missions, resend a historic browser
request, or accept v1.0. A dated 2026-11-09 read-only production sample did
attest a new independent staged zero-turn checkpoint, seven source digests,
matching PI review and subsequent separate owner activation. The first
production Send was **reserved, not credited** at that sample; this does not
establish completed work, release readiness or safe maintenance. Always
resample the original single Windows Worker and private SQLite before acting.

## Owner protocol (single existing, authenticated Telegram Worker)

1. `/goal-stage <objective>` stages a read-only Goal; alternatively
   `/goal-stage-build <objective>` binds the *already locally approved*
   `telegram.build.project == telegram.pi.project` workspace. Neither route
   changes the PI model selection, accesses Chrome, connects to PI, reserves
   a browser Send or consumes a turn. A previously existing active Mission
   does **not** prevent holding a new independent Goal.
2. `/goal-verify <goal-UUID>` independently rereads the private SQLite
   Goal/Mission association, source owner/update ID, browser-profile scope,
   original event series, Mission revision/state, Goal revision, zero turns,
   zero browser reservations, zero parent inheritance and unchanged checkpoint
   SHA-256. It is read-only; changed state produces `CHANGED`, not approval.
3. `/goal-review <goal-UUID>` first collects **seven first-party read-only
   operational witnesses**, before any PI invocation: the authenticated
   controller/held stage, verified GitHub `main`, exact-SHA three-platform
   successful push CI, installed compiled Worker and its enrolled task/lease,
   separately opened read-only SQLite integrity and original-request event
   digests, physically connected pinned Chrome tab inventory, and the healthy
   operator-managed host `pictl` default-inference invocation. The collector refuses a dirty or
   divergent GMK checkout, missing `gh` credentials, mismatched CI, unavailable
   Chrome anchor, unhealthy Worker or PI, or a changed stage. It never performs
   a browser Send, Retry, navigation, restart, PI model override or activation.
   The redacted underlying readbacks are kept in the owner-private
   `stage-baseline-evidence/<sha256>.json` directory, never Git. A separate
   append-only `goal.stage_baseline_attested` event records all **seven**
   source-specific evidence SHA-256 digests and their combined, original
   staged-checkpoint-bound `baselineSha256`. A changed/forged baseline pointer
   must fail an independent SQLite readback; replacing a still-fresh approved
   baseline is prohibited. A baseline older than 15 minutes cannot enter a
   new formal PI review until independently refreshed. Synthetic test data
   can exercise this contract, but cannot constitute a real production witness.
4. Only after those witnesses pass does `/goal-review` invoke a **tool-free PI inference** inheriting
   the configured operator-managed host pictl default model. PI returns strictly
   `APPROVE`/`REJECT`; the controller rechecks the exact immutable
   checkpoint **after** inference and persists its verdict and response digest
   separately as `goal.stage_pi_reviewed`. The decision is bound to **both**
   immutable `checkpointSha256` and `baselineSha256`; replacing either while
   PI is thinking fails closed. The independently returned
   `pictl infer` **envelope** must report actual provider and model, and its
   SHA-256 is retained alongside the SHA-256 of the fixed invocation argv,
   with explicit `modelOverride=false`, `providerOverride=false` and
   `thinkingOverride=false`. A missing, forged-in-prose, or incompatible
   model identity or invocation attestation fails closed: a model's own
   prose claiming a provider is never evidence of the actual model used.
   A mutable review pointer must equal the latest **append-only**
   `goal.stage_pi_reviewed` event on timestamp, checkpoint SHA, verdict,
   result SHA and model/argv receipt; mismatches block readback and activation.
   These fields stay in private SQLite, not Git. This is not a browser-derived
   `goal.pi_review`, a test receipt or Release Gate PASS. A rejected or
   expired review can be repeated; earlier audit events remain intact.
   In the authenticated Telegram flow, a stale `APPROVE` is **not** treated
   as fresh: `/goal-verify` reports `EXPIRED` without printing an unusable
   activation instruction, and a new `/goal-review` collects all seven
   current witnesses and runs PI again. Repeating `/goal-review` while the
   approval remains fresh is read-only and does not duplicate evidence or
   inference. The original stage checksum, zero turns, stop flags and
   historical PI review events remain unchanged.
5. `/goal-activate <goal-UUID> <full-checkpoint-sha256>` is a separate
   authenticated owner command. An approval is valid for 15 minutes and
   must match the **unchanged** original checkpoint and its latest formally
   reviewed operational baseline. A fresh transaction
   rejects wrong owner/hash, revoked build scope, changed approved Chrome
   anchor, owner stop, maintenance drain, active/PI-READY/unreconciled
   Missions, any original `reserved`/`uncertain` browser request, or other
   undelivered Telegram owner commands. Only then does it bind the approved
   source Chrome profile and transition the staged Mission from held PAUSED
   to READY. **Activation itself performs no browser Send or PI call.**
   The original single-Worker recovery scanner may subsequently dispatch
   according to normal PI/browser safety checks.

The staged-Mission hash covers its own Goal/Mission state and pinned Chrome
**identity**; the separately audited operational baseline contains the real
cross-system witnesses. The CI and Worker attestations show exact source and
compiled-tree agreement, not immutable host-memory attestation. Chrome's
unique connected-tab inventory does not establish that an unfinished reply
has completed. The PI default *invocation* proof is separate from the actual
provider/model, which is captured only from the subsequent `pictl infer`
envelope. If any required witness is unavailable, the formal review remains
PENDING; a model statement cannot fill the gap. Never reclassify a
historical BLOCKED Mission, recover an old PAUSED Mission, or replay an
unsettled browser Send as a shortcut to this baseline.

Each staged Mission has `goal.stage.hold.<mission>` and
`pi.autopilot.enabled.<mission>=1` in private SQLite; it starts in PAUSED
with no Chat link. The native Engine cannot acquire it; generic resume
rejects PI ownership; owner-note queueing and browser reservation reject
the hold even if reached directly. Restart does not remove the hold. The
stage payload is bound to authenticated owner ID, original Telegram update
ID, exact goal text, write scope, approved anchor URL **hash** and Chrome
profile. `BEGIN IMMEDIATE` and existing Goal/Mission request-key uniqueness
prevent duplicate creation across independent SQLite handles. No second
Worker, daemon or database was introduced.

The isolated tests exercise stage/verify/baseline/review/activate, owner rejection,
same/conflicting idempotency key, multiple SQLite handles, injected Goal
binding failure with transaction rollback, checkpoint change during PI
inference, stale/rejected review, explicit review renewal, active/PI-READY
and original reserved-Send conflicts, owner stop and drain, revoked workspace,
restart hold and zero browser calls. They use temporary SQLite and synthetic
transport only. They additionally reject missing actual-model metadata,
non-default invocation flags, and a mismatch between the PI review
result's declared argv digest and the controller's invocation policy.
Synthetic seven-dimensional digests and provider/model identifiers are not
live PI attestation. An expired or replaced baseline requires a fresh PI
verdict and retains prior append-only events. A staged Goal may coexist with
an unrelated original reserved Send but **cannot activate** while that Send
is unresolved. These guarantees do not authorize a GMK upgrade before the
real maintenance restart/drain preflight permits it.
Historical stop flags are preserved; an **unrelated old
owner-paused** Mission is not silently unpaused or reinterpreted as a global
prohibition on safe future goals. Real GMK runtime activation, Chrome custody,
rollback drill and final PI work acceptance remain separate release evidence.

Run:

```sh
node --import tsx --test tests/staged-goal-intake.test.ts
npm run check
npm run privacy-check
npm test
npm run build
git diff --check
```

**Source-admission rule:** only source commits passing their own GitHub main
Ubuntu/Windows/macOS CI can be considered for a later explicitly approved
GMK pull-only Upgrade. Even a successful CI does not authorize execution
against the private live Mission/SQLite/Chrome. Use the [acceptance matrix]
(v1-acceptance-evidence-matrix.md) and [operations](operations.md) for the
subsequent independent release proofs.
