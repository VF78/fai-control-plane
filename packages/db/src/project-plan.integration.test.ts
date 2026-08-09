import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {sourceArtifactDigest} from '@fai-control-plane/domain';
import {migrate} from 'drizzle-orm/node-postgres/migrator';
import {Pool} from 'pg';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {dropDatabaseWhenDisconnected} from './integration-test-utils';
import {actors, auditEvents, commandReceipts, createDatabase, createPostgresProjectPlanStore, projectMemberships, projectPlanDrafts, projectPlanVersions, projects, workspaces} from './index';

const databaseUrl = process.env.DATABASE_URL;
if (process.env.CI && databaseUrl === undefined) throw new Error('DATABASE_URL is required for project plan integration tests in CI.');
const describePostgres = databaseUrl === undefined ? describe.skip : describe;
const databaseName = `fai_project_plan_${randomUUID().replaceAll('-', '')}`;

describePostgres('project plan persistence', () => {
  let adminPool: Pool; let testPool: Pool; let db: ReturnType<typeof createDatabase>['db'];
  beforeAll(async () => {
    const adminUrl = new URL(databaseUrl!); adminUrl.pathname = '/postgres'; adminPool = new Pool({connectionString: adminUrl.toString()});
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    const testUrl = new URL(databaseUrl!); testUrl.pathname = `/${databaseName}`; const created = createDatabase(testUrl.toString()); db = created.db; testPool = created.pool;
    await migrate(db, {migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url))});
  }, 30_000);
  afterAll(async () => { await testPool?.end(); if (adminPool !== undefined) { try { await dropDatabaseWhenDisconnected(adminPool, databaseName); } finally { await adminPool.end(); } } }, 30_000);

  it('isolates source evidence, saves with CAS, and freezes an approved version and source manifest', async () => {
    const workspaceId = randomUUID(); const projectId = randomUUID(); const otherProjectId = randomUUID(); const ownerId = randomUUID(); const adminId = randomUUID(); const leadId = randomUUID(); const inactiveOwnerId = randomUUID(); const artifactId = randomUUID(); const planId = randomUUID();
    await db.insert(workspaces).values({id: workspaceId, name: 'Plan', slug: `plan-${randomUUID()}`});
    await db.insert(projects).values([{id: projectId, workspaceId, name: 'Project', slug: `project-${randomUUID()}`}, {id: otherProjectId, workspaceId, name: 'Other', slug: `other-${randomUUID()}`}]);
    await db.insert(actors).values([
      {id: ownerId, workspaceId, type: 'human', role: 'developer', displayName: 'PO', authMode: 'user'},
      {id: adminId, workspaceId, type: 'human', role: 'workspace_admin', displayName: 'Admin', authMode: 'user'},
      {id: leadId, workspaceId, type: 'human', role: 'delivery_lead', displayName: 'Lead', authMode: 'user'},
      {id: inactiveOwnerId, workspaceId, type: 'human', role: 'developer', displayName: 'Former PO', authMode: 'user'}
    ]);
    await db.insert(projectMemberships).values([
      {id: randomUUID(), projectId, actorId: ownerId, role: 'project_owner'},
      {id: randomUUID(), projectId: otherProjectId, actorId: ownerId, role: 'project_owner'},
      {id: randomUUID(), projectId, actorId: inactiveOwnerId, role: 'project_owner', active: false}
    ]);
    const store = createPostgresProjectPlanStore(db); const content = 'Подтверждённый результат\nКритерий приёмки';
    const envelope = (type: string, payload: unknown, key: string, actorId = ownerId) => ({commandId: randomUUID(), workspaceId, correlationId: randomUUID(), idempotencyKey: key, issuedAt: '2026-08-09T10:00:00.000Z', actor: {actorId}, type, payload});
    await expect(store.execute({command: envelope('project_plan.source.record', {artifactId, projectId, name: 'Интервью', mediaType: 'text/plain', content, sizeBytes: Buffer.byteLength(content), sha256: sourceArtifactDigest(content), provenance: {kind: 'manager_note', label: 'PO', capturedAt: '2026-08-09T10:00:00.000Z'}}, 'source') as never, requestHash: 'a'.repeat(64), authorized: true})).resolves.toMatchObject({receipt: {result: {ok: true}}});
    const citation = {kind: 'citation' as const, artifactId, locator: {kind: 'line_range' as const, startLine: 1, endLine: 2}};
    const definition = {title: 'План', outcomes: Array.from({length: 5}, (_, index) => ({key: `outcome_${index}`, title: `Результат ${index}`, weight: 20, evidence: citation})), milestones: [{key: 'm1', title: 'Приёмка', checkpoint: 'PO принимает результат', targetAt: null, evidence: citation}], risks: [{key: 'r1', statement: 'Исходные данные изменятся', mitigation: 'Повторная проверка PO', evidence: citation}], tasks: [{key: 't1', title: 'Выполнить результат', outcomeKeys: ['outcome_0'], milestoneKey: 'm1', dependsOn: [], acceptanceEvidence: [{description: 'Критерий выполнен', evidence: citation}]}]};
    await expect(store.execute({command: envelope('project_plan.draft.save', {planId, projectId, expectedRevision: null, definition}, 'draft') as never, requestHash: 'b'.repeat(64), authorized: true})).resolves.toMatchObject({receipt: {result: {ok: true, value: {plan: {revision: 1}}}}});
    await expect(store.simulate({workspaceId, projectId: otherProjectId, actorId: ownerId, definition})).resolves.toMatchObject({readyForApproval: false, blockers: [expect.stringContaining('цитат')]});
    await expect(store.simulate({workspaceId, projectId, actorId: adminId, definition})).resolves.toMatchObject({capabilities: {canEdit: true, canApprove: false}, readyForApproval: false});
    for (const [actorId, key] of [[adminId, 'admin-denied'], [leadId, 'lead-denied'], [inactiveOwnerId, 'inactive-po-denied']] as const) {
      await expect(store.execute({command: envelope('project_plan.approve', {planId, expectedRevision: 1, expectedPlanHash: '0'.repeat(64), expectedSimulationHash: '0'.repeat(64)}, key, actorId) as never, requestHash: key.padEnd(64, '0').slice(0, 64), authorized: true})).resolves.toMatchObject({receipt: {result: {error: {code: 'CAPABILITY_DENIED'}}}});
    }
    const concurrent = [
      {command: envelope('project_plan.draft.save', {planId, projectId, expectedRevision: 1, definition}, 'draft-cas-a'), requestHash: 'e'.repeat(64)},
      {command: envelope('project_plan.draft.save', {planId, projectId, expectedRevision: 1, definition}, 'draft-cas-b'), requestHash: 'f'.repeat(64)}
    ];
    const casResults = await Promise.all(concurrent.map((entry) => store.execute({...entry, command: entry.command as never, authorized: true})));
    expect(casResults.filter((result) => 'receipt' in result && result.receipt.result.ok)).toHaveLength(1);
    expect(casResults.filter((result) => 'receipt' in result && !result.receipt.result.ok && result.receipt.result.error.code === 'VERSION_CONFLICT')).toHaveLength(1);
    await expect(store.execute({command: concurrent[0]!.command as never, requestHash: concurrent[0]!.requestHash, authorized: true})).resolves.toMatchObject({status: 'replayed'});
    const simulation = await store.simulate({workspaceId, projectId, actorId: ownerId, definition});
    expect(simulation).toMatchObject({readyForApproval: true, protocol: {state: 'not_configured'}});
    await expect(store.execute({command: envelope('project_plan.approve', {planId, expectedRevision: 2, expectedPlanHash: simulation!.planHash, expectedSimulationHash: '0'.repeat(64)}, 'approve-stale') as never, requestHash: 'g'.repeat(64), authorized: true})).resolves.toMatchObject({receipt: {result: {error: {code: 'INVALID_COMMAND'}}}});
    expect(await db.select().from(projectPlanVersions)).toHaveLength(0);
    await expect(store.execute({command: envelope('project_plan.approve', {planId, expectedRevision: 2, expectedPlanHash: simulation!.planHash, expectedSimulationHash: simulation!.simulationHash}, 'approve') as never, requestHash: 'c'.repeat(64), authorized: true})).resolves.toMatchObject({receipt: {result: {ok: true, value: {plan: {state: 'approved', approvedVersion: 1}}}}});
    const [version] = await db.select().from(projectPlanVersions);
    expect(version?.sourceManifest).toEqual([{artifactId, version: 1, sha256: sourceArtifactDigest(content)}]);
    expect(await db.select().from(commandReceipts)).toHaveLength(9); expect(await db.select().from(auditEvents)).toHaveLength(9);
    await expect(store.execute({command: envelope('project_plan.draft.save', {planId, projectId, expectedRevision: 3, definition}, 'immutable') as never, requestHash: 'd'.repeat(64), authorized: true})).resolves.toMatchObject({receipt: {result: {error: {code: 'INVALID_TRANSITION'}}}});
    const foreignWorkspaceId = randomUUID(); const foreignProjectId = randomUUID(); const foreignActorId = randomUUID();
    await db.insert(workspaces).values({id: foreignWorkspaceId, name: 'Foreign', slug: `foreign-${randomUUID()}`});
    await db.insert(projects).values({id: foreignProjectId, workspaceId: foreignWorkspaceId, name: 'Foreign', slug: `foreign-project-${randomUUID()}`});
    await db.insert(actors).values({id: foreignActorId, workspaceId: foreignWorkspaceId, type: 'human', role: 'developer', displayName: 'Foreign PO', authMode: 'user'});
    await db.insert(projectMemberships).values({id: randomUUID(), projectId: foreignProjectId, actorId: foreignActorId, role: 'project_owner'});
    await expect(store.inspect({workspaceId: foreignWorkspaceId, projectId, actorId: foreignActorId})).resolves.toBeNull();
    await expect(store.simulate({workspaceId: foreignWorkspaceId, projectId, actorId: foreignActorId, definition})).resolves.toBeNull();
  });

  it('enforces workspace composites and JSONB shapes at the migration boundary', async () => {
    const workspaceA = randomUUID(); const workspaceB = randomUUID(); const projectA = randomUUID(); const projectB = randomUUID(); const actorA = randomUUID(); const actorB = randomUUID();
    await db.insert(workspaces).values([{id: workspaceA, name: 'A', slug: `a-${randomUUID()}`}, {id: workspaceB, name: 'B', slug: `b-${randomUUID()}`}]);
    await db.insert(projects).values([{id: projectA, workspaceId: workspaceA, name: 'A', slug: `pa-${randomUUID()}`}, {id: projectB, workspaceId: workspaceB, name: 'B', slug: `pb-${randomUUID()}`}]);
    await db.insert(actors).values([{id: actorA, workspaceId: workspaceA, type: 'human', role: 'developer', displayName: 'A', authMode: 'user'}, {id: actorB, workspaceId: workspaceB, type: 'human', role: 'developer', displayName: 'B', authMode: 'user'}]);
    const artifactSql = `insert into project_source_artifacts (id, workspace_id, project_id, name, media_type, content, size_bytes, sha256, provenance, created_by_actor_id) values ($1,$2,$3,'x','text/plain','x',1,$4,$5::jsonb,$6)`;
    await expect(testPool.query(artifactSql, [randomUUID(), workspaceA, projectA, sourceArtifactDigest('x'), '{}', actorB])).rejects.toMatchObject({code: '23503'});
    await expect(testPool.query(artifactSql, [randomUUID(), workspaceA, projectA, sourceArtifactDigest('x'), '[]', actorA])).rejects.toMatchObject({code: '23514'});
    await expect(testPool.query(`insert into project_plan_drafts (id,workspace_id,project_id,definition,content_hash,created_by_actor_id) values ($1,$2,$3,'[]'::jsonb,$4,$5)`, [randomUUID(), workspaceA, projectA, 'a'.repeat(64), actorA])).rejects.toMatchObject({code: '23514'});
    const approvedPlanId = randomUUID();
    await db.insert(projectPlanDrafts).values({id: approvedPlanId, workspaceId: workspaceA, projectId: projectA, state: 'approved', definition: {} as never, contentHash: 'a'.repeat(64), revision: 2, createdByActorId: actorA, approvedByActorId: actorA, approvedAt: new Date()});
    const versionSql = `insert into project_plan_versions (id,workspace_id,project_id,plan_id,version,source_revision,definition,content_hash,source_manifest,simulation,approved_by_actor_id,approved_at) values ($1,$2,$3,$4,1,1,'{}'::jsonb,$5,$6::jsonb,'{}'::jsonb,$7,now())`;
    await expect(testPool.query(versionSql, [randomUUID(), workspaceB, projectB, approvedPlanId, 'a'.repeat(64), '[]', actorB])).rejects.toMatchObject({code: '23503'});
    await expect(testPool.query(versionSql, [randomUUID(), workspaceA, projectA, approvedPlanId, 'a'.repeat(64), '{}', actorA])).rejects.toMatchObject({code: '23514'});
  });
});
