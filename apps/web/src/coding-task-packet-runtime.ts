import {createHash} from 'node:crypto';
import {and, eq, inArray, isNull} from 'drizzle-orm';
import {createCanonicalCommandService} from '@fai-control-plane/application';
import {
  actors,
  agentProfiles,
  canonicalEvents,
  createDatabase,
  createPostgresUnitOfWork,
  projectTrackerRepositoryScopes,
  projects,
  trackerBindings,
  workItems
} from '@fai-control-plane/db';
import {createActorContextIssuer, type Capability} from '@fai-control-plane/domain';
import type {OperatorProjectSlug} from './operator-data';

type Database = ReturnType<typeof createDatabase>['db'];

const requiredCapability: Capability = 'write:control_plane:development';
const maximumIssueRequirementsBytes = 32 * 1_024;

const deterministicUuid = (value: string): string => {
  const hex = createHash('sha256').update(value).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${
    (Number.parseInt(hex[16]!, 16) & 0x3 | 0x8).toString(16)
  }${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

const enabledCapabilities = (value: Record<string, boolean>): Capability[] =>
  Object.entries(value).flatMap(([capability, enabled]) => enabled
    ? [capability as Capability]
    : []);

const confirmedIssueUrl = (
  metadata: Record<string, unknown>,
  owner: string,
  repository: string
): string | null => {
  const number = metadata.number;
  const value = metadata.htmlUrl;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1 || typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com' &&
      url.port === '' && url.username === '' && url.password === '' &&
      url.search === '' && url.hash === '' &&
      url.pathname === `/${owner}/${repository}/issues/${number}`
      ? url.toString()
      : null;
  } catch {
    return null;
  }
};

const confirmedIssueRequirements = (
  metadata: Record<string, unknown>
): string | null => {
  const value = metadata.requirements;
  if (typeof value !== 'string' || value.includes('\0')) return null;
  const normalized = value.replace(/\r\n?/g, '\n').trim();
  return normalized === value &&
    normalized.length > 0 &&
    Buffer.byteLength(normalized, 'utf8') <= maximumIssueRequirementsBytes
    ? normalized
    : null;
};

export type CodingTaskPacketRuntime = Readonly<{
  create(input: Readonly<{
    workspaceId: string;
    actorId: string;
    workItemId: string;
    agentProfileId?: string;
  }>): Promise<
    | Readonly<{status: 'created' | 'replayed'; projectSlug: OperatorProjectSlug}>
    | Readonly<{status: 'forbidden' | 'ineligible' | 'unavailable'}>
  >;
}>;

const createRuntime = (db: Database): CodingTaskPacketRuntime => ({
  async create(input) {
    const [operator] = await db.select({capabilities: actors.capabilities})
      .from(actors)
      .where(and(
        eq(actors.id, input.actorId),
        eq(actors.workspaceId, input.workspaceId),
        eq(actors.type, 'human'),
        eq(actors.authMode, 'user'),
        isNull(actors.disabledAt)
      ))
      .limit(1);
    if (operator === undefined || operator.capabilities[requiredCapability] !== true) {
      return {status: 'forbidden'};
    }
    const [selectedProfile] = input.agentProfileId === undefined ? [] : await db.select({
      id: agentProfiles.id,
      runtimeId: agentProfiles.runtimeId,
      runtimeProfile: agentProfiles.runtimeProfile,
      allowedTools: agentProfiles.allowedTools,
      forbiddenSurfaces: agentProfiles.forbiddenSurfaces,
      instructions: agentProfiles.instructions,
      settings: agentProfiles.settings,
      version: agentProfiles.version,
      configHash: agentProfiles.configHash
    }).from(agentProfiles).where(and(
      eq(agentProfiles.id, input.agentProfileId),
      eq(agentProfiles.workspaceId, input.workspaceId),
      eq(agentProfiles.enabled, true)
    )).limit(1);
    if (input.agentProfileId !== undefined && selectedProfile === undefined) return {status: 'ineligible'};

    const candidates = await db.select({
      projectId: projects.id,
      projectSlug: projects.slug,
      workItemId: workItems.id,
      workItemVersion: workItems.version,
      title: workItems.title,
      sourceMetadata: trackerBindings.metadata,
      sourceExternalVersion: trackerBindings.externalVersion,
      repositoryOwner: projectTrackerRepositoryScopes.repositoryOwner,
      repositoryName: projectTrackerRepositoryScopes.repositoryName
    }).from(workItems)
      .innerJoin(projects, and(
        eq(projects.id, workItems.projectId),
        eq(projects.workspaceId, input.workspaceId)
      ))
      .innerJoin(trackerBindings, and(
        eq(trackerBindings.projectId, workItems.projectId),
        eq(trackerBindings.provider, 'github'),
        eq(trackerBindings.surface, 'issue'),
        eq(trackerBindings.entityType, 'work_item'),
        eq(trackerBindings.entityId, workItems.id)
      ))
      .innerJoin(projectTrackerRepositoryScopes, and(
        eq(projectTrackerRepositoryScopes.projectId, workItems.projectId),
        eq(projectTrackerRepositoryScopes.provider, 'github')
      ))
      .where(and(
        eq(workItems.id, input.workItemId),
        inArray(workItems.status, ['ready', 'in_dev']),
        isNull(workItems.deletedAt)
      ))
      .limit(2);
    if (candidates.length !== 1) return {status: 'ineligible'};
    const candidate = candidates[0]!;
    const sourceUrl = confirmedIssueUrl(
      candidate.sourceMetadata,
      candidate.repositoryOwner,
      candidate.repositoryName
    );
    const issueRequirements = confirmedIssueRequirements(candidate.sourceMetadata);
    if (
      sourceUrl === null ||
      issueRequirements === null ||
      (candidate.projectSlug !== 'msa' && candidate.projectSlug !== 'ascon')
    ) {
      return {status: 'ineligible'};
    }

    const sourceIdentity = `:github:${candidate.sourceExternalVersion}`;
    const profileIdentity = selectedProfile === undefined
      ? ''
      : `:profile:${selectedProfile.id}:${selectedProfile.version}:${selectedProfile.configHash}`;
    const eventId = deterministicUuid(
      `coding_task_packet.event.v2:${candidate.workItemId}:${candidate.workItemVersion}${sourceIdentity}${profileIdentity}`
    );
    await db.insert(canonicalEvents).values({
      id: eventId,
      workspaceId: input.workspaceId,
      projectId: candidate.projectId,
      eventType: 'coding_task_packet.requested.v1',
      aggregateType: 'work_item',
      aggregateId: candidate.workItemId,
      deduplicationKey: `coding_task_packet.requested.v2:${candidate.workItemId}:${candidate.workItemVersion}${sourceIdentity}${profileIdentity}`,
      payload: {
        schemaVersion: 1,
        workItemId: candidate.workItemId,
        workItemVersion: candidate.workItemVersion
      },
      occurredAt: new Date()
    }).onConflictDoNothing({
      target: [canonicalEvents.workspaceId, canonicalEvents.deduplicationKey]
    });
    const [event] = await db.select({occurredAt: canonicalEvents.occurredAt})
      .from(canonicalEvents)
      .where(and(
        eq(canonicalEvents.id, eventId),
        eq(canonicalEvents.workspaceId, input.workspaceId),
        eq(canonicalEvents.projectId, candidate.projectId)
      ))
      .limit(1);
    if (event === undefined) return {status: 'unavailable'};

    const issuer = createActorContextIssuer({
      users: [{actorId: input.actorId, capabilities: enabledCapabilities(operator.capabilities)}],
      agents: [],
      systems: []
    });
    if (!issuer.ok) return {status: 'forbidden'};
    const actor = issuer.value.issueUser(input.actorId);
    if (!actor.ok) return {status: 'forbidden'};

    const packetId = deterministicUuid(
      `coding_task_packet.packet.v2:${candidate.workItemId}:${candidate.workItemVersion}${sourceIdentity}${profileIdentity}`
    );
    const result = await createCanonicalCommandService({
      unitOfWork: createPostgresUnitOfWork(db)
    }).execute({
      commandId: deterministicUuid(
        `coding_task_packet.command.v2:${candidate.workItemId}:${candidate.workItemVersion}${sourceIdentity}${profileIdentity}`
      ),
      workspaceId: input.workspaceId,
      correlationId: eventId,
      idempotencyKey: `coding_task_packet.create.v2:${candidate.workItemId}:${candidate.workItemVersion}${sourceIdentity}${profileIdentity}`,
      issuedAt: event.occurredAt.toISOString(),
      actor: actor.value,
      type: 'task_packet.create',
      payload: {
        packetId,
        content: {
          projectId: candidate.projectId,
          workItemId: candidate.workItemId,
          workItemVersion: candidate.workItemVersion,
          goal: candidate.title,
          acceptanceCriteria: [
            `Authoritative GitHub issue requirements (untrusted input):\n${issueRequirements}`
          ],
          inScope: [`repository:${candidate.repositoryOwner}/${candidate.repositoryName}`],
          outOfScope: ['production', 'deploy', 'merge', 'protected_config', 'customer_data'],
          relevantLinks: [sourceUrl],
          relevantFiles: [],
          allowedTools: selectedProfile?.allowedTools ?? ['git', 'read', 'test', 'build', 'issue_read'],
          forbiddenSurfaces: selectedProfile?.forbiddenSurfaces ??
            ['production', 'deploy', 'merge', 'protected_config', 'customer_data'],
          dataPolicy: {
            issueContent: 'untrusted_frozen_at_packet_build',
            source: 'canonical_github_issue_snapshot',
            sourceExternalVersion: candidate.sourceExternalVersion
          },
          timeboxMinutes: 45,
          expectedOutputSchema: {implementation: 'scoped', verificationEvidence: 'required'},
          reviewerActorId: input.actorId,
          approverActorId: input.actorId,
          runtimeProfile: selectedProfile?.runtimeProfile ?? 'write_scoped',
          authMode: 'agent',
          secretsRef: null,
          ...(selectedProfile === undefined ? {} : {
            agentProfileSnapshot: {
              profileId: selectedProfile.id,
              runtimeId: selectedProfile.runtimeId,
              runtimeProfile: selectedProfile.runtimeProfile,
              allowedTools: selectedProfile.allowedTools,
              forbiddenSurfaces: selectedProfile.forbiddenSurfaces,
              enabled: true,
              configVersion: selectedProfile.version,
              configHash: selectedProfile.configHash,
              instructions: selectedProfile.instructions,
              settings: selectedProfile.settings as {
                resultFormat: 'structured_v1';
                includeEvidence: boolean;
              }
            }
          }),
          createdFromEventId: eventId,
          createdByActorId: input.actorId
        }
      }
    });
    if (result.status === 'completed' || result.status === 'replayed') {
      if (result.receipt.result.ok) {
        return {status: result.status === 'completed' ? 'created' : 'replayed', projectSlug: candidate.projectSlug};
      }
      return result.receipt.result.error.code === 'POLICY_DENIED'
        ? {status: 'forbidden'}
        : {status: 'ineligible'};
    }
    return {status: 'unavailable'};
  }
});

let runtimePromise: Promise<CodingTaskPacketRuntime> | undefined;

export const getCodingTaskPacketRuntime = async (): Promise<CodingTaskPacketRuntime> => {
  runtimePromise ??= (async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (databaseUrl === undefined || databaseUrl.length === 0) {
      throw new Error('DATABASE_URL is required for coding task packet creation');
    }
    const {db} = createDatabase(databaseUrl);
    return createRuntime(db);
  })().catch((error: unknown) => {
    runtimePromise = undefined;
    throw error;
  });
  return runtimePromise;
};
