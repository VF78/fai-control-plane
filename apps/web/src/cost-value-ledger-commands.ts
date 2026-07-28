import {randomUUID} from 'node:crypto';
import type {LedgerCost, ValueEvidence} from '@fai-control-plane/db';
import {requireOperatorSession} from './operator-auth-runtime';
import {getCostValueLedgerRuntime} from './cost-value-ledger-runtime';

const MAX_BODY_BYTES = 8 * 1024;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const REFERENCE_PATTERN = /^[^\u0000-\u001f\u007f]{1,512}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const noStore = {'Cache-Control': 'no-store'} as const;

type Runtime = Awaited<ReturnType<typeof getCostValueLedgerRuntime>>;
type Dependencies = Readonly<{
  requireSession: typeof requireOperatorSession;
  getRuntime(): Promise<Runtime>;
  now(): Date;
  nextId(): string;
}>;

const defaults: Dependencies = {
  requireSession: requireOperatorSession,
  getRuntime: getCostValueLedgerRuntime,
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

const boundedString = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum;

const instant = (value: unknown, latest: Date): value is string =>
  typeof value === 'string' &&
  ISO_INSTANT_PATTERN.test(value) &&
  new Date(value).toISOString() === value &&
  new Date(value).getTime() <= latest.getTime();

const minorAmount = (value: unknown, positive = false): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= (positive ? 1 : 0);

const readBoundedJson = async (request: Request): Promise<unknown> => {
  const contentType = request.headers.get('content-type')?.toLowerCase();
  const contentLength = request.headers.get('content-length');
  if (
    contentType !== 'application/json' ||
    (contentLength !== null &&
      (!/^[0-9]+$/.test(contentLength) ||
        Number(contentLength) > MAX_BODY_BYTES)) ||
    request.body === null
  ) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_BODY_BYTES) return null;
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    return null;
  }
};

const suppliedCsrf = (value: unknown): string | null =>
  isRecord(value) && boundedString(value._csrf, 128) ? value._csrf : null;

type ParsedInput =
  | Readonly<{
      csrfToken: string;
      idempotencyKey: string;
      kind: 'cost';
      cost: LedgerCost;
      correctsCommandId: string | null;
    }>
  | Readonly<{
      csrfToken: string;
      idempotencyKey: string;
      kind: 'value_evidence';
      valueEvidence: ValueEvidence;
    }>;

const parseInput = (value: unknown, now: Date): ParsedInput | null => {
  if (
    !isRecord(value) ||
    !boundedString(value._csrf, 128) ||
    !boundedString(value.idempotencyKey, 128) ||
    !VERSION_PATTERN.test(value.idempotencyKey)
  ) return null;
  if (value.kind === 'cost') {
    const correctsCommandId = value.correctsCommandId;
    if (correctsCommandId !== null &&
      (typeof correctsCommandId !== 'string' ||
        !UUID_PATTERN.test(correctsCommandId))) return null;
    if (value.state === 'calculated') {
      if (
        !exactKeys(value, [
          '_csrf', 'idempotencyKey', 'kind', 'state', 'amountMinor',
          'currency', 'pricingVersion', 'pricingEffectiveAt',
          'allocationFormulaVersion', 'correctsCommandId'
        ]) ||
        !minorAmount(value.amountMinor, true) ||
        typeof value.currency !== 'string' ||
        !CURRENCY_PATTERN.test(value.currency) ||
        typeof value.pricingVersion !== 'string' ||
        !VERSION_PATTERN.test(value.pricingVersion) ||
        !instant(value.pricingEffectiveAt, now) ||
        typeof value.allocationFormulaVersion !== 'string' ||
        !VERSION_PATTERN.test(value.allocationFormulaVersion)
      ) return null;
      return {
        csrfToken: value._csrf,
        idempotencyKey: value.idempotencyKey,
        kind: 'cost',
        correctsCommandId,
        cost: {
          state: 'calculated',
          amountMinor: value.amountMinor,
          currency: value.currency,
          pricingVersion: value.pricingVersion,
          pricingEffectiveAt: value.pricingEffectiveAt,
          allocationFormulaVersion: value.allocationFormulaVersion
        }
      };
    }
    if (
      !['unknown', 'pending', 'error'].includes(value.state as string) ||
      !exactKeys(value, [
        '_csrf', 'idempotencyKey', 'kind', 'state', 'reason',
        'correctsCommandId'
      ]) ||
      !boundedString(value.reason, 256)
    ) return null;
    return {
      csrfToken: value._csrf,
      idempotencyKey: value.idempotencyKey,
      kind: 'cost',
      correctsCommandId,
      cost: {
        state: value.state as 'unknown' | 'pending' | 'error',
        reason: value.reason
      }
    };
  }
  if (
    value.kind !== 'value_evidence' ||
    !exactKeys(value, [
      '_csrf', 'idempotencyKey', 'kind', 'baselineAmountMinor',
      'outcomeAmountMinor', 'currency', 'method', 'observedAt',
      'evidenceReference', 'formulaVersion'
    ]) ||
    !minorAmount(value.baselineAmountMinor) ||
    !minorAmount(value.outcomeAmountMinor) ||
    typeof value.currency !== 'string' ||
    !CURRENCY_PATTERN.test(value.currency) ||
    typeof value.method !== 'string' ||
    !VERSION_PATTERN.test(value.method) ||
    !instant(value.observedAt, now) ||
    typeof value.evidenceReference !== 'string' ||
    !REFERENCE_PATTERN.test(value.evidenceReference) ||
    value.formulaVersion !== 'roi_v1'
  ) return null;
  return {
    csrfToken: value._csrf,
    idempotencyKey: value.idempotencyKey,
    kind: 'value_evidence',
    valueEvidence: {
      baselineAmountMinor: value.baselineAmountMinor,
      outcomeAmountMinor: value.outcomeAmountMinor,
      currency: value.currency,
      method: value.method,
      observedAt: value.observedAt,
      evidenceReference: value.evidenceReference,
      formulaVersion: value.formulaVersion
    }
  };
};

const unavailable = (status = 503): Response =>
  Response.json({status: 'unavailable'}, {status, headers: noStore});

export async function appendRunLedgerCommand(
  request: Request,
  agentRunId: string,
  dependencies: Dependencies = defaults
): Promise<Response> {
  const body = await readBoundedJson(request);
  const authorization = await dependencies.requireSession(request, {
    csrfToken: suppliedCsrf(body)
  });
  if (!authorization.ok) return authorization.response;
  const now = dependencies.now();
  const input = parseInput(body, now);
  if (input === null || !UUID_PATTERN.test(agentRunId)) {
    return unavailable(400);
  }
  try {
    const runtime = await dependencies.getRuntime();
    const commandId = dependencies.nextId();
    const result = await runtime.append({
      workspaceId: authorization.runtime.config.workspaceId,
      actorId: authorization.session.actorId,
      agentRunId,
      idempotencyKey: input.idempotencyKey,
      commandId,
      correlationId: commandId,
      recordedAt: now,
      ...(input.kind === 'cost'
        ? {
            kind: input.kind,
            cost: input.cost,
            correctsCommandId: input.correctsCommandId
          }
        : {kind: input.kind, valueEvidence: input.valueEvidence})
    });
    if (result.status !== 'completed' && result.status !== 'replayed') {
      return unavailable(result.status === 'forbidden' ? 403 : 400);
    }
    return Response.json(
      {status: result.status, record: result.record},
      {status: result.status === 'completed' ? 201 : 200, headers: noStore}
    );
  } catch {
    return unavailable();
  }
}
