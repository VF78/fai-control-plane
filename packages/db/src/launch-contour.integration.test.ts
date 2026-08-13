import {execFile} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {and, asc, eq, inArray} from 'drizzle-orm';
import {migrate} from 'drizzle-orm/node-postgres/migrator';
import {Pool} from 'pg';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {createActorContextIssuer, type DeliveryProtocolDefinition} from '@fai-control-plane/domain';
import {createCanonicalCommandService} from '../../application/src/index';
import {
  actors,
  agentProfiles,
  createDatabase,
  createPostgresUnitOfWork,
  createPostgresDeliveryJourneyStore,
  createPostgresGovernedQaStore,
  deliveryJourneys,
  projectMemberships,
  projectPlanDrafts,
  projectPlanVersions,
  projects,
  projectTrackerRepositoryScopes,
  runbooks,
  runtimeAvailabilityObservations,
  runtimeRegistrations,
  trackerSnapshotOperations,
  workspaceInstructionVersions,
  workItems,
  workspaces
} from './index';
import {dropDatabaseWhenDisconnected} from './integration-test-utils';

const databaseUrl = process.env.DATABASE_URL;
if (process.env.CI && databaseUrl === undefined) {
  throw new Error('DATABASE_URL is required for launch contour integration tests in CI.');
}
const describePostgres = databaseUrl === undefined ? describe.skip : describe;
const databaseName = `fai_launch_contour_${randomUUID().replaceAll('-', '')}`;
const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const requestHash = (value: string) =>
  createHash('sha256').update(value).digest('hex');

describePostgres('test-operational launch contour', () => {
  let adminPool: Pool;
  let testPool: Pool;
  let db: ReturnType<typeof createDatabase>['db'];
  let testDatabaseUrl: string;

  beforeAll(async () => {
    const adminUrl = new URL(databaseUrl!);
    adminUrl.pathname = '/postgres';
    adminPool = new Pool({connectionString: adminUrl.toString()});
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    const testUrl = new URL(databaseUrl!);
    testUrl.pathname = `/${databaseName}`;
    testDatabaseUrl = testUrl.toString();
    const created = createDatabase(testDatabaseUrl);
    db = created.db;
    testPool = created.pool;
    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url))
    });
    const seedEnvironment = {
      ...process.env,
      DATABASE_URL: testDatabaseUrl,
      GITHUB_PROJECTS_OAUTH_TOKEN_FILE: '/synthetic/not-resolved',
      FCP_BOOTSTRAP_HUMAN_SUBJECT: 'github:user:222',
      FCP_OPERATOR_GITHUB_USER_IDS: '111,222'
    };
    await execFileAsync(
      'pnpm',
      ['--filter', '@fai-control-plane/db', 'db:seed'],
      {cwd: repositoryRoot, env: seedEnvironment}
    );
    await execFileAsync(
      'pnpm',
      ['--filter', '@fai-control-plane/db', 'db:seed'],
      {cwd: repositoryRoot, env: seedEnvironment}
    );
  }, 60_000);

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

  it('persists the fixed provider-neutral roster, protocols and Hermes boundary idempotently', async () => {
    const [workspace] = await db.select().from(workspaces)
      .where(eq(workspaces.slug, 'fai-studio'));
    if (workspace === undefined) throw new Error('workspace missing');
    const projectRows = await db.select().from(projects)
      .where(eq(projects.workspaceId, workspace.id)).orderBy(asc(projects.slug));
    expect(projectRows.map(({slug}) => slug)).toEqual(['ascon', 'msa']);

    const memberships = await db.select({
      project: projects.slug,
      actor: actors.displayName,
      roles: projectMemberships.roles,
      active: projectMemberships.active
    }).from(projectMemberships)
      .innerJoin(projects, eq(projects.id, projectMemberships.projectId))
      .innerJoin(actors, eq(actors.id, projectMemberships.actorId))
      .orderBy(asc(projects.slug), asc(actors.displayName));
    expect(memberships.filter(({active}) => active)).toEqual([
      {project: 'ascon', actor: 'Vladimir', roles: ['project_owner', 'contributor'], active: true},
      {project: 'msa', actor: 'Hermes', roles: ['agent'], active: true},
      {project: 'msa', actor: 'Vitaliy', roles: ['contributor'], active: true},
      {project: 'msa', actor: 'Vladimir', roles: ['project_owner'], active: true}
    ]);

    const protocolRows = await db.select({
      project: projects.slug,
      definition: runbooks.definition,
      state: runbooks.protocolState,
      active: runbooks.active
    }).from(runbooks).innerJoin(projects, eq(projects.id, runbooks.projectId))
      .orderBy(asc(projects.slug));
    expect(protocolRows).toHaveLength(2);
    expect(protocolRows.every(({state, active}) => state === 'published' && active)).toBe(true);
    const msaStages = (protocolRows.find(({project}) => project === 'msa')
      ?.definition as unknown as DeliveryProtocolDefinition).stages;
    const asconStages = (protocolRows.find(({project}) => project === 'ascon')
      ?.definition as unknown as DeliveryProtocolDefinition).stages;
    expect(msaStages.find(({key}) => key === 'development')?.responsibility)
      .toEqual({kind: 'project_role', role: 'contributor'});
    expect(msaStages.find(({key}) => key === 'qa')).toMatchObject({
      executionMode: 'autonomous',
      responsibility: {kind: 'actor', actorType: 'agent'}
    });
    expect(msaStages.find(({key}) => key === 'staging')).toMatchObject({
      executionMode: 'human_approval',
      responsibility: {kind: 'actor', actorType: 'agent'}
    });
    expect(asconStages.every(({responsibility}) =>
      responsibility.kind === 'project_role' &&
      responsibility.role === 'project_owner'
    )).toBe(true);

    const registrations = await db.select({
      project: projects.slug,
      provider: runtimeRegistrations.provider,
      runtimeKey: runtimeRegistrations.runtimeKey,
      serviceTtl: runtimeRegistrations.serviceMaxAgeSeconds,
      schedulerTtl: runtimeRegistrations.schedulerMaxAgeSeconds,
      deliveryTtl: runtimeRegistrations.deliveryMaxAgeSeconds
    }).from(runtimeRegistrations)
      .innerJoin(projects, eq(projects.id, runtimeRegistrations.projectId));
    expect(registrations).toEqual([{
      project: 'msa',
      provider: 'provider_neutral',
      runtimeKey: 'hermes',
      serviceTtl: 300,
      schedulerTtl: 900,
      deliveryTtl: 93_600
    }]);
    expect(await db.select().from(workspaceInstructionVersions)).toHaveLength(1);
    expect(await db.select().from(agentProfiles)
      .where(eq(agentProfiles.runtimeId, 'hermes'))).toHaveLength(1);
    expect(await db.select({
      type: actors.type,
      role: actors.role,
      authMode: actors.authMode,
      externalSubject: actors.externalSubject,
      capabilities: actors.capabilities,
      disabledAt: actors.disabledAt
    }).from(actors).where(and(
      eq(actors.workspaceId, workspace.id),
      eq(actors.authMode, 'system'),
      eq(actors.externalSubject, 'system:runtime-observer:v1')
    ))).toEqual([{
      type: 'system',
      role: 'agent_operator',
      authMode: 'system',
      externalSubject: 'system:runtime-observer:v1',
      capabilities: {'write:runtime_observation:development': true},
      disabledAt: null
    }]);
    expect(await db.select().from(projectTrackerRepositoryScopes)
      .orderBy(asc(projectTrackerRepositoryScopes.repositoryName))).toMatchObject([
      {provider: 'github', repositoryOwner: 'VF78', repositoryName: 'ascon'},
      {provider: 'github', repositoryOwner: 'VF78', repositoryName: 'MSA'}
    ]);
  });

  it('persists only component-exact runtime observation TTLs through the canonical command', async () => {
    const [workspace] = await db.select().from(workspaces)
      .where(eq(workspaces.slug, 'fai-studio'));
    if (workspace === undefined) throw new Error('runtime observation workspace fixture missing');
    const [registration] = await db.select().from(runtimeRegistrations);
    const [runtimeObserver] = await db.select({id: actors.id}).from(actors).where(and(
      eq(actors.workspaceId, workspace.id),
      eq(actors.externalSubject, 'system:runtime-observer:v1')
    ));
    if (registration === undefined || runtimeObserver === undefined) {
      throw new Error('runtime observation fixture missing');
    }
    const issuer = createActorContextIssuer({users: [], agents: [], systems: [{
      actorId: runtimeObserver.id,
      capabilities: ['write:runtime_observation:development']
    }]});
    if (!issuer.ok) throw new Error('runtime observation issuer failed');
    const actor = issuer.value.issueSystem(runtimeObserver.id);
    if (!actor.ok) throw new Error('runtime observation actor failed');
    const service = createCanonicalCommandService({unitOfWork: createPostgresUnitOfWork(db)});
    const observe = (
      observationId: string,
      component: 'service' | 'scheduler' | 'delivery',
      ttlSeconds: number
    ) => ({
      commandId: randomUUID(),
      workspaceId: workspace.id,
      correlationId: randomUUID(),
      idempotencyKey: `launch-runtime-observation-${observationId}`,
      issuedAt: new Date().toISOString(),
      actor: actor.value,
      type: 'runtime_availability.observe' as const,
      payload: {
        observationId,
        registrationId: registration.id,
        component,
        state: 'available' as const,
        observedAt: new Date().toISOString(),
        ttlSeconds,
        evidenceReference: `test://hermes/canonical/${component}/${observationId}`
      }
    });
    const expectedTtls = {service: 300, scheduler: 900, delivery: 93_600} as const;
    const acceptedIds: string[] = [];
    for (const component of ['service', 'scheduler', 'delivery'] as const) {
      const observationId = randomUUID();
      acceptedIds.push(observationId);
      await expect(service.execute(observe(observationId, component, expectedTtls[component])))
        .resolves.toMatchObject({status: 'completed', receipt: {result: {ok: true}}});
    }
    const accepted = await db.select({
      component: runtimeAvailabilityObservations.component,
      ttlSeconds: runtimeAvailabilityObservations.ttlSeconds
    }).from(runtimeAvailabilityObservations)
      .where(inArray(runtimeAvailabilityObservations.id, acceptedIds));
    expect(Object.fromEntries(accepted.map(({component, ttlSeconds}) => [component, ttlSeconds])))
      .toEqual(expectedTtls);

    const mismatchedId = randomUUID();
    await expect(service.execute(observe(mismatchedId, 'delivery', 120)))
      .resolves.toMatchObject({status: 'completed', receipt: {result: {
        error: {code: 'NOT_FOUND'}
      }}});
    expect(await db.select().from(runtimeAvailabilityObservations)
      .where(eq(runtimeAvailabilityObservations.id, mismatchedId))).toHaveLength(0);
    await db.delete(runtimeAvailabilityObservations)
      .where(inArray(runtimeAvailabilityObservations.id, acceptedIds));
  });

  it('records fresh tracker/runtime facts and reaches the acceptance boundary for both projects', async () => {
    const [workspace] = await db.select().from(workspaces);
    if (workspace === undefined) throw new Error('workspace missing');
    const projectRows = await db.select().from(projects).orderBy(asc(projects.slug));
    const [owner] = await db.select().from(actors)
      .where(eq(actors.externalSubject, 'github:user:222'));
    if (owner === undefined) throw new Error('owner missing');
    const observedAt = new Date();

    for (const project of projectRows) {
      const [scope] = await db.select().from(projectTrackerRepositoryScopes)
        .where(eq(projectTrackerRepositoryScopes.projectId, project.id));
      if (scope === undefined) throw new Error('tracker scope missing');
      await db.insert(trackerSnapshotOperations).values({
        workspaceId: workspace.id,
        projectId: project.id,
        provider: scope.provider,
        repositoryExternalId: scope.repositoryExternalId,
        mode: 'synchronize',
        requestHash: requestHash(`snapshot-${project.slug}`),
        snapshotExternalVersion: `synthetic:${project.slug}:fresh`,
        result: {status: 'applied', source: 'synthetic_test'},
        createdAt: observedAt
      });

      const [protocol] = await db.select().from(runbooks).where(and(
        eq(runbooks.projectId, project.id),
        eq(runbooks.active, true)
      ));
      if (protocol === undefined) throw new Error('protocol missing');
      const planId = randomUUID();
      const planVersionId = randomUUID();
      const planDefinition = {title: `Synthetic ${project.slug} plan`, outcomes: [], milestones: [], risks: [], tasks: []};
      const approvedAt = new Date();
      await db.insert(projectPlanDrafts).values({
        id: planId,
        workspaceId: workspace.id,
        projectId: project.id,
        state: 'approved',
        definition: planDefinition as never,
        contentHash: requestHash(`plan-${project.slug}`),
        revision: 1,
        createdByActorId: owner.id,
        approvedByActorId: owner.id,
        approvedAt
      });
      await db.insert(projectPlanVersions).values({
        id: planVersionId,
        workspaceId: workspace.id,
        projectId: project.id,
        planId,
        version: 1,
        sourceRevision: 1,
        definition: planDefinition as never,
        contentHash: requestHash(`plan-${project.slug}`),
        sourceManifest: [],
        simulation: {} as never,
        approvedByActorId: owner.id,
        approvedAt
      });
      const [task] = await db.insert(workItems).values({
        projectId: project.id,
        title: `Synthetic ${project.slug} journey`,
        ownerActorId: owner.id,
        sourcePlanVersionId: planVersionId,
        sourceTaskKey: `synthetic-${project.slug}`,
        responsibility: {kind: 'human', actorId: owner.id},
        acceptanceEvidence: []
      }).returning();
      if (task === undefined) throw new Error('task missing');
      const store = createPostgresDeliveryJourneyStore(db);
      const command = (
        type: 'delivery_journey.start' | 'delivery_journey.advance',
        payload: Record<string, unknown>,
        key: string
      ) => ({
        commandId: randomUUID(),
        workspaceId: workspace.id,
        correlationId: randomUUID(),
        idempotencyKey: key,
        actor: {actorId: owner.id},
        type,
        payload
      });
      const startKey = `start-${project.slug}`;
      await expect(store.execute({
        command: command('delivery_journey.start', {
          workItemId: task.id,
          protocolId: protocol.id,
          expectedWorkItemVersion: 1,
          deadlineAt: null
        }, startKey) as never,
        requestHash: requestHash(startKey),
        authorized: true
      })).resolves.toMatchObject({receipt: {result: {ok: true}}});

      const definition = protocol.definition as {
        stages: Array<{
          key: string;
          taskStatus: string;
          executionMode: string;
          requiredEvidence: string[];
        }>
      };
      let stoppedAtAutonomousQa = false;
      for (let index = 0; index < definition.stages.length - 1; index += 1) {
        const [currentTask] = await db.select().from(workItems)
          .where(eq(workItems.id, task.id));
        const [journey] = await db.select().from(deliveryJourneys)
          .where(eq(deliveryJourneys.workItemId, task.id));
        const stage = definition.stages[index]!;
        if (currentTask === undefined || journey === undefined) {
          throw new Error('journey state missing');
        }
        const advanceKey = `advance-${project.slug}-${stage.key}`;
        if (stage.taskStatus === 'qa') {
          if (stage.executionMode === 'autonomous') {
            await expect(store.execute({
              command: command('delivery_journey.advance', {
                workItemId: task.id,
                expectedWorkItemVersion: currentTask.version,
                expectedJourneyVersion: journey.version,
                evidenceReferences: stage.requiredEvidence.map((requirement) => ({
                  requirement,
                  reference: `test://${project.slug}/${stage.key}/${requestHash(requirement)}`
                }))
              }, advanceKey) as never,
              requestHash: requestHash(advanceKey),
              authorized: true
            })).resolves.toMatchObject({receipt: {result: {error: {code: 'INVALID_TRANSITION'}}}});
            stoppedAtAutonomousQa = true;
            break;
          }
          const qaStore = createPostgresGovernedQaStore(db);
          const prepareKey = `qa-prepare-${project.slug}-${stage.key}`;
          const prepared = await qaStore.execute({
            command: {
              ...command('delivery_journey.advance', {}, prepareKey),
              type: 'qa_task_packet.prepare.v1',
              payload: {
                workItemId: task.id,
                expectedWorkItemVersion: currentTask.version,
                expectedJourneyVersion: journey.version
              }
            } as never,
            requestHash: requestHash(prepareKey),
            authorized: true
          });
          if (!('receipt' in prepared) || !prepared.receipt.result.ok) {
            throw new Error(`governed QA packet preparation failed: ${JSON.stringify(
              'receipt' in prepared ? prepared.receipt.result : prepared
            )}`);
          }
          const reviewKey = `qa-review-${project.slug}-${stage.key}`;
          await expect(qaStore.execute({
            command: {
              ...command('delivery_journey.advance', {}, reviewKey),
              type: 'qa_review.record.v1',
              payload: {
                workItemId: task.id,
                expectedWorkItemVersion: currentTask.version,
                expectedJourneyVersion: journey.version,
                taskPacketId: prepared.receipt.result.value.taskPacketId,
                evidence: {
                  outcome: 'passed',
                  checks: [{name: 'launch contour QA', status: 'passed', reference: `test://${project.slug}/qa/check`}],
                  artifacts: [{kind: 'report', reference: `test://${project.slug}/qa/report`}],
                  failures: [],
                  risks: [],
                  evidenceReferences: stage.requiredEvidence.map((requirement) => ({
                    requirement,
                    reference: `test://${project.slug}/${stage.key}/${requestHash(requirement)}`
                  }))
                }
              }
            } as never,
            requestHash: requestHash(reviewKey),
            authorized: true
          })).resolves.toMatchObject({receipt: {result: {ok: true}}});
          continue;
        }
        await expect(store.execute({
          command: command('delivery_journey.advance', {
            workItemId: task.id,
            expectedWorkItemVersion: currentTask.version,
            expectedJourneyVersion: journey.version,
            evidenceReferences: stage.requiredEvidence.map((requirement) => ({
              requirement,
              reference: `test://${project.slug}/${stage.key}/${requestHash(requirement)}`
            }))
          }, advanceKey) as never,
          requestHash: requestHash(advanceKey),
          authorized: true
        })).resolves.toMatchObject({receipt: {result: {ok: true}}});
      }
      expect((await db.select().from(workItems)
        .where(eq(workItems.id, task.id)))[0]).toMatchObject({
        status: stoppedAtAutonomousQa ? 'qa' : 'done'
      });
      expect((await db.select().from(deliveryJourneys)
        .where(eq(deliveryJourneys.workItemId, task.id)))[0]).toMatchObject({
        stageKey: stoppedAtAutonomousQa ? 'qa' : 'acceptance'
      });
    }

    const [registration] = await db.select().from(runtimeRegistrations);
    if (registration === undefined) throw new Error('runtime registration missing');
    const ttlByComponent = {service: 300, scheduler: 900, delivery: 93_600} as const;
    for (const component of ['service', 'scheduler', 'delivery'] as const) {
      await db.insert(runtimeAvailabilityObservations).values({
        runtimeRegistrationId: registration.id,
        component,
        state: 'available',
        observedAt,
        ttlSeconds: ttlByComponent[component],
        evidenceReference: `test://hermes/${component}/available`
      });
    }
    expect(await db.select().from(runtimeAvailabilityObservations)).toHaveLength(3);
    expect(await db.select().from(trackerSnapshotOperations)).toHaveLength(2);
  });
});
