/** Kept executable so a new core capability cannot silently lose its UI seam. */
export const operatorCapabilityMatrix = [
  ['GitHub Project snapshot', 'tracker_snapshots → listProjectTaskViews', 'Dashboard, Tasks board/detail', 'fresh/stale/error; task-count status and readable assignee projection'],
  ['ASCON process policy', 'provider-neutral read policy', 'Process', 'read-only stages, gates, evidence and terminal Done'],
  ['Logout', 'logout()', 'Shell: Выйти', 'session revoked/error'],
  ['Add source', 'addSourceArtifact → source()', 'Settings: Добавить источник', 'success/error'],
  ['Exact approval', 'decideApproval → approval()', 'Tasks selected detail: Зафиксировать согласование', 'recorded/duplicate/conflict/denied'],
  ['Onboard member', 'onboard()', 'People: Добавить участника', 'success/denied/error'],
  ['Change membership', 'membership()', 'People: active/inactive roster and Изменить членство', 'success/denied/error'],
  ['Explicit browser agent submit', 'session + same-origin CSRF → fresh tracker snapshot → AgentDeliveryPort → receipt/audit transaction', 'Systems: Передать роль Hermes', 'completed/duplicate/denied/provider error; never automatic or production'],
  ['Messenger delivery', 'audit_events/outbox_events/identity read projection', 'Conversations', 'configured/confirmed activity/pending/delivered/failure/no data']
] as const;
