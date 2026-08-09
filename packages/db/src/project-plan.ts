import {randomUUID} from 'node:crypto';
import {
  hashProjectPlanDefinition,
  simulateDeliveryProtocol,
  simulateProjectPlan,
  validateDeliveryProtocolDefinition,
  validateProjectPlanDefinition,
  validateSourceArtifact,
  type CommandError,
  type PlanEvidence,
  type ProjectPlan,
  type ProjectPlanDefinition,
  type ProjectPlanSimulation,
  type SourceArtifact
} from '@fai-control-plane/domain';
import type {ProjectPlanMutationCommand, ProjectPlanWorkspace} from '@fai-control-plane/application';
import {and, count, desc, eq, inArray, isNull, max} from 'drizzle-orm';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import * as schema from './schema';

type Database = NodePgDatabase<typeof schema>;
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type StoreInput = Readonly<{command: ProjectPlanMutationCommand; requestHash: string; authorized: boolean; policyError?: CommandError}>;
const fail = (code: CommandError['code'], message: string) => ({ok: false as const, error: {code, message}});

const authority = async (tx: Transaction, workspaceId: string, projectId: string, actorId: string) => {
  const [actor] = await tx.select({role: schema.actors.role}).from(schema.actors).where(and(
    eq(schema.actors.id, actorId), eq(schema.actors.workspaceId, workspaceId), eq(schema.actors.type, 'human'),
    eq(schema.actors.authMode, 'user'), isNull(schema.actors.disabledAt)
  )).limit(1);
  if (actor === undefined) return null;
  const [project] = await tx.select({id: schema.projects.id}).from(schema.projects).where(and(
    eq(schema.projects.id, projectId), eq(schema.projects.workspaceId, workspaceId)
  )).limit(1);
  if (project === undefined) return null;
  const [membership] = await tx.select({role: schema.projectMemberships.role, active: schema.projectMemberships.active}).from(schema.projectMemberships).where(and(
    eq(schema.projectMemberships.projectId, projectId), eq(schema.projectMemberships.actorId, actorId)
  )).limit(1);
  const administrativeEditor = actor.role === 'workspace_admin' || actor.role === 'delivery_lead';
  const activeMembership = membership?.active === true;
  const productOwner = activeMembership && membership.role === 'project_owner';
  const ownerEditor = productOwner || activeMembership && membership.role === 'workspace_owner';
  return {canRead: administrativeEditor || activeMembership, canEdit: administrativeEditor || ownerEditor, canApprove: productOwner};
};

const protocolSimulation = async (tx: Transaction, workspaceId: string, projectId: string) => {
  const [row] = await tx.select({id: schema.runbooks.id, definition: schema.runbooks.definition}).from(schema.runbooks).where(and(
    eq(schema.runbooks.projectId, projectId), eq(schema.runbooks.active, true), eq(schema.runbooks.protocolState, 'published')
  )).limit(1);
  if (row === undefined) return null;
  const definition = validateDeliveryProtocolDefinition(row.definition);
  if (!definition.ok) return {protocolId: row.id, simulationHash: '', valid: false};
  const memberships = await tx.select({actorId: schema.projectMemberships.actorId, role: schema.projectMemberships.role, active: schema.projectMemberships.active})
    .from(schema.projectMemberships).where(eq(schema.projectMemberships.projectId, projectId));
  const actorIds = [...new Set(memberships.map(({actorId}) => actorId))];
  const actors = actorIds.length === 0 ? [] : await tx.select({actorId: schema.actors.id, actorType: schema.actors.type, disabledAt: schema.actors.disabledAt})
    .from(schema.actors).where(and(eq(schema.actors.workspaceId, workspaceId), inArray(schema.actors.id, actorIds)));
  const agentIds = actors.filter(({actorType}) => actorType === 'agent').map(({actorId}) => actorId);
  const profiles = agentIds.length === 0 ? [] : await tx.select({profileId: schema.agentProfiles.id, actorId: schema.agentProfiles.actorId, enabled: schema.agentProfiles.enabled})
    .from(schema.agentProfiles).where(and(eq(schema.agentProfiles.workspaceId, workspaceId), inArray(schema.agentProfiles.actorId, agentIds)));
  const registrations = agentIds.length === 0 ? [] : await tx.select({actorId: schema.runtimeRegistrations.actorId, profileId: schema.runtimeRegistrations.agentProfileId, enabled: schema.runtimeRegistrations.enabled})
    .from(schema.runtimeRegistrations).where(and(eq(schema.runtimeRegistrations.projectId, projectId), inArray(schema.runtimeRegistrations.actorId, agentIds)));
  const simulated = simulateDeliveryProtocol(definition.value, {
    projectExists: true,
    memberships,
    actors: actors.flatMap((actor) => actor.actorType === 'human' || actor.actorType === 'agent' ? [{actorId: actor.actorId, actorType: actor.actorType, active: actor.disabledAt === null}] : []),
    agentProfiles: profiles,
    agentRegistrations: registrations
  });
  return {protocolId: row.id, simulationHash: simulated.simulationHash, valid: simulated.valid};
};

const evidenceIn = (definition: ProjectPlanDefinition): readonly PlanEvidence[] => [
  ...definition.outcomes.map(({evidence}) => evidence),
  ...definition.milestones.map(({evidence}) => evidence),
  ...definition.risks.map(({evidence}) => evidence),
  ...definition.tasks.flatMap(({acceptanceEvidence}) => acceptanceEvidence.map(({evidence}) => evidence))
];
const pointerExists = (content: string, pointer: string) => {
  try {
    let current: unknown = JSON.parse(content);
    for (const token of pointer.slice(1).split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))) {
      if (typeof current !== 'object' || current === null || !Object.hasOwn(current, token)) return false;
      current = (current as Record<string, unknown>)[token];
    }
    return true;
  } catch { return false; }
};
const citationsValid = async (tx: Transaction, workspaceId: string, projectId: string, definition: ProjectPlanDefinition) => {
  const citations = evidenceIn(definition).flatMap((item) => item.kind === 'citation' ? [item] : []);
  const ids = [...new Set(citations.map(({artifactId}) => artifactId))];
  if (ids.length === 0) return true;
  const rows = await tx.select({id: schema.projectSourceArtifacts.id, mediaType: schema.projectSourceArtifacts.mediaType, content: schema.projectSourceArtifacts.content})
    .from(schema.projectSourceArtifacts).where(and(
      eq(schema.projectSourceArtifacts.workspaceId, workspaceId), eq(schema.projectSourceArtifacts.projectId, projectId),
      inArray(schema.projectSourceArtifacts.id, ids)
    ));
  const byId = new Map(rows.map((row) => [row.id, row]));
  return citations.every((citation) => {
    const artifact = byId.get(citation.artifactId); if (artifact === undefined) return false;
    if (citation.locator.kind === 'whole_artifact') return true;
    if (citation.locator.kind === 'line_range') return citation.locator.endLine <= artifact.content.split(/\r?\n/).length;
    return artifact.mediaType === 'application/json' && pointerExists(artifact.content, citation.locator.pointer);
  });
};

const simulateIn = async (tx: Transaction, input: {workspaceId: string; projectId: string; actorId: string; definition: ProjectPlanDefinition}) => {
  const rights = await authority(tx, input.workspaceId, input.projectId, input.actorId);
  if (rights === null || !rights.canRead) return null;
  return simulateProjectPlan({
    definition: input.definition,
    citationsValid: await citationsValid(tx, input.workspaceId, input.projectId, input.definition),
    canEdit: rights.canEdit,
    canApprove: rights.canApprove,
    protocol: await protocolSimulation(tx, input.workspaceId, input.projectId)
  });
};

const draftFrom = (row: typeof schema.projectPlanDrafts.$inferSelect): ProjectPlan | null => {
  const definition = validateProjectPlanDefinition(row.definition); if (!definition.ok) return null;
  return {id: row.id, projectId: row.projectId, revision: row.revision, state: row.state as 'draft' | 'approved', definition: definition.value,
    contentHash: row.contentHash, approvedVersion: null, approvedByActorId: row.approvedByActorId, approvedAt: row.approvedAt?.toISOString() ?? null};
};
const approvedFrom = (row: typeof schema.projectPlanVersions.$inferSelect): ProjectPlan | null => {
  const definition = validateProjectPlanDefinition(row.definition); if (!definition.ok) return null;
  return {id: row.planId, projectId: row.projectId, revision: row.sourceRevision, state: 'approved', definition: definition.value,
    contentHash: row.contentHash, approvedVersion: row.version, approvedByActorId: row.approvedByActorId, approvedAt: row.approvedAt.toISOString()};
};

export const createPostgresProjectPlanStore = (db: Database) => ({
  async execute(input: StoreInput) {
    return db.transaction(async (tx) => {
      const command = input.command;
      const [claimed] = await tx.insert(schema.commandReceipts).values({workspaceId: command.workspaceId, idempotencyKey: command.idempotencyKey,
        requestHash: input.requestHash, commandId: command.commandId, correlationId: command.correlationId, commandType: command.type})
        .onConflictDoNothing({target: [schema.commandReceipts.workspaceId, schema.commandReceipts.idempotencyKey]})
        .returning({id: schema.commandReceipts.id});
      if (claimed === undefined) {
        const [existing] = await tx.select({requestHash: schema.commandReceipts.requestHash, state: schema.commandReceipts.state,
          commandId: schema.commandReceipts.commandId, commandType: schema.commandReceipts.commandType, result: schema.commandReceipts.result})
          .from(schema.commandReceipts).where(and(eq(schema.commandReceipts.workspaceId, command.workspaceId), eq(schema.commandReceipts.idempotencyKey, command.idempotencyKey))).for('update');
        if (existing === undefined || existing.requestHash !== input.requestHash) return {status: 'key_reused' as const, existingRequestHash: existing?.requestHash ?? ''};
        if (existing.state !== 'completed' || existing.result === null) throw new Error('project_plan_receipt_incomplete');
        return {status: 'replayed' as const, receipt: {commandId: existing.commandId, commandType: command.type, result: existing.result as never}};
      }
      let projectId: string | null = command.type === 'project_plan.approve' ? null : command.payload.projectId;
      let expectedVersion: number | undefined;
      let resultVersion: number | undefined;
      let result: {ok: true; value: {artifact?: SourceArtifact; plan?: ProjectPlan; simulation?: ProjectPlanSimulation}} | ReturnType<typeof fail>;
      const complete = async () => {
        const now = new Date();
        await tx.insert(schema.auditEvents).values({id: randomUUID(), workspaceId: command.workspaceId, projectId, actorId: command.actor.actorId,
          commandId: command.commandId, actionCategory: 'write', action: command.type, targetType: command.type === 'project_plan.source.record' ? 'project_source_artifact' : 'project_plan',
          targetId: command.type === 'project_plan.source.record' ? command.payload.artifactId : command.payload.planId,
          policyDecision: input.authorized ? 'allow' : input.policyError?.code === 'POLICY_DENIED' ? 'deny' : undefined,
          outcome: result.ok ? 'succeeded' : input.authorized ? 'failed' : 'rejected', reasonCode: result.ok ? undefined : result.error.code,
          expectedVersion, resultVersion, correlationId: command.correlationId, occurredAt: now});
        await tx.update(schema.commandReceipts).set({state: 'completed', aggregateType: command.type === 'project_plan.source.record' ? 'project_source_artifact' : 'project_plan',
          aggregateId: command.type === 'project_plan.source.record' ? command.payload.artifactId : command.payload.planId,
          expectedVersion, resultVersion, result, completedAt: now}).where(eq(schema.commandReceipts.id, claimed.id));
        return {status: 'completed' as const, receipt: {commandId: command.commandId, commandType: command.type, result}};
      };
      if (!input.authorized) { result = fail(input.policyError?.code ?? 'POLICY_DENIED', input.policyError?.message ?? 'Policy denied.'); return complete(); }

      if (command.type === 'project_plan.source.record') {
        const rights = await authority(tx, command.workspaceId, command.payload.projectId, command.actor.actorId);
        if (rights === null || !rights.canEdit) { result = fail(rights === null ? 'NOT_FOUND' : 'CAPABILITY_DENIED', 'Only the project Product Owner can add plan sources.'); return complete(); }
        const artifact = validateSourceArtifact({
          id: command.payload.artifactId,
          projectId: command.payload.projectId,
          name: command.payload.name,
          mediaType: command.payload.mediaType,
          content: command.payload.content,
          sizeBytes: command.payload.sizeBytes,
          sha256: command.payload.sha256,
          provenance: command.payload.provenance,
          version: 1
        });
        if (!artifact.ok) { result = artifact; return complete(); }
        const [artifactCount] = await tx.select({value: count()}).from(schema.projectSourceArtifacts).where(and(
          eq(schema.projectSourceArtifacts.workspaceId, command.workspaceId), eq(schema.projectSourceArtifacts.projectId, command.payload.projectId)
        ));
        if ((artifactCount?.value ?? 0) >= 100) { result = fail('INVALID_COMMAND', 'A project can contain at most 100 plan source artifacts.'); return complete(); }
        const inserted = await tx.insert(schema.projectSourceArtifacts).values({...artifact.value, workspaceId: command.workspaceId, provenance: artifact.value.provenance, createdByActorId: command.actor.actorId})
          .onConflictDoNothing({target: schema.projectSourceArtifacts.id}).returning({id: schema.projectSourceArtifacts.id});
        if (inserted.length !== 1) { result = fail('VERSION_CONFLICT', 'Source artifact identifier is already used.'); return complete(); }
        resultVersion = 1; result = {ok: true, value: {artifact: artifact.value}}; return complete();
      }

      const [currentRow] = await tx.select().from(schema.projectPlanDrafts).where(and(
        eq(schema.projectPlanDrafts.id, command.payload.planId), eq(schema.projectPlanDrafts.workspaceId, command.workspaceId)
      )).limit(1).for('update');
      if (currentRow !== undefined) projectId = currentRow.projectId;
      const requestedProjectId = command.type === 'project_plan.draft.save' ? command.payload.projectId : projectId;
      if (requestedProjectId === null) { result = fail('NOT_FOUND', 'Project plan was not found.'); return complete(); }
      const rights = await authority(tx, command.workspaceId, requestedProjectId, command.actor.actorId);
      if (rights === null || !rights.canEdit) { result = fail(rights === null ? 'NOT_FOUND' : 'CAPABILITY_DENIED', 'Only the project Product Owner can edit or approve the plan.'); return complete(); }

      if (command.type === 'project_plan.draft.save') {
        expectedVersion = command.payload.expectedRevision ?? undefined;
        const current = currentRow === undefined ? null : draftFrom(currentRow);
        if ((command.payload.expectedRevision === null) !== (current === null) || current !== null && current.revision !== command.payload.expectedRevision) {
          resultVersion = current?.revision; result = fail('VERSION_CONFLICT', 'Project plan draft revision conflicts.'); return complete();
        }
        if (current !== null && (current.state !== 'draft' || current.projectId !== command.payload.projectId)) {
          result = fail(current.state !== 'draft' ? 'INVALID_TRANSITION' : 'INVALID_COMMAND', 'Approved plans are immutable.'); return complete();
        }
        const definition = validateProjectPlanDefinition(command.payload.definition); if (!definition.ok) { result = definition; return complete(); }
        if (!await citationsValid(tx, command.workspaceId, command.payload.projectId, definition.value)) {
          result = fail('INVALID_COMMAND', 'Plan citations must resolve inside this project and bounded source content.'); return complete();
        }
        const contentHash = hashProjectPlanDefinition(definition.value);
        if (current === null) {
          const inserted = await tx.insert(schema.projectPlanDrafts).values({id: command.payload.planId, workspaceId: command.workspaceId, projectId: command.payload.projectId,
            definition: definition.value, contentHash, revision: 1, createdByActorId: command.actor.actorId}).onConflictDoNothing().returning();
          if (inserted.length !== 1) { result = fail('VERSION_CONFLICT', 'Another draft already exists for this project.'); return complete(); }
          resultVersion = 1;
        } else {
          resultVersion = current.revision + 1;
          const updated = await tx.update(schema.projectPlanDrafts).set({definition: definition.value, contentHash, revision: resultVersion, updatedAt: new Date()}).where(and(
            eq(schema.projectPlanDrafts.id, current.id), eq(schema.projectPlanDrafts.revision, current.revision), eq(schema.projectPlanDrafts.state, 'draft')
          )).returning();
          if (updated.length !== 1) { result = fail('VERSION_CONFLICT', 'Project plan draft changed concurrently.'); return complete(); }
        }
        const [stored] = await tx.select().from(schema.projectPlanDrafts).where(eq(schema.projectPlanDrafts.id, command.payload.planId));
        const plan = stored === undefined ? null : draftFrom(stored);
        result = plan === null ? fail('NOT_FOUND', 'Project plan was not found after persistence.') : {ok: true, value: {plan}};
        return complete();
      }

      expectedVersion = command.payload.expectedRevision;
      if (!rights.canApprove) { result = fail('CAPABILITY_DENIED', 'Only an active project Product Owner can approve the plan.'); return complete(); }
      const current = currentRow === undefined ? null : draftFrom(currentRow);
      if (current === null) { result = fail('NOT_FOUND', 'Project plan draft was not found.'); return complete(); }
      if (current.state !== 'draft') { result = fail('INVALID_TRANSITION', 'Only a draft plan can be approved.'); return complete(); }
      if (current.revision !== command.payload.expectedRevision) { resultVersion = current.revision; result = fail('VERSION_CONFLICT', 'Project plan draft revision conflicts.'); return complete(); }
      const simulation = await simulateIn(tx, {workspaceId: command.workspaceId, projectId: current.projectId, actorId: command.actor.actorId, definition: current.definition});
      if (simulation === null || !simulation.readyForApproval || simulation.planHash !== command.payload.expectedPlanHash || simulation.simulationHash !== command.payload.expectedSimulationHash) {
        result = fail('INVALID_COMMAND', simulation === null || !simulation.readyForApproval ? 'Project plan is not ready for approval.' : 'Project plan simulation is stale.'); return complete();
      }
      const [latest] = await tx.select({version: max(schema.projectPlanVersions.version)}).from(schema.projectPlanVersions).where(eq(schema.projectPlanVersions.projectId, current.projectId));
      const approvedVersion = (latest?.version ?? 0) + 1; const now = new Date();
      const citedArtifactIds = [...new Set(evidenceIn(current.definition).flatMap((item) => item.kind === 'citation' ? [item.artifactId] : []))];
      const sourceManifest = citedArtifactIds.length === 0 ? [] : await tx.select({artifactId: schema.projectSourceArtifacts.id, version: schema.projectSourceArtifacts.version, sha256: schema.projectSourceArtifacts.sha256})
        .from(schema.projectSourceArtifacts).where(and(eq(schema.projectSourceArtifacts.workspaceId, command.workspaceId), eq(schema.projectSourceArtifacts.projectId, current.projectId), inArray(schema.projectSourceArtifacts.id, citedArtifactIds)))
        .orderBy(schema.projectSourceArtifacts.id);
      await tx.insert(schema.projectPlanVersions).values({workspaceId: command.workspaceId, projectId: current.projectId, planId: current.id, version: approvedVersion,
        sourceRevision: current.revision, definition: current.definition, contentHash: current.contentHash, sourceManifest, simulation, approvedByActorId: command.actor.actorId, approvedAt: now});
      resultVersion = current.revision + 1;
      const changed = await tx.update(schema.projectPlanDrafts).set({state: 'approved', revision: resultVersion, approvedByActorId: command.actor.actorId, approvedAt: now, updatedAt: now}).where(and(
        eq(schema.projectPlanDrafts.id, current.id), eq(schema.projectPlanDrafts.revision, current.revision), eq(schema.projectPlanDrafts.state, 'draft')
      )).returning();
      if (changed.length !== 1) throw new Error('project_plan_approval_cas_failed');
      const approved: ProjectPlan = {...current, revision: resultVersion, state: 'approved', approvedVersion, approvedByActorId: command.actor.actorId, approvedAt: now.toISOString()};
      result = {ok: true, value: {plan: approved, simulation}}; return complete();
    });
  },

  async inspect(input: {workspaceId: string; projectId: string; actorId: string}): Promise<ProjectPlanWorkspace | null> {
    return db.transaction(async (tx) => {
      const rights = await authority(tx, input.workspaceId, input.projectId, input.actorId);
      if (rights === null || !rights.canRead) return null;
      const [artifactRows, draftRows, approvedRows] = await Promise.all([
        tx.select().from(schema.projectSourceArtifacts).where(and(eq(schema.projectSourceArtifacts.workspaceId, input.workspaceId), eq(schema.projectSourceArtifacts.projectId, input.projectId))).orderBy(desc(schema.projectSourceArtifacts.createdAt)),
        tx.select().from(schema.projectPlanDrafts).where(and(eq(schema.projectPlanDrafts.workspaceId, input.workspaceId), eq(schema.projectPlanDrafts.projectId, input.projectId), eq(schema.projectPlanDrafts.state, 'draft'))).limit(1),
        tx.select().from(schema.projectPlanVersions).where(and(eq(schema.projectPlanVersions.workspaceId, input.workspaceId), eq(schema.projectPlanVersions.projectId, input.projectId))).orderBy(desc(schema.projectPlanVersions.version)).limit(1)
      ]);
      const artifacts = artifactRows.flatMap((row) => {
        const artifact = validateSourceArtifact({id: row.id, projectId: row.projectId, name: row.name, mediaType: row.mediaType, content: row.content, sizeBytes: row.sizeBytes, sha256: row.sha256, provenance: row.provenance, version: row.version});
        return artifact.ok ? [artifact.value] : [];
      });
      const draft = draftRows[0] === undefined ? null : draftFrom(draftRows[0]);
      const approved = approvedRows[0] === undefined ? null : approvedFrom(approvedRows[0]);
      const simulation = draft === null ? null : await simulateIn(tx, {...input, definition: draft.definition});
      return {artifacts, draft, approved, simulation};
    });
  },
  async simulate(input: {workspaceId: string; projectId: string; actorId: string; definition: ProjectPlanDefinition}) {
    return db.transaction((tx) => simulateIn(tx, input));
  }
});
