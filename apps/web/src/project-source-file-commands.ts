import {createHash, randomUUID} from 'node:crypto';
import {projectSourceArtifactKinds, sourceFileMediaTypeForFilename, sourceFileUploadLimits, type ProjectSourceArtifactKind, type SourceFileMediaType} from '@fai-control-plane/domain';
import {requireOperatorSession} from './operator-auth-runtime';
import {getDeliveryRuntime} from './delivery-runtime';
import {createProjectSourceFileExtractor, SourceFileExtractionError, type ProjectSourceFileExtractor} from './project-source-file-extractor';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const noStore = {'Cache-Control': 'no-store'};
const MAX_BODY_BYTES = 3 * 1024 * 1024;
const MAX_BASE64_CHARS = Math.ceil(sourceFileUploadLimits.rawBytes / 3) * 4;
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const invalid = (status: string, code = 400) => Response.json({status}, {status: code, headers: noStore});
const body = async (request: Request) => {
  if (request.headers.get('content-type')?.toLowerCase() !== 'application/json' || request.body === null) return null;
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) { await request.body.cancel().catch(() => undefined); return null; }
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  try {
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; total += chunk.value.byteLength; if (total > MAX_BODY_BYTES) { await reader.cancel().catch(() => undefined); return null; } chunks.push(chunk.value); }
  } catch { return null; } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)) as unknown; } catch { return null; }
};
const decodeBase64 = (value: string): Uint8Array | null => {
  if (value.length === 0 || value.length > MAX_BASE64_CHARS || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64');
  if (bytes.byteLength < 1 || bytes.byteLength > sourceFileUploadLimits.rawBytes || bytes.toString('base64') !== value) return null;
  return new Uint8Array(bytes);
};
export type ProjectSourceFileCommandDependencies = Readonly<{requireSession: typeof requireOperatorSession; getRuntime: typeof getDeliveryRuntime; extractor: ProjectSourceFileExtractor; nextId(): string; now(): Date}>;
const dependencies: ProjectSourceFileCommandDependencies = {requireSession: requireOperatorSession, getRuntime: getDeliveryRuntime, extractor: createProjectSourceFileExtractor(), nextId: randomUUID, now: () => new Date()};

export async function projectSourceFileCommand(request: Request, overrides: ProjectSourceFileCommandDependencies = dependencies): Promise<Response> {
  const value = await body(request); if (value === null) return invalid('invalid_request');
  const csrf = isObject(value) && typeof value._csrf === 'string' ? value._csrf : null;
  const auth = await overrides.requireSession(request, {csrfToken: csrf}); if (!auth.ok) return auth.response;
  if (!isObject(value) || !exact(value, ['_csrf', 'projectId', 'artifactId', 'name', 'sourceKind', 'provenanceLabel', 'filename', 'mediaType', 'contentBase64']) ||
    typeof value.projectId !== 'string' || !UUID.test(value.projectId) || typeof value.artifactId !== 'string' || !UUID.test(value.artifactId) ||
    typeof value.name !== 'string' || value.name.trim() !== value.name || value.name.length < 1 || value.name.length > 160 ||
    !projectSourceArtifactKinds.includes(value.sourceKind as ProjectSourceArtifactKind) ||
    typeof value.provenanceLabel !== 'string' || value.provenanceLabel.trim() !== value.provenanceLabel || value.provenanceLabel.length < 1 || value.provenanceLabel.length > 160 ||
    typeof value.filename !== 'string' || sourceFileMediaTypeForFilename(value.filename) === null ||
    value.mediaType !== sourceFileMediaTypeForFilename(value.filename) || typeof value.contentBase64 !== 'string') return invalid('invalid_request');
  const rawBytes = decodeBase64(value.contentBase64); if (rawBytes === null) return invalid('invalid_file', 422);
  let file;
  try { file = await overrides.extractor.extract({filename: value.filename, mediaType: value.mediaType as SourceFileMediaType, rawBytes}); }
  catch (error) { return error instanceof SourceFileExtractionError ? invalid('invalid_file', 422) : invalid('unavailable', 503); }
  const runtime = await overrides.getRuntime(); const actor = await runtime.actor(auth.runtime.config.workspaceId, auth.session.actorId); if (!actor.ok) return invalid('forbidden', 403);
  const issuedAt = overrides.now().toISOString();
  try {
    const result = await runtime.plan.execute({commandId: overrides.nextId(), workspaceId: auth.runtime.config.workspaceId, correlationId: overrides.nextId(), issuedAt, actor: actor.value,
      idempotencyKey: `project_plan.source.record.v1:${value.artifactId}`, type: 'project_plan.source.record', payload: {
        artifactId: value.artifactId, projectId: value.projectId, name: value.name, sourceKind: value.sourceKind as ProjectSourceArtifactKind, mediaType: file.mediaType,
        content: file.content, sizeBytes: Buffer.byteLength(file.content, 'utf8'), sha256: createHash('sha256').update(file.content, 'utf8').digest('hex'),
        sourceFile: {filename: value.filename, mediaType: value.mediaType as SourceFileMediaType, rawSizeBytes: rawBytes.byteLength, rawSha256: createHash('sha256').update(rawBytes).digest('hex'), extractionMethod: file.extractionMethod, extractionVersion: 1},
        provenance: {kind: 'manager_upload', label: value.provenanceLabel, capturedAt: issuedAt}
      }
    });
    if (!('receipt' in result)) return invalid(result.error.code.toLowerCase(), result.error.code === 'NOT_FOUND' ? 404 : 422);
    if (!result.receipt.result.ok) return invalid(result.receipt.result.error.code.toLowerCase(), 422);
    return Response.json({receipt: {commandId: result.receipt.commandId, commandType: result.receipt.commandType}}, {headers: noStore});
  } catch { return invalid('unavailable', 503); }
}
