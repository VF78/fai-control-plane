import {randomUUID} from 'node:crypto';
import {DEPLOYMENT_PRODUCTION_APPROVE_COMMAND, DEPLOYMENT_REQUEST_COMMAND} from '@fai-control-plane/application';
import {deploymentEnvironments} from '@fai-control-plane/domain';
import {requireOperatorSession} from './operator-auth-runtime';
import {getDeliveryRuntime} from './delivery-runtime';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const noStore = {'Cache-Control': 'no-store'} as const;
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const boundedBody = async (request: Request): Promise<Record<string, unknown> | null> => {
  if (request.headers.get('content-type')?.toLowerCase() !== 'application/json' || request.body === null) return null;
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > 4_096)) {
    await request.body.cancel().catch(() => undefined); return null;
  }
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  try {
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; total += chunk.value.byteLength;
      if (total > 4_096) { await reader.cancel().catch(() => undefined); return null; } chunks.push(chunk.value); }
    const bytes = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const parsed = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; } finally { reader.releaseLock(); }
};
const responseStatus = (code: string) => code === 'CAPABILITY_DENIED' || code === 'POLICY_DENIED' ? 403
  : code === 'NOT_FOUND' ? 404 : ['VERSION_CONFLICT', 'INVALID_TRANSITION', 'IDEMPOTENCY_KEY_REUSED',
      'APPROVAL_REQUIRED'].includes(code) ? 409 : 422;

export type ReleaseEvidenceCommandDependencies = Readonly<{
  requireSession: typeof requireOperatorSession;
  getRuntime: typeof getDeliveryRuntime;
  nextId(): string;
  now(): Date;
}>;
const dependencies: ReleaseEvidenceCommandDependencies = {requireSession: requireOperatorSession,
  getRuntime: getDeliveryRuntime, nextId: randomUUID, now: () => new Date()};

export async function releaseEvidenceCommand(request: Request,
  overrides: ReleaseEvidenceCommandDependencies = dependencies): Promise<Response> {
  const body = await boundedBody(request);
  const authorization = await overrides.requireSession(request, {csrfToken:
    body !== null && typeof body._csrf === 'string' ? body._csrf : null});
  if (!authorization.ok) return authorization.response;
  if (body === null || typeof body._csrf !== 'string' || typeof body.action !== 'string') {
    return Response.json({status: 'invalid_request'}, {status: 400, headers: noStore});
  }
  try {
    const runtime = await overrides.getRuntime();
    const actor = await runtime.actor(authorization.runtime.config.workspaceId, authorization.session.actorId);
    if (!actor.ok) return Response.json({status: 'forbidden'}, {status: 403, headers: noStore});
    const base = {commandId: overrides.nextId(), workspaceId: authorization.runtime.config.workspaceId,
      correlationId: overrides.nextId(), issuedAt: overrides.now().toISOString(), actor: actor.value};
    let result;
    if (body.action === 'request' && exact(body, ['_csrf', 'action', 'deploymentId', 'projectId',
      'workItemId', 'planVersionId', 'materializationId', 'environment', 'sourceCommit',
      'releasePackageReference', 'releasePackageSha256',
      'expectedProjectVersion']) && typeof body.deploymentId === 'string' && UUID.test(body.deploymentId) &&
      typeof body.projectId === 'string' && UUID.test(body.projectId) &&
      (body.workItemId === null || typeof body.workItemId === 'string' && UUID.test(body.workItemId)) &&
      typeof body.planVersionId === 'string' && UUID.test(body.planVersionId) &&
      typeof body.materializationId === 'string' && UUID.test(body.materializationId) &&
      deploymentEnvironments.includes(body.environment as never) &&
      typeof body.sourceCommit === 'string' && /^[0-9a-f]{40}$/.test(body.sourceCommit) &&
      typeof body.releasePackageReference === 'string' && body.releasePackageReference.length <= 512 &&
      typeof body.releasePackageSha256 === 'string' &&
      /^[0-9a-f]{64}$/.test(body.releasePackageSha256) &&
      Number.isSafeInteger(body.expectedProjectVersion) && (body.expectedProjectVersion as number) > 0) {
      result = await runtime.deploymentEvidence.execute({...base, type: DEPLOYMENT_REQUEST_COMMAND,
        idempotencyKey: `deployment-request:v1:${body.deploymentId}:${body.expectedProjectVersion}:${actor.value.actorId}`,
        payload: {deploymentId: body.deploymentId, projectId: body.projectId, workItemId: body.workItemId as string | null,
          planVersionId: body.planVersionId, materializationId: body.materializationId,
          environment: body.environment as 'development' | 'staging' | 'production',
          reference: {kind: 'commit', reference: `git-commit:${body.sourceCommit}`},
          releasePackage: {schemaVersion: 1, sourceCommit: body.sourceCommit,
            artifactReference: body.releasePackageReference, artifactSha256: body.releasePackageSha256},
          expectedProjectVersion: body.expectedProjectVersion as number}});
    } else if (body.action === 'approve_production' && exact(body, ['_csrf', 'action', 'deploymentId',
      'expectedVersion']) && typeof body.deploymentId === 'string' && UUID.test(body.deploymentId) &&
      Number.isSafeInteger(body.expectedVersion) && (body.expectedVersion as number) > 0) {
      result = await runtime.deploymentEvidence.execute({...base, type: DEPLOYMENT_PRODUCTION_APPROVE_COMMAND,
        idempotencyKey: `deployment-production-approve:v1:${body.deploymentId}:${body.expectedVersion}:${actor.value.actorId}`,
        payload: {deploymentId: body.deploymentId, expectedVersion: body.expectedVersion as number}});
    } else return Response.json({status: 'invalid_request'}, {status: 400, headers: noStore});
    if (!('receipt' in result)) return Response.json({status: result.error.code.toLowerCase(),
      message: result.error.message}, {status: responseStatus(result.error.code), headers: noStore});
    if (!result.receipt.result.ok) return Response.json({status: result.receipt.result.error.code.toLowerCase(),
      message: result.receipt.result.error.message},
    {status: responseStatus(result.receipt.result.error.code), headers: noStore});
    return Response.json({receipt: {commandId: result.receipt.commandId,
      commandType: result.receipt.commandType}, deployment: result.receipt.result.value}, {headers: noStore});
  } catch { return Response.json({status: 'unavailable'}, {status: 503, headers: noStore}); }
}
