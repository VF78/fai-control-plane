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
    'Invoke the configured CLI once with the exact executor, model and effort. It reads AGENTS.md and the referenced issue, owns one implementation pass, focused self-checks, commit, review branch and pull request; Hermes only returns its result.',
    'Push only a new review branch and create a pull request. Never push the default branch, merge, release, deploy, or access production.',
    'Return the exact configured next stage for this item. Control Plane performs and verifies the Project mutation.'
  ], acceptanceCriteria: [
    'Record delivery evidence in the referenced GitHub issue or pull request.',
    'The result requests the next stage configured by the project process policy.'
  ]} : {constraints: [
    'Work only on the referenced GitHub Project item and repository.',
    'Do not merge, release, deploy, or access production.',
    'Invoke the configured CLI once in a fresh temporary worktree with the exact model and effort. It reviews the referenced PR and prior evidence, runs only missing acceptance/risk checks, and records the QA result; Hermes only returns its result.',
    'Do not repeat an unchanged full test suite and do not implement fixes during QA; request the configured developer rework stage when changes are required.',
    'Return the exact configured rework or next stage. Control Plane performs and verifies the Project mutation.'
  ], acceptanceCriteria: [
    'Record QA evidence in the referenced GitHub issue or pull request.',
    'The result requests the configured rework or next stage after QA.'
  ]};
