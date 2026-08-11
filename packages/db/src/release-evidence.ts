import {createHash, randomUUID} from 'node:crypto';
import {and, eq, isNull} from 'drizzle-orm';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import type {
  DeploymentEvidenceResult,
  DeploymentEvidenceStore
} from '@fai-control-plane/application';
import {validateDeliveryProtocolDefinition, validateDeploymentObservation, validateDeploymentReference,
  type CommandError, type DeploymentEnvironment} from '@fai-control-plane/domain';
import * as schema from './schema';

type Database = NodePgDatabase<typeof schema>;
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type Command = Parameters<DeploymentEvidenceStore['execute']>[0]['command'];
const DEPLOYMENT_REQUEST_COMMAND = 'deployment.request.v1' as const;
const DEPLOYMENT_PRODUCTION_APPROVE_COMMAND = 'deployment.production_approve.v1' as const;
const fail = (code: CommandError['code'], message: string): DeploymentEvidenceResult =>
  ({ok: false, error: {code, message}});
const expectedVersion = (command: Command) => command.type === DEPLOYMENT_REQUEST_COMMAND
  ? command.payload.expectedProjectVersion : command.payload.expectedVersion;
const deploymentId = (command: Command) => command.payload.deploymentId;
const auditCommandId = (command: Command, requestHash: string, outcome: string) => `deployment-evidence:v1:${createHash('sha256')
  .update(`${command.commandId}:${requestHash}:${outcome}`).digest('hex')}`;
const attemptKey = (command: Command, requestHash: string) => `deployment-evidence-attempt:v1:${createHash('sha256')
  .update(`${command.actor.actorId}:${command.commandId}:${requestHash}`).digest('hex')}`;

const humanAuthority = async (tx: Transaction, workspaceId: string, projectId: string, actorId: string) => {
  const [actor] = await tx.select({role: schema.actors.role}).from(schema.actors).where(and(
    eq(schema.actors.id, actorId), eq(schema.actors.workspaceId, workspaceId),
    eq(schema.actors.type, 'human'), eq(schema.actors.authMode, 'user'), isNull(schema.actors.disabledAt)
  )).limit(1);
  if (actor === undefined) return false;
  if (actor.role === 'workspace_admin' || actor.role === 'delivery_lead') return true;
  const [membership] = await tx.select({roles: schema.projectMemberships.roles}).from(schema.projectMemberships)
    .where(and(eq(schema.projectMemberships.projectId, projectId),
      eq(schema.projectMemberships.actorId, actorId), eq(schema.projectMemberships.active, true))).limit(1);
  return membership?.roles.includes('workspace_owner') === true || membership?.roles.includes('project_owner') === true;
};
const systemAuthority = async (tx: Transaction, workspaceId: string, actorId: string) => {
  const [actor] = await tx.select({id: schema.actors.id}).from(schema.actors).where(and(
    eq(schema.actors.id, actorId), eq(schema.actors.workspaceId, workspaceId),
    eq(schema.actors.type, 'system'), eq(schema.actors.authMode, 'system'), isNull(schema.actors.disabledAt)
  )).limit(1);
  return actor !== undefined;
};
const releaseReadinessError = async (tx: Transaction, projectId: string, planVersionId: string,
  environment: DeploymentEnvironment, workItemId: string | null): Promise<CommandError | null> => {
  const items = await tx.select().from(schema.workItems).where(and(
    eq(schema.workItems.projectId, projectId), eq(schema.workItems.sourcePlanVersionId, planVersionId),
    isNull(schema.workItems.deletedAt), ...(workItemId === null ? [] : [eq(schema.workItems.id, workItemId)])
  )).for('update');
  if (items.length === 0 || workItemId !== null && items.length !== 1) {
    return {code: 'NOT_FOUND', message: 'Release target is not part of the materialized plan.'};
  }
  for (const item of items) {
    if (item.blocked) return {code: 'INVALID_TRANSITION', message: 'Blocked work items cannot enter a deployment request.'};
    if (environment === 'development') continue;
    const [journey] = await tx.select().from(schema.deliveryJourneys)
      .where(eq(schema.deliveryJourneys.workItemId, item.id)).limit(1).for('update');
    if (journey === undefined) return {code: 'INVALID_TRANSITION', message: 'Release target has no governed delivery journey.'};
    const [protocol] = await tx.select().from(schema.runbooks).where(and(eq(schema.runbooks.id, journey.protocolId),
      eq(schema.runbooks.version, journey.protocolVersion), eq(schema.runbooks.projectId, projectId))).limit(1);
    const definition = protocol === undefined ? null : validateDeliveryProtocolDefinition(protocol.definition);
    const stage = definition?.ok === true ? definition.value.stages.find((candidate) =>
      candidate.enabled && candidate.key === journey.stageKey) : undefined;
    if (stage === undefined || item.status !== stage.taskStatus || !['published', 'retired'].includes(protocol?.protocolState ?? '')) {
      return {code: 'INVALID_TRANSITION', message: 'Release target is not at a confirmed enabled protocol stage.'};
    }
    if (environment === 'staging') {
      if (stage.taskStatus !== 'acceptance' && stage.taskStatus !== 'done') return {
        code: 'INVALID_TRANSITION', message: 'Staging requires a post-QA acceptance-equivalent stage.'
      };
      continue;
    }
    if (item.status !== 'done' || stage.taskStatus !== 'done' || stage.allowedNextStageKey !== null) return {
      code: 'INVALID_TRANSITION', message: 'Production requires the terminal done stage.'
    };
    const evidence = await tx.select({requirement: schema.deliveryJourneyEvidence.requirement})
      .from(schema.deliveryJourneyEvidence).where(and(eq(schema.deliveryJourneyEvidence.workItemId, item.id),
        eq(schema.deliveryJourneyEvidence.stageKey, stage.key)));
    const recorded = new Set(evidence.map(({requirement}) => requirement));
    if (!stage.requiredEvidence.every((requirement) => recorded.has(requirement))) return {
      code: 'INVALID_TRANSITION', message: 'Production requires all terminal delivery evidence.'
    };
  }
  return null;
};

export const createPostgresDeploymentEvidenceStore = (
  db: Database,
  options: Readonly<{now?: () => Date}> = {}
): DeploymentEvidenceStore => ({
  async execute(input) {
    return db.transaction(async (tx) => {
      const {command} = input;
      const existing = await tx.select().from(schema.commandReceipts).where(and(
        eq(schema.commandReceipts.workspaceId, command.workspaceId),
        eq(schema.commandReceipts.idempotencyKey, command.idempotencyKey)
      )).limit(1).for('update');
      if (existing[0] !== undefined) {
        if (existing[0].requestHash !== input.requestHash) return {status: 'key_reused', existingRequestHash: existing[0].requestHash};
        if (existing[0].state !== 'completed' || existing[0].result === null) throw new Error('deployment_evidence_receipt_incomplete');
        return {status: 'replayed', receipt: {commandId: existing[0].commandId,
          workspaceId: command.workspaceId, correlationId: existing[0].correlationId,
          idempotencyKey: command.idempotencyKey, requestHash: existing[0].requestHash,
          commandType: command.type, result: existing[0].result as DeploymentEvidenceResult,
          createdAt: existing[0].createdAt.toISOString()}};
      }
      const [claimed] = await tx.insert(schema.commandReceipts).values({workspaceId: command.workspaceId,
        idempotencyKey: command.idempotencyKey, requestHash: input.requestHash, commandId: command.commandId,
        correlationId: command.correlationId, commandType: command.type}).onConflictDoNothing({
          target: [schema.commandReceipts.workspaceId, schema.commandReceipts.idempotencyKey]
        }).returning();
      if (claimed === undefined) {
        const [concurrent] = await tx.select().from(schema.commandReceipts).where(and(
          eq(schema.commandReceipts.workspaceId, command.workspaceId),
          eq(schema.commandReceipts.idempotencyKey, command.idempotencyKey)
        )).limit(1).for('update');
        if (concurrent === undefined || concurrent.requestHash !== input.requestHash) {
          return {status: 'key_reused', existingRequestHash: concurrent?.requestHash ?? ''};
        }
        if (concurrent.state !== 'completed' || concurrent.result === null) throw new Error('deployment_evidence_concurrent_receipt');
        return {status: 'replayed', receipt: {commandId: concurrent.commandId,
          workspaceId: command.workspaceId, correlationId: concurrent.correlationId,
          idempotencyKey: command.idempotencyKey, requestHash: concurrent.requestHash,
          commandType: command.type, result: concurrent.result as DeploymentEvidenceResult,
          createdAt: concurrent.createdAt.toISOString()}};
      }
      let projectId: string | undefined;
      let resultVersion: number | undefined;
      let result: DeploymentEvidenceResult = fail('INVALID_COMMAND', 'Deployment command was not evaluated.');
      const complete = async (policyDecision: 'allow' | 'deny' = input.authorized ? 'allow' : 'deny') => {
        const now = options.now?.() ?? new Date();
        let receipt = claimed;
        let receiptKey = command.idempotencyKey;
        if (!result.ok) {
          receiptKey = attemptKey(command, input.requestHash);
          const [previousAttempt] = await tx.select().from(schema.commandReceipts).where(and(
            eq(schema.commandReceipts.workspaceId, command.workspaceId),
            eq(schema.commandReceipts.idempotencyKey, receiptKey)
          )).limit(1).for('update');
          if (previousAttempt !== undefined) {
            await tx.delete(schema.commandReceipts).where(eq(schema.commandReceipts.id, claimed.id));
            receipt = previousAttempt;
            result = previousAttempt.result as DeploymentEvidenceResult;
          } else {
            const [moved] = await tx.update(schema.commandReceipts).set({idempotencyKey: receiptKey})
              .where(eq(schema.commandReceipts.id, claimed.id)).returning();
            if (moved === undefined) throw new Error('deployment_evidence_attempt_receipt_move');
            receipt = moved;
          }
        }
        if (receipt.state !== 'completed') await tx.update(schema.commandReceipts).set({state: 'completed', aggregateType: 'deployment',
          aggregateId: deploymentId(command), expectedVersion: expectedVersion(command), resultVersion,
          result, completedAt: now}).where(eq(schema.commandReceipts.id, receipt.id));
        await tx.insert(schema.auditEvents).values({id: randomUUID(), workspaceId: command.workspaceId,
          projectId, actorId: command.actor.actorId, commandId: auditCommandId(command, input.requestHash,
            result.ok ? `succeeded:${resultVersion ?? 'none'}` : `failed:${result.error.code}`),
          actionCategory: 'write', action: command.type, targetType: 'deployment', targetId: deploymentId(command),
          policyDecision, outcome: result.ok ? 'succeeded' : policyDecision === 'deny' ? 'rejected' : 'failed',
          ...(!result.ok ? {reasonCode: result.error.code} : {}), expectedVersion: expectedVersion(command),
          resultVersion, correlationId: command.correlationId, occurredAt: now, metadata: {}})
          .onConflictDoNothing({target: [schema.auditEvents.workspaceId, schema.auditEvents.commandId]});
        return {status: 'completed' as const, receipt: {commandId: command.commandId,
          workspaceId: command.workspaceId, correlationId: command.correlationId,
          idempotencyKey: receiptKey, requestHash: input.requestHash,
          commandType: command.type, result, createdAt: receipt.createdAt.toISOString()}};
      };
      if (!input.authorized) {
        result = fail(input.policyError?.code ?? 'POLICY_DENIED', input.policyError?.message ?? 'Policy denied deployment evidence command.');
        return complete('deny');
      }

      if (command.type === DEPLOYMENT_REQUEST_COMMAND) {
        const [project] = await tx.select({id: schema.projects.id, version: schema.projects.version})
          .from(schema.projects).where(and(eq(schema.projects.id, command.payload.projectId),
            eq(schema.projects.workspaceId, command.workspaceId))).limit(1).for('update');
        if (project === undefined) { result = fail('NOT_FOUND', 'Project was not found.'); return complete(); }
        projectId = project.id;
        if (!await humanAuthority(tx, command.workspaceId, project.id, command.actor.actorId)) {
          result = fail('CAPABILITY_DENIED', 'Only an active manager or Product Owner can request a deployment.');
          return complete('deny');
        }
        if (project.version !== command.payload.expectedProjectVersion) {
          resultVersion = project.version; result = fail('VERSION_CONFLICT', 'Project version conflicts.'); return complete();
        }
        const desired = validateDeploymentReference(command.payload.reference);
        if (!desired.ok) { result = desired; return complete(); }
        const [plan] = await tx.select({id: schema.projectPlanVersions.id})
          .from(schema.projectPlanVersions).where(and(eq(schema.projectPlanVersions.id, command.payload.planVersionId),
            eq(schema.projectPlanVersions.workspaceId, command.workspaceId),
            eq(schema.projectPlanVersions.projectId, project.id))).limit(1).for('update');
        const [materialization] = await tx.select({id: schema.projectPlanMaterializations.id})
          .from(schema.projectPlanMaterializations).where(and(
            eq(schema.projectPlanMaterializations.id, command.payload.materializationId),
            eq(schema.projectPlanMaterializations.workspaceId, command.workspaceId),
            eq(schema.projectPlanMaterializations.projectId, project.id),
            eq(schema.projectPlanMaterializations.planVersionId, command.payload.planVersionId)
          )).limit(1).for('update');
        if (plan === undefined || materialization === undefined) {
          result = fail('INVALID_COMMAND', 'Deployment requires the exact materialized approved plan.'); return complete();
        }
        const readiness = await releaseReadinessError(tx, project.id, command.payload.planVersionId,
          command.payload.environment, command.payload.workItemId);
        if (readiness !== null) { result = {ok: false, error: readiness}; return complete(); }
        const [collision] = await tx.select({id: schema.deployments.id}).from(schema.deployments)
          .where(eq(schema.deployments.id, command.payload.deploymentId)).limit(1).for('update');
        if (collision !== undefined) { result = fail('VERSION_CONFLICT', 'Deployment identity already exists.'); return complete(); }
        const now = options.now?.() ?? new Date();
        const production = command.payload.environment === 'production';
        await tx.insert(schema.deployments).values({id: command.payload.deploymentId,
          workspaceId: command.workspaceId, projectId: project.id, workItemId: command.payload.workItemId,
          environment: command.payload.environment, revision: desired.value.reference,
          referenceKind: desired.value.kind, status: production ? 'requested' : 'approved', externalRef: null,
          planVersionId: command.payload.planVersionId, materializationId: command.payload.materializationId,
          requestedByActorId: command.actor.actorId, requestedAt: now,
          approvedByActorId: production ? null : command.actor.actorId, approvedAt: production ? null : now,
          lifecycleVersion: 1, version: 1});
        resultVersion = 1;
        result = {ok: true, value: {deploymentId: command.payload.deploymentId, projectId: project.id,
          environment: command.payload.environment, state: production ? 'requested' : 'approved', version: 1,
          nextAction: production ? 'approve_production' : 'record_observation'}};
        return complete();
      }

      const [deployment] = await tx.select().from(schema.deployments).where(and(
        eq(schema.deployments.id, deploymentId(command)), eq(schema.deployments.workspaceId, command.workspaceId)
      )).limit(1).for('update');
      if (deployment === undefined || deployment.lifecycleVersion !== 1 ||
        !['development', 'staging', 'production'].includes(deployment.environment)) {
        result = fail('NOT_FOUND', 'Canonical deployment request was not found.'); return complete();
      }
      projectId = deployment.projectId;
      if (command.type === DEPLOYMENT_PRODUCTION_APPROVE_COMMAND) {
        if (!await humanAuthority(tx, command.workspaceId, deployment.projectId, command.actor.actorId)) {
          result = fail('CAPABILITY_DENIED', 'Only an active manager or Product Owner can approve production deployment.');
          return complete('deny');
        }
        if (deployment.version !== command.payload.expectedVersion) {
          resultVersion = deployment.version; result = fail('VERSION_CONFLICT', 'Deployment version conflicts.'); return complete();
        }
        if (deployment.environment !== 'production' || deployment.status !== 'requested') {
          result = fail('INVALID_TRANSITION', 'Only a pending production request can be approved.'); return complete();
        }
        const now = options.now?.() ?? new Date();
        const [updated] = await tx.update(schema.deployments).set({status: 'approved',
          approvedByActorId: command.actor.actorId, approvedAt: now, version: deployment.version + 1,
          updatedAt: now}).where(and(eq(schema.deployments.id, deployment.id),
            eq(schema.deployments.version, command.payload.expectedVersion), eq(schema.deployments.status, 'requested')))
          .returning({version: schema.deployments.version});
        if (updated === undefined) throw new Error('deployment_production_approval_cas');
        resultVersion = updated.version;
        result = {ok: true, value: {deploymentId: deployment.id, projectId: deployment.projectId,
          environment: 'production', state: 'approved', version: updated.version, nextAction: 'record_observation'}};
        return complete();
      }

      if (!await systemAuthority(tx, command.workspaceId, command.actor.actorId)) {
        result = fail('CAPABILITY_DENIED', 'Deployment observations require an active trusted system identity.');
        return complete('deny');
      }
      if (deployment.version !== command.payload.expectedVersion) {
        resultVersion = deployment.version; result = fail('VERSION_CONFLICT', 'Deployment version conflicts.'); return complete();
      }
      if (deployment.status !== 'approved' || deployment.approvedByActorId === null || deployment.approvedAt === null) {
        result = fail('APPROVAL_REQUIRED', 'Deployment result cannot be observed before human approval.'); return complete();
      }
      const observed = validateDeploymentObservation(command.payload.observation);
      if (!observed.ok) { result = observed; return complete(); }
      const now = options.now?.() ?? new Date();
      const [updated] = await tx.update(schema.deployments).set({status: 'observed',
        observedByActorId: command.actor.actorId, observedAt: now,
        observedResult: {outcome: observed.value.outcome, reference: observed.value.reference},
        smokeChecks: observed.value.smokeChecks, rollbackEvidence: observed.value.rollback,
        startedAt: new Date(observed.value.startedAt), completedAt: new Date(observed.value.completedAt),
        version: deployment.version + 1, updatedAt: now}).where(and(eq(schema.deployments.id, deployment.id),
          eq(schema.deployments.version, command.payload.expectedVersion), eq(schema.deployments.status, 'approved')))
        .returning({version: schema.deployments.version});
      if (updated === undefined) throw new Error('deployment_observation_cas');
      resultVersion = updated.version;
      result = {ok: true, value: {deploymentId: deployment.id, projectId: deployment.projectId,
        environment: deployment.environment as 'development' | 'staging' | 'production', state: 'observed',
        version: updated.version, nextAction: 'review_observation'}};
      return complete();
    });
  }
});
