import type {
  TrackerRepositoryReadScopeAuthorization,
  TrackerRepositoryReadScopeAuthorizationInput,
  TrackerRepositoryReadScopeAuthorizer
} from '@fai-control-plane/domain';
import {and, eq} from 'drizzle-orm';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import * as schema from './schema';

type Database = NodePgDatabase<typeof schema>;

/** Reads only canonical scope configuration; provider credentials are never resolved here. */
export const createPostgresTrackerRepositoryReadScopeAuthorizer = (
  db: Database
): TrackerRepositoryReadScopeAuthorizer => ({
  async authorize(
    input: TrackerRepositoryReadScopeAuthorizationInput
  ): Promise<TrackerRepositoryReadScopeAuthorization> {
    const [scope] = await db.select({
      repositoryExternalId: schema.projectTrackerRepositoryScopes.repositoryExternalId
    }).from(schema.projectTrackerRepositoryScopes)
      .innerJoin(
        schema.actors,
        and(
          eq(schema.actors.id, input.actorId),
          eq(schema.actors.workspaceId, input.workspaceId)
        )
      )
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, input.projectId),
          eq(schema.projects.workspaceId, input.workspaceId)
        )
      )
      .innerJoin(
        schema.secretRefs,
        and(
          eq(
            schema.secretRefs.id,
            schema.projectTrackerRepositoryScopes.credentialRefId
          ),
          eq(schema.secretRefs.workspaceId, input.workspaceId),
          eq(schema.secretRefs.provider, input.credentialRef.provider),
          eq(schema.secretRefs.reference, input.credentialRef.reference),
          eq(schema.secretRefs.scope, [...input.credentialRef.scope])
        )
      )
      .where(and(
        eq(schema.projectTrackerRepositoryScopes.workspaceId, input.workspaceId),
        eq(schema.projectTrackerRepositoryScopes.projectId, input.projectId),
        eq(schema.projectTrackerRepositoryScopes.provider, input.provider),
        eq(
          schema.projectTrackerRepositoryScopes.repositoryOwner,
          input.repository.owner
        ),
        eq(
          schema.projectTrackerRepositoryScopes.repositoryName,
          input.repository.repository
        )
      ));
    return scope === undefined
      ? {status: 'denied'}
      : {status: 'authorized', repositoryExternalId: scope.repositoryExternalId};
  }
});
