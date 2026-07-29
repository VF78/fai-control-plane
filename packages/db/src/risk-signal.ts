import {and, eq, isNull, notInArray} from 'drizzle-orm';
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

export type RiskSignalSetMember = Readonly<
  Omit<RiskSignalReconciliation, 'projectId' | 'observedAt' | 'condition'> & {
    condition: RiskSignalCondition;
  }
>;

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

export const reconcileRiskSignalSet = async (
  tx: Transaction,
  input: Readonly<{
    projectId: string;
    ruleId: string;
    observedAt: Date;
    members: readonly RiskSignalSetMember[];
  }>
): Promise<void> => {
  const deduplicationKeys = new Set<string>();
  for (const member of input.members) {
    if (member.condition.ruleId !== input.ruleId) {
      throw new Error('Risk signal set member rule does not match the reconciled rule.');
    }
    if (deduplicationKeys.has(member.deduplicationKey)) {
      throw new Error('Risk signal set contains a duplicate deduplication key.');
    }
    deduplicationKeys.add(member.deduplicationKey);
    await reconcileRiskSignal(tx, {
      ...member,
      projectId: input.projectId,
      observedAt: input.observedAt
    });
  }

  const activeForRule = and(
    eq(schema.riskSignals.projectId, input.projectId),
    eq(schema.riskSignals.ruleId, input.ruleId),
    isNull(schema.riskSignals.resolvedAt)
  );
  await tx.update(schema.riskSignals).set({
    resolvedAt: input.observedAt,
    updatedAt: input.observedAt
  }).where(input.members.length === 0
    ? activeForRule
    : and(
        activeForRule,
        notInArray(
          schema.riskSignals.deduplicationKey,
          input.members.map((member) => member.deduplicationKey)
        )
      ));
};
