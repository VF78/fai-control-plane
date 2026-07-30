import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {and, asc, eq} from 'drizzle-orm';
import {migrate} from 'drizzle-orm/node-postgres/migrator';
import {Pool} from 'pg';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {dropDatabaseWhenDisconnected} from './integration-test-utils';
import {
  reconcileLaunchHumanRoster,
  reconcileLaunchProjectMemberships
} from './launch-roster';
import {
  actorExternalIdentities,
  actors,
  createDatabase,
  projectMemberships,
  projects,
  resourceAccessGrants,
  workspaces
} from './index';

const databaseUrl = process.env.DATABASE_URL;
if (process.env.CI && databaseUrl === undefined) {
  throw new Error('DATABASE_URL is required for launch roster integration tests in CI.');
}
const describePostgres = databaseUrl === undefined ? describe.skip : describe;
const databaseName = `fai_launch_roster_${randomUUID().replaceAll('-', '')}`;

describePostgres('launch roster reconciliation', () => {
  let adminPool: Pool;
  let testPool: Pool;
  let db: ReturnType<typeof createDatabase>['db'];
  const workspaceId = randomUUID();
  const projectSeeds = [
    {id: randomUUID(), name: 'MSA', slug: 'msa'},
    {id: randomUUID(), name: 'ASCON', slug: 'ascon'}
  ] as const;

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
    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url))
    });

    await db.insert(workspaces).values({
      id: workspaceId,
      name: 'fAI Studio',
      slug: `fai-studio-${randomUUID()}`
    });
    await db.insert(projects).values(projectSeeds.map((project) => ({
      ...project,
      workspaceId
    })));
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

  it('restores the fixed human and Hermes memberships without granting provider access', async () => {
    const firstRoster = await reconcileLaunchHumanRoster(
      db,
      workspaceId,
      'github:user:222',
      '111,222'
    );
    const [hermesActor] = await db.insert(actors).values({
      workspaceId,
      type: 'agent',
      role: 'agent_operator',
      displayName: 'Hermes',
      authMode: 'agent',
      externalSubject: 'agent:hermes:v1'
    }).returning({id: actors.id});
    if (hermesActor === undefined) throw new Error('Hermes actor seed failed');
    const [codexActor] = await db.insert(actors).values({
      workspaceId,
      type: 'agent',
      role: 'agent_operator',
      displayName: 'Codex CLI',
      authMode: 'agent',
      externalSubject: 'agent:codex-cli:v1'
    }).returning({id: actors.id});
    if (codexActor === undefined) throw new Error('Codex actor seed failed');
    const hermesActorId = hermesActor.id;
    const codexActorId = codexActor.id;

    for (const project of projectSeeds) {
      await reconcileLaunchProjectMemberships(
        db,
        project.id,
        firstRoster.members,
        hermesActorId
      );
    }
    const initialMembershipIds = (await db.select({id: projectMemberships.id})
      .from(projectMemberships)).map(({id}) => id).sort();
    const initialIdentityIds = (await db.select({id: actorExternalIdentities.id})
      .from(actorExternalIdentities)).map(({id}) => id).sort();

    const vladimirActorId = firstRoster.members
      .find(({role}) => role === 'project_owner')?.actorId;
    if (vladimirActorId === undefined) throw new Error('Vladimir actor missing');
    await db.update(actors).set({displayName: 'Stale owner'})
      .where(eq(actors.id, vladimirActorId));
    await db.update(actorExternalIdentities).set({active: false}).where(and(
      eq(actorExternalIdentities.actorId, vladimirActorId),
      eq(actorExternalIdentities.provider, 'github')
    ));
    await db.update(projectMemberships).set({
      role: 'contributor',
      active: false
    }).where(and(
      eq(projectMemberships.projectId, projectSeeds[0].id),
      eq(projectMemberships.actorId, vladimirActorId)
    ));

    const reconciledRoster = await reconcileLaunchHumanRoster(
      db,
      workspaceId,
      'github:user:222',
      '111,222'
    );
    for (const project of projectSeeds) {
      await reconcileLaunchProjectMemberships(
        db,
        project.id,
        reconciledRoster.members,
        hermesActorId
      );
    }

    const humans = await db.select({
      displayName: actors.displayName,
      role: actors.role,
      type: actors.type
    }).from(actors).where(eq(actors.type, 'human')).orderBy(asc(actors.displayName));
    expect(humans).toEqual([
      {displayName: 'Vitaliy', role: 'developer', type: 'human'},
      {displayName: 'Vladimir', role: 'workspace_admin', type: 'human'}
    ]);

    const identities = await db.select({
      displayName: actors.displayName,
      provider: actorExternalIdentities.provider,
      externalSubject: actorExternalIdentities.externalSubject,
      active: actorExternalIdentities.active
    }).from(actorExternalIdentities).innerJoin(
      actors,
      eq(actors.id, actorExternalIdentities.actorId)
    ).orderBy(asc(actors.displayName));
    expect(identities).toEqual([
      {
        displayName: 'Vitaliy',
        provider: 'github',
        externalSubject: 'github:user:111',
        active: true
      },
      {
        displayName: 'Vladimir',
        provider: 'github',
        externalSubject: 'github:user:222',
        active: true
      }
    ]);

    const memberships = await db.select({
      project: projects.slug,
      actor: actors.displayName,
      actorType: actors.type,
      role: projectMemberships.role,
      active: projectMemberships.active
    }).from(projectMemberships)
      .innerJoin(projects, eq(projects.id, projectMemberships.projectId))
      .innerJoin(actors, eq(actors.id, projectMemberships.actorId))
      .orderBy(asc(projects.slug), asc(actors.displayName));
    expect(memberships).toEqual([
      {project: 'ascon', actor: 'Hermes', actorType: 'agent', role: 'agent', active: true},
      {project: 'ascon', actor: 'Vitaliy', actorType: 'human', role: 'contributor', active: true},
      {project: 'ascon', actor: 'Vladimir', actorType: 'human', role: 'project_owner', active: true},
      {project: 'msa', actor: 'Hermes', actorType: 'agent', role: 'agent', active: true},
      {project: 'msa', actor: 'Vitaliy', actorType: 'human', role: 'contributor', active: true},
      {project: 'msa', actor: 'Vladimir', actorType: 'human', role: 'project_owner', active: true}
    ]);
    expect(memberships.some(({actor}) => actor === 'Codex CLI')).toBe(false);
    expect(await db.select({id: resourceAccessGrants.id}).from(resourceAccessGrants)).toEqual([]);

    const finalMembershipIds = (await db.select({id: projectMemberships.id})
      .from(projectMemberships)).map(({id}) => id).sort();
    const finalIdentityIds = (await db.select({id: actorExternalIdentities.id})
      .from(actorExternalIdentities)).map(({id}) => id).sort();
    expect(finalMembershipIds).toEqual(initialMembershipIds);
    expect(finalIdentityIds).toEqual(initialIdentityIds);
    expect(codexActorId).not.toBe(hermesActorId);
  });
});
