import {randomUUID} from 'node:crypto';
import {
  RISK_SIGNAL_REENTRY_CONDITION,
  riskSignalDispositionReasons
} from '@fai-control-plane/db';
import {requireOperatorSession} from './operator-auth-runtime';
import {getRiskSignalDispositionRuntime} from './risk-signal-disposition-runtime';

const MAX_BODY_BYTES = 4 * 1024;
const MAX_EXPIRY_MS = 30 * 24 * 60 * 60 * 1_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const noStore = {'Cache-Control': 'no-store'} as const;

type Runtime = Awaited<ReturnType<typeof getRiskSignalDispositionRuntime>>;
export type RiskSignalDispositionCommandDependencies = Readonly<{
  requireSession: typeof requireOperatorSession;
  getRuntime(): Promise<Runtime>;
  now(): Date;
  nextId(): string;
}>;

const dependencies: RiskSignalDispositionCommandDependencies = {
  requireSession: requireOperatorSession,
  getRuntime: getRiskSignalDispositionRuntime,
  now: () => new Date(),
  nextId: randomUUID
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const exactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[]
): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length &&
    actual.every((key) => keys.includes(key));
};
const csrf = (value: unknown): string | null =>
  isRecord(value) &&
  typeof value._csrf === 'string' &&
  value._csrf.length > 0 &&
  value._csrf.length <= 128
    ? value._csrf
    : null;
const readJson = async (request: Request): Promise<unknown> => {
  const length = request.headers.get('content-length');
  if (
    request.headers.get('content-type')?.toLowerCase() !== 'application/json' ||
    request.body === null ||
    (length !== null &&
      (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES))
  ) {
    return null;
  }
  const text = await request.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
};
const error = (status: string, code: number): Response =>
  Response.json({status}, {status: code, headers: noStore});

export async function riskSignalDispositionCommand(
  request: Request,
  riskSignalId: string,
  overrides: RiskSignalDispositionCommandDependencies = dependencies
): Promise<Response> {
  const body = await readJson(request);
  const authorization = await overrides.requireSession(request, {
    csrfToken: csrf(body)
  });
  if (!authorization.ok) return authorization.response;
  const now = overrides.now();
  if (
    !UUID_PATTERN.test(riskSignalId) ||
    !isRecord(body) ||
    !exactKeys(body, [
      '_csrf',
      'action',
      'commandId',
      'expectedVersion',
      'expiresAt',
      'projectId',
      'reason'
    ]) ||
    !UUID_PATTERN.test(String(body.commandId)) ||
    !UUID_PATTERN.test(String(body.projectId)) ||
    (body.action !== 'acknowledged' && body.action !== 'snoozed') ||
    !Number.isInteger(body.expectedVersion) ||
    (body.expectedVersion as number) < 0 ||
    typeof body.reason !== 'string' ||
    !(riskSignalDispositionReasons as readonly string[]).includes(body.reason)
  ) {
    return error('invalid_request', 400);
  }
  const reason = body.reason as (typeof riskSignalDispositionReasons)[number];
  const expiresAt = typeof body.expiresAt === 'string'
    ? new Date(body.expiresAt)
    : new Date(Number.NaN);
  if (
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAt.toISOString() !== body.expiresAt ||
    expiresAt.getTime() <= now.getTime() ||
    expiresAt.getTime() > now.getTime() + MAX_EXPIRY_MS
  ) {
    return error('invalid_request', 400);
  }

  try {
    const runtime = await overrides.getRuntime();
    const result = await runtime.execute({
      workspaceId: authorization.runtime.config.workspaceId,
      projectId: body.projectId as string,
      riskSignalId,
      actorId: authorization.session.actorId,
      commandId: body.commandId as string,
      correlationId: overrides.nextId(),
      kind: body.action,
      reason,
      expiresAt,
      reentryCondition: RISK_SIGNAL_REENTRY_CONDITION,
      expectedVersion: body.expectedVersion as number,
      occurredAt: now
    });
    if (!('disposition' in result)) {
      if (result.status === 'forbidden') return error('forbidden', 403);
      if (result.status === 'not_found') return error('not_found', 404);
      return error('version_conflict', 409);
    }
    return Response.json({
      status: result.status,
      disposition: {
        kind: result.disposition.kind,
        expiresAt: result.disposition.expiresAt.toISOString(),
        reentryCondition: result.disposition.reentryCondition,
        version: result.disposition.version
      }
    }, {headers: noStore});
  } catch {
    return error('unavailable', 503);
  }
}
