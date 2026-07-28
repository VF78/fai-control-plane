import {createHash, randomUUID} from 'node:crypto';
import {
  canonicalJson,
  type CanonicalJson
} from '@fai-control-plane/domain';
import {and, asc, eq, inArray, isNull, sql} from 'drizzle-orm';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import * as schema from './schema';

type Database = NodePgDatabase<typeof schema>;

export const COST_LEDGER_COMMAND = 'agent_run.cost.record.v1';
export const VALUE_LEDGER_COMMAND = 'agent_run.value_evidence.record.v1';

export type CostState = 'unknown' | 'pending' | 'calculated' | 'error';

type CalculatedCost = Readonly<{
  state: 'calculated';
  amountMinor: number;
  currency: string;
  pricingVersion: string;
  pricingEffectiveAt: string;
  allocationFormulaVersion: string;
}>;

type UncalculatedCost = Readonly<{
  state: Exclude<CostState, 'calculated'>;
  reason: string;
}>;

export type LedgerCost = CalculatedCost | UncalculatedCost;

export type ValueEvidence = Readonly<{
  baselineAmountMinor: number;
  outcomeAmountMinor: number;
  currency: string;
  method: string;
  observedAt: string;
  evidenceReference: string;
  formulaVersion: string;
}>;

export type LedgerRecord = Readonly<{
  commandId: string;
  kind: 'cost' | 'value_evidence';
  agentRunId: string;
  runType: string;
  actorId: string;
  recordedAt: string;
  correctsCommandId: string | null;
  cost?: LedgerCost;
  valueEvidence?: ValueEvidence;
  usageProvenance?: Readonly<{
    source: 'agent_run_receipt';
    receiptSha256: string;
  }>;
}>;

export type LedgerRoi =
  | Readonly<{state: 'calculated'; ratio: number; formulaVersion: 'roi_v1'}>
  | Readonly<{
      state: 'not_configured';
      reason:
        | 'cost_not_calculated'
        | 'value_evidence_missing'
        | 'currency_mismatch'
        | 'formula_version_unsupported';
    }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const REFERENCE_PATTERN = /^[^\u0000-\u001f\u007f]{1,512}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

const validInstant = (value: unknown): value is string =>
  typeof value === 'string' &&
  Number.isFinite(new Date(value).getTime()) &&
  new Date(value).toISOString() === value;

const validCost = (value: unknown): value is LedgerCost => {
  if (!isRecord(value)) return false;
  if (value.state === 'calculated') {
    return typeof value.amountMinor === 'number' &&
      Number.isSafeInteger(value.amountMinor) &&
      value.amountMinor > 0 &&
      typeof value.currency === 'string' &&
      CURRENCY_PATTERN.test(value.currency) &&
      typeof value.pricingVersion === 'string' &&
      VERSION_PATTERN.test(value.pricingVersion) &&
      validInstant(value.pricingEffectiveAt) &&
      typeof value.allocationFormulaVersion === 'string' &&
      VERSION_PATTERN.test(value.allocationFormulaVersion);
  }
  return ['unknown', 'pending', 'error'].includes(String(value.state)) &&
    typeof value.reason === 'string' &&
    value.reason.length > 0 &&
    value.reason.length <= 256 &&
    !('amountMinor' in value);
};

const validValueEvidence = (value: unknown): value is ValueEvidence =>
  isRecord(value) &&
  typeof value.baselineAmountMinor === 'number' &&
  Number.isSafeInteger(value.baselineAmountMinor) &&
  value.baselineAmountMinor >= 0 &&
  typeof value.outcomeAmountMinor === 'number' &&
  Number.isSafeInteger(value.outcomeAmountMinor) &&
  value.outcomeAmountMinor >= 0 &&
  typeof value.currency === 'string' &&
  CURRENCY_PATTERN.test(value.currency) &&
  typeof value.method === 'string' &&
  VERSION_PATTERN.test(value.method) &&
  validInstant(value.observedAt) &&
  typeof value.evidenceReference === 'string' &&
  REFERENCE_PATTERN.test(value.evidenceReference) &&
  value.formulaVersion === 'roi_v1';

const hasAvailableUsage = (metadata: Record<string, unknown>): boolean => {
  const usage = metadata.usage;
  return isRecord(usage) &&
    usage.state === 'available' &&
    Object.keys(usage).length > 1;
};

const requestHash = (value: unknown): string =>
  createHash('sha256')
    .update(canonicalJson(value as CanonicalJson))
    .digest('hex');

const authorizedActor = (actorId: string, workspaceId: string) => and(
  eq(schema.actors.id, actorId),
  eq(schema.actors.workspaceId, workspaceId),
  eq(schema.actors.type, 'human'),
  eq(schema.actors.authMode, 'user'),
  inArray(schema.actors.role, ['workspace_admin', 'delivery_lead']),
  isNull(schema.actors.disabledAt)
);

export const parseLedgerRecord = (
  result: Record<string, unknown> | null
): LedgerRecord | null => {
  const value = isRecord(result?.value) ? result.value : null;
  if (
    value === null ||
    (value.kind !== 'cost' && value.kind !== 'value_evidence') ||
    typeof value.commandId !== 'string' ||
    typeof value.agentRunId !== 'string' ||
    typeof value.runType !== 'string' ||
    typeof value.actorId !== 'string' ||
    typeof value.recordedAt !== 'string' ||
    (value.correctsCommandId !== null &&
      typeof value.correctsCommandId !== 'string') ||
    !validInstant(value.recordedAt)
  ) return null;
  if (value.kind === 'cost') {
    if (!validCost(value.cost)) return null;
    if (
      value.cost.state === 'calculated' &&
      (!isRecord(value.usageProvenance) ||
        value.usageProvenance.source !== 'agent_run_receipt' ||
        typeof value.usageProvenance.receiptSha256 !== 'string' ||
        !/^[0-9a-f]{64}$/.test(value.usageProvenance.receiptSha256))
    ) return null;
  } else if (!validValueEvidence(value.valueEvidence)) {
    return null;
  }
  return value as LedgerRecord;
};

export const ledgerRoi = (
  cost: LedgerCost,
  valueEvidence: ValueEvidence | null
): LedgerRoi => {
  if (cost.state !== 'calculated') {
    return {state: 'not_configured', reason: 'cost_not_calculated'};
  }
  if (valueEvidence === null) {
    return {state: 'not_configured', reason: 'value_evidence_missing'};
  }
  if (valueEvidence.currency !== cost.currency) {
    return {state: 'not_configured', reason: 'currency_mismatch'};
  }
  if (valueEvidence.formulaVersion !== 'roi_v1') {
    return {state: 'not_configured', reason: 'formula_version_unsupported'};
  }
  return {
    state: 'calculated',
    ratio: (
      (valueEvidence.baselineAmountMinor - valueEvidence.outcomeAmountMinor) -
      cost.amountMinor
    ) / cost.amountMinor,
    formulaVersion: 'roi_v1'
  };
};

type AppendInput = Readonly<{
  workspaceId: string;
  actorId: string;
  agentRunId: string;
  idempotencyKey: string;
  commandId: string;
  correlationId: string;
  recordedAt: Date;
}> & (
  | Readonly<{
      kind: 'cost';
      cost: LedgerCost;
      correctsCommandId: string | null;
    }>
  | Readonly<{
      kind: 'value_evidence';
      valueEvidence: ValueEvidence;
    }>
);

export const createPostgresCostValueLedgerStore = (db: Database) => ({
  async append(input: AppendInput): Promise<
    Readonly<{status: 'completed' | 'replayed'; record: LedgerRecord}> |
    Readonly<{status: 'forbidden' | 'invalid'}>
  > {
    return db.transaction(async (tx) => {
      if (
        !Number.isFinite(input.recordedAt.getTime()) ||
        (input.kind === 'cost'
          ? !validCost(input.cost)
          : !validValueEvidence(input.valueEvidence))
      ) return {status: 'invalid'} as const;
      const [[actor], [run]] = await Promise.all([
        tx.select({id: schema.actors.id}).from(schema.actors)
          .where(authorizedActor(input.actorId, input.workspaceId)).limit(1),
        tx.select({
          id: schema.agentRuns.id,
          projectId: schema.taskPackets.projectId,
          workspaceId: schema.projects.workspaceId,
          runType: schema.taskPackets.runtimeProfile,
          receiptSha256: schema.agentRunReceipts.receiptSha256,
          receiptMetadata: schema.agentRunReceipts.metadata
        }).from(schema.agentRuns)
          .innerJoin(
            schema.taskPackets,
            eq(schema.taskPackets.id, schema.agentRuns.taskPacketId)
          )
          .innerJoin(
            schema.projects,
            eq(schema.projects.id, schema.taskPackets.projectId)
          )
          .leftJoin(
            schema.agentRunReceipts,
            eq(schema.agentRunReceipts.agentRunId, schema.agentRuns.id)
          )
          .where(and(
            eq(schema.agentRuns.id, input.agentRunId),
            eq(schema.projects.workspaceId, input.workspaceId)
          ))
          .limit(1)
      ]);
      if (actor === undefined) return {status: 'forbidden'} as const;
      if (run === undefined) return {status: 'invalid'} as const;
      await tx.execute(sql`
        select pg_advisory_xact_lock(hashtextextended(${run.id}, 0))
      `);

      const hash = requestHash({
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        agentRunId: run.id,
        runType: run.runType,
        kind: input.kind,
        ...(input.kind === 'cost'
          ? {cost: input.cost, correctsCommandId: input.correctsCommandId}
          : {valueEvidence: input.valueEvidence})
      });
      const [existingReplay] = await tx.select({
        requestHash: schema.commandReceipts.requestHash,
        result: schema.commandReceipts.result
      }).from(schema.commandReceipts).where(and(
        eq(schema.commandReceipts.workspaceId, input.workspaceId),
        eq(schema.commandReceipts.idempotencyKey, input.idempotencyKey)
      )).limit(1);
      if (existingReplay !== undefined) {
        const replay = parseLedgerRecord(existingReplay.result);
        return existingReplay.requestHash === hash && replay !== null
          ? {status: 'replayed', record: replay} as const
          : {status: 'invalid'} as const;
      }

      const previousRows = await tx.select({
        commandId: schema.commandReceipts.commandId,
        result: schema.commandReceipts.result
      }).from(schema.commandReceipts).where(and(
        eq(schema.commandReceipts.workspaceId, input.workspaceId),
        eq(schema.commandReceipts.aggregateId, input.agentRunId),
        eq(schema.commandReceipts.commandType, COST_LEDGER_COMMAND)
      )).orderBy(asc(schema.commandReceipts.completedAt), asc(schema.commandReceipts.id));
      const previousCosts = previousRows.flatMap(({commandId, result}) => {
        const record = parseLedgerRecord(result);
        return record?.kind === 'cost' ? [{commandId, record}] : [];
      });
      const latestCost = previousCosts.at(-1);

      if (input.kind === 'cost') {
        if (
          (latestCost === undefined && input.correctsCommandId !== null) ||
          (latestCost !== undefined &&
            input.correctsCommandId !== latestCost.commandId) ||
          (input.cost.state === 'calculated' &&
            (run.receiptSha256 === null ||
              run.receiptMetadata === null ||
              !hasAvailableUsage(run.receiptMetadata)))
        ) return {status: 'invalid'} as const;
      }

      const recordedAt = input.recordedAt.toISOString();
      const record: LedgerRecord = input.kind === 'cost'
        ? {
            commandId: input.commandId,
            kind: 'cost',
            agentRunId: run.id,
            runType: run.runType,
            actorId: input.actorId,
            recordedAt,
            correctsCommandId: input.correctsCommandId,
            cost: input.cost,
            ...(input.cost.state === 'calculated' && run.receiptSha256 !== null
              ? {
                  usageProvenance: {
                    source: 'agent_run_receipt' as const,
                    receiptSha256: run.receiptSha256
                  }
                }
              : {})
          }
        : {
            commandId: input.commandId,
            kind: 'value_evidence',
            agentRunId: run.id,
            runType: run.runType,
            actorId: input.actorId,
            recordedAt,
            correctsCommandId: null,
            valueEvidence: input.valueEvidence
          };
      const commandType = input.kind === 'cost'
        ? COST_LEDGER_COMMAND
        : VALUE_LEDGER_COMMAND;
      const result = {ok: true, value: record} as unknown as Record<string, unknown>;
      const [inserted] = await tx.insert(schema.commandReceipts).values({
        workspaceId: input.workspaceId,
        idempotencyKey: input.idempotencyKey,
        requestHash: hash,
        commandId: input.commandId,
        correlationId: input.correlationId,
        state: 'completed',
        commandType,
        aggregateType: 'agent_run',
        aggregateId: run.id,
        result,
        createdAt: input.recordedAt,
        completedAt: input.recordedAt
      }).onConflictDoNothing({
        target: [
          schema.commandReceipts.workspaceId,
          schema.commandReceipts.idempotencyKey
        ]
      }).returning({id: schema.commandReceipts.id});

      if (inserted === undefined) {
        const [existing] = await tx.select({
          requestHash: schema.commandReceipts.requestHash,
          result: schema.commandReceipts.result
        }).from(schema.commandReceipts).where(and(
          eq(schema.commandReceipts.workspaceId, input.workspaceId),
          eq(schema.commandReceipts.idempotencyKey, input.idempotencyKey)
        )).limit(1);
        const replay = existing === undefined
          ? null
          : parseLedgerRecord(existing.result);
        if (existing?.requestHash !== hash || replay === null) {
          return {status: 'invalid'} as const;
        }
        return {status: 'replayed', record: replay} as const;
      }

      await tx.insert(schema.auditEvents).values({
        id: randomUUID(),
        workspaceId: input.workspaceId,
        projectId: run.projectId,
        actorId: input.actorId,
        commandId: input.commandId,
        actionCategory: 'write',
        action: commandType,
        targetType: 'agent_run',
        targetId: run.id,
        outcome: 'succeeded',
        correlationId: input.correlationId,
        occurredAt: input.recordedAt,
        metadata: {}
      });
      return {status: 'completed', record} as const;
    });
  }
});
