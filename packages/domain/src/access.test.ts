import {describe, expect, it} from 'vitest';
import {actorOnboardingRolesAreCompatible} from './access.ts';

describe('actor onboarding role compatibility', () => {
  it('requires agent-only role/profile pairing and rejects it for humans', () => {
    expect(actorOnboardingRolesAreCompatible({actorType: 'agent', actorRole: 'agent_operator', membershipRoles: ['agent'], hasAgentProfile: true})).toBe(true);
    expect(actorOnboardingRolesAreCompatible({actorType: 'agent', actorRole: 'developer', membershipRoles: ['agent'], hasAgentProfile: true})).toBe(false);
    expect(actorOnboardingRolesAreCompatible({actorType: 'human', actorRole: 'developer', membershipRoles: ['agent'], hasAgentProfile: false})).toBe(false);
    expect(actorOnboardingRolesAreCompatible({actorType: 'human', actorRole: 'delivery_lead', membershipRoles: ['workspace_owner'], hasAgentProfile: false})).toBe(true);
    expect(actorOnboardingRolesAreCompatible({actorType: 'human', actorRole: 'developer', membershipRoles: ['contributor'], hasAgentProfile: false})).toBe(true);
  });
});
