import type {
  ProviderEvidence,
  ProviderEvidenceState,
  TrackerEvidenceProjectionReader
} from '@fai-control-plane/domain';
import {and, eq} from 'drizzle-orm';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import * as schema from './schema';

type Database = NodePgDatabase<typeof schema>;

const evidence = (row: Readonly<{
  provider: string;
  externalId: string;
  externalVersion: string | null;
  observedAt: Date;
  confirmedAt: Date | null;
  evidenceState: string;
  conflictReason: string | null;
}>): ProviderEvidence => ({
  providerRef: row.provider,
  externalRef: row.externalId,
  externalVersion: row.externalVersion,
  observedAt: row.observedAt.toISOString(),
  confirmedAt: row.confirmedAt?.toISOString() ?? null,
  state: row.evidenceState as ProviderEvidenceState,
  conflictReason: row.conflictReason
});

const belongsToRepository = (
  metadata: Record<string, unknown>,
  repositoryExternalRef: string
): boolean => metadata.repositoryExternalId === repositoryExternalRef;

export const createPostgresTrackerEvidenceProjectionReader = (
  db: Database
): TrackerEvidenceProjectionReader => ({
  async read(input) {
    const [project] = await db.select({id: schema.projects.id})
      .from(schema.projects)
      .where(and(
        eq(schema.projects.id, input.projectId),
        eq(schema.projects.workspaceId, input.workspaceId)
      ));
    if (project === undefined) return null;

    const [repositoryBinding] = await db.select({id: schema.trackerBindings.id})
      .from(schema.trackerBindings)
      .where(and(
        eq(schema.trackerBindings.projectId, input.projectId),
        eq(schema.trackerBindings.provider, input.providerRef),
        eq(schema.trackerBindings.surface, 'repository'),
        eq(schema.trackerBindings.entityType, 'project'),
        eq(schema.trackerBindings.entityId, input.projectId),
        eq(schema.trackerBindings.externalId, input.repositoryExternalRef)
      ));
    if (repositoryBinding === undefined) return null;

    const bindingRows = await db.select()
      .from(schema.trackerBindings)
      .where(and(
        eq(schema.trackerBindings.projectId, input.projectId),
        eq(schema.trackerBindings.provider, input.providerRef)
      ));
    const scopedBindings = bindingRows.filter(({id, metadata}) =>
      id === repositoryBinding.id ||
      belongsToRepository(metadata, input.repositoryExternalRef)
    );
    const scopedBindingIds = new Set(scopedBindings.map(({id}) => id));

    const pullRequestRows = await db.select({
      pullRequest: schema.prLinks,
      binding: schema.trackerBindings
    }).from(schema.prLinks)
      .innerJoin(schema.trackerBindings, and(
        eq(schema.trackerBindings.projectId, input.projectId),
        eq(schema.trackerBindings.provider, input.providerRef),
        eq(schema.trackerBindings.surface, 'pull_request'),
        eq(schema.trackerBindings.entityType, 'pr_link'),
        eq(schema.trackerBindings.entityId, schema.prLinks.id),
        eq(schema.trackerBindings.externalId, schema.prLinks.externalId),
        eq(schema.prLinks.provider, input.providerRef)
      ))
      .innerJoin(schema.workItems, and(
        eq(schema.workItems.id, schema.prLinks.workItemId),
        eq(schema.workItems.projectId, input.projectId)
      ));
    const scopedPullRequests = pullRequestRows.filter(({binding}) =>
      scopedBindingIds.has(binding.id) &&
      belongsToRepository(binding.metadata, input.repositoryExternalRef)
    );
    const scopedPullRequestIds = new Set(
      scopedPullRequests.map(({pullRequest}) => pullRequest.id)
    );

    const checkRows = await db.select({
      check: schema.buildChecks,
      binding: schema.trackerBindings
    }).from(schema.buildChecks)
      .innerJoin(schema.trackerBindings, and(
        eq(schema.trackerBindings.projectId, input.projectId),
        eq(schema.trackerBindings.provider, input.providerRef),
        eq(schema.trackerBindings.surface, 'check'),
        eq(schema.trackerBindings.entityType, 'build_check'),
        eq(schema.trackerBindings.entityId, schema.buildChecks.id),
        eq(schema.trackerBindings.externalId, schema.buildChecks.externalId),
        eq(schema.buildChecks.provider, input.providerRef)
      ));

    return {
      bindings: scopedBindings.map((binding) => ({
        bindingId: binding.id,
        surface: binding.surface,
        entityType: binding.entityType,
        entityId: binding.entityId,
        evidence: evidence(binding)
      })),
      pullRequests: scopedPullRequests.map(({pullRequest}) => ({
        pullRequestLinkId: pullRequest.id,
        workItemId: pullRequest.workItemId,
        evidence: evidence(pullRequest)
      })),
      buildChecks: checkRows.filter(({check, binding}) =>
        scopedBindingIds.has(binding.id) &&
        scopedPullRequestIds.has(check.prLinkId) &&
        belongsToRepository(binding.metadata, input.repositoryExternalRef)
      ).map(({check}) => ({
        buildCheckId: check.id,
        pullRequestLinkId: check.prLinkId,
        evidence: evidence(check)
      }))
    };
  }
});
