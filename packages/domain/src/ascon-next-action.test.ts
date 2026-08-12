import {describe, expect, it} from 'vitest';
import {decideAsconNextAction} from './ascon-next-action';

const item = (optionExternalId: string | null, assigned = false) => ({
  externalId: 'PVTI_item',
  issueExternalId: 'github:issue:159',
  externalVersion: 'github:sha256:item-v1',
  assignees: assigned ? [{externalId: 'github:user:1'}] : [],
  status: {optionExternalId}
});

describe('decideAsconNextAction', () => {
  it.each([
    ['f75ad846', 'hermes_role_request', 'manager'],
    ['f1d63022', 'hermes_role_request', 'developer'],
    ['47fc9ee4', 'no_op', null],
    ['eccb04fa', 'hermes_role_request', 'qa'],
    ['640fe9a8', 'human_approval_required', null],
    ['98236657', 'human_approval_required', null]
  ] as const)('maps the fixed ASCON option %s', (option, action, role) => {
    expect(decideAsconNextAction(item(option))).toMatchObject({action, hermesRole: role});
  });

  it('keeps an assigned Ready item with its human owner', () => {
    expect(decideAsconNextAction(item('f1d63022', true))).toMatchObject({
      action: 'assigned_human', hermesRole: null
    });
  });

  it('deduplicates the same observed provider item deterministically', () => {
    const first = decideAsconNextAction(item('eccb04fa'));
    const replay = decideAsconNextAction(item('eccb04fa'));
    expect(replay.idempotencyKey).toBe(first.idempotencyKey);
  });
});
