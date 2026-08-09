import {createHash, randomUUID} from 'node:crypto';
import type {
  AccessObservationPort,
  AccessObservationResult,
  AccessResourceType,
  CanonicalCommand,
  TrustedActorContext
} from '@fai-control-plane/domain';
import type {CanonicalCommandService} from './index.ts';

export type AccessObservationBinding = Readonly<{
  workspaceId: string;
  projectId: string;
  grantId: string;
  grantVersion: number;
  grantActorId: string;
  identityActorId: string;
  resourceType: AccessResourceType;
  resourceId: string;
  identityProvider: string;
  externalSubject: string;
  identityActive: boolean;
  repository: Readonly<{scopeId: string; owner: string; repository: string; externalId: string}>;
}>;

export type AccessObservationApplicationResult = AccessObservationResult & Readonly<{
  application?: 'applied' | 'replayed';
}>;

export const accessObservationBindingEligibility = (
  requestedWorkspaceId: string,
  requestedProjectId: string,
  binding: AccessObservationBinding
): Readonly<{eligible: true}> | Readonly<{eligible: false; remediation: string}> => {
  if (binding.workspaceId !== requestedWorkspaceId || binding.projectId !== requestedProjectId) return {
    eligible: false,
    remediation: 'Reload the access grant from the requested workspace and project.'
  };
  if (binding.grantActorId !== binding.identityActorId) return {
    eligible: false,
    remediation: 'Reload an external identity bound to the access-grant actor.'
  };
  if (binding.resourceId !== binding.repository.scopeId) return {
    eligible: false,
    remediation: 'Reload the access grant bound to the configured repository scope.'
  };
  return {eligible: true};
};

/** Observes one already-bound access grant and applies only confirmed facts canonically. */
export const createAccessObservationService = (dependencies: Readonly<{
  observer: AccessObservationPort;
  commands: CanonicalCommandService;
  now?: () => Date;
  nextId?: () => string;
}>) => ({
  async observe(input: Readonly<{
    workspaceId: string;
    projectId: string;
    actor: TrustedActorContext;
    binding: AccessObservationBinding;
  }>): Promise<AccessObservationApplicationResult> {
    const {binding} = input;
    const eligibility = accessObservationBindingEligibility(
      input.workspaceId,
      input.projectId,
      binding
    );
    if (!eligibility.eligible) return {
      state: 'unobserved',
      remediation: eligibility.remediation
    };
    if (!binding.identityActive || binding.identityProvider !== dependencies.observer.provider) return {
      state: 'unobserved',
      remediation: `Bind an active ${dependencies.observer.provider} external identity for this actor.`
    };
    let observation: AccessObservationResult;
    try {
      observation = await dependencies.observer.observeAccess({
        resourceType: binding.resourceType,
        externalSubject: binding.externalSubject,
        repository: binding.repository
      });
    } catch {
      return {
        state: 'unavailable',
        remediation: 'Provider access observation failed before a fact was confirmed; retry safely.'
      };
    }
    if (observation.state !== 'confirmed') return observation;
    if (
      observation.provider !== dependencies.observer.provider ||
      observation.externalResourceRef !== binding.repository.externalId
    ) return {
      state: 'unavailable',
      remediation: 'Provider observation did not match the configured provider and repository identity.'
    };
    const nextId = dependencies.nextId ?? randomUUID;
    const issuedAt = (dependencies.now ?? (() => new Date()))().toISOString();
    const factHash = createHash('sha256').update(JSON.stringify([
      binding.grantId, binding.grantVersion, observation.provider,
      observation.externalResourceRef, observation.confirmedLevel, observation.observedAt
    ])).digest('hex');
    const command: Extract<CanonicalCommand, {type: 'resource_access_grant.observe'}> = {
      commandId: nextId(), workspaceId: input.workspaceId, correlationId: nextId(),
      idempotencyKey: `resource_access_grant.observe.v1:${binding.grantId}:${binding.grantVersion}:${factHash}`,
      issuedAt, actor: input.actor, type: 'resource_access_grant.observe',
      payload: {
        grantId: binding.grantId, provider: observation.provider,
        externalResourceRef: observation.externalResourceRef,
        confirmedLevel: observation.confirmedLevel, observedAt: observation.observedAt,
        expectedVersion: binding.grantVersion
      }
    };
    const execution = await dependencies.commands.execute(command);
    if (execution.status !== 'completed' && execution.status !== 'replayed') return {
      state: 'unavailable',
      remediation: 'Canonical access observation was rejected; inspect its audited command receipt.'
    };
    if (!execution.receipt.result.ok) return {
      state: 'unavailable',
      remediation: execution.receipt.result.error.code === 'VERSION_CONFLICT'
        ? 'Access grant changed during observation; reload its version and observe again.'
        : 'Canonical access observation failed; inspect its audited command receipt.'
    };
    return {...observation, application: execution.status === 'replayed' ? 'replayed' : 'applied'};
  }
});
