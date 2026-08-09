import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {defaultDeliveryProtocolDefinition, deterministicProjectPlanUuid, hashDeliveryProtocolDefinition,
  hashProjectPlanDefinition, hashProjectPlanSourceManifest, sourceArtifactDigest} from '@fai-control-plane/domain';
import {migrate} from 'drizzle-orm/node-postgres/migrator';
import {eq} from 'drizzle-orm';
import {Pool} from 'pg';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {dropDatabaseWhenDisconnected} from './integration-test-utils';
import {actors, agentRuns, auditEvents, commandReceipts, createDatabase, createPostgresProjectPlanStore,
  deliveryJourneys, outboxEvents, projectMemberships, projectPlanDrafts, projectPlanMaterializations, projectPublicationIntents,
  projectPlanVersions, projectScopeBaselineVersions, projectScopeOutcomes, projectSetups, projects,
  runbooks, workItemDependencies, workItems, workItemScopeOutcomes, workspaces} from './index';

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

  it('assembles or replaces only a CAS-protected draft from the exact bounded project corpus', async () => {
    const workspaceId = randomUUID(); const projectId = randomUUID(); const ownerId = randomUUID(); const planId = randomUUID(); const competingPlanId = randomUUID();
    await db.insert(workspaces).values({id: workspaceId, name: 'Generation', slug: `generation-${randomUUID()}`});
    await db.insert(projects).values({id: projectId, workspaceId, name: 'Generated', slug: `generated-${randomUUID()}`});
    await db.insert(actors).values({id: ownerId, workspaceId, type: 'human', role: 'developer', displayName: 'PO', authMode: 'user'});
    await db.insert(projectMemberships).values({id: randomUUID(), projectId, actorId: ownerId, role: 'project_owner'});
    const store = createPostgresProjectPlanStore(db);
    const envelope = (type: string, payload: unknown, key: string) => ({commandId: randomUUID(), workspaceId, correlationId: randomUUID(), idempotencyKey: key, issuedAt: '2026-08-09T10:00:00.000Z', actor: {actorId: ownerId}, type, payload});
    const record = async (artifactId: string, content: string, key: string) => store.execute({command: envelope('project_plan.source.record', {
      artifactId, projectId, name: key, mediaType: 'text/markdown', content, sizeBytes: Buffer.byteLength(content), sha256: sourceArtifactDigest(content),
      provenance: {kind: 'manager_note', label: 'PO', capturedAt: '2026-08-09T10:00:00.000Z'}
    }, key) as never, requestHash: key.padEnd(64, '0').slice(0, 64), authorized: true});
    const firstArtifactId = randomUUID(); const firstContent = '# Результат\nСогласовать границы\nПодтвердить критерии';
    await expect(record(firstArtifactId, firstContent, 'gen-source-1')).resolves.toMatchObject({receipt: {result: {ok: true}}});
    const firstManifest = [{artifactId: firstArtifactId, version: 1, sha256: sourceArtifactDigest(firstContent)}];
    const generate = envelope('project_plan.draft.generate', {planId, projectId, expectedRevision: null, sourceManifest: firstManifest}, 'generate-1');
    await expect(store.execute({command: generate as never, requestHash: 'a'.repeat(64), authorized: true})).resolves.toMatchObject({receipt: {result: {ok: true, value: {plan: {state: 'draft', revision: 1}}}}});
    await expect(store.execute({command: generate as never, requestHash: 'a'.repeat(64), authorized: true})).resolves.toMatchObject({status: 'replayed'});
    expect(await db.select().from(projectPlanVersions)).toHaveLength(0);
    expect(await db.select().from(projectPlanMaterializations)).toHaveLength(0);
    expect(await db.select().from(workItems)).toHaveLength(0);
    expect(await db.select().from(agentRuns)).toHaveLength(0);

    const secondArtifactId = randomUUID(); const secondContent = 'Проверить итог с Product Owner';
    await expect(record(secondArtifactId, secondContent, 'gen-source-2')).resolves.toMatchObject({receipt: {result: {ok: true}}});
    const staleManifest = [...firstManifest, {artifactId: secondArtifactId, version: 1, sha256: '0'.repeat(64)}];
    await expect(store.execute({command: envelope('project_plan.draft.generate', {planId, projectId, expectedRevision: 1, sourceManifest: staleManifest}, 'generate-stale') as never,
      requestHash: 'b'.repeat(64), authorized: true})).resolves.toMatchObject({receipt: {result: {error: {code: 'VERSION_CONFLICT'}}}});
    const fullManifest = [...firstManifest, {artifactId: secondArtifactId, version: 1, sha256: sourceArtifactDigest(secondContent)}];
    await expect(store.execute({command: envelope('project_plan.draft.generate', {planId, projectId, expectedRevision: 1, sourceManifest: fullManifest}, 'generate-2') as never,
      requestHash: 'c'.repeat(64), authorized: true})).resolves.toMatchObject({receipt: {result: {ok: true, value: {plan: {state: 'draft', revision: 2}}}}});
    await expect(store.execute({command: envelope('project_plan.draft.generate', {planId: competingPlanId, projectId, expectedRevision: null, sourceManifest: fullManifest}, 'generate-competing') as never,
      requestHash: 'd'.repeat(64), authorized: true})).resolves.toMatchObject({receipt: {result: {error: {code: 'VERSION_CONFLICT'}}}});
    expect(await db.select().from(projectPlanDrafts)).toHaveLength(1);
    expect(await db.select().from(auditEvents)).toHaveLength(6);
    expect(await db.select().from(commandReceipts)).toHaveLength(6);
  });

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
    const definition = {title: 'План', outcomes: Array.from({length: 5}, (_, index) => ({key: `outcome_${index}`, title: `Результат ${index}`, weight: 20, evidence: citation})), milestones: [{key: 'm1', title: 'Приёмка', checkpoint: 'PO принимает результат', targetAt: null, evidence: citation}], risks: [{key: 'r1', statement: 'Исходные данные изменятся', mitigation: 'Повторная проверка PO', evidence: citation}], tasks: [
      {key: 't1', title: 'Подготовить результат', outcomeKeys: ['outcome_0'], milestoneKey: 'm1', dependsOn: [], acceptanceEvidence: [{description: 'Критерий выполнен', evidence: citation}]},
      {key: 't2', title: 'Проверить результат', outcomeKeys: ['outcome_1'], milestoneKey: 'm1', dependsOn: ['t1'], acceptanceEvidence: [{description: 'Проверка выполнена', evidence: citation}]}
    ]};
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
    expect(await db.select().from(commandReceipts).where(eq(commandReceipts.workspaceId, workspaceId))).toHaveLength(9);
    expect(await db.select().from(auditEvents).where(eq(auditEvents.workspaceId, workspaceId))).toHaveLength(9);
    await expect(store.execute({command: envelope('project_plan.draft.save', {planId, projectId, expectedRevision: 3, definition}, 'immutable') as never, requestHash: 'd'.repeat(64), authorized: true})).resolves.toMatchObject({receipt: {result: {error: {code: 'INVALID_TRANSITION'}}}});
    const replanSaveId = randomUUID(); const replanGenerateId = randomUUID();
    await expect(store.execute({command: envelope('project_plan.draft.save', {planId: replanSaveId, projectId, expectedRevision: null, definition}, 'replan-save-blocked') as never,
      requestHash: 'n'.repeat(64), authorized: true})).resolves.toMatchObject({receipt: {result: {error: {code: 'INVALID_TRANSITION', message: expect.stringContaining('scope-delta re-plan')}}}});
    await expect(store.execute({command: envelope('project_plan.draft.generate', {planId: replanGenerateId, projectId, expectedRevision: null,
      sourceManifest: [{artifactId, version: 1, sha256: sourceArtifactDigest(content)}]}, 'replan-generate-blocked') as never,
      requestHash: 'o'.repeat(64), authorized: true})).resolves.toMatchObject({receipt: {result: {error: {code: 'INVALID_TRANSITION', message: expect.stringContaining('scope-delta re-plan')}}}});
    expect(await db.select().from(projectPlanDrafts).where(eq(projectPlanDrafts.projectId, projectId))).toHaveLength(1);
    const foreignWorkspaceId = randomUUID(); const foreignProjectId = randomUUID(); const foreignActorId = randomUUID();
    await db.insert(workspaces).values({id: foreignWorkspaceId, name: 'Foreign', slug: `foreign-${randomUUID()}`});
    await db.insert(projects).values({id: foreignProjectId, workspaceId: foreignWorkspaceId, name: 'Foreign', slug: `foreign-project-${randomUUID()}`});
    await db.insert(actors).values({id: foreignActorId, workspaceId: foreignWorkspaceId, type: 'human', role: 'developer', displayName: 'Foreign PO', authMode: 'user'});
    await db.insert(projectMemberships).values({id: randomUUID(), projectId: foreignProjectId, actorId: foreignActorId, role: 'project_owner'});
    await expect(store.inspect({workspaceId: foreignWorkspaceId, projectId, actorId: foreignActorId})).resolves.toBeNull();
    await expect(store.simulate({workspaceId: foreignWorkspaceId, projectId, actorId: foreignActorId, definition})).resolves.toBeNull();

    await db.insert(projectSetups).values({id: randomUUID(), projectId, state: 'pending', configuration: {
      repositoryBinding: 'none', trackerBinding: 'create_managed', internalChat: 'none', clientChat: 'none',
      executionMode: 'manual', agentProfileId: null
    }});
    const materializePayload = {projectId, planId, expectedPlanVersion: version!.version,
      expectedPlanHash: version!.contentHash, expectedSourceManifestHash: hashProjectPlanSourceManifest(version!.sourceManifest)};
    await testPool.query('update project_source_artifacts set content = $1, size_bytes = $2 where id = $3', ['tampered', Buffer.byteLength('tampered'), artifactId]);
    await expect(store.execute({command: envelope('project_plan.materialize', materializePayload, 'materialize-tampered-source') as never,
      requestHash: 'l'.repeat(64), authorized: true})).resolves.toMatchObject({receipt: {result: {error: {code: 'INVALID_COMMAND'}}}});
    await testPool.query('update project_source_artifacts set content = $1, size_bytes = $2 where id = $3', [content, Buffer.byteLength(content), artifactId]);
    await expect(store.execute({command: envelope('project_plan.materialize', materializePayload, 'materialize-admin', adminId) as never,
      requestHash: 'h'.repeat(64), authorized: true})).resolves.toMatchObject({receipt: {result: {error: {code: 'CAPABILITY_DENIED'}}}});
    await db.insert(projectScopeBaselineVersions).values({id: randomUUID(), projectId, version: 1, active: true});
    await expect(store.execute({command: envelope('project_plan.materialize', materializePayload, 'materialize-existing-baseline') as never,
      requestHash: 'k'.repeat(64), authorized: true})).resolves.toMatchObject({receipt: {result: {error: {code: 'INVALID_TRANSITION'}}}});
    expect(await db.select().from(projectPlanMaterializations)).toHaveLength(0);
    expect(await db.select().from(workItems)).toHaveLength(0);
    expect(await db.select().from(outboxEvents)).toHaveLength(0);
    await testPool.query('update project_scope_baseline_versions set active = false where project_id = $1', [projectId]);
    await expect(store.execute({command: envelope('project_plan.materialize', materializePayload, 'materialize-inactive-baseline') as never,
      requestHash: 'm'.repeat(64), authorized: true})).resolves.toMatchObject({receipt: {result: {error: {code: 'INVALID_TRANSITION'}}}});
    await db.delete(projectScopeBaselineVersions);
    const concurrentMaterializations = await Promise.all([
      store.execute({command: envelope('project_plan.materialize', materializePayload, 'materialize-a') as never, requestHash: 'i'.repeat(64), authorized: true}),
      store.execute({command: envelope('project_plan.materialize', materializePayload, 'materialize-b') as never, requestHash: 'j'.repeat(64), authorized: true})
    ]);
    expect(concurrentMaterializations).toHaveLength(2);
    expect(concurrentMaterializations.every((entry) => 'receipt' in entry && entry.receipt.result.ok)).toBe(true);
    const [materialization] = await db.select().from(projectPlanMaterializations);
    expect(materialization).toMatchObject({outcomeCount: 5, milestoneCount: 1, workItemCount: 2,
      dependencyCount: 1, journeyCount: 0, publicationIntentCount: 9});
    expect(materialization?.id).toBe(deterministicProjectPlanUuid(version!.id, 'materialization'));
    expect(await db.select().from(projectScopeBaselineVersions)).toHaveLength(1);
    expect((await db.select().from(projectScopeOutcomes)).map(({weight, state, sourcePlanVersionId}) => ({weight, state, sourcePlanVersionId})))
      .toEqual(Array.from({length: 5}, () => ({weight: 20, state: 'not_started', sourcePlanVersionId: version!.id})));
    expect(await db.select().from(workItems)).toEqual(expect.arrayContaining([
      expect.objectContaining({id: deterministicProjectPlanUuid(version!.id, 'work_item', 't1'), sourcePlanVersionId: version!.id, sourceTaskKey: 't1', acceptanceEvidence: definition.tasks[0]!.acceptanceEvidence}),
      expect.objectContaining({id: deterministicProjectPlanUuid(version!.id, 'work_item', 't2'), sourcePlanVersionId: version!.id, sourceTaskKey: 't2', acceptanceEvidence: definition.tasks[1]!.acceptanceEvidence})
    ]));
    expect(await db.select().from(workItemDependencies)).toEqual([expect.objectContaining({sourcePlanVersionId: version!.id})]);
    expect(await db.select().from(workItemScopeOutcomes)).toEqual(expect.arrayContaining([
      expect.objectContaining({sourcePlanVersionId: version!.id})
    ]));
    expect(await db.select().from(deliveryJourneys)).toHaveLength(0);
    expect(await db.select().from(agentRuns)).toHaveLength(0);
    expect(await db.select().from(outboxEvents)).toHaveLength(0);
    const publication = await db.select().from(projectPublicationIntents);
    expect(publication).toHaveLength(9);
    expect(publication.every(({surface, mode, state}) =>
      surface === 'tracker' && mode === 'create_managed' && state === 'desired')).toBe(true);
    await expect(store.inspect({workspaceId, projectId, actorId: ownerId})).resolves.toMatchObject({
      materialization: {id: materialization!.id, planVersion: 1, workItemCount: 2}
    });
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

    const approvedPlanBId = randomUUID();
    await db.insert(projectPlanDrafts).values({id: approvedPlanBId, workspaceId: workspaceB, projectId: projectB, state: 'approved', definition: {} as never, contentHash: 'b'.repeat(64), revision: 1, createdByActorId: actorB, approvedByActorId: actorB, approvedAt: new Date()});
    const planVersionA = randomUUID(); const planVersionB = randomUUID();
    await testPool.query(versionSql, [planVersionA, workspaceA, projectA, approvedPlanId, 'a'.repeat(64), '[]', actorA]);
    await testPool.query(versionSql, [planVersionB, workspaceB, projectB, approvedPlanBId, 'b'.repeat(64), '[]', actorB]);
    const baselineA = randomUUID(); const baselineB = randomUUID();
    await db.insert(projectScopeBaselineVersions).values([
      {id: baselineA, projectId: projectA, version: 1, active: false, sourcePlanVersionId: planVersionA, sourcePlanHash: 'a'.repeat(64)},
      {id: baselineB, projectId: projectB, version: 1, active: false, sourcePlanVersionId: planVersionB, sourcePlanHash: 'b'.repeat(64)}
    ]);
    const materializationSql = `insert into project_plan_materializations (id,workspace_id,project_id,plan_version_id,baseline_id,command_id,plan_version,plan_hash,source_manifest_hash,outcome_count,milestone_count,work_item_count,dependency_count,journey_count,publication_intent_count,created_by_actor_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,1,1,0,0,0,$10)`;
    await expect(testPool.query(materializationSql, [randomUUID(), workspaceA, projectA, planVersionA, baselineB, randomUUID(), 1, 'a'.repeat(64), 'c'.repeat(64), actorA])).rejects.toMatchObject({code: '23503'});
    await expect(testPool.query(materializationSql, [randomUUID(), workspaceA, projectA, planVersionA, baselineA, randomUUID(), 2, 'a'.repeat(64), 'c'.repeat(64), actorA])).rejects.toMatchObject({code: '23503'});

    const workItemA = randomUUID(); const workItemB = randomUUID();
    await db.insert(workItems).values([
      {id: workItemA, projectId: projectA, title: 'A', sourcePlanVersionId: planVersionA, sourceTaskKey: 'a', acceptanceEvidence: []},
      {id: workItemB, projectId: projectB, title: 'B', sourcePlanVersionId: planVersionB, sourceTaskKey: 'b', acceptanceEvidence: []}
    ]);
    await expect(testPool.query('insert into work_item_dependencies (work_item_id,depends_on_work_item_id,source_plan_version_id) values ($1,$2,$3)', [workItemA, workItemB, planVersionA])).rejects.toMatchObject({code: '23503'});
    await expect(testPool.query(`insert into project_publication_intents (id,workspace_id,project_id,plan_version_id,surface,mode,resource_kind,canonical_id,state,idempotency_key) values ($1,$2,$3,$4,'tracker','none','baseline',$5,'desired',$6)`, [randomUUID(), workspaceA, projectA, planVersionA, baselineA, randomUUID()])).rejects.toMatchObject({code: '23514'});
  });

  it('serializes competing approved plans and creates only root journeys for a ready protocol', async () => {
    const workspaceId = randomUUID(); const projectId = randomUUID(); const ownerId = randomUUID();
    await db.insert(workspaces).values({id: workspaceId, name: 'Concurrent', slug: `concurrent-${randomUUID()}`});
    await db.insert(projects).values({id: projectId, workspaceId, name: 'Concurrent', slug: `concurrent-project-${randomUUID()}`});
    await db.insert(actors).values({id: ownerId, workspaceId, type: 'human', role: 'developer', displayName: 'PO', authMode: 'user'});
    await db.insert(projectMemberships).values({id: randomUUID(), projectId, actorId: ownerId, role: 'project_owner'});
    const assumption = {kind: 'assumption' as const, statement: 'Product Owner подтвердит результат'};
    const definition = {title: 'Исполняемый план', outcomes: Array.from({length: 5}, (_, index) => ({key: `outcome_${index}`, title: `Результат ${index}`, weight: 20, evidence: assumption})),
      milestones: [{key: 'm1', title: 'Приёмка', checkpoint: 'PO принимает результат', targetAt: null, evidence: assumption}],
      risks: [{key: 'r1', statement: 'Изменятся требования', mitigation: 'Повторная приёмка', evidence: assumption}], tasks: [
        {key: 'root', title: 'Корневая задача', outcomeKeys: ['outcome_0'], milestoneKey: 'm1', dependsOn: [], acceptanceEvidence: [{description: 'PO подтвердил', evidence: assumption}]},
        {key: 'dependent', title: 'Зависимая задача', outcomeKeys: ['outcome_1'], milestoneKey: 'm1', dependsOn: ['root'], acceptanceEvidence: [{description: 'Проверка пройдена', evidence: assumption}]}
      ]};
    const contentHash = hashProjectPlanDefinition(definition);
    const planIds = [randomUUID(), randomUUID()]; const versionIds = [randomUUID(), randomUUID()];
    await db.insert(projectPlanDrafts).values(planIds.map((id) => ({id, workspaceId, projectId, state: 'approved' as const, definition, contentHash, revision: 1, createdByActorId: ownerId, approvedByActorId: ownerId, approvedAt: new Date()})));
    await db.insert(projectPlanVersions).values(planIds.map((planId, index) => ({id: versionIds[index]!, workspaceId, projectId, planId, version: index + 1, sourceRevision: 1, definition, contentHash, sourceManifest: [], simulation: {} as never, approvedByActorId: ownerId, approvedAt: new Date()})));
    const protocol = defaultDeliveryProtocolDefinition();
    await db.insert(runbooks).values({id: randomUUID(), projectId, name: 'Delivery', version: 1, definition: protocol as never, active: true, protocolState: 'published', revision: 1, contentHash: hashDeliveryProtocolDefinition(protocol)});
    const store = createPostgresProjectPlanStore(db);
    const commands = planIds.map((planId, index) => ({commandId: randomUUID(), workspaceId, correlationId: randomUUID(), idempotencyKey: `competing-${index}`, issuedAt: '2026-08-09T10:00:00.000Z', actor: {actorId: ownerId}, type: 'project_plan.materialize' as const,
      payload: {projectId, planId, expectedPlanVersion: index + 1, expectedPlanHash: contentHash, expectedSourceManifestHash: hashProjectPlanSourceManifest([])}}));
    const results = await Promise.all(commands.map((command, index) => store.execute({command: command as never, requestHash: `${index + 1}`.repeat(64), authorized: true})));
    expect(results.filter((entry) => 'receipt' in entry && entry.receipt.result.ok)).toHaveLength(1);
    expect(results.filter((entry) => 'receipt' in entry && !entry.receipt.result.ok && entry.receipt.result.error.code === 'INVALID_TRANSITION')).toHaveLength(1);
    await expect(testPool.query('select count(*)::int as count from project_plan_materializations where project_id = $1', [projectId])).resolves.toMatchObject({rows: [{count: 1}]});
    await expect(testPool.query('select count(*)::int as count from project_scope_baseline_versions where project_id = $1', [projectId])).resolves.toMatchObject({rows: [{count: 1}]});
    await expect(testPool.query('select wi.source_task_key, wi.status from delivery_journeys dj join work_items wi on wi.id = dj.work_item_id where wi.project_id = $1', [projectId])).resolves.toMatchObject({rows: [{source_task_key: 'root', status: 'ready'}]});
    await expect(testPool.query('select status from work_items where project_id = $1 and source_task_key = $2', [projectId, 'dependent'])).resolves.toMatchObject({rows: [{status: 'backlog'}]});
    expect(await db.select().from(agentRuns)).toHaveLength(0);

    const rollbackProjectId = randomUUID(); const rollbackPlanId = randomUUID(); const rollbackVersionId = randomUUID();
    await db.insert(projects).values({id: rollbackProjectId, workspaceId, name: 'Rollback', slug: `rollback-${randomUUID()}`});
    await db.insert(projectMemberships).values({id: randomUUID(), projectId: rollbackProjectId, actorId: ownerId, role: 'project_owner'});
    await db.insert(projectPlanDrafts).values({id: rollbackPlanId, workspaceId, projectId: rollbackProjectId, state: 'approved', definition, contentHash, revision: 1, createdByActorId: ownerId, approvedByActorId: ownerId, approvedAt: new Date()});
    await db.insert(projectPlanVersions).values({id: rollbackVersionId, workspaceId, projectId: rollbackProjectId, planId: rollbackPlanId, version: 1, sourceRevision: 1, definition, contentHash, sourceManifest: [], simulation: {} as never, approvedByActorId: ownerId, approvedAt: new Date()});
    await db.insert(projectSetups).values({id: randomUUID(), projectId: rollbackProjectId, state: 'pending', configuration: {repositoryBinding: 'none', trackerBinding: 'create_managed', internalChat: 'none', clientChat: 'none', executionMode: 'manual', agentProfileId: null}});
    const rollbackBaselineId = deterministicProjectPlanUuid(rollbackVersionId, 'baseline');
    const conflictingIntentId = deterministicProjectPlanUuid(rollbackVersionId, 'materialization', `tracker:baseline:${rollbackBaselineId}`);
    await db.insert(projectPublicationIntents).values({id: conflictingIntentId, workspaceId, projectId: rollbackProjectId, planVersionId: rollbackVersionId, surface: 'tracker', mode: 'create_managed', resourceKind: 'baseline', canonicalId: rollbackBaselineId, state: 'desired', idempotencyKey: `${rollbackVersionId}:tracker:baseline:${rollbackBaselineId}`});
    const rollbackCommand = {commandId: randomUUID(), workspaceId, correlationId: randomUUID(), idempotencyKey: 'late-conflict', issuedAt: '2026-08-09T10:00:00.000Z', actor: {actorId: ownerId}, type: 'project_plan.materialize' as const,
      payload: {projectId: rollbackProjectId, planId: rollbackPlanId, expectedPlanVersion: 1, expectedPlanHash: contentHash, expectedSourceManifestHash: hashProjectPlanSourceManifest([])}};
    await expect(store.execute({command: rollbackCommand as never, requestHash: 'z'.repeat(64), authorized: true})).rejects.toMatchObject({cause: {code: '23505'}});
    await expect(testPool.query('select count(*)::int as count from project_scope_baseline_versions where project_id = $1', [rollbackProjectId])).resolves.toMatchObject({rows: [{count: 0}]});
    await expect(testPool.query('select count(*)::int as count from work_items where project_id = $1', [rollbackProjectId])).resolves.toMatchObject({rows: [{count: 0}]});
    await expect(testPool.query('select count(*)::int as count from project_plan_materializations where project_id = $1', [rollbackProjectId])).resolves.toMatchObject({rows: [{count: 0}]});
  });
});
