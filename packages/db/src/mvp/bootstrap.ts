import {createDatabase, subjectHash} from './runtime.ts';

const required = (name: string, max = 2_048): string => {
  const value = process.env[name];
  if (value === undefined || value.length === 0 || value.length > max || value.includes('\0')) throw new Error(`${name}_required`);
  return value;
};
const optional = (name: string): string | null => process.env[name]?.trim() || null;
const secretPath = (name: string): string => {
  const value = required(name);
  if (!value.startsWith('/')) throw new Error(`${name}_invalid`);
  return value;
};
const uuid = (name: string): string => {
  const value = required(name, 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new Error(`${name}_invalid`);
  return value;
};
/** Idempotent workspace bootstrap. Projects are created and removed only through the product UI. */
export const bootstrap = async (): Promise<void> => {
  const database = createDatabase(); const client = await database.connect();
  const workspaceId = uuid('FCP_WORKSPACE_ID'); const ownerId = uuid('BOOTSTRAP_OWNER_ACTOR_ID');
  const secretId = uuid('BOOTSTRAP_TRACKER_SECRET_REF_ID');
  const workspace = {slug: required('BOOTSTRAP_WORKSPACE_SLUG', 100), name: required('BOOTSTRAP_WORKSPACE_NAME', 200)};
  const trackerSecretLocator = secretPath('GITHUB_PROJECTS_TOKEN_FILE');
  try {
    await client.query('begin');
    await client.query(`insert into workspaces(id,slug,name) values($1,$2,$3) on conflict(id) do nothing`,
      [workspaceId,workspace.slug,workspace.name]);
    await client.query(`insert into actors(id,workspace_id,kind,display_name) values($1,$2,'human',$3) on conflict(id) do nothing`,
      [ownerId,workspaceId,required('BOOTSTRAP_OWNER_NAME',200)]);
    await client.query(`insert into actor_external_identities(actor_id,provider,subject_hash)
      values($1,'github',$2) on conflict(provider,subject_hash) do nothing`,
      [ownerId,subjectHash('github',required('BOOTSTRAP_OWNER_GITHUB_USER_ID',32))]);
    const ownerTelegram = optional('BOOTSTRAP_OWNER_TELEGRAM_USER_ID');
    if (ownerTelegram !== null) await client.query(`insert into actor_external_identities(actor_id,provider,subject_hash)
      values($1,'telegram',$2) on conflict(provider,subject_hash) do nothing`, [ownerId,subjectHash('telegram',ownerTelegram)]);
    await client.query(`insert into secret_refs(id,workspace_id,purpose,locator) values($1,$2,'tracker_read',$3)
      on conflict(id) do nothing`, [secretId,workspaceId,trackerSecretLocator]);
    const result = await client.query<{workspaceId:string;actorWorkspaceId:string;secretLocator:string}>(
      `select w.id as "workspaceId",a.workspace_id as "actorWorkspaceId",s.locator as "secretLocator"
       from workspaces w join actors a on a.id=$2 join secret_refs s on s.id=$3 and s.workspace_id=w.id where w.id=$1`,
    [workspaceId,ownerId,secretId]);
    const row = result.rows[0];
    if (row?.workspaceId !== workspaceId || row.actorWorkspaceId !== workspaceId ||
      row.secretLocator !== trackerSecretLocator) throw new Error('bootstrap_existing_state_conflict');
    await client.query('commit');
  } catch (error) { await client.query('rollback'); throw error; }
  finally { client.release(); await database.end(); }
};

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) await bootstrap();
