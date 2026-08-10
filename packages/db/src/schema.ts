import {sql} from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from 'drizzle-orm/pg-core';
import type {AnyPgColumn} from 'drizzle-orm/pg-core';

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
export const projectMembershipRoleEnum = pgEnum('project_membership_role', [
  'workspace_owner',
  'project_owner',
  'contributor',
  'reviewer',
  'client_viewer',
  'agent'
]);
export const accessResourceTypeEnum = pgEnum('access_resource_type', [
  'repository',
  'tracker',
  'internal_chat',
  'client_chat',
  'environment',
  'control_plane_action'
]);
export const accessLevelEnum = pgEnum('access_level', [
  'none',
  'read',
  'write',
  'admin'
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
export const riskSignalClassEnum = pgEnum('risk_signal_class', [
  'fact',
  'inference'
]);
export const riskSignalDispositionKindEnum = pgEnum(
  'risk_signal_disposition_kind',
  ['acknowledged', 'snoozed']
);
export const notificationAudienceKindEnum = pgEnum(
  'notification_audience_kind',
  ['actor', 'project_operators']
);
export const notificationDeliveryStatusEnum = pgEnum(
  'notification_delivery_status',
  ['accepted', 'delivered', 'failed']
);
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
export const trackerStatusObservationStateEnum = pgEnum(
  'tracker_status_observation_state',
  ['pending', 'processing', 'applied', 'acknowledged', 'conflict']
);
export const auditOutcomeEnum = pgEnum('audit_outcome', [
  'succeeded',
  'failed',
  'rejected',
  'approval_required'
]);
export const conversationClassEnum = pgEnum('conversation_class', [
  'internal',
  'client'
]);
export const conversationChannelStateEnum = pgEnum('conversation_channel_state', [
  'active',
  'inactive',
  'not_used'
]);
export const runtimeAvailabilityComponentEnum = pgEnum(
  'runtime_availability_component',
  ['service', 'scheduler', 'delivery']
);
export const runtimeAvailabilityStateEnum = pgEnum(
  'runtime_availability_state',
  ['available', 'unavailable']
);

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
    uniqueIndex('actors_workspace_id_unique').on(table.workspaceId, table.id),
    uniqueIndex('actors_external_subject_unique').on(
      table.workspaceId,
      table.authMode,
      table.externalSubject
    )
  ]
);

export const oauthLoginAttempts = pgTable(
  'oauth_login_attempts',
  {
    stateHash: text('state_hash').primaryKey(),
    createdAt: createdAt(),
    expiresAt: timestamp('expires_at', {withTimezone: true}).notNull(),
    consumedAt: timestamp('consumed_at', {withTimezone: true})
  },
  (table) => [
    index('oauth_login_attempts_expires_idx').on(table.expiresAt),
    check(
      'oauth_login_attempts_state_hash_sha256',
      sql`${table.stateHash} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      'oauth_login_attempts_expiry_after_creation',
      sql`${table.expiresAt} > ${table.createdAt}`
    )
  ]
);

export const operatorSessions = pgTable(
  'operator_sessions',
  {
    tokenHash: text('token_hash').primaryKey(),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => actors.id, {onDelete: 'cascade'}),
    githubUserId: bigint('github_user_id', {mode: 'number'}).notNull(),
    createdAt: createdAt(),
    expiresAt: timestamp('expires_at', {withTimezone: true}).notNull(),
    revokedAt: timestamp('revoked_at', {withTimezone: true}),
    lastSeenAt: timestamp('last_seen_at', {withTimezone: true}).notNull()
  },
  (table) => [
    index('operator_sessions_actor_idx').on(table.actorId),
    index('operator_sessions_expires_idx').on(table.expiresAt),
    check(
      'operator_sessions_token_hash_sha256',
      sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`
    ),
    check('operator_sessions_github_user_id_positive', sql`${table.githubUserId} > 0`),
    check(
      'operator_sessions_expiry_after_creation',
      sql`${table.expiresAt} > ${table.createdAt}`
    ),
    check(
      'operator_sessions_last_seen_after_creation',
      sql`${table.lastSeenAt} >= ${table.createdAt}`
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
    uniqueIndex('projects_workspace_id_unique').on(table.workspaceId, table.id),
    uniqueIndex('projects_workspace_slug_unique').on(
      table.workspaceId,
      table.slug
    ),
    check('projects_version_positive', sql`${table.version} > 0`)
  ]
);

export const projectMemberships = pgTable(
  'project_memberships',
  {
    id: id(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, {onDelete: 'restrict'}),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => actors.id, {onDelete: 'restrict'}),
    role: projectMembershipRoleEnum('role').notNull(),
    active: boolean('active').default(true).notNull(),
    version: integer('version').default(1).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    uniqueIndex('project_memberships_project_actor_unique').on(
      table.projectId,
      table.actorId
    ),
    index('project_memberships_actor_idx').on(table.actorId),
    check('project_memberships_version_positive', sql`${table.version} > 0`)
  ]
);

export type ProjectSetupConfiguration = Readonly<{
  repositoryBinding: 'none' | 'link_existing' | 'create_managed';
  trackerBinding: 'none' | 'link_existing' | 'create_managed';
  internalChat: 'none' | 'link_existing' | 'create_managed';
  clientChat: 'none' | 'link_existing' | 'create_managed';
  executionMode: 'manual' | 'managed_agent';
  agentProfileId: string | null;
}>;

export const projectSetups = pgTable(
  'project_setups',
  {
    id: id(),
    projectId: uuid('project_id').notNull().references(() => projects.id, {onDelete: 'restrict'}),
    state: text('state').default('pending').notNull(),
    configuration: jsonb('configuration').$type<ProjectSetupConfiguration>().notNull(),
    lastErrorCode: text('last_error_code'),
    version: integer('version').default(1).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    uniqueIndex('project_setups_project_unique').on(table.projectId),
    check('project_setups_state_valid', sql`${table.state} in ('pending', 'in_progress', 'blocked')`),
    check('project_setups_version_positive', sql`${table.version} > 0`),
    check('project_setups_error_code_valid', sql`${table.lastErrorCode} is null or ${table.lastErrorCode} ~ '^[a-z][a-z0-9_]{0,63}$'`)
  ]
);

export const projectSourceArtifacts = pgTable(
  'project_source_artifacts',
  {
    id: id(),
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id').notNull(),
    name: text('name').notNull(),
    sourceKind: text('source_kind').default('other').notNull(),
    mediaType: text('media_type').notNull(),
    content: text('content').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: text('sha256').notNull(),
    sourceFile: jsonb('source_file').$type<import('@fai-control-plane/domain').SourceFileProvenance>(),
    provenance: jsonb('provenance').$type<Readonly<{
      kind: 'manager_note' | 'manager_upload';
      label: string;
      capturedAt: string;
    }>>().notNull(),
    createdByActorId: uuid('created_by_actor_id').notNull(),
    version: integer('version').default(1).notNull(),
    createdAt: createdAt()
  },
  (table) => [
    foreignKey({
      columns: [table.workspaceId, table.projectId],
      foreignColumns: [projects.workspaceId, projects.id],
      name: 'project_source_artifacts_workspace_project_fk'
    }).onDelete('restrict'),
    foreignKey({columns: [table.workspaceId, table.createdByActorId], foreignColumns: [actors.workspaceId, actors.id], name: 'project_source_artifacts_workspace_actor_fk'}).onDelete('restrict'),
    index('project_source_artifacts_project_created_idx').on(table.projectId, table.createdAt),
    check('project_source_artifacts_source_kind', sql`${table.sourceKind} in ('project_passport', 'client_requirements', 'contract_scope', 'acceptance_method', 'architecture_constraints', 'other')`),
    check('project_source_artifacts_media_type', sql`${table.mediaType} in ('text/plain', 'text/markdown', 'application/json')`),
    check('project_source_artifacts_content_bounded', sql`octet_length(${table.content}) between 1 and 262144 and ${table.sizeBytes} = octet_length(${table.content})`),
    check('project_source_artifacts_sha256', sql`${table.sha256} ~ '^[0-9a-f]{64}$'`),
    check('project_source_artifacts_source_file_object', sql`${table.sourceFile} is null or jsonb_typeof(${table.sourceFile}) = 'object'`),
    check('project_source_artifacts_provenance_object', sql`jsonb_typeof(${table.provenance}) = 'object'`),
    check('project_source_artifacts_version_one', sql`${table.version} = 1`)
  ]
);

export const projectPlanDrafts = pgTable(
  'project_plan_drafts',
  {
    id: id(),
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id').notNull(),
    state: text('state').default('draft').notNull(),
    definition: jsonb('definition').$type<import('@fai-control-plane/domain').ProjectPlanDefinition>().notNull(),
    contentHash: text('content_hash').notNull(),
    revision: integer('revision').default(1).notNull(),
    createdByActorId: uuid('created_by_actor_id').notNull(),
    approvedByActorId: uuid('approved_by_actor_id'),
    approvedAt: timestamp('approved_at', {withTimezone: true}),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    foreignKey({columns: [table.workspaceId, table.projectId], foreignColumns: [projects.workspaceId, projects.id], name: 'project_plan_drafts_workspace_project_fk'}).onDelete('restrict'),
    foreignKey({columns: [table.workspaceId, table.createdByActorId], foreignColumns: [actors.workspaceId, actors.id], name: 'project_plan_drafts_workspace_created_actor_fk'}).onDelete('restrict'),
    foreignKey({columns: [table.workspaceId, table.approvedByActorId], foreignColumns: [actors.workspaceId, actors.id], name: 'project_plan_drafts_workspace_approved_actor_fk'}).onDelete('restrict'),
    uniqueIndex('project_plan_drafts_identity_scope_unique').on(table.id, table.workspaceId, table.projectId),
    uniqueIndex('project_plan_drafts_project_active_unique').on(table.projectId).where(sql`${table.state} = 'draft'`),
    index('project_plan_drafts_project_updated_idx').on(table.projectId, table.updatedAt),
    check('project_plan_drafts_state', sql`${table.state} in ('draft', 'approved')`),
    check('project_plan_drafts_revision_positive', sql`${table.revision} > 0`),
    check('project_plan_drafts_hash', sql`${table.contentHash} ~ '^[0-9a-f]{64}$'`),
    check('project_plan_drafts_definition_object', sql`jsonb_typeof(${table.definition}) = 'object'`),
    check('project_plan_drafts_approval_shape', sql`(${table.state} = 'draft' and ${table.approvedByActorId} is null and ${table.approvedAt} is null) or (${table.state} = 'approved' and ${table.approvedByActorId} is not null and ${table.approvedAt} is not null)`)
  ]
);

export const projectPlanVersions = pgTable(
  'project_plan_versions',
  {
    id: id(),
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id').notNull(),
    planId: uuid('plan_id').notNull(),
    version: integer('version').notNull(),
    sourceRevision: integer('source_revision').notNull(),
    definition: jsonb('definition').$type<import('@fai-control-plane/domain').ProjectPlanDefinition>().notNull(),
    contentHash: text('content_hash').notNull(),
    sourceManifest: jsonb('source_manifest').$type<readonly Readonly<{artifactId: string; version: number; sha256: string}>[]>().notNull(),
    simulation: jsonb('simulation').$type<import('@fai-control-plane/domain').ProjectPlanSimulation>().notNull(),
    approvedByActorId: uuid('approved_by_actor_id').notNull(),
    approvedAt: timestamp('approved_at', {withTimezone: true}).notNull(),
    createdAt: createdAt()
  },
  (table) => [
    foreignKey({columns: [table.workspaceId, table.projectId], foreignColumns: [projects.workspaceId, projects.id], name: 'project_plan_versions_workspace_project_fk'}).onDelete('restrict'),
    foreignKey({columns: [table.planId, table.workspaceId, table.projectId], foreignColumns: [projectPlanDrafts.id, projectPlanDrafts.workspaceId, projectPlanDrafts.projectId], name: 'project_plan_versions_plan_scope_fk'}).onDelete('restrict'),
    foreignKey({columns: [table.workspaceId, table.approvedByActorId], foreignColumns: [actors.workspaceId, actors.id], name: 'project_plan_versions_workspace_actor_fk'}).onDelete('restrict'),
    uniqueIndex('project_plan_versions_identity_scope_version_unique').on(table.id, table.workspaceId, table.projectId, table.version),
    uniqueIndex('project_plan_versions_identity_scope_unique').on(table.id, table.workspaceId, table.projectId),
    uniqueIndex('project_plan_versions_project_identity_unique').on(table.projectId, table.id),
    uniqueIndex('project_plan_versions_identity_project_unique').on(table.id, table.projectId),
    uniqueIndex('project_plan_versions_project_version_unique').on(table.projectId, table.version),
    uniqueIndex('project_plan_versions_plan_unique').on(table.planId),
    index('project_plan_versions_project_created_idx').on(table.projectId, table.createdAt),
    check('project_plan_versions_positive', sql`${table.version} > 0 and ${table.sourceRevision} > 0`),
    check('project_plan_versions_hash', sql`${table.contentHash} ~ '^[0-9a-f]{64}$'`),
    check('project_plan_versions_definition_object', sql`jsonb_typeof(${table.definition}) = 'object'`),
    check('project_plan_versions_source_manifest_array', sql`jsonb_typeof(${table.sourceManifest}) = 'array'`),
    check('project_plan_versions_simulation_object', sql`jsonb_typeof(${table.simulation}) = 'object'`)
  ]
);

export const actorExternalIdentities = pgTable(
  'actor_external_identities',
  {
    id: id(),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => actors.id, {onDelete: 'restrict'}),
    provider: text('provider').notNull(),
    externalSubject: text('external_subject').notNull(),
    active: boolean('active').default(true).notNull(),
    version: integer('version').default(1).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    uniqueIndex('actor_external_identities_provider_subject_unique').on(
      table.provider,
      table.externalSubject
    ),
    uniqueIndex('actor_external_identities_actor_provider_unique').on(
      table.actorId,
      table.provider
    ),
    check(
      'actor_external_identities_provider_key',
      sql`${table.provider} ~ '^[a-z][a-z0-9_-]{0,63}$'`
    ),
    check('actor_external_identities_version_positive', sql`${table.version} > 0`)
  ]
);

export type ConversationAttachmentMetadata = Readonly<{
  kind: 'document' | 'photo' | 'video' | 'audio' | 'voice' | 'sticker' | 'animation';
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
}>;

export const conversationChannelConfigurations = pgTable(
  'conversation_channel_configurations',
  {
    id: id(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, {onDelete: 'restrict'}),
    conversationClass: conversationClassEnum('conversation_class').notNull(),
    desiredState: conversationChannelStateEnum('desired_state').notNull(),
    provider: text('provider'),
    configurationRef: text('configuration_ref'),
    version: integer('version').default(1).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    uniqueIndex('conversation_channel_configurations_project_class_unique').on(
      table.projectId,
      table.conversationClass
    ),
    check(
      'conversation_channel_configurations_binding_complete',
      sql`(${table.desiredState} = 'not_used' and ${table.provider} is null and ${table.configurationRef} is null)
        or (${table.desiredState} in ('active', 'inactive')
          and ${table.provider} ~ '^[a-z][a-z0-9_-]{0,63}$'
          and ${table.configurationRef} ~ '^[a-z][a-z0-9._:-]{0,127}$')`
    ),
    check('conversation_channel_configurations_version_positive', sql`${table.version} > 0`)
  ]
);

export const conversationBindings = pgTable(
  'conversation_bindings',
  {
    id: id(),
    configurationId: uuid('configuration_id')
      .references(() => conversationChannelConfigurations.id, {onDelete: 'restrict'}),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, {onDelete: 'restrict'}),
    conversationClass: conversationClassEnum('conversation_class').notNull(),
    provider: text('provider').notNull(),
    externalRef: text('external_ref').notNull(),
    activatedAt: timestamp('activated_at', {withTimezone: true}).notNull(),
    active: boolean('active').default(true).notNull(),
    lastObservedAt: timestamp('last_observed_at', {withTimezone: true}),
    lastFailureAt: timestamp('last_failure_at', {withTimezone: true}),
    lastFailureCode: text('last_failure_code'),
    failureCount: integer('failure_count').default(0).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    uniqueIndex('conversation_bindings_project_class_unique').on(
      table.projectId,
      table.conversationClass
    ).where(sql`${table.active} = true`),
    uniqueIndex('conversation_bindings_provider_external_unique').on(
      table.provider,
      table.externalRef
    ),
    uniqueIndex('conversation_bindings_configuration_unique').on(table.configurationId)
      .where(sql`${table.configurationId} is not null`),
    check(
      'conversation_bindings_provider_key',
      sql`${table.provider} ~ '^[a-z][a-z0-9_-]{0,63}$'`
    ),
    check(
      'conversation_bindings_external_ref_bounded',
      sql`length(${table.externalRef}) between 1 and 128`
    ),
    check(
      'conversation_bindings_failure_complete',
      sql`(${table.lastFailureAt} is null and ${table.lastFailureCode} is null)
        or (${table.lastFailureAt} is not null
          and length(${table.lastFailureCode}) between 1 and 64)`
    ),
    check('conversation_bindings_failure_count_nonnegative', sql`${table.failureCount} >= 0`)
  ]
);

export const conversationParticipants = pgTable(
  'conversation_participants',
  {
    id: id(),
    bindingId: uuid('binding_id')
      .notNull()
      .references(() => conversationBindings.id, {onDelete: 'cascade'}),
    externalSubject: text('external_subject').notNull(),
    actorId: uuid('actor_id').references(() => actors.id, {onDelete: 'restrict'}),
    displayName: text('display_name').notNull(),
    observedLevel: accessLevelEnum('observed_level'),
    observedAt: timestamp('observed_at', {withTimezone: true}),
    lastObservationRef: text('last_observation_ref'),
    firstObservedAt: timestamp('first_observed_at', {withTimezone: true}).notNull(),
    lastObservedAt: timestamp('last_observed_at', {withTimezone: true}).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    uniqueIndex('conversation_participants_binding_subject_unique').on(
      table.bindingId,
      table.externalSubject
    ),
    index('conversation_participants_actor_idx').on(table.actorId),
    check(
      'conversation_participants_subject_bounded',
      sql`length(${table.externalSubject}) between 1 and 128`
    ),
    check(
      'conversation_participants_display_name_bounded',
      sql`length(${table.displayName}) between 1 and 120`
    ),
    check(
      'conversation_participants_observation_order',
      sql`${table.lastObservedAt} >= ${table.firstObservedAt}`
    ),
    check(
      'conversation_participants_access_observation_complete',
      sql`(${table.observedLevel} is null and ${table.observedAt} is null and ${table.lastObservationRef} is null)
        or (${table.observedLevel} is not null and ${table.observedAt} is not null
          and length(${table.lastObservationRef}) between 1 and 128)`
    )
  ]
);

export const conversationMessages = pgTable(
  'conversation_messages',
  {
    id: id(),
    bindingId: uuid('binding_id')
      .notNull()
      .references(() => conversationBindings.id, {onDelete: 'cascade'}),
    participantId: uuid('participant_id')
      .notNull()
      .references(() => conversationParticipants.id, {onDelete: 'restrict'}),
    deliveryRef: text('delivery_ref').notNull(),
    messageRef: text('message_ref').notNull(),
    replyToMessageRef: text('reply_to_message_ref'),
    threadRef: text('thread_ref'),
    sentAt: timestamp('sent_at', {withTimezone: true}).notNull(),
    text: text('text'),
    attachments: jsonb('attachments')
      .$type<readonly ConversationAttachmentMetadata[]>()
      .default(sql`'[]'::jsonb`)
      .notNull(),
    observedAt: timestamp('observed_at', {withTimezone: true}).defaultNow().notNull()
  },
  (table) => [
    uniqueIndex('conversation_messages_binding_delivery_unique').on(
      table.bindingId,
      table.deliveryRef
    ),
    uniqueIndex('conversation_messages_binding_message_unique').on(
      table.bindingId,
      table.messageRef
    ),
    index('conversation_messages_binding_sent_idx').on(table.bindingId, table.sentAt),
    check('conversation_messages_delivery_ref_bounded', sql`length(${table.deliveryRef}) between 1 and 128`),
    check('conversation_messages_message_ref_bounded', sql`length(${table.messageRef}) between 1 and 128`),
    check('conversation_messages_reply_ref_bounded', sql`${table.replyToMessageRef} is null or length(${table.replyToMessageRef}) between 1 and 128`),
    check('conversation_messages_thread_ref_bounded', sql`${table.threadRef} is null or length(${table.threadRef}) between 1 and 128`),
    check('conversation_messages_text_bounded', sql`${table.text} is null or length(${table.text}) between 1 and 4000`),
    check('conversation_messages_attachments_array', sql`jsonb_typeof(${table.attachments}) = 'array'`),
    check('conversation_messages_has_content', sql`${table.text} is not null or jsonb_array_length(${table.attachments}) > 0`)
  ]
);

export const resourceAccessGrants = pgTable(
  'resource_access_grants',
  {
    id: id(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, {onDelete: 'restrict'}),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => actors.id, {onDelete: 'restrict'}),
    resourceType: accessResourceTypeEnum('resource_type').notNull(),
    resourceId: uuid('resource_id').notNull(),
    desiredLevel: accessLevelEnum('desired_level').notNull(),
    observedProvider: text('observed_provider'),
    observedExternalResourceRef: text('observed_external_resource_ref'),
    observedLevel: accessLevelEnum('observed_level'),
    observedAt: timestamp('observed_at', {withTimezone: true}),
    version: integer('version').default(1).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    uniqueIndex('resource_access_grants_binding_unique').on(
      table.projectId,
      table.actorId,
      table.resourceType,
      table.resourceId
    ),
    index('resource_access_grants_actor_project_idx').on(
      table.actorId,
      table.projectId
    ),
    check(
      'resource_access_grants_observation_complete',
      sql`(${table.observedProvider} is null
          and ${table.observedExternalResourceRef} is null
          and ${table.observedLevel} is null
          and ${table.observedAt} is null)
        or (${table.observedProvider} is not null
          and ${table.observedExternalResourceRef} is not null
          and ${table.observedLevel} is not null
          and ${table.observedAt} is not null)`
    ),
    check(
      'resource_access_grants_observed_provider_key',
      sql`${table.observedProvider} is null
        or ${table.observedProvider} ~ '^[a-z][a-z0-9_-]{0,63}$'`
    ),
    check('resource_access_grants_version_positive', sql`${table.version} > 0`)
  ]
);

export const projectShareGrants = pgTable(
  'project_share_grants',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, {onDelete: 'cascade'}),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, {onDelete: 'cascade'}),
    createdByActorId: uuid('created_by_actor_id')
      .notNull()
      .references(() => actors.id, {onDelete: 'restrict'}),
    tokenHash: text('token_hash').notNull(),
    fieldScope: jsonb('field_scope')
      .$type<readonly [
        'publicTitle',
        'publicStatus',
        'publicSummary',
        'updatedTime'
      ]>()
      .default(sql`'["publicTitle","publicStatus","publicSummary","updatedTime"]'::jsonb`)
      .notNull(),
    expiresAt: timestamp('expires_at', {withTimezone: true}).notNull(),
    revokedAt: timestamp('revoked_at', {withTimezone: true}),
    revokedByActorId: uuid('revoked_by_actor_id').references(() => actors.id, {
      onDelete: 'restrict'
    }),
    lastAccessedAt: timestamp('last_accessed_at', {withTimezone: true}),
    accessCount: integer('access_count').default(0).notNull(),
    createdAt: createdAt()
  },
  (table) => [
    uniqueIndex('project_share_grants_token_hash_unique').on(table.tokenHash),
    index('project_share_grants_project_idx').on(table.projectId),
    index('project_share_grants_expires_idx').on(table.expiresAt),
    check(
      'project_share_grants_token_hash_sha256',
      sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      'project_share_grants_field_scope_fixed',
      sql`${table.fieldScope} = '["publicTitle","publicStatus","publicSummary","updatedTime"]'::jsonb`
    ),
    check(
      'project_share_grants_expiry_after_creation',
      sql`${table.expiresAt} > ${table.createdAt}`
    ),
    check(
      'project_share_grants_revocation_consistent',
      sql`(${table.revokedAt} is null and ${table.revokedByActorId} is null)
        or (${table.revokedAt} is not null and ${table.revokedByActorId} is not null
          and ${table.revokedAt} >= ${table.createdAt})`
    ),
    check(
      'project_share_grants_access_consistent',
      sql`(${table.accessCount} = 0 and ${table.lastAccessedAt} is null)
        or (${table.accessCount} > 0 and ${table.lastAccessedAt} is not null
          and ${table.lastAccessedAt} >= ${table.createdAt})`
    )
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
    sourcePlanVersionId: uuid('source_plan_version_id'),
    sourceKey: text('source_key'),
    checkpoint: text('checkpoint'),
    sourceEvidence: jsonb('source_evidence').$type<import('@fai-control-plane/domain').PlanEvidence>(),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    index('milestones_project_idx').on(table.projectId),
    foreignKey({columns: [table.projectId, table.sourcePlanVersionId], foreignColumns: [projectPlanVersions.projectId, projectPlanVersions.id], name: 'milestones_project_plan_version_fk'}).onDelete('restrict'),
    uniqueIndex('milestones_plan_source_key_unique').on(table.sourcePlanVersionId, table.sourceKey),
    check('milestones_plan_source_complete', sql`(${table.sourcePlanVersionId} is null and ${table.sourceKey} is null and ${table.checkpoint} is null and ${table.sourceEvidence} is null) or (${table.sourcePlanVersionId} is not null and ${table.sourceKey} is not null and ${table.checkpoint} is not null and ${table.sourceEvidence} is not null)`)
  ]
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
    instructions: text('instructions').default('').notNull(),
    settings: jsonb('settings')
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    enabled: boolean('enabled').default(true).notNull(),
    version: integer('version').default(1).notNull(),
    configHash: text('config_hash')
      .default('0000000000000000000000000000000000000000000000000000000000000000')
      .notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    uniqueIndex('agent_profiles_actor_runtime_unique').on(
      table.actorId,
      table.runtimeId,
      table.runtimeProfile
    ),
    check('agent_profiles_version_positive', sql`${table.version} > 0`),
    check('agent_profiles_config_hash_sha256', sql`${table.configHash} ~ '^[0-9a-f]{64}$'`)
  ]
);

export const runtimeRegistrations = pgTable(
  'runtime_registrations',
  {
    id: id(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, {onDelete: 'restrict'}),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => actors.id, {onDelete: 'restrict'}),
    agentProfileId: uuid('agent_profile_id')
      .notNull()
      .references(() => agentProfiles.id, {onDelete: 'restrict'}),
    provider: text('provider').notNull(),
    runtimeKey: text('runtime_key').notNull(),
    enabled: boolean('enabled').default(true).notNull(),
    serviceMaxAgeSeconds: integer('service_max_age_seconds'),
    schedulerMaxAgeSeconds: integer('scheduler_max_age_seconds'),
    deliveryMaxAgeSeconds: integer('delivery_max_age_seconds'),
    version: integer('version').default(1).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    uniqueIndex('runtime_registrations_identity_project_unique').on(table.id, table.projectId),
    uniqueIndex('runtime_registrations_binding_unique').on(
      table.projectId,
      table.actorId,
      table.agentProfileId,
      table.provider,
      table.runtimeKey
    ),
    index('runtime_registrations_project_actor_idx').on(
      table.projectId,
      table.actorId
    ),
    check(
      'runtime_registrations_provider_key',
      sql`${table.provider} ~ '^[a-z][a-z0-9_-]{0,63}$'`
    ),
    check(
      'runtime_registrations_runtime_key_bounded',
      sql`length(${table.runtimeKey}) between 1 and 256
        and ${table.runtimeKey} !~ '[[:cntrl:]]'`
    ),
    check(
      'runtime_registrations_service_max_age_bounded',
      sql`${table.serviceMaxAgeSeconds} is null or ${table.serviceMaxAgeSeconds} between 30 and 604800`
    ),
    check(
      'runtime_registrations_scheduler_max_age_bounded',
      sql`${table.schedulerMaxAgeSeconds} is null or ${table.schedulerMaxAgeSeconds} between 30 and 604800`
    ),
    check(
      'runtime_registrations_delivery_max_age_bounded',
      sql`${table.deliveryMaxAgeSeconds} is null or ${table.deliveryMaxAgeSeconds} between 30 and 604800`
    ),
    check('runtime_registrations_version_positive', sql`${table.version} > 0`)
  ]
);

export const runtimeAvailabilityObservations = pgTable(
  'runtime_availability_observations',
  {
    id: id(),
    runtimeRegistrationId: uuid('runtime_registration_id')
      .notNull()
      .references(() => runtimeRegistrations.id, {onDelete: 'cascade'}),
    component: runtimeAvailabilityComponentEnum('component').notNull(),
    state: runtimeAvailabilityStateEnum('state').notNull(),
    observedAt: timestamp('observed_at', {withTimezone: true}).notNull(),
    ttlSeconds: integer('ttl_seconds'),
    evidenceReference: text('evidence_reference').notNull(),
    createdAt: createdAt()
  },
  (table) => [
    uniqueIndex('runtime_availability_observations_fact_unique').on(
      table.runtimeRegistrationId,
      table.component,
      table.observedAt
    ),
    index('runtime_availability_observations_latest_idx').on(
      table.runtimeRegistrationId,
      table.component,
      table.observedAt
    ),
    check(
      'runtime_availability_observations_evidence_bounded',
      sql`length(${table.evidenceReference}) between 1 and 500
        and ${table.evidenceReference} !~ '[[:cntrl:]]'`
    ),
    check(
      'runtime_availability_observations_ttl_bounded',
      sql`${table.ttlSeconds} between 30 and 604800`
    )
  ]
);

export const runtimeRecoveryPolicies = pgTable(
  'runtime_recovery_policies',
  {
    runtimeRegistrationId: uuid('runtime_registration_id')
      .primaryKey()
      .references(() => runtimeRegistrations.id, {onDelete: 'cascade'}),
    enabled: boolean('enabled').default(false).notNull(),
    staleThresholdSeconds: integer('stale_threshold_seconds').notNull(),
    maximumAttempts: integer('maximum_attempts').notNull(),
    version: integer('version').default(1).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    check(
      'runtime_recovery_policies_stale_threshold_bounded',
      sql`${table.staleThresholdSeconds} between 30 and 604800`
    ),
    check(
      'runtime_recovery_policies_maximum_attempts_bounded',
      sql`${table.maximumAttempts} between 1 and 10`
    ),
    check('runtime_recovery_policies_version_positive', sql`${table.version} > 0`)
  ]
);

export const workspaceInstructionVersions = pgTable(
  'workspace_instruction_versions',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, {onDelete: 'restrict'}),
    version: integer('version').notNull(),
    instructions: text('instructions').notNull(),
    settings: jsonb('settings')
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    contentHash: text('content_hash').notNull(),
    authoredByActorId: uuid('authored_by_actor_id')
      .notNull()
      .references(() => actors.id, {onDelete: 'restrict'}),
    approvedByActorId: uuid('approved_by_actor_id')
      .notNull()
      .references(() => actors.id, {onDelete: 'restrict'}),
    rollbackOfVersionId: uuid('rollback_of_version_id').references(
      (): AnyPgColumn => workspaceInstructionVersions.id,
      {onDelete: 'restrict'}
    ),
    createdAt: createdAt()
  },
  (table) => [
    uniqueIndex('workspace_instruction_versions_sequence_unique').on(
      table.workspaceId,
      table.version
    ),
    check('workspace_instruction_versions_version_positive', sql`${table.version} > 0`),
    check(
      'workspace_instruction_versions_content_hash_sha256',
      sql`${table.contentHash} ~ '^[0-9a-f]{64}$'`
    )
  ]
);

export const agentProfileInstructionVersions = pgTable(
  'agent_profile_instruction_versions',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, {onDelete: 'restrict'}),
    agentProfileId: uuid('agent_profile_id')
      .notNull()
      .references(() => agentProfiles.id, {onDelete: 'restrict'}),
    version: integer('version').notNull(),
    instructions: text('instructions').notNull(),
    settings: jsonb('settings')
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    contentHash: text('content_hash').notNull(),
    authoredByActorId: uuid('authored_by_actor_id')
      .notNull()
      .references(() => actors.id, {onDelete: 'restrict'}),
    approvedByActorId: uuid('approved_by_actor_id')
      .notNull()
      .references(() => actors.id, {onDelete: 'restrict'}),
    rollbackOfVersionId: uuid('rollback_of_version_id').references(
      (): AnyPgColumn => agentProfileInstructionVersions.id,
      {onDelete: 'restrict'}
    ),
    createdAt: createdAt()
  },
  (table) => [
    uniqueIndex('agent_profile_instruction_versions_sequence_unique').on(
      table.agentProfileId,
      table.version
    ),
    index('agent_profile_instruction_versions_workspace_profile_idx').on(
      table.workspaceId,
      table.agentProfileId
    ),
    check('agent_profile_instruction_versions_version_positive', sql`${table.version} > 0`),
    check(
      'agent_profile_instruction_versions_content_hash_sha256',
      sql`${table.contentHash} ~ '^[0-9a-f]{64}$'`
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
    protocolState: text('protocol_state').$type<'draft' | 'published' | 'retired'>(),
    revision: integer('revision'),
    contentHash: text('content_hash'),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    uniqueIndex('runbooks_project_name_version_unique').on(
      table.projectId,
      table.name,
      table.version
    ),
    uniqueIndex('runbooks_id_version_unique').on(table.id, table.version),
    uniqueIndex('runbooks_one_active_delivery_protocol_per_project')
      .on(table.projectId)
      .where(sql`${table.protocolState} = 'published' AND ${table.active}`),
    check(
      'runbooks_delivery_protocol_metadata_complete',
      sql`(${table.protocolState} IS NULL AND ${table.revision} IS NULL AND ${table.contentHash} IS NULL) OR
          (${table.protocolState} IN ('draft', 'published', 'retired') AND
           ${table.revision} > 0 AND ${table.contentHash} ~ '^[0-9a-f]{64}$')`
    ),
    check(
      'runbooks_delivery_protocol_active_state',
      sql`${table.protocolState} IS NULL OR ${table.protocolState} = 'published' OR NOT ${table.active}`
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
    deletedAt: timestamp('deleted_at', {withTimezone: true}),
    sourcePlanVersionId: uuid('source_plan_version_id'),
    sourceTaskKey: text('source_task_key'),
    acceptanceEvidence: jsonb('acceptance_evidence').$type<import('@fai-control-plane/domain').ProjectPlanDefinition['tasks'][number]['acceptanceEvidence']>()
  },
  (table) => [
    index('work_items_project_status_idx').on(table.projectId, table.status),
    uniqueIndex('work_items_identity_project_unique').on(table.id, table.projectId),
    foreignKey({columns: [table.projectId, table.sourcePlanVersionId], foreignColumns: [projectPlanVersions.projectId, projectPlanVersions.id], name: 'work_items_project_plan_version_fk'}).onDelete('restrict'),
    uniqueIndex('work_items_identity_source_plan_unique').on(table.id, table.sourcePlanVersionId),
    uniqueIndex('work_items_plan_source_key_unique').on(table.sourcePlanVersionId, table.sourceTaskKey),
    check('work_items_plan_source_complete', sql`(${table.sourcePlanVersionId} is null and ${table.sourceTaskKey} is null and ${table.acceptanceEvidence} is null) or (${table.sourcePlanVersionId} is not null and ${table.sourceTaskKey} is not null and ${table.acceptanceEvidence} is not null)`),
    check('work_items_version_positive', sql`${table.version} > 0`)
  ]
);

export const projectExecutions = pgTable(
  'project_executions',
  {
    projectId: uuid('project_id').primaryKey()
      .references(() => projects.id, {onDelete: 'restrict'}),
    status: text('status').$type<import('@fai-control-plane/domain').ProjectExecutionStatus>()
      .notNull(),
    selectedWorkItemId: uuid('selected_work_item_id'),
    selectedPlanVersionId: uuid('selected_plan_version_id'),
    selectedWorkItemVersion: integer('selected_work_item_version'),
    selectedProtocolId: uuid('selected_protocol_id'),
    selectedProtocolVersion: integer('selected_protocol_version'),
    selectedJourneyVersion: integer('selected_journey_version'),
    selectedStageKey: text('selected_stage_key'),
    selectedResponsibleActorId: uuid('selected_responsible_actor_id'),
    selectedAgentProfileId: uuid('selected_agent_profile_id'),
    blockReason: text('block_reason'),
    version: integer('version').default(1).notNull(),
    startedAt: timestamp('started_at', {withTimezone: true}).notNull(),
    pausedAt: timestamp('paused_at', {withTimezone: true}),
    completedAt: timestamp('completed_at', {withTimezone: true}),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    foreignKey({
      columns: [table.selectedWorkItemId, table.projectId],
      foreignColumns: [workItems.id, workItems.projectId],
      name: 'project_executions_selected_work_item_project_fk'
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.selectedWorkItemId, table.selectedPlanVersionId],
      foreignColumns: [workItems.id, workItems.sourcePlanVersionId],
      name: 'project_executions_selected_work_item_plan_fk'
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.selectedPlanVersionId, table.projectId],
      foreignColumns: [projectPlanVersions.id, projectPlanVersions.projectId],
      name: 'project_executions_selected_plan_project_fk'
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.selectedProtocolId, table.selectedProtocolVersion],
      foreignColumns: [runbooks.id, runbooks.version],
      name: 'project_executions_selected_protocol_version_fk'
    }).onDelete('restrict'),
    foreignKey({columns: [table.selectedResponsibleActorId], foreignColumns: [actors.id],
      name: 'project_executions_selected_actor_fk'}).onDelete('restrict'),
    foreignKey({columns: [table.selectedAgentProfileId], foreignColumns: [agentProfiles.id],
      name: 'project_executions_selected_agent_profile_fk'}).onDelete('restrict'),
    check('project_executions_status_valid',
      sql`${table.status} in ('stopped', 'running', 'paused', 'blocked', 'completed')`),
    check('project_executions_version_positive', sql`${table.version} > 0`),
    check('project_executions_selection_shape',
      sql`(${table.status} = 'completed' and ${table.selectedWorkItemId} is null) or (${table.status} <> 'completed')`),
    check('project_executions_running_selection',
      sql`${table.status} <> 'running' or ${table.selectedWorkItemId} is not null`),
    check('project_executions_selection_snapshot_shape', sql`
      (${table.selectedWorkItemId} is null and ${table.selectedPlanVersionId} is null and
       ${table.selectedWorkItemVersion} is null and ${table.selectedProtocolId} is null and
       ${table.selectedProtocolVersion} is null and ${table.selectedJourneyVersion} is null and
       ${table.selectedStageKey} is null and ${table.selectedResponsibleActorId} is null and
       ${table.selectedAgentProfileId} is null)
      or
      (${table.selectedWorkItemId} is not null and ${table.selectedPlanVersionId} is not null and
       ${table.selectedWorkItemVersion} > 0 and ${table.selectedProtocolId} is not null and
       ${table.selectedProtocolVersion} > 0 and ${table.selectedJourneyVersion} > 0 and
       ${table.selectedStageKey} ~ '^[a-z][a-z0-9_]{0,63}$' and ${table.selectedResponsibleActorId} is not null)`),
    check('project_executions_block_shape',
      sql`(${table.status} = 'blocked' and ${table.blockReason} ~ '^[a-z][a-z0-9_]{0,63}$') or (${table.status} <> 'blocked' and ${table.blockReason} is null)`),
    check('project_executions_pause_shape',
      sql`(${table.status} = 'paused') = (${table.pausedAt} is not null)`),
    check('project_executions_completion_shape',
      sql`(${table.status} = 'completed') = (${table.completedAt} is not null)`)
  ]
);

export const scopeOutcomeStateEnum = pgEnum('scope_outcome_state', ['accepted', 'review', 'in_progress', 'not_started', 'not_configured']);
export const projectScopeBaselineVersions = pgTable('project_scope_baseline_versions', {
  id: id(), projectId: uuid('project_id').notNull().references(() => projects.id, {onDelete: 'cascade'}),
  version: integer('version').notNull(), active: boolean('active').default(true).notNull(),
  approvedByActorId: uuid('approved_by_actor_id').references(() => actors.id, {onDelete: 'set null'}), approvedAt: timestamp('approved_at', {withTimezone: true}),
  sourcePlanVersionId: uuid('source_plan_version_id'),
  sourcePlanHash: text('source_plan_hash'),
  checkpointTitle: text('checkpoint_title'), checkpointStatus: workItemStatusEnum('checkpoint_status'), checkpointOwnerActorId: uuid('checkpoint_owner_actor_id').references(() => actors.id, {onDelete: 'set null'}), checkpointTargetAt: timestamp('checkpoint_target_at', {withTimezone: true}), updatedAt: updatedAt()
}, (table) => [
  uniqueIndex('project_scope_baseline_versions_project_version_unique').on(table.projectId, table.version),
  foreignKey({columns: [table.projectId, table.sourcePlanVersionId], foreignColumns: [projectPlanVersions.projectId, projectPlanVersions.id], name: 'project_scope_baseline_versions_project_plan_fk'}).onDelete('restrict'),
  uniqueIndex('project_scope_baseline_versions_identity_project_source_unique').on(table.id, table.projectId, table.sourcePlanVersionId),
  uniqueIndex('project_scope_baseline_versions_identity_source_unique').on(table.id, table.sourcePlanVersionId),
  uniqueIndex('project_scope_baseline_versions_one_active_per_project').on(table.projectId).where(sql`${table.active}`),
  uniqueIndex('project_scope_baseline_versions_source_plan_unique').on(table.sourcePlanVersionId),
  check('project_scope_baseline_versions_version_positive', sql`${table.version} > 0`),
  check('project_scope_baseline_versions_checkpoint_complete', sql`(${table.checkpointTitle} IS NULL AND ${table.checkpointStatus} IS NULL AND ${table.checkpointOwnerActorId} IS NULL AND ${table.checkpointTargetAt} IS NULL) OR (${table.checkpointTitle} IS NOT NULL AND ${table.checkpointStatus} IS NOT NULL)`),
  check('project_scope_baseline_versions_source_complete', sql`(${table.sourcePlanVersionId} is null and ${table.sourcePlanHash} is null) or (${table.sourcePlanVersionId} is not null and ${table.sourcePlanHash} ~ '^[0-9a-f]{64}$')`)
]);
export const projectScopeOutcomes = pgTable('project_scope_outcomes', {
  id: id(), baselineId: uuid('baseline_id').notNull().references(() => projectScopeBaselineVersions.id, {onDelete: 'cascade'}),
  sourcePlanVersionId: uuid('source_plan_version_id'),
  key: text('key').notNull(), title: text('title').notNull(), weight: integer('weight').notNull(),
  state: scopeOutcomeStateEnum('state').notNull(), acceptedByActorId: uuid('accepted_by_actor_id').references(() => actors.id, {onDelete: 'set null'}),
  acceptedAt: timestamp('accepted_at', {withTimezone: true}), evidenceReference: text('evidence_reference'), createdAt: createdAt()
}, (table) => [
  foreignKey({columns: [table.baselineId, table.sourcePlanVersionId], foreignColumns: [projectScopeBaselineVersions.id, projectScopeBaselineVersions.sourcePlanVersionId], name: 'project_scope_outcomes_baseline_plan_fk'}).onDelete('cascade'),
  uniqueIndex('project_scope_outcomes_baseline_key_unique').on(table.baselineId, table.key),
  uniqueIndex('project_scope_outcomes_identity_source_plan_unique').on(table.id, table.sourcePlanVersionId),
  check('project_scope_outcomes_weight_positive', sql`${table.weight} > 0`)
]);

/** Immutable observations are the sole source for the scope burn-up graphic. */
export const projectScopeOutcomeObservations = pgTable(
  'project_scope_outcome_observations',
  {
    id: id(),
    projectId: uuid('project_id').notNull().references(() => projects.id, {onDelete: 'cascade'}),
    baselineId: uuid('baseline_id').notNull().references(() => projectScopeBaselineVersions.id, {onDelete: 'cascade'}),
    acceptedWeight: integer('accepted_weight').notNull(),
    totalWeight: integer('total_weight').notNull(),
    observedAt: timestamp('observed_at', {withTimezone: true}).notNull(),
    evidenceReference: text('evidence_reference').notNull(),
    createdAt: createdAt()
  },
  (table) => [
    uniqueIndex('project_scope_outcome_observations_project_observed_unique')
      .on(table.projectId, table.observedAt),
    index('project_scope_outcome_observations_project_observed_idx')
      .on(table.projectId, table.observedAt),
    check('project_scope_outcome_observations_weights_valid', sql`${table.acceptedWeight} >= 0 AND ${table.totalWeight} > 0 AND ${table.acceptedWeight} <= ${table.totalWeight}`),
    check('project_scope_outcome_observations_evidence_bounded', sql`length(${table.evidenceReference}) BETWEEN 1 AND 500`)
  ]
);

export const workItemDependencies = pgTable('work_item_dependencies', {
  workItemId: uuid('work_item_id').notNull(),
  dependsOnWorkItemId: uuid('depends_on_work_item_id').notNull(),
  sourcePlanVersionId: uuid('source_plan_version_id').notNull(),
  createdAt: createdAt()
}, (table) => [
  primaryKey({name: 'work_item_dependencies_pk', columns: [table.workItemId, table.dependsOnWorkItemId]}),
  foreignKey({columns: [table.workItemId, table.sourcePlanVersionId], foreignColumns: [workItems.id, workItems.sourcePlanVersionId], name: 'work_item_dependencies_item_plan_fk'}).onDelete('restrict'),
  foreignKey({columns: [table.dependsOnWorkItemId, table.sourcePlanVersionId], foreignColumns: [workItems.id, workItems.sourcePlanVersionId], name: 'work_item_dependencies_dependency_plan_fk'}).onDelete('restrict'),
  check('work_item_dependencies_not_self', sql`${table.workItemId} <> ${table.dependsOnWorkItemId}`)
]);

export const workItemScopeOutcomes = pgTable('work_item_scope_outcomes', {
  workItemId: uuid('work_item_id').notNull(),
  outcomeId: uuid('outcome_id').notNull(),
  sourcePlanVersionId: uuid('source_plan_version_id').notNull(),
  createdAt: createdAt()
}, (table) => [
  primaryKey({name: 'work_item_scope_outcomes_pk', columns: [table.workItemId, table.outcomeId]}),
  foreignKey({columns: [table.workItemId, table.sourcePlanVersionId], foreignColumns: [workItems.id, workItems.sourcePlanVersionId], name: 'work_item_scope_outcomes_item_plan_fk'}).onDelete('restrict'),
  foreignKey({columns: [table.outcomeId, table.sourcePlanVersionId], foreignColumns: [projectScopeOutcomes.id, projectScopeOutcomes.sourcePlanVersionId], name: 'work_item_scope_outcomes_outcome_plan_fk'}).onDelete('restrict')
]);

export const projectPlanMaterializations = pgTable('project_plan_materializations', {
  id: id(),
  workspaceId: uuid('workspace_id').notNull(),
  projectId: uuid('project_id').notNull(),
  planVersionId: uuid('plan_version_id').notNull(),
  baselineId: uuid('baseline_id').notNull(),
  commandId: uuid('command_id').notNull(),
  planVersion: integer('plan_version').notNull(),
  planHash: text('plan_hash').notNull(),
  sourceManifestHash: text('source_manifest_hash').notNull(),
  outcomeCount: integer('outcome_count').notNull(),
  milestoneCount: integer('milestone_count').notNull(),
  workItemCount: integer('work_item_count').notNull(),
  dependencyCount: integer('dependency_count').notNull(),
  journeyCount: integer('journey_count').notNull(),
  publicationIntentCount: integer('publication_intent_count').notNull(),
  createdByActorId: uuid('created_by_actor_id').notNull(),
  createdAt: createdAt()
}, (table) => [
  uniqueIndex('project_plan_materializations_plan_version_unique').on(table.planVersionId),
  uniqueIndex('project_plan_materializations_baseline_unique').on(table.baselineId),
  uniqueIndex('project_plan_materializations_command_unique').on(table.commandId),
  foreignKey({columns: [table.workspaceId, table.projectId], foreignColumns: [projects.workspaceId, projects.id], name: 'project_plan_materializations_workspace_project_fk'}).onDelete('restrict'),
  foreignKey({columns: [table.planVersionId, table.workspaceId, table.projectId, table.planVersion], foreignColumns: [projectPlanVersions.id, projectPlanVersions.workspaceId, projectPlanVersions.projectId, projectPlanVersions.version], name: 'project_plan_materializations_plan_scope_fk'}).onDelete('restrict'),
  foreignKey({columns: [table.baselineId, table.projectId, table.planVersionId], foreignColumns: [projectScopeBaselineVersions.id, projectScopeBaselineVersions.projectId, projectScopeBaselineVersions.sourcePlanVersionId], name: 'project_plan_materializations_baseline_scope_fk'}).onDelete('restrict'),
  foreignKey({columns: [table.workspaceId, table.createdByActorId], foreignColumns: [actors.workspaceId, actors.id], name: 'project_plan_materializations_workspace_actor_fk'}).onDelete('restrict'),
  check('project_plan_materializations_hashes_valid', sql`${table.planHash} ~ '^[0-9a-f]{64}$' and ${table.sourceManifestHash} ~ '^[0-9a-f]{64}$'`),
  check('project_plan_materializations_plan_version_positive', sql`${table.planVersion} > 0`),
  check('project_plan_materializations_counts_nonnegative', sql`${table.outcomeCount} > 0 and ${table.milestoneCount} > 0 and ${table.workItemCount} > 0 and ${table.dependencyCount} >= 0 and ${table.journeyCount} >= 0 and ${table.publicationIntentCount} >= 0`)
]);

/** Provider-neutral desired publication state. A future adapter may observe and reconcile it. */
export const projectPublicationIntents = pgTable('project_publication_intents', {
  id: id(),
  workspaceId: uuid('workspace_id').notNull(),
  projectId: uuid('project_id').notNull(),
  planVersionId: uuid('plan_version_id').notNull(),
  surface: text('surface').notNull(),
  mode: text('mode').notNull(),
  resourceKind: text('resource_kind').notNull(),
  canonicalId: uuid('canonical_id').notNull(),
  state: text('state').default('desired').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  createdAt: createdAt()
}, (table) => [
  foreignKey({columns: [table.planVersionId, table.workspaceId, table.projectId], foreignColumns: [projectPlanVersions.id, projectPlanVersions.workspaceId, projectPlanVersions.projectId], name: 'project_publication_intents_plan_scope_fk'}).onDelete('restrict'),
  uniqueIndex('project_publication_intents_idempotency_unique').on(table.idempotencyKey),
  index('project_publication_intents_project_state_idx').on(table.projectId, table.state),
  check('project_publication_intents_surface', sql`${table.surface} in ('repository', 'tracker')`),
  check('project_publication_intents_mode', sql`${table.mode} in ('link_existing', 'create_managed')`),
  check('project_publication_intents_resource_kind', sql`${table.resourceKind} in ('baseline', 'outcome', 'milestone', 'work_item')`),
  check('project_publication_intents_state', sql`${table.state} = 'desired'`)
]);

export const deliveryJourneys = pgTable(
  'delivery_journeys',
  {
    workItemId: uuid('work_item_id').primaryKey()
      .references(() => workItems.id, {onDelete: 'cascade'}),
    protocolId: uuid('protocol_id').notNull(),
    protocolVersion: integer('protocol_version').notNull(),
    stageKey: text('stage_key').notNull(),
    deadlineAt: timestamp('deadline_at', {withTimezone: true}),
    version: integer('version').default(1).notNull(),
    startedAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    foreignKey({
      name: 'delivery_journeys_protocol_version_fk',
      columns: [table.protocolId, table.protocolVersion],
      foreignColumns: [runbooks.id, runbooks.version]
    }).onDelete('restrict'),
    index('delivery_journeys_protocol_version_idx').on(table.protocolId, table.protocolVersion),
    check('delivery_journeys_stage_key_valid', sql`${table.stageKey} ~ '^[a-z][a-z0-9_]{0,63}$'`),
    check('delivery_journeys_protocol_version_positive', sql`${table.protocolVersion} > 0`),
    check('delivery_journeys_version_positive', sql`${table.version} > 0`)
  ]
);

export const deliveryJourneyEvidence = pgTable(
  'delivery_journey_evidence',
  {
    id: id(),
    workItemId: uuid('work_item_id').notNull()
      .references(() => deliveryJourneys.workItemId, {onDelete: 'cascade'}),
    stageKey: text('stage_key').notNull(),
    requirement: text('requirement').notNull(),
    evidenceReference: text('evidence_reference').notNull(),
    commandId: text('command_id').notNull(),
    createdAt: createdAt()
  },
  (table) => [
    uniqueIndex('delivery_journey_evidence_stage_requirement_unique')
      .on(table.workItemId, table.stageKey, table.requirement),
    index('delivery_journey_evidence_work_item_idx').on(table.workItemId, table.createdAt),
    check('delivery_journey_evidence_reference_nonempty',
      sql`length(${table.evidenceReference}) BETWEEN 1 AND 2048`)
  ]
);

export const projectShareWorkItems = pgTable(
  'project_share_work_items',
  {
    grantId: uuid('grant_id')
      .notNull()
      .references(() => projectShareGrants.id, {onDelete: 'cascade'}),
    workItemId: uuid('work_item_id')
      .notNull()
      .references(() => workItems.id, {onDelete: 'cascade'})
  },
  (table) => [
    primaryKey({
      name: 'project_share_work_items_pk',
      columns: [table.grantId, table.workItemId]
    }),
    index('project_share_work_items_work_item_idx').on(table.workItemId)
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
    observedAt: timestamp('observed_at', {withTimezone: true}).defaultNow().notNull(),
    confirmedAt: timestamp('confirmed_at', {withTimezone: true}),
    evidenceState: text('evidence_state').default('observed').notNull(),
    conflictReason: text('conflict_reason'),
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
    ),
    check(
      'tracker_bindings_evidence_state_valid',
      sql`${table.evidenceState} in (
        'observed', 'pending_confirmation', 'confirmed', 'stale', 'conflict', 'missing'
      )`
    ),
    check(
      'tracker_bindings_conflict_reason_valid',
      sql`(${table.evidenceState} = 'conflict'
        and ${table.conflictReason} is not null
        and length(${table.conflictReason}) between 1 and 255)
      or (${table.evidenceState} <> 'conflict' and ${table.conflictReason} is null)`
    )
  ]
);

export const trackerSnapshotOperations = pgTable(
  'tracker_snapshot_operations',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, {onDelete: 'restrict'}),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, {onDelete: 'restrict'}),
    provider: text('provider').notNull(),
    repositoryExternalId: text('repository_external_id').notNull(),
    mode: text('mode').notNull(),
    requestHash: text('request_hash').notNull(),
    previousExternalVersion: text('previous_external_version'),
    snapshotExternalVersion: text('snapshot_external_version').notNull(),
    result: jsonb('result').$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt()
  },
  (table) => [
    uniqueIndex('tracker_snapshot_operations_workspace_id_unique').on(
      table.workspaceId,
      table.id
    ),
    index('tracker_snapshot_operations_repository_idx').on(
      table.projectId,
      table.provider,
      table.repositoryExternalId,
      table.createdAt
    ),
    check(
      'tracker_snapshot_operations_mode_valid',
      sql`${table.mode} in ('bootstrap', 'synchronize')`
    )
  ]
);

/**
 * Immutable GitHub Project Status observations. Only delivery state and a
 * conflict code may change after insertion; the observed provider value and
 * canonical CAS expectation remain evidence for the eventual command.
 */
export const trackerStatusObservationInbox = pgTable(
  'tracker_status_observation_inbox',
  {
    id: id(),
    snapshotOperationId: uuid('snapshot_operation_id').notNull(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, {onDelete: 'restrict'}),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, {onDelete: 'restrict'}),
    bindingId: uuid('binding_id')
      .notNull()
      .references(() => trackerBindings.id, {onDelete: 'restrict'}),
    workItemId: uuid('work_item_id')
      .notNull()
      .references(() => workItems.id, {onDelete: 'restrict'}),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => actors.id, {onDelete: 'restrict'}),
    correlationId: uuid('correlation_id').notNull(),
    provider: text('provider').notNull(),
    mappedStatus: workItemStatusEnum('mapped_status').notNull(),
    expectedCanonicalVersion: integer('expected_canonical_version').notNull(),
    bindingInboundVersion: text('binding_inbound_version').notNull(),
    outboundMutationId: uuid('outbound_mutation_id'),
    state: trackerStatusObservationStateEnum('state').default('pending').notNull(),
    conflictCode: text('conflict_code'),
    processingToken: uuid('processing_token'),
    processingLeaseExpiresAt: timestamp('processing_lease_expires_at', {
      withTimezone: true
    }),
    processedAt: timestamp('processed_at', {withTimezone: true}),
    createdAt: createdAt()
  },
  (table) => [
    uniqueIndex('tracker_status_observation_binding_snapshot_unique').on(
      table.bindingId,
      table.snapshotOperationId
    ),
    index('tracker_status_observation_claim_idx').on(
      table.state,
      table.createdAt
    ),
    index('tracker_status_observation_work_item_idx').on(
      table.workItemId,
      table.createdAt
    ),
    check(
      'tracker_status_observation_expected_version_positive',
      sql`${table.expectedCanonicalVersion} > 0`
    ),
    check(
      'tracker_status_observation_processing_claim_valid',
      sql`(
        ${table.state} = 'processing'
        and ${table.processingToken} is not null
        and ${table.processingLeaseExpiresAt} is not null
      ) or (
        ${table.state} <> 'processing'
        and ${table.processingToken} is null
        and ${table.processingLeaseExpiresAt} is null
      )`
    ),
    check(
      'tracker_status_observation_conflict_code_valid',
      sql`(${table.state} = 'conflict' and ${table.conflictCode} is not null)
        or (${table.state} <> 'conflict' and ${table.conflictCode} is null)`
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
    externalVersion: text('external_version'),
    url: text('url').notNull(),
    headRef: text('head_ref').notNull(),
    baseRef: text('base_ref').notNull(),
    state: text('state').notNull(),
    draft: boolean('draft').default(true).notNull(),
    observedAt: timestamp('observed_at', {withTimezone: true}).defaultNow().notNull(),
    confirmedAt: timestamp('confirmed_at', {withTimezone: true}),
    evidenceState: text('evidence_state').default('observed').notNull(),
    conflictReason: text('conflict_reason'),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    uniqueIndex('pr_links_provider_external_unique').on(
      table.provider,
      table.repositoryRef,
      table.externalId
    ),
    check(
      'pr_links_evidence_state_valid',
      sql`${table.evidenceState} in (
        'observed', 'pending_confirmation', 'confirmed', 'stale', 'conflict', 'missing'
      )`
    ),
    check(
      'pr_links_conflict_reason_valid',
      sql`(${table.evidenceState} = 'conflict'
        and ${table.conflictReason} is not null
        and length(${table.conflictReason}) between 1 and 255)
      or (${table.evidenceState} <> 'conflict' and ${table.conflictReason} is null)`
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
    externalVersion: text('external_version'),
    name: text('name').notNull(),
    status: text('status').notNull(),
    conclusion: text('conclusion'),
    detailsUrl: text('details_url'),
    observedAt: timestamp('observed_at', {withTimezone: true}).defaultNow().notNull(),
    confirmedAt: timestamp('confirmed_at', {withTimezone: true}),
    evidenceState: text('evidence_state').default('observed').notNull(),
    conflictReason: text('conflict_reason'),
    startedAt: timestamp('started_at', {withTimezone: true}),
    completedAt: timestamp('completed_at', {withTimezone: true}),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    uniqueIndex('build_checks_provider_external_unique').on(
      table.provider,
      table.externalId
    ),
    check(
      'build_checks_evidence_state_valid',
      sql`${table.evidenceState} in (
        'observed', 'pending_confirmation', 'confirmed', 'stale', 'conflict', 'missing'
      )`
    ),
    check(
      'build_checks_conflict_reason_valid',
      sql`(${table.evidenceState} = 'conflict'
        and ${table.conflictReason} is not null
        and length(${table.conflictReason}) between 1 and 255)
      or (${table.evidenceState} <> 'conflict' and ${table.conflictReason} is null)`
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

export type DailyPmReportPayload = Readonly<{
  schemaVersion: 1;
  timezone: 'UTC';
  reportDate: string;
  generatedAt: string;
  dataAsOf: string;
  workItems: Readonly<{
    statusCounts: Readonly<Record<
      'backlog' | 'ready' | 'in_dev' | 'qa' | 'acceptance' | 'done',
      number
    >>;
    blockedCount: number;
  }>;
  riskSignals: Readonly<{
    unresolvedCountsBySeverity: Readonly<Record<'green' | 'yellow' | 'red', number>>;
  }>;
  approvals: Readonly<{pendingCount: number}>;
  github: Readonly<{
    failedWritebackCount: number;
    latestSuccessfulTrackerSnapshot: Readonly<{
      at: string | null;
      freshness: 'fresh' | 'stale' | 'missing';
    }>;
  }>;
}>;

export const dailyPmReports = pgTable(
  'daily_pm_reports',
  {
    id: id(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, {onDelete: 'restrict'}),
    reportDate: date('report_date').notNull(),
    payload: jsonb('payload').$type<DailyPmReportPayload>().notNull(),
    createdAt: createdAt()
  },
  (table) => [
    uniqueIndex('daily_pm_reports_project_date_unique').on(
      table.projectId,
      table.reportDate
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
    telegramMessageId: text('telegram_message_id'),
    telegramChatId: text('telegram_chat_id'),
    telegramUserId: text('telegram_user_id'),
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
    ),
    check(
      'incoming_events_telegram_verified_source',
      sql`${table.provider} <> 'telegram' or (
        ${table.verification} = '{"outcome":"verified","method":"shared-token"}'::jsonb
        and ${table.installationId} is null
        and ${table.repositoryId} is null
        and ${table.projectNodeId} is null
        and ${table.telegramMessageId} ~ '^tgid:v1:[0-9a-f]{64}$'
        and ${table.telegramChatId} ~ '^tgid:v1:[0-9a-f]{64}$'
        and ${table.telegramUserId} ~ '^tgid:v1:[0-9a-f]{64}$'
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

/** Immutable configured repository identity used to authorize tracker reads before bootstrap. */
export const projectTrackerRepositoryScopes = pgTable(
  'project_tracker_repository_scopes',
  {
    id: id(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, {onDelete: 'cascade'}),
    provider: text('provider').notNull(),
    repositoryOwner: text('repository_owner').notNull(),
    repositoryName: text('repository_name').notNull(),
    repositoryExternalId: text('repository_external_id').notNull(),
    credentialRefId: uuid('credential_ref_id')
      .notNull()
      .references(() => secretRefs.id, {onDelete: 'restrict'}),
    createdAt: createdAt()
  },
  (table) => [
    uniqueIndex('project_tracker_repository_scopes_config_unique').on(
      table.projectId,
      table.provider,
      table.repositoryOwner,
      table.repositoryName
    ),
    uniqueIndex('project_tracker_repository_scopes_external_unique').on(
      table.projectId,
      table.provider,
      table.repositoryExternalId
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
    workItemVersion: integer('work_item_version').notNull(),
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
    agentProfileSnapshotId: uuid('agent_profile_snapshot_id')
      .references(() => agentProfiles.id, {onDelete: 'restrict'}),
    agentProfileSnapshotRuntimeId: text('agent_profile_snapshot_runtime_id'),
    agentProfileSnapshotAllowedTools: text('agent_profile_snapshot_allowed_tools').array(),
    agentProfileSnapshotForbiddenSurfaces: text('agent_profile_snapshot_forbidden_surfaces').array(),
    agentProfileSnapshotEnabled: boolean('agent_profile_snapshot_enabled'),
    agentProfileSnapshotVersion: integer('agent_profile_snapshot_version'),
    agentProfileSnapshotHash: text('agent_profile_snapshot_hash'),
    agentProfileSnapshotInstructions: text('agent_profile_snapshot_instructions'),
    agentProfileSnapshotSettings: jsonb('agent_profile_snapshot_settings')
      .$type<Record<string, unknown>>(),
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
    uniqueIndex('task_packets_identity_project_unique').on(table.id, table.projectId),
    uniqueIndex('task_packets_content_hash_unique').on(
      table.workItemId,
      table.contentHash
    ),
    check('task_packets_timebox_positive', sql`${table.timeboxMinutes} > 0`),
    check('task_packets_work_item_version_positive', sql`${table.workItemVersion} > 0`),
    check(
      'task_packets_agent_profile_snapshot_consistent',
      sql`(
        ${table.agentProfileSnapshotId} is null and
        ${table.agentProfileSnapshotRuntimeId} is null and
        ${table.agentProfileSnapshotAllowedTools} is null and
        ${table.agentProfileSnapshotForbiddenSurfaces} is null and
        ${table.agentProfileSnapshotEnabled} is null and
        ${table.agentProfileSnapshotVersion} is null and
        ${table.agentProfileSnapshotHash} is null and
        ${table.agentProfileSnapshotInstructions} is null and
        ${table.agentProfileSnapshotSettings} is null
      ) or (
        ${table.agentProfileSnapshotId} is not null and
        ${table.agentProfileSnapshotRuntimeId} is not null and
        ${table.agentProfileSnapshotAllowedTools} is not null and
        ${table.agentProfileSnapshotForbiddenSurfaces} is not null and
        ${table.agentProfileSnapshotEnabled} is not null and
        ${table.agentProfileSnapshotVersion} > 0 and
        ${table.agentProfileSnapshotHash} ~ '^[0-9a-f]{64}$' and
        ${table.agentProfileSnapshotInstructions} is not null and
        ${table.agentProfileSnapshotSettings} is not null
      )`
    )
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
    workItemId: uuid('work_item_id')
      .notNull()
      .references(() => workItems.id, {onDelete: 'restrict'}),
    repositoryScopeId: uuid('repository_scope_id')
      .notNull()
      .references(() => projectTrackerRepositoryScopes.id, {onDelete: 'restrict'}),
    retryOfAgentRunId: uuid('retry_of_agent_run_id'),
    confirmedPacketHash: text('confirmed_packet_hash').notNull(),
    baseCommit: text('base_commit').notNull(),
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
    runnerId: text('runner_id'),
    leaseTokenHash: text('lease_token_hash'),
    leaseExpiresAt: timestamp('lease_expires_at', {withTimezone: true}),
    attempt: integer('attempt').default(0).notNull(),
    version: integer('version').default(1).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    uniqueIndex('agent_runs_identity_packet_unique').on(table.id, table.taskPacketId),
    uniqueIndex('agent_runs_idempotency_unique').on(table.idempotencyKey),
    uniqueIndex('agent_runs_one_active_attempt_unique')
      .on(table.workItemId, table.repositoryScopeId)
      .where(sql`${table.status} in ('queued', 'running', 'waiting_approval')`),
    index('agent_runs_status_heartbeat_idx').on(
      table.status,
      table.heartbeatAt
    ),
    index('agent_runs_claim_order_idx').on(table.status, table.createdAt),
    check('agent_runs_version_positive', sql`${table.version} > 0`),
    check('agent_runs_attempt_nonnegative', sql`${table.attempt} >= 0`),
    check(
      'agent_runs_base_commit_sha1',
      sql`${table.baseCommit} ~ '^[0-9a-f]{40}$'`
    ),
    check(
      'agent_runs_confirmed_packet_hash_sha256',
      sql`${table.confirmedPacketHash} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      'agent_runs_lease_token_hash_sha256',
      sql`${table.leaseTokenHash} is null or ${table.leaseTokenHash} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      'agent_runs_lease_fields_together',
      sql`num_nonnulls(${table.runnerId}, ${table.leaseTokenHash}, ${table.leaseExpiresAt}) in (0, 3)`
    ),
    check(
      'agent_runs_runner_id_nonempty',
      sql`${table.runnerId} is null or length(${table.runnerId}) between 1 and 128`
    ),
    check(
      'agent_runs_retry_not_self',
      sql`${table.retryOfAgentRunId} is null or ${table.retryOfAgentRunId} <> ${table.id}`
    ),
    foreignKey({
      name: 'agent_runs_retry_of_agent_run_id_agent_runs_id_fk',
      columns: [table.retryOfAgentRunId],
      foreignColumns: [table.id]
    }).onDelete('restrict')
  ]
);

/** Immutable linkage between one execution selection version and one isolated runner attempt. */
export const projectExecutionDispatches = pgTable(
  'project_execution_dispatches',
  {
    id: id(),
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id').notNull(),
    executionVersion: integer('execution_version').notNull(),
    selectionHash: text('selection_hash').notNull(),
    taskPacketId: uuid('task_packet_id').notNull(),
    agentRunId: uuid('agent_run_id').notNull(),
    runtimeRegistrationId: uuid('runtime_registration_id').notNull(),
    runtimeRegistrationVersion: integer('runtime_registration_version').notNull(),
    requestedByActorId: uuid('requested_by_actor_id').notNull(),
    createdAt: createdAt()
  },
  (table) => [
    foreignKey({name: 'project_execution_dispatches_workspace_project_fk',
      columns: [table.workspaceId, table.projectId],
      foreignColumns: [projects.workspaceId, projects.id]}).onDelete('restrict'),
    foreignKey({name: 'project_execution_dispatches_execution_project_fk',
      columns: [table.projectId],
      foreignColumns: [projectExecutions.projectId]}).onDelete('restrict'),
    foreignKey({name: 'project_execution_dispatches_packet_project_fk',
      columns: [table.taskPacketId, table.projectId],
      foreignColumns: [taskPackets.id, taskPackets.projectId]}).onDelete('restrict'),
    foreignKey({name: 'project_execution_dispatches_run_packet_fk',
      columns: [table.agentRunId, table.taskPacketId],
      foreignColumns: [agentRuns.id, agentRuns.taskPacketId]}).onDelete('restrict'),
    foreignKey({name: 'project_execution_dispatches_runtime_project_fk',
      columns: [table.runtimeRegistrationId, table.projectId],
      foreignColumns: [runtimeRegistrations.id, runtimeRegistrations.projectId]}).onDelete('restrict'),
    foreignKey({name: 'project_execution_dispatches_workspace_requester_fk',
      columns: [table.workspaceId, table.requestedByActorId],
      foreignColumns: [actors.workspaceId, actors.id]}).onDelete('restrict'),
    uniqueIndex('project_execution_dispatches_execution_unique')
      .on(table.projectId, table.executionVersion),
    index('project_execution_dispatches_packet_idx').on(table.taskPacketId),
    uniqueIndex('project_execution_dispatches_run_unique').on(table.agentRunId),
    check('project_execution_dispatches_execution_version_positive',
      sql`${table.executionVersion} > 0`),
    check('project_execution_dispatches_runtime_registration_version_positive',
      sql`${table.runtimeRegistrationVersion} > 0`),
    check('project_execution_dispatches_selection_hash_sha256',
      sql`${table.selectionHash} ~ '^[0-9a-f]{64}$'`)
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
    subjectHash: text('subject_hash').notNull(),
    policyVersion: integer('policy_version').notNull(),
    executionIdentity: uuid('execution_identity').notNull(),
    actionHash: text('action_hash').notNull(),
    status: approvalStatusEnum('status').default('pending').notNull(),
    requestedByActorId: uuid('requested_by_actor_id')
      .notNull()
      .references(() => actors.id, {onDelete: 'restrict'}),
    decidedByActorId: uuid('decided_by_actor_id').references(
      () => actors.id,
      {onDelete: 'restrict'}
    ),
    decisionReason: text('decision_reason'),
    expiresAt: timestamp('expires_at', {withTimezone: true}).notNull(),
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
    index('approval_requests_agent_run_binding_idx').on(
      table.agentRunId,
      table.subjectHash,
      table.actionHash,
      table.status,
      table.expiresAt
    ),
    check(
      'approval_requests_exactly_one_target',
      sql`(${table.workItemId} is null) <> (${table.agentRunId} is null)`
    ),
    check(
      'approval_requests_execution_identity_target',
      sql`${table.agentRunId} is null or ${table.executionIdentity} = ${table.agentRunId}`
    ),
    check('approval_requests_subject_hash_sha256', sql`${table.subjectHash} ~ '^[0-9a-f]{64}$'`),
    check('approval_requests_action_hash_sha256', sql`${table.actionHash} ~ '^[0-9a-f]{64}$'`),
    check('approval_requests_policy_version_positive', sql`${table.policyVersion} > 0`),
    check(
      'approval_requests_expiry_bounded',
      sql`${table.expiresAt} > ${table.createdAt} and ${table.expiresAt} <= ${table.createdAt} + interval '24 hours'`
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

export const agentRunReceipts = pgTable(
  'agent_run_receipts',
  {
    agentRunId: uuid('agent_run_id')
      .primaryKey()
      .references(() => agentRuns.id, {onDelete: 'restrict'}),
    runnerId: text('runner_id').notNull(),
    attempt: integer('attempt').notNull(),
    terminal: runStatusEnum('terminal').notNull(),
    receiptSha256: text('receipt_sha256').notNull(),
    receiptSizeBytes: bigint('receipt_size_bytes', {mode: 'number'}).notNull(),
    completionReplayHash: text('completion_replay_hash').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull(),
    completedAt: timestamp('completed_at', {withTimezone: true}).notNull(),
    createdAt: createdAt()
  },
  (table) => [
    check(
      'agent_run_receipts_terminal_status',
      sql`${table.terminal} in ('done', 'failed')`
    ),
    check('agent_run_receipts_attempt_positive', sql`${table.attempt} > 0`),
    check(
      'agent_run_receipts_sha256',
      sql`${table.receiptSha256} ~ '^[0-9a-f]{64}$' and ${table.completionReplayHash} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      'agent_run_receipts_size_positive',
      sql`${table.receiptSizeBytes} > 0 and ${table.receiptSizeBytes} <= 1048576`
    ),
    check(
      'agent_run_receipts_runner_id_nonempty',
      sql`length(${table.runnerId}) between 1 and 128`
    )
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
    ruleId: text('rule_id').notNull(),
    ruleVersion: text('rule_version').notNull(),
    signalClass: riskSignalClassEnum('signal_class').notNull(),
    severity: riskSeverityEnum('severity').notNull(),
    summary: text('summary').notNull(),
    details: jsonb('details')
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    evidenceReferences: jsonb('evidence_references')
      .$type<readonly Readonly<{type: string; id: string}>[]>()
      .default(sql`'[]'::jsonb`)
      .notNull(),
    impact: text('impact').notNull(),
    ownerActorId: uuid('owner_actor_id').references(() => actors.id, {
      onDelete: 'set null'
    }),
    nextAction: text('next_action').notNull(),
    observedAt: timestamp('observed_at', {withTimezone: true}).notNull(),
    deduplicationKey: text('deduplication_key').notNull(),
    resolvedAt: timestamp('resolved_at', {withTimezone: true}),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    index('risk_signals_project_severity_idx').on(
      table.projectId,
      table.severity,
      table.resolvedAt
    ),
    uniqueIndex('risk_signals_project_unresolved_dedup_unique')
      .on(table.projectId, table.deduplicationKey)
      .where(sql`${table.resolvedAt} is null`)
  ]
);

export const riskSignalDispositionEvents = pgTable(
  'risk_signal_disposition_events',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, {onDelete: 'restrict'}),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, {onDelete: 'restrict'}),
    riskSignalId: uuid('risk_signal_id')
      .notNull()
      .references(() => riskSignals.id, {onDelete: 'restrict'}),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => actors.id, {onDelete: 'restrict'}),
    commandId: text('command_id').notNull(),
    correlationId: text('correlation_id').notNull(),
    kind: riskSignalDispositionKindEnum('kind').notNull(),
    reason: text('reason').notNull(),
    expiresAt: timestamp('expires_at', {withTimezone: true}).notNull(),
    reentryCondition: text('reentry_condition').notNull(),
    version: integer('version').notNull(),
    occurredAt: timestamp('occurred_at', {withTimezone: true}).notNull(),
    createdAt: createdAt()
  },
  (table) => [
    uniqueIndex('risk_signal_disposition_events_workspace_command_unique')
      .on(table.workspaceId, table.commandId),
    uniqueIndex('risk_signal_disposition_events_signal_version_unique')
      .on(table.riskSignalId, table.version),
    index('risk_signal_disposition_events_project_signal_idx')
      .on(table.projectId, table.riskSignalId, table.version),
    check(
      'risk_signal_disposition_events_reason_bounded',
      sql`${table.reason} in ('investigating', 'awaiting_evidence', 'planned_maintenance', 'external_dependency')`
    ),
    check(
      'risk_signal_disposition_events_expiry_after_occurrence',
      sql`${table.expiresAt} > ${table.occurredAt}`
    ),
    check(
      'risk_signal_disposition_events_reentry_condition',
      sql`${table.reentryCondition} = 'risk_unresolved_at_expiry'`
    ),
    check(
      'risk_signal_disposition_events_version_positive',
      sql`${table.version} > 0`
    )
  ]
);

export const notificationIntents = pgTable(
  'notification_intents',
  {
    id: id(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, {onDelete: 'restrict'}),
    riskSignalId: uuid('risk_signal_id')
      .notNull()
      .references(() => riskSignals.id, {onDelete: 'restrict'}),
    audienceKind: notificationAudienceKindEnum('audience_kind').notNull(),
    audienceActorId: uuid('audience_actor_id').references(() => actors.id, {
      onDelete: 'restrict'
    }),
    category: text('category').notNull(),
    severity: riskSeverityEnum('severity').notNull(),
    summary: text('summary').notNull(),
    nextAction: text('next_action').notNull(),
    evidenceReferences: jsonb('evidence_references')
      .$type<readonly Readonly<{type: string; id: string}>[]>()
      .default(sql`'[]'::jsonb`)
      .notNull(),
    deduplicationKey: text('deduplication_key').notNull(),
    createdAt: createdAt()
  },
  (table) => [
    uniqueIndex('notification_intents_risk_signal_unique')
      .on(table.riskSignalId),
    uniqueIndex('notification_intents_project_dedup_unique')
      .on(table.projectId, table.deduplicationKey),
    index('notification_intents_project_created_idx')
      .on(table.projectId, table.createdAt),
    check(
      'notification_intents_audience_shape',
      sql`(${table.audienceKind} = 'actor' and ${table.audienceActorId} is not null)
        or (${table.audienceKind} = 'project_operators' and ${table.audienceActorId} is null)`
    ),
    check(
      'notification_intents_category_key',
      sql`${table.category} ~ '^[a-z][a-z0-9_]{0,127}$'`
    ),
    check(
      'notification_intents_dedup_key_bounded',
      sql`length(${table.deduplicationKey}) between 1 and 200`
    ),
    check(
      'notification_intents_actionable',
      sql`length(btrim(${table.summary})) between 1 and 500
        and length(btrim(${table.nextAction})) between 1 and 500`
    )
  ]
);

export const notificationDeliveryReceipts = pgTable(
  'notification_delivery_receipts',
  {
    id: id(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, {onDelete: 'restrict'}),
    notificationIntentId: uuid('notification_intent_id')
      .notNull()
      .references(() => notificationIntents.id, {onDelete: 'restrict'}),
    commandId: text('command_id').notNull(),
    correlationId: text('correlation_id').notNull(),
    status: notificationDeliveryStatusEnum('status').notNull(),
    failureCode: text('failure_code'),
    version: integer('version').notNull(),
    occurredAt: timestamp('occurred_at', {withTimezone: true}).notNull(),
    createdAt: createdAt()
  },
  (table) => [
    uniqueIndex('notification_delivery_receipts_project_command_unique')
      .on(table.projectId, table.commandId),
    uniqueIndex('notification_delivery_receipts_intent_version_unique')
      .on(table.notificationIntentId, table.version),
    index('notification_delivery_receipts_project_intent_idx')
      .on(table.projectId, table.notificationIntentId, table.version),
    check(
      'notification_delivery_receipts_failure_shape',
      sql`(${table.status} = 'failed' and ${table.failureCode} ~ '^[a-z][a-z0-9_]{0,63}$')
        or (${table.status} <> 'failed' and ${table.failureCode} is null)`
    ),
    check(
      'notification_delivery_receipts_version_positive',
      sql`${table.version} > 0`
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
