import {and, asc, eq, isNull, sql} from 'drizzle-orm';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import * as schema from './schema';

type Database = NodePgDatabase<typeof schema>;
type Transaction = Parameters<Database['transaction']>[0] extends (
  tx: infer Value
) => unknown ? Value : never;

export const QA_INTAKE_QUEUE = 'qa-intake';
// pg-boss evaluates cron expressions in UTC; this runs daily at 09:20 UTC.
export const qaIntakeCron = '20 9 * * *';

const qaIntakeName = 'qa_intake';
const maximumWorkItems = 10;
const maximumPullRequestsPerWorkItem = 3;
const maximumChecksPerPullRequest = 20;

const nextQaIntakeRunAt = (runAt: Date): Date => {
  const next = new Date(Date.UTC(
    runAt.getUTCFullYear(), runAt.getUTCMonth(), runAt.getUTCDate(), 9, 20, 0, 0
  ));
  if (next <= runAt) next.setUTCDate(next.getUTCDate() + 1);
  return next;
};

const runKeyFor = (runAt: Date): string => runAt.toISOString().slice(0, 10);

const intakeDeduplicationKey = (projectId: string, runKey: string): string =>
  `qa_intake:${projectId}:${runKey}`;

const configuredProjects = (db: Database) => db.select({
  id: schema.projects.id,
  workspaceId: schema.projects.workspaceId
}).from(schema.projects).innerJoin(schema.projectTrackerRepositoryScopes, and(
  eq(schema.projectTrackerRepositoryScopes.projectId, schema.projects.id),
  eq(schema.projectTrackerRepositoryScopes.provider, 'github')
)).groupBy(
  schema.projects.id,
  schema.projects.workspaceId
).orderBy(asc(schema.projects.id));

const eligibleWorkItems = async (tx: Transaction, projectId: string) => tx.select({
  id: schema.workItems.id,
  version: schema.workItems.version
}).from(schema.workItems).innerJoin(schema.prLinks, and(
  eq(schema.prLinks.workItemId, schema.workItems.id),
  eq(schema.prLinks.provider, 'github'),
  eq(schema.prLinks.state, 'open'),
  eq(schema.prLinks.draft, false)
)).where(and(
  eq(schema.workItems.projectId, projectId),
  eq(schema.workItems.status, 'qa'),
  isNull(schema.workItems.deletedAt)
)).groupBy(schema.workItems.id, schema.workItems.version)
  .orderBy(asc(schema.workItems.id)).limit(maximumWorkItems + 1);

const reviewRequestPayload = async (
  tx: Transaction,
  projectId: string,
  runAt: Date
): Promise<Record<string, unknown>> => {
  const candidates = await eligibleWorkItems(tx, projectId);
  const selected = candidates.slice(0, maximumWorkItems);
  const workItems = await Promise.all(selected.map(async (workItem) => {
    const pullRequests = await tx.select({
      id: schema.prLinks.id,
      externalId: schema.prLinks.externalId,
      repositoryRef: schema.prLinks.repositoryRef,
      url: schema.prLinks.url,
      headRef: schema.prLinks.headRef,
      baseRef: schema.prLinks.baseRef,
      state: schema.prLinks.state,
      draft: schema.prLinks.draft,
      updatedAt: schema.prLinks.updatedAt
    }).from(schema.prLinks).where(and(
      eq(schema.prLinks.workItemId, workItem.id),
      eq(schema.prLinks.provider, 'github'),
      eq(schema.prLinks.state, 'open'),
      eq(schema.prLinks.draft, false)
    )).orderBy(asc(schema.prLinks.id)).limit(maximumPullRequestsPerWorkItem);
    return {
      workItemId: workItem.id,
      workItemVersion: workItem.version,
      pullRequests: await Promise.all(pullRequests.map(async (pullRequest) => ({
        ...pullRequest,
        updatedAt: pullRequest.updatedAt.toISOString(),
        checks: await tx.select({
          externalId: schema.buildChecks.externalId,
          name: schema.buildChecks.name,
          status: schema.buildChecks.status,
          conclusion: schema.buildChecks.conclusion,
          detailsUrl: schema.buildChecks.detailsUrl,
          startedAt: schema.buildChecks.startedAt,
          completedAt: schema.buildChecks.completedAt,
          updatedAt: schema.buildChecks.updatedAt
        }).from(schema.buildChecks).where(eq(schema.buildChecks.prLinkId, pullRequest.id))
          .orderBy(asc(schema.buildChecks.id)).limit(maximumChecksPerPullRequest)
      })))
    };
  }));
  const runKey = runKeyFor(runAt);

  return workItems.length === 0
    ? {schemaVersion: 1, runKey, outcome: 'no_work', observedAt: runAt.toISOString(), workItems}
    : {
        schemaVersion: 1,
        runKey,
        outcome: 'review_requested',
        observedAt: runAt.toISOString(),
        limits: {
          workItems: maximumWorkItems,
          pullRequestsPerWorkItem: maximumPullRequestsPerWorkItem,
          checksPerPullRequest: maximumChecksPerPullRequest
        },
        truncated: candidates.length > maximumWorkItems,
        workItems
      };
};

export const createPostgresQaIntakeProducer = (
  db: Database,
  options: Readonly<{now?: () => Date}> = {}
): Readonly<{run(): Promise<readonly string[]>}> => {
  const now = options.now ?? (() => new Date());

  return {
    async run(): Promise<readonly string[]> {
      const projects = await configuredProjects(db);
      const runAt = now();
      const runKey = runKeyFor(runAt);
      let firstFailure: unknown;
      const eventIds: string[] = [];

      for (const project of projects) {
        try {
          const eventId = await db.transaction(async (tx) => {
            await tx.select({id: schema.projects.id}).from(schema.projects)
              .where(eq(schema.projects.id, project.id)).for('update');
            await tx.insert(schema.scheduledJobs).values({
              projectId: project.id,
              name: qaIntakeName,
              cron: qaIntakeCron,
              queueName: QA_INTAKE_QUEUE,
              status: 'active',
              nextRunAt: nextQaIntakeRunAt(runAt),
              lastRunAt: runAt,
              heartbeatAt: runAt
            }).onConflictDoUpdate({
              target: [schema.scheduledJobs.projectId, schema.scheduledJobs.name],
              set: {
                cron: qaIntakeCron,
                queueName: QA_INTAKE_QUEUE,
                status: 'active',
                nextRunAt: nextQaIntakeRunAt(runAt),
                lastRunAt: runAt,
                heartbeatAt: runAt,
                updatedAt: runAt
              }
            });
            const deduplicationKey = intakeDeduplicationKey(project.id, runKey);
            const [existing] = await tx.select({id: schema.canonicalEvents.id})
              .from(schema.canonicalEvents).where(and(
                eq(schema.canonicalEvents.workspaceId, project.workspaceId),
                eq(schema.canonicalEvents.deduplicationKey, deduplicationKey)
              )).limit(1);
            let canonicalEventId = existing?.id;
            if (canonicalEventId === undefined) {
              const payload = await reviewRequestPayload(tx, project.id, runAt);
              const [created] = await tx.insert(schema.canonicalEvents).values({
                workspaceId: project.workspaceId,
                projectId: project.id,
                eventType: payload.outcome === 'no_work'
                  ? 'qa_intake.no_work.v1'
                  : 'qa_intake.review_requested.v1',
                aggregateType: 'qa_intake',
                deduplicationKey,
                payload,
                occurredAt: runAt
              }).returning({id: schema.canonicalEvents.id});
              if (created === undefined) throw new Error('QA intake event was not persisted.');
              canonicalEventId = created.id;
            }
            await tx.update(schema.scheduledJobs).set({
              status: 'active',
              lastSuccessAt: runAt,
              retryCount: 0,
              heartbeatAt: runAt,
              updatedAt: runAt
            }).where(and(
              eq(schema.scheduledJobs.projectId, project.id),
              eq(schema.scheduledJobs.name, qaIntakeName)
            ));
            return canonicalEventId;
          });
          eventIds.push(eventId);
        } catch (error) {
          await db.insert(schema.scheduledJobs).values({
            projectId: project.id,
            name: qaIntakeName,
            cron: qaIntakeCron,
            queueName: QA_INTAKE_QUEUE,
            status: 'unhealthy',
            nextRunAt: nextQaIntakeRunAt(runAt),
            lastRunAt: runAt,
            retryCount: 1,
            heartbeatAt: runAt
          }).onConflictDoUpdate({
            target: [schema.scheduledJobs.projectId, schema.scheduledJobs.name],
            set: {
              status: 'unhealthy',
              retryCount: sql`${schema.scheduledJobs.retryCount} + 1`,
              nextRunAt: nextQaIntakeRunAt(runAt),
              lastRunAt: runAt,
              heartbeatAt: runAt,
              updatedAt: runAt
            }
          });
          firstFailure ??= error;
        }
      }
      if (firstFailure !== undefined) throw firstFailure;
      return eventIds;
    }
  };
};
