import {createHash, randomUUID} from 'node:crypto';
import {validateProjectPlanDefinition, type ProjectPlanDefinition, type SourceArtifactMediaType} from '@fai-control-plane/domain';
import {requireOperatorSession} from './operator-auth-runtime';
import {getDeliveryRuntime} from './delivery-runtime';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const noStore = {'Cache-Control': 'no-store'};
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const invalid = (status: string, code = 400) => Response.json({status}, {status: code, headers: noStore});
const commandError = (error: Readonly<{code: string; message: string}>) => {
  const status = error.code === 'CAPABILITY_DENIED' || error.code === 'POLICY_DENIED' ? 403
    : error.code === 'NOT_FOUND' ? 404
    : error.code === 'VERSION_CONFLICT' || error.code === 'INVALID_TRANSITION' || error.code === 'IDEMPOTENCY_KEY_REUSED' ? 409
    : error.code === 'INVALID_COMMAND' || error.code === 'SECRET_VALUE_FORBIDDEN' ? 422 : 400;
  return Response.json({status: error.code.toLowerCase(), message: error.message}, {status, headers: noStore});
};
const mutationResponse = (result: Awaited<ReturnType<Awaited<ReturnType<typeof getDeliveryRuntime>>['plan']['execute']>>) => {
  if (!('receipt' in result)) return commandError(result.error);
  if (!result.receipt.result.ok) return commandError(result.receipt.result.error);
  return Response.json({receipt: {commandId: result.receipt.commandId, commandType: result.receipt.commandType},
    ...('materialization' in result.receipt.result.value ? {materialization: result.receipt.result.value.materialization} : {})}, {headers: noStore});
};
const MAX_BODY_BYTES = 300 * 1024;
const body = async (request: Request) => {
  if (request.headers.get('content-type')?.toLowerCase() !== 'application/json' || request.body === null) return null;
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) {
    await request.body.cancel().catch(() => undefined); return null;
  }
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_BODY_BYTES) { await reader.cancel().catch(() => undefined); return null; }
      chunks.push(chunk.value);
    }
  } catch { return null; } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)) as unknown; } catch { return null; }
};
const parsedDefinition = (value: unknown): ProjectPlanDefinition | null => { const result = validateProjectPlanDefinition(value); return result.ok ? result.value : null; };
export type ProjectPlanCommandDependencies = Readonly<{requireSession: typeof requireOperatorSession; getRuntime: typeof getDeliveryRuntime; nextId(): string; now(): Date}>;
const dependencies: ProjectPlanCommandDependencies = {requireSession: requireOperatorSession, getRuntime: getDeliveryRuntime, nextId: randomUUID, now: () => new Date()};

export async function projectPlanCommand(request: Request, overrides: ProjectPlanCommandDependencies = dependencies): Promise<Response> {
  const value = await body(request); if (value === null) return invalid('invalid_request');
  const csrf = isObject(value) && typeof value._csrf === 'string' ? value._csrf : null;
  const auth = await overrides.requireSession(request, {csrfToken: csrf}); if (!auth.ok) return auth.response;
  if (!isObject(value) || typeof value.action !== 'string' || typeof value.projectId !== 'string' || !UUID.test(value.projectId)) return invalid('invalid_request');
  const runtime = await overrides.getRuntime(); const actor = await runtime.actor(auth.runtime.config.workspaceId, auth.session.actorId); if (!actor.ok) return invalid('forbidden', 403);
  const base = {commandId: overrides.nextId(), workspaceId: auth.runtime.config.workspaceId, correlationId: overrides.nextId(), issuedAt: overrides.now().toISOString(), actor: actor.value};
  try {
    if (value.action === 'record_source' && exact(value, ['_csrf', 'action', 'projectId', 'artifactId', 'name', 'mediaType', 'content', 'provenanceLabel']) &&
      typeof value.artifactId === 'string' && UUID.test(value.artifactId) &&
      typeof value.name === 'string' && value.name.trim() === value.name && value.name.length > 0 && value.name.length <= 160 &&
      ['text/plain', 'text/markdown', 'application/json'].includes(value.mediaType as string) && typeof value.content === 'string' &&
      typeof value.provenanceLabel === 'string' && value.provenanceLabel.trim() === value.provenanceLabel && value.provenanceLabel.length > 0 && value.provenanceLabel.length <= 160) {
      const sizeBytes = Buffer.byteLength(value.content); if (sizeBytes < 1 || sizeBytes > 256 * 1024) return invalid('artifact_too_large', 413);
      const result = await runtime.plan.execute({...base, idempotencyKey: `project_plan.source.record.v1:${value.artifactId}`, type: 'project_plan.source.record', payload: {
        artifactId: value.artifactId, projectId: value.projectId, name: value.name, mediaType: value.mediaType as SourceArtifactMediaType, content: value.content,
        sizeBytes, sha256: createHash('sha256').update(value.content, 'utf8').digest('hex'), provenance: {kind: 'manager_note', label: value.provenanceLabel, capturedAt: base.issuedAt}
      }});
      return mutationResponse(result);
    }
    if ((value.action === 'save_draft' || value.action === 'simulate') && exact(value, ['_csrf', 'action', 'projectId', 'planId', 'expectedRevision', 'definition']) &&
      typeof value.planId === 'string' && UUID.test(value.planId) && (value.expectedRevision === null || Number.isSafeInteger(value.expectedRevision) && (value.expectedRevision as number) > 0)) {
      const definition = parsedDefinition(value.definition); if (definition === null) return invalid('invalid_plan');
      if (value.action === 'simulate') {
        const simulation = await runtime.plan.simulate({workspaceId: base.workspaceId, projectId: value.projectId, definition, actor: actor.value});
        return simulation === null ? invalid('simulation_unavailable', 403) : Response.json({simulation}, {headers: noStore});
      }
      const result = await runtime.plan.execute({...base, idempotencyKey: `project_plan.draft.save.v1:${value.planId}:${value.expectedRevision ?? 0}:${createHash('sha256').update(JSON.stringify(definition)).digest('hex')}`,
        type: 'project_plan.draft.save', payload: {planId: value.planId, projectId: value.projectId, expectedRevision: value.expectedRevision as number | null, definition}});
      return mutationResponse(result);
    }
    if (value.action === 'approve' && exact(value, ['_csrf', 'action', 'projectId', 'planId', 'expectedRevision', 'expectedPlanHash', 'expectedSimulationHash']) &&
      typeof value.planId === 'string' && UUID.test(value.planId) && Number.isSafeInteger(value.expectedRevision) && (value.expectedRevision as number) > 0 &&
      typeof value.expectedPlanHash === 'string' && typeof value.expectedSimulationHash === 'string') {
      const result = await runtime.plan.execute({...base, idempotencyKey: `project_plan.approve.v1:${value.planId}:${value.expectedRevision}`,
        type: 'project_plan.approve', payload: {planId: value.planId, expectedRevision: value.expectedRevision as number, expectedPlanHash: value.expectedPlanHash, expectedSimulationHash: value.expectedSimulationHash}});
      return mutationResponse(result);
    }
    if (value.action === 'materialize' && exact(value, ['_csrf', 'action', 'projectId', 'planId', 'expectedPlanVersion', 'expectedPlanHash', 'expectedSourceManifestHash']) &&
      typeof value.planId === 'string' && UUID.test(value.planId) && Number.isSafeInteger(value.expectedPlanVersion) && (value.expectedPlanVersion as number) > 0 &&
      typeof value.expectedPlanHash === 'string' && /^[0-9a-f]{64}$/.test(value.expectedPlanHash) &&
      typeof value.expectedSourceManifestHash === 'string' && /^[0-9a-f]{64}$/.test(value.expectedSourceManifestHash)) {
      const result = await runtime.plan.execute({...base,
        idempotencyKey: `project_plan.materialize.v1:${value.planId}:${value.expectedPlanVersion}:${value.expectedPlanHash}:${value.expectedSourceManifestHash}`,
        type: 'project_plan.materialize', payload: {projectId: value.projectId, planId: value.planId,
          expectedPlanVersion: value.expectedPlanVersion as number, expectedPlanHash: value.expectedPlanHash,
          expectedSourceManifestHash: value.expectedSourceManifestHash}});
      return mutationResponse(result);
    }
    return invalid('invalid_request');
  } catch { return invalid('unavailable', 503); }
}
