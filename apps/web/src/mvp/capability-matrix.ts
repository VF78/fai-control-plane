/** Kept executable so a new core capability cannot silently lose its UI seam. */
export const operatorCapabilityMatrix = [
  ['GitHub Project snapshot', 'tracker_snapshots → listProjectTaskViews', 'Dashboard, Tasks board/detail', 'fresh/stale/error; task-count status and readable assignee projection'],
  ['ASCON process policy', 'provider-neutral read policy', 'Process', 'read-only stages, gates, evidence and terminal Done'],
  ['Logout', 'logout()', 'Shell: Выйти', 'session revoked/error'],
  ['Onboard member', 'onboard()', 'People: Добавить участника', 'success/denied/error'],
  ['Change membership', 'membership()', 'People: active/inactive roster and Изменить членство', 'success/denied/error'],
  ['Task executor', 'session + same-origin CSRF → GitHub assignment/status mutation → exact Hermes receipt when selected', 'Tasks detail: Назначить исполнителя', 'human assigned or Hermes started/duplicate/status-sync warning; never automatic or production'],
  ['Messenger delivery', 'audit_events/outbox_events/identity read projection', 'Conversations', 'configured/confirmed activity/pending/delivered/failure/no data']
] as const;
