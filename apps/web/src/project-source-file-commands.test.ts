import {createHash} from 'node:crypto';
import {expect, it, vi} from 'vitest';
import {projectSourceFileCommand, type ProjectSourceFileCommandDependencies} from './project-source-file-commands';

const workspaceId = '11111111-1111-4111-8111-111111111111'; const projectId = '22222222-2222-4222-8222-222222222222'; const id = '44444444-4444-4444-8444-444444444444';
const request = (body: unknown, headers: HeadersInit = {}) => new Request('https://control.test/api/project-plan/source-file', {method: 'POST', headers: {'content-type': 'application/json', ...headers}, body: JSON.stringify(body)});
const valid = () => ({_csrf: 'csrf', projectId, artifactId: id, name: 'Паспорт', sourceKind: 'project_passport', provenanceLabel: 'PO', filename: 'brief.txt', mediaType: 'text/plain', contentBase64: Buffer.from('Текст паспорта').toString('base64')});
const dependencies = (execute = vi.fn().mockResolvedValue({status: 'completed', receipt: {commandId: id, commandType: 'project_plan.source.record', result: {ok: true, value: {}}}})): ProjectSourceFileCommandDependencies => ({
  requireSession: async (_request, input) => input?.csrfToken === 'csrf' ? ({ok: true, session: {actorId: id}, runtime: {config: {workspaceId}}} as never) : ({ok: false, response: new Response(null, {status: 403})} as never),
  getRuntime: async () => ({actor: async () => ({ok: true, value: {} as never}), plan: {execute}} as never),
  extractor: {extract: vi.fn().mockResolvedValue({content: 'Текст паспорта', mediaType: 'text/plain', extractionMethod: 'utf8_text_v1'})}, nextId: () => id, now: () => new Date('2026-08-10T10:00:00.000Z')
});

it('authenticates exact CSRF JSON input and records only extracted text with provenance hashes', async () => {
  const execute = vi.fn().mockResolvedValue({status: 'completed', receipt: {commandId: id, commandType: 'project_plan.source.record', result: {ok: true, value: {}}}}); const deps = dependencies(execute);
  const response = await projectSourceFileCommand(request(valid()), deps);
  expect(response.status).toBe(200);
  expect(execute).toHaveBeenCalledWith(expect.objectContaining({payload: expect.objectContaining({content: 'Текст паспорта', sourceFile: expect.objectContaining({filename: 'brief.txt', rawSizeBytes: Buffer.byteLength('Текст паспорта'), rawSha256: createHash('sha256').update('Текст паспорта').digest('hex'), extractionMethod: 'utf8_text_v1'})})}));
  await expect(response.text()).resolves.not.toContain('contentBase64');
  expect((await projectSourceFileCommand(request({...valid(), _csrf: 'wrong'}), deps)).status).toBe(403);
});

it('rejects pre-auth oversized, malformed base64 and invalid types before a write', async () => {
  const execute = vi.fn(); const deps = dependencies(execute); const requireSession = vi.fn(deps.requireSession); const withSpy = {...deps, requireSession};
  expect((await projectSourceFileCommand(request(valid(), {'content-length': String(4 * 1024 * 1024)}), withSpy)).status).toBe(400);
  expect(requireSession).not.toHaveBeenCalled();
  expect((await projectSourceFileCommand(request({...valid(), contentBase64: '%%%'}), withSpy)).status).toBe(422);
  expect((await projectSourceFileCommand(request({...valid(), filename: 'brief.exe', mediaType: 'application/octet-stream'}), withSpy)).status).toBe(400);
  expect((await projectSourceFileCommand(request({...valid(), extra: 'no'}), withSpy)).status).toBe(400);
  expect(execute).not.toHaveBeenCalled();
});
