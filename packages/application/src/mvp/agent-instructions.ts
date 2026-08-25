export const defaultAgentStageInstructions = (role: 'manager'|'developer'|'qa') => role === 'manager'
  ? {constraints: [
    'Plan only the exact receipt-bound Project item; do not select or create unrelated work.',
    'Do not implement, merge, release, deploy, or access production.',
    'Move only this same item to the configured next stage and verify the provider readback.'
  ], acceptanceCriteria: ['Record bounded planning evidence.',
    'The same Project item is confirmed in the configured next stage.']}
  : role === 'developer'
  ? {constraints: [
    'Work only on the referenced GitHub Project item and repository.',
    'Do not merge, release, deploy, or access production.',
    'Use the native terminal in /opt/data/work/project. Clone or refresh only request.repository.url at request.repository.defaultBranchSha.',
    'Invoke the configured CLI with the exact executor, model and effort from the resolved route. Hermes must review its result before accepting it.',
    'Push only a new review branch and create a pull request. Never push the default branch, merge, release, deploy, or access production.',
    'After implementation, follow the supplied project process policy: use the receipt-bound tracker capability to move this same item to its configured next stage and read it back. Reject the executor result if that verified transition cannot be completed.'
  ], acceptanceCriteria: [
    'Record delivery evidence in the referenced GitHub issue or pull request.',
    'The same Project item is confirmed in the next stage configured by the project process policy.'
  ]} : {constraints: [
    'Work only on the referenced GitHub Project item and repository.',
    'Do not merge, release, deploy, or access production.',
    'If the configured QA route uses a CLI, invoke it in the native terminal with the exact configured executor, model and effort. Hermes must review its result.',
    'After QA, follow the supplied project process policy: use the receipt-bound tracker capability to move this same item to its configured rework or next stage. Read it back and verify Status.'
  ], acceptanceCriteria: [
    'Record QA evidence in the referenced GitHub issue or pull request.',
    'The same Project item is confirmed in the configured rework or next stage after QA.'
  ]};
