import {
  validateTrackerRepositorySnapshot,
  type ProjectTaskProjection,
  type ProjectTaskProjectionReader,
  type TrackerRepositorySnapshot
} from '@fai-control-plane/domain';
import {and, desc, eq, or, sql} from 'drizzle-orm';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import * as schema from './schema';

type Database = NodePgDatabase<typeof schema>;
const staleAfterMs = 10 * 60_000;

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const resultSnapshot = (
  value: unknown,
  repository: Readonly<{owner: string; repository: string; externalId: string}>
): TrackerRepositorySnapshot | null => {
  const result = object(value);
  if (result === null || (result.status !== 'applied' && result.status !== 'unchanged')) return null;
  return validateTrackerRepositorySnapshot({
    snapshot: result.snapshot,
    repository: {owner: repository.owner, repository: repository.repository},
    repositoryExternalId: repository.externalId
  });
};

const errorCode = (value: unknown): string | null => {
  const result = object(value);
  return result?.status === 'conflict' && typeof result.code === 'string'
    ? result.code
    : null;
};

/** Reads the last validated provider snapshot; PostgreSQL is only its mirror. */
export const createPostgresProjectTaskProjectionReader = (
  db: Database,
  now: () => Date = () => new Date()
): ProjectTaskProjectionReader => ({
  async read(input): Promise<ProjectTaskProjection | null> {
    const [project] = await db.select({
      id: schema.projects.id,
      name: schema.projects.name,
      slug: schema.projects.slug,
      version: schema.projects.version
    }).from(schema.projects).where(and(
      eq(schema.projects.id, input.projectId),
      eq(schema.projects.workspaceId, input.workspaceId)
    ));
    if (project === undefined) return null;

    const [scope] = await db.select({
      owner: schema.projectTrackerRepositoryScopes.repositoryOwner,
      repository: schema.projectTrackerRepositoryScopes.repositoryName,
      externalId: schema.projectTrackerRepositoryScopes.repositoryExternalId
    }).from(schema.projectTrackerRepositoryScopes).where(and(
      eq(schema.projectTrackerRepositoryScopes.projectId, project.id),
      eq(schema.projectTrackerRepositoryScopes.provider, 'github')
    ));
    const operationSelection = {
      result: schema.trackerSnapshotOperations.result,
      createdAt: schema.trackerSnapshotOperations.createdAt
    } as const;
    const operationScope = and(
      eq(schema.trackerSnapshotOperations.projectId, project.id),
      eq(schema.trackerSnapshotOperations.provider, 'github')
    );
    const [[latestAttempt], [successful], [latestReadFailure]] = await Promise.all([
      db.select(operationSelection).from(schema.trackerSnapshotOperations)
        .where(operationScope)
        .orderBy(desc(schema.trackerSnapshotOperations.createdAt))
        .limit(1),
      db.select(operationSelection).from(schema.trackerSnapshotOperations)
        .where(and(
          operationScope,
          or(
            eq(sql<string>`${schema.trackerSnapshotOperations.result}->>'status'`, 'applied'),
            eq(sql<string>`${schema.trackerSnapshotOperations.result}->>'status'`, 'unchanged')
          )
        ))
        .orderBy(desc(schema.trackerSnapshotOperations.createdAt))
        .limit(1),
      db.select({
        reasonCode: schema.auditEvents.reasonCode,
        occurredAt: schema.auditEvents.occurredAt
      }).from(schema.auditEvents).where(and(
        eq(schema.auditEvents.projectId, project.id),
        eq(schema.auditEvents.action, 'tracker_snapshot.reconcile'),
        eq(schema.auditEvents.outcome, 'failed')
      )).orderBy(desc(schema.auditEvents.occurredAt)).limit(1)
    ]);

    const snapshot = scope === undefined || successful === undefined
      ? null
      : resultSnapshot(successful.result, scope);
    const observedAt = successful?.createdAt ?? null;
    const freshness = observedAt === null
      ? 'unavailable'
      : now().getTime() - observedAt.getTime() > staleAfterMs
        ? 'stale'
        : 'fresh';
    const repositoryName = scope === undefined ? null : `${scope.owner}/${scope.repository}`;
    const repositoryUrl = repositoryName === null ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repositoryName)
      ? null
      : `https://github.com/${repositoryName}`;
    const operationFailure = latestAttempt === undefined
      ? null
      : errorCode(latestAttempt.result) === null
        ? null
        : {code: errorCode(latestAttempt.result)!, occurredAt: latestAttempt.createdAt};
    const readFailure = latestReadFailure?.reasonCode === null || latestReadFailure === undefined
      ? null
      : {code: latestReadFailure.reasonCode.toLowerCase(), occurredAt: latestReadFailure.occurredAt};
    const latestFailure = [operationFailure, readFailure]
      .filter((failure): failure is NonNullable<typeof failure> => failure !== null)
      .sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime())[0] ?? null;
    const latestError = latestFailure !== null &&
      (observedAt === null || latestFailure.occurredAt.getTime() > observedAt.getTime())
      ? latestFailure.code
      : null;

    return {
      project: {
        ...project,
        source: {provider: 'github', repository: repositoryName, url: repositoryUrl},
        observedAt: observedAt?.toISOString() ?? null,
        freshness,
        error: scope === undefined
          ? 'repository_scope_not_configured'
          : snapshot === null
            ? latestError ?? 'provider_snapshot_unavailable'
            : latestError
      },
      tasks: snapshot?.projectItems.map((item) => ({
        id: item.externalId,
        issueExternalId: item.issueExternalId,
        title: item.title,
        requirements: item.requirements ?? null,
        state: item.state,
        status: item.status,
        assignees: item.assignees,
        targetDate: item.targetDate,
        parentIssueExternalId: item.parentIssueExternalId,
        subIssueExternalIds: item.subIssueExternalIds,
        dependencyExternalIds: item.dependencyExternalIds,
        sourceUrl: item.htmlUrl,
        observedVersion: item.externalVersion
      })) ?? [],
      pullRequests: snapshot?.pullRequests ?? [],
      checks: snapshot?.checks ?? []
    };
  }
});
