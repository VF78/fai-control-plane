import {expect, it} from 'vitest';
import {
  replaceRuntimeRegistrations,
  type RuntimeRegistration
} from './runtime-registration';

const registration = (
  overrides: Partial<RuntimeRegistration> = {}
): RuntimeRegistration => ({
  id: 'source',
  projectId: 'project',
  actorId: 'actor-source',
  agentProfileId: 'profile-source',
  provider: 'provider_neutral',
  runtimeKey: 'source-runtime',
  enabled: true,
  version: 2,
  ...overrides
});

it('switches only two persisted registrations for different agents in one project', () => {
  expect(replaceRuntimeRegistrations(
    registration(),
    registration({
      id: 'target',
      actorId: 'actor-target',
      agentProfileId: 'profile-target',
      runtimeKey: 'target-runtime',
      enabled: false,
      version: 4
    })
  )).toEqual({
    source: expect.objectContaining({id: 'source', enabled: false, version: 3}),
    target: expect.objectContaining({id: 'target', enabled: true, version: 5})
  });
});

it.each([
  {id: 'source'},
  {projectId: 'other-project'},
  {actorId: 'actor-source'},
  {agentProfileId: 'profile-source'},
  {enabled: true}
])('rejects an invalid replacement target: %o', (targetOverride) => {
  expect(replaceRuntimeRegistrations(
    registration(),
    registration({
      id: 'target',
      actorId: 'actor-target',
      agentProfileId: 'profile-target',
      enabled: false,
      ...targetOverride
    })
  )).toBeNull();
});

it('rejects a disabled source registration', () => {
  expect(replaceRuntimeRegistrations(
    registration({enabled: false}),
    registration({
      id: 'target',
      actorId: 'actor-target',
      agentProfileId: 'profile-target',
      enabled: false
    })
  )).toBeNull();
});
