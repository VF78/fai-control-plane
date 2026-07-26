import {randomUUID} from 'node:crypto';
import {and, eq} from 'drizzle-orm';
import {migrate} from 'drizzle-orm/node-postgres/migrator';
import {Pool} from 'pg';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {
  createDatabase,
  createPostgresDailyPmReportProducer,
  createPostgresQaIntakeProducer,
  canonicalEvents,
  dailyPmReports,
  projectTrackerRepositoryScopes,
  scheduledJobs,
  secretRefs
} from './index';
import {dropDatabaseWhenDisconnected} from './integration-test-utils';

const databaseUrl = process.env.DATABASE_URL;
if (process.env.CI && databaseUrl === undefined) {
  throw new Error('DATABASE_URL is required for PostgreSQL integration tests in CI.');
}
const describePostgres = databaseUrl === undefined ? describe.skip : describe;
const databaseName = `fai_daily_pm_report_test_${randomUUID().replaceAll('-', '')}`;
const ids = {
  workspace: randomUUID(),
  msa: randomUUID(),
  ascon: randomUUID(),
  other: randomUUID(),
  secret: randomUUID()
};

describePostgres('PostgreSQL daily PM report producer', () => {
  let adminPool: Pool;
  let testPool: Pool;
  let db: ReturnType<typeof createDatabase>['db'];
  const now = new Date('2026-07-26T09:00:00.000Z');

  beforeAll(async () => {
    const adminUrl = new URL(databaseUrl!);
    adminUrl.pathname = '/postgres';
    adminPool = new Pool({connectionString: adminUrl.toString()});
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    const testUrl = new URL(databaseUrl!);
    testUrl.pathname = `/${databaseName}`;
    const created = createDatabase(testUrl.toString());
    db = created.db;
    testPool = created.pool;
    await migrate(db, {migrationsFolder: new URL('../drizzle', import.meta.url).pathname});
    await testPool.query(
      `INSERT INTO workspaces (id, name, slug) VALUES ($1, 'Workspace', $2)`,
      [ids.workspace, `workspace-${randomUUID()}`]
    );
    await testPool.query(
      `INSERT INTO projects (id, workspace_id, name, slug) VALUES
       ($1, $2, 'MSA', 'msa'), ($3, $2, 'ascon', 'ascon'), ($4, $2, 'Other', 'other')`,
      [ids.msa, ids.workspace, ids.ascon, ids.other]
    );
    await db.insert(secretRefs).values({
      id: ids.secret,
      workspaceId: ids.workspace,
      provider: 'test',
      reference: 'daily-pm-report',
      scope: []
    });
    await db.insert(projectTrackerRepositoryScopes).values([
      {
        projectId: ids.msa,
        provider: 'github',
        repositoryOwner: 'VF78',
        repositoryName: 'MSA',
        repositoryExternalId: 'github:repository:msa',
        credentialRefId: ids.secret
      },
      {
        projectId: ids.ascon,
        provider: 'github',
        repositoryOwner: 'VF78',
        repositoryName: 'ascon',
        repositoryExternalId: 'github:repository:ascon',
        credentialRefId: ids.secret
      }
    ]);
    await testPool.query(
      `INSERT INTO work_items (project_id, title, status, blocked) VALUES
       ($1, 'Backlog', 'backlog', false), ($1, 'Ready', 'ready', true),
       ($1, 'Dev', 'in_dev', true), ($1, 'QA', 'qa', false),
       ($1, 'Acceptance', 'acceptance', false), ($1, 'Done', 'done', false),
       ($2, 'Other project', 'backlog', true)`,
      [ids.msa, ids.other]
    );
    await testPool.query(
      `INSERT INTO risk_signals (project_id, code, severity, summary, resolved_at) VALUES
       ($1, 'yellow', 'yellow', 'Yellow', null), ($1, 'red', 'red', 'Red', null),
       ($1, 'resolved', 'red', 'Resolved', $2)`,
      [ids.msa, now]
    );
    await testPool.query(
      `INSERT INTO outbox_events (
         workspace_id, project_id, destination, event_type, idempotency_key, payload, status
       ) VALUES
       ($1, $2, 'github', 'github.project_status.write.v1', 'failed-writeback', '{}', 'failed'),
       ($1, $2, 'github', 'other', 'not-a-writeback', '{}', 'failed')`,
      [ids.workspace, ids.msa]
    );
    await testPool.query(
      `INSERT INTO tracker_snapshot_operations (
         workspace_id, project_id, provider, repository_external_id, mode, request_hash,
         snapshot_external_version, result, created_at
       ) VALUES ($1, $2, 'github', 'github:repository:msa', 'synchronize', 'daily-report',
         'github:sha256:daily-report', '{"status":"applied"}', $3)`,
      [ids.workspace, ids.msa, new Date(now.getTime() - 5 * 60 * 1_000)]
    );
  });

  afterAll(async () => {
    await testPool?.end();
    if (adminPool !== undefined) {
      try {
        await dropDatabaseWhenDisconnected(adminPool, databaseName);
      } finally {
        await adminPool.end();
      }
    }
  });

  it('is deterministic and idempotent while a failed project does not stop another project', async () => {
    await testPool.query(`
      CREATE FUNCTION fail_msa_daily_pm_report() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.project_id = '${ids.msa}'::uuid THEN RAISE EXCEPTION 'forced_msa_failure'; END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER fail_msa_daily_pm_report BEFORE INSERT ON daily_pm_reports
      FOR EACH ROW EXECUTE FUNCTION fail_msa_daily_pm_report();
    `);
    const producer = createPostgresDailyPmReportProducer(db, {now: () => now});
    await expect(producer.run()).rejects.toThrow();

    expect(await db.select().from(dailyPmReports).where(eq(
      dailyPmReports.projectId, ids.ascon
    ))).toHaveLength(1);
    expect(await db.select().from(scheduledJobs).where(and(
      eq(scheduledJobs.projectId, ids.msa),
      eq(scheduledJobs.name, 'daily_pm_report'),
      eq(scheduledJobs.status, 'unhealthy')
    ))).toHaveLength(1);

    await testPool.query('DROP TRIGGER fail_msa_daily_pm_report ON daily_pm_reports');
    await producer.run();
    const firstReports = await db.select().from(dailyPmReports)
      .orderBy(dailyPmReports.projectId);
    await testPool.query(`
      CREATE FUNCTION fail_daily_pm_report_replay() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'daily_pm_report_recomputed';
      END;
      $$;
      CREATE TRIGGER fail_daily_pm_report_replay BEFORE INSERT ON daily_pm_reports
      FOR EACH ROW EXECUTE FUNCTION fail_daily_pm_report_replay();
    `);
    await producer.run();
    const reports = await db.select().from(dailyPmReports).orderBy(dailyPmReports.projectId);

    expect(reports).toEqual(firstReports);
    expect(reports).toHaveLength(2);
    expect(reports.find((report) => report.projectId === ids.other)).toBeUndefined();
    expect(reports.find((report) => report.projectId === ids.msa)?.payload).toEqual({
      schemaVersion: 1,
      timezone: 'UTC',
      reportDate: '2026-07-26',
      generatedAt: '2026-07-26T09:00:00.000Z',
      dataAsOf: '2026-07-26T09:00:00.000Z',
      workItems: {
        statusCounts: {
          backlog: 1,
          ready: 1,
          in_dev: 1,
          qa: 1,
          acceptance: 1,
          done: 1
        },
        blockedCount: 2
      },
      riskSignals: {unresolvedCountsBySeverity: {green: 0, yellow: 1, red: 1}},
      approvals: {pendingCount: 0},
      github: {
        failedWritebackCount: 1,
        latestSuccessfulTrackerSnapshot: {
          at: '2026-07-26T08:55:00.000Z',
          freshness: 'fresh'
        }
      }
    });
  });

  it('persists one no-work QA intake result without enqueuing a handoff', async () => {
    const producer = createPostgresQaIntakeProducer(db, {now: () => now});

    await producer.run();
    await producer.run();

    expect(await db.select().from(canonicalEvents).where(and(
      eq(canonicalEvents.projectId, ids.msa),
      eq(canonicalEvents.eventType, 'qa_intake.no_work.v1')
    ))).toEqual([expect.objectContaining({
      payload: {
        schemaVersion: 1,
        runKey: '2026-07-26',
        outcome: 'no_work',
        observedAt: '2026-07-26T09:00:00.000Z',
        workItems: []
      }
    })]);
    expect(await db.select().from(scheduledJobs).where(and(
      eq(scheduledJobs.projectId, ids.msa),
      eq(scheduledJobs.name, 'qa_intake'),
      eq(scheduledJobs.status, 'active')
    ))).toHaveLength(1);
  });
});
