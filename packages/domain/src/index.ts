export const workItemStatuses = [
  'backlog',
  'ready',
  'in_dev',
  'qa',
  'acceptance',
  'done'
] as const;

export type WorkItemStatus = (typeof workItemStatuses)[number];

export const actionCategories = [
  'read',
  'write',
  'delete',
  'external_message',
  'deploy',
  'access_change',
  'critical_config',
  'customer_data_touch'
] as const;

export type ActionCategory = (typeof actionCategories)[number];
