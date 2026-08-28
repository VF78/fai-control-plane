import type {OpaqueSecretRef} from '@fai-control-plane/domain';
import type {Database} from './runtime.ts';

export const projectHermesRuntimeArtifactKind = 'project_hermes_runtime_v1';
export const projectHermesRuntimeContract = 'fai.project-hermes-runtime.v1';

export type ProjectHermesSecretKind =
  | 'agent-delivery'
  | 'management-username'
  | 'management-password'
  | 'telegram-bot'
  | 'inbound-actions';

export const projectHermesSecretPurpose = (projectId: string, kind: ProjectHermesSecretKind): string =>
  `project-hermes:${projectId}:${kind}`;

export type ProjectHermesRuntimeBinding = Readonly<{
  workspaceId: string;
  projectId: string;
  slug: string;
  artifactVersion: string;
  runtimeId: string;
  gatewayEndpoint: string;
  managementEndpoint: string;
  workspacePath: string;
  telegramChatId: string;
  telegramAllowedUserIds: readonly string[];
  agentCredentialRef: OpaqueSecretRef;
  managementUsernameRef: OpaqueSecretRef;
  managementPasswordRef: OpaqueSecretRef;
  telegramCredentialRef: OpaqueSecretRef;
  inboundActionCredentialRef: OpaqueSecretRef;
}>;

type ArtifactRow = Readonly<{
  workspaceId: string;
  projectId: string;
  slug: string;
  artifactVersion: string;
  content: string;
}>;
type SecretRow = Readonly<{id: string; purpose: string; locator: string}>;
type ParsedArtifact = Readonly<{
  runtimeId: string;
  gatewayEndpoint: string;
  managementEndpoint: string;
  workspacePath: string;
  telegramChatId: string;
  telegramAllowedUserIds: readonly string[];
  secretIds: Readonly<Record<ProjectHermesSecretKind, string>>;
}>;

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const uuid = (value: unknown): value is string => typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const exactEndpoint = (value: unknown, expected: string): string | null => {
  if (typeof value !== 'string' || value.length > 2_048 || value.includes('\0')) return null;
  try {
    const endpoint = new URL(value);
    return endpoint.toString() === expected ? expected : null;
  } catch { return null; }
};
const workspacePath = (value: unknown): value is string => typeof value === 'string' &&
  /^\/(?!.*(?:^|\/)\.\.(?:\/|$))[^\0\r\n]{1,511}$/.test(value) && value !== '/';

export const parseProjectHermesRuntimeArtifact = (content: string): ParsedArtifact | null => {
  try {
    const value = object(JSON.parse(content));
    const telegram = object(value?.telegram); const refs = object(value?.secretRefs);
    const runtimeId = typeof value?.runtimeId === 'string' &&
      /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(value.runtimeId) ? value.runtimeId : null;
    const gatewayEndpoint = runtimeId === null ? null : exactEndpoint(value?.gatewayEndpoint,
      `http://${runtimeId}-gateway:8642/v1/runs`);
    const managementEndpoint = runtimeId === null ? null : exactEndpoint(value?.managementEndpoint,
      `http://${runtimeId}-management:9119/`);
    const allowed = telegram?.allowedUserIds;
    const secretIds = {
      'agent-delivery': refs?.agentDelivery,
      'management-username': refs?.managementUsername,
      'management-password': refs?.managementPassword,
      'telegram-bot': refs?.telegramBot,
      'inbound-actions': refs?.inboundActions
    };
    if (value?.contract !== projectHermesRuntimeContract || value.status !== 'ready' ||
      runtimeId === null || gatewayEndpoint === null || managementEndpoint === null || !workspacePath(value.workspacePath) ||
      typeof telegram?.chatId !== 'string' || !/^-?[1-9][0-9]{0,19}$/.test(telegram.chatId) ||
      !Array.isArray(allowed) || allowed.length === 0 || allowed.length > 100 ||
      allowed.some((id) => typeof id !== 'string' || !/^[1-9][0-9]{0,19}$/.test(id)) ||
      new Set(allowed).size !== allowed.length || Object.values(secretIds).some((id) => !uuid(id))) return null;
    return {runtimeId, gatewayEndpoint, managementEndpoint,
      workspacePath: value.workspacePath, telegramChatId: telegram.chatId,
      telegramAllowedUserIds: allowed as string[], secretIds: secretIds as Record<ProjectHermesSecretKind, string>};
  } catch { return null; }
};

const duplicateCoordinates = (bindings: readonly ProjectHermesRuntimeBinding[]): boolean => {
  const coordinates = bindings.flatMap((binding) => [
    `runtime:${binding.runtimeId}`,
    `gateway:${binding.gatewayEndpoint}`,
    `management:${binding.managementEndpoint}`,
    `workspace:${binding.workspacePath}`,
    `telegram:${binding.telegramChatId}`,
    ...[binding.agentCredentialRef, binding.managementUsernameRef, binding.managementPasswordRef,
      binding.telegramCredentialRef, binding.inboundActionCredentialRef].flatMap((reference) =>
        [`secret:${reference.id}`, `secret-locator:${reference.locator}`])
  ]);
  return new Set(coordinates).size !== coordinates.length;
};

/** Canonical non-secret binding for dedicated project runtimes. Invalid or shared coordinates fail closed. */
export const listProjectHermesRuntimeBindings = async (
  database: Database,
  workspaceId: string
): Promise<readonly ProjectHermesRuntimeBinding[]> => {
  const artifacts = await database.query<ArtifactRow>(`select p.workspace_id as "workspaceId",p.id as "projectId",p.slug,
    runtime.sha256 as "artifactVersion",runtime.content_text as content from projects p
    join lateral(select sha256,content_text from project_source_artifacts where project_id=p.id and kind=$2
      order by created_at desc,id desc limit 1)runtime on true where p.workspace_id=$1 order by p.id`,
  [workspaceId, projectHermesRuntimeArtifactKind]);
  const parsed = artifacts.rows.flatMap((row) => {
    const artifact = parseProjectHermesRuntimeArtifact(row.content);
    return artifact === null ? [] : [{row, artifact}];
  });
  const ids = [...new Set(parsed.flatMap(({artifact}) => Object.values(artifact.secretIds)))];
  if (ids.length === 0) return [];
  const secrets = await database.query<SecretRow>(`select id,purpose,locator from secret_refs
    where workspace_id=$1 and id=any($2::uuid[])`, [workspaceId, ids]);
  const byId = new Map(secrets.rows.map((secret) => [secret.id, secret]));
  const logicalPurpose: Record<ProjectHermesSecretKind, string> = {
    'agent-delivery': 'agent_delivery',
    'management-username': 'hermes_management_username',
    'management-password': 'hermes_management_password',
    'telegram-bot': 'messenger_delivery',
    'inbound-actions': 'hermes_inbound_actions'
  };
  const bindings = parsed.flatMap(({row, artifact}) => {
    const reference = (kind: ProjectHermesSecretKind): OpaqueSecretRef | null => {
      const secret = byId.get(artifact.secretIds[kind]);
      return secret !== undefined && secret.purpose === projectHermesSecretPurpose(row.projectId, kind) &&
        secret.locator.startsWith('/')
        ? {id: secret.id, purpose: logicalPurpose[kind], locator: secret.locator} : null;
    };
    const agentCredentialRef = reference('agent-delivery');
    const managementUsernameRef = reference('management-username');
    const managementPasswordRef = reference('management-password');
    const telegramCredentialRef = reference('telegram-bot');
    const inboundActionCredentialRef = reference('inbound-actions');
    if (agentCredentialRef === null || managementUsernameRef === null || managementPasswordRef === null ||
      telegramCredentialRef === null || inboundActionCredentialRef === null) return [];
    return [{workspaceId: row.workspaceId, projectId: row.projectId, slug: row.slug,
      artifactVersion: row.artifactVersion, ...artifact, agentCredentialRef, managementUsernameRef,
      managementPasswordRef, telegramCredentialRef, inboundActionCredentialRef}];
  });
  if (duplicateCoordinates(bindings)) throw new Error('project_hermes_runtime_conflict');
  return bindings;
};

export const readProjectHermesRuntimeBinding = async (
  database: Database,
  actorId: string,
  projectId: string
): Promise<ProjectHermesRuntimeBinding | null> => {
  const allowed = await database.query<{workspaceId: string}>(`select p.workspace_id as "workspaceId" from projects p
    join project_memberships m on m.project_id=p.id and m.actor_id=$1 and m.active=true where p.id=$2`,
  [actorId, projectId]);
  const workspaceId = allowed.rows[0]?.workspaceId;
  if (workspaceId === undefined) return null;
  return (await listProjectHermesRuntimeBindings(database, workspaceId)).find((binding) =>
    binding.projectId === projectId) ?? null;
};
