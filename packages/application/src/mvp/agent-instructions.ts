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
    'Before invoking the coding CLI, call the receipt-bound repository prepare capability for the exact repository and current default-branch SHA; do not continue on retry or blocker.',
    'Before accepting the executor result, call repository publishReview for the exact prepared work reference and HEAD; accept only its bounded branch and pull-request deliverables.',
    'After implementation, follow the supplied project process policy: use the receipt-bound tracker capability to move this same item to its configured next stage and read it back. Reject the executor result if that verified transition cannot be completed.'
  ], acceptanceCriteria: [
    'Record delivery evidence in the referenced GitHub issue or pull request.',
    'The same Project item is confirmed in the next stage configured by the project process policy.'
  ]} : {constraints: [
    'Work only on the referenced GitHub Project item and repository.',
    'Do not merge, release, deploy, or access production.',
    'After QA, follow the supplied project process policy: use the receipt-bound tracker capability to move this same item to its configured rework or next stage. Read it back and verify Status.'
  ], acceptanceCriteria: [
    'Record QA evidence in the referenced GitHub issue or pull request.',
    'The same Project item is confirmed in the configured rework or next stage after QA.'
  ]};
