import {randomUUID} from 'node:crypto';
import {describe, expect, it} from 'vitest';
import {
  defaultDeliveryProtocolDefinition,
  simulateDeliveryProtocol,
  validateDeliveryProtocolDefinition
} from './delivery-protocol';

describe('delivery protocol', () => {
  it('provides the ordered default five-stage protocol', () => {
    const definition = defaultDeliveryProtocolDefinition();
    expect(definition.stages.map((stage) => stage.key)).toEqual([
      'intake', 'development', 'qa', 'staging', 'production'
    ]);
    expect(validateDeliveryProtocolDefinition(definition)).toMatchObject({ok: true});
  });

  it('rejects provider identifiers, unstable transitions, and invalid agent ownership', () => {
    const definition = defaultDeliveryProtocolDefinition();
    expect(validateDeliveryProtocolDefinition({
      ...definition,
      providerId: 'github:1'
    })).toMatchObject({ok: false});
    expect(validateDeliveryProtocolDefinition({
      ...definition,
      stages: definition.stages.map((stage, index) =>
        index === 0 ? {...stage, allowedNextStageKey: 'intake'} : stage
      )
    })).toMatchObject({ok: false});
    expect(validateDeliveryProtocolDefinition({
      ...definition,
      stages: definition.stages.map((stage, index) =>
        index === 0
          ? {
              ...stage,
              responsibility: {kind: 'actor', actorId: randomUUID(), actorType: 'agent'}
            }
          : stage
      )
    })).toMatchObject({ok: false});
    expect(validateDeliveryProtocolDefinition({
      ...definition,
      stages: definition.stages.map((stage, index) =>
        index === 0
          ? {...stage, executionMode: 'autonomous'}
          : stage
      )
    })).toMatchObject({
      ok: false,
      error: {message: 'Autonomous stages require an agent actor and profile.'}
    });
    expect(validateDeliveryProtocolDefinition({
      ...definition,
      stages: definition.stages.map((stage, index) =>
        index === 0
          ? {
              ...stage,
              responsibility: {
                kind: 'actor',
                actorId: randomUUID(),
                actorType: 'agent',
                agentProfileId: randomUUID()
              },
              executionMode: 'manual'
            }
          : stage
      )
    })).toMatchObject({
      ok: false,
      error: {message: 'Agent-owned stages cannot use manual execution.'}
    });
  });

  it('fails autonomous permission closed for missing membership, actor, or profile context', () => {
    const actorId = randomUUID();
    const profileId = randomUUID();
    const definition = {
      schemaVersion: 1,
      stages: [{
        key: 'development',
        name: 'Development',
        enabled: true,
        responsibility: {kind: 'actor', actorId, actorType: 'agent', agentProfileId: profileId},
        executionMode: 'autonomous',
        entryCriteria: ['Ready'],
        requiredEvidence: ['Checks'],
        allowedNextStageKey: null
      }]
    };
    const missing = simulateDeliveryProtocol(definition, {
      projectExists: true,
      memberships: [],
      actors: [{actorId, actorType: 'agent', active: true}],
      agentProfiles: [],
      agentRegistrations: []
    });
    expect(missing).toMatchObject({
      valid: false,
      stages: [{
        autonomousPermission: false,
        missingContext: [
          'missing.agent_profile',
          'missing.responsible_actor_or_membership',
          'missing.runtime_registration'
        ]
      }]
    });
    const mismatchedRuntime = simulateDeliveryProtocol(definition, {
      projectExists: true,
      memberships: [{actorId, role: 'agent', active: true}],
      actors: [{actorId, actorType: 'agent', active: true}],
      agentProfiles: [{profileId, actorId, enabled: true}],
      agentRegistrations: [{profileId: randomUUID(), actorId, enabled: true}]
    });
    expect(mismatchedRuntime).toMatchObject({
      valid: false,
      stages: [{
        autonomousPermission: false,
        missingContext: ['missing.runtime_registration']
      }]
    });
    const complete = simulateDeliveryProtocol(definition, {
      projectExists: true,
      memberships: [{actorId, role: 'agent', active: true}],
      actors: [{actorId, actorType: 'agent', active: true}],
      agentProfiles: [{profileId, actorId, enabled: true}],
      agentRegistrations: [{profileId, actorId, enabled: true}]
    });
    expect(complete).toMatchObject({
      valid: true,
      stages: [{autonomousPermission: true, missingContext: []}]
    });
    expect(complete.simulationHash).not.toBe(missing.simulationHash);
  });
});
