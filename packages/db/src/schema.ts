import {sql} from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from 'drizzle-orm/pg-core';

const id = () => uuid('id').defaultRandom().primaryKey();
const createdAt = () =>
  timestamp('created_at', {withTimezone: true}).defaultNow().notNull();
const updatedAt = () =>
  timestamp('updated_at', {withTimezone: true}).defaultNow().notNull();

export const workItemStatusEnum = pgEnum('work_item_status', [
  'backlog',
  'ready',
  'in_dev',
  'qa',
  'acceptance',
  'done'
]);
export const actorTypeEnum = pgEnum('actor_type', ['human', 'agent', 'system']);
export const actorRoleEnum = pgEnum('actor_role', [
  'workspace_admin',
  'delivery_lead',
  'developer',
  'agent_operator'
]);
export const authModeEnum = pgEnum('auth_mode', ['user', 'agent', 'system']);
export const runStatusEnum = pgEnum('agent_run_status', [
  'queued',
  'running',
  'waiting_approval',
  'done',
  'failed'
]);
export const approvalStatusEnum = pgEnum('approval_status', [
  'pending',
  'approved',
  'rejected',
  'expired'
]);
export const accessRequestStatusEnum = pgEnum('access_request_status', [
  'pending',
  'granted',
  'rejected',
  'expired'
]);
export const policyDecisionEnum = pgEnum('policy_decision', [
  'allow',
  'ask',
  'deny'
]);
export const actionCategoryEnum = pgEnum('action_category', [
  'read',
  'write',
  'delete',
  'external_message',
  'deploy',
  'access_change',
  'critical_config',
  'customer_data_touch'
]);
export const jobStatusEnum = pgEnum('scheduled_job_status', [
  'active',
  'paused',
  'unhealthy'
]);
export const eventStatusEnum = pgEnum('event_status', [
  'pending',
  'processing',
  'processed',
  'failed',
  'dead_letter'
]);
export const riskSeverityEnum = pgEnum('risk_severity', [
  'green',
  'yellow',
  'red'
]);
export const outboxStatusEnum = pgEnum('outbox_status', [
  'pending',
  'publishing',
  'published',
  'failed'
]);
export const commandReceiptStateEnum = pgEnum('command_receipt_state', [
  'claimed',
  'completed'
]);
export const auditOutcomeEnum = pgEnum('audit_outcome', [
  'succeeded',
  'failed',
  'rejected',
  'approval_required'
]);

export const workspaces = pgTable(
  'workspaces',
  {
    id: id(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [uniqueIndex('workspaces_slug_unique').on(table.slug)]
);

export const actors = pgTable(
  'actors',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, {onDelete: 'cascade'}),
    type: actorTypeEnum('type').notNull(),
    role: actorRoleEnum('role').notNull(),
    displayName: text('display_name').notNull(),
    authMode: authModeEnum('auth_mode').notNull(),
    externalSubject: text('external_subject'),
    capabilities: jsonb('capabilities')
      .$type<Record<string, boolean>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    disabledAt: timestamp('disabled_at', {withTimezone: true}),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    uniqueIndex('actors_external_subject_unique').on(
      table.workspaceId,
      table.authMode,
      table.externalSubject
    )
  ]
);

export const projects = pgTable(
  'projects',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, {onDelete: 'cascade'}),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description'),
    defaultBranch: text('default_branch').default('main').notNull(),
    version: integer('version').default(1).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    uniqueIndex('projects_workspace_slug_unique').on(
      table.workspaceId,
      table.slug
    ),
    check('projects_version_positive', sql`${table.version} > 0`)
  ]
);

export const milestones = pgTable(
  'milestones',
  {
    id: id(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, {onDelete: 'cascade'}),
    title: text('title').notNull(),
    description: text('description'),
    targetAt: timestamp('target_at', {withTimezone: true}),
    closedAt: timestamp('closed_at', {withTimezone: true}),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [index('milestones_project_idx').on(table.projectId)]
);

export const agentProfiles = pgTable(
  'agent_profiles',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, {onDelete: 'cascade'}),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => actors.id, {onDelete: 'cascade'}),
    runtimeId: text('runtime_id').notNull(),
    runtimeProfile: text('runtime_profile').notNull(),
    allowedTools: text('allowed_tools')
      .array()
      .default(sql`'{}'::text[]`)
      .notNull(),
    forbiddenSurfaces: text('forbidden_surfaces')
      .array()
      .default(sql`'{}'::text[]`)
      .notNull(),
    enabled: boolean('enabled').default(true).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    uniqueIndex('agent_profiles_actor_runtime_unique').on(
      table.actorId,
      table.runtimeId,
      table.runtimeProfile
    )
  ]
);

export const runbooks = pgTable(
  'runbooks',
  {
    id: id(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, {onDelete: 'cascade'}),
    name: text('name').notNull(),
    version: integer('version').default(1).notNull(),
    definition: jsonb('definition')
      .$type<Record<string, unknown>>()
      .notNull(),
    active: boolean('active').default(true).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    uniqueIndex('runbooks_project_name_version_unique').on(
      table.projectId,
      table.name,
      table.version
    )
  ]
);

export const workItems = pgTable(
  'work_items',
  {
    id: id(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, {onDelete: 'cascade'}),
    milestoneId: uuid('milestone_id').references(() => milestones.id, {
      onDelete: 'set null'
    }),
    title: text('title').notNull(),
    summary: text('summary'),
    status: workItemStatusEnum('status').default('backlog').notNull(),
    blocked: boolean('blocked').default(false).notNull(),
    ownerActorId: uuid('owner_actor_id').references(() => actors.id, {
      onDelete: 'set null'
    }),
    version: integer('version').default(1).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp('deleted_at', {withTimezone: true})
  },
  (table) => [
    index('work_items_project_status_idx').on(table.projectId, table.status),
    check('work_items_version_positive', sql`${table.version} > 0`)
  ]
);

export const statusTransitions = pgTable(
  'status_transitions',
  {
    id: id(),
    workItemId: uuid('work_item_id')
      .notNull()
      .references(() => workItems.id, {onDelete: 'cascade'}),
    fromStatus: workItemStatusEnum('from_status'),
    toStatus: workItemStatusEnum('to_status').notNull(),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => actors.id, {onDelete: 'restrict'}),
    reason: text('reason'),
    idempotencyKey: text('idempotency_key').notNull(),
    createdAt: createdAt()
  },
  (table) => [
    uniqueIndex('status_transitions_idempotency_unique').on(
      table.idempotencyKey
    ),
    index('status_transitions_work_item_idx').on(
      table.workItemId,
      table.createdAt
    )
  ]
);

export const trackerBindings = pgTable(
  'tracker_bindings',
  {
    id: id(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, {onDelete: 'cascade'}),
    provider: text('provider').notNull(),
    surface: text('surface').notNull(),
    externalId: text('external_id').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    externalVersion: text('external_version'),
    lastInboundVersion: text('last_inbound_version'),
    lastOutboundMutationId: text('last_outbound_mutation_id'),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    uniqueIndex('tracker_bindings_external_unique').on(
      table.provider,
      table.surface,
      table.externalId
    ),
    uniqueIndex('tracker_bindings_entity_unique').on(
      table.provider,
      table.surface,
      table.entityType,
      table.entityId
    )
  ]
);

export const prLinks = pgTable(
  'pr_links',
  {
    id: id(),
    workItemId: uuid('work_item_id')
      .notNull()
      .references(() => workItems.id, {onDelete: 'cascade'}),
    provider: text('provider').notNull(),
    repositoryRef: text('repository_ref').notNull(),
    externalId: text('external_id').notNull(),
    url: text('url').notNull(),
    headRef: text('head_ref').notNull(),
    baseRef: text('base_ref').notNull(),
    state: text('state').notNull(),
    draft: boolean('draft').default(true).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    uniqueIndex('pr_links_provider_external_unique').on(
      table.provider,
      table.repositoryRef,
      table.externalId
    )
  ]
);

export const buildChecks = pgTable(
  'build_checks',
  {
    id: id(),
    prLinkId: uuid('pr_link_id')
      .notNull()
      .references(() => prLinks.id, {onDelete: 'cascade'}),
    provider: text('provider').notNull(),
    externalId: text('external_id').notNull(),
    name: text('name').notNull(),
    status: text('status').notNull(),
    conclusion: text('conclusion'),
    detailsUrl: text('details_url'),
    startedAt: timestamp('started_at', {withTimezone: true}),
    completedAt: timestamp('completed_at', {withTimezone: true}),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    uniqueIndex('build_checks_provider_external_unique').on(
      table.provider,
      table.externalId
    )
  ]
);

export const deployments = pgTable(
  'deployments',
  {
    id: id(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, {onDelete: 'restrict'}),
    workItemId: uuid('work_item_id').references(() => workItems.id, {
      onDelete: 'set null'
    }),
    environment: text('environment').notNull(),
    revision: text('revision').notNull(),
    status: text('status').notNull(),
    externalRef: text('external_ref'),
    approvedByActorId: uuid('approved_by_actor_id').references(
      () => actors.id,
      {onDelete: 'set null'}
    ),
    startedAt: timestamp('started_at', {withTimezone: true}),
    completedAt: timestamp('completed_at', {withTimezone: true}),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    index('deployments_project_environment_idx').on(
      table.projectId,
      table.environment
    )
  ]
);

export const scheduledJobs = pgTable(
  'scheduled_jobs',
  {
    id: id(),
    projectId: uuid('project_id').references(() => projects.id, {
      onDelete: 'cascade'
    }),
    name: text('name').notNull(),
    cron: text('cron').notNull(),
    queueName: text('queue_name').notNull(),
    status: jobStatusEnum('status').default('active').notNull(),
    nextRunAt: timestamp('next_run_at', {withTimezone: true}),
    lastRunAt: timestamp('last_run_at', {withTimezone: true}),
    lastSuccessAt: timestamp('last_success_at', {withTimezone: true}),
    retryCount: integer('retry_count').default(0).notNull(),
    heartbeatAt: timestamp('heartbeat_at', {withTimezone: true}),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    uniqueIndex('scheduled_jobs_project_name_unique').on(
      table.projectId,
      table.name
    )
  ]
);

export const incomingEvents = pgTable(
  'incoming_events',
  {
    id: id(),
    projectId: uuid('project_id')
      .references(() => projects.id, {onDelete: 'restrict'}),
    provider: text('provider').notNull(),
    deliveryId: text('delivery_id').notNull(),
    eventType: text('event_type').notNull(),
    action: text('action'),
    installationId: text('installation_id'),
    repositoryId: text('repository_id'),
    projectNodeId: text('project_node_id'),
    payloadSha256: text('payload_sha256'),
    verification: jsonb('verification')
      .$type<
        | {outcome: 'unverified'; method: 'none'}
        | {
            outcome: 'verified' | 'rejected';
            method: 'hmac-sha256' | 'signature-sha256' | 'shared-token';
          }
      >()
      .notNull(),
    sanitizedPayload: jsonb('sanitized_payload')
      .$type<Record<string, unknown>>()
      .notNull(),
    status: eventStatusEnum('status').default('pending').notNull(),
    attemptCount: integer('attempt_count').default(0).notNull(),
    processingToken: uuid('processing_token'),
    processingLeaseExpiresAt: timestamp('processing_lease_expires_at', {
      withTimezone: true
    }),
    receivedAt: timestamp('received_at', {withTimezone: true})
      .defaultNow()
      .notNull(),
    processedAt: timestamp('processed_at', {withTimezone: true}),
    failureCode: text('failure_code')
  },
  (table) => [
    uniqueIndex('incoming_events_delivery_unique').on(
      table.provider,
      table.deliveryId
    ),
    index('incoming_events_status_received_idx').on(
      table.status,
      table.receivedAt
    ),
    index('incoming_events_processing_lease_idx').on(
      table.status,
      table.processingLeaseExpiresAt
    ).where(sql`${table.status} = 'processing'`),
    check(
      'incoming_events_processing_claim_valid',
      sql`(
        ${table.status} = 'processing'
        and ${table.processingToken} is not null
        and ${table.processingLeaseExpiresAt} is not null
      ) or (
        ${table.status} <> 'processing'
        and ${table.processingToken} is null
        and ${table.processingLeaseExpiresAt} is null
      )`
    ),
    index('incoming_events_project_received_idx').on(
      table.projectId,
      table.receivedAt
    ),
    check(
      'incoming_events_verification_envelope_valid',
      sql`${table.verification} in (
        '{"outcome":"unverified","method":"none"}'::jsonb,
        '{"outcome":"verified","method":"hmac-sha256"}'::jsonb,
        '{"outcome":"verified","method":"signature-sha256"}'::jsonb,
        '{"outcome":"verified","method":"shared-token"}'::jsonb,
        '{"outcome":"rejected","method":"hmac-sha256"}'::jsonb,
        '{"outcome":"rejected","method":"signature-sha256"}'::jsonb,
        '{"outcome":"rejected","method":"shared-token"}'::jsonb
      )`
    ),
    check(
      'incoming_events_sanitized_payload_object',
      sql`jsonb_typeof(${table.sanitizedPayload}) = 'object'`
    ),
    check(
      'incoming_events_payload_sha256_valid',
      sql`(
        (
          ${table.provider} like 'legacy-%'
          and ${table.projectId} is null
          and ${table.payloadSha256} is null
        )
        or
        (
          ${table.provider} not like 'legacy-%'
          and ${table.projectId} is not null
          and coalesce(${table.payloadSha256} ~ '^[0-9a-f]{64}$', false)
        )
      )`
    ),
    check(
      'incoming_events_github_verified_source',
      sql`${table.provider} <> 'github' or (
        ${table.verification} = '{"outcome":"verified","method":"hmac-sha256"}'::jsonb
        and ${table.installationId} ~ '^[1-9][0-9]{0,19}$'
        and ${table.repositoryId} ~ '^[1-9][0-9]{0,19}$'
        and ${table.projectNodeId} is not null
        and length(${table.projectNodeId}) between 1 and 128
      )`
    )
  ]
);

export const canonicalEvents = pgTable(
  'canonical_events',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, {onDelete: 'cascade'}),
    projectId: uuid('project_id').references(() => projects.id, {
      onDelete: 'cascade'
    }),
    incomingEventId: uuid('incoming_event_id').references(
      () => incomingEvents.id,
      {onDelete: 'set null'}
    ),
    eventType: text('event_type').notNull(),
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: uuid('aggregate_id'),
    deduplicationKey: text('deduplication_key').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    occurredAt: timestamp('occurred_at', {withTimezone: true}).notNull(),
    createdAt: createdAt()
  },
  (table) => [
    uniqueIndex('canonical_events_deduplication_unique').on(
      table.workspaceId,
      table.deduplicationKey
    ),
    uniqueIndex('canonical_events_incoming_event_unique')
      .on(table.incomingEventId)
      .where(sql`${table.incomingEventId} is not null`),
    index('canonical_events_aggregate_idx').on(
      table.aggregateType,
      table.aggregateId,
      table.createdAt
    )
  ]
);

export const secretRefs = pgTable(
  'secret_refs',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, {onDelete: 'cascade'}),
    provider: text('provider').notNull(),
    reference: text('reference').notNull(),
    scope: text('scope').array().default(sql`'{}'::text[]`).notNull(),
    leaseMetadata: jsonb('lease_metadata')
      .$type<Record<string, string | number | boolean>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    lastRotatedAt: timestamp('last_rotated_at', {withTimezone: true}),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    uniqueIndex('secret_refs_workspace_reference_unique').on(
      table.workspaceId,
      table.provider,
      table.reference
    )
  ]
);

export const taskPackets = pgTable(
  'task_packets',
  {
    id: id(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, {onDelete: 'restrict'}),
    workItemId: uuid('work_item_id')
      .notNull()
      .references(() => workItems.id, {onDelete: 'restrict'}),
    goal: text('goal').notNull(),
    acceptanceCriteria: text('acceptance_criteria')
      .array()
      .default(sql`'{}'::text[]`)
      .notNull(),
    inScope: text('in_scope').array().default(sql`'{}'::text[]`).notNull(),
    outOfScope: text('out_of_scope')
      .array()
      .default(sql`'{}'::text[]`)
      .notNull(),
    relevantLinks: text('relevant_links')
      .array()
      .default(sql`'{}'::text[]`)
      .notNull(),
    relevantFiles: text('relevant_files')
      .array()
      .default(sql`'{}'::text[]`)
      .notNull(),
    allowedTools: text('allowed_tools')
      .array()
      .default(sql`'{}'::text[]`)
      .notNull(),
    forbiddenSurfaces: text('forbidden_surfaces')
      .array()
      .default(sql`'{}'::text[]`)
      .notNull(),
    dataPolicy: jsonb('data_policy')
      .$type<Record<string, unknown>>()
      .notNull(),
    timeboxMinutes: integer('timebox_minutes').notNull(),
    expectedOutputSchema: jsonb('expected_output_schema')
      .$type<Record<string, unknown>>()
      .notNull(),
    reviewerActorId: uuid('reviewer_actor_id')
      .notNull()
      .references(() => actors.id, {onDelete: 'restrict'}),
    approverActorId: uuid('approver_actor_id')
      .notNull()
      .references(() => actors.id, {onDelete: 'restrict'}),
    runtimeProfile: text('runtime_profile').notNull(),
    authMode: authModeEnum('auth_mode').notNull(),
    secretRefId: uuid('secret_ref_id').references(() => secretRefs.id, {
      onDelete: 'restrict'
    }),
    createdFromEventId: uuid('created_from_event_id')
      .notNull()
      .references(() => canonicalEvents.id, {onDelete: 'restrict'}),
    contentHash: text('content_hash').notNull(),
    createdByActorId: uuid('created_by_actor_id')
      .notNull()
      .references(() => actors.id, {onDelete: 'restrict'}),
    createdAt: createdAt()
  },
  (table) => [
    uniqueIndex('task_packets_content_hash_unique').on(
      table.workItemId,
      table.contentHash
    ),
    check('task_packets_timebox_positive', sql`${table.timeboxMinutes} > 0`)
  ]
);

export const agentRuns = pgTable(
  'agent_runs',
  {
    id: id(),
    taskPacketId: uuid('task_packet_id')
      .notNull()
      .references(() => taskPackets.id, {onDelete: 'restrict'}),
    agentProfileId: uuid('agent_profile_id')
      .notNull()
      .references(() => agentProfiles.id, {onDelete: 'restrict'}),
    status: runStatusEnum('status').default('queued').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    queueJobId: text('queue_job_id'),
    worktreePath: text('worktree_path'),
    branchName: text('branch_name'),
    artifactRoot: text('artifact_root'),
    heartbeatAt: timestamp('heartbeat_at', {withTimezone: true}),
    startedAt: timestamp('started_at', {withTimezone: true}),
    completedAt: timestamp('completed_at', {withTimezone: true}),
    failureCode: text('failure_code'),
    version: integer('version').default(1).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    uniqueIndex('agent_runs_idempotency_unique').on(table.idempotencyKey),
    index('agent_runs_status_heartbeat_idx').on(
      table.status,
      table.heartbeatAt
    ),
    check('agent_runs_version_positive', sql`${table.version} > 0`)
  ]
);

export const approvalRequests = pgTable(
  'approval_requests',
  {
    id: id(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, {onDelete: 'restrict'}),
    workItemId: uuid('work_item_id').references(() => workItems.id, {
      onDelete: 'restrict'
    }),
    agentRunId: uuid('agent_run_id').references(() => agentRuns.id, {
      onDelete: 'restrict'
    }),
    actionCategory: actionCategoryEnum('action_category').notNull(),
    surface: text('surface').notNull(),
    environment: text('environment').notNull(),
    status: approvalStatusEnum('status').default('pending').notNull(),
    requestedByActorId: uuid('requested_by_actor_id')
      .notNull()
      .references(() => actors.id, {onDelete: 'restrict'}),
    decidedByActorId: uuid('decided_by_actor_id').references(
      () => actors.id,
      {onDelete: 'restrict'}
    ),
    decisionReason: text('decision_reason'),
    expiresAt: timestamp('expires_at', {withTimezone: true}),
    decidedAt: timestamp('decided_at', {withTimezone: true}),
    version: integer('version').default(1).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    index('approval_requests_status_expiry_idx').on(
      table.status,
      table.expiresAt
    ),
    check(
      'approval_requests_exactly_one_target',
      sql`(${table.workItemId} is null) <> (${table.agentRunId} is null)`
    ),
    check('approval_requests_version_positive', sql`${table.version} > 0`)
  ]
);

export const accessRequests = pgTable(
  'access_requests',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, {onDelete: 'restrict'}),
    requesterActorId: uuid('requester_actor_id')
      .notNull()
      .references(() => actors.id, {onDelete: 'restrict'}),
    targetSurface: text('target_surface').notNull(),
    requestedScope: text('requested_scope')
      .array()
      .default(sql`'{}'::text[]`)
      .notNull(),
    status: accessRequestStatusEnum('status').default('pending').notNull(),
    decidedByActorId: uuid('decided_by_actor_id').references(
      () => actors.id,
      {onDelete: 'restrict'}
    ),
    expiresAt: timestamp('expires_at', {withTimezone: true}),
    decidedAt: timestamp('decided_at', {withTimezone: true}),
    version: integer('version').default(1).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    index('access_requests_status_expiry_idx').on(
      table.status,
      table.expiresAt
    ),
    check('access_requests_version_positive', sql`${table.version} > 0`)
  ]
);

export const artifacts = pgTable(
  'artifacts',
  {
    id: id(),
    agentRunId: uuid('agent_run_id')
      .notNull()
      .references(() => agentRuns.id, {onDelete: 'restrict'}),
    kind: text('kind').notNull(),
    storageProvider: text('storage_provider').notNull(),
    storageKey: text('storage_key').notNull(),
    contentType: text('content_type').notNull(),
    sha256: text('sha256').notNull(),
    sizeBytes: bigint('size_bytes', {mode: 'number'}).notNull(),
    redacted: boolean('redacted').default(false).notNull(),
    retentionUntil: timestamp('retention_until', {withTimezone: true}),
    createdAt: createdAt()
  },
  (table) => [
    uniqueIndex('artifacts_provider_key_unique').on(
      table.storageProvider,
      table.storageKey
    ),
    check('artifacts_size_non_negative', sql`${table.sizeBytes} >= 0`)
  ]
);

export const riskSignals = pgTable(
  'risk_signals',
  {
    id: id(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, {onDelete: 'cascade'}),
    workItemId: uuid('work_item_id').references(() => workItems.id, {
      onDelete: 'cascade'
    }),
    agentRunId: uuid('agent_run_id').references(() => agentRuns.id, {
      onDelete: 'cascade'
    }),
    code: text('code').notNull(),
    severity: riskSeverityEnum('severity').notNull(),
    summary: text('summary').notNull(),
    details: jsonb('details')
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    resolvedAt: timestamp('resolved_at', {withTimezone: true}),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    index('risk_signals_project_severity_idx').on(
      table.projectId,
      table.severity,
      table.resolvedAt
    )
  ]
);

export const auditEvents = pgTable(
  'audit_events',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, {onDelete: 'restrict'}),
    projectId: uuid('project_id').references(() => projects.id, {
      onDelete: 'restrict'
    }),
    actorId: uuid('actor_id').references(() => actors.id, {
      onDelete: 'restrict'
    }),
    commandId: text('command_id').notNull(),
    actionCategory: actionCategoryEnum('action_category').notNull(),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id'),
    policyDecision: policyDecisionEnum('policy_decision'),
    outcome: auditOutcomeEnum('outcome'),
    reasonCode: text('reason_code'),
    expectedVersion: integer('expected_version'),
    resultVersion: integer('result_version'),
    correlationId: text('correlation_id').notNull(),
    occurredAt: timestamp('occurred_at', {withTimezone: true}).notNull(),
    metadata: jsonb('metadata').$type<Record<string, never>>().default(sql`'{}'::jsonb`).notNull(),
    createdAt: createdAt()
  },
  (table) => [
    uniqueIndex('audit_events_workspace_command_unique').on(
      table.workspaceId,
      table.commandId
    ),
    index('audit_events_workspace_created_idx').on(
      table.workspaceId,
      table.createdAt
    ),
    index('audit_events_correlation_idx').on(table.correlationId)
  ]
);

export const dashboardSnapshots = pgTable(
  'dashboard_snapshots',
  {
    id: id(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, {onDelete: 'cascade'}),
    capturedAt: timestamp('captured_at', {withTimezone: true})
      .defaultNow()
      .notNull(),
    health: riskSeverityEnum('health').notNull(),
    metrics: jsonb('metrics').$type<Record<string, number>>().notNull(),
    sourceEventId: uuid('source_event_id').references(
      () => canonicalEvents.id,
      {onDelete: 'set null'}
    )
  },
  (table) => [
    uniqueIndex('dashboard_snapshots_project_captured_unique').on(
      table.projectId,
      table.capturedAt
    )
  ]
);

export const commandReceipts = pgTable(
  'command_receipts',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, {onDelete: 'cascade'}),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    commandId: text('command_id').notNull(),
    correlationId: text('correlation_id').notNull(),
    state: commandReceiptStateEnum('state').default('claimed').notNull(),
    commandType: text('command_type').notNull(),
    aggregateType: text('aggregate_type'),
    aggregateId: uuid('aggregate_id'),
    expectedVersion: integer('expected_version'),
    resultVersion: integer('result_version'),
    result: jsonb('result').$type<Record<string, unknown>>(),
    createdAt: createdAt(),
    completedAt: timestamp('completed_at', {withTimezone: true})
  },
  (table) => [
    uniqueIndex('command_receipts_workspace_key_unique').on(
      table.workspaceId,
      table.idempotencyKey
    ),
    check(
      'command_receipts_completion_consistent',
      sql`(${table.state} = 'claimed' and ${table.result} is null and ${table.completedAt} is null)
        or (${table.state} = 'completed' and ${table.result} is not null and ${table.completedAt} is not null)`
    )
  ]
);

export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, {onDelete: 'cascade'}),
    projectId: uuid('project_id').references(() => projects.id, {
      onDelete: 'cascade'
    }),
    destination: text('destination').notNull(),
    eventType: text('event_type').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    status: outboxStatusEnum('status').default('pending').notNull(),
    attemptCount: integer('attempt_count').default(0).notNull(),
    availableAt: timestamp('available_at', {withTimezone: true})
      .defaultNow()
      .notNull(),
    publishedAt: timestamp('published_at', {withTimezone: true}),
    failureCode: text('failure_code'),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    uniqueIndex('outbox_events_idempotency_unique').on(
      table.destination,
      table.idempotencyKey
    ),
    index('outbox_events_status_available_idx').on(
      table.status,
      table.availableAt
    )
  ]
);
