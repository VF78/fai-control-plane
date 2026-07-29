import {randomUUID} from 'node:crypto';
import {defaultDeliveryProtocolDefinition, validateDeliveryProtocolDefinition, type DeliveryEvidenceReference, type DeliveryProtocolDefinition} from '@fai-control-plane/domain';
import {requireOperatorSession} from './operator-auth-runtime';
import {getDeliveryRuntime} from './delivery-runtime';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i;
const noStore = {'Cache-Control': 'no-store'};
const invalid = (status: string, code = 400) => Response.json({status}, {status: code, headers: noStore});
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const boundedJson = async (request: Request): Promise<unknown> => {
  if (request.headers.get('content-type')?.toLowerCase() !== 'application/json' || request.body === null) return null;
  const length = request.headers.get('content-length'); if (length !== null && (!/^\d+$/.test(length) || Number(length) > 32 * 1024)) return null;
  const text = await request.text(); if (Buffer.byteLength(text) > 32 * 1024) return null;
  try { return JSON.parse(text) as unknown; } catch { return null; }
};
const csrf = (value: unknown) => isRecord(value) && typeof value._csrf === 'string' && value._csrf.length > 0 && value._csrf.length <= 128 ? value._csrf : null;
const protocolDefinition = (value: unknown): DeliveryProtocolDefinition | null => {
  const parsed = validateDeliveryProtocolDefinition(value); return parsed.ok ? parsed.value : null;
};
const receipt = (value: {receipt: {commandId: string; commandType: string}}) => ({receipt: {commandId: value.receipt.commandId, commandType: value.receipt.commandType}});

export async function deliveryProtocolCommand(request: Request): Promise<Response> {
  const body = await boundedJson(request); const authorization = await requireOperatorSession(request, {csrfToken: csrf(body)});
  if (!authorization.ok) return authorization.response;
  if (!isRecord(body) || typeof body.action !== 'string' || typeof body.projectId !== 'string' || !UUID.test(body.projectId)) return invalid('invalid_request');
  const runtime = await getDeliveryRuntime(); const actor = await runtime.actor(authorization.runtime.config.workspaceId, authorization.session.actorId);
  if (!actor.ok) return invalid('forbidden', 403);
  const base = {commandId: randomUUID(), workspaceId: authorization.runtime.config.workspaceId, correlationId: randomUUID(), idempotencyKey: '', issuedAt: new Date().toISOString(), actor: actor.value};
  try {
    if (body.action === 'create_default' && exact(body, ['_csrf', 'action', 'projectId'])) {
      const result = await runtime.protocol.execute({...base, idempotencyKey: `delivery_protocol.draft.v1:${body.projectId}`, type: 'delivery_protocol.draft', payload: {protocolId: randomUUID(), projectId: body.projectId, name: 'Default delivery protocol', expectedRevision: null, definition: defaultDeliveryProtocolDefinition()}});
      return 'receipt' in result ? Response.json(receipt(result), {headers: noStore}) : invalid(result.error.message, 409);
    }
    if ((body.action === 'draft' || body.action === 'simulate') && exact(body, ['_csrf', 'action', 'projectId', 'protocolId', 'expectedRevision', 'definition']) && typeof body.protocolId === 'string' && UUID.test(body.protocolId) && Number.isInteger(body.expectedRevision) && (body.expectedRevision as number) > 0) {
      const expectedRevision = body.expectedRevision as number;
      const definition = protocolDefinition(body.definition); if (definition === null) return invalid('invalid_protocol');
      if (body.action === 'simulate') {
        const simulation = await runtime.protocol.simulate({...base, idempotencyKey: `delivery_protocol.simulate.v1:${body.protocolId}:${body.expectedRevision}`, type: 'delivery_protocol.simulate', payload: {projectId: body.projectId, definition}});
        return simulation === null ? invalid('simulation_unavailable', 403) : Response.json({simulation}, {headers: noStore});
      }
      const current = await runtime.protocol.get({workspaceId: base.workspaceId, protocolId: body.protocolId, actor: actor.value});
      if (current === null) return invalid('not_found', 404);
      const result = await runtime.protocol.execute({...base, idempotencyKey: `delivery_protocol.draft.v1:${body.protocolId}:${expectedRevision}`, type: 'delivery_protocol.draft', payload: {protocolId: body.protocolId, projectId: body.projectId, name: current.name, expectedRevision, definition}});
      return 'receipt' in result ? Response.json(receipt(result), {headers: noStore}) : invalid(result.error.message, 409);
    }
    if ((body.action === 'publish' || body.action === 'activate') && exact(body, ['_csrf', 'action', 'projectId', 'protocolId', 'expectedRevision']) && typeof body.protocolId === 'string' && UUID.test(body.protocolId) && Number.isInteger(body.expectedRevision) && (body.expectedRevision as number) > 0) {
      const expectedRevision = body.expectedRevision as number;
      const current = await runtime.protocol.get({workspaceId: base.workspaceId, protocolId: body.protocolId, actor: actor.value});
      if (current === null) return invalid('not_found', 404);
      const simulation = body.action === 'publish' ? await runtime.protocol.simulate({...base, idempotencyKey: `delivery_protocol.simulate.v1:${body.protocolId}:${body.expectedRevision}`, type: 'delivery_protocol.simulate', payload: {projectId: body.projectId, definition: current.definition}}) : null;
      if (body.action === 'publish' && (simulation === null || !simulation.valid)) return invalid('simulation_invalid', 409);
      const result = body.action === 'publish'
        ? await runtime.protocol.execute({...base, idempotencyKey: `delivery_protocol.publish.v1:${body.protocolId}:${expectedRevision}`, type: 'delivery_protocol.publish', payload: {protocolId: body.protocolId, expectedRevision, expectedSimulationHash: simulation!.simulationHash}})
        : await runtime.protocol.execute({...base, idempotencyKey: `delivery_protocol.activate.v1:${body.protocolId}:${expectedRevision}`, type: 'delivery_protocol.activate', payload: {protocolId: body.protocolId, expectedRevision}});
      return 'receipt' in result ? Response.json({...receipt(result), ...(simulation === null ? {} : {simulation})}, {headers: noStore}) : invalid(result.error.message, 409);
    }
    return invalid('invalid_request');
  } catch { return invalid('unavailable', 503); }
}

export async function deliveryJourneyCommand(request: Request, workItemId: string): Promise<Response> {
  const body = await boundedJson(request); const authorization = await requireOperatorSession(request, {csrfToken: csrf(body)});
  if (!authorization.ok) return authorization.response;
  if (!UUID.test(workItemId) || !isRecord(body) || typeof body.action !== 'string') return invalid('invalid_request');
  const runtime = await getDeliveryRuntime(); const actor = await runtime.actor(authorization.runtime.config.workspaceId, authorization.session.actorId);
  if (!actor.ok) return invalid('forbidden', 403);
  const base = {commandId: randomUUID(), workspaceId: authorization.runtime.config.workspaceId, correlationId: randomUUID(), idempotencyKey: '', issuedAt: new Date().toISOString(), actor: actor.value};
  try {
    if (body.action === 'start' && exact(body, ['_csrf', 'action', 'protocolId', 'expectedWorkItemVersion', 'deadlineAt']) && typeof body.protocolId === 'string' && UUID.test(body.protocolId) && Number.isInteger(body.expectedWorkItemVersion) && (body.expectedWorkItemVersion as number) > 0 && (body.deadlineAt === null || typeof body.deadlineAt === 'string')) {
      const expectedWorkItemVersion = body.expectedWorkItemVersion as number;
      const deadlineAt = body.deadlineAt as string | null;
      const result = await runtime.journey.execute({...base, idempotencyKey: `delivery_journey.start.v1:${workItemId}:${expectedWorkItemVersion}`, type: 'delivery_journey.start', payload: {workItemId, protocolId: body.protocolId, expectedWorkItemVersion, deadlineAt}});
      return 'receipt' in result ? Response.json(receipt(result), {headers: noStore}) : invalid(result.error.message, 409);
    }
    if (body.action === 'advance' && exact(body, ['_csrf', 'action', 'expectedWorkItemVersion', 'expectedJourneyVersion', 'evidenceReferences']) && Number.isInteger(body.expectedWorkItemVersion) && Number.isInteger(body.expectedJourneyVersion) && (body.expectedWorkItemVersion as number) > 0 && (body.expectedJourneyVersion as number) > 0 && Array.isArray(body.evidenceReferences) && body.evidenceReferences.length <= 25) {
      const evidence = body.evidenceReferences as DeliveryEvidenceReference[];
      const expectedWorkItemVersion = body.expectedWorkItemVersion as number;
      const expectedJourneyVersion = body.expectedJourneyVersion as number;
      const result = await runtime.journey.execute({...base, idempotencyKey: `delivery_journey.advance.v1:${workItemId}:${expectedJourneyVersion}`, type: 'delivery_journey.advance', payload: {workItemId, expectedWorkItemVersion, expectedJourneyVersion, evidenceReferences: evidence}});
      return 'receipt' in result ? Response.json(receipt(result), {headers: noStore}) : invalid(result.error.message, 409);
    }
    return invalid('invalid_request');
  } catch { return invalid('unavailable', 503); }
}
