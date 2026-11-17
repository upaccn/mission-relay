/** Default economics for autonomous work. This is a decision policy, not a
 * bypass of a repository's actual test/release gates or owner instructions. */
export const CI_EXECUTOR_POLICY=[
  'Delivery priority: make the smallest authorized production code/UI change that moves this work item toward acceptance; provide the resulting SHA or artifact and its targeted validation. A new report is not a substitute for implementation.',
  'Before running tests, compare source SHA and existing source-bound evidence. Reuse unchanged coverage; run only newly affected tests plus necessary integration checks. Do not rename or rerun a known failing feasibility probe without a genuinely new candidate.',
  'When an external capability blocks this item, record one precise dependency and stop repeating that experiment. Preserve the original contract, leave publication on HOLD, and let PI schedule independent implementation or Play sandbox work.',
  'CI budget: avoid metered GitHub Actions for ordinary intermediate commits. Inspect workflow triggers before pushing; a push can start paid CI automatically.',
  'Prefer targeted local tests and the approved native validation host (for Android, the GMK mobile workflow). Commit locally while iterating; batch remote pushes at meaningful verified milestones.',
  'Run metered GitHub CI only for an explicit owner requirement, an independently necessary security/platform gate, or a release candidate. Keep required release evidence; do not claim local checks equal remote CI.',
  'Public-repository standard GitHub-hosted runners may be free; distinguish those from private-repository metered jobs and do not suppress essential checks solely because a run exists.',
] as const;

export const CI_PI_POLICY=[
  'Optimize for business delivery: prioritize implemented features, usable UI, source commits, device observations and real sandbox purchases over repeated reports. A report-only round without a new fact is not an implementation milestone.',
  'When one security or external dependency cannot be solved by the authorized tools, record the blocker once and continue independent ready packages. Do not recreate the same capability check under a new work-item name.',
  'Use existing exact-SHA proofs for unchanged behavior, require source-delta tests for actual changes, and group the final mandatory release checks. Never weaken a failed owner-mandated condition to manufacture DONE.',
  'Conserve metered GitHub Actions across long-running Goals: do not demand a fresh remote CI run after every fix, report or intermediate commit.',
  'Inspect each repository workflow trigger and visibility before approving a push; a private main-branch push may launch an expensive full matrix without an explicit CI request.',
  'Prefer local deterministic tests and the approved native host for routine implementation; require independent GitHub CI at an actual owner-required release or critical validation gate.',
  'Never waive an explicit mandatory CI acceptance criterion or mark a release proven using local-only evidence. Budget optimization must not falsify acceptance.',
] as const;
