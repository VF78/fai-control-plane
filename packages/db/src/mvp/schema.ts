import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from 'drizzle-orm/pg-core';
import {sql} from 'drizzle-orm';

const createdAt = () => timestamp('created_at', {withTimezone: true}).notNull().defaultNow();

export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  createdAt: createdAt()
}, (table) => [uniqueIndex('workspaces_slug_unique').on(table.slug)]);

export const actors = pgTable('actors', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  kind: text('kind').notNull(),
  displayName: text('display_name').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: createdAt()
}, (table) => [
  index('actors_workspace_idx').on(table.workspaceId),
  check('actors_kind_check', sql`${table.kind} in ('human', 'agent', 'system')`)
]);

export const oauthLoginAttempts = pgTable('oauth_login_attempts', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  stateHash: text('state_hash').notNull(),
  verifierHash: text('verifier_hash').notNull(),
  expiresAt: timestamp('expires_at', {withTimezone: true}).notNull(),
  consumedAt: timestamp('consumed_at', {withTimezone: true}),
  createdAt: createdAt()
}, (table) => [uniqueIndex('oauth_login_attempts_state_unique').on(table.stateHash)]);

export const operatorSessions = pgTable('operator_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  actorId: uuid('actor_id').notNull().references(() => actors.id),
  tokenHash: text('token_hash').notNull(),
  expiresAt: timestamp('expires_at', {withTimezone: true}).notNull(),
  revokedAt: timestamp('revoked_at', {withTimezone: true}),
  createdAt: createdAt()
}, (table) => [uniqueIndex('operator_sessions_token_unique').on(table.tokenHash)]);

export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  repositoryUrl: text('repository_url').notNull(),
  createdAt: createdAt()
}, (table) => [uniqueIndex('projects_workspace_slug_unique').on(table.workspaceId, table.slug)]);

export const projectMemberships = pgTable('project_memberships', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id),
  actorId: uuid('actor_id').notNull().references(() => actors.id),
  role: text('role').notNull(),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt()
}, (table) => [
  uniqueIndex('project_memberships_actor_unique').on(table.projectId, table.actorId),
  check('project_memberships_role_check', sql`${table.role} in ('project_owner', 'operator', 'contributor', 'client')`)
]);

export const actorExternalIdentities = pgTable('actor_external_identities', {
  id: uuid('id').primaryKey().defaultRandom(),
  actorId: uuid('actor_id').notNull().references(() => actors.id),
  provider: text('provider').notNull(),
  subjectHash: text('subject_hash').notNull(),
  createdAt: createdAt()
}, (table) => [
  uniqueIndex('actor_external_identities_subject_unique').on(table.provider, table.subjectHash),
  index('actor_external_identities_actor_idx').on(table.actorId)
]);

export const projectSourceArtifacts = pgTable('project_source_artifacts', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id),
  createdByActorId: uuid('created_by_actor_id').notNull().references(() => actors.id),
  kind: text('kind').notNull(),
  name: text('name').notNull(),
  mediaType: text('media_type').notNull(),
  sha256: text('sha256').notNull(),
  contentText: text('content_text').notNull(),
  sourceUrl: text('source_url'),
  provenance: text('provenance').notNull(),
  createdAt: createdAt()
}, (table) => [uniqueIndex('project_source_artifacts_kind_hash_unique').on(table.projectId, table.kind, table.sha256)]);

export const secretRefs = pgTable('secret_refs', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  purpose: text('purpose').notNull(),
  locator: text('locator').notNull(),
  createdAt: createdAt()
}, (table) => [uniqueIndex('secret_refs_purpose_unique').on(table.workspaceId, table.purpose)]);

export const trackerBindings = pgTable('tracker_bindings', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id),
  secretRefId: uuid('secret_ref_id').notNull().references(() => secretRefs.id),
  provider: text('provider').notNull(),
  externalProjectId: text('external_project_id').notNull(),
  projectUrl: text('project_url').notNull(),
  repositoryId: text('repository_id').notNull(),
  repositoryUrl: text('repository_url').notNull(),
  cursor: text('cursor'),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: createdAt()
}, (table) => [uniqueIndex('tracker_bindings_project_unique').on(table.projectId)]);

export const trackerSnapshots = pgTable('tracker_snapshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  bindingId: uuid('binding_id').notNull().references(() => trackerBindings.id),
  externalVersion: text('external_version').notNull(),
  cursor: text('cursor'),
  sourceUrl: text('source_url').notNull(),
  facts: jsonb('facts').$type<Readonly<Record<string, unknown>>>().notNull(),
  observedAt: timestamp('observed_at', {withTimezone: true}).notNull(),
  errorCode: text('error_code'),
  createdAt: createdAt()
}, (table) => [uniqueIndex('tracker_snapshots_version_unique').on(table.bindingId, table.externalVersion)]);

export const incomingEvents = pgTable('incoming_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id),
  provider: text('provider').notNull(),
  providerDeliveryId: text('provider_delivery_id').notNull(),
  eventType: text('event_type').notNull(),
  payloadHash: text('payload_hash').notNull(),
  receivedAt: timestamp('received_at', {withTimezone: true}).notNull(),
  createdAt: createdAt()
}, (table) => [uniqueIndex('incoming_events_delivery_unique').on(table.provider, table.providerDeliveryId)]);

export const approvalEvidence = pgTable('approval_evidence', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id),
  actorId: uuid('actor_id').notNull().references(() => actors.id),
  kind: text('kind').notNull(),
  decision: text('decision').notNull(),
  targetReference: text('target_reference').notNull(),
  targetUrl: text('target_url').notNull(),
  targetVersion: text('target_version').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  decidedAt: timestamp('decided_at', {withTimezone: true}).notNull(),
  createdAt: createdAt()
}, (table) => [
  uniqueIndex('approval_evidence_idempotency_unique').on(table.idempotencyKey),
  check('approval_evidence_kind_check', sql`${table.kind} in ('plan', 'internal_operation', 'production', 'acceptance', 'client_uat')`),
  check('approval_evidence_decision_check', sql`${table.decision} in ('approved', 'rejected')`)
]);

export const commandReceipts = pgTable('command_receipts', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id),
  actorId: uuid('actor_id').references(() => actors.id),
  idempotencyKey: text('idempotency_key').notNull(),
  commandType: text('command_type').notNull(),
  resultReference: text('result_reference').notNull(),
  occurredAt: timestamp('occurred_at', {withTimezone: true}).notNull(),
  createdAt: createdAt()
}, (table) => [uniqueIndex('command_receipts_idempotency_unique').on(table.idempotencyKey)]);

export const outboxEvents = pgTable('outbox_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id),
  topic: text('topic').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  payload: jsonb('payload').$type<Readonly<Record<string, unknown>>>().notNull(),
  attempts: integer('attempts').notNull().default(0),
  availableAt: timestamp('available_at', {withTimezone: true}).notNull(),
  claimedAt: timestamp('claimed_at', {withTimezone: true}),
  deliveredAt: timestamp('delivered_at', {withTimezone: true}),
  deliveryReference: text('delivery_reference'),
  lastErrorCode: text('last_error_code'),
  createdAt: createdAt()
}, (table) => [
  uniqueIndex('outbox_events_idempotency_unique').on(table.idempotencyKey),
  index('outbox_events_ready_idx').on(table.availableAt, table.deliveredAt),
  check('outbox_events_topic_check', sql`${table.topic} = 'messenger-notification'`),
  check('outbox_events_attempts_check', sql`${table.attempts} >= 0`)
]);

export const auditEvents = pgTable('audit_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  projectId: uuid('project_id').references(() => projects.id),
  actorId: uuid('actor_id').references(() => actors.id),
  action: text('action').notNull(),
  targetReference: text('target_reference').notNull(),
  correlationId: text('correlation_id').notNull(),
  details: jsonb('details').$type<Readonly<Record<string, unknown>>>().notNull(),
  occurredAt: timestamp('occurred_at', {withTimezone: true}).notNull(),
  createdAt: createdAt()
}, (table) => [index('audit_events_project_time_idx').on(table.projectId, table.occurredAt)]);

export const mvpTables = Object.freeze({
  workspaces,
  actors,
  oauthLoginAttempts,
  operatorSessions,
  projects,
  projectMemberships,
  actorExternalIdentities,
  projectSourceArtifacts,
  secretRefs,
  trackerBindings,
  trackerSnapshots,
  incomingEvents,
  approvalEvidence,
  commandReceipts,
  outboxEvents,
  auditEvents
});
