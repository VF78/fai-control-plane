import {randomUUID} from 'node:crypto';
import {and, eq, isNull} from 'drizzle-orm';
import {migrate} from 'drizzle-orm/node-postgres/migrator';
import {Pool} from 'pg';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {
  createDatabase,
  createPostgresPmReportCheckProducer,
  projectTrackerRepositoryScopes,
  riskSignals,
  scheduledJobs,
  secretRefs
} from './index';
import {dropDatabaseWhenDisconnected} from './integration-test-utils';

const databaseUrl = process.env.DATABASE_URL;
if (process.env.CI && databaseUrl === undefined) {
  throw new Error('DATABASE_URL is required for PostgreSQL integration tests in CI.');
}
const describePostgres = databaseUrl === undefined ? describe.skip : describe;
const databaseName = `fai_pm_report_check_test_${randomUUID().replaceAll('-', '')}`;
const ids = {
  workspace: randomUUID(),
  msa: randomUUID(),
  ascon: randomUUID(),
  other: randomUUID(),
  secret: randomUUID()
};

describePostgres('PostgreSQL PM report check producer', () => {
  let adminPool: Pool;
  let testPool: Pool;
  let db: ReturnType<typeof createDatabase>['db'];
  const now = new Date('2026-07-26T09:10:00.000Z');

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
      reference: 'pm-report-check',
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
      `INSERT INTO daily_pm_reports (project_id, report_date, payload) VALUES
       ($1, '2026-07-26', '{"schemaVersion":1,"timezone":"UTC","reportDate":"2026-07-26","generatedAt":"2026-07-26T09:00:00.000Z","dataAsOf":"2026-07-26T09:00:00.000Z","workItems":{"statusCounts":{"backlog":0,"ready":0,"in_dev":0,"qa":0,"acceptance":0,"done":0},"blockedCount":0},"riskSignals":{"unresolvedCountsBySeverity":{"green":0,"yellow":0,"red":0}},"approvals":{"pendingCount":0},"github":{"failedWritebackCount":0,"latestSuccessfulTrackerSnapshot":{"at":null,"freshness":"missing"}}}')`,
      [ids.ascon]
    );
    await testPool.query(
      `INSERT INTO risk_signals (
         project_id, code, rule_id, rule_version, signal_class, severity, summary,
         details, evidence_references, impact, next_action, observed_at, deduplication_key
       ) VALUES (
         $1, 'daily_pm_report_missing', 'daily_pm_report_missing', '1', 'inference',
         'yellow', 'Old primary', '{}', '[]', 'Old impact', 'generate_daily_pm_report',
         $2, 'daily_pm_report_missing'
       )`,
      [ids.ascon, now]
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

  it('reconciles missing reports deterministically and continues after a project failure', async () => {
    const producer = createPostgresPmReportCheckProducer(db, {now: () => now});
    await producer.run();

    const initialMsaSignals = await db.select().from(riskSignals).where(and(
      eq(riskSignals.projectId, ids.msa),
      eq(riskSignals.code, 'daily_pm_report_missing'),
      isNull(riskSignals.resolvedAt)
    ));
    expect(initialMsaSignals).toEqual([expect.objectContaining({
      severity: 'yellow',
      summary: 'Daily PM report is missing.',
      details: {
        reportDate: '2026-07-26',
        reportExists: false,
        observedAt: '2026-07-26T09:10:00.000Z'
      },
      ruleId: 'daily_pm_report_missing',
      ruleVersion: '1',
      signalClass: 'inference',
      evidenceReferences: [],
      impact: 'Operators lack the expected daily delivery summary.',
      ownerActorId: null,
      nextAction: 'generate_daily_pm_report',
      observedAt: now,
      deduplicationKey: 'daily_pm_report_missing'
    })]);
    expect(await db.select().from(riskSignals).where(and(
      eq(riskSignals.projectId, ids.ascon),
      eq(riskSignals.code, 'daily_pm_report_missing'),
      isNull(riskSignals.resolvedAt)
    ))).toHaveLength(0);

    await producer.run();
    expect(await db.select().from(riskSignals).where(and(
      eq(riskSignals.projectId, ids.msa),
      eq(riskSignals.code, 'daily_pm_report_missing'),
      isNull(riskSignals.resolvedAt)
    ))).toHaveLength(1);
    expect(await db.select().from(riskSignals).where(and(
      eq(riskSignals.projectId, ids.ascon),
      eq(riskSignals.code, 'daily_pm_report_missing')
    ))).toHaveLength(1);

    const failedAt = new Date('2026-07-27T09:10:00.000Z');
    await testPool.query(`
      CREATE FUNCTION fail_msa_pm_report_check() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.project_id = '${ids.msa}'::uuid THEN RAISE EXCEPTION 'forced_msa_failure'; END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER fail_msa_pm_report_check BEFORE INSERT OR UPDATE ON risk_signals
      FOR EACH ROW EXECUTE FUNCTION fail_msa_pm_report_check();
    `);
    const failingProducer = createPostgresPmReportCheckProducer(db, {now: () => failedAt});
    await expect(failingProducer.run()).rejects.toThrow();

    expect(await db.select().from(riskSignals).where(and(
      eq(riskSignals.projectId, ids.ascon),
      eq(riskSignals.code, 'daily_pm_report_missing'),
      isNull(riskSignals.resolvedAt)
    ))).toHaveLength(1);
    expect(await db.select().from(scheduledJobs).where(and(
      eq(scheduledJobs.projectId, ids.msa),
      eq(scheduledJobs.name, 'pm_report_check'),
      eq(scheduledJobs.status, 'unhealthy')
    ))).toHaveLength(1);
  });
});
