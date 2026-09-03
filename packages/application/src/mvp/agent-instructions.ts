export const defaultAgentStageInstructions = (role: 'manager'|'developer'|'qa') => role === 'manager'
  ? {constraints: [
    'Plan only the exact receipt-bound tracker item; do not select or create unrelated work.',
    'Do not implement, merge, release, deploy, or access production.',
    'Use the bound tracker to change this same item to the configured next stage and verify provider readback.'
  ], acceptanceCriteria: ['Record bounded planning evidence.',
    'Return the exact next stage configured by the project process policy.']}
  : role === 'developer'
  ? {constraints: [
    'Work only on the referenced tracker item and bound repository.',
    'Do not merge, release, deploy, or access production.',
    'Use one stable issue worktree under /opt/data/work/items and reuse it after interruption, rework and QA.',
    'Invoke the configured CLI once with the exact executor, model and effort. It reads AGENTS.md and the referenced issue and owns one implementation pass, focused self-checks and commit.',
    'If this item already has an open review request, update that same review branch for rework. Otherwise push one new review branch and create one review request. Never create a duplicate review request for the same item.',
    'Never push the default branch, merge, release, deploy, or access production.',
    'Use the bound tracker to change the same item to the exact configured next stage and verify provider readback before returning.'
  ], acceptanceCriteria: [
    'Record delivery evidence in the referenced tracker item or review request.',
    'The result requests the next stage configured by the project process policy.'
  ]} : {constraints: [
    'Work only on the referenced tracker item and bound repository.',
    'Do not merge, release, deploy, or access production.',
    'Invoke the configured CLI once in the existing item worktree with the exact model and effort. It first reviews the unchanged referenced review request and prior evidence independently, then runs only missing acceptance/risk checks.',
    'Do not repeat an unchanged full test suite. A localized low-risk defect may be fixed, committed and pushed once on the existing review branch in this same QA pass, followed by the focused check and recorded final diff evidence.',
    'Request the configured developer rework stage instead of fixing when scope or acceptance changes, or when the change affects architecture, schema or public API, security, migrations, production configuration, or remains uncertain or failing after the one focused fix.',
    'Use the bound tracker to change the same item to the configured rework or next stage and verify provider readback before returning.'
  ], acceptanceCriteria: [
    'Record the independently reviewed commit, QA evidence, and any localized QA fix in the referenced tracker item or review request.',
    'The result requests the configured rework or next stage after QA.'
  ]};
