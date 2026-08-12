import {randomUUID} from 'node:crypto';
import {describe, expect, it, vi} from 'vitest';
import {createActorContextIssuer, hashDeploymentReleasePackage} from '@fai-control-plane/domain';
import {createDeploymentExecutorService, parseDeploymentExecutorCompletionPayload} from './deployment-executor.ts';

const ids = {workspace: randomUUID(), project: randomUUID(), registration: randomUUID(), actor: randomUUID(),
  job: randomUUID(), deployment: randomUUID(), approver: randomUUID()};
const issuer = createActorContextIssuer({users: [], agents: [], systems: [{actorId: ids.actor,
  capabilities: ['deploy:runner:production']}]});
if (!issuer.ok) throw new Error('issuer');
const actor = issuer.value.issueSystem(ids.actor);
if (!actor.ok) throw new Error('actor');
const authorization = {workspaceId: ids.workspace, executorId: 'deployment-executor',
  registrationId: ids.registration, projectIds: [ids.project], environments: ['production' as const], actor: actor.value};

describe('deployment executor service', () => {
  it('keeps a distinct lease and emits the exact existing observation command for the same job', async () => {
    const releasePackage = {schemaVersion: 1 as const, sourceCommit: 'a'.repeat(40),
      artifactReference: 'artifact:release-package:1', artifactSha256: 'b'.repeat(64)};
    const claim = vi.fn(async (_input, prepare) => prepare({jobId: ids.job, deploymentId: ids.deployment,
      deploymentVersion: 2, projectId: ids.project, environment: 'production',
      releasePackage, releasePackageHash: hashDeploymentReleasePackage(releasePackage), approvedByActorId: ids.approver,
      approvedAt: new Date('2026-08-12T09:00:00.000Z'), attempt: 1}));
    const heartbeat = vi.fn().mockResolvedValue({status: 'extended',
      leaseExpiresAt: new Date('2026-08-12T09:03:00.000Z')});
    const complete = vi.fn().mockImplementation(async (input) => ({status: 'completed',
      outcome: input.observationCommand.payload.observation.outcome,
      completedAt: new Date(input.observationCommand.payload.observation.completedAt)}));
    let now = new Date('2026-08-12T09:01:00.000Z');
    const service = createDeploymentExecutorService({store: {claim, heartbeat, complete}, now: () => now,
      tokenGenerator: () => 'l'.repeat(43), nextId: () => randomUUID()});
    const envelope = await service.claim(authorization);
    expect(envelope).toMatchObject({schemaVersion: 1, jobId: ids.job, deploymentVersion: 2,
      releasePackage: {sourceCommit: 'a'.repeat(40)}, leaseToken: 'l'.repeat(43)});
    if (envelope === null) throw new Error('claim');
    now = new Date('2026-08-12T09:01:30.000Z');
    await expect(service.heartbeat({authorization, payload: {jobId: ids.job, attempt: 1},
      leaseToken: envelope.leaseToken})).resolves.toEqual({leaseExpiresAt: '2026-08-12T09:03:00.000Z'});
    const payload = {jobId: ids.job, deploymentId: ids.deployment, deploymentVersion: 2, attempt: 1,
      result: {outcome: 'succeeded' as const, startedAt: '2026-08-12T09:01:00.000Z',
        completedAt: '2026-08-12T09:01:20.000Z',
        smokeChecks: [{name: 'health', status: 'passed' as const, reference: 'evidence:health'}],
        rollback: {outcome: 'not_required' as const, reference: null}}};
    await expect(service.complete({authorization, payload, leaseToken: envelope.leaseToken}))
      .resolves.toEqual({outcome: 'succeeded', completedAt: '2026-08-12T09:01:20.000Z'});
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({jobId: ids.job, attempt: 1,
      observationCommand: expect.objectContaining({type: 'deployment.observe_result.v1',
        payload: expect.objectContaining({deploymentId: ids.deployment, expectedVersion: 2,
          observation: expect.objectContaining({reference: expect.stringMatching(
            new RegExp(`^deployment-job:${ids.job}:attempt:1:result:[0-9a-f]{64}$`))})})})}));
  });

  it('rejects incoherent smoke/rollback facts before the store', () => {
    expect(parseDeploymentExecutorCompletionPayload({jobId: ids.job, deploymentId: ids.deployment,
      deploymentVersion: 2, attempt: 1, result: {outcome: 'succeeded',
        startedAt: '2026-08-12T09:00:00.000Z', completedAt: '2026-08-12T09:01:00.000Z',
        smokeChecks: [{name: 'health', status: 'failed', reference: 'evidence:health'}],
        rollback: {outcome: 'not_required', reference: null}}})).toBeNull();
  });
});
