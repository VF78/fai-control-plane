import {randomUUID} from 'node:crypto';
import {
  CONVERSATION_CHANNEL_SET_COMMAND,
  createConversationChannelService,
  type ConversationChannelState
} from '@fai-control-plane/application';
import {
  actors,
  conversationChannelConfigurations,
  createDatabase,
  createPostgresConversationChannelStore,
  projects
} from '@fai-control-plane/db';
import {
  createActorContextIssuer,
  type Capability
} from '@fai-control-plane/domain';
import {and, eq, isNull} from 'drizzle-orm';
import {getAccessManagementRuntime} from './access-management-runtime';

type Database = ReturnType<typeof createDatabase>['db'];
type MutationStatus = 'updated' | 'replayed' | 'forbidden' | 'not_found' | 'stale' | 'invalid';
const capabilities = (value: Record<string, boolean>): Capability[] => Object.entries(value)
  .flatMap(([key, enabled]) => enabled ? [key as Capability] : []);

export type ConversationManagementRuntime = Readonly<{
  setChannel(input: Readonly<{
    workspaceId: string;
    operatorActorId: string;
    projectId: string;
    channelId: string;
    conversationClass: 'internal' | 'client';
    desiredState: ConversationChannelState;
    expectedVersion: number | null;
  }>): Promise<MutationStatus>;
  setAccess: Awaited<ReturnType<typeof getAccessManagementRuntime>>['setConversationAccess'];
}>;

const createRuntime = (db: Database): ConversationManagementRuntime => {
  const service = createConversationChannelService(createPostgresConversationChannelStore(db));
  return {
    async setChannel(input) {
      const [operator] = await db.select({capabilities: actors.capabilities}).from(actors).where(and(
        eq(actors.id, input.operatorActorId),
        eq(actors.workspaceId, input.workspaceId),
        eq(actors.type, 'human'),
        eq(actors.authMode, 'user'),
        isNull(actors.disabledAt)
      )).limit(1);
      if (operator === undefined) return 'forbidden';
      const [project] = await db.select({slug: projects.slug}).from(projects).where(and(
        eq(projects.id, input.projectId),
        eq(projects.workspaceId, input.workspaceId)
      )).limit(1);
      if (project === undefined) return 'not_found';
      const [current] = await db.select().from(conversationChannelConfigurations).where(and(
        eq(conversationChannelConfigurations.projectId, input.projectId),
        eq(conversationChannelConfigurations.conversationClass, input.conversationClass)
      )).limit(1);
      if (
        (input.expectedVersion === null && current !== undefined) ||
        (input.expectedVersion !== null && (
          current?.id !== input.channelId || current.version !== input.expectedVersion
        ))
      ) return 'stale';
      const issuer = createActorContextIssuer({
        users: [{actorId: input.operatorActorId, capabilities: capabilities(operator.capabilities)}],
        agents: [],
        systems: []
      });
      if (!issuer.ok) return 'forbidden';
      const actor = issuer.value.issueUser(input.operatorActorId);
      if (!actor.ok) return 'forbidden';
      const provider = input.desiredState === 'not_used' ? null : current?.provider ?? 'telegram';
      const configurationRef = input.desiredState === 'not_used'
        ? null
        : current?.configurationRef ?? `telegram:${project.slug}:${input.conversationClass}`;
      const result = await service.execute({
        commandId: randomUUID(),
        workspaceId: input.workspaceId,
        correlationId: randomUUID(),
        idempotencyKey: [
          'conversation-channel-set:v1', input.channelId,
          input.expectedVersion ?? 0, input.desiredState, input.operatorActorId
        ].join(':'),
        issuedAt: new Date().toISOString(),
        actor: actor.value,
        type: CONVERSATION_CHANNEL_SET_COMMAND,
        payload: {
          projectId: input.projectId,
          channelId: input.channelId,
          conversationClass: input.conversationClass,
          desiredState: input.desiredState,
          provider,
          configurationRef,
          expectedVersion: input.expectedVersion
        }
      });
      if (result.status === 'replayed') return 'replayed';
      if (!('receipt' in result)) return result.error.code === 'CAPABILITY_DENIED' ||
        result.error.code === 'POLICY_DENIED' ? 'forbidden' : 'invalid';
      if (result.receipt.result.ok) return 'updated';
      switch (result.receipt.result.error.code) {
        case 'CAPABILITY_DENIED':
        case 'POLICY_DENIED': return 'forbidden';
        case 'NOT_FOUND': return 'not_found';
        case 'VERSION_CONFLICT': return 'stale';
        default: return 'invalid';
      }
    },
    async setAccess(input) {
      return (await getAccessManagementRuntime()).setConversationAccess(input);
    }
  };
};

let runtimePromise: Promise<ConversationManagementRuntime> | undefined;
export const getConversationManagementRuntime = async (): Promise<ConversationManagementRuntime> => {
  runtimePromise ??= (async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (databaseUrl === undefined || databaseUrl.length === 0) {
      throw new Error('DATABASE_URL is required for Conversations.');
    }
    return createRuntime(createDatabase(databaseUrl).db);
  })().catch((error) => { runtimePromise = undefined; throw error; });
  return runtimePromise;
};
