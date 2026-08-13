import {describe, expect, it} from 'vitest';
import {mayChangeMembership} from './membership-governance.ts';

const request = {requesterActorId: 'operator', requesterRole: 'operator' as const,
  targetActorId: 'target', targetRole: 'contributor' as const,
  requestedRole: 'project_owner' as const, requestedActive: true};

describe('membership governance', () => {
  it('denies an operator appointing an owner', () => expect(mayChangeMembership(request)).toBe(false));
  it('denies an operator promoting itself', () => expect(mayChangeMembership({...request, targetActorId: 'operator'})).toBe(false));
  it('denies an operator removing an owner', () => expect(mayChangeMembership({...request,
    targetRole: 'project_owner', requestedRole: 'operator', requestedActive: false})).toBe(false));
  it('allows an owner to manage another member', () => expect(mayChangeMembership({...request,
    requesterActorId: 'owner', requesterRole: 'project_owner', requestedRole: 'operator'})).toBe(true));
  it('keeps the acting owner active', () => expect(mayChangeMembership({...request,
    requesterActorId: 'owner', requesterRole: 'project_owner', targetActorId: 'owner',
    targetRole: 'project_owner', requestedRole: 'operator'})).toBe(false));
});
