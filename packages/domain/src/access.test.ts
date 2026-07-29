import {randomUUID} from 'node:crypto';
import {describe, expect, it} from 'vitest';
import {explainEffectiveAccess} from './access.ts';

const id = () => randomUUID();

describe('effective access explanation', () => {
  it('fails closed and keeps desired access separate from provider observation', () => {
    const projectId = id();
    const actorId = id();
    const resourceId = id();
    const grantId = id();
    const explanations = explainEffectiveAccess({
      actorIds: [actorId],
      resources: [{
        projectId,
        resourceType: 'repository',
        resourceId,
        policyDecision: 'allow'
      }],
      memberships: [],
      grants: [{
        id: grantId,
        projectId,
        actorId,
        resourceType: 'repository',
        resourceId,
        desiredLevel: 'write',
        providerObservation: {
          provider: 'github',
          externalResourceRef: 'github:repository:123',
          confirmedLevel: 'admin',
          observedAt: '2026-07-29T10:00:00.000Z'
        },
        version: 2
      }]
    });

    expect(explanations).toEqual([expect.objectContaining({
      desiredCanonical: {
        level: 'none',
        allowed: false,
        reasons: ['membership_missing_or_inactive']
      },
      providerConfirmed: expect.objectContaining({
        state: 'confirmed',
        level: 'admin'
      })
    })]);
  });

  it('is deterministic and lets policy deny an otherwise-derived role grant', () => {
    const projectId = id();
    const actorId = id();
    const firstResource = id();
    const secondResource = id();
    const membership = {
      id: id(),
      projectId,
      actorId,
      role: 'contributor' as const,
      active: true,
      version: 1
    };
    const input = {
      actorIds: [actorId],
      resources: [
        {
          projectId,
          resourceType: 'tracker' as const,
          resourceId: secondResource,
          policyDecision: 'deny' as const
        },
        {
          projectId,
          resourceType: 'repository' as const,
          resourceId: firstResource,
          policyDecision: 'allow' as const
        }
      ],
      memberships: [membership],
      grants: []
    };

    const first = explainEffectiveAccess(input);
    const second = explainEffectiveAccess({
      ...input,
      resources: [...input.resources].reverse()
    });

    expect(second).toEqual(first);
    expect(first.find((item) => item.resourceType === 'repository')?.desiredCanonical)
      .toMatchObject({level: 'write', allowed: true});
    expect(first.find((item) => item.resourceType === 'tracker')?.desiredCanonical)
      .toEqual({level: 'none', allowed: false, reasons: ['policy_denied']});
  });
});

