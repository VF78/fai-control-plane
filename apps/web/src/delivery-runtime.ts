import {createAgentRunRetryContinuationService, createDeliveryJourneyService, createDeliveryProtocolService, createGovernedQaService, createProjectExecutionService, createProjectOutcomeAcceptanceService, createProjectPlanService} from '@fai-control-plane/application';
import {actors, createDatabase, createPostgresAgentRunRetryContinuationStore, createPostgresDeliveryJourneyStore, createPostgresDeliveryProtocolStore, createPostgresGovernedQaStore, createPostgresProjectExecutionDispatcher, createPostgresProjectExecutionStore, createPostgresProjectOutcomeAcceptanceStore, createPostgresProjectPlanStore, loadProjectExecutionProjection} from '@fai-control-plane/db';
import {createActorContextIssuer, type Capability, type CommandResult, type TrustedUserActorContext} from '@fai-control-plane/domain';
import {and, eq, isNull} from 'drizzle-orm';
import {runnerActivationEnabled} from './runner-activation-policy';
import {createHermesSemanticPlanner} from './hermes-semantic-planner';

type Database = ReturnType<typeof createDatabase>['db'];
const capabilities = (value: Record<string, boolean>): Capability[] => Object.entries(value)
  .flatMap(([key, enabled]) => enabled ? [key as Capability] : []);

export type DeliveryRuntime = Readonly<{
  protocol: ReturnType<typeof createDeliveryProtocolService>;
  journey: ReturnType<typeof createDeliveryJourneyService>;
  governedQa: ReturnType<typeof createGovernedQaService>;
  plan: ReturnType<typeof createProjectPlanService>;
  projectExecution: ReturnType<typeof createProjectExecutionService>;
  agentRunRetryContinuation: ReturnType<typeof createAgentRunRetryContinuationService>;
  projectOutcomeAcceptance: ReturnType<typeof createProjectOutcomeAcceptanceService>;
  projectExecutionDispatch: ReturnType<typeof createPostgresProjectExecutionDispatcher>;
  projectExecutionProjection(workspaceId: string, projectId: string): ReturnType<typeof loadProjectExecutionProjection>;
  actor(workspaceId: string, actorId: string): Promise<CommandResult<TrustedUserActorContext>>;
}>;

const createRuntime = (db: Database): DeliveryRuntime => ({
  protocol: createDeliveryProtocolService(createPostgresDeliveryProtocolStore(db)),
  journey: createDeliveryJourneyService(createPostgresDeliveryJourneyStore(db)),
  governedQa: createGovernedQaService(createPostgresGovernedQaStore(db)),
  plan: createProjectPlanService(createPostgresProjectPlanStore(db), createHermesSemanticPlanner()),
  projectExecution: createProjectExecutionService(createPostgresProjectExecutionStore(db)),
  agentRunRetryContinuation: createAgentRunRetryContinuationService(
    createPostgresAgentRunRetryContinuationStore(db, {
      runnerQueueEnabled: runnerActivationEnabled(), runtimeEnvironment: process.env
    })
  ),
  projectOutcomeAcceptance: createProjectOutcomeAcceptanceService(
    createPostgresProjectOutcomeAcceptanceStore(db)
  ),
  projectExecutionDispatch: createPostgresProjectExecutionDispatcher(db, {
    runnerQueueEnabled: runnerActivationEnabled(), runtimeEnvironment: process.env
  }),
  projectExecutionProjection: (workspaceId, projectId) => loadProjectExecutionProjection(db, workspaceId, projectId),
  async actor(workspaceId, actorId) {
    const [operator] = await db.select({capabilities: actors.capabilities}).from(actors).where(and(
      eq(actors.id, actorId), eq(actors.workspaceId, workspaceId), eq(actors.type, 'human'),
      eq(actors.authMode, 'user'), isNull(actors.disabledAt)
    )).limit(1);
    if (operator === undefined) return {ok: false as const, error: {code: 'INVALID_ACTOR_CONTEXT' as const, message: 'Operator is unavailable.'}};
    const issuer = createActorContextIssuer({users: [{actorId, capabilities: capabilities(operator.capabilities)}], agents: [], systems: []});
    return issuer.ok ? issuer.value.issueUser(actorId) : issuer;
  }
});

let runtimePromise: Promise<DeliveryRuntime> | undefined;
export const getDeliveryRuntime = async (): Promise<DeliveryRuntime> => {
  runtimePromise ??= (async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (databaseUrl === undefined || databaseUrl.length === 0) throw new Error('DATABASE_URL is required for Delivery.');
    const {db} = createDatabase(databaseUrl);
    return createRuntime(db);
  })().catch((error) => { runtimePromise = undefined; throw error; });
  return runtimePromise;
};
