import {and, desc, eq, isNull} from 'drizzle-orm';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import * as schema from './schema';
import {projectMembershipHasAnyRoleSql} from './project-membership-roles';

type Database = NodePgDatabase<typeof schema>;
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export const RISK_SIGNAL_REENTRY_CONDITION =
  'risk_unresolved_at_expiry' as const;
export const riskSignalDispositionReasons = [
  'investigating',
  'awaiting_evidence',
  'planned_maintenance',
  'external_dependency'
] as const;
export type RiskSignalDispositionReason =
  (typeof riskSignalDispositionReasons)[number];

export type RiskSignalDisposition = Readonly<{
  riskSignalId: string;
  kind: 'acknowledged' | 'snoozed';
  reason: RiskSignalDispositionReason;
  expiresAt: Date;
  reentryCondition: typeof RISK_SIGNAL_REENTRY_CONDITION;
  version: number;
  actorId: string;
  occurredAt: Date;
}>;

export type RiskSignalDispositionCommand = Readonly<{
  workspaceId: string;
  projectId: string;
  riskSignalId: string;
  actorId: string;
  commandId: string;
  correlationId: string;
  kind: RiskSignalDisposition['kind'];
  reason: RiskSignalDispositionReason;
  expiresAt: Date;
  reentryCondition: typeof RISK_SIGNAL_REENTRY_CONDITION;
  expectedVersion: number;
  occurredAt: Date;
}>;

export type RiskSignalDispositionResult =
  | Readonly<{
      status: 'applied' | 'replayed';
      disposition: RiskSignalDisposition;
    }>
  | Readonly<{status: 'not_found' | 'forbidden' | 'conflict'}>;

const dispositionFrom = (
  row: typeof schema.riskSignalDispositionEvents.$inferSelect
): RiskSignalDisposition => ({
  riskSignalId: row.riskSignalId,
  kind: row.kind,
  reason: row.reason as RiskSignalDispositionReason,
  expiresAt: row.expiresAt,
  reentryCondition: row.reentryCondition as typeof RISK_SIGNAL_REENTRY_CONDITION,
  version: row.version,
  actorId: row.actorId,
  occurredAt: row.occurredAt
});

const canManageProjectRisk = async (
  tx: Transaction,
  workspaceId: string,
  projectId: string,
  actorId: string
): Promise<boolean> => {
  const [actor] = await tx.select({role: schema.actors.role})
    .from(schema.actors)
    .where(and(
      eq(schema.actors.id, actorId),
      eq(schema.actors.workspaceId, workspaceId),
      eq(schema.actors.type, 'human'),
      eq(schema.actors.authMode, 'user'),
      isNull(schema.actors.disabledAt)
    ))
    .limit(1);
  if (actor === undefined) return false;
  if (inArrayRole(actor.role, ['workspace_admin', 'delivery_lead'])) return true;
  const [membership] = await tx.select({roles: schema.projectMemberships.roles})
    .from(schema.projectMemberships)
    .innerJoin(
      schema.projects,
      eq(schema.projects.id, schema.projectMemberships.projectId)
    )
    .where(and(
      eq(schema.projectMemberships.projectId, projectId),
      eq(schema.projectMemberships.actorId, actorId),
      eq(schema.projectMemberships.active, true),
      eq(schema.projects.workspaceId, workspaceId),
      projectMembershipHasAnyRoleSql(schema.projectMemberships.roles, [
        'workspace_owner',
        'project_owner'
      ])
    ))
    .limit(1);
  return membership !== undefined;
};

const inArrayRole = <T extends string>(
  value: T,
  allowed: readonly T[]
): boolean => allowed.includes(value);

const sameCommand = (
  row: typeof schema.riskSignalDispositionEvents.$inferSelect,
  command: RiskSignalDispositionCommand
): boolean =>
  row.projectId === command.projectId &&
  row.riskSignalId === command.riskSignalId &&
  row.actorId === command.actorId &&
  row.kind === command.kind &&
  row.reason === command.reason &&
  row.expiresAt.getTime() === command.expiresAt.getTime() &&
  row.reentryCondition === command.reentryCondition &&
  row.version === command.expectedVersion + 1;

export const createPostgresRiskSignalDispositionStore = (db: Database) => ({
  async execute(
    command: RiskSignalDispositionCommand
  ): Promise<RiskSignalDispositionResult> {
    return db.transaction(async (tx) => {
      const [project] = await tx.select({id: schema.projects.id})
        .from(schema.projects)
        .where(and(
          eq(schema.projects.id, command.projectId),
          eq(schema.projects.workspaceId, command.workspaceId)
        ))
        .limit(1);
      if (project === undefined) return {status: 'not_found' as const};
      if (!await canManageProjectRisk(
        tx,
        command.workspaceId,
        command.projectId,
        command.actorId
      )) {
        return {status: 'forbidden' as const};
      }

      const [existing] = await tx
        .select()
        .from(schema.riskSignalDispositionEvents)
        .where(and(
          eq(
            schema.riskSignalDispositionEvents.workspaceId,
            command.workspaceId
          ),
          eq(schema.riskSignalDispositionEvents.commandId, command.commandId)
        ))
        .limit(1);
      if (existing !== undefined) {
        return sameCommand(existing, command)
          ? {status: 'replayed' as const, disposition: dispositionFrom(existing)}
          : {status: 'conflict' as const};
      }

      const [signal] = await tx.select({id: schema.riskSignals.id})
        .from(schema.riskSignals)
        .where(and(
          eq(schema.riskSignals.id, command.riskSignalId),
          eq(schema.riskSignals.projectId, command.projectId),
          isNull(schema.riskSignals.resolvedAt)
        ))
        .limit(1)
        .for('update');
      if (signal === undefined) return {status: 'not_found' as const};

      const [latest] = await tx.select({
        version: schema.riskSignalDispositionEvents.version
      })
        .from(schema.riskSignalDispositionEvents)
        .where(eq(
          schema.riskSignalDispositionEvents.riskSignalId,
          command.riskSignalId
        ))
        .orderBy(desc(schema.riskSignalDispositionEvents.version))
        .limit(1);
      const currentVersion = latest?.version ?? 0;
      if (currentVersion !== command.expectedVersion) {
        return {status: 'conflict' as const};
      }

      const [inserted] = await tx.insert(schema.riskSignalDispositionEvents)
        .values({
          workspaceId: command.workspaceId,
          projectId: command.projectId,
          riskSignalId: command.riskSignalId,
          actorId: command.actorId,
          commandId: command.commandId,
          correlationId: command.correlationId,
          kind: command.kind,
          reason: command.reason,
          expiresAt: command.expiresAt,
          reentryCondition: command.reentryCondition,
          version: currentVersion + 1,
          occurredAt: command.occurredAt
        })
        .returning();
      if (inserted === undefined) return {status: 'conflict' as const};

      await tx.insert(schema.auditEvents).values({
        workspaceId: command.workspaceId,
        projectId: command.projectId,
        actorId: command.actorId,
        commandId: command.commandId,
        actionCategory: 'write',
        action: `risk_signal.${command.kind}`,
        targetType: 'risk_signal',
        targetId: command.riskSignalId,
        outcome: 'succeeded',
        reasonCode: command.reason,
        expectedVersion: command.expectedVersion,
        resultVersion: currentVersion + 1,
        correlationId: command.correlationId,
        occurredAt: command.occurredAt
      });
      return {
        status: 'applied' as const,
        disposition: dispositionFrom(inserted)
      };
    });
  }
});
