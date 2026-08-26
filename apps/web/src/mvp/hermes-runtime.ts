import {createHash} from 'node:crypto';
import {
  addSourceArtifact,
  canApprove,
  createApprovalPersistence,
  createStores,
  readActiveProjectContext,
  resolveActiveHumanMember,
  resolveReceiptBoundRoleRun,
  saveProjectExecutionMode
} from '@fai-control-plane/db';
import {decideApproval, dispatchClientConversationAction, dispatchConversationAction} from '@fai-control-plane/application';
import {
  createGitHubTrackerMutationAdapter,
  createGitHubTrackerReadAdapter
} from '@fai-control-plane/integrations';
import {parseProjectContextSnapshot, type ApprovalKind, type ClientConversationEnvelope,
  type InternalConversationEnvelope, type OpaqueSecretRef} from '@fai-control-plane/domain';
import {createHermesConversationActionHandler} from './hermes-actions.ts';
import {bitrixClientActionsEnabled} from './integration-config.ts';
import {getDatabase, readSecretFile, secretResolver} from './runtime.ts';
import {startGitHubProcess} from './api.ts';

const env = (name: string, maximum = 2_048): string => {
  const value = process.env[name];
  if (value === undefined || value.length === 0 || value.length > maximum || value.includes('\0')) {
    throw new Error(`${name}_required`);
  }
  return value;
};
const secret = (id: string, purpose: string, variable: string): OpaqueSecretRef =>
  ({id, purpose, locator: env(variable)});

export const hermesConversationAction = async (request: Request): Promise<Response> => {
  const database = getDatabase();
  const clientActionsEnabled = bitrixClientActionsEnabled();
  const workspaceId = env('FCP_WORKSPACE_ID'); const projectId = env('FCP_PROJECT_ID');
  const bindingId = env('GITHUB_BINDING_ID'); const owner = env('GITHUB_OWNER', 100);
  const repository = env('GITHUB_REPOSITORY', 100); const projectNumber = Number(env('GITHUB_PROJECT_NUMBER', 16));
  const binding = {id: bindingId, owner, repository, projectId, projectNumber,
    projectUrl: `https://github.com/users/${owner}/projects/${projectNumber}`,
    credentialRef: secret('github-projects', 'tracker_read', 'GITHUB_PROJECTS_TOKEN_FILE')};
  const trackerRead = createGitHubTrackerReadAdapter({binding, secrets: secretResolver});
  const tracker = createGitHubTrackerMutationAdapter({binding,
    credentialRef: secret('github-projects-mutate', 'tracker_mutate', 'GITHUB_PROJECTS_TOKEN_FILE'),
    secrets: secretResolver});
  const stores = createStores(database, workspaceId); const persistence = createApprovalPersistence(database);
  const shared = {
    facts: {async read(targetProjectId: string) {
      if (targetProjectId !== projectId) throw new Error('project_denied');
      const result = await database.query<{id: string}>(
        `select s.id from tracker_snapshots s join tracker_bindings b on b.id=s.binding_id
         where b.project_id=$1 and s.error_code is null order by s.observed_at desc limit 1`, [projectId]);
      if (result.rows[0] === undefined) throw new Error('tracker_snapshot_unavailable');
      return {referenceId: result.rows[0].id};
    }}, tracker,
    sources: {async add(command: Readonly<{projectId: string; actorId: string; name: string; content: string;
      messageReference: string}>) {
      if (command.projectId !== projectId) throw new Error('project_denied');
      return {referenceId: await addSourceArtifact(database, {projectId, actorId: command.actorId,
        kind: 'messenger_context', name: command.name, mediaType: 'text/plain', contentText: command.content,
        sourceUrl: null, sha256: createHash('sha256').update(command.content).digest('hex'),
        provenance: `messenger:${command.messageReference}`})};
    }},
    approvals: {async decide(command: Readonly<{projectId: string; actorId: string; approvalId: string;
      kind: ApprovalKind; targetReference: string; decision: 'approved'|'rejected'; idempotencyKey: string}>) {
      const result = await decideApproval({workspaceId, request: {id: command.approvalId, projectId: command.projectId,
        kind: command.kind, decision: command.decision, actorId: command.actorId,
        targetReference: command.targetReference, decidedAt: new Date().toISOString(),
        idempotencyKey: command.idempotencyKey}, authority: {canDecide: (actorId, targetProjectId, kind) =>
          canApprove(database, actorId, targetProjectId, kind)}, targets: {async resolve(target) {
            const snapshot = await trackerRead.readSnapshot(bindingId, null);
            if (snapshot.items.some((item) => item.projectId !== projectId)) throw new Error('tracker_project_mismatch');
            await stores.snapshots.replace(snapshot);
            const fact = snapshot.items.find((item) => item.itemId === target.targetReference ||
              item.issueId === target.targetReference);
            return fact === undefined ? null : {id: target.targetReference, url: fact.url, version: fact.version};
          }}, transaction: persistence.transaction});
      if (result !== 'recorded' && result !== 'duplicate') throw new Error(`approval_${result}`);
      return {referenceId: command.approvalId};
    }},
    identities: {resolveActiveHuman: ({projectId: targetProjectId, senderReference}: Readonly<{
      projectId: string; senderReference: string}>) => resolveActiveHumanMember(database, targetProjectId, senderReference)},
    receipts: stores.receipts, completion: stores.completion,
    processStart: {async execute(command: Readonly<{actorId: string; projectId: string;
      task: Readonly<{kind: 'existing'; itemId: string}> | Readonly<{kind: 'create'; title: string; statement: string}>;
      sourceReference: string; idempotencyKey: string}>) {
      const result = await startGitHubProcess(database, command);
      return {referenceId: result.chainReference};
    }},
    executionMode: {async configure(command: Readonly<{actorId: string; projectId: string;
      mode: 'manual'|'autonomous'; idempotencyKey: string; observedAt: string}>) {
      const result = await saveProjectExecutionMode(database, {workspaceId, projectId: command.projectId,
        actorId: command.actorId, mode: command.mode, idempotencyKey: command.idempotencyKey,
        occurredAt: command.observedAt});
      return {referenceId: result.mode};
    }}
  };
  return createHermesConversationActionHandler({
    internalToken: () => readSecretFile(env('HERMES_INTERNAL_ACTION_TOKEN_FILE')),
    clientToken: () => readSecretFile(env('HERMES_CLIENT_ACTION_TOKEN_FILE')),
    projectId, telegramChatId: env('TELEGRAM_INTERNAL_CHAT_ID'),
    telegramUserIds: env('TELEGRAM_INTERNAL_ALLOWED_USER_IDS').split(','),
    bitrixTaskId: clientActionsEnabled ? env('BITRIX24_TASK_ID') : '', clientActionsEnabled,
    resolveRoleRun: (sessionId) => resolveReceiptBoundRoleRun(database, sessionId, projectId),
    readInternalContext: async ({message, ifVersion}) => {
      if (message.projectId !== projectId || message.contour !== 'trusted-main') throw new Error('project_denied');
      const identity = await resolveActiveHumanMember(database, projectId, message.senderReference);
      if (identity === null || identity.role === 'client') throw new Error('identity_denied');
      const source = await readActiveProjectContext(database, identity.actorId, projectId);
      if (source === null) throw new Error('project_context_unavailable');
      let decoded: unknown;
      try { decoded = JSON.parse(source.content); } catch { throw new Error('project_context_unavailable'); }
      const snapshot = parseProjectContextSnapshot(decoded);
      if (snapshot === null) throw new Error('project_context_unavailable');
      const refreshedAt = 'createdAt' in source && typeof source.createdAt === 'string' ? source.createdAt : null;
      return ifVersion === source.sha256
        ? {status: 'duplicate' as const, version: source.sha256, sourceCount: snapshot.sources.length, refreshedAt}
        : {status: 'completed' as const, version: source.sha256, capsule: snapshot.content,
          sourceCount: snapshot.sources.length, refreshedAt};
    },
    dispatchInternal: (envelope: InternalConversationEnvelope, roleRun) => dispatchConversationAction({workspaceId,
      envelope, ports: shared, ...(roleRun === undefined ? {} : {roleRun})}),
    dispatchClient: (envelope: ClientConversationEnvelope) => dispatchClientConversationAction({workspaceId,
      envelope, ports: shared})
  })(request);
};
