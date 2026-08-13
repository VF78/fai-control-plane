import {randomUUID} from 'node:crypto';
import {afterAll, describe, expect, it} from 'vitest';
import {createDatabase, resolveActiveHumanMember, subjectHash} from './runtime.ts';

const enabled = process.env.DATABASE_URL !== undefined && process.env.FCP_PROJECT_ID !== undefined;
const database = enabled ? createDatabase() : null;

describe.skipIf(!enabled)('exact provider sender authority', () => {
  afterAll(async () => database?.end());

  it('maps one sender to one active human member and denies every adjacent identity', async () => {
    const projectId = process.env.FCP_PROJECT_ID!;
    const workspace = await database!.query<{workspaceId: string}>(
      'select workspace_id as "workspaceId" from projects where id=$1', [projectId]);
    const workspaceId = workspace.rows[0]!.workspaceId;
    const actors = {clientA: randomUUID(), clientB: randomUUID(), inactive: randomUUID(), agent: randomUUID()};
    const subjects = {clientA: `client-a-${randomUUID()}`, clientB: `client-b-${randomUUID()}`,
      inactive: `inactive-${randomUUID()}`, agent: `agent-${randomUUID()}`};
    try {
      for (const [name, actorId] of Object.entries(actors)) await database!.query(
        `insert into actors(id,workspace_id,kind,display_name) values($1,$2,$3,$4)`,
        [actorId, workspaceId, name === 'agent' ? 'agent' : 'human', name]
      );
      for (const [name, actorId] of Object.entries(actors)) await database!.query(
        `insert into actor_external_identities(actor_id,provider,subject_hash) values($1,'bitrix24',$2)`,
        [actorId, subjectHash('bitrix24', subjects[name as keyof typeof subjects])]
      );
      for (const [name, actorId] of Object.entries(actors)) await database!.query(
        `insert into project_memberships(project_id,actor_id,role,active) values($1,$2,$3,$4)`,
        [projectId, actorId, name === 'clientA' || name === 'clientB' ? 'client' : 'operator', name !== 'inactive']
      );
      await expect(resolveActiveHumanMember(database!, projectId, subjectHash('bitrix24', subjects.clientA)))
        .resolves.toEqual({actorId: actors.clientA, role: 'client'});
      await expect(resolveActiveHumanMember(database!, projectId, subjectHash('bitrix24', subjects.clientB)))
        .resolves.toEqual({actorId: actors.clientB, role: 'client'});
      await expect(resolveActiveHumanMember(database!, projectId, subjectHash('bitrix24', subjects.inactive)))
        .resolves.toBeNull();
      await expect(resolveActiveHumanMember(database!, projectId, subjectHash('bitrix24', subjects.agent)))
        .resolves.toBeNull();
      await expect(resolveActiveHumanMember(database!, projectId, subjectHash('bitrix24', 'unmapped')))
        .resolves.toBeNull();
    } finally {
      const ids = Object.values(actors);
      await database!.query('delete from project_memberships where actor_id=any($1::uuid[])', [ids]);
      await database!.query('delete from actor_external_identities where actor_id=any($1::uuid[])', [ids]);
      await database!.query('delete from actors where id=any($1::uuid[])', [ids]);
    }
  });
});
