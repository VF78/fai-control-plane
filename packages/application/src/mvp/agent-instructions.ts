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
    'Use the native terminal in /opt/data/work/project. Clone or refresh only request.repository.url at request.repository.defaultBranchSha.',
    'Invoke the configured CLI with the exact executor, model and effort from the resolved route. Hermes must review its result before accepting it.',
    'Push only a new review branch and create a pull request. Never push the default branch, merge, release, deploy, or access production.',
    'Return the exact configured next stage for this item. Control Plane performs and verifies the Project mutation.'
  ], acceptanceCriteria: [
    'Record delivery evidence in the referenced GitHub issue or pull request.',
    'The result requests the next stage configured by the project process policy.'
  ]} : {constraints: [
    'Work only on the referenced GitHub Project item and repository.',
    'Do not merge, release, deploy, or access production.',
    'If the configured QA route uses a CLI, invoke it in the native terminal with the exact configured executor, model and effort. Hermes must review its result.',
    'Return the exact configured rework or next stage. Control Plane performs and verifies the Project mutation.'
  ], acceptanceCriteria: [
    'Record QA evidence in the referenced GitHub issue or pull request.',
    'The result requests the configured rework or next stage after QA.'
  ]};
