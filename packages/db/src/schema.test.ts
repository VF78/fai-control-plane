import {getTableColumns, getTableName} from 'drizzle-orm';
import {describe, expect, it} from 'vitest';
import * as schema from './schema';

const requiredTables = [
  schema.workspaces,
  schema.projects,
  schema.projectMemberships,
  schema.actorExternalIdentities,
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
  schema.secretRefs,
  schema.projectTrackerRepositoryScopes,
  schema.auditEvents,
  schema.dashboardSnapshots
];

describe('canonical schema foundation', () => {
  it('contains every entity required by the MVP specification', () => {
    expect(requiredTables.map(getTableName)).toEqual([
      'workspaces',
      'projects',
      'project_memberships',
      'actor_external_identities',
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
      'secret_refs',
      'project_tracker_repository_scopes',
      'audit_events',
      'dashboard_snapshots'
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
});
