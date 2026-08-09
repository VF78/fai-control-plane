import {createHash, randomUUID} from 'node:crypto';
import {and, eq, isNull} from 'drizzle-orm';
import type {CommandError} from '@fai-control-plane/domain';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import * as schema from './schema';

type Database = NodePgDatabase<typeof schema>;
type Command = Readonly<{
  commandId: string;
  workspaceId: string;
  correlationId: string;
  idempotencyKey: string;
  actor: Readonly<{actorId: string}>;
  type: 'conversation_channel.set.v1';
  payload: Readonly<{
    projectId: string;
    channelId: string;
    conversationClass: 'internal' | 'client';
    desiredState: 'active' | 'inactive' | 'not_used';
    provider: string | null;
    configurationRef: string | null;
    expectedVersion: number | null;
  }>;
}>;
type Value = Readonly<{
  projectId: string;
  channelId: string;
  conversationClass: 'internal' | 'client';
  desiredState: 'active' | 'inactive' | 'not_used';
  provider: string | null;
  configurationRef: string | null;
  version: number;
}>;
type Result = Readonly<{ok: true; value: Value}> | Readonly<{ok: false; error: CommandError}>;
const fail = (code: CommandError['code'], message: string): Result => ({ok: false, error: {code, message}});
const attemptKey = (command: Command, requestHash: string): string =>
  `conversation-channel-attempt:v1:${createHash('sha256')
    .update(`${command.actor.actorId}:${requestHash}:${command.commandId}`)
    .digest('hex')}`;
const attemptAuditId = (command: Command, requestHash: string, code: string): string =>
  `conversation-channel-attempt:v1:${createHash('sha256')
    .update(`${command.commandId}:${requestHash}:${code}`)
    .digest('hex')}`;

const canManage = async (
  tx: Parameters<Parameters<Database['transaction']>[0]>[0],
  workspaceId: string,
  projectId: string,
  actorId: string
): Promise<boolean> => {
  const [actor] = await tx.select({role: schema.actors.role}).from(schema.actors).where(and(
    eq(schema.actors.id, actorId),
    eq(schema.actors.workspaceId, workspaceId),
    eq(schema.actors.type, 'human'),
    eq(schema.actors.authMode, 'user'),
    isNull(schema.actors.disabledAt)
  )).limit(1);
  if (actor?.role === 'workspace_admin') return true;
  const [membership] = await tx.select({role: schema.projectMemberships.role})
    .from(schema.projectMemberships).where(and(
      eq(schema.projectMemberships.projectId, projectId),
      eq(schema.projectMemberships.actorId, actorId),
      eq(schema.projectMemberships.active, true)
    )).limit(1);
  return membership?.role === 'project_owner' || membership?.role === 'workspace_owner';
};

export const createPostgresConversationChannelStore = (db: Database) => ({
  async execute(input: Readonly<{
    command: Command;
    requestHash: string;
    authorized: boolean;
    policyError?: CommandError;
  }>) {
    return db.transaction(async (tx) => {
      const {command} = input;
      let result: Result = fail('INVALID_COMMAND', 'Conversation channel was not evaluated.');
      let resultVersion: number | undefined;
      const complete = async (
        projectId: string | undefined,
        decision: 'allow' | 'deny' = input.authorized ? 'allow' : 'deny',
        successReceipt?: typeof schema.commandReceipts.$inferSelect
      ) => {
        const now = new Date();
        let stored = successReceipt;
        let idempotencyKey = command.idempotencyKey;
        if (!result.ok) {
          idempotencyKey = attemptKey(command, input.requestHash);
          const [inserted] = await tx.insert(schema.commandReceipts).values({
            workspaceId: command.workspaceId,
            idempotencyKey,
            requestHash: input.requestHash,
            commandId: command.commandId,
            correlationId: command.correlationId,
            commandType: command.type,
            state: 'completed',
            aggregateType: 'conversation_channel',
            aggregateId: command.payload.channelId,
            expectedVersion: command.payload.expectedVersion,
            resultVersion,
            result,
            completedAt: now
          }).onConflictDoNothing({
            target: [schema.commandReceipts.workspaceId, schema.commandReceipts.idempotencyKey]
          }).returning();
          [stored] = inserted === undefined ? await tx.select().from(schema.commandReceipts).where(and(
            eq(schema.commandReceipts.workspaceId, command.workspaceId),
            eq(schema.commandReceipts.idempotencyKey, idempotencyKey)
          )).limit(1).for('update') : [inserted];
        } else {
          if (stored === undefined) throw new Error('conversation_channel_receipt_unclaimed');
          await tx.update(schema.commandReceipts).set({
            state: 'completed',
            aggregateType: 'conversation_channel',
            aggregateId: command.payload.channelId,
            expectedVersion: command.payload.expectedVersion,
            resultVersion,
            result,
            completedAt: now
          }).where(eq(schema.commandReceipts.id, stored.id));
        }
        if (stored === undefined || stored.requestHash !== input.requestHash) {
          throw new Error('conversation_channel_receipt_incomplete');
        }
        const storedResult = result.ok ? result : stored.result as Result;
        await tx.insert(schema.auditEvents).values({
          id: randomUUID(),
          workspaceId: command.workspaceId,
          projectId,
          actorId: command.actor.actorId,
          commandId: storedResult.ok
            ? command.commandId
            : attemptAuditId(command, input.requestHash, storedResult.error.code),
          actionCategory: 'access_change',
          action: command.type,
          targetType: 'conversation_channel',
          targetId: command.payload.channelId,
          policyDecision: decision,
          outcome: storedResult.ok ? 'succeeded' : decision === 'deny' ? 'rejected' : 'failed',
          ...(!storedResult.ok ? {reasonCode: storedResult.error.code} : {}),
          expectedVersion: command.payload.expectedVersion,
          resultVersion,
          correlationId: command.correlationId,
          occurredAt: now,
          metadata: {}
        }).onConflictDoNothing({target: [schema.auditEvents.workspaceId, schema.auditEvents.commandId]});
        return {
          status: 'completed' as const,
          receipt: {
            commandId: stored.commandId,
            workspaceId: command.workspaceId,
            correlationId: stored.correlationId,
            idempotencyKey,
            requestHash: stored.requestHash,
            commandType: command.type,
            result: storedResult,
            createdAt: stored.createdAt.toISOString()
          }
        };
      };

      if (!input.authorized) {
        result = fail(input.policyError?.code ?? 'POLICY_DENIED',
          input.policyError?.message ?? 'Policy denies conversation management.');
        return complete(undefined, 'deny');
      }
      const [project] = await tx.select({id: schema.projects.id}).from(schema.projects).where(and(
        eq(schema.projects.id, command.payload.projectId),
        eq(schema.projects.workspaceId, command.workspaceId)
      )).limit(1).for('update');
      if (project === undefined) {
        result = fail('NOT_FOUND', 'Project was not found.');
        return complete(undefined);
      }
      if (!await canManage(tx, command.workspaceId, project.id, command.actor.actorId)) {
        result = fail('CAPABILITY_DENIED', 'Only a project owner can manage conversations.');
        return complete(project.id, 'deny');
      }
      const [current] = await tx.select().from(schema.conversationChannelConfigurations)
        .where(and(
          eq(schema.conversationChannelConfigurations.projectId, project.id),
          eq(schema.conversationChannelConfigurations.conversationClass, command.payload.conversationClass)
        )).limit(1).for('update');
      const [existingSuccess] = await tx.select().from(schema.commandReceipts).where(and(
        eq(schema.commandReceipts.workspaceId, command.workspaceId),
        eq(schema.commandReceipts.idempotencyKey, command.idempotencyKey)
      )).limit(1).for('update');
      if (existingSuccess !== undefined) {
        if (existingSuccess.requestHash !== input.requestHash) return {
          status: 'key_reused' as const,
          existingRequestHash: existingSuccess.requestHash
        };
        if (existingSuccess.state !== 'completed' || existingSuccess.result === null) {
          throw new Error('conversation_channel_receipt_incomplete');
        }
        return {
          status: 'replayed' as const,
          receipt: {
            commandId: existingSuccess.commandId,
            workspaceId: command.workspaceId,
            correlationId: existingSuccess.correlationId,
            idempotencyKey: command.idempotencyKey,
            requestHash: existingSuccess.requestHash,
            commandType: command.type,
            result: existingSuccess.result as Result,
            createdAt: existingSuccess.createdAt.toISOString()
          }
        };
      }
      if (
        (command.payload.expectedVersion === null && current !== undefined) ||
        (command.payload.expectedVersion !== null && (
          current === undefined || current.id !== command.payload.channelId ||
          current.version !== command.payload.expectedVersion
        ))
      ) {
        resultVersion = current?.version;
        result = fail('VERSION_CONFLICT', 'Conversation channel version conflicts.');
        return complete(project.id);
      }
      if (current !== undefined && current.desiredState !== 'not_used' &&
        command.payload.desiredState !== 'not_used' && (
          current.provider !== command.payload.provider ||
          current.configurationRef !== command.payload.configurationRef
        )) {
        result = fail('INVALID_COMMAND', 'Conversation provider binding is immutable while configured.');
        return complete(project.id);
      }
      const [claimed] = await tx.insert(schema.commandReceipts).values({
        workspaceId: command.workspaceId,
        idempotencyKey: command.idempotencyKey,
        requestHash: input.requestHash,
        commandId: command.commandId,
        correlationId: command.correlationId,
        commandType: command.type
      }).onConflictDoNothing({
        target: [schema.commandReceipts.workspaceId, schema.commandReceipts.idempotencyKey]
      }).returning();
      if (claimed === undefined) throw new Error('conversation_channel_concurrent_receipt');

      const now = new Date();
      const version = (command.payload.expectedVersion ?? 0) + 1;
      if (current === undefined) {
        await tx.insert(schema.conversationChannelConfigurations).values({
          id: command.payload.channelId,
          projectId: project.id,
          conversationClass: command.payload.conversationClass,
          desiredState: command.payload.desiredState,
          provider: command.payload.provider,
          configurationRef: command.payload.configurationRef,
          version
        });
      } else {
        const [updated] = await tx.update(schema.conversationChannelConfigurations).set({
          desiredState: command.payload.desiredState,
          provider: command.payload.provider,
          configurationRef: command.payload.configurationRef,
          version,
          updatedAt: now
        }).where(and(
          eq(schema.conversationChannelConfigurations.id, current.id),
          eq(schema.conversationChannelConfigurations.version, current.version)
        )).returning({id: schema.conversationChannelConfigurations.id});
        if (updated === undefined) throw new Error('conversation_channel_cas');
      }
      if (command.payload.desiredState !== 'active') {
        await tx.update(schema.conversationBindings).set({active: false, updatedAt: now}).where(and(
          eq(schema.conversationBindings.projectId, project.id),
          eq(schema.conversationBindings.conversationClass, command.payload.conversationClass),
          eq(schema.conversationBindings.active, true)
        ));
      }
      resultVersion = version;
      result = {ok: true, value: {
        projectId: project.id,
        channelId: command.payload.channelId,
        conversationClass: command.payload.conversationClass,
        desiredState: command.payload.desiredState,
        provider: command.payload.provider,
        configurationRef: command.payload.configurationRef,
        version
      }};
      return complete(project.id, 'allow', claimed);
    });
  }
});
