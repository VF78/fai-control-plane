import {createHash} from 'node:crypto';
import {
  addSourceArtifact,
  canApprove,
  createApprovalPersistence,
  createStores,
  listProjectHermesRuntimeBindings,
  readActiveProjectContext,
  resolveAgentSubmissionBinding,
  resolveActiveHumanMember,
  saveProjectExecutionMode
} from '@fai-control-plane/db';
import {decideApproval, dispatchConversationAction} from '@fai-control-plane/application';
import {createGitHubTrackerReadAdapter} from '@fai-control-plane/integrations';
import {type ApprovalKind, type InternalConversationEnvelope} from '@fai-control-plane/domain';
import {createHermesConversationActionHandler, resolveInboundHermesRuntime} from './hermes-actions.ts';
import {getDatabase, secretResolver} from './runtime.ts';

const env = (name: string, maximum = 2_048): string => {
  const value = process.env[name];
  if (value === undefined || value.length === 0 || value.length > maximum || value.includes('\0')) {
    throw new Error(`${name}_required`);
  }
  return value;
};
export const hermesConversationAction = async (request: Request): Promise<Response> => {
  const database = getDatabase();
  const workspaceId = env('FCP_WORKSPACE_ID');
  const stores = createStores(database, workspaceId); const persistence = createApprovalPersistence(database);
  const shared = {
    sources: {async add(command: Readonly<{projectId: string; actorId: string; name: string; content: string;
      messageReference: string}>) {
      return {referenceId: await addSourceArtifact(database, {projectId: command.projectId, actorId: command.actorId,
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
            const context = await resolveAgentSubmissionBinding(database, command.actorId, command.projectId);
            if (context === null || context.provider !== 'github') throw new Error('tracker_project_mismatch');
            const projectUrl = new URL(context.projectUrl); const repositoryUrl = new URL(context.repositoryUrl);
            const project = /^\/users\/([^/]+)\/projects\/(\d+)\/?$/.exec(projectUrl.pathname);
            const repository = /^\/([^/]+)\/([^/]+)\/?$/.exec(repositoryUrl.pathname);
            if (projectUrl.origin !== 'https://github.com' || repositoryUrl.origin !== 'https://github.com' ||
              project === null || repository === null || project[1]!.toLowerCase() !== repository[1]!.toLowerCase()) {
              throw new Error('tracker_project_mismatch');
            }
            const trackerRead = createGitHubTrackerReadAdapter({binding: {id: context.bindingId,
              owner: project[1]!, repository: repository[2]!, projectId: command.projectId,
              projectNumber: Number(project[2]), projectUrl: context.projectUrl,
              credentialRef: context.trackerCredentialRef}, secrets: secretResolver});
            const snapshot = await trackerRead.readSnapshot(context.bindingId, null);
            if (snapshot.items.some((item) => item.projectId !== command.projectId)) throw new Error('tracker_project_mismatch');
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
    executionMode: {async configure(command: Readonly<{actorId: string; projectId: string;
      mode: 'manual'|'autonomous'; idempotencyKey: string; observedAt: string}>) {
      const result = await saveProjectExecutionMode(database, {workspaceId, projectId: command.projectId,
        actorId: command.actorId, mode: command.mode, idempotencyKey: command.idempotencyKey,
        occurredAt: command.observedAt});
      return {referenceId: result.mode};
    }}
  };
  return createHermesConversationActionHandler({
    resolveRuntime: async (bearer) => resolveInboundHermesRuntime(
      await listProjectHermesRuntimeBindings(database, workspaceId), secretResolver, bearer),
    readInternalContext: async ({message, ifVersion}) => {
      if (message.contour !== 'trusted-main') throw new Error('project_denied');
      const identity = await resolveActiveHumanMember(database, message.projectId, message.senderReference);
      if (identity === null || identity.role === 'client') throw new Error('identity_denied');
      const source = await readActiveProjectContext(database, identity.actorId, message.projectId);
      if (source === null) throw new Error('project_context_unavailable');
      const refreshedAt = 'createdAt' in source && typeof source.createdAt === 'string' ? source.createdAt : null;
      return ifVersion === source.sha256
        ? {status: 'duplicate' as const, version: source.sha256, sourceCount: 1, refreshedAt}
        : {status: 'completed' as const, version: source.sha256, capsule: source.content,
          sourceCount: 1, refreshedAt};
    },
    dispatchInternal: (envelope: InternalConversationEnvelope) => dispatchConversationAction({workspaceId,
      envelope, ports: shared})
  })(request);
};
