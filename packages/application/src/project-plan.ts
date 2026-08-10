import {createHash} from 'node:crypto';
import {
  authorize,
  canonicalJson,
  isTrustedActorContext,
  projectSourceArtifactKinds,
  sourceArtifactDigest,
  validateSourceArtifact,
  validateProjectPlanDefinition,
  type CanonicalCommandEnvelope,
  type CommandError,
  type ProjectPlan,
  type ProjectPlanDefinition,
  type ProjectPlanMaterialization,
  type ProjectPlanSourceManifest,
  type ProjectPlanSimulation,
  type SourceArtifact,
  type CommandResult,
  type SourceFileProvenance,
  type SourceArtifactMediaType,
  type TrustedActorContext
} from '@fai-control-plane/domain';

export type RecordSourceArtifactCommand = CanonicalCommandEnvelope<'project_plan.source.record', Readonly<{
  artifactId: string;
  projectId: string;
  name: string;
  sourceKind: import('@fai-control-plane/domain').ProjectSourceArtifactKind;
  mediaType: SourceArtifactMediaType;
  content: string;
  sizeBytes: number;
  sha256: string;
  sourceFile: SourceFileProvenance | null;
  provenance: Readonly<{kind: 'manager_note' | 'manager_upload'; label: string; capturedAt: string}>;
}>>;
export type SaveProjectPlanDraftCommand = CanonicalCommandEnvelope<'project_plan.draft.save', Readonly<{
  planId: string;
  projectId: string;
  expectedRevision: number | null;
  definition: ProjectPlanDefinition;
}>>;
export type GenerateProjectPlanDraftCommand = CanonicalCommandEnvelope<'project_plan.draft.generate', Readonly<{
  planId: string;
  projectId: string;
  expectedRevision: number | null;
  sourceManifest: ProjectPlanSourceManifest;
}>>;
export type ApproveProjectPlanCommand = CanonicalCommandEnvelope<'project_plan.approve', Readonly<{
  planId: string;
  expectedRevision: number;
  expectedPlanHash: string;
  expectedSimulationHash: string;
}>>;
export type MaterializeProjectPlanCommand = CanonicalCommandEnvelope<'project_plan.materialize', Readonly<{
  projectId: string;
  planId: string;
  expectedPlanVersion: number;
  expectedPlanHash: string;
  expectedSourceManifestHash: string;
}>>;
export type ProjectPlanMutationCommand = RecordSourceArtifactCommand | GenerateProjectPlanDraftCommand | SaveProjectPlanDraftCommand | ApproveProjectPlanCommand | MaterializeProjectPlanCommand;
export type SemanticProjectPlanRequest = Readonly<{
  idempotencyKey: string;
  sourceManifest: ProjectPlanSourceManifest;
  artifacts: readonly SourceArtifact[];
}>;
export interface ProjectPlanSemanticPlanner {
  generate(input: SemanticProjectPlanRequest): Promise<CommandResult<ProjectPlanDefinition>>;
}
export type ProjectPlanSemanticPreparation =
  | Readonly<{kind: 'ready'; request: SemanticProjectPlanRequest}>
  | Readonly<{kind: 'replay'; receipt: ProjectPlanReceipt}>;
export type ProjectPlanSemanticPreparationResult = CommandResult<ProjectPlanSemanticPreparation>;

export type ProjectPlanWorkspace = Readonly<{
  artifacts: readonly SourceArtifact[];
  draft: ProjectPlan | null;
  approved: ProjectPlan | null;
  simulation: ProjectPlanSimulation | null;
  materialization: ProjectPlanMaterialization | null;
}>;
export type ProjectPlanReceipt = Readonly<{
  commandId: string;
  commandType: ProjectPlanMutationCommand['type'];
  result: Readonly<{ok: true; value: Readonly<{artifact?: SourceArtifact; plan?: ProjectPlan; simulation?: ProjectPlanSimulation; materialization?: ProjectPlanMaterialization}>}> |
    Readonly<{ok: false; error: CommandError}>;
}>;
export type ProjectPlanExecution =
  | Readonly<{status: 'completed' | 'replayed'; receipt: ProjectPlanReceipt}>
  | Readonly<{status: 'key_reused' | 'rejected'; error: CommandError}>;

export interface ProjectPlanStore {
  execute(input: Readonly<{command: ProjectPlanMutationCommand; requestHash: string; authorized: boolean; policyError?: CommandError; semanticGeneration?: CommandResult<ProjectPlanDefinition>}>): Promise<
    | Readonly<{status: 'completed' | 'replayed'; receipt: ProjectPlanReceipt}>
    | Readonly<{status: 'key_reused'; existingRequestHash: string}>
  >;
  prepareSemanticGeneration(input: Readonly<{command: GenerateProjectPlanDraftCommand; requestHash: string; authorized: boolean}>): Promise<ProjectPlanSemanticPreparationResult>;
  inspect(input: Readonly<{workspaceId: string; projectId: string; actorId: string}>): Promise<ProjectPlanWorkspace | null>;
  simulate(input: Readonly<{workspaceId: string; projectId: string; actorId: string; definition: ProjectPlanDefinition}>): Promise<ProjectPlanSimulation | null>;
}

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
const semanticCitationsMatch = (definition: ProjectPlanDefinition, artifacts: readonly SourceArtifact[]) => {
  const corpus = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const evidence = [...definition.outcomes.map(({evidence}) => evidence), ...definition.milestones.map(({evidence}) => evidence), ...definition.risks.map(({evidence}) => evidence), ...definition.tasks.flatMap(({acceptanceEvidence}) => acceptanceEvidence.map(({evidence}) => evidence))];
  return evidence.every((item) => {
    if (item.kind === 'assumption') return true;
    const artifact = corpus.get(item.artifactId); if (artifact === undefined) return false;
    if (item.locator.kind === 'whole_artifact') return true;
    if (item.locator.kind === 'line_range') return item.locator.endLine <= artifact.content.split(/\r?\n/).length;
    return artifact.mediaType === 'application/json' && pointerExists(artifact.content, item.locator.pointer);
  });
};
export const validateSemanticProjectPlanDefinition = (definition: unknown, artifacts: readonly SourceArtifact[]): CommandResult<ProjectPlanDefinition> => {
  const validated = validateProjectPlanDefinition(definition);
  if (!validated.ok) return validated;
  return semanticCitationsMatch(validated.value, artifacts) ? validated : {ok: false, error: {code: 'INVALID_COMMAND', message: 'Semantic plan citations must resolve inside the exact selected corpus.'}};
};
const unavailableSemanticPlanner: ProjectPlanSemanticPlanner = {generate: async () => ({ok: false, error: {code: 'INVALID_TRANSITION', message: 'Hermes semantic planning is unavailable. Configure and explicitly enable its private runtime before generating a draft.'}})};

export interface ProjectPlanService {
  execute(command: ProjectPlanMutationCommand): Promise<ProjectPlanExecution>;
  inspect(input: Readonly<{workspaceId: string; projectId: string; actor: TrustedActorContext}>): Promise<ProjectPlanWorkspace | null>;
  simulate(input: Readonly<{workspaceId: string; projectId: string; definition: ProjectPlanDefinition; actor: TrustedActorContext}>): Promise<ProjectPlanSimulation | null>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/;
const readPolicy = {actionCategory: 'read', surface: 'control_plane', environment: 'development'} as const;
const writePolicy = {actionCategory: 'write', surface: 'control_plane', environment: 'development'} as const;
const requestHash = (command: ProjectPlanMutationCommand) => createHash('sha256').update(canonicalJson({
  workspaceId: command.workspaceId,
  idempotencyKey: command.idempotencyKey,
  actorId: command.actor.actorId,
  type: command.type,
  payload: command.payload
} as never)).digest('hex');
const rejected = (code: CommandError['code'], message: string): ProjectPlanExecution => ({status: 'rejected', error: {code, message}});
const semanticAttemptCommand = (command: GenerateProjectPlanDraftCommand): GenerateProjectPlanDraftCommand => ({
  ...command,
  // A denial or failed remote attempt is auditable, but must never claim the
  // canonical plan/revision/manifest key that a later valid generation needs.
  idempotencyKey: `project_plan.semantic_attempt.v1:${createHash('sha256').update(`${command.idempotencyKey}\u0000${command.commandId}`).digest('hex')}`
});

const validEnvelope = (command: ProjectPlanMutationCommand) => {
  if (!isTrustedActorContext(command.actor) || !UUID.test(command.commandId) || !UUID.test(command.workspaceId) ||
    !UUID.test(command.correlationId) || command.idempotencyKey.length < 1 || command.idempotencyKey.length > 256) return false;
  try { return new Date(command.issuedAt).toISOString() === command.issuedAt; } catch { return false; }
};

export const createProjectPlanService = (store: ProjectPlanStore, semanticPlanner: ProjectPlanSemanticPlanner = unavailableSemanticPlanner): ProjectPlanService => ({
  async execute(command) {
    if (!validEnvelope(command) || command.actor.kind !== 'trusted_user' || command.actor.actorType !== 'human') {
      return rejected('INVALID_ACTOR_CONTEXT', 'Project plan changes require an authenticated human.');
    }
    if (command.type === 'project_plan.source.record') {
      if (!UUID.test(command.payload.artifactId) || !UUID.test(command.payload.projectId) || !SHA.test(command.payload.sha256) ||
        !projectSourceArtifactKinds.includes(command.payload.sourceKind)) {
        return rejected('INVALID_COMMAND', 'Source artifact command is invalid.');
      }
      const artifact = validateSourceArtifact({
        id: command.payload.artifactId, projectId: command.payload.projectId, name: command.payload.name,
        sourceKind: command.payload.sourceKind, mediaType: command.payload.mediaType, content: command.payload.content,
        sizeBytes: command.payload.sizeBytes, sha256: command.payload.sha256, sourceFile: command.payload.sourceFile,
        provenance: command.payload.provenance, version: 1
      });
      if (!artifact.ok || command.payload.sha256 !== sourceArtifactDigest(command.payload.content)) {
        return rejected('INVALID_COMMAND', 'Source artifact command is invalid.');
      }
    } else if (!UUID.test(command.payload.planId)) {
      return rejected('INVALID_COMMAND', 'Project plan identifier is invalid.');
    } else if (command.type === 'project_plan.draft.save') {
      if (!UUID.test(command.payload.projectId) || !(command.payload.expectedRevision === null || Number.isSafeInteger(command.payload.expectedRevision) && command.payload.expectedRevision > 0)) {
        return rejected('INVALID_COMMAND', 'Draft revision is invalid.');
      }
      const definition = validateProjectPlanDefinition(command.payload.definition);
      if (!definition.ok) return {status: 'rejected', error: definition.error};
    } else if (command.type === 'project_plan.draft.generate') {
      if (!UUID.test(command.payload.projectId) || !(command.payload.expectedRevision === null || Number.isSafeInteger(command.payload.expectedRevision) && command.payload.expectedRevision > 0) ||
        !Array.isArray(command.payload.sourceManifest) || command.payload.sourceManifest.length < 1 || command.payload.sourceManifest.length > 32 ||
        command.payload.sourceManifest.some((entry) => !UUID.test(entry.artifactId) || entry.version !== 1 || !SHA.test(entry.sha256)) ||
        new Set(command.payload.sourceManifest.map(({artifactId}) => artifactId)).size !== command.payload.sourceManifest.length) {
        return rejected('INVALID_COMMAND', 'Draft generation preconditions are invalid.');
      }
    } else if (command.type === 'project_plan.approve' && (!Number.isSafeInteger(command.payload.expectedRevision) || command.payload.expectedRevision < 1 ||
      !SHA.test(command.payload.expectedPlanHash) || !SHA.test(command.payload.expectedSimulationHash))) {
      return rejected('INVALID_COMMAND', 'Plan approval preconditions are invalid.');
    } else if (command.type === 'project_plan.materialize' && (!UUID.test(command.payload.projectId) ||
      !Number.isSafeInteger(command.payload.expectedPlanVersion) || command.payload.expectedPlanVersion < 1 ||
      !SHA.test(command.payload.expectedPlanHash) || !SHA.test(command.payload.expectedSourceManifestHash))) {
      return rejected('INVALID_COMMAND', 'Plan materialization preconditions are invalid.');
    }
    const authorization = authorize(command.actor, writePolicy);
    const requestHashValue = requestHash(command);
    if (command.type === 'project_plan.draft.generate') {
      const attemptedCommand = semanticAttemptCommand(command);
      if (authorization.ok) {
        const preparation = await store.prepareSemanticGeneration({command, requestHash: requestHashValue, authorized: true});
        if (!preparation.ok) {
          if (preparation.error.code === 'IDEMPOTENCY_KEY_REUSED') return rejected('IDEMPOTENCY_KEY_REUSED', 'Idempotency key was already used for another request.');
          const result = await store.execute({command: attemptedCommand, requestHash: requestHash(attemptedCommand), authorized: true});
          return result.status === 'key_reused' ? rejected('IDEMPOTENCY_KEY_REUSED', 'Idempotency key was already used for another request.') : result;
        }
        if (preparation.value.kind === 'replay') {
          return {status: 'replayed', receipt: preparation.value.receipt};
        }
        let semanticGeneration: CommandResult<ProjectPlanDefinition>;
        try { semanticGeneration = await semanticPlanner.generate(preparation.value.request); }
        catch { semanticGeneration = {ok: false, error: {code: 'INVALID_TRANSITION', message: 'Hermes semantic planning is unavailable. No draft was created.'}}; }
        if (semanticGeneration.ok) semanticGeneration = validateSemanticProjectPlanDefinition(semanticGeneration.value, preparation.value.request.artifacts);
        const persistedCommand = semanticGeneration.ok ? command : attemptedCommand;
        const result = await store.execute({command: persistedCommand, requestHash: requestHash(persistedCommand), authorized: true, semanticGeneration});
        return result.status === 'key_reused' ? rejected('IDEMPOTENCY_KEY_REUSED', 'Idempotency key was already used for another request.') : result;
      }
      const result = await store.execute({command: attemptedCommand, requestHash: requestHash(attemptedCommand), authorized: false,
        ...(authorization.ok ? {} : {policyError: authorization.error})});
      return result.status === 'key_reused' ? rejected('IDEMPOTENCY_KEY_REUSED', 'Idempotency key was already used for another request.') : result;
    }
    const result = await store.execute({command, requestHash: requestHashValue, authorized: authorization.ok,
      ...(!authorization.ok ? {policyError: authorization.error} : {})});
    return result.status === 'key_reused'
      ? rejected('IDEMPOTENCY_KEY_REUSED', 'Idempotency key was already used for another request.')
      : result;
  },
  async inspect(input) {
    if (!isTrustedActorContext(input.actor) || !UUID.test(input.workspaceId) || !UUID.test(input.projectId) || !authorize(input.actor, readPolicy).ok) return null;
    return store.inspect({workspaceId: input.workspaceId, projectId: input.projectId, actorId: input.actor.actorId});
  },
  async simulate(input) {
    if (!isTrustedActorContext(input.actor) || !UUID.test(input.workspaceId) || !UUID.test(input.projectId) || !authorize(input.actor, readPolicy).ok) return null;
    const definition = validateProjectPlanDefinition(input.definition);
    return definition.ok ? store.simulate({...input, actorId: input.actor.actorId, definition: definition.value}) : null;
  }
});
