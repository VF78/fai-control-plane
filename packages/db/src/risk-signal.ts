import {and, eq, isNull} from 'drizzle-orm';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import * as schema from './schema';

type Database = NodePgDatabase<typeof schema>;
type Transaction = Parameters<Database['transaction']>[0] extends (
  tx: infer Value
) => unknown ? Value : never;

export type RiskSignalEvidenceReference = Readonly<{
  type: string;
  id: string;
}>;

export type RiskSignalCondition = Readonly<{
  code: string;
  ruleId: string;
  ruleVersion: string;
  signalClass: 'fact' | 'inference';
  severity: 'green' | 'yellow' | 'red';
  summary: string;
  details: Record<string, unknown>;
  evidenceReferences: readonly RiskSignalEvidenceReference[];
  impact: string;
  ownerActorId?: string | null;
  nextAction: string;
}>;

export type RiskSignalReconciliation = Readonly<{
  projectId: string;
  workItemId?: string | null;
  agentRunId?: string | null;
  deduplicationKey: string;
  observedAt: Date;
  condition: RiskSignalCondition | null;
}>;

export const reconcileRiskSignal = async (
  tx: Transaction,
  reconciliation: RiskSignalReconciliation
): Promise<void> => {
  const {
    projectId,
    workItemId = null,
    agentRunId = null,
    deduplicationKey,
    observedAt,
    condition
  } = reconciliation;

  if (condition === null) {
    await tx.update(schema.riskSignals).set({
      resolvedAt: observedAt,
      updatedAt: observedAt
    }).where(and(
      eq(schema.riskSignals.projectId, projectId),
      eq(schema.riskSignals.deduplicationKey, deduplicationKey),
      isNull(schema.riskSignals.resolvedAt)
    ));
    return;
  }

  await tx.insert(schema.riskSignals).values({
    projectId,
    workItemId,
    agentRunId,
    code: condition.code,
    ruleId: condition.ruleId,
    ruleVersion: condition.ruleVersion,
    signalClass: condition.signalClass,
    severity: condition.severity,
    summary: condition.summary,
    details: condition.details,
    evidenceReferences: condition.evidenceReferences,
    impact: condition.impact,
    ownerActorId: condition.ownerActorId ?? null,
    nextAction: condition.nextAction,
    observedAt,
    deduplicationKey,
    createdAt: observedAt,
    updatedAt: observedAt
  }).onConflictDoUpdate({
    target: [
      schema.riskSignals.projectId,
      schema.riskSignals.deduplicationKey
    ],
    targetWhere: isNull(schema.riskSignals.resolvedAt),
    set: {
      workItemId,
      agentRunId,
      code: condition.code,
      ruleId: condition.ruleId,
      ruleVersion: condition.ruleVersion,
      signalClass: condition.signalClass,
      severity: condition.severity,
      summary: condition.summary,
      details: condition.details,
      evidenceReferences: condition.evidenceReferences,
      impact: condition.impact,
      ownerActorId: condition.ownerActorId ?? null,
      nextAction: condition.nextAction,
      observedAt,
      updatedAt: observedAt
    }
  });
};
