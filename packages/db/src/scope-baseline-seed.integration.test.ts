import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {asc} from 'drizzle-orm';
import {migrate} from 'drizzle-orm/node-postgres/migrator';
import {Pool} from 'pg';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {dropDatabaseWhenDisconnected} from './integration-test-utils';
import {
  actors,
  createDatabase,
  projectMemberships,
  projects,
  projectScopeBaselineVersions,
  projectScopeOutcomeObservations,
  projectScopeOutcomes,
  workspaces
} from './index';

const databaseUrl = process.env.DATABASE_URL;
if (process.env.CI && databaseUrl === undefined) {
  throw new Error('DATABASE_URL is required for scope baseline migration tests in CI.');
}
const describePostgres = databaseUrl === undefined ? describe.skip : describe;
const databaseName = `fai_scope_baseline_${randomUUID().replaceAll('-', '')}`;
const migrationSql = await readFile(
  fileURLToPath(new URL('../drizzle/0036_seed_approved_scope_baselines.sql', import.meta.url)),
  'utf8'
);

describePostgres('approved scope baseline migration', () => {
  let adminPool: Pool;
  let testPool: Pool;
  let db: ReturnType<typeof createDatabase>['db'];
  let msaId: string;
  let asconId: string;

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
    await migrate(db, {migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url))});

    const [workspace] = await db.insert(workspaces).values({name: 'fAI Studio', slug: `scope-seed-${randomUUID()}`}).returning();
    if (workspace === undefined) throw new Error('workspace fixture failed');
    const [owner] = await db.insert(actors).values({
      workspaceId: workspace.id,
      type: 'human', role: 'workspace_admin', displayName: 'Vladimir', authMode: 'user', externalSubject: `github:user:${randomUUID()}`
    }).returning();
    if (owner === undefined) throw new Error('owner fixture failed');
    const insertedProjects = await db.insert(projects).values([
      {workspaceId: workspace.id, name: 'MSA', slug: 'msa'},
      {workspaceId: workspace.id, name: 'ASCON', slug: 'ascon'}
    ]).returning();
    const msa = insertedProjects.find((project) => project.slug === 'msa');
    const ascon = insertedProjects.find((project) => project.slug === 'ascon');
    if (msa === undefined || ascon === undefined) throw new Error('project fixture failed');
    msaId = msa.id;
    asconId = ascon.id;
    await db.insert(projectMemberships).values([
      {projectId: msa.id, actorId: owner.id, roles: ['project_owner']},
      {projectId: ascon.id, actorId: owner.id, roles: ['project_owner']}
    ]);
  }, 30_000);

  afterAll(async () => {
    await testPool?.end();
    if (adminPool !== undefined) {
      try {
        await dropDatabaseWhenDisconnected(adminPool, databaseName);
      } finally {
        await adminPool.end();
      }
    }
  }, 30_000);

  it('creates the canonical 45/100 MSA and 0/100 ASCON baselines once without overwriting them', async () => {
    await testPool.query(migrationSql);
    const baselines = await db.select().from(projectScopeBaselineVersions).orderBy(asc(projectScopeBaselineVersions.projectId));
    const outcomes = await db.select().from(projectScopeOutcomes).orderBy(asc(projectScopeOutcomes.key));
    const observations = await db.select().from(projectScopeOutcomeObservations).orderBy(asc(projectScopeOutcomeObservations.projectId));

    expect(baselines).toHaveLength(2);
    expect(outcomes.filter((outcome) => outcome.baselineId === baselines.find((baseline) => baseline.projectId === msaId)?.id)
      .map(({key, weight, state}) => ({key, weight, state}))).toEqual(expect.arrayContaining([
      {key: 'foundation', weight: 5, state: 'accepted'},
      {key: 'matching', weight: 20, state: 'accepted'},
      {key: 'documents_ocr', weight: 20, state: 'accepted'},
      {key: 'onec_api', weight: 20, state: 'review'},
      {key: 'feedback', weight: 10, state: 'in_progress'},
      {key: 'security', weight: 10, state: 'in_progress'},
      {key: 'e2e', weight: 10, state: 'in_progress'},
      {key: 'release', weight: 5, state: 'not_started'}
    ]));
    expect(observations.map(({projectId, acceptedWeight, totalWeight}) => ({projectId, acceptedWeight, totalWeight}))).toEqual(expect.arrayContaining([
      {projectId: msaId, acceptedWeight: 45, totalWeight: 100},
      {projectId: asconId, acceptedWeight: 0, totalWeight: 100}
    ]));

    await testPool.query(migrationSql);
    expect(await db.select().from(projectScopeBaselineVersions)).toHaveLength(2);
    expect(await db.select().from(projectScopeOutcomes)).toHaveLength(16);
    expect(await db.select().from(projectScopeOutcomeObservations)).toHaveLength(2);
  });
});
