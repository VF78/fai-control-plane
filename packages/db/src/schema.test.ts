import {getTableColumns, getTableName} from 'drizzle-orm';
import {describe, expect, it} from 'vitest';
import * as schema from './schema';

const requiredTables = [
  schema.workspaces,
  schema.projects,
  schema.projectMemberships,
  schema.actorExternalIdentities,
  schema.conversationBindings,
  schema.conversationParticipants,
  schema.conversationMessages,
  schema.resourceAccessGrants,
  schema.milestones,
  schema.workItems,
  schema.statusTransitions,
  schema.trackerBindings,
  schema.trackerSnapshotOperations,
  schema.prLinks,
  schema.buildChecks,
  schema.deployments,
  schema.actors,
  schema.agentProfiles,
  schema.runtimeRegistrations,
  schema.workspaceInstructionVersions,
  schema.agentProfileInstructionVersions,
  schema.runbooks,
  schema.scheduledJobs,
  schema.incomingEvents,
  schema.canonicalEvents,
  schema.taskPackets,
  schema.agentRuns,
  schema.approvalRequests,
  schema.accessRequests,
  schema.artifacts,
  schema.riskSignals,
  schema.riskSignalDispositionEvents,
  schema.notificationIntents,
  schema.notificationDeliveryReceipts,
  schema.secretRefs,
  schema.projectTrackerRepositoryScopes,
  schema.auditEvents,
  schema.dashboardSnapshots,
  schema.projectScopeBaselineVersions,
  schema.projectScopeOutcomes,
  schema.projectScopeOutcomeObservations
];

describe('canonical schema foundation', () => {
  it('contains every entity required by the MVP specification', () => {
    expect(requiredTables.map(getTableName)).toEqual([
      'workspaces',
      'projects',
      'project_memberships',
      'actor_external_identities',
      'conversation_bindings',
      'conversation_participants',
      'conversation_messages',
      'resource_access_grants',
      'milestones',
      'work_items',
      'status_transitions',
      'tracker_bindings',
      'tracker_snapshot_operations',
      'pr_links',
      'build_checks',
      'deployments',
      'actors',
      'agent_profiles',
      'runtime_registrations',
      'workspace_instruction_versions',
      'agent_profile_instruction_versions',
      'runbooks',
      'scheduled_jobs',
      'incoming_events',
      'canonical_events',
      'task_packets',
      'agent_runs',
      'approval_requests',
      'access_requests',
      'artifacts',
      'risk_signals',
      'risk_signal_disposition_events',
      'notification_intents',
      'notification_delivery_receipts',
      'secret_refs',
      'project_tracker_repository_scopes',
      'audit_events',
      'dashboard_snapshots',
      'project_scope_baseline_versions',
      'project_scope_outcomes',
      'project_scope_outcome_observations'
    ]);
  });

  it('never creates a business column for secret values', () => {
    const columnNames = Object.values(schema)
      .filter(
        (value): value is (typeof requiredTables)[number] =>
          typeof value === 'object' &&
          value !== null &&
          Symbol.for('drizzle:Name') in value
      )
      .flatMap((table) =>
        Object.values(getTableColumns(table)).map((column) => column.name)
      );

    expect(columnNames).not.toContain('secret_value');
    expect(columnNames).not.toContain('value');
  });

  it('does not expose raw headers on incoming event persistence', () => {
    const incomingEventColumns = Object.values(
      getTableColumns(schema.incomingEvents)
    ).map((column) => column.name);

    expect(incomingEventColumns).not.toContain('headers');
    expect(incomingEventColumns).not.toContain('payload');
    expect(incomingEventColumns).toContain('verification');
    expect(incomingEventColumns).toContain('sanitized_payload');
  });

  it('persists only bounded conversation observations, never raw provider payloads or bodies', () => {
    expect(Object.values(getTableColumns(schema.conversationBindings)).map(({name}) => name))
      .toContain('active');
    const messageColumns = Object.values(
      getTableColumns(schema.conversationMessages)
    ).map((column) => column.name);
    expect(messageColumns).toEqual(expect.arrayContaining([
      'participant_id',
      'sent_at',
      'reply_to_message_ref',
      'thread_ref',
      'text',
      'attachments'
    ]));
    for (const forbidden of [
      'raw_payload',
      'attachment_body',
      'provider_token',
      'webhook_secret'
    ]) expect(messageColumns).not.toContain(forbidden);
  });

  it('models optimistic versions and atomic command receipt state', () => {
    for (const table of [
      schema.agentRuns,
      schema.approvalRequests,
      schema.accessRequests,
      schema.projectMemberships,
      schema.actorExternalIdentities,
      schema.resourceAccessGrants,
      schema.runtimeRegistrations
    ]) {
      expect(getTableColumns(table)).toHaveProperty('version');
    }

    const receiptColumns = Object.values(
      getTableColumns(schema.commandReceipts)
    ).map((column) => column.name);
    expect(receiptColumns).toEqual(
      expect.arrayContaining([
        'workspace_id',
        'idempotency_key',
        'request_hash',
        'command_id',
        'correlation_id',
        'state',
        'result',
        'created_at',
        'completed_at'
      ])
    );
  });

  it('persists bounded evidence lifecycle fields on snapshot-backed facts', () => {
    for (const table of [
      schema.trackerBindings,
      schema.prLinks,
      schema.buildChecks
    ]) {
      expect(Object.values(getTableColumns(table)).map(({name}) => name)).toEqual(
        expect.arrayContaining([
          'external_version',
          'observed_at',
          'confirmed_at',
          'evidence_state',
          'conflict_reason'
        ])
      );
    }
  });

  it('persists canonical, deduplicated risk signal provenance and action fields', () => {
    expect(Object.values(getTableColumns(schema.riskSignals)).map(({name}) => name)).toEqual(
      expect.arrayContaining([
        'rule_id',
        'rule_version',
        'signal_class',
        'evidence_references',
        'impact',
        'owner_actor_id',
        'next_action',
        'observed_at',
        'deduplication_key'
      ])
    );
    expect(Object.values(getTableColumns(
      schema.riskSignalDispositionEvents
    )).map(({name}) => name)).toEqual(expect.arrayContaining([
      'risk_signal_id',
      'command_id',
      'kind',
      'reason',
      'expires_at',
      'reentry_condition',
      'version',
      'occurred_at'
    ]));
    expect(Object.values(getTableColumns(schema.notificationIntents))
      .map(({name}) => name)).toEqual(expect.arrayContaining([
      'project_id',
      'risk_signal_id',
      'audience_kind',
      'audience_actor_id',
      'category',
      'severity',
      'summary',
      'next_action',
      'evidence_references',
      'deduplication_key'
    ]));
    expect(Object.values(getTableColumns(
      schema.notificationDeliveryReceipts
    )).map(({name}) => name)).toEqual(expect.arrayContaining([
      'project_id',
      'notification_intent_id',
      'command_id',
      'correlation_id',
      'status',
      'failure_code',
      'version',
      'occurred_at'
    ]));
  });
});
