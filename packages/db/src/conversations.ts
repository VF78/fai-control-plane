import {and, asc, eq, inArray, sql} from 'drizzle-orm';
import type {createDatabase} from './index';
import {
  actorExternalIdentities,
  actors,
  conversationBindings,
  conversationMessages,
  conversationParticipants,
  type ConversationAttachmentMetadata
} from './schema';

type Database = ReturnType<typeof createDatabase>['db'];

export const CONVERSATION_MESSAGE_LIMIT = 500;

export type ConversationBindingConfiguration = Readonly<{
  projectId: string;
  conversationClass: 'internal' | 'client';
  provider: string;
  externalRef: string;
  activatedAt: Date;
}>;

export type ConversationObservation = Readonly<{
  provider: string;
  externalBindingRef: string;
  deliveryRef: string;
  messageRef: string;
  authorExternalSubject: string;
  authorDisplayName: string;
  sentAt: Date;
  replyToMessageRef: string | null;
  threadRef: string | null;
  text: string | null;
  attachments: readonly ConversationAttachmentMetadata[];
}>;
export type ConversationIdentityConfiguration = Readonly<{
  actorExternalSubject: string;
  externalSubject: string | null;
}>;

const keyedRef = /^tgid:v1:[0-9a-f]{64}$/;
const providerKey = /^[a-z][a-z0-9_-]{0,63}$/;
const attachmentKinds = new Set([
  'document', 'photo', 'video', 'audio', 'voice', 'sticker', 'animation'
]);
const bounded = (value: string, maximum: number): boolean =>
  value.length > 0 && value.length <= maximum;

const validateConfiguration = (configuration: ConversationBindingConfiguration): void => {
  if (
    !providerKey.test(configuration.provider) ||
    !bounded(configuration.externalRef, 128) ||
    Number.isNaN(configuration.activatedAt.getTime())
  ) throw new Error('Conversation binding configuration is invalid.');
  if (configuration.provider === 'telegram' && !keyedRef.test(configuration.externalRef)) {
    throw new Error('Telegram conversation binding reference is invalid.');
  }
};

const validateObservation = (observation: ConversationObservation): void => {
  if (
    !providerKey.test(observation.provider) ||
    !bounded(observation.externalBindingRef, 128) ||
    !bounded(observation.deliveryRef, 128) ||
    !bounded(observation.messageRef, 128) ||
    !bounded(observation.authorExternalSubject, 128) ||
    !bounded(observation.authorDisplayName, 120) ||
    Number.isNaN(observation.sentAt.getTime()) ||
    (observation.text !== null && (
      !bounded(observation.text, 4000) ||
      /[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(observation.text)
    )) ||
    (observation.replyToMessageRef !== null && !bounded(observation.replyToMessageRef, 128)) ||
    (observation.threadRef !== null && !bounded(observation.threadRef, 128)) ||
    observation.attachments.length > 10 ||
    observation.attachments.some((attachment) =>
      !attachmentKinds.has(attachment.kind) ||
      (attachment.fileName !== undefined && (
        !bounded(attachment.fileName, 180) ||
        /[<>\u0000-\u001f\u007f]/.test(attachment.fileName)
      )) ||
      (attachment.mimeType !== undefined && (
        !bounded(attachment.mimeType, 120) ||
        !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(attachment.mimeType)
      )) ||
      (attachment.sizeBytes !== undefined && (
        !Number.isSafeInteger(attachment.sizeBytes) ||
        attachment.sizeBytes <= 0
      ))
    ) ||
    (observation.text === null && observation.attachments.length === 0)
  ) throw new Error('Conversation observation is invalid.');
  if (observation.provider === 'telegram' && [
    observation.externalBindingRef,
    observation.deliveryRef,
    observation.messageRef,
    observation.authorExternalSubject,
    observation.replyToMessageRef,
    observation.threadRef
  ].some((value) => value !== null && !keyedRef.test(value))) {
    throw new Error('Telegram conversation observation reference is invalid.');
  }
};

export const createPostgresConversationStore = (db: Database) => ({
  async reconcileBindings(
    provider: string,
    projectIds: readonly string[],
    configurations: readonly ConversationBindingConfiguration[]
  ): Promise<void> {
    if (!providerKey.test(provider) || projectIds.length === 0) {
      throw new Error('Conversation binding reconciliation scope is invalid.');
    }
    for (const configuration of configurations) validateConfiguration(configuration);
    const uniqueProjectClasses = new Set(configurations.map((item) =>
      `${item.projectId}:${item.conversationClass}`));
    const uniqueProviderRefs = new Set(configurations.map((item) =>
      `${item.provider}:${item.externalRef}`));
    if (
      uniqueProjectClasses.size !== configurations.length ||
      uniqueProviderRefs.size !== configurations.length
    ) throw new Error('Conversation binding configuration is ambiguous.');

    await db.transaction(async (tx) => {
      await tx.update(conversationBindings).set({
        active: false,
        updatedAt: new Date()
      }).where(and(
        eq(conversationBindings.provider, provider),
        inArray(conversationBindings.projectId, projectIds)
      ));
      for (const configuration of configurations) {
        const [persisted] = await tx.select({
          id: conversationBindings.id,
          projectId: conversationBindings.projectId,
          conversationClass: conversationBindings.conversationClass,
          provider: conversationBindings.provider,
          externalRef: conversationBindings.externalRef,
          activatedAt: conversationBindings.activatedAt
        }).from(conversationBindings).where(and(
          eq(conversationBindings.provider, configuration.provider),
          eq(conversationBindings.externalRef, configuration.externalRef)
        )).limit(1).for('update');
        if (persisted === undefined) {
          await tx.insert(conversationBindings).values({...configuration, active: true});
          continue;
        }
        if (
          persisted.projectId !== configuration.projectId ||
          persisted.conversationClass !== configuration.conversationClass ||
          persisted.provider !== configuration.provider ||
          persisted.externalRef !== configuration.externalRef ||
          persisted.activatedAt.getTime() !== configuration.activatedAt.getTime()
        ) throw new Error('Conversation binding configuration conflicts with canonical state.');
        await tx.update(conversationBindings).set({
          active: true,
          updatedAt: new Date()
        }).where(eq(conversationBindings.id, persisted.id));
      }
    });
  },

  async reconcileIdentities(
    workspaceId: string,
    provider: string,
    configurations: readonly ConversationIdentityConfiguration[]
  ): Promise<void> {
    if (
      !providerKey.test(provider) ||
      configurations.length === 0 ||
      configurations.some(({actorExternalSubject, externalSubject}) =>
        !bounded(actorExternalSubject, 255) ||
        (externalSubject !== null && !bounded(externalSubject, 128))) ||
      new Set(configurations.map(({actorExternalSubject}) => actorExternalSubject)).size !==
        configurations.length ||
      new Set(configurations.flatMap(({externalSubject}) =>
        externalSubject === null ? [] : [externalSubject])).size !==
        configurations.filter(({externalSubject}) => externalSubject !== null).length
    ) throw new Error('Conversation identity configuration is invalid.');
    if (
      provider === 'telegram' &&
      configurations.some(({externalSubject}) =>
        externalSubject !== null && !keyedRef.test(externalSubject))
    ) throw new Error('Telegram conversation identity is invalid.');

    await db.transaction(async (tx) => {
      const workspaceActors = await tx.select({id: actors.id}).from(actors)
        .where(eq(actors.workspaceId, workspaceId));
      const resolved = [];
      for (const configuration of configurations) {
        const matches = await tx.select({id: actors.id}).from(actors).where(and(
          eq(actors.workspaceId, workspaceId),
          eq(actors.externalSubject, configuration.actorExternalSubject)
        )).limit(2);
        if (matches.length !== 1) {
          throw new Error('Conversation identity actor is missing or ambiguous.');
        }
        resolved.push({actorId: matches[0]!.id, ...configuration});
      }
      await tx.update(actorExternalIdentities).set({
        active: false,
        updatedAt: new Date()
      }).where(and(
        eq(actorExternalIdentities.provider, provider),
        inArray(actorExternalIdentities.actorId, workspaceActors.map(({id}) => id))
      ));
      for (const identity of resolved) {
        if (identity.externalSubject === null) continue;
        await tx.insert(actorExternalIdentities).values({
          actorId: identity.actorId,
          provider,
          externalSubject: identity.externalSubject,
          active: true
        }).onConflictDoUpdate({
          target: [
            actorExternalIdentities.actorId,
            actorExternalIdentities.provider
          ],
          set: {
            externalSubject: identity.externalSubject,
            active: true,
            updatedAt: new Date()
          }
        });
      }
    });
  },

  async ingest(observation: ConversationObservation): Promise<'accepted' | 'duplicate' | 'before_activation'> {
    validateObservation(observation);
    return db.transaction(async (tx) => {
      const [binding] = await tx.select().from(conversationBindings).where(and(
        eq(conversationBindings.provider, observation.provider),
        eq(conversationBindings.externalRef, observation.externalBindingRef),
        eq(conversationBindings.active, true)
      )).limit(1).for('update');
      if (binding === undefined) throw new Error('Conversation binding is not configured.');
      if (observation.sentAt < binding.activatedAt) return 'before_activation';
      const [duplicate] = await tx.select({id: conversationMessages.id})
        .from(conversationMessages).where(and(
          eq(conversationMessages.bindingId, binding.id),
          eq(conversationMessages.deliveryRef, observation.deliveryRef)
        )).limit(1);
      if (duplicate !== undefined) return 'duplicate';

      const [identity] = await tx.select({actorId: actorExternalIdentities.actorId})
        .from(actorExternalIdentities).where(and(
          eq(actorExternalIdentities.provider, observation.provider),
          eq(actorExternalIdentities.externalSubject, observation.authorExternalSubject),
          eq(actorExternalIdentities.active, true)
        )).limit(1);
      const [participant] = await tx.insert(conversationParticipants).values({
        bindingId: binding.id,
        externalSubject: observation.authorExternalSubject,
        actorId: identity?.actorId ?? null,
        displayName: observation.authorDisplayName,
        firstObservedAt: observation.sentAt,
        lastObservedAt: observation.sentAt
      }).onConflictDoUpdate({
        target: [
          conversationParticipants.bindingId,
          conversationParticipants.externalSubject
        ],
        set: {
          actorId: identity?.actorId ?? null,
          displayName: observation.authorDisplayName,
          firstObservedAt: sql`least(
            ${conversationParticipants.firstObservedAt},
            ${observation.sentAt}
          )`,
          lastObservedAt: sql`greatest(
            ${conversationParticipants.lastObservedAt},
            ${observation.sentAt}
          )`,
          updatedAt: new Date()
        }
      }).returning({id: conversationParticipants.id});
      if (participant === undefined) throw new Error('Conversation participant was not persisted.');

      const inserted = await tx.insert(conversationMessages).values({
        bindingId: binding.id,
        participantId: participant.id,
        deliveryRef: observation.deliveryRef,
        messageRef: observation.messageRef,
        replyToMessageRef: observation.replyToMessageRef,
        threadRef: observation.threadRef,
        sentAt: observation.sentAt,
        text: observation.text,
        attachments: observation.attachments
      }).onConflictDoNothing({
        target: [conversationMessages.bindingId, conversationMessages.deliveryRef]
      }).returning({id: conversationMessages.id});
      if (inserted.length === 0) return 'duplicate';

      const now = new Date();
      await tx.update(conversationBindings).set({
        lastObservedAt: now,
        lastFailureAt: null,
        lastFailureCode: null,
        updatedAt: now
      }).where(eq(conversationBindings.id, binding.id));
      await tx.execute(sql`
        delete from ${conversationMessages}
        where ${conversationMessages.id} in (
          select ${conversationMessages.id}
          from ${conversationMessages}
          where ${conversationMessages.bindingId} = ${binding.id}
          order by ${conversationMessages.sentAt} desc, ${conversationMessages.id} desc
          offset ${CONVERSATION_MESSAGE_LIMIT}
        )
      `);
      await tx.execute(sql`
        delete from ${conversationParticipants}
        where ${conversationParticipants.bindingId} = ${binding.id}
          and not exists (
            select 1
            from ${conversationMessages}
            where ${conversationMessages.participantId} = ${conversationParticipants.id}
          )
      `);
      return 'accepted';
    });
  },

  async recordFailure(provider: string, externalRef: string, code: string): Promise<void> {
    if (!providerKey.test(provider) || !bounded(externalRef, 128) || !/^[a-z0-9_]{1,64}$/.test(code)) {
      throw new Error('Conversation ingestion failure is invalid.');
    }
    const now = new Date();
    await db.update(conversationBindings).set({
      lastFailureAt: now,
      lastFailureCode: code,
      failureCount: sql`${conversationBindings.failureCount} + 1`,
      updatedAt: now
    }).where(and(
      eq(conversationBindings.provider, provider),
      eq(conversationBindings.externalRef, externalRef)
    ));
  }
});

export const loadConversationRows = async (
  db: Database,
  projectIds: readonly string[]
) => projectIds.length === 0 ? {bindings: [], participants: [], messages: []} : {
  bindings: await db.select().from(conversationBindings)
    .where(and(
      inArray(conversationBindings.projectId, projectIds),
      eq(conversationBindings.active, true)
    ))
    .orderBy(conversationBindings.projectId, conversationBindings.conversationClass),
  participants: await db.select({
    id: conversationParticipants.id,
    bindingId: conversationParticipants.bindingId,
    actorId: conversationParticipants.actorId,
    lastObservedAt: conversationParticipants.lastObservedAt
  }).from(conversationParticipants)
    .innerJoin(conversationBindings, eq(conversationParticipants.bindingId, conversationBindings.id))
    .where(and(
      inArray(conversationBindings.projectId, projectIds),
      eq(conversationBindings.active, true)
    ))
    .orderBy(conversationParticipants.displayName),
  messages: await db.select({
    id: conversationMessages.id,
    bindingId: conversationMessages.bindingId,
    participantId: conversationMessages.participantId,
    replyToMessageRef: conversationMessages.replyToMessageRef,
    threadRef: conversationMessages.threadRef,
    sentAt: conversationMessages.sentAt,
    text: conversationMessages.text,
    attachments: conversationMessages.attachments
  }).from(conversationMessages)
    .innerJoin(conversationBindings, eq(conversationMessages.bindingId, conversationBindings.id))
    .where(and(
      inArray(conversationBindings.projectId, projectIds),
      eq(conversationBindings.active, true)
    ))
    .orderBy(asc(conversationMessages.sentAt), conversationMessages.id)
};
