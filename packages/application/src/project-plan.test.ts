import {describe, expect, it, vi} from 'vitest';
import {createActorContextIssuer, sourceArtifactDigest} from '@fai-control-plane/domain';
import {createProjectPlanService, type ProjectPlanStore} from './project-plan';

const actor = createActorContextIssuer({users: [{actorId: '10000000-0000-4000-8000-000000000001', capabilities: ['read:control_plane:development', 'write:control_plane:development']}], agents: [], systems: []});
const semanticDefinition = {
  title: 'Hermes plan', outcomes: Array.from({length: 5}, (_, index) => ({key: `outcome_${index + 1}`, title: `Outcome ${index + 1}`, weight: 20, evidence: {kind: 'assumption' as const, statement: 'Product Owner confirms this semantic proposal.'}})),
  milestones: [{key: 'm1', title: 'Acceptance', checkpoint: 'Product Owner accepts.', targetAt: null, evidence: {kind: 'assumption' as const, statement: 'Acceptance date is confirmed by Product Owner.'}}],
  risks: [{key: 'r1', statement: 'Interpretation risk', mitigation: 'Review citations.', evidence: {kind: 'assumption' as const, statement: 'Product Owner reviews interpretation.'}}],
  tasks: [{key: 't1', title: 'Prepare outcome', responsibility: {kind: 'project_role' as const, role: 'project_owner' as const}, outcomeKeys: ['outcome_1'], milestoneKey: 'm1', dependsOn: [], acceptanceEvidence: [{description: 'Product Owner verifies.', evidence: {kind: 'assumption' as const, statement: 'Product Owner verifies the result.'}}]}]
};
const planningContext = {schemaVersion: 1 as const, projectId: '20000000-0000-4000-8000-000000000004',
  deliveryProtocol: {id: '20000000-0000-4000-8000-000000000007', revision: 1, contentHash: 'b'.repeat(64),
    stages: [{key: 'delivery', name: 'Delivery', taskStatus: 'in_dev' as const,
      responsibility: {kind: 'project_role' as const, role: 'contributor' as const}, executionMode: 'manual' as const,
      requiredEvidence: ['Change'], allowedNextStageKey: null}]},
  responsibilityCandidates: [{kind: 'project_role' as const, role: 'project_owner' as const}]};

describe('project plan service', () => {
  it('passes an authenticated manager command with a stable request hash', async () => {
    if (!actor.ok) throw new Error('issuer');
    const user = actor.value.issueUser('10000000-0000-4000-8000-000000000001'); if (!user.ok) throw new Error('actor');
    const execute = vi.fn().mockResolvedValue({status: 'completed', receipt: {commandId: '20000000-0000-4000-8000-000000000001', commandType: 'project_plan.source.record', result: {ok: true, value: {}}}});
    const service = createProjectPlanService({execute, inspect: vi.fn(), simulate: vi.fn()} as unknown as ProjectPlanStore);
    const content = 'Подтверждённые заметки';
    await service.execute({commandId: '20000000-0000-4000-8000-000000000001', workspaceId: '20000000-0000-4000-8000-000000000002', correlationId: '20000000-0000-4000-8000-000000000003', idempotencyKey: 'artifact:1', issuedAt: '2026-08-09T10:00:00.000Z', actor: user.value, type: 'project_plan.source.record', payload: {artifactId: '20000000-0000-4000-8000-000000000004', projectId: '20000000-0000-4000-8000-000000000005', name: 'Архитектура решения', sourceKind: 'solution_architecture', mediaType: 'text/plain', content, sizeBytes: Buffer.byteLength(content), sha256: sourceArtifactDigest(content), sourceFile: null, provenance: {kind: 'manager_note', label: 'PO', capturedAt: '2026-08-09T10:00:00.000Z'}}});
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({authorized: true, requestHash: expect.stringMatching(/^[0-9a-f]{64}$/)}));
  });

  it('accepts only bounded immutable materialization preconditions', async () => {
    if (!actor.ok) throw new Error('issuer');
    const user = actor.value.issueUser('10000000-0000-4000-8000-000000000001'); if (!user.ok) throw new Error('actor');
    const execute = vi.fn().mockResolvedValue({status: 'completed', receipt: {commandId: '20000000-0000-4000-8000-000000000001', commandType: 'project_plan.materialize', result: {ok: true, value: {}}}});
    const service = createProjectPlanService({execute, inspect: vi.fn(), simulate: vi.fn()} as unknown as ProjectPlanStore);
    const command = {commandId: '20000000-0000-4000-8000-000000000001', workspaceId: '20000000-0000-4000-8000-000000000002', correlationId: '20000000-0000-4000-8000-000000000003',
      idempotencyKey: 'materialize:1', issuedAt: '2026-08-09T10:00:00.000Z', actor: user.value, type: 'project_plan.materialize' as const,
      payload: {projectId: '20000000-0000-4000-8000-000000000004', planId: '20000000-0000-4000-8000-000000000005', expectedPlanVersion: 1,
        expectedPlanHash: 'a'.repeat(64), expectedSourceManifestHash: 'b'.repeat(64)}};
    await expect(service.execute(command)).resolves.toMatchObject({status: 'completed'});
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({authorized: true, requestHash: expect.stringMatching(/^[0-9a-f]{64}$/)}));
    const firstHash = execute.mock.calls[0]![0].requestHash;
    await expect(service.execute({...command, commandId: '30000000-0000-4000-8000-000000000001',
      correlationId: '30000000-0000-4000-8000-000000000002', issuedAt: '2026-08-09T10:01:00.000Z'})).resolves.toMatchObject({status: 'completed'});
    expect(execute.mock.calls[1]![0].requestHash).toBe(firstHash);
    await expect(service.execute({...command, payload: {...command.payload, expectedPlanVersion: 0}})).resolves.toMatchObject({status: 'rejected', error: {code: 'INVALID_COMMAND'}});
  });

  it('calls semantic planning only after a prepared exact corpus and keeps failures retryable', async () => {
    if (!actor.ok) throw new Error('issuer');
    const user = actor.value.issueUser('10000000-0000-4000-8000-000000000001'); if (!user.ok) throw new Error('actor');
    const execute = vi.fn().mockResolvedValue({status: 'completed', receipt: {commandId: '20000000-0000-4000-8000-000000000001', commandType: 'project_plan.draft.generate', result: {ok: true, value: {}}}});
    const artifact = {id: '20000000-0000-4000-8000-000000000006', projectId: '20000000-0000-4000-8000-000000000004', name: 'Passport', sourceKind: 'project_passport' as const, mediaType: 'text/plain' as const, content: 'Confirmed project passport', sizeBytes: 25, sha256: sourceArtifactDigest('Confirmed project passport'), sourceFile: null, provenance: {kind: 'manager_note' as const, label: 'PO', capturedAt: '2026-08-09T10:00:00.000Z'}, version: 1 as const};
    const preparation = {idempotencyKey: 'generate:1', sourceManifest: [{artifactId: artifact.id, version: 1, sha256: artifact.sha256}], sourceManifestHash: 'd'.repeat(64), artifacts: [artifact], planningContext, planningContextHash: 'c'.repeat(64)};
    const prepareSemanticGeneration = vi.fn().mockResolvedValue({ok: true, value: {kind: 'ready', request: preparation}});
    const generate = vi.fn().mockResolvedValue({ok: false, error: {code: 'INVALID_TRANSITION', message: 'Hermes unavailable'}});
    const service = createProjectPlanService({execute, prepareSemanticGeneration, inspect: vi.fn(), simulate: vi.fn()} as unknown as ProjectPlanStore, {generate});
    const command = {commandId: '20000000-0000-4000-8000-000000000001', workspaceId: '20000000-0000-4000-8000-000000000002', correlationId: '20000000-0000-4000-8000-000000000003',
      idempotencyKey: 'generate:1', issuedAt: '2026-08-09T10:00:00.000Z', actor: user.value, type: 'project_plan.draft.generate' as const,
      payload: {projectId: '20000000-0000-4000-8000-000000000004', planId: '20000000-0000-4000-8000-000000000005', expectedRevision: null,
        sourceManifest: [{artifactId: '20000000-0000-4000-8000-000000000006', version: 1, sha256: 'a'.repeat(64)}]}};
    await expect(service.execute(command)).resolves.toMatchObject({status: 'completed'});
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({artifacts: [artifact], idempotencyKey: 'generate:1'}));
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({authorized: true, semanticGeneration: expect.objectContaining({ok: false}), command: expect.objectContaining({idempotencyKey: expect.stringMatching(/^project_plan\.semantic_attempt\.v1:/)} )}));
    generate.mockResolvedValueOnce({ok: true, value: semanticDefinition});
    await expect(service.execute({...command, commandId: '30000000-0000-4000-8000-000000000001', correlationId: '30000000-0000-4000-8000-000000000002'})).resolves.toMatchObject({status: 'completed'});
    expect(execute).toHaveBeenLastCalledWith(expect.objectContaining({semanticGeneration: {ok: true, value: semanticDefinition}, semanticPlanningContextHash: 'c'.repeat(64), command: expect.objectContaining({idempotencyKey: 'generate:1'})}));
    prepareSemanticGeneration.mockResolvedValueOnce({ok: false, error: {code: 'INVALID_TRANSITION', message: 'Dossier incomplete'}});
    await service.execute(command);
    expect(generate).toHaveBeenCalledTimes(2);
    await expect(service.execute({...command, payload: {...command.payload, sourceManifest: []}})).resolves.toMatchObject({status: 'rejected', error: {code: 'INVALID_COMMAND'}});
  });

  it('keeps the canonical generation key available after an authority denial', async () => {
    if (!actor.ok) throw new Error('issuer');
    const user = actor.value.issueUser('10000000-0000-4000-8000-000000000001'); if (!user.ok) throw new Error('actor');
    const execute = vi.fn().mockResolvedValue({status: 'completed', receipt: {commandId: '20000000-0000-4000-8000-000000000001', commandType: 'project_plan.draft.generate', result: {ok: true, value: {}}}});
    const artifact = {id: '20000000-0000-4000-8000-000000000006', projectId: '20000000-0000-4000-8000-000000000004', name: 'Passport', sourceKind: 'project_passport' as const, mediaType: 'text/plain' as const, content: 'Confirmed project passport', sizeBytes: 25, sha256: sourceArtifactDigest('Confirmed project passport'), sourceFile: null, provenance: {kind: 'manager_note' as const, label: 'PO', capturedAt: '2026-08-09T10:00:00.000Z'}, version: 1 as const};
    const preparation = {idempotencyKey: 'generate:po', sourceManifest: [{artifactId: artifact.id, version: 1, sha256: artifact.sha256}], sourceManifestHash: 'd'.repeat(64), artifacts: [artifact], planningContext, planningContextHash: 'c'.repeat(64)};
    const prepareSemanticGeneration = vi.fn()
      .mockResolvedValueOnce({ok: false, error: {code: 'CAPABILITY_DENIED', message: 'Only Product Owner'}})
      .mockResolvedValueOnce({ok: true, value: {kind: 'ready', request: preparation}});
    const service = createProjectPlanService({execute, prepareSemanticGeneration, inspect: vi.fn(), simulate: vi.fn()} as unknown as ProjectPlanStore, {generate: vi.fn().mockResolvedValue({ok: true, value: semanticDefinition})});
    const command = {commandId: '20000000-0000-4000-8000-000000000001', workspaceId: '20000000-0000-4000-8000-000000000002', correlationId: '20000000-0000-4000-8000-000000000003', idempotencyKey: 'generate:po', issuedAt: '2026-08-09T10:00:00.000Z', actor: user.value, type: 'project_plan.draft.generate' as const, payload: {projectId: '20000000-0000-4000-8000-000000000004', planId: '20000000-0000-4000-8000-000000000005', expectedRevision: null, sourceManifest: [{artifactId: artifact.id, version: 1, sha256: artifact.sha256}]}};
    await service.execute(command);
    expect(execute).toHaveBeenLastCalledWith(expect.objectContaining({command: expect.objectContaining({idempotencyKey: expect.stringMatching(/^project_plan\.semantic_attempt\.v1:/)})}));
    await service.execute({...command, commandId: '30000000-0000-4000-8000-000000000001', correlationId: '30000000-0000-4000-8000-000000000002'});
    expect(execute).toHaveBeenLastCalledWith(expect.objectContaining({command: expect.objectContaining({idempotencyKey: 'generate:po'}), semanticGeneration: {ok: true, value: semanticDefinition}}));
  });

  it('replays an authorized completed draft without calling Hermes or the generic store', async () => {
    if (!actor.ok) throw new Error('issuer');
    const user = actor.value.issueUser('10000000-0000-4000-8000-000000000001'); if (!user.ok) throw new Error('actor');
    const receipt = {commandId: '20000000-0000-4000-8000-000000000001', commandType: 'project_plan.draft.generate' as const, result: {ok: true as const, value: {}}};
    const execute = vi.fn(); const generate = vi.fn();
    const prepareSemanticGeneration = vi.fn().mockResolvedValue({ok: true, value: {kind: 'replay', receipt}});
    const service = createProjectPlanService({execute, prepareSemanticGeneration, inspect: vi.fn(), simulate: vi.fn()} as unknown as ProjectPlanStore, {generate});
    const command = {commandId: '20000000-0000-4000-8000-000000000001', workspaceId: '20000000-0000-4000-8000-000000000002', correlationId: '20000000-0000-4000-8000-000000000003', idempotencyKey: 'generate:replay', issuedAt: '2026-08-09T10:00:00.000Z', actor: user.value, type: 'project_plan.draft.generate' as const, payload: {projectId: '20000000-0000-4000-8000-000000000004', planId: '20000000-0000-4000-8000-000000000005', expectedRevision: null, sourceManifest: [{artifactId: '20000000-0000-4000-8000-000000000006', version: 1, sha256: 'a'.repeat(64)}]}};
    await expect(service.execute(command)).resolves.toEqual({status: 'replayed', receipt});
    expect(generate).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
  });
});
