import {randomUUID} from 'node:crypto';
import {
  deterministicProjectPlanUuid,
  generateProjectPlanDraft,
  hashProjectPlanSourceManifest,
  hashProjectPlanDefinition,
  projectSetupBindingModes,
  projectPlanGenerationLimits,
  projectDossierReadiness,
  sourceArtifactDigest,
  simulateDeliveryProtocol,
  simulateProjectPlan,
  validateDeliveryProtocolDefinition,
  validateProjectPlanDefinition,
  validateSourceArtifact,
  type CommandError,
  type PlanEvidence,
  type ProjectPlan,
  type ProjectPlanDefinition,
  type ProjectPlanMaterialization,
  type ProjectPlanSourceManifest,
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
  const rows = await tx.select({id: schema.projectSourceArtifacts.id, content: schema.projectSourceArtifacts.content})
    .from(schema.projectSourceArtifacts).where(and(
      eq(schema.projectSourceArtifacts.workspaceId, workspaceId), eq(schema.projectSourceArtifacts.projectId, projectId),
      inArray(schema.projectSourceArtifacts.id, ids)
    ));
  const byId = new Map(rows.map((row) => [row.id, row]));
  return citations.every((citation) => {
    const artifact = byId.get(citation.artifactId); if (artifact === undefined) return false;
    if (citation.locator.kind === 'whole_artifact') return true;
    if (citation.locator.kind === 'line_range') return citation.locator.endLine <= artifact.content.split(/\r?\n/).length;
    return pointerExists(artifact.content, citation.locator.pointer);
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

const materializationFrom = (
  row: typeof schema.projectPlanMaterializations.$inferSelect,
  planId: string
): ProjectPlanMaterialization => ({
  id: row.id,
  projectId: row.projectId,
  planId,
  planVersionId: row.planVersionId,
  planVersion: row.planVersion,
  planHash: row.planHash,
  sourceManifestHash: row.sourceManifestHash,
  baselineId: row.baselineId,
  outcomeCount: row.outcomeCount,
  milestoneCount: row.milestoneCount,
  workItemCount: row.workItemCount,
  dependencyCount: row.dependencyCount,
  journeyCount: row.journeyCount,
  publicationIntentCount: row.publicationIntentCount,
  createdAt: row.createdAt.toISOString()
});

const validSourceManifest = (value: unknown): value is ProjectPlanSourceManifest =>
  Array.isArray(value) && value.length <= 100 && value.every((entry) =>
    typeof entry === 'object' && entry !== null && !Array.isArray(entry) &&
    Object.keys(entry).length === 3 && Object.hasOwn(entry, 'artifactId') &&
    Object.hasOwn(entry, 'version') && Object.hasOwn(entry, 'sha256') &&
    typeof entry.artifactId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(entry.artifactId) &&
    typeof entry.version === 'number' && Number.isSafeInteger(entry.version) && entry.version === 1 &&
    typeof entry.sha256 === 'string' && /^[0-9a-f]{64}$/.test(entry.sha256));

const validSetupConfiguration = (value: unknown): value is schema.ProjectSetupConfiguration => {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
    Object.keys(value).length !== 6) return false;
  const configuration = value as Record<string, unknown>;
  if (!['repositoryBinding', 'trackerBinding', 'internalChat', 'clientChat', 'executionMode', 'agentProfileId']
    .every((key) => Object.hasOwn(configuration, key))) return false;
  if (!['repositoryBinding', 'trackerBinding', 'internalChat', 'clientChat'].every((key) =>
    projectSetupBindingModes.includes(configuration[key] as (typeof projectSetupBindingModes)[number]))) return false;
  return (configuration.executionMode === 'manual' && configuration.agentProfileId === null) ||
    (configuration.executionMode === 'managed_agent' && typeof configuration.agentProfileId === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(configuration.agentProfileId));
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
      let result: {ok: true; value: {artifact?: SourceArtifact; plan?: ProjectPlan; simulation?: ProjectPlanSimulation; materialization?: ProjectPlanMaterialization}} | ReturnType<typeof fail>;
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
          sourceKind: command.payload.sourceKind,
          mediaType: command.payload.mediaType,
          content: command.payload.content,
          sizeBytes: command.payload.sizeBytes,
          sha256: command.payload.sha256,
          sourceFile: command.payload.sourceFile,
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

      if (command.type === 'project_plan.materialize') {
        expectedVersion = command.payload.expectedPlanVersion;
        const rights = await authority(tx, command.workspaceId, command.payload.projectId, command.actor.actorId);
        if (rights === null || !rights.canApprove) {
          result = fail(rights === null ? 'NOT_FOUND' : 'CAPABILITY_DENIED',
            'Only an active project Product Owner can materialize the approved plan.');
          return complete();
        }
        const [lockedProject] = await tx.select({id: schema.projects.id}).from(schema.projects).where(and(
          eq(schema.projects.id, command.payload.projectId),
          eq(schema.projects.workspaceId, command.workspaceId)
        )).limit(1).for('update');
        if (lockedProject === undefined) {
          result = fail('NOT_FOUND', 'Project was not found for plan materialization.');
          return complete();
        }
        const [versionRow] = await tx.select().from(schema.projectPlanVersions).where(and(
          eq(schema.projectPlanVersions.workspaceId, command.workspaceId),
          eq(schema.projectPlanVersions.projectId, command.payload.projectId),
          eq(schema.projectPlanVersions.planId, command.payload.planId),
          eq(schema.projectPlanVersions.version, command.payload.expectedPlanVersion)
        )).limit(1).for('update');
        if (versionRow === undefined) {
          result = fail('VERSION_CONFLICT', 'Approved plan version does not match the materialization request.');
          return complete();
        }
        projectId = versionRow.projectId;
        resultVersion = versionRow.version;
        const definition = validateProjectPlanDefinition(versionRow.definition);
        const manifest = versionRow.sourceManifest;
        if (!definition.ok || hashProjectPlanDefinition(definition.ok ? definition.value : versionRow.definition as ProjectPlanDefinition) !== versionRow.contentHash ||
          versionRow.contentHash !== command.payload.expectedPlanHash || !validSourceManifest(manifest) ||
          hashProjectPlanSourceManifest(manifest) !== command.payload.expectedSourceManifestHash) {
          result = fail('INVALID_COMMAND', 'Approved plan or frozen source manifest failed integrity validation.');
          return complete();
        }
        const manifestIds = manifest.map(({artifactId}) => artifactId);
        const artifactRows = manifestIds.length === 0 ? [] : await tx.select({
          artifactId: schema.projectSourceArtifacts.id,
          version: schema.projectSourceArtifacts.version,
          sha256: schema.projectSourceArtifacts.sha256,
          content: schema.projectSourceArtifacts.content
        }).from(schema.projectSourceArtifacts).where(and(
          eq(schema.projectSourceArtifacts.workspaceId, command.workspaceId),
          eq(schema.projectSourceArtifacts.projectId, command.payload.projectId),
          inArray(schema.projectSourceArtifacts.id, manifestIds)
        )).orderBy(schema.projectSourceArtifacts.id).for('share');
        if (artifactRows.length !== manifest.length || artifactRows.some((artifact, index) => {
          const expected = manifest[index];
          return expected === undefined || artifact.artifactId !== expected.artifactId ||
            artifact.version !== expected.version || artifact.sha256 !== expected.sha256 ||
            sourceArtifactDigest(artifact.content) !== artifact.sha256;
        }) || !await citationsValid(tx, command.workspaceId, command.payload.projectId, definition.value)) {
          result = fail('INVALID_COMMAND', 'Frozen source artifacts no longer match the approved plan.');
          return complete();
        }
        const [existingMaterialization] = await tx.select().from(schema.projectPlanMaterializations).where(
          eq(schema.projectPlanMaterializations.planVersionId, versionRow.id)
        ).limit(1);
        if (existingMaterialization !== undefined) {
          result = {ok: true, value: {materialization: materializationFrom(existingMaterialization, versionRow.planId)}};
          return complete();
        }
        const [existingBaseline] = await tx.select({id: schema.projectScopeBaselineVersions.id}).from(
          schema.projectScopeBaselineVersions
        ).where(eq(schema.projectScopeBaselineVersions.projectId, versionRow.projectId)).limit(1).for('update');
        if (existingBaseline !== undefined) {
          result = fail('INVALID_TRANSITION',
            'A scope baseline already exists. Approve an explicit re-plan delta before creating another baseline.');
          return complete();
        }
        const [setup] = await tx.select({configuration: schema.projectSetups.configuration}).from(
          schema.projectSetups
        ).where(eq(schema.projectSetups.projectId, versionRow.projectId)).limit(1);
        if (setup !== undefined && !validSetupConfiguration(setup.configuration)) {
          result = fail('INVALID_COMMAND', 'Project setup configuration is not canonical.');
          return complete();
        }
        const [latestBaseline] = await tx.select({version: max(schema.projectScopeBaselineVersions.version)}).from(
          schema.projectScopeBaselineVersions
        ).where(eq(schema.projectScopeBaselineVersions.projectId, versionRow.projectId));
        const baselineVersion = (latestBaseline?.version ?? 0) + 1;
        const baselineId = deterministicProjectPlanUuid(versionRow.id, 'baseline');
        const materializationId = deterministicProjectPlanUuid(versionRow.id, 'materialization');
        const now = new Date();
        const firstMilestone = definition.value.milestones[0]!;

        await tx.insert(schema.projectScopeBaselineVersions).values({
          id: baselineId,
          projectId: versionRow.projectId,
          version: baselineVersion,
          active: true,
          approvedByActorId: command.actor.actorId,
          approvedAt: versionRow.approvedAt,
          sourcePlanVersionId: versionRow.id,
          sourcePlanHash: versionRow.contentHash,
          checkpointTitle: firstMilestone.checkpoint,
          checkpointStatus: 'backlog',
          checkpointTargetAt: firstMilestone.targetAt === null ? null : new Date(`${firstMilestone.targetAt}T00:00:00.000Z`)
        });

        const outcomeIds = new Map(definition.value.outcomes.map((outcome) => [
          outcome.key,
          deterministicProjectPlanUuid(versionRow.id, 'outcome', outcome.key)
        ]));
        await tx.insert(schema.projectScopeOutcomes).values(definition.value.outcomes.map((outcome) => ({
          id: outcomeIds.get(outcome.key)!,
          baselineId,
          sourcePlanVersionId: versionRow.id,
          key: outcome.key,
          title: outcome.title,
          weight: outcome.weight,
          state: 'not_started' as const,
          evidenceReference: `approved-plan:${versionRow.id}:outcome:${outcome.key}`
        })));
        await tx.insert(schema.projectScopeOutcomeObservations).values({
          id: deterministicProjectPlanUuid(versionRow.id, 'baseline', 'initial-observation'),
          projectId: versionRow.projectId,
          baselineId,
          acceptedWeight: 0,
          totalWeight: 100,
          observedAt: now,
          evidenceReference: `approved-plan:${versionRow.id}:materialized`
        });

        const milestoneIds = new Map(definition.value.milestones.map((milestone) => [
          milestone.key,
          deterministicProjectPlanUuid(versionRow.id, 'milestone', milestone.key)
        ]));
        await tx.insert(schema.milestones).values(definition.value.milestones.map((milestone) => ({
          id: milestoneIds.get(milestone.key)!,
          projectId: versionRow.projectId,
          title: milestone.title,
          description: milestone.checkpoint,
          targetAt: milestone.targetAt === null ? null : new Date(`${milestone.targetAt}T00:00:00.000Z`),
          sourcePlanVersionId: versionRow.id,
          sourceKey: milestone.key,
          checkpoint: milestone.checkpoint,
          sourceEvidence: milestone.evidence
        })));

        const [protocolRow] = await tx.select({
          id: schema.runbooks.id,
          version: schema.runbooks.version,
          definition: schema.runbooks.definition
        }).from(schema.runbooks).where(and(
          eq(schema.runbooks.projectId, versionRow.projectId),
          eq(schema.runbooks.active, true),
          eq(schema.runbooks.protocolState, 'published')
        )).limit(1);
        const protocolDefinition = protocolRow === undefined ? null : validateDeliveryProtocolDefinition(protocolRow.definition);
        const protocolReadiness = protocolRow === undefined ? null : await protocolSimulation(tx, command.workspaceId, versionRow.projectId);
        const firstStage = protocolDefinition?.ok === true && protocolReadiness?.valid === true
          ? protocolDefinition.value.stages.find((stage) => stage.enabled) ?? null
          : null;
        const journeyReady = firstStage !== null && (firstStage.taskStatus === 'backlog' || firstStage.taskStatus === 'ready');
        const workItemIds = new Map(definition.value.tasks.map((task) => [
          task.key,
          deterministicProjectPlanUuid(versionRow.id, 'work_item', task.key)
        ]));
        await tx.insert(schema.workItems).values(definition.value.tasks.map((task) => ({
          id: workItemIds.get(task.key)!,
          projectId: versionRow.projectId,
          milestoneId: milestoneIds.get(task.milestoneKey)!,
          title: task.title,
          summary: `Approved plan ${versionRow.version} · ${task.key}`,
          status: journeyReady && task.dependsOn.length === 0 ? firstStage.taskStatus : 'backlog',
          blocked: false,
          sourcePlanVersionId: versionRow.id,
          sourceTaskKey: task.key,
          acceptanceEvidence: task.acceptanceEvidence
        })));
        const dependencyRows = definition.value.tasks.flatMap((task) => task.dependsOn.map((dependencyKey) => ({
          workItemId: workItemIds.get(task.key)!,
          dependsOnWorkItemId: workItemIds.get(dependencyKey)!,
          sourcePlanVersionId: versionRow.id
        })));
        if (dependencyRows.length > 0) await tx.insert(schema.workItemDependencies).values(dependencyRows);
        const taskOutcomeRows = definition.value.tasks.flatMap((task) => task.outcomeKeys.map((outcomeKey) => ({
          workItemId: workItemIds.get(task.key)!,
          outcomeId: outcomeIds.get(outcomeKey)!,
          sourcePlanVersionId: versionRow.id
        })));
        await tx.insert(schema.workItemScopeOutcomes).values(taskOutcomeRows);

        const journeyWorkItems = journeyReady
          ? definition.value.tasks.filter((task) => task.dependsOn.length === 0)
          : [];
        if (protocolRow !== undefined && firstStage !== null && journeyWorkItems.length > 0) {
          await tx.insert(schema.deliveryJourneys).values(journeyWorkItems.map((task) => ({
            workItemId: workItemIds.get(task.key)!,
            protocolId: protocolRow.id,
            protocolVersion: protocolRow.version!,
            stageKey: firstStage.key,
            version: 1
          })));
        }

        const desiredSurfaces = setup === undefined ? [] : [
          {surface: 'repository' as const, mode: setup.configuration.repositoryBinding},
          {surface: 'tracker' as const, mode: setup.configuration.trackerBinding}
        ].filter((binding) => binding.mode !== 'none');
        const publicationResources = [
          {kind: 'baseline', canonicalId: baselineId},
          ...definition.value.outcomes.map((outcome) => ({kind: 'outcome', canonicalId: outcomeIds.get(outcome.key)!})),
          ...definition.value.milestones.map((milestone) => ({kind: 'milestone', canonicalId: milestoneIds.get(milestone.key)!})),
          ...definition.value.tasks.map((task) => ({kind: 'work_item', canonicalId: workItemIds.get(task.key)!}))
        ];
        const publicationRows = desiredSurfaces.flatMap((binding) => publicationResources.map((resource) => ({
          id: deterministicProjectPlanUuid(versionRow.id, 'materialization', `${binding.surface}:${resource.kind}:${resource.canonicalId}`),
          workspaceId: command.workspaceId,
          projectId: versionRow.projectId,
          planVersionId: versionRow.id,
          surface: binding.surface,
          mode: binding.mode as 'link_existing' | 'create_managed',
          resourceKind: resource.kind,
          canonicalId: resource.canonicalId,
          state: 'desired' as const,
          idempotencyKey: `${versionRow.id}:${binding.surface}:${resource.kind}:${resource.canonicalId}`,
        })));
        if (publicationRows.length > 0) await tx.insert(schema.projectPublicationIntents).values(publicationRows);

        const [materialized] = await tx.insert(schema.projectPlanMaterializations).values({
          id: materializationId,
          workspaceId: command.workspaceId,
          projectId: versionRow.projectId,
          planVersionId: versionRow.id,
          baselineId,
          commandId: command.commandId,
          planVersion: versionRow.version,
          planHash: versionRow.contentHash,
          sourceManifestHash: command.payload.expectedSourceManifestHash,
          outcomeCount: definition.value.outcomes.length,
          milestoneCount: definition.value.milestones.length,
          workItemCount: definition.value.tasks.length,
          dependencyCount: dependencyRows.length,
          journeyCount: journeyWorkItems.length,
          publicationIntentCount: publicationRows.length,
          createdByActorId: command.actor.actorId,
          createdAt: now
        }).returning();
        if (materialized === undefined) throw new Error('project_plan_materialization_missing');
        result = {ok: true, value: {materialization: materializationFrom(materialized, versionRow.planId)}};
        return complete();
      }

      const [currentRow] = await tx.select().from(schema.projectPlanDrafts).where(and(
        eq(schema.projectPlanDrafts.id, command.payload.planId), eq(schema.projectPlanDrafts.workspaceId, command.workspaceId)
      )).limit(1).for('update');
      if (currentRow !== undefined) projectId = currentRow.projectId;
      const requestedProjectId = command.type === 'project_plan.draft.save' || command.type === 'project_plan.draft.generate' ? command.payload.projectId : projectId;
      if (requestedProjectId === null) { result = fail('NOT_FOUND', 'Project plan was not found.'); return complete(); }
      const [lockedProject] = await tx.select({id: schema.projects.id}).from(schema.projects).where(and(
        eq(schema.projects.id, requestedProjectId), eq(schema.projects.workspaceId, command.workspaceId)
      )).limit(1).for('update');
      if (lockedProject === undefined) { result = fail('NOT_FOUND', 'Project was not found.'); return complete(); }
      const rights = await authority(tx, command.workspaceId, requestedProjectId, command.actor.actorId);
      if (rights === null || !rights.canEdit) { result = fail(rights === null ? 'NOT_FOUND' : 'CAPABILITY_DENIED', 'Only the project Product Owner can edit or approve the plan.'); return complete(); }

      if (command.type === 'project_plan.draft.save' || command.type === 'project_plan.draft.generate') {
        expectedVersion = command.payload.expectedRevision ?? undefined;
        const current = currentRow === undefined ? null : draftFrom(currentRow);
        if ((command.payload.expectedRevision === null) !== (current === null) || current !== null && current.revision !== command.payload.expectedRevision) {
          resultVersion = current?.revision; result = fail('VERSION_CONFLICT', 'Project plan draft revision conflicts.'); return complete();
        }
        if (current !== null && current.state !== 'draft') { result = fail('INVALID_TRANSITION', 'Approved plans are immutable.'); return complete(); }
        if (current !== null && current.projectId !== command.payload.projectId) {
          result = fail('INVALID_COMMAND', 'Project plan does not belong to the requested project.'); return complete();
        }
        if (current === null) {
          const [approved] = await tx.select({id: schema.projectPlanVersions.id}).from(schema.projectPlanVersions).where(and(
            eq(schema.projectPlanVersions.workspaceId, command.workspaceId), eq(schema.projectPlanVersions.projectId, command.payload.projectId)
          )).limit(1);
          if (approved !== undefined) {
            result = fail('INVALID_TRANSITION', 'У проекта уже есть утверждённый план. Для нового черновика требуется явный scope-delta re-plan.'); return complete();
          }
        }
        let generatedDefinition: ProjectPlanDefinition | null = null;
        if (command.type === 'project_plan.draft.generate') {
          if (!validSourceManifest(command.payload.sourceManifest) || command.payload.sourceManifest.length < 1 ||
            command.payload.sourceManifest.length > projectPlanGenerationLimits.artifactCount ||
            new Set(command.payload.sourceManifest.map(({artifactId}) => artifactId)).size !== command.payload.sourceManifest.length) {
            result = fail('INVALID_COMMAND', 'Корпус источников некорректен или превышает допустимый размер.'); return complete();
          }
          const requestedArtifactIds = command.payload.sourceManifest.map(({artifactId}) => artifactId);
          const artifactRows = await tx.select().from(schema.projectSourceArtifacts).where(and(
            eq(schema.projectSourceArtifacts.workspaceId, command.workspaceId), eq(schema.projectSourceArtifacts.projectId, command.payload.projectId),
            inArray(schema.projectSourceArtifacts.id, requestedArtifactIds)
          )).orderBy(schema.projectSourceArtifacts.id).for('share');
          const actualManifest = artifactRows.map(({id: artifactId, version, sha256}) => ({artifactId, version, sha256}));
          const requestedManifest = [...command.payload.sourceManifest].sort((left, right) => left.artifactId.localeCompare(right.artifactId));
          if (hashProjectPlanSourceManifest(actualManifest) !== hashProjectPlanSourceManifest(requestedManifest)) {
            result = fail('VERSION_CONFLICT', 'Выбранные источники изменились или недоступны. Обновите страницу и соберите черновик повторно.'); return complete();
          }
          const artifacts = artifactRows.flatMap((row) => {
            const artifact = validateSourceArtifact({id: row.id, projectId: row.projectId, name: row.name, sourceKind: row.sourceKind, mediaType: row.mediaType,
              content: row.content, sizeBytes: row.sizeBytes, sha256: row.sha256, sourceFile: row.sourceFile, provenance: row.provenance, version: row.version});
            return artifact.ok ? [artifact.value] : [];
          });
          if (artifacts.length !== artifactRows.length || artifacts.reduce((total, artifact) => total + artifact.sizeBytes, 0) > projectPlanGenerationLimits.totalBytes) {
            result = fail('INVALID_COMMAND', 'Записанные источники некорректны или превышают лимит 32 материала / 512 КБ.'); return complete();
          }
          const dossier = projectDossierReadiness(artifacts);
          if (!dossier.ready) {
            result = fail('INVALID_TRANSITION', `Черновик нельзя собрать: ${dossier.required
              .flatMap(({remediation}) => remediation === null ? [] : [remediation]).join(' ')}`);
            return complete();
          }
          const generated = generateProjectPlanDraft(artifacts); if (!generated.ok) { result = generated; return complete(); }
          generatedDefinition = generated.value;
        }
        const definition = validateProjectPlanDefinition(command.type === 'project_plan.draft.save' ? command.payload.definition : generatedDefinition);
        if (!definition.ok) { result = definition; return complete(); }
        if (!await citationsValid(tx, command.workspaceId, command.payload.projectId, definition.value)) {
          result = fail('INVALID_COMMAND', 'Plan citations must resolve inside this project and bounded source content.'); return complete();
        }
        const contentHash = hashProjectPlanDefinition(definition.value);
        if (current === null) {
          const inserted = await tx.insert(schema.projectPlanDrafts).values({id: command.payload.planId, workspaceId: command.workspaceId, projectId: command.payload.projectId,
            definition: definition.value, contentHash, revision: 1, createdByActorId: command.actor.actorId}).onConflictDoNothing().returning();
          if (inserted.length !== 1) { result = fail('VERSION_CONFLICT', command.type === 'project_plan.draft.generate'
            ? 'Черновик проекта уже изменён. Обновите страницу перед повторной сборкой.' : 'Another draft already exists for this project.'); return complete(); }
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
        const artifact = validateSourceArtifact({id: row.id, projectId: row.projectId, name: row.name, sourceKind: row.sourceKind, mediaType: row.mediaType, content: row.content, sizeBytes: row.sizeBytes, sha256: row.sha256, sourceFile: row.sourceFile, provenance: row.provenance, version: row.version});
        return artifact.ok ? [artifact.value] : [];
      });
      const draft = draftRows[0] === undefined ? null : draftFrom(draftRows[0]);
      const approved = approvedRows[0] === undefined ? null : approvedFrom(approvedRows[0]);
      const simulation = draft === null ? null : await simulateIn(tx, {...input, definition: draft.definition});
      const [materializationRow] = approvedRows[0] === undefined ? [] : await tx.select().from(
        schema.projectPlanMaterializations
      ).where(eq(schema.projectPlanMaterializations.planVersionId, approvedRows[0].id)).limit(1);
      return {
        artifacts,
        draft,
        approved,
        simulation,
        materialization: materializationRow === undefined || approvedRows[0] === undefined
          ? null
          : materializationFrom(materializationRow, approvedRows[0].planId)
      };
    });
  },
  async simulate(input: {workspaceId: string; projectId: string; actorId: string; definition: ProjectPlanDefinition}) {
    return db.transaction((tx) => simulateIn(tx, input));
  }
});
