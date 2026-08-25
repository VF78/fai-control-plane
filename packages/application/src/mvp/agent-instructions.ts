export const defaultAgentStageInstructions = (role: 'manager'|'developer'|'qa') => role === 'manager'
  ? {constraints: [
    'Plan only the exact receipt-bound Project item; do not select or create unrelated work.',
    'Do not implement, merge, release, deploy, or access production.',
    'Return the requested next stage for this same item; Control Plane performs and verifies the provider mutation.'
  ], acceptanceCriteria: ['Record bounded planning evidence.',
    'Return the exact next stage configured by the project process policy.']}
  : role === 'developer'
  ? {constraints: [
    'Work only on the referenced GitHub Project item and repository.',
    'Do not merge, release, deploy, or access production.',
    'Use a fresh temporary git worktree created from request.repository.defaultBranchSha; never execute in the persistent base checkout.',
    'Invoke the configured CLI once with the exact executor, model and effort. It reads AGENTS.md and the referenced issue, owns one implementation pass, focused self-checks and commit; Hermes only returns its result.',
    'If this item already has an open review pull request, update that same PR head branch for rework. Otherwise push one new review branch and create one pull request. Never create a duplicate PR for the same item.',
    'Never push the default branch, merge, release, deploy, or access production.',
    'Return the exact configured next stage for this item. Control Plane performs and verifies the Project mutation.'
  ], acceptanceCriteria: [
    'Record delivery evidence in the referenced GitHub issue or pull request.',
    'The result requests the next stage configured by the project process policy.'
  ]} : {constraints: [
    'Work only on the referenced GitHub Project item and repository.',
    'Do not merge, release, deploy, or access production.',
    'Invoke the configured CLI once in a fresh temporary worktree with the exact model and effort. It first reviews the unchanged referenced PR and prior evidence independently, then runs only missing acceptance/risk checks; Hermes only returns its result.',
    'Do not repeat an unchanged full test suite. A localized low-risk defect may be fixed, committed and pushed once on the existing PR branch in this same QA pass, followed by the focused check and recorded final diff evidence.',
    'Request the configured developer rework stage instead of fixing when scope or acceptance changes, or when the change affects architecture, schema or public API, security, migrations, production configuration, or remains uncertain or failing after the one focused fix.',
    'Return the exact configured rework or next stage. Control Plane performs and verifies the Project mutation.'
  ], acceptanceCriteria: [
    'Record the independently reviewed commit, QA evidence, and any localized QA fix in the referenced GitHub issue or pull request.',
    'The result requests the configured rework or next stage after QA.'
  ]};
