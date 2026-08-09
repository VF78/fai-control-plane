import {execFile} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {and, asc, eq} from 'drizzle-orm';
import {migrate} from 'drizzle-orm/node-postgres/migrator';
import {Pool} from 'pg';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import type {DeliveryProtocolDefinition} from '@fai-control-plane/domain';
import {
  actorExternalIdentities,
  actors,
  agentProfiles,
  conversationChannelConfigurations,
  conversationBindings,
  conversationMessages,
  conversationParticipants,
  createDatabase,
  createPostgresConversationStore,
  createPostgresDeliveryJourneyStore,
  deliveryJourneys,
  projectMemberships,
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
const keyedRef = (value: string) =>
  `tgid:v1:${createHash('sha256').update(value).digest('hex')}`;
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
      role: projectMemberships.role,
      active: projectMemberships.active
    }).from(projectMemberships)
      .innerJoin(projects, eq(projects.id, projectMemberships.projectId))
      .innerJoin(actors, eq(actors.id, projectMemberships.actorId))
      .orderBy(asc(projects.slug), asc(actors.displayName));
    expect(memberships.filter(({active}) => active)).toEqual([
      {project: 'ascon', actor: 'Vladimir', role: 'project_owner', active: true},
      {project: 'msa', actor: 'Hermes', role: 'agent', active: true},
      {project: 'msa', actor: 'Vitaliy', role: 'contributor', active: true},
      {project: 'msa', actor: 'Vladimir', role: 'project_owner', active: true}
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
    expect(await db.select().from(projectTrackerRepositoryScopes)
      .orderBy(asc(projectTrackerRepositoryScopes.repositoryName))).toMatchObject([
      {provider: 'github', repositoryOwner: 'VF78', repositoryName: 'ascon'},
      {provider: 'github', repositoryOwner: 'VF78', repositoryName: 'MSA'}
    ]);
  });

  it('accepts only the configured MSA internal chat and resolves the three launch participants', async () => {
    const projectRows = await db.select().from(projects);
    const msa = projectRows.find(({slug}) => slug === 'msa')!;
    const ascon = projectRows.find(({slug}) => slug === 'ascon')!;
    const [workspace] = await db.select().from(workspaces);
    if (workspace === undefined) throw new Error('workspace missing');
    const store = createPostgresConversationStore(db);
    const activation = new Date('2026-07-30T10:00:00.000Z');
    const bindingRef = keyedRef('synthetic-msa-internal');
    const channelId = randomUUID();
    await db.insert(conversationChannelConfigurations).values({
      id: channelId,
      projectId: msa.id,
      conversationClass: 'internal',
      desiredState: 'active',
      provider: 'telegram',
      configurationRef: 'telegram:msa:internal'
    });
    await store.reconcileBindings('telegram', [msa.id, ascon.id], [{
      configurationId: channelId,
      projectId: msa.id,
      conversationClass: 'internal',
      provider: 'telegram',
      configurationRef: 'telegram:msa:internal',
      externalRef: bindingRef,
      activatedAt: activation
    }]);
    await store.reconcileIdentities(workspace.id, 'telegram', [
      {actorExternalSubject: 'github:user:222', externalSubject: keyedRef('vladimir')},
      {actorExternalSubject: 'github:user:111', externalSubject: keyedRef('vitaliy')},
      {actorExternalSubject: 'agent:hermes:v1', externalSubject: keyedRef('hermes')}
    ]);
    const observation = (actor: string, sequence: number, sentAt: Date) => ({
      provider: 'telegram',
      externalBindingRef: bindingRef,
      deliveryRef: keyedRef(`delivery-${sequence}`),
      messageRef: keyedRef(`message-${sequence}`),
      authorExternalSubject: keyedRef(actor),
      authorDisplayName: actor,
      sentAt,
      replyToMessageRef: null,
      threadRef: null,
      text: `synthetic ${actor}`,
      attachments: []
    } as const);
    await expect(store.ingest(observation(
      'vladimir', 0, new Date(activation.getTime() - 1)
    ))).resolves.toBe('before_activation');
    for (const [index, actor] of ['vladimir', 'vitaliy', 'hermes'].entries()) {
      await expect(store.ingest(observation(
        actor, index + 1, new Date(activation.getTime() + index + 1)
      ))).resolves.toBe('accepted');
    }
    expect(await db.select().from(conversationBindings)).toMatchObject([{
      projectId: msa.id,
      conversationClass: 'internal',
      provider: 'telegram',
      active: true
    }]);
    expect(await db.select().from(conversationMessages)).toHaveLength(3);
    expect(await db.select().from(conversationParticipants)).toHaveLength(3);
    expect((await db.select().from(conversationParticipants))
      .every(({actorId}) => actorId !== null)).toBe(true);
    expect(await db.select().from(actorExternalIdentities)
      .where(eq(actorExternalIdentities.provider, 'telegram'))).toHaveLength(3);
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
      const [task] = await db.insert(workItems).values({
        projectId: project.id,
        title: `Synthetic ${project.slug} journey`,
        ownerActorId: owner.id
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
        stages: Array<{key: string; requiredEvidence: string[]}>
      };
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
        .where(eq(workItems.id, task.id)))[0]).toMatchObject({status: 'done'});
      expect((await db.select().from(deliveryJourneys)
        .where(eq(deliveryJourneys.workItemId, task.id)))[0])
        .toMatchObject({stageKey: 'acceptance'});
    }

    const [registration] = await db.select().from(runtimeRegistrations);
    if (registration === undefined) throw new Error('runtime registration missing');
    for (const component of ['service', 'scheduler', 'delivery'] as const) {
      await db.insert(runtimeAvailabilityObservations).values({
        runtimeRegistrationId: registration.id,
        component,
        state: 'available',
        observedAt,
        ttlSeconds: 300,
        evidenceReference: `test://hermes/${component}/available`
      });
    }
    expect(await db.select().from(runtimeAvailabilityObservations)).toHaveLength(3);
    expect(await db.select().from(trackerSnapshotOperations)).toHaveLength(2);
  });
});
