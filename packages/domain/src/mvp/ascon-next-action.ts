import {createHash} from 'node:crypto';
import type {TrackerItemFact} from './model.ts';
import type {AgentRole} from './ports.ts';

export type NextAction = Readonly<{
  kind: 'none' | 'human' | 'agent';
  role: AgentRole | null;
  reason: string;
  idempotencyKey: string;
}>;

export type StatusMap = Readonly<{
  backlog: string;
  ready: string;
  development: string;
  qa: string;
  acceptance: string;
  done: string;
}>;

const key = (item: TrackerItemFact): string =>
  `next-action:sha256:${createHash('sha256').update([
    item.itemId, item.statusOptionId ?? 'missing', item.version
  ].join('\n')).digest('hex')}`;

export const decideNextAction = (item: TrackerItemFact, statuses: StatusMap): NextAction => {
  const idempotencyKey = key(item);
  switch (item.statusOptionId) {
    case statuses.backlog:
      return {kind: 'agent', role: 'manager', reason: 'plan_requested', idempotencyKey};
    case statuses.ready:
      return item.assigneeIds.length > 0
        ? {kind: 'human', role: null, reason: 'assigned_human', idempotencyKey}
        : {kind: 'agent', role: 'developer', reason: 'development_requested', idempotencyKey};
    case statuses.qa:
      return {kind: 'agent', role: 'qa', reason: 'qa_requested', idempotencyKey};
    case statuses.acceptance:
      return {kind: 'human', role: null, reason: 'approval_required', idempotencyKey};
    case statuses.done:
      return {kind: 'none', role: null, reason: 'completed', idempotencyKey};
    case statuses.development:
    default:
      return {kind: 'none', role: null, reason: 'no_action', idempotencyKey};
  }
};
