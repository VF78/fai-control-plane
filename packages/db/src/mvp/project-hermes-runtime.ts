import type {AgentExecutorCatalog,OpaqueSecretRef} from '@fai-control-plane/domain';
import type {Database} from './runtime.ts';

export const projectHermesRuntimeArtifactKind = 'project_hermes_runtime_v2';
export const projectHermesRuntimeContract = 'fai.project-hermes-runtime.v2';
export const projectHermesRuntimeImageVersion = 'v2026.8.31-codex-0.153.4';

export type ProjectHermesRuntimeStatus =
  | 'not_configured'
  | 'messenger_ready'
  | 'installing'
  | 'auth_required'
  | 'ready'
  | 'error';

export type ProjectHermesSecretKind =
  | 'agent-delivery'
  | 'dashboard-username'
  | 'dashboard-password'
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
  dashboardEndpoint: string;
  workspacePath: string;
  telegramChatId: string | null;
  telegramAllowedUserIds: readonly string[];
  agentCredentialRef: OpaqueSecretRef;
  dashboardUsernameRef: OpaqueSecretRef;
  dashboardPasswordRef: OpaqueSecretRef;
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
export type ParsedProjectHermesRuntimeArtifact = Readonly<{
  status: Exclude<ProjectHermesRuntimeStatus, 'not_configured'>;
  runtimeId: string;
  gatewayEndpoint: string;
  dashboardEndpoint: string;
  workspacePath: string;
  telegramChatId: string | null;
  telegramAllowedUserIds: readonly string[];
  secretIds: Readonly<Record<ProjectHermesSecretKind, string>>;
  imageVersion: string;
  auth?: Readonly<{verificationUrl: string; userCode: string}>;
  failure?: 'host_layout_failed' | 'image_unavailable' | 'authentication_expired' | 'gateway_failed' | 'readiness_failed';
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

export const parseProjectHermesRuntimeArtifact = (content: string): ParsedProjectHermesRuntimeArtifact | null => {
  try {
    const value = object(JSON.parse(content));
    const telegram = object(value?.telegram); const refs = object(value?.secretRefs);
    const runtimeId = typeof value?.runtimeId === 'string' &&
      /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(value.runtimeId) ? value.runtimeId : null;
    const gatewayEndpoint = runtimeId === null ? null : exactEndpoint(value?.gatewayEndpoint,
      `http://${runtimeId}-gateway:8642/v1/runs`);
    const dashboardEndpoint = runtimeId === null ? null : exactEndpoint(value?.dashboardEndpoint,
      `http://${runtimeId}-gateway:9119/`);
    const allowed = telegram?.allowedUserIds;
    const secretIds = {
      'agent-delivery': refs?.agentDelivery,
      'dashboard-username': refs?.dashboardUsername,
      'dashboard-password': refs?.dashboardPassword,
      'telegram-bot': refs?.telegramBot,
      'inbound-actions': refs?.inboundActions
    };
    const status = typeof value?.status === 'string' &&
      ['messenger_ready','installing','auth_required','ready','error'].includes(value.status)
      ? value.status as ParsedProjectHermesRuntimeArtifact['status'] : null;
    const auth = object(value?.auth);
    const parsedAuth = status === 'auth_required' && typeof auth?.verificationUrl === 'string' &&
      /^https:\/\/[^\s\0]{1,2040}$/.test(auth.verificationUrl) &&
      typeof auth.userCode === 'string' && /^[A-Z0-9-]{4,32}$/.test(auth.userCode)
      ? {verificationUrl: auth.verificationUrl, userCode: auth.userCode} : undefined;
    const failure = status === 'error' &&
      ['host_layout_failed','image_unavailable','authentication_expired','gateway_failed','readiness_failed'].includes(String(value?.failure))
      ? value?.failure as ParsedProjectHermesRuntimeArtifact['failure'] : undefined;
    if (value?.contract!==projectHermesRuntimeContract || status === null ||
      runtimeId === null || gatewayEndpoint === null || dashboardEndpoint === null || !workspacePath(value.workspacePath) ||
      (telegram !== null && (typeof telegram?.chatId !== 'string' || !/^-?[1-9][0-9]{0,19}$/.test(telegram.chatId))) ||
      (telegram !== null && (!Array.isArray(allowed) || allowed.length === 0 || allowed.length > 100 ||
      allowed.some((id) => typeof id !== 'string' || !/^[1-9][0-9]{0,19}$/.test(id)) ||
      new Set(allowed).size !== allowed.length)) || Object.values(secretIds).some((id) => !uuid(id)) ||
      (typeof value.imageVersion!=='string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.imageVersion)) ||
      (status === 'auth_required' && parsedAuth === undefined) || (status === 'error' && failure === undefined)) return null;
    return {status,runtimeId, gatewayEndpoint, dashboardEndpoint,
      workspacePath: value.workspacePath, telegramChatId: typeof telegram?.chatId === 'string' ? telegram.chatId : null,
      telegramAllowedUserIds: telegram?.allowedUserIds as string[] ?? [], secretIds: secretIds as Record<ProjectHermesSecretKind, string>,
      imageVersion:value.imageVersion as string,...(parsedAuth===undefined?{}:{auth:parsedAuth}),
      ...(failure===undefined?{}:{failure})};
  } catch { return null; }
};

const duplicateCoordinates = (bindings: readonly ProjectHermesRuntimeBinding[]): boolean => {
  const coordinates = bindings.flatMap((binding) => [
    `runtime:${binding.runtimeId}`,
    `gateway:${binding.gatewayEndpoint}`,
    `dashboard:${binding.dashboardEndpoint}`,
    `workspace:${binding.workspacePath}`,
    ...(binding.telegramChatId===null?[]:[`telegram:${binding.telegramChatId}`]),
    ...[binding.agentCredentialRef, binding.dashboardUsernameRef, binding.dashboardPasswordRef,
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
    return artifact === null || artifact.status !== 'ready' ? [] : [{row, artifact}];
  });
  const ids = [...new Set(parsed.flatMap(({artifact}) => Object.values(artifact.secretIds)))];
  if (ids.length === 0) return [];
  const secrets = await database.query<SecretRow>(`select id,purpose,locator from secret_refs
    where workspace_id=$1 and id=any($2::uuid[])`, [workspaceId, ids]);
  const byId = new Map(secrets.rows.map((secret) => [secret.id, secret]));
  const logicalPurpose: Record<ProjectHermesSecretKind, string> = {
    'agent-delivery': 'agent_delivery',
    'dashboard-username': 'hermes_dashboard_username',
    'dashboard-password': 'hermes_dashboard_password',
    'telegram-bot': 'messenger_delivery',
    'inbound-actions': 'hermes_inbound_actions'
  };
  const bindings = parsed.flatMap(({row, artifact}) => {
    const reference = (kind: ProjectHermesSecretKind): OpaqueSecretRef | null => {
      const secret = byId.get(artifact.secretIds[kind]);
      return secret !== undefined && secret.purpose === `project-hermes:${row.projectId}:${kind}` &&
        secret.locator.startsWith('/')
        ? {id: secret.id, purpose: logicalPurpose[kind], locator: secret.locator} : null;
    };
    const agentCredentialRef = reference('agent-delivery');
    const dashboardUsernameRef = reference('dashboard-username');
    const dashboardPasswordRef = reference('dashboard-password');
    const telegramCredentialRef = reference('telegram-bot');
    const inboundActionCredentialRef = reference('inbound-actions');
    if (agentCredentialRef === null || dashboardUsernameRef === null || dashboardPasswordRef === null ||
      telegramCredentialRef === null || inboundActionCredentialRef === null) return [];
    return [{workspaceId: row.workspaceId, projectId: row.projectId, slug: row.slug,
      artifactVersion: row.artifactVersion, ...artifact, agentCredentialRef, dashboardUsernameRef,
      dashboardPasswordRef, telegramCredentialRef, inboundActionCredentialRef}];
  });
  if (duplicateCoordinates(bindings)) throw new Error('project_hermes_runtime_conflict');
  return bindings;
};

const unavailableExecutorCatalog:AgentExecutorCatalog={
  'codex-cli':{available:false,models:[]},'claude-code-cli':{available:false,models:[]}
};
export const projectHermesExecutorCatalog=(runtime:ProjectHermesRuntimeBinding|null|undefined):AgentExecutorCatalog=>runtime===null||runtime===undefined
  ?unavailableExecutorCatalog:{'codex-cli':{available:true,models:['gpt-5.6-terra','gpt-5.6-sol']},
    'claude-code-cli':{available:false,models:[]}};

export type ProjectHermesRuntimeSetupView = Readonly<{
  status: ProjectHermesRuntimeStatus;
  telegramConfigured: boolean;
  auth: Readonly<{verificationUrl: string; userCode: string}> | null;
  failure: ParsedProjectHermesRuntimeArtifact['failure'] | null;
}>;

export const readProjectHermesRuntimeArtifact = async (
  database: Database,
  actorId: string,
  projectId: string
): Promise<ParsedProjectHermesRuntimeArtifact | null> => {
  const result=await database.query<{content:string}>(`select s.content_text as content
    from project_source_artifacts s join project_memberships m on m.project_id=s.project_id
    where s.project_id=$1 and m.actor_id=$2 and m.role='project_owner' and m.active=true and s.kind=$3
    order by s.created_at desc,s.id desc limit 1`,[projectId,actorId,projectHermesRuntimeArtifactKind]);
  return result.rows[0]===undefined?null:parseProjectHermesRuntimeArtifact(result.rows[0].content);
};

export const readProjectHermesRuntimeSetup = async (
  database: Database,
  actorId: string,
  projectId: string
): Promise<ProjectHermesRuntimeSetupView> => {
  const artifact=await readProjectHermesRuntimeArtifact(database,actorId,projectId);
  return artifact===null?{status:'not_configured',telegramConfigured:false,auth:null,failure:null}:
    {status:artifact.status,telegramConfigured:artifact.telegramChatId!==null,auth:artifact.auth??null,
      failure:artifact.failure??null};
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
