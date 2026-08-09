import {describe, expect, it, vi} from 'vitest';
import {createActorContextIssuer, sourceArtifactDigest} from '@fai-control-plane/domain';
import {createProjectPlanService, type ProjectPlanStore} from './project-plan';

const actor = createActorContextIssuer({users: [{actorId: '10000000-0000-4000-8000-000000000001', capabilities: ['read:control_plane:development', 'write:control_plane:development']}], agents: [], systems: []});

describe('project plan service', () => {
  it('passes an authenticated manager command with a stable request hash', async () => {
    if (!actor.ok) throw new Error('issuer');
    const user = actor.value.issueUser('10000000-0000-4000-8000-000000000001'); if (!user.ok) throw new Error('actor');
    const execute = vi.fn().mockResolvedValue({status: 'completed', receipt: {commandId: '20000000-0000-4000-8000-000000000001', commandType: 'project_plan.source.record', result: {ok: true, value: {}}}});
    const service = createProjectPlanService({execute, inspect: vi.fn(), simulate: vi.fn()} as unknown as ProjectPlanStore);
    const content = 'Подтверждённые заметки';
    await service.execute({commandId: '20000000-0000-4000-8000-000000000001', workspaceId: '20000000-0000-4000-8000-000000000002', correlationId: '20000000-0000-4000-8000-000000000003', idempotencyKey: 'artifact:1', issuedAt: '2026-08-09T10:00:00.000Z', actor: user.value, type: 'project_plan.source.record', payload: {artifactId: '20000000-0000-4000-8000-000000000004', projectId: '20000000-0000-4000-8000-000000000005', name: 'Интервью', mediaType: 'text/plain', content, sizeBytes: Buffer.byteLength(content), sha256: sourceArtifactDigest(content), provenance: {kind: 'manager_note', label: 'PO', capturedAt: '2026-08-09T10:00:00.000Z'}}});
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({authorized: true, requestHash: expect.stringMatching(/^[0-9a-f]{64}$/)}));
  });
});
