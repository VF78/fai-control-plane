import type {
  CanonicalDeploymentProjection,
  ProjectTaskProjection,
  ProjectTaskProjectionReader,
  ProjectionAvailability
} from '@fai-control-plane/domain';
import {and, eq, inArray, isNull} from 'drizzle-orm';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import {providerEvidenceFromPersistedFact} from './tracker-evidence-projection';
import * as schema from './schema';

type Database = NodePgDatabase<typeof schema>;
type Actor = typeof schema.actors.$inferSelect;
type Deployment = typeof schema.deployments.$inferSelect;

const unknown = <T>(): ProjectionAvailability<T> => ({availability: 'unknown'});
const notConfigured = <T>(): ProjectionAvailability<T> => ({availability: 'not_configured'});
const known = <T>(value: T): ProjectionAvailability<T> => ({availability: 'known', value});

const byText = <T>(left: T, right: T, value: (item: T) => string): number => {
  const leftValue = value(left);
  const rightValue = value(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
};

/** Do not pass unvalidated provider metadata through a control-plane projection. */
const safeDeepLink = (value: unknown): string | null => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048) return null;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
      parsed.username === '' && parsed.password === ''
      ? value
      : null;
  } catch {
    return null;
  }
};

const metadataDeepLink = (metadata: Record<string, unknown>): string | null =>
  safeDeepLink(metadata.htmlUrl) ?? safeDeepLink(metadata.url);

const actorProjection = (actor: Actor | undefined) => actor === undefined
  ? unknown<Readonly<{id: string; displayName: string; type: Actor['type']; role: string}>>()
  : known({
      id: actor.id,
      displayName: actor.displayName,
      type: actor.type,
      role: actor.role
    });

const deploymentProjection = (
  deployment: Deployment,
  actors: ReadonlyMap<string, Actor>
): CanonicalDeploymentProjection => ({
  id: deployment.id,
  workItemId: deployment.workItemId,
  environment: deployment.environment,
  revision: deployment.revision,
  status: deployment.status,
  externalRef: deployment.externalRef,
  approvedBy: deployment.approvedByActorId === null
    ? unknown()
    : actorProjection(actors.get(deployment.approvedByActorId)),
  startedAt: deployment.startedAt?.toISOString() ?? null,
  completedAt: deployment.completedAt?.toISOString() ?? null,
  externalEvidence: notConfigured()
});

/**
 * Reads only canonical PostgreSQL facts and persisted provider evidence.
 * Project lookup establishes workspace scope before any related fact is read.
 */
export const createPostgresProjectTaskProjectionReader = (
  db: Database
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

    const taskRows = await db.select().from(schema.workItems).where(and(
      eq(schema.workItems.projectId, project.id),
      isNull(schema.workItems.deletedAt)
    ));
    const taskIds = taskRows.map(({id}) => id);
    const [actorRows, milestoneRows, journeyRows, bindingRows, prRows, checkRows, deploymentRows] = await Promise.all([
      db.select().from(schema.actors).where(eq(schema.actors.workspaceId, input.workspaceId)),
      db.select().from(schema.milestones).where(eq(schema.milestones.projectId, project.id)),
      taskIds.length === 0
        ? Promise.resolve([])
        : db.select().from(schema.deliveryJourneys).where(
            inArray(schema.deliveryJourneys.workItemId, taskIds)
          ),
      taskIds.length === 0
        ? Promise.resolve([])
        : db.select().from(schema.trackerBindings).where(and(
            eq(schema.trackerBindings.projectId, project.id),
            eq(schema.trackerBindings.entityType, 'work_item'),
            inArray(schema.trackerBindings.entityId, taskIds)
          )),
      taskIds.length === 0
        ? Promise.resolve([])
        : db.select().from(schema.prLinks).where(inArray(schema.prLinks.workItemId, taskIds)),
      taskIds.length === 0
        ? Promise.resolve([])
        : db.select({check: schema.buildChecks, pullRequest: schema.prLinks})
            .from(schema.buildChecks)
            .innerJoin(schema.prLinks, eq(schema.prLinks.id, schema.buildChecks.prLinkId))
            .where(inArray(schema.prLinks.workItemId, taskIds)),
      db.select().from(schema.deployments).where(eq(schema.deployments.projectId, project.id))
    ]);

    const actors = new Map(actorRows.map((actor) => [actor.id, actor]));
    const milestones = new Map(milestoneRows.map((milestone) => [milestone.id, milestone]));
    const journeys = new Map(journeyRows.map((journey) => [journey.workItemId, journey]));
    const bindingsByTask = new Map<string, typeof bindingRows>();
    for (const binding of bindingRows) {
      const bindings = bindingsByTask.get(binding.entityId) ?? [];
      bindings.push(binding);
      bindingsByTask.set(binding.entityId, bindings);
    }
    const checksByPullRequest = new Map<string, typeof checkRows>();
    for (const row of checkRows) {
      const checks = checksByPullRequest.get(row.check.prLinkId) ?? [];
      checks.push(row);
      checksByPullRequest.set(row.check.prLinkId, checks);
    }
    const pullRequestsByTask = new Map<string, typeof prRows>();
    for (const pullRequest of prRows) {
      const pullRequests = pullRequestsByTask.get(pullRequest.workItemId) ?? [];
      pullRequests.push(pullRequest);
      pullRequestsByTask.set(pullRequest.workItemId, pullRequests);
    }
    const deploymentsByTask = new Map<string, Deployment[]>();
    for (const deployment of deploymentRows) {
      if (deployment.workItemId === null || !taskIds.includes(deployment.workItemId)) continue;
      const deployments = deploymentsByTask.get(deployment.workItemId) ?? [];
      deployments.push(deployment);
      deploymentsByTask.set(deployment.workItemId, deployments);
    }

    return {
      project: {
        ...project,
        status: notConfigured(),
        blocked: notConfigured(),
        deployments: deploymentRows.slice().sort((left, right) => byText(left, right, (item) => item.id))
          .map((deployment) => deploymentProjection(deployment, actors))
      },
      tasks: taskRows.slice().sort((left, right) => byText(left, right, (item) => item.id)).map((task) => {
        const milestone = task.milestoneId === null ? undefined : milestones.get(task.milestoneId);
        return {
          id: task.id,
          title: task.title,
          summary: task.summary,
          status: task.status,
          blocked: task.blocked,
          version: task.version,
          owner: task.ownerActorId === null ? unknown() : actorProjection(actors.get(task.ownerActorId)),
          milestone: milestone === undefined
            ? unknown()
            : known({
                id: milestone.id,
                title: milestone.title,
                closedAt: milestone.closedAt?.toISOString() ?? null,
                targetAt: milestone.targetAt === null
                  ? unknown()
                  : known(milestone.targetAt.toISOString())
              }),
          deadline: journeys.get(task.id)?.deadlineAt === undefined ||
            journeys.get(task.id)?.deadlineAt === null
            ? notConfigured()
            : known(journeys.get(task.id)!.deadlineAt!.toISOString()),
          sourceBindings: (bindingsByTask.get(task.id) ?? []).slice()
            .sort((left, right) => byText(left, right, (item) => `${item.provider}\u0000${item.surface}\u0000${item.externalId}`))
            .map((binding) => ({
              bindingId: binding.id,
              providerRef: binding.provider,
              surface: binding.surface,
              externalRef: binding.externalId,
              deepLink: metadataDeepLink(binding.metadata),
              evidence: providerEvidenceFromPersistedFact(binding)
            })),
          pullRequests: (pullRequestsByTask.get(task.id) ?? []).slice()
            .sort((left, right) => byText(left, right, (item) => item.id))
            .map((pullRequest) => ({
              id: pullRequest.id,
              providerRef: pullRequest.provider,
              repositoryRef: pullRequest.repositoryRef,
              externalRef: pullRequest.externalId,
              url: safeDeepLink(pullRequest.url),
              headRef: pullRequest.headRef,
              baseRef: pullRequest.baseRef,
              state: pullRequest.state,
              draft: pullRequest.draft,
              evidence: providerEvidenceFromPersistedFact(pullRequest),
              checks: (checksByPullRequest.get(pullRequest.id) ?? []).slice()
                .sort((left, right) => byText(left, right, (item) => item.check.id))
                .map(({check}) => ({
                  id: check.id,
                  providerRef: check.provider,
                  externalRef: check.externalId,
                  name: check.name,
                  status: check.status,
                  conclusion: check.conclusion,
                  detailsUrl: safeDeepLink(check.detailsUrl),
                  evidence: providerEvidenceFromPersistedFact(check)
                }))
            })),
          deployments: (deploymentsByTask.get(task.id) ?? []).slice()
            .sort((left, right) => byText(left, right, (item) => item.id))
            .map((deployment) => deploymentProjection(deployment, actors))
        };
      })
    };
  }
});
