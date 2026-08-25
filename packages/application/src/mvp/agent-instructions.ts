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
    'Invoke the configured CLI once with the exact executor, model and effort from the resolved route. The CLI owns implementation, checks, commit, review branch and pull request; Hermes only verifies the returned provider evidence.',
    'Push only a new review branch and create a pull request. Never push the default branch, merge, release, deploy, or access production.',
    'Return the exact configured next stage for this item. Control Plane performs and verifies the Project mutation.'
  ], acceptanceCriteria: [
    'Record delivery evidence in the referenced GitHub issue or pull request.',
    'The result requests the next stage configured by the project process policy.'
  ]} : {constraints: [
    'Work only on the referenced GitHub Project item and repository.',
    'Do not merge, release, deploy, or access production.',
    'If the configured QA route uses a CLI, invoke it once in the native terminal with the exact configured executor, model and effort. The CLI owns the bounded QA review; Hermes only verifies the returned provider evidence.',
    'Return the exact configured rework or next stage. Control Plane performs and verifies the Project mutation.'
  ], acceptanceCriteria: [
    'Record QA evidence in the referenced GitHub issue or pull request.',
    'The result requests the configured rework or next stage after QA.'
  ]};
