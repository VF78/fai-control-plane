import {createHash, randomUUID} from 'node:crypto';
import {and, asc, eq, lte, or} from 'drizzle-orm';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import {type AgentDeliveryPort, type AgentRoleRequest, type TrackerNextActionDecision, type TrackerRepositorySnapshot, validateAgentRoleRequest} from '@fai-control-plane/domain';
import * as schema from './schema';

type Database = NodePgDatabase<typeof schema>;
const destination = 'ai_agent'; const eventType = 'agent.role_request.v1'; const maxAttempts = 3;
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value !== null && typeof value === 'object' ? `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}` : JSON.stringify(value);
const hash = (value: unknown) => `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
const commandId = (key: string) => `agent-request:${hash(key).slice(7)}`;
/** Bounded delivery bookkeeping only: no external agent lifecycle is persisted. */
export const createPostgresAgentRoleRequestOutbox = (db: Database, publisher: AgentDeliveryPort) => ({
  async prepare(input: Readonly<{workspaceId: string; projectId: string; actorId: string; request: AgentRoleRequest}>): Promise<'prepared' | 'replayed' | 'conflict'> {
    const request = validateAgentRoleRequest(input.request); if (request === null) return 'conflict';
    const requestHash = hash(request);
    return db.transaction(async (tx) => {
      const [[workspace], [project], [actor]] = await Promise.all([
        tx.select({id: schema.workspaces.id}).from(schema.workspaces).where(eq(schema.workspaces.id, input.workspaceId)),
        tx.select({id: schema.projects.id}).from(schema.projects).where(and(eq(schema.projects.id, input.projectId), eq(schema.projects.workspaceId, input.workspaceId))),
        tx.select({id: schema.actors.id}).from(schema.actors).where(and(eq(schema.actors.id, input.actorId), eq(schema.actors.workspaceId, input.workspaceId)))
      ]); if (workspace === undefined || project === undefined || actor === undefined) return 'conflict';
      const [receipt] = await tx.insert(schema.commandReceipts).values({workspaceId: input.workspaceId,
        idempotencyKey: request.idempotencyKey, requestHash, commandId: commandId(request.idempotencyKey),
        correlationId: request.correlationId, commandType: eventType}).onConflictDoNothing().returning({id: schema.commandReceipts.id});
      if (receipt === undefined) {
        const [existing] = await tx.select({requestHash: schema.commandReceipts.requestHash}).from(schema.commandReceipts)
          .where(and(eq(schema.commandReceipts.workspaceId, input.workspaceId), eq(schema.commandReceipts.idempotencyKey, request.idempotencyKey)));
        return existing?.requestHash === requestHash ? 'replayed' : 'conflict';
      }
      await tx.insert(schema.outboxEvents).values({workspaceId: input.workspaceId, projectId: input.projectId, destination, eventType,
        idempotencyKey: request.idempotencyKey, payload: {request} as Record<string, unknown>});
      await tx.insert(schema.auditEvents).values({id: randomUUID(), workspaceId: input.workspaceId, projectId: input.projectId, actorId: input.actorId,
        commandId: commandId(request.idempotencyKey), actionCategory: 'external_message', action: 'agent.role_request.prepared',
        targetType: 'github_project_item', targetId: request.projectItem.id, outcome: 'succeeded', correlationId: request.correlationId, occurredAt: new Date()});
      return 'prepared';
    });
  },
  async prepareSnapshotDecisions(input: Readonly<{workspaceId: string; projectId: string; actorId: string; snapshot: TrackerRepositorySnapshot; decisions: readonly TrackerNextActionDecision[]}>): Promise<void> {
    const sources = await db.select({id: schema.projectSourceArtifacts.id, kind: schema.projectSourceArtifacts.sourceKind, sha256: schema.projectSourceArtifacts.sha256, provenance: schema.projectSourceArtifacts.provenance})
      .from(schema.projectSourceArtifacts).where(and(eq(schema.projectSourceArtifacts.workspaceId, input.workspaceId), eq(schema.projectSourceArtifacts.projectId, input.projectId))).orderBy(asc(schema.projectSourceArtifacts.createdAt));
    for (const decision of input.decisions) {
      if (decision.action !== 'agent_role_request' || decision.agentRole === null) continue;
      const item = input.snapshot.projectItems.find((candidate) => candidate.externalId === decision.projectItemExternalId && candidate.issueExternalId === decision.issueExternalId && candidate.externalVersion === decision.observedItemVersion);
      if (item === undefined) continue;
      // Manager never starts without the three approved source dossiers.
      if (decision.agentRole === 'manager' && !['project_passport', 'solution_architecture', 'client_requirements'].every((kind) => sources.some((source) => source.kind === kind))) continue;
      await this.prepare({workspaceId: input.workspaceId, projectId: input.projectId, actorId: input.actorId, request: {role: decision.agentRole,
        repository: {id: input.snapshot.repository.externalId, url: `https://github.com/${input.snapshot.repository.owner}/${input.snapshot.repository.name}`},
        projectItem: {id: item.externalId, projectId: item.projectExternalId, issueId: item.issueExternalId, url: item.htmlUrl}, observedVersion: item.externalVersion,
        sourceReferences: sources.map((source) => ({id: source.id, sha256: source.sha256, kind: source.kind, provenance: source.provenance.label})),
        constraints: ['Use only the same GitHub Project item and repository.', 'Do not auto-merge, deploy, or claim completion to Control Plane.'],
        acceptanceCriteria: ['Update evidence on the same GitHub item, PR, check, or release.'], approval: null,
        correlationId: hash(decision.idempotencyKey).slice(7, 71), idempotencyKey: decision.idempotencyKey}});
    }
  },
  async publishAvailable(): Promise<'published' | 'failed' | 'idle'> {
    const candidate = await db.transaction(async (tx) => {
      const now = new Date();
      const [row] = await tx.select().from(schema.outboxEvents).where(and(eq(schema.outboxEvents.destination, destination), eq(schema.outboxEvents.eventType, eventType),
        or(eq(schema.outboxEvents.status, 'pending'), eq(schema.outboxEvents.status, 'publishing')), lte(schema.outboxEvents.availableAt, now)))
        .orderBy(asc(schema.outboxEvents.availableAt), asc(schema.outboxEvents.createdAt)).limit(1).for('update', {skipLocked: true});
      if (row === undefined) return undefined;
      const request = validateAgentRoleRequest((row.payload as {request?: unknown}).request);
      if (request === null) {
        const now = new Date();
        await tx.update(schema.outboxEvents).set({status: 'failed', failureCode: 'agent_request_invalid', updatedAt: now}).where(eq(schema.outboxEvents.id, row.id));
        await tx.update(schema.commandReceipts).set({state: 'completed', aggregateType: 'agent_delivery', result: {errorCode: 'agent_request_invalid'}, completedAt: now})
          .where(and(eq(schema.commandReceipts.workspaceId, row.workspaceId), eq(schema.commandReceipts.idempotencyKey, row.idempotencyKey), eq(schema.commandReceipts.state, 'claimed')));
        await tx.insert(schema.auditEvents).values({id: randomUUID(), workspaceId: row.workspaceId, projectId: row.projectId, actorId: null,
          commandId: `${commandId(row.idempotencyKey)}:failed`, actionCategory: 'external_message', action: 'agent.role_request.failed',
          targetType: 'outbox_event', targetId: row.id, outcome: 'failed', correlationId: row.id, occurredAt: now});
        return {invalid: true as const};
      }
      if (row.status === 'publishing' && row.attemptCount >= maxAttempts) {
        await tx.update(schema.outboxEvents).set({status: 'failed', failureCode: 'agent_retry_exhausted', updatedAt: now}).where(eq(schema.outboxEvents.id, row.id));
        await tx.update(schema.commandReceipts).set({state: 'completed', aggregateType: 'agent_delivery', result: {errorCode: 'agent_retry_exhausted'}, completedAt: now})
          .where(and(eq(schema.commandReceipts.workspaceId, row.workspaceId), eq(schema.commandReceipts.idempotencyKey, row.idempotencyKey), eq(schema.commandReceipts.state, 'claimed')));
        await tx.insert(schema.auditEvents).values({id: randomUUID(), workspaceId: row.workspaceId, projectId: row.projectId, actorId: null,
          commandId: `${commandId(row.idempotencyKey)}:failed`, actionCategory: 'external_message', action: 'agent.role_request.failed',
          targetType: 'github_project_item', targetId: request.projectItem.id, outcome: 'failed', correlationId: request.correlationId, occurredAt: now});
        return {invalid: true as const};
      }
      const [claimed] = await tx.update(schema.outboxEvents).set({status: 'publishing', attemptCount: row.attemptCount + 1,
        availableAt: new Date(now.getTime() + 30_000), updatedAt: now}).where(eq(schema.outboxEvents.id, row.id)).returning({id: schema.outboxEvents.id});
      if (claimed === undefined) return undefined;
      return {id: row.id, workspaceId: row.workspaceId, projectId: row.projectId, request, attempt: row.attemptCount + 1};
    });
    if (candidate === undefined) return 'idle';
    if ('invalid' in candidate) return 'failed';
    try {
      const ack = await publisher.submit(candidate.request); const now = new Date();
      await db.transaction(async (tx) => { await tx.update(schema.outboxEvents).set({status: 'published', publishedAt: now, updatedAt: now}).where(and(eq(schema.outboxEvents.id, candidate.id), eq(schema.outboxEvents.status, 'publishing')));
        await tx.update(schema.commandReceipts).set({state: 'completed', aggregateType: 'agent_delivery', result: {deliveryReference: ack.deliveryReference, sessionReference: ack.sessionReference}, completedAt: now}).where(and(eq(schema.commandReceipts.workspaceId, candidate.workspaceId), eq(schema.commandReceipts.idempotencyKey, candidate.request.idempotencyKey)));
        await tx.insert(schema.auditEvents).values({id: randomUUID(), workspaceId: candidate.workspaceId, projectId: candidate.projectId, actorId: null, commandId: `${commandId(candidate.request.idempotencyKey)}:ack`, actionCategory: 'external_message', action: 'agent.role_request.accepted', targetType: 'github_project_item', targetId: candidate.request.projectItem.id, outcome: 'succeeded', correlationId: candidate.request.correlationId, occurredAt: now}); });
      return 'published';
    } catch (error) {
      const adapterCode = error !== null && typeof error === 'object' && 'code' in error &&
        (error.code === 'identity_denied' || error.code === 'invalid_ack' || error.code === 'retryable') ? error.code : 'retryable';
      const terminal = adapterCode !== 'retryable' || candidate.attempt >= maxAttempts;
      const failureCode = adapterCode === 'identity_denied' ? 'agent_identity_denied' : adapterCode === 'invalid_ack' ? 'agent_invalid_ack' : 'agent_retry_exhausted';
      const now = new Date();
      await db.transaction(async (tx) => {
        await tx.update(schema.outboxEvents).set({status: terminal ? 'failed' : 'pending', failureCode: terminal ? failureCode : null,
          availableAt: new Date(now.getTime() + candidate.attempt * 1000), updatedAt: now}).where(and(eq(schema.outboxEvents.id, candidate.id), eq(schema.outboxEvents.status, 'publishing')));
        if (terminal) {
          await tx.update(schema.commandReceipts).set({state: 'completed', aggregateType: 'agent_delivery', result: {errorCode: failureCode}, completedAt: now})
            .where(and(eq(schema.commandReceipts.workspaceId, candidate.workspaceId), eq(schema.commandReceipts.idempotencyKey, candidate.request.idempotencyKey), eq(schema.commandReceipts.state, 'claimed')));
          await tx.insert(schema.auditEvents).values({id: randomUUID(), workspaceId: candidate.workspaceId, projectId: candidate.projectId, actorId: null,
            commandId: `${commandId(candidate.request.idempotencyKey)}:failed`, actionCategory: 'external_message', action: 'agent.role_request.failed',
            targetType: 'github_project_item', targetId: candidate.request.projectItem.id, outcome: 'failed', correlationId: candidate.request.correlationId, occurredAt: now});
        }
      });
      return 'failed';
    }
  }
});
