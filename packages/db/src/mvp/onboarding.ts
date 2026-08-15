import {randomUUID} from 'node:crypto';
import type {ProjectRole} from '@fai-control-plane/domain';
import type {Database} from './runtime.ts';

export type OnboardingIdentity = Readonly<{provider: 'github' | 'telegram' | 'bitrix24'; subjectHash: string}>;
export type OnboardProjectMemberInput = Readonly<{workspaceId: string; projectId: string; displayName: string;
  role: Exclude<ProjectRole, 'project_owner'>; identities: readonly OnboardingIdentity[]}>;
const valid = (value: string, maximum: number): boolean =>
  value.length > 0 && value.length <= maximum && !value.includes('\0');

/** Changes Control Plane access only; messenger room membership stays provider-owned. */
export const onboardProjectMember = async (database: Database, input: OnboardProjectMemberInput): Promise<Readonly<{
  actorId: string; created: boolean;
}>> => {
  const providers = input.identities.map(({provider}) => provider);
  const hasGitHub = providers.includes('github'); const hasBitrix = providers.includes('bitrix24');
  if (!valid(input.workspaceId, 256) || !valid(input.projectId, 256) || !valid(input.displayName, 200) ||
    !['operator', 'contributor', 'client'].includes(input.role) || input.identities.length === 0 ||
    new Set(providers).size !== providers.length ||
    input.identities.some(({provider, subjectHash}) =>
      !['github', 'telegram', 'bitrix24'].includes(provider) || !/^[a-f0-9]{64}$/.test(subjectHash)) ||
    (input.role === 'client' ? !hasGitHub && !hasBitrix : !hasGitHub)) throw new Error('onboarding_invalid');
  const client = await database.connect();
  try {
    await client.query('begin');
    const project = await client.query('select 1 from projects where id=$1 and workspace_id=$2 for update',
      [input.projectId, input.workspaceId]);
    if (project.rowCount !== 1) throw new Error('onboarding_denied');
    for (const identity of [...input.identities].sort((left, right) =>
      `${left.provider}:${left.subjectHash}`.localeCompare(`${right.provider}:${right.subjectHash}`))) {
      await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',
        [`onboard:${identity.provider}:${identity.subjectHash}`]);
    }
    const existing = await client.query<{actorId: string; workspaceId: string; kind: string; enabled: boolean}>(
      `select i.actor_id as "actorId",a.workspace_id as "workspaceId",a.kind,a.enabled
       from actor_external_identities i join actors a on a.id=i.actor_id
       where (i.provider,i.subject_hash) in (
         select value->>'provider',value->>'subjectHash' from jsonb_array_elements($1::jsonb) value
       ) for update`, [JSON.stringify(input.identities)]);
    if (existing.rows.some((row) => row.workspaceId !== input.workspaceId || row.kind !== 'human' || !row.enabled)) {
      throw new Error('onboarding_denied');
    }
    const actorIds = new Set(existing.rows.map(({actorId}) => actorId));
    if (actorIds.size > 1) throw new Error('onboarding_identity_conflict');
    const created = actorIds.size === 0;
    const actorId = actorIds.values().next().value as string | undefined ?? randomUUID();
    if (created) await client.query(`insert into actors(id,workspace_id,kind,display_name) values($1,$2,'human',$3)`,
      [actorId, input.workspaceId, input.displayName]);
    for (const identity of input.identities) {
      const bound = await client.query<{actorId: string}>(
        `insert into actor_external_identities(actor_id,provider,subject_hash) values($1,$2,$3)
         on conflict(provider,subject_hash) do update set subject_hash=excluded.subject_hash
         returning actor_id as "actorId"`, [actorId, identity.provider, identity.subjectHash]);
      if (bound.rows[0]?.actorId !== actorId) throw new Error('onboarding_identity_conflict');
    }
    await client.query(
      `insert into project_memberships(project_id,actor_id,role,active) values($1,$2,$3,true)
       on conflict(project_id,actor_id) do update set role=excluded.role,active=true`,
      [input.projectId, actorId, input.role]);
    await client.query('commit');
    return {actorId, created};
  } catch (error) { await client.query('rollback'); throw error; }
  finally { client.release(); }
};
