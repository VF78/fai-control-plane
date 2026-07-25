import {getTableColumns, getTableName} from 'drizzle-orm';
import {describe, expect, it} from 'vitest';
import * as schema from './schema';

const requiredTables = [
  schema.workspaces,
  schema.projects,
  schema.milestones,
  schema.workItems,
  schema.statusTransitions,
  schema.prLinks,
  schema.buildChecks,
  schema.deployments,
  schema.actors,
  schema.agentProfiles,
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
  schema.auditEvents,
  schema.dashboardSnapshots
];

describe('canonical schema foundation', () => {
  it('contains every entity required by the MVP specification', () => {
    expect(requiredTables.map(getTableName)).toEqual([
      'workspaces',
      'projects',
      'milestones',
      'work_items',
      'status_transitions',
      'pr_links',
      'build_checks',
      'deployments',
      'actors',
      'agent_profiles',
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
});
