/** Default economics for autonomous work. This is a decision policy, not a
 * bypass of a repository's actual test/release gates or owner instructions. */
export const CI_EXECUTOR_POLICY=[
  'CI budget: avoid metered GitHub Actions for ordinary intermediate commits. Inspect workflow triggers before pushing; a push can start paid CI automatically.',
  'Prefer targeted local tests and the approved native validation host (for Android, the GMK mobile workflow). Commit locally while iterating; batch remote pushes at meaningful verified milestones.',
  'Run metered GitHub CI only for an explicit owner requirement, an independently necessary security/platform gate, or a release candidate. Keep required release evidence; do not claim local checks equal remote CI.',
  'Public-repository standard GitHub-hosted runners may be free; distinguish those from private-repository metered jobs and do not suppress essential checks solely because a run exists.',
] as const;

export const CI_PI_POLICY=[
  'Conserve metered GitHub Actions across long-running Goals: do not demand a fresh remote CI run after every fix, report or intermediate commit.',
  'Inspect each repository workflow trigger and visibility before approving a push; a private main-branch push may launch an expensive full matrix without an explicit CI request.',
  'Prefer local deterministic tests and the approved native host for routine implementation; require independent GitHub CI at an actual owner-required release or critical validation gate.',
  'Never waive an explicit mandatory CI acceptance criterion or mark a release proven using local-only evidence. Budget optimization must not falsify acceptance.',
] as const;
