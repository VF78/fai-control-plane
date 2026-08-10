import {createHash} from 'node:crypto';
import {expect, it, vi} from 'vitest';
import {hashProjectPlanSourceManifest} from '@fai-control-plane/domain';
import {projectPlanCommand, type ProjectPlanCommandDependencies} from './project-plan-commands';
import {defaultGenerationArtifactIds, postProjectPlan} from './project-plan-controls';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const projectId = '22222222-2222-4222-8222-222222222222';
const id = '44444444-4444-4444-8444-444444444444';
const request = (body: unknown, headers: HeadersInit = {}) => new Request('https://control.test/api/project-plan', {method: 'POST', headers: {'content-type': 'application/json', ...headers}, body: JSON.stringify(body)});
const dependencies = (execute: ReturnType<typeof vi.fn>): ProjectPlanCommandDependencies => ({
  requireSession: async () => ({ok: true, session: {actorId: id}, runtime: {config: {workspaceId}}, sessionToken: 'session'} as never),
  getRuntime: async () => ({actor: async () => ({ok: true, value: {} as never}), plan: {execute, simulate: vi.fn()}, protocol: {} as never, journey: {} as never} as never),
  nextId: () => id,
  now: () => new Date('2026-08-09T10:00:00.000Z')
});

it('computes source bytes and digest on the server before the canonical command', async () => {
  const execute = vi.fn().mockResolvedValue({status: 'completed', receipt: {commandId: id, commandType: 'project_plan.source.record', result: {ok: true, value: {}}}});
  const content = 'Факт\nвторая строка';
  const response = await projectPlanCommand(request({_csrf: 'csrf', action: 'record_source', projectId, artifactId: id, name: 'Интервью', sourceKind: 'client_requirements', mediaType: 'text/plain', content, provenanceLabel: 'Product Owner'}), dependencies(execute));
  expect(response.status).toBe(200);
  expect(execute).toHaveBeenCalledWith(expect.objectContaining({payload: expect.objectContaining({
    sizeBytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex')
  })}));
});

it('rejects oversized source input before a runtime write', async () => {
  const execute = vi.fn(); const deps = dependencies(execute);
  const response = await projectPlanCommand(request({_csrf: 'csrf', action: 'record_source', projectId, artifactId: id, name: 'X', sourceKind: 'other', mediaType: 'text/plain', content: 'x', provenanceLabel: 'Y'}, {'content-length': String(301 * 1024)}), deps);
  expect(response.status).toBe(400); expect(execute).not.toHaveBeenCalled();
});

it('rejects chunked oversized and invalid UTF-8 bodies before authentication', async () => {
  const requireSession = vi.fn();
  const chunk = new Uint8Array(160 * 1024).fill(120); let reads = 0; let cancelled = false;
  const oversized = new Request('https://control.test/api/project-plan', {method: 'POST', headers: {'content-type': 'application/json'}, body: new ReadableStream<Uint8Array>({
    pull(controller) { if (reads++ < 2) controller.enqueue(chunk); else controller.close(); },
    cancel() { cancelled = true; }
  }), duplex: 'half'} as RequestInit);
  const invalidUtf8 = new Request('https://control.test/api/project-plan', {method: 'POST', headers: {'content-type': 'application/json'}, body: new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d])});
  const deps = {requireSession, getRuntime: vi.fn(), nextId: () => id, now: () => new Date()} as never;
  expect((await projectPlanCommand(oversized, deps)).status).toBe(400);
  expect(cancelled).toBe(true);
  expect((await projectPlanCommand(invalidUtf8, deps)).status).toBe(400);
  expect(requireSession).not.toHaveBeenCalled();
});

it('maps a persisted failed receipt to 4xx and the client rejects it', async () => {
  const execute = vi.fn().mockResolvedValue({status: 'completed', receipt: {commandId: id, commandType: 'project_plan.source.record', result: {ok: false, error: {code: 'CAPABILITY_DENIED', message: 'Only Product Owner'}}}});
  const payload = {_csrf: 'csrf', action: 'record_source', projectId, artifactId: id, name: 'Интервью', sourceKind: 'client_requirements', mediaType: 'text/plain', content: 'Факт', provenanceLabel: 'PO'};
  const response = await projectPlanCommand(request(payload), dependencies(execute));
  expect(response.status).toBe(403);
  await expect(response.json()).resolves.toMatchObject({status: 'capability_denied', message: 'Only Product Owner'});
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({status: 'capability_denied', message: 'Only Product Owner'}), {status: 403, headers: {'content-type': 'application/json'}}));
  vi.stubGlobal('fetch', fetchMock);
  await expect(postProjectPlan(payload)).rejects.toThrow('Only Product Owner');
  vi.unstubAllGlobals();
});

it('accepts an exact materialization CAS payload and derives a stable replay key', async () => {
  const execute = vi.fn().mockResolvedValue({status: 'completed', receipt: {commandId: id, commandType: 'project_plan.materialize', result: {ok: true, value: {materialization: {workItemCount: 6}}}}});
  const payload = {_csrf: 'csrf', action: 'materialize', projectId, planId: id, expectedPlanVersion: 3,
    expectedPlanHash: 'a'.repeat(64), expectedSourceManifestHash: 'b'.repeat(64)};
  const response = await projectPlanCommand(request(payload), dependencies(execute));
  expect(response.status).toBe(200);
  expect(execute).toHaveBeenCalledWith(expect.objectContaining({
    idempotencyKey: `project_plan.materialize.v1:${id}:3:${'a'.repeat(64)}:${'b'.repeat(64)}`,
    type: 'project_plan.materialize', payload: expect.objectContaining({projectId, planId: id, expectedPlanVersion: 3})
  }));
  await expect(response.json()).resolves.toMatchObject({materialization: {workItemCount: 6}});
});

it('creates a canonical draft-generation command from an exact source manifest', async () => {
  const execute = vi.fn().mockResolvedValue({status: 'completed', receipt: {commandId: id, commandType: 'project_plan.draft.generate', result: {ok: true, value: {plan: {revision: 2}}}}});
  const manifest = [{artifactId: id, version: 1, sha256: 'a'.repeat(64)}];
  const response = await projectPlanCommand(request({_csrf: 'csrf', action: 'generate_draft', projectId, planId: id, expectedRevision: 1, sourceManifest: manifest}), dependencies(execute));
  expect(response.status).toBe(200);
  expect(execute).toHaveBeenCalledWith(expect.objectContaining({
    idempotencyKey: `project_plan.draft.generate.v1:${id}:1:${hashProjectPlanSourceManifest(manifest)}`,
    type: 'project_plan.draft.generate', payload: {planId: id, projectId, expectedRevision: 1, sourceManifest: manifest}
  }));
});

it('rejects an empty or oversized generation corpus before execution', async () => {
  const execute = vi.fn();
  const base = {_csrf: 'csrf', action: 'generate_draft', projectId, planId: id, expectedRevision: null};
  expect((await projectPlanCommand(request({...base, sourceManifest: []}), dependencies(execute))).status).toBe(422);
  expect((await projectPlanCommand(request({...base, sourceManifest: Array.from({length: 33}, () => ({artifactId: id, version: 1, sha256: 'a'.repeat(64)}))}), dependencies(execute))).status).toBe(422);
  expect(execute).not.toHaveBeenCalled();
});

it('rejects an unknown dossier category before execution', async () => {
  const execute = vi.fn();
  const response = await projectPlanCommand(request({_csrf: 'csrf', action: 'record_source', projectId, artifactId: id,
    name: 'Интервью', sourceKind: 'passport', mediaType: 'text/plain', content: 'Факт', provenanceLabel: 'PO'}), dependencies(execute));
  expect(response.status).toBe(400); expect(execute).not.toHaveBeenCalled();
});

it('defaults source selection to all bounded artifacts or a usable bounded subset', () => {
  const artifact = (index: number, sizeBytes: number) => ({id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, name: `Source ${index}`,
    sourceKind: 'other' as const, mediaType: 'text/plain', content: 'x', sizeBytes, sha256: 'a'.repeat(64), sourceFile: null, version: 1, provenance: {kind: 'manager_note' as const, label: 'PO', capturedAt: '2026-08-09T10:00:00.000Z'}});
  expect(defaultGenerationArtifactIds([artifact(1, 10), artifact(2, 10)])).toHaveLength(2);
  expect(defaultGenerationArtifactIds([artifact(1, 200 * 1024), artifact(2, 200 * 1024), artifact(3, 200 * 1024)])).toHaveLength(2);
  expect(defaultGenerationArtifactIds(Array.from({length: 33}, (_, index) => artifact(index + 1, 1)))).toHaveLength(32);
});

it('rejects extra or stale-shaped materialization payloads before execution', async () => {
  const execute = vi.fn();
  const payload = {_csrf: 'csrf', action: 'materialize', projectId, planId: id, expectedPlanVersion: 0,
    expectedPlanHash: 'a'.repeat(64), expectedSourceManifestHash: 'b'.repeat(64), provider: 'github'};
  const response = await projectPlanCommand(request(payload), dependencies(execute));
  expect(response.status).toBe(400);
  expect(execute).not.toHaveBeenCalled();
});
