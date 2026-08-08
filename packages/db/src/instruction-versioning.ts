import {randomUUID} from 'node:crypto';
import {
  diffEffectiveInstructions,
  effectiveInstructions,
  type CommandError,
  type EffectiveInstructionDiff,
  type EffectiveInstructions,
  type InstructionContent,
  type InstructionSettings
} from '@fai-control-plane/domain';
import {and, desc, eq, inArray, isNull} from 'drizzle-orm';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import * as schema from './schema';

type Database = NodePgDatabase<typeof schema>;
type Scope =
  | Readonly<{scope: 'workspace'}>
  | Readonly<{scope: 'agent_profile'; agentProfileId: string}>;
type Command = Readonly<{
  commandId: string;
  workspaceId: string;
  correlationId: string;
  idempotencyKey: string;
  issuedAt: string;
  actor: Readonly<{actorId: string}>;
  type: 'instruction_version.publish' | 'instruction_version.rollback';
  payload: Scope & Readonly<{
    versionId: string;
    expectedVersion: number | null;
    approvedByActorId: string;
    content?: InstructionContent;
    rollbackOfVersionId?: string;
  }>;
}>;
type StoreInput = Readonly<{
  command: Command;
  requestHash: string;
  authorized: boolean;
  policyError?: CommandError;
}>;

type VersionRow = Readonly<{
  id: string;
  version: number;
  instructions: string;
  settings: Record<string, unknown>;
}>;

const asContent = (row: VersionRow): InstructionContent => ({
  instructions: row.instructions,
  settings: row.settings as InstructionSettings
});

const resultError = (code: CommandError['code'], message: string) => ({
  ok: false as const,
  error: {code, message}
});
type StoreResult = ReturnType<typeof resultError> | Readonly<{ok: true; value: Readonly<{
  workspaceVersion: number | null;
  profileVersion: number | null;
  effective: EffectiveInstructions;
  diff: EffectiveInstructionDiff;
  versionId: string;
}>}>;

export const createPostgresInstructionVersionStore = (db: Database) => {
  const previewIn = async (
    tx: Parameters<Parameters<Database['transaction']>[0]>[0],
    input: Readonly<{workspaceId: string; agentProfileId?: string}>
  ) => {
    const baselineRows = await tx
      .select({
        id: schema.workspaceInstructionVersions.id,
        version: schema.workspaceInstructionVersions.version,
        instructions: schema.workspaceInstructionVersions.instructions,
        settings: schema.workspaceInstructionVersions.settings
      })
      .from(schema.workspaceInstructionVersions)
      .where(eq(schema.workspaceInstructionVersions.workspaceId, input.workspaceId))
      .orderBy(desc(schema.workspaceInstructionVersions.version))
      .limit(2);
    if (baselineRows[0] === undefined) return null;

    const profileRows = input.agentProfileId === undefined
      ? []
      : await tx
          .select({
            id: schema.agentProfileInstructionVersions.id,
            version: schema.agentProfileInstructionVersions.version,
            instructions: schema.agentProfileInstructionVersions.instructions,
            settings: schema.agentProfileInstructionVersions.settings
          })
          .from(schema.agentProfileInstructionVersions)
          .where(and(
            eq(schema.agentProfileInstructionVersions.workspaceId, input.workspaceId),
            eq(schema.agentProfileInstructionVersions.agentProfileId, input.agentProfileId)
          ))
          .orderBy(desc(schema.agentProfileInstructionVersions.version))
          .limit(2);

    const current = effectiveInstructions(
      asContent(baselineRows[0]),
      profileRows[0] === undefined ? null : asContent(profileRows[0])
    );
    const previous = input.agentProfileId === undefined
      ? baselineRows[1] === undefined
        ? null
        : effectiveInstructions(asContent(baselineRows[1]))
      : profileRows[1] === undefined
        ? effectiveInstructions(asContent(baselineRows[0]))
        : effectiveInstructions(asContent(baselineRows[0]), asContent(profileRows[1]));
    return {
      workspaceVersion: baselineRows[0].version,
      profileVersion: profileRows[0]?.version ?? null,
      effective: current,
      diff: diffEffectiveInstructions(previous, current)
    };
  };

  return {
    async execute(input: StoreInput) {
      return db.transaction(async (tx) => {
        const command = input.command;
        const [claimed] = await tx.insert(schema.commandReceipts).values({
          workspaceId: command.workspaceId,
          idempotencyKey: command.idempotencyKey,
          requestHash: input.requestHash,
          commandId: command.commandId,
          correlationId: command.correlationId,
          commandType: command.type
        }).onConflictDoNothing({
          target: [
            schema.commandReceipts.workspaceId,
            schema.commandReceipts.idempotencyKey
          ]
        }).returning({
          id: schema.commandReceipts.id,
          createdAt: schema.commandReceipts.createdAt
        });

        if (claimed === undefined) {
          const [existing] = await tx.select({
            requestHash: schema.commandReceipts.requestHash,
            state: schema.commandReceipts.state,
            commandId: schema.commandReceipts.commandId,
            correlationId: schema.commandReceipts.correlationId,
            commandType: schema.commandReceipts.commandType,
            result: schema.commandReceipts.result,
            createdAt: schema.commandReceipts.createdAt
          }).from(schema.commandReceipts).where(and(
            eq(schema.commandReceipts.workspaceId, command.workspaceId),
            eq(schema.commandReceipts.idempotencyKey, command.idempotencyKey)
          )).for('update');
          if (existing === undefined || existing.requestHash !== input.requestHash) {
            return {status: 'key_reused' as const, existingRequestHash: existing?.requestHash ?? ''};
          }
          if (existing.state !== 'completed' || existing.result === null) {
            throw new Error('instruction_version_receipt_incomplete');
          }
          return {
            status: 'replayed' as const,
            receipt: {
              commandId: existing.commandId,
              workspaceId: command.workspaceId,
              correlationId: existing.correlationId,
              idempotencyKey: command.idempotencyKey,
              requestHash: existing.requestHash,
              commandType: command.type,
              result: existing.result as StoreResult,
              createdAt: existing.createdAt.toISOString()
            }
          };
        }

        let result: StoreResult;
        const expectedVersion = command.payload.expectedVersion;
        let resultVersion: number | undefined;
        const [author] = await tx.select({id: schema.actors.id}).from(schema.actors).where(and(
          eq(schema.actors.id, command.actor.actorId),
          eq(schema.actors.workspaceId, command.workspaceId),
          eq(schema.actors.type, 'human'),
          eq(schema.actors.authMode, 'user'),
          inArray(schema.actors.role, ['workspace_admin', 'delivery_lead']),
          isNull(schema.actors.disabledAt)
        )).limit(1);

        const complete = async () => {
          const now = new Date();
          await tx.insert(schema.auditEvents).values({
            id: randomUUID(),
            workspaceId: command.workspaceId,
            ...(author === undefined ? {} : {actorId: author.id}),
            commandId: command.commandId,
            actionCategory: 'write',
            action: command.type,
            targetType: command.payload.scope === 'workspace'
              ? 'workspace_instruction_version'
              : 'agent_profile_instruction_version',
            targetId: command.payload.versionId,
            ...(input.authorized
              ? {policyDecision: 'allow' as const}
              : input.policyError?.code === 'POLICY_DENIED'
                ? {policyDecision: 'deny' as const}
                : {}),
            outcome: (result as {ok: boolean}).ok ? 'succeeded' : input.authorized ? 'failed' : 'rejected',
            ...(!(result as {ok: boolean}).ok
              ? {reasonCode: ((result as {error: {code: string}}).error.code)}
              : {}),
            ...(expectedVersion === null ? {} : {expectedVersion}),
            ...(resultVersion === undefined ? {} : {resultVersion}),
            correlationId: command.correlationId,
            occurredAt: now
          });
          await tx.update(schema.commandReceipts).set({
            state: 'completed',
            aggregateType: command.payload.scope === 'workspace'
              ? 'workspace_instruction_version'
              : 'agent_profile_instruction_version',
            aggregateId: command.payload.versionId,
            ...(expectedVersion === null ? {} : {expectedVersion}),
            ...(resultVersion === undefined ? {} : {resultVersion}),
            result,
            completedAt: now
          }).where(eq(schema.commandReceipts.id, claimed.id));
          return {
            status: 'completed' as const,
            receipt: {
              commandId: command.commandId,
              workspaceId: command.workspaceId,
              correlationId: command.correlationId,
              idempotencyKey: command.idempotencyKey,
              requestHash: input.requestHash,
              commandType: command.type,
              result,
              createdAt: claimed.createdAt.toISOString()
            }
          };
        };

        if (!input.authorized) {
          result = resultError(
            input.policyError?.code ?? 'POLICY_DENIED',
            input.policyError?.message ?? 'Policy denies this command.'
          );
          return complete();
        }

        if (
          author === undefined ||
          command.payload.approvedByActorId !== command.actor.actorId
        ) {
          result = resultError(
            'INVALID_ACTOR_CONTEXT',
            'Instruction approval must identify the authenticated human publisher.'
          );
          return complete();
        }
        const workspaceRows = await tx.select({id: schema.workspaces.id})
          .from(schema.workspaces)
          .where(eq(schema.workspaces.id, command.workspaceId))
          .limit(1)
          .for('update');
        if (workspaceRows[0] === undefined) {
          result = resultError('NOT_FOUND', 'Workspace was not found.');
          return complete();
        }

        if (command.payload.scope === 'agent_profile') {
          const [profile] = await tx.select({id: schema.agentProfiles.id})
            .from(schema.agentProfiles)
            .where(and(
              eq(schema.agentProfiles.id, command.payload.agentProfileId),
              eq(schema.agentProfiles.workspaceId, command.workspaceId)
            )).limit(1);
          if (profile === undefined) {
            result = resultError('NOT_FOUND', 'Agent profile was not found in the workspace.');
            return complete();
          }
          const [baseline] = await tx.select({id: schema.workspaceInstructionVersions.id})
            .from(schema.workspaceInstructionVersions)
            .where(eq(schema.workspaceInstructionVersions.workspaceId, command.workspaceId))
            .limit(1);
          if (baseline === undefined) {
            result = resultError(
              'NOT_FOUND',
              'A workspace baseline is required before profile overrides.'
            );
            return complete();
          }
        }

        const latest = command.payload.scope === 'workspace'
          ? await tx.select({
              id: schema.workspaceInstructionVersions.id,
              version: schema.workspaceInstructionVersions.version,
              instructions: schema.workspaceInstructionVersions.instructions,
              settings: schema.workspaceInstructionVersions.settings
            }).from(schema.workspaceInstructionVersions)
              .where(eq(schema.workspaceInstructionVersions.workspaceId, command.workspaceId))
              .orderBy(desc(schema.workspaceInstructionVersions.version)).limit(1).for('update')
          : await tx.select({
              id: schema.agentProfileInstructionVersions.id,
              version: schema.agentProfileInstructionVersions.version,
              instructions: schema.agentProfileInstructionVersions.instructions,
              settings: schema.agentProfileInstructionVersions.settings
            }).from(schema.agentProfileInstructionVersions).where(and(
              eq(schema.agentProfileInstructionVersions.workspaceId, command.workspaceId),
              eq(schema.agentProfileInstructionVersions.agentProfileId, command.payload.agentProfileId)
            )).orderBy(desc(schema.agentProfileInstructionVersions.version)).limit(1).for('update');
        const persistedVersion = latest[0]?.version ?? null;
        if (persistedVersion !== command.payload.expectedVersion) {
          resultVersion = persistedVersion ?? undefined;
          result = resultError('VERSION_CONFLICT', 'Instruction version conflicts with the command.');
          return complete();
        }

        let content = command.payload.content;
        let rollbackOfVersionId: string | null = null;
        if (command.type === 'instruction_version.rollback') {
          rollbackOfVersionId = command.payload.rollbackOfVersionId!;
          const source = command.payload.scope === 'workspace'
            ? await tx.select({
                id: schema.workspaceInstructionVersions.id,
                version: schema.workspaceInstructionVersions.version,
                instructions: schema.workspaceInstructionVersions.instructions,
                settings: schema.workspaceInstructionVersions.settings
              }).from(schema.workspaceInstructionVersions).where(and(
                eq(schema.workspaceInstructionVersions.id, rollbackOfVersionId),
                eq(schema.workspaceInstructionVersions.workspaceId, command.workspaceId)
              )).limit(1)
            : await tx.select({
                id: schema.agentProfileInstructionVersions.id,
                version: schema.agentProfileInstructionVersions.version,
                instructions: schema.agentProfileInstructionVersions.instructions,
                settings: schema.agentProfileInstructionVersions.settings
              }).from(schema.agentProfileInstructionVersions).where(and(
                eq(schema.agentProfileInstructionVersions.id, rollbackOfVersionId),
                eq(schema.agentProfileInstructionVersions.workspaceId, command.workspaceId),
                eq(schema.agentProfileInstructionVersions.agentProfileId, command.payload.agentProfileId)
              )).limit(1);
          if (source[0] === undefined) {
            result = resultError('NOT_FOUND', 'Rollback source was not found in the same scope.');
            return complete();
          }
          content = asContent(source[0]);
        }
        if (content === undefined) {
          result = resultError('INVALID_COMMAND', 'Instruction content is required.');
          return complete();
        }

        const nextVersion = (persistedVersion ?? 0) + 1;
        const contentHash = effectiveInstructions(content).hash;
        if (command.payload.scope === 'workspace') {
          await tx.insert(schema.workspaceInstructionVersions).values({
            id: command.payload.versionId,
            workspaceId: command.workspaceId,
            version: nextVersion,
            instructions: content.instructions,
            settings: content.settings as Record<string, unknown>,
            contentHash,
            authoredByActorId: command.actor.actorId,
            approvedByActorId: author.id,
            rollbackOfVersionId
          });
        } else {
          await tx.insert(schema.agentProfileInstructionVersions).values({
            id: command.payload.versionId,
            workspaceId: command.workspaceId,
            agentProfileId: command.payload.agentProfileId,
            version: nextVersion,
            instructions: content.instructions,
            settings: content.settings as Record<string, unknown>,
            contentHash,
            authoredByActorId: command.actor.actorId,
            approvedByActorId: author.id,
            rollbackOfVersionId
          });
        }
        resultVersion = nextVersion;
        const preview = await previewIn(tx, {
          workspaceId: command.workspaceId,
          ...(command.payload.scope === 'agent_profile'
            ? {agentProfileId: command.payload.agentProfileId}
            : {})
        });
        result = preview === null
          ? resultError('NOT_FOUND', 'A workspace baseline is required before profile overrides.')
          : {ok: true, value: {...preview, versionId: command.payload.versionId}};
        return complete();
      });
    },

    async preview(input: Readonly<{workspaceId: string; agentProfileId?: string}>) {
      return db.transaction((tx) => previewIn(tx, input));
    }
  };
};
