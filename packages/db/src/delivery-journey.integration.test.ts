import {createHash, randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {
  defaultDeliveryProtocolDefinition,
  hashDeliveryProtocolDefinition
} from '@fai-control-plane/domain';
import {and, eq} from 'drizzle-orm';
import {migrate} from 'drizzle-orm/node-postgres/migrator';
import {Pool} from 'pg';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {dropDatabaseWhenDisconnected} from './integration-test-utils';
import {
  actors,
  auditEvents,
  commandReceipts,
  createDatabase,
  createPostgresDeliveryJourneyStore,
  deliveryJourneyEvidence,
  deliveryJourneys,
  loadProjectExecutionProjection,
  projectMemberships,
  projectExecutions,
  projectPlanDrafts,
  projectPlanMaterializations,
  projectPlanVersions,
  projectScopeBaselineVersions,
  projects,
  runbooks,
  workItems,
  workspaces
} from './index';
import {resolveCurrentExecutionResponsibility} from './work-item-responsibility';

const databaseUrl = process.env.DATABASE_URL;
if (process.env.CI && databaseUrl === undefined) {
  throw new Error('DATABASE_URL is required for delivery journey integration tests in CI.');
}
const describePostgres = databaseUrl === undefined ? describe.skip : describe;
const databaseName = `fai_delivery_journey_${randomUUID().replaceAll('-', '')}`;

describePostgres('delivery journey persistence', () => {
  let adminPool: Pool;
  let testPool: Pool;
  let db: ReturnType<typeof createDatabase>['db'];
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
  }, 30_000);
  afterAll(async () => {
    await testPool?.end();
    if (adminPool !== undefined) {
      try { await dropDatabaseWhenDisconnected(adminPool, databaseName); }
      finally { await adminPool.end(); }
    }
  }, 30_000);

  const seedSelectedManualJourney = async () => {
    const ids = {
      workspace: randomUUID(), project: randomUUID(), owner: randomUUID(),
      membership: randomUUID(), plan: randomUUID(), planVersion: randomUUID(),
      baseline: randomUUID(), protocol: randomUUID(), task: randomUUID()
    };
    const planDefinition = {
      title: 'Manual delivery plan',
      outcomes: [{key: 'outcome_1', title: 'Accepted result', weight: 100,
        evidence: {kind: 'assumption' as const, statement: 'Owner-approved result.'}}],
      milestones: [{key: 'milestone_1', title: 'Delivery', checkpoint: 'Owner review',
        targetAt: null, evidence: {kind: 'assumption' as const, statement: 'Owner checkpoint.'}}],
      risks: [],
      tasks: [{key: 'task_1', title: 'Manual task',
        responsibility: {kind: 'human' as const, actorId: ids.owner},
        outcomeKeys: ['outcome_1'], milestoneKey: 'milestone_1', dependsOn: [],
        acceptanceEvidence: [{description: 'Owner evidence',
          evidence: {kind: 'assumption' as const, statement: 'Evidence is required.'}}]}]
    };
    const definition = {
      schemaVersion: 1 as const,
      stages: [{
        key: 'intake', name: 'Intake', enabled: true, taskStatus: 'ready' as const,
        responsibility: {kind: 'project_role' as const, role: 'project_owner' as const},
        executionMode: 'manual' as const, entryCriteria: ['Context ready'],
        requiredEvidence: ['Accepted task brief'], allowedNextStageKey: 'development'
      }, {
        key: 'development', name: 'Development', enabled: true, taskStatus: 'in_dev' as const,
        responsibility: {kind: 'project_role' as const, role: 'project_owner' as const},
        executionMode: 'manual' as const, entryCriteria: ['Brief accepted'],
        requiredEvidence: ['Implementation result'], allowedNextStageKey: null
      }]
    };
    await db.insert(workspaces).values({id: ids.workspace, name: 'Selected journey',
      slug: `selected-journey-${randomUUID()}`});
    await db.insert(projects).values({id: ids.project, workspaceId: ids.workspace,
      name: 'Selected journey project', slug: `selected-project-${randomUUID()}`});
    await db.insert(actors).values({id: ids.owner, workspaceId: ids.workspace, type: 'human',
      role: 'workspace_admin', displayName: 'Product Owner', authMode: 'user'});
    await db.insert(projectMemberships).values({id: ids.membership, projectId: ids.project,
      actorId: ids.owner, roles: ['project_owner']});
    const approvedAt = new Date('2026-08-12T08:00:00.000Z');
    await db.insert(projectPlanDrafts).values({id: ids.plan, workspaceId: ids.workspace,
      projectId: ids.project, state: 'approved', definition: planDefinition,
      contentHash: 'a'.repeat(64), revision: 1, createdByActorId: ids.owner,
      approvedByActorId: ids.owner, approvedAt});
    await db.insert(projectPlanVersions).values({id: ids.planVersion, workspaceId: ids.workspace,
      projectId: ids.project, planId: ids.plan, version: 1, sourceRevision: 1,
      definition: planDefinition, contentHash: 'a'.repeat(64), sourceManifest: [],
      simulation: {} as never, approvedByActorId: ids.owner, approvedAt});
    await db.insert(projectScopeBaselineVersions).values({id: ids.baseline,
      projectId: ids.project, version: 1, sourcePlanVersionId: ids.planVersion,
      sourcePlanHash: 'a'.repeat(64)});
    await db.insert(projectPlanMaterializations).values({workspaceId: ids.workspace,
      projectId: ids.project, planVersionId: ids.planVersion, baselineId: ids.baseline,
      commandId: randomUUID(), planVersion: 1, planHash: 'a'.repeat(64),
      sourceManifestHash: createHash('sha256').update('[]').digest('hex'),
      outcomeCount: 1, milestoneCount: 1, workItemCount: 1, dependencyCount: 0,
      journeyCount: 1, publicationIntentCount: 0, createdByActorId: ids.owner});
    await db.insert(runbooks).values({id: ids.protocol, projectId: ids.project,
      name: 'Manual delivery', version: 1, definition, active: true,
      protocolState: 'published', revision: 1,
      contentHash: hashDeliveryProtocolDefinition(definition)});
    await db.insert(workItems).values({id: ids.task, projectId: ids.project,
      title: 'Manual task', status: 'ready', sourcePlanVersionId: ids.planVersion,
      sourceTaskKey: 'task_1', responsibility: planDefinition.tasks[0]!.responsibility,
      acceptanceEvidence: planDefinition.tasks[0]!.acceptanceEvidence});
    await db.insert(deliveryJourneys).values({workItemId: ids.task,
      protocolId: ids.protocol, protocolVersion: 1, stageKey: 'intake'});
    const selection = await resolveCurrentExecutionResponsibility(db, {
      workspaceId: ids.workspace, projectId: ids.project, workItemId: ids.task
    });
    if (selection === null) throw new Error('selected journey fixture did not resolve');
    await db.insert(projectExecutions).values({projectId: ids.project, status: 'blocked',
      blockReason: 'provider_handoff_required', selectedWorkItemId: ids.task,
      selectedPlanVersionId: ids.planVersion, selectedWorkItemVersion: 1,
      selectedProtocolId: ids.protocol, selectedProtocolVersion: 1,
      selectedJourneyVersion: 1, selectedStageKey: 'intake',
      selectedResponsibleActorId: selection.actor.id,
      selectedAgentProfileId: selection.actor.agentProfileId,
      selectedResponsibilityHash: selection.factHash, startedAt: approvedAt});
    const store = createPostgresDeliveryJourneyStore(db);
    const command = (key: string, reference: string) => ({
      commandId: randomUUID(), workspaceId: ids.workspace, correlationId: randomUUID(),
      idempotencyKey: key, actor: {actorId: ids.owner}, type: 'delivery_journey.advance' as const,
      payload: {workItemId: ids.task, expectedWorkItemVersion: 1,
        expectedJourneyVersion: 1, evidenceReferences: [{
          requirement: 'Accepted task brief', reference
        }]}
    });
    return {ids, store, command};
  };

  it('binds immutable protocol version, denies missing evidence, advances with CAS, and projects legacy state', async () => {
    const ids = {
      workspace: randomUUID(), project: randomUUID(), owner: randomUUID(),
      contributor: randomUUID(), membership: randomUUID(),
      contributorMembership: randomUUID(), protocol: randomUUID(), task: randomUUID(),
      legacy: randomUUID()
    };
    await db.insert(workspaces).values({
      id: ids.workspace, name: 'Journey', slug: `journey-${randomUUID()}`
    });
    await db.insert(projects).values({
      id: ids.project, workspaceId: ids.workspace, name: 'Project',
      slug: `project-${randomUUID()}`
    });
    await db.insert(actors).values([
      {id: ids.owner, workspaceId: ids.workspace, type: 'human',
        role: 'workspace_admin', displayName: 'Owner', authMode: 'user'},
      {id: ids.contributor, workspaceId: ids.workspace, type: 'human',
        role: 'developer', displayName: 'Contributor', authMode: 'user'}
    ]);
    await db.insert(projectMemberships).values([
      {id: ids.membership, projectId: ids.project, actorId: ids.owner,
        roles: ['project_owner']},
      {id: ids.contributorMembership, projectId: ids.project,
        actorId: ids.contributor, roles: ['contributor']}
    ]);
    const baseDefinition = defaultDeliveryProtocolDefinition();
    const definition = {
      ...baseDefinition,
      stages: baseDefinition.stages.map((stage, index, stages) => ({
        ...stage,
        key: `lane_${index}`,
        allowedNextStageKey: index === stages.length - 1 ? null : `lane_${index + 1}`
      }))
    };
    await db.insert(runbooks).values({
      id: ids.protocol, projectId: ids.project, name: 'Delivery', version: 1,
      definition: definition as never, active: true, protocolState: 'published',
      revision: 2, contentHash: hashDeliveryProtocolDefinition(definition)
    });
    await db.insert(workItems).values([
      {id: ids.task, projectId: ids.project, title: 'Bound'},
      {id: ids.legacy, projectId: ids.project, title: 'Legacy'}
    ]);
    const store = createPostgresDeliveryJourneyStore(db);
    const envelope = (type: 'delivery_journey.start' | 'delivery_journey.advance',
      payload: unknown, key: string) => ({
      commandId: randomUUID(), workspaceId: ids.workspace, correlationId: randomUUID(),
      idempotencyKey: key, actor: {actorId: ids.owner}, type, payload
    });
    const start = envelope('delivery_journey.start', {
      workItemId: ids.task, protocolId: ids.protocol, expectedWorkItemVersion: 1,
      deadlineAt: '2026-08-01T10:00:00.000Z'
    }, 'start');
    const deniedStart = {...start, commandId: randomUUID(), idempotencyKey: 'denied-start',
      actor: {actorId: ids.contributor}};
    await expect(store.execute({command: deniedStart as never,
      requestHash: createHash('sha256').update('denied-start').digest('hex'), authorized: true}))
      .resolves.toMatchObject({receipt: {result: {error: {code: 'CAPABILITY_DENIED'}}}});
    expect((await db.select().from(auditEvents).where(and(
      eq(auditEvents.workspaceId, ids.workspace), eq(auditEvents.actorId, ids.contributor),
      eq(auditEvents.action, 'delivery_journey.start'))))[0]).toMatchObject({
      policyDecision: 'deny', outcome: 'rejected', reasonCode: 'CAPABILITY_DENIED'
    });
    await expect(store.execute({
      command: start as never, requestHash: createHash('sha256').update('start').digest('hex'),
      authorized: true
    })).resolves.toMatchObject({
      receipt: {result: {ok: true, value: {
        state: 'configured', task: {status: 'ready', version: 2},
        protocol: {id: ids.protocol, version: 1}, journeyVersion: 1,
        stage: {key: 'lane_0'}
      }}}
    });
    await db.update(workItems).set({blocked: true}).where(eq(workItems.id, ids.task));
    const blocked = await store.execute({
      command: envelope('delivery_journey.advance', {
        workItemId: ids.task, expectedWorkItemVersion: 2, expectedJourneyVersion: 1,
        evidenceReferences: [{
          requirement: 'Accepted task brief', reference: 'artifact://brief/blocked'
        }]
      }, 'blocked') as never,
      requestHash: createHash('sha256').update('blocked').digest('hex'), authorized: true
    });
    expect(blocked).toMatchObject({receipt: {result: {error: {code: 'WORK_ITEM_BLOCKED'}}}});
    expect(await db.select().from(deliveryJourneyEvidence)).toHaveLength(0);
    expect((await db.select().from(deliveryJourneys)
      .where(eq(deliveryJourneys.workItemId, ids.task)))[0]).toMatchObject({
      stageKey: 'lane_0', version: 1
    });
    expect((await db.select().from(workItems).where(eq(workItems.id, ids.task)))[0])
      .toMatchObject({status: 'ready', blocked: true, version: 2});
    await db.update(workItems).set({blocked: false}).where(eq(workItems.id, ids.task));
    const missing = await store.execute({
      command: envelope('delivery_journey.advance', {
        workItemId: ids.task, expectedWorkItemVersion: 2,
        expectedJourneyVersion: 1, evidenceReferences: []
      }, 'missing') as never,
      requestHash: createHash('sha256').update('missing').digest('hex'), authorized: true
    });
    expect(missing).toMatchObject({receipt: {result: {error: {code: 'INVALID_COMMAND'}}}});
    expect(await db.select().from(deliveryJourneyEvidence)).toHaveLength(0);
    const advanced = await store.execute({
      command: envelope('delivery_journey.advance', {
        workItemId: ids.task, expectedWorkItemVersion: 2, expectedJourneyVersion: 1,
        evidenceReferences: [{
          requirement: 'Accepted task brief', reference: 'artifact://brief/accepted'
        }]
      }, 'advance') as never,
      requestHash: createHash('sha256').update('advance').digest('hex'), authorized: true
    });
    expect(advanced).toMatchObject({receipt: {result: {ok: true, value: {
      task: {status: 'in_dev', version: 3}, journeyVersion: 2,
      stage: {key: 'lane_1'}
    }}}});
    expect(await db.select().from(deliveryJourneyEvidence)).toHaveLength(1);
    expect((await db.select().from(deliveryJourneys)
      .where(eq(deliveryJourneys.workItemId, ids.task)))[0]).toMatchObject({
      protocolId: ids.protocol, protocolVersion: 1, stageKey: 'lane_1', version: 2
    });
    await expect(store.read({
      workspaceId: ids.workspace, workItemId: ids.legacy,
      actorId: ids.owner, at: '2026-07-30T10:00:00.000Z'
    })).resolves.toMatchObject({state: 'not_configured', reason: 'protocol_not_bound'});

    let terminalTask = (await db.select().from(workItems).where(eq(workItems.id, ids.task)))[0]!;
    let terminalJourney = (await db.select().from(deliveryJourneys)
      .where(eq(deliveryJourneys.workItemId, ids.task)))[0]!;
    for (const stage of definition.stages.slice(1, -1)) {
      const advance = store.execute({
        command: envelope('delivery_journey.advance', {
          workItemId: ids.task, expectedWorkItemVersion: terminalTask.version,
          expectedJourneyVersion: terminalJourney.version,
          evidenceReferences: stage.requiredEvidence.map((requirement) => ({
            requirement, reference: `artifact://terminal/${stage.key}/${requirement}`
          }))
        }, `to-${stage.key}`) as never,
        requestHash: createHash('sha256').update(`to-${stage.key}`).digest('hex'), authorized: true
      });
      if (stage.taskStatus === 'qa') {
        await expect(advance).resolves.toMatchObject({receipt: {result: {error: {code: 'INVALID_TRANSITION'}}}});
        const nextStage = definition.stages.find((candidate) => candidate.key === stage.allowedNextStageKey)!;
        await db.insert(deliveryJourneyEvidence).values(stage.requiredEvidence.map((requirement) => ({
          workItemId: ids.task, stageKey: stage.key, requirement,
          evidenceReference: `artifact://governed-qa/${stage.key}/${requirement}`, commandId: randomUUID()
        })));
        await db.update(workItems).set({status: nextStage.taskStatus, version: terminalTask.version + 1})
          .where(eq(workItems.id, ids.task));
        await db.update(deliveryJourneys).set({stageKey: nextStage.key, version: terminalJourney.version + 1})
          .where(eq(deliveryJourneys.workItemId, ids.task));
      } else {
        await expect(advance).resolves.toMatchObject({receipt: {result: {ok: true}}});
      }
      terminalTask = (await db.select().from(workItems).where(eq(workItems.id, ids.task)))[0]!;
      terminalJourney = (await db.select().from(deliveryJourneys)
        .where(eq(deliveryJourneys.workItemId, ids.task)))[0]!;
    }
    const terminalStage = definition.stages.at(-1)!;
    expect(terminalTask.status).toBe('done');
    await expect(store.execute({
      command: envelope('delivery_journey.advance', {
        workItemId: ids.task, expectedWorkItemVersion: terminalTask.version,
        expectedJourneyVersion: terminalJourney.version, evidenceReferences: []
      }, 'terminal-evidence') as never,
      requestHash: createHash('sha256').update('terminal-missing').digest('hex'), authorized: true
    })).resolves.toMatchObject({receipt: {result: {error: {code: 'INVALID_COMMAND'}}}});
    await db.update(actors).set({role: 'delivery_lead'}).where(eq(actors.id, ids.contributor));
    const wrongResponsible = {...envelope('delivery_journey.advance', {
      workItemId: ids.task, expectedWorkItemVersion: terminalTask.version,
      expectedJourneyVersion: terminalJourney.version,
      evidenceReferences: terminalStage.requiredEvidence.map((requirement) => ({
        requirement, reference: `artifact://wrong-responsible/${requirement}`
      }))
    }, 'terminal-wrong-responsible'), actor: {actorId: ids.contributor}};
    await expect(store.execute({command: wrongResponsible as never,
      requestHash: createHash('sha256').update('terminal-wrong-responsible').digest('hex'), authorized: true}))
      .resolves.toMatchObject({receipt: {result: {error: {code: 'CAPABILITY_DENIED'}}}});
    expect((await db.select().from(auditEvents).where(and(
      eq(auditEvents.workspaceId, ids.workspace), eq(auditEvents.actorId, ids.contributor),
      eq(auditEvents.action, 'delivery_journey.advance'))))[0]).toMatchObject({
      policyDecision: 'deny', outcome: 'rejected', reasonCode: 'CAPABILITY_DENIED'
    });
    const terminalCommand = envelope('delivery_journey.advance', {
        workItemId: ids.task, expectedWorkItemVersion: terminalTask.version,
        expectedJourneyVersion: terminalJourney.version,
        evidenceReferences: terminalStage.requiredEvidence.map((requirement) => ({
          requirement, reference: `artifact://terminal/${terminalStage.key}/${requirement}`
        }))
      }, 'terminal-evidence');
    const finalAcceptance = await store.execute({
      command: terminalCommand as never,
      requestHash: createHash('sha256').update('terminal-evidence').digest('hex'), authorized: true
    });
    expect(finalAcceptance).toMatchObject({receipt: {result: {ok: true, value: {
      task: {status: 'done', version: terminalTask.version}, journeyVersion: terminalJourney.version + 1,
      nextAllowedAction: {kind: 'blocked', reason: 'journey_complete'}
    }}}});
    expect((await db.select().from(deliveryJourneys).where(eq(
      deliveryJourneys.workItemId, ids.task)))[0]).toMatchObject({
      stageKey: terminalStage.key, version: terminalJourney.version + 1
    });
    await expect(store.execute({command: terminalCommand as never,
      requestHash: createHash('sha256').update('terminal-evidence').digest('hex'), authorized: true}))
      .resolves.toMatchObject({status: 'replayed', receipt: {result: {ok: true}}});
  });

  it('atomically pauses an exact selected journey, clears its snapshot, and serializes concurrent advances', async () => {
    const fixture = await seedSelectedManualJourney();
    const attempts = [
      {command: fixture.command('selected-advance-a', 'artifact://brief/a'),
        requestHash: createHash('sha256').update('selected-advance-a').digest('hex'), authorized: true},
      {command: fixture.command('selected-advance-b', 'artifact://brief/b'),
        requestHash: createHash('sha256').update('selected-advance-b').digest('hex'), authorized: true}
    ];
    const results = await Promise.all(attempts.map((attempt) =>
      fixture.store.execute({...attempt, command: attempt.command as never})));
    const successIndex = results.findIndex((result) =>
      'receipt' in result && result.receipt.result.ok);
    expect(successIndex).toBeGreaterThanOrEqual(0);
    expect(results.filter((result) => 'receipt' in result && result.receipt.result.ok)).toHaveLength(1);
    expect(results.filter((result) => 'receipt' in result && !result.receipt.result.ok &&
      result.receipt.result.error.code === 'VERSION_CONFLICT')).toHaveLength(1);

    expect((await db.select().from(workItems).where(eq(workItems.id, fixture.ids.task)))[0])
      .toMatchObject({status: 'in_dev', version: 2});
    expect((await db.select().from(deliveryJourneys).where(eq(
      deliveryJourneys.workItemId, fixture.ids.task)))[0])
      .toMatchObject({stageKey: 'development', version: 2});
    expect(await db.select().from(deliveryJourneyEvidence).where(eq(
      deliveryJourneyEvidence.workItemId, fixture.ids.task))).toHaveLength(1);
    expect((await db.select().from(projectExecutions).where(eq(
      projectExecutions.projectId, fixture.ids.project)))[0]).toMatchObject({
      status: 'paused', blockReason: null, version: 2,
      selectedWorkItemId: null, selectedPlanVersionId: null,
      selectedWorkItemVersion: null, selectedProtocolId: null,
      selectedProtocolVersion: null, selectedJourneyVersion: null,
      selectedStageKey: null, selectedResponsibleActorId: null,
      selectedAgentProfileId: null, selectedResponsibilityHash: null
    });
    await expect(loadProjectExecutionProjection(db, fixture.ids.workspace, fixture.ids.project))
      .resolves.toMatchObject({status: 'paused', version: 2, selection: null,
        blockReason: null, decisions: []});

    const winner = attempts[successIndex]!;
    await expect(fixture.store.execute({...winner, command: winner.command as never}))
      .resolves.toMatchObject({status: 'replayed', receipt: {result: {ok: true}}});
    expect((await db.select().from(projectExecutions).where(eq(
      projectExecutions.projectId, fixture.ids.project)))[0]).toMatchObject({
      status: 'paused', version: 2, selectedWorkItemId: null
    });
    expect(await db.select().from(commandReceipts).where(and(
      eq(commandReceipts.workspaceId, fixture.ids.workspace),
      eq(commandReceipts.commandType, 'delivery_journey.advance')))).toHaveLength(2);
    expect(await db.select().from(auditEvents).where(and(
      eq(auditEvents.workspaceId, fixture.ids.workspace),
      eq(auditEvents.action, 'delivery_journey.advance')))).toHaveLength(2);
  });

  it('rejects a stale selected responsibility without partially advancing either aggregate', async () => {
    const fixture = await seedSelectedManualJourney();
    await db.update(projectMemberships).set({version: 2})
      .where(eq(projectMemberships.id, fixture.ids.membership));
    const command = fixture.command('stale-selected-advance', 'artifact://brief/stale');
    await expect(fixture.store.execute({command: command as never,
      requestHash: createHash('sha256').update('stale-selected-advance').digest('hex'),
      authorized: true})).resolves.toMatchObject({receipt: {result: {
      error: {code: 'VERSION_CONFLICT'}
    }}});
    expect((await db.select().from(workItems).where(eq(workItems.id, fixture.ids.task)))[0])
      .toMatchObject({status: 'ready', version: 1});
    expect((await db.select().from(deliveryJourneys).where(eq(
      deliveryJourneys.workItemId, fixture.ids.task)))[0])
      .toMatchObject({stageKey: 'intake', version: 1});
    expect(await db.select().from(deliveryJourneyEvidence).where(eq(
      deliveryJourneyEvidence.workItemId, fixture.ids.task))).toHaveLength(0);
    expect((await db.select().from(projectExecutions).where(eq(
      projectExecutions.projectId, fixture.ids.project)))[0]).toMatchObject({
      status: 'blocked', blockReason: 'provider_handoff_required', version: 1,
      selectedWorkItemId: fixture.ids.task
    });
    await expect(loadProjectExecutionProjection(db, fixture.ids.workspace, fixture.ids.project))
      .resolves.toMatchObject({status: 'blocked', selection: null,
        blockReason: 'selection_preconditions_stale'});
  });

  it('fails closed instead of deadlocking when another execution command owns the row lock', async () => {
    const fixture = await seedSelectedManualJourney();
    const client = await testPool.connect();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await client.query('BEGIN');
      await client.query('SELECT project_id FROM project_executions WHERE project_id = $1 FOR UPDATE',
        [fixture.ids.project]);
      const command = fixture.command('locked-selected-advance', 'artifact://brief/locked');
      const result = await Promise.race([
        fixture.store.execute({command: command as never,
          requestHash: createHash('sha256').update('locked-selected-advance').digest('hex'),
          authorized: true}),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('delivery journey waited on execution lock')), 1_000);
        })
      ]);
      expect(result).toMatchObject({receipt: {result: {
        error: {code: 'VERSION_CONFLICT'}
      }}});
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      await client.query('ROLLBACK');
      client.release();
    }
    expect((await db.select().from(workItems).where(eq(workItems.id, fixture.ids.task)))[0])
      .toMatchObject({status: 'ready', version: 1});
    expect((await db.select().from(deliveryJourneys).where(eq(
      deliveryJourneys.workItemId, fixture.ids.task)))[0])
      .toMatchObject({stageKey: 'intake', version: 1});
    expect(await db.select().from(deliveryJourneyEvidence).where(eq(
      deliveryJourneyEvidence.workItemId, fixture.ids.task))).toHaveLength(0);
  });
});
