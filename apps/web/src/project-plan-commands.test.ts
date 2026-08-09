import {createHash} from 'node:crypto';
import {expect, it, vi} from 'vitest';
import {projectPlanCommand, type ProjectPlanCommandDependencies} from './project-plan-commands';
import {postProjectPlan} from './project-plan-controls';

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
  const response = await projectPlanCommand(request({_csrf: 'csrf', action: 'record_source', projectId, artifactId: id, name: 'Интервью', mediaType: 'text/plain', content, provenanceLabel: 'Product Owner'}), dependencies(execute));
  expect(response.status).toBe(200);
  expect(execute).toHaveBeenCalledWith(expect.objectContaining({payload: expect.objectContaining({
    sizeBytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex')
  })}));
});

it('rejects oversized source input before a runtime write', async () => {
  const execute = vi.fn(); const deps = dependencies(execute);
  const response = await projectPlanCommand(request({_csrf: 'csrf', action: 'record_source', projectId, artifactId: id, name: 'X', mediaType: 'text/plain', content: 'x', provenanceLabel: 'Y'}, {'content-length': String(301 * 1024)}), deps);
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
  const payload = {_csrf: 'csrf', action: 'record_source', projectId, artifactId: id, name: 'Интервью', mediaType: 'text/plain', content: 'Факт', provenanceLabel: 'PO'};
  const response = await projectPlanCommand(request(payload), dependencies(execute));
  expect(response.status).toBe(403);
  await expect(response.json()).resolves.toMatchObject({status: 'capability_denied', message: 'Only Product Owner'});
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({status: 'capability_denied', message: 'Only Product Owner'}), {status: 403, headers: {'content-type': 'application/json'}}));
  vi.stubGlobal('fetch', fetchMock);
  await expect(postProjectPlan(payload)).rejects.toThrow('Only Product Owner');
  vi.unstubAllGlobals();
});
