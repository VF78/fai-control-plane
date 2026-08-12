import {createHash} from 'node:crypto';

export type TrackerNextActionDecision = Readonly<{
  projectItemExternalId: string;
  issueExternalId: string;
  observedItemVersion: string;
  observedOptionExternalId: string | null;
  action: 'no_op' | 'human_approval_required' | 'assigned_human' | 'hermes_role_request';
  hermesRole: 'manager' | 'developer' | 'qa' | null;
  reason:
    | 'plan_requested'
    | 'assigned_developer'
    | 'developer_requested'
    | 'development_in_progress'
    | 'qa_requested'
    | 'product_owner_acceptance_required'
    | 'completed_acceptance_required'
    | 'status_unmapped';
  idempotencyKey: string;
}>;

type ProjectItem = Readonly<{
  externalId: string;
  issueExternalId: string;
  externalVersion: string;
  assignees: readonly unknown[];
  status: Readonly<{optionExternalId: string | null}>;
}>;

const ASCON_STATUS = Object.freeze({
  backlog: 'f75ad846',
  ready: 'f1d63022',
  inDevelopment: '47fc9ee4',
  qa: 'eccb04fa',
  acceptance: '640fe9a8',
  done: '98236657'
});

const idempotencyKey = (item: ProjectItem): string =>
  `ascon-next-action:sha256:${createHash('sha256').update([
    item.externalId,
    item.status.optionExternalId ?? 'missing',
    item.externalVersion
  ].join('\n')).digest('hex')}`;

/**
 * The complete ASCON status decision table. It emits intent only; transport,
 * retries and execution belong to the Hermes adapter boundary.
 */
export const decideAsconNextAction = (item: ProjectItem): TrackerNextActionDecision => {
  const base = {
    projectItemExternalId: item.externalId,
    issueExternalId: item.issueExternalId,
    observedItemVersion: item.externalVersion,
    observedOptionExternalId: item.status.optionExternalId,
    idempotencyKey: idempotencyKey(item)
  };
  switch (item.status.optionExternalId) {
    case ASCON_STATUS.backlog:
      return {...base, action: 'hermes_role_request', hermesRole: 'manager', reason: 'plan_requested'};
    case ASCON_STATUS.ready:
      return item.assignees.length > 0
        ? {...base, action: 'assigned_human', hermesRole: null, reason: 'assigned_developer'}
        : {...base, action: 'hermes_role_request', hermesRole: 'developer', reason: 'developer_requested'};
    case ASCON_STATUS.inDevelopment:
      return {...base, action: 'no_op', hermesRole: null, reason: 'development_in_progress'};
    case ASCON_STATUS.qa:
      return {...base, action: 'hermes_role_request', hermesRole: 'qa', reason: 'qa_requested'};
    case ASCON_STATUS.acceptance:
      return {...base, action: 'human_approval_required', hermesRole: null,
        reason: 'product_owner_acceptance_required'};
    case ASCON_STATUS.done:
      return {...base, action: 'human_approval_required', hermesRole: null,
        reason: 'completed_acceptance_required'};
    default:
      return {...base, action: 'no_op', hermesRole: null, reason: 'status_unmapped'};
  }
};
