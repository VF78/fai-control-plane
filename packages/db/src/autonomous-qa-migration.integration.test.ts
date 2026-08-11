import {randomUUID} from 'node:crypto';
import {cp, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {migrate} from 'drizzle-orm/node-postgres/migrator';
import {Pool} from 'pg';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {createDatabase} from './index';
import {dropDatabaseWhenDisconnected} from './integration-test-utils';

const databaseUrl = process.env.DATABASE_URL;
if (process.env.CI && databaseUrl === undefined) {
  throw new Error('DATABASE_URL is required for migration integration tests in CI.');
}
const describePostgres = databaseUrl === undefined ? describe.skip : describe;
const databaseName = `fai_autonomous_qa_migration_${randomUUID().replaceAll('-', '')}`;

describePostgres('0055 autonomous QA receipt binding migration', () => {
  let adminPool: Pool;
  let testPool: Pool;
  let legacyMigrations: string;
  const ids = {
    workspace: randomUUID(), project: randomUUID(), owner: randomUUID(), agent: randomUUID(),
    profile: randomUUID(), plan: randomUUID(), planVersion: randomUUID(), protocol: randomUUID(),
    secret: randomUUID(), repository: randomUUID(),
    works: [randomUUID(), randomUUID(), randomUUID()],
    events: [randomUUID(), randomUUID(), randomUUID()],
    packets: [randomUUID(), randomUUID(), randomUUID()],
    manualReceipt: randomUUID(), run: randomUUID()
  } as const;

  beforeAll(async () => {
    const adminUrl = new URL(databaseUrl!); adminUrl.pathname = '/postgres';
    adminPool = new Pool({connectionString: adminUrl.toString()});
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    const testUrl = new URL(databaseUrl!); testUrl.pathname = `/${databaseName}`;
    const created = createDatabase(testUrl.toString()); testPool = created.pool;
    const migrationFolder = fileURLToPath(new URL('../drizzle', import.meta.url));
    legacyMigrations = await mkdtemp(join(tmpdir(), 'fai-autonomous-qa-0054-'));
    await cp(migrationFolder, legacyMigrations, {recursive: true});
    await rm(join(legacyMigrations, '0055_autonomous_qa_receipt_binding.sql'));
    const journalPath = join(legacyMigrations, 'meta', '_journal.json');
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {entries: Array<{idx: number}>};
    journal.entries = journal.entries.filter(({idx}) => idx < 55);
    await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
    await migrate(created.db, {migrationsFolder: legacyMigrations});

    await testPool.query('insert into workspaces (id, name, slug) values ($1, $2, $3)',
      [ids.workspace, 'Autonomous QA migration', `qa-migration-${randomUUID()}`]);
    await testPool.query(`insert into projects (id, workspace_id, name, slug)
      values ($1, $2, 'QA project', $3)`, [ids.project, ids.workspace, `qa-project-${randomUUID()}`]);
    await testPool.query(`insert into actors (id, workspace_id, type, role, display_name, auth_mode)
      values ($1, $3, 'human', 'delivery_lead', 'Owner', 'user'),
             ($2, $3, 'agent', 'agent_operator', 'Hermes', 'agent')`,
    [ids.owner, ids.agent, ids.workspace]);
    await testPool.query(`insert into agent_profiles
      (id, workspace_id, actor_id, runtime_id, runtime_profile, allowed_tools,
       forbidden_surfaces, instructions, settings, enabled, version, config_hash)
      values ($1, $2, $3, 'hermes', 'read_safe', '{}', '{}', '', '{}', true, 1, $4)`,
    [ids.profile, ids.workspace, ids.agent, 'a'.repeat(64)]);
    await testPool.query(`insert into project_plan_drafts
      (id, workspace_id, project_id, state, definition, content_hash, revision,
       created_by_actor_id, approved_by_actor_id, approved_at)
      values ($1, $2, $3, 'approved', '{}', $4, 1, $5, $5, now())`,
    [ids.plan, ids.workspace, ids.project, 'b'.repeat(64), ids.owner]);
    await testPool.query(`insert into project_plan_versions
      (id, workspace_id, project_id, plan_id, version, source_revision, definition,
       content_hash, source_manifest, simulation, approved_by_actor_id, approved_at)
      values ($1, $2, $3, $4, 1, 1, '{}', $5, '[]', '{}', $6, now())`,
    [ids.planVersion, ids.workspace, ids.project, ids.plan, 'c'.repeat(64), ids.owner]);
    await testPool.query(`insert into runbooks
      (id, project_id, name, version, definition, active)
      values ($1, $2, 'Legacy QA protocol', 1, '{}', true)`, [ids.protocol, ids.project]);
    await testPool.query(`insert into secret_refs (id, workspace_id, provider, reference)
      values ($1, $2, 'fixture', $3)`, [ids.secret, ids.workspace, `fixture:${randomUUID()}`]);
    await testPool.query(`insert into project_tracker_repository_scopes
      (id, project_id, provider, repository_owner, repository_name, repository_external_id, credential_ref_id)
      values ($1, $2, 'fixture', 'owner', 'repository', $3, $4)`,
    [ids.repository, ids.project, `repository:${randomUUID()}`, ids.secret]);

    for (let index = 0; index < ids.works.length; index += 1) {
      await testPool.query(`insert into work_items
        (id, project_id, title, status, owner_actor_id, version, source_plan_version_id,
         source_task_key, responsibility, acceptance_evidence)
        values ($1, $2, $3, 'qa', $4, 1, $5, $6, $7, '[]')`,
      [ids.works[index], ids.project, `QA item ${index}`, ids.owner, ids.planVersion,
        `qa-item-${index}`, JSON.stringify({kind: 'agent', agentProfileId: ids.profile})]);
      await testPool.query(`insert into canonical_events
        (id, workspace_id, project_id, event_type, aggregate_type, aggregate_id,
         deduplication_key, payload, occurred_at)
        values ($1, $2, $3, 'qa.packet.prepared', 'work_item', $4, $5, '{}', now())`,
      [ids.events[index], ids.workspace, ids.project, ids.works[index], `qa-packet:${index}`]);
      await testPool.query(`insert into task_packets
        (id, project_id, work_item_id, work_item_version, goal, data_policy, timebox_minutes,
         expected_output_schema, reviewer_actor_id, approver_actor_id, runtime_profile,
         auth_mode, created_from_event_id, content_hash, created_by_actor_id)
        values ($1, $2, $3, 1, 'Run bounded QA', '{}', 30, '{}', $4, $4,
          'read_safe', 'agent', $5, $6, $4)`,
      [ids.packets[index], ids.project, ids.works[index], ids.owner, ids.events[index],
        `${index + 1}`.repeat(64)]);
      await testPool.query(`insert into qa_task_packets
        (task_packet_id, project_id, plan_version_id, work_item_id, work_item_version,
         protocol_id, protocol_version, journey_version, stage_key, responsibility,
         required_evidence, prepared_by_actor_id)
        values ($1, $2, $3, $4, 1, $5, 1, 1, 'qa', $6, array['QA result'], $7)`,
      [ids.packets[index], ids.project, ids.planVersion, ids.works[index], ids.protocol,
        JSON.stringify({kind: 'agent', agentProfileId: ids.profile}), ids.owner]);
    }
    await testPool.query(`insert into qa_review_receipts
      (id, task_packet_id, outcome, checks, artifacts, failures, risks,
       evidence_references, recorded_by_actor_id, command_id)
      values ($1, $2, 'passed', '[]', '[]', '[]', '[]', '[]', $3, $4)`,
    [ids.manualReceipt, ids.packets[0], ids.owner, `qa_review.record.v1:${randomUUID()}`]);
    await testPool.query(`insert into agent_runs
      (id, task_packet_id, agent_profile_id, work_item_id, repository_scope_id,
       confirmed_packet_hash, base_commit, status, idempotency_key, attempt)
      values ($1, $2, $3, $4, $5, $6, $7, 'done', $8, 1)`,
    [ids.run, ids.packets[1], ids.profile, ids.works[1], ids.repository,
      '2'.repeat(64), 'd'.repeat(40), `qa-run:${randomUUID()}`]);

    await migrate(created.db, {migrationsFolder: migrationFolder});
  }, 30_000);

  afterAll(async () => {
    await testPool?.end();
    if (legacyMigrations !== undefined) await rm(legacyMigrations, {recursive: true, force: true});
    if (adminPool !== undefined) {
      try { await dropDatabaseWhenDisconnected(adminPool, databaseName); } finally { await adminPool.end(); }
    }
  }, 30_000);

  it('preserves manual receipts and rejects partial machine binding', async () => {
    const migrated = await testPool.query(`select agent_run_id, agent_run_attempt,
      agent_run_receipt_sha256 from qa_review_receipts where id = $1`, [ids.manualReceipt]);
    expect(migrated.rows[0]).toEqual({agent_run_id: null, agent_run_attempt: null,
      agent_run_receipt_sha256: null});
    await expect(testPool.query(`update qa_review_receipts set agent_run_attempt = 1 where id = $1`,
      [ids.manualReceipt])).rejects.toMatchObject({code: '23514'});
  });

  it('rejects a machine receipt whose run belongs to a different QA packet', async () => {
    await expect(testPool.query(`insert into qa_review_receipts
      (task_packet_id, outcome, checks, artifacts, failures, risks, evidence_references,
       recorded_by_actor_id, agent_run_id, agent_run_attempt, agent_run_receipt_sha256, command_id)
      values ($1, 'passed', '[]', '[]', '[]', '[]', '[]', $2, $3, 1, $4, $5)`,
    [ids.packets[2], ids.agent, ids.run, 'e'.repeat(64), `runner.complete:${randomUUID()}`]))
      .rejects.toMatchObject({code: '23503'});
  });
});
