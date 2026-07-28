import {randomUUID} from 'node:crypto';
import {and, eq, gt, inArray, isNull, sql} from 'drizzle-orm';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import * as schema from './schema';

type Database = NodePgDatabase<typeof schema>;

type CreateGrantInput = Readonly<{
  id: string;
  workspaceId: string;
  projectId: string;
  createdByActorId: string;
  workItemIds: readonly string[];
  tokenHash: string;
  expiresAt: Date;
  createdAt: Date;
  commandId: string;
  correlationId: string;
}>;

type RevokeGrantInput = Readonly<{
  workspaceId: string;
  shareId: string;
  revokedByActorId: string;
  revokedAt: Date;
  commandId: string;
  correlationId: string;
}>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_SHARED_WORK_ITEMS = 100;

const validWorkItemScope = (workItemIds: readonly string[]): boolean =>
  workItemIds.length > 0 &&
  workItemIds.length <= MAX_SHARED_WORK_ITEMS &&
  workItemIds.every((id) => UUID_PATTERN.test(id)) &&
  new Set(workItemIds).size === workItemIds.length;

const authorizedActor = (
  actorId: string,
  workspaceId: string
) => and(
  eq(schema.actors.id, actorId),
  eq(schema.actors.workspaceId, workspaceId),
  eq(schema.actors.type, 'human'),
  eq(schema.actors.authMode, 'user'),
  inArray(schema.actors.role, ['workspace_admin', 'delivery_lead']),
  isNull(schema.actors.disabledAt)
);

export const createPostgresProjectShareStore = (db: Database) => ({
  async createGrant(input: CreateGrantInput): Promise<boolean> {
    return db.transaction(async (tx) => {
      if (!validWorkItemScope(input.workItemIds)) return false;
      const [[project], [actor], scopedItems] = await Promise.all([
        tx.select({id: schema.projects.id}).from(schema.projects)
          .where(and(
            eq(schema.projects.id, input.projectId),
            eq(schema.projects.workspaceId, input.workspaceId)
          ))
          .limit(1),
        tx.select({id: schema.actors.id}).from(schema.actors)
          .where(authorizedActor(input.createdByActorId, input.workspaceId))
          .limit(1),
        tx.select({id: schema.workItems.id}).from(schema.workItems)
          .innerJoin(
            schema.projects,
            and(
              eq(schema.projects.id, schema.workItems.projectId),
              eq(schema.projects.workspaceId, input.workspaceId)
            )
          )
          .where(and(
            eq(schema.workItems.projectId, input.projectId),
            inArray(schema.workItems.id, input.workItemIds),
            isNull(schema.workItems.deletedAt)
          ))
      ]);
      if (
        project === undefined ||
        actor === undefined ||
        scopedItems.length !== input.workItemIds.length
      ) {
        return false;
      }

      await tx.insert(schema.projectShareGrants).values({
        id: input.id,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        createdByActorId: input.createdByActorId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
        createdAt: input.createdAt
      });
      await tx.insert(schema.projectShareWorkItems).values(
        input.workItemIds.map((workItemId) => ({
          grantId: input.id,
          workItemId
        }))
      );
      await tx.insert(schema.auditEvents).values({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        actorId: input.createdByActorId,
        commandId: input.commandId,
        actionCategory: 'access_change',
        action: 'project_share.create',
        targetType: 'project_share',
        targetId: input.id,
        outcome: 'succeeded',
        correlationId: input.correlationId,
        occurredAt: input.createdAt
      });
      return true;
    });
  },

  async revokeGrant(input: RevokeGrantInput): Promise<boolean> {
    return db.transaction(async (tx) => {
      const [actor] = await tx.select({id: schema.actors.id})
        .from(schema.actors)
        .where(authorizedActor(input.revokedByActorId, input.workspaceId))
        .limit(1);
      if (actor === undefined) return false;

      const [revoked] = await tx.update(schema.projectShareGrants).set({
        revokedAt: input.revokedAt,
        revokedByActorId: input.revokedByActorId
      }).where(and(
        eq(schema.projectShareGrants.id, input.shareId),
        eq(schema.projectShareGrants.workspaceId, input.workspaceId),
        isNull(schema.projectShareGrants.revokedAt)
      )).returning({projectId: schema.projectShareGrants.projectId});
      if (revoked === undefined) return false;

      await tx.insert(schema.auditEvents).values({
        workspaceId: input.workspaceId,
        projectId: revoked.projectId,
        actorId: input.revokedByActorId,
        commandId: input.commandId,
        actionCategory: 'access_change',
        action: 'project_share.revoke',
        targetType: 'project_share',
        targetId: input.shareId,
        outcome: 'succeeded',
        correlationId: input.correlationId,
        occurredAt: input.revokedAt
      });
      return true;
    });
  },

  async findGrantByTokenHash(tokenHash: string) {
    const [grant] = await db.select({
      id: schema.projectShareGrants.id,
      tokenHash: schema.projectShareGrants.tokenHash,
      projectId: schema.projectShareGrants.projectId,
      expiresAt: schema.projectShareGrants.expiresAt,
      revokedAt: schema.projectShareGrants.revokedAt
    }).from(schema.projectShareGrants).where(
      eq(schema.projectShareGrants.tokenHash, tokenHash)
    ).limit(1);
    if (grant === undefined) return null;

    const items = await db.select({
      title: schema.workItems.title,
      status: schema.workItems.status,
      summary: schema.workItems.summary,
      updatedAt: schema.workItems.updatedAt
    }).from(schema.projectShareWorkItems)
      .innerJoin(
        schema.workItems,
        eq(schema.workItems.id, schema.projectShareWorkItems.workItemId)
      )
      .where(and(
        eq(schema.projectShareWorkItems.grantId, grant.id),
        eq(schema.workItems.projectId, grant.projectId),
        isNull(schema.workItems.deletedAt)
      ))
      .orderBy(
        schema.workItems.status,
        schema.workItems.updatedAt,
        schema.workItems.id
      );
    return {
      id: grant.id,
      tokenHash: grant.tokenHash,
      expiresAt: grant.expiresAt,
      revokedAt: grant.revokedAt,
      items
    };
  },

  async recordAccessIfActive(
    shareId: string,
    tokenHash: string,
    accessedAt: Date
  ): Promise<boolean> {
    return db.transaction(async (tx) => {
      const [recorded] = await tx.update(schema.projectShareGrants).set({
        lastAccessedAt: accessedAt,
        accessCount: sql`${schema.projectShareGrants.accessCount} + 1`
      }).where(and(
        eq(schema.projectShareGrants.id, shareId),
        eq(schema.projectShareGrants.tokenHash, tokenHash),
        isNull(schema.projectShareGrants.revokedAt),
        gt(schema.projectShareGrants.expiresAt, accessedAt)
      )).returning({
        workspaceId: schema.projectShareGrants.workspaceId,
        projectId: schema.projectShareGrants.projectId
      });
      if (recorded === undefined) return false;

      await tx.insert(schema.auditEvents).values({
        workspaceId: recorded.workspaceId,
        projectId: recorded.projectId,
        actorId: null,
        commandId: `project-share-access:${randomUUID()}`,
        actionCategory: 'read',
        action: 'project_share.access',
        targetType: 'project_share',
        targetId: shareId,
        outcome: 'succeeded',
        correlationId: randomUUID(),
        occurredAt: accessedAt
      });
      return true;
    });
  }
});
