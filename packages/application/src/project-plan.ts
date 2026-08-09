import {createHash} from 'node:crypto';
import {
  authorize,
  canonicalJson,
  isTrustedActorContext,
  validateProjectPlanDefinition,
  type CanonicalCommandEnvelope,
  type CommandError,
  type ProjectPlan,
  type ProjectPlanDefinition,
  type ProjectPlanSimulation,
  type SourceArtifact,
  type SourceArtifactMediaType,
  type TrustedActorContext
} from '@fai-control-plane/domain';

export type RecordSourceArtifactCommand = CanonicalCommandEnvelope<'project_plan.source.record', Readonly<{
  artifactId: string;
  projectId: string;
  name: string;
  mediaType: SourceArtifactMediaType;
  content: string;
  sizeBytes: number;
  sha256: string;
  provenance: Readonly<{kind: 'manager_note' | 'manager_upload'; label: string; capturedAt: string}>;
}>>;
export type SaveProjectPlanDraftCommand = CanonicalCommandEnvelope<'project_plan.draft.save', Readonly<{
  planId: string;
  projectId: string;
  expectedRevision: number | null;
  definition: ProjectPlanDefinition;
}>>;
export type ApproveProjectPlanCommand = CanonicalCommandEnvelope<'project_plan.approve', Readonly<{
  planId: string;
  expectedRevision: number;
  expectedPlanHash: string;
  expectedSimulationHash: string;
}>>;
export type ProjectPlanMutationCommand = RecordSourceArtifactCommand | SaveProjectPlanDraftCommand | ApproveProjectPlanCommand;

export type ProjectPlanWorkspace = Readonly<{
  artifacts: readonly SourceArtifact[];
  draft: ProjectPlan | null;
  approved: ProjectPlan | null;
  simulation: ProjectPlanSimulation | null;
}>;
export type ProjectPlanReceipt = Readonly<{
  commandId: string;
  commandType: ProjectPlanMutationCommand['type'];
  result: Readonly<{ok: true; value: Readonly<{artifact?: SourceArtifact; plan?: ProjectPlan; simulation?: ProjectPlanSimulation}>}> |
    Readonly<{ok: false; error: CommandError}>;
}>;
export type ProjectPlanExecution =
  | Readonly<{status: 'completed' | 'replayed'; receipt: ProjectPlanReceipt}>
  | Readonly<{status: 'key_reused' | 'rejected'; error: CommandError}>;

export interface ProjectPlanStore {
  execute(input: Readonly<{command: ProjectPlanMutationCommand; requestHash: string; authorized: boolean; policyError?: CommandError}>): Promise<
    | Readonly<{status: 'completed' | 'replayed'; receipt: ProjectPlanReceipt}>
    | Readonly<{status: 'key_reused'; existingRequestHash: string}>
  >;
  inspect(input: Readonly<{workspaceId: string; projectId: string; actorId: string}>): Promise<ProjectPlanWorkspace | null>;
  simulate(input: Readonly<{workspaceId: string; projectId: string; actorId: string; definition: ProjectPlanDefinition}>): Promise<ProjectPlanSimulation | null>;
}

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
  commandId: command.commandId,
  workspaceId: command.workspaceId,
  correlationId: command.correlationId,
  idempotencyKey: command.idempotencyKey,
  issuedAt: command.issuedAt,
  actorId: command.actor.actorId,
  type: command.type,
  payload: command.payload
} as never)).digest('hex');
const rejected = (code: CommandError['code'], message: string): ProjectPlanExecution => ({status: 'rejected', error: {code, message}});

const validEnvelope = (command: ProjectPlanMutationCommand) => {
  if (!isTrustedActorContext(command.actor) || !UUID.test(command.commandId) || !UUID.test(command.workspaceId) ||
    !UUID.test(command.correlationId) || command.idempotencyKey.length < 1 || command.idempotencyKey.length > 256) return false;
  try { return new Date(command.issuedAt).toISOString() === command.issuedAt; } catch { return false; }
};

export const createProjectPlanService = (store: ProjectPlanStore): ProjectPlanService => ({
  async execute(command) {
    if (!validEnvelope(command) || command.actor.kind !== 'trusted_user' || command.actor.actorType !== 'human') {
      return rejected('INVALID_ACTOR_CONTEXT', 'Project plan changes require an authenticated human.');
    }
    if (command.type === 'project_plan.source.record') {
      if (!UUID.test(command.payload.artifactId) || !UUID.test(command.payload.projectId) || !SHA.test(command.payload.sha256)) {
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
    } else if (!Number.isSafeInteger(command.payload.expectedRevision) || command.payload.expectedRevision < 1 ||
      !SHA.test(command.payload.expectedPlanHash) || !SHA.test(command.payload.expectedSimulationHash)) {
      return rejected('INVALID_COMMAND', 'Plan approval preconditions are invalid.');
    }
    const authorization = authorize(command.actor, writePolicy);
    const result = await store.execute({command, requestHash: requestHash(command), authorized: authorization.ok,
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
