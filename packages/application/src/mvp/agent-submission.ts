import {createHash} from 'node:crypto';
import type {AgentDeliveryPort, AgentRole, AgentRoleRequest, ProjectRole, RepositoryReadPort, SourceReference, TrackerSnapshot} from '@fai-control-plane/domain';
import {validateAgentRoleRequest} from '@fai-control-plane/domain';

export type AgentSubmissionContext = Readonly<{
  workspaceId: string; projectId: string; requesterRole: ProjectRole;
  bindingId: string; repository: Readonly<{id: string; url: string}>;
  agentTrackerOwnerOptionId: string;
  doneStatusOptionId: string;
}>;

export type AgentSubmissionPorts = Readonly<{
  resolveContext(input: Readonly<{actorId: string; projectId: string}>): Promise<AgentSubmissionContext | null>;
  readFreshSnapshot(context: AgentSubmissionContext): Promise<TrackerSnapshot>;
  persistSnapshot(snapshot: TrackerSnapshot): Promise<void>;
  resolveSources(input: Readonly<{actorId: string; projectId: string; sourceIds: readonly string[]}>): Promise<readonly SourceReference[]>;
  repository: RepositoryReadPort;
  delivery: AgentDeliveryPort;
  transaction: Readonly<{execute(input: Readonly<{
    workspaceId: string; projectId: string; actorId: string; idempotencyKey: string; correlationId: string;
    role: AgentRole; itemId: string; observedVersion: string; sourceCount: number;
  }>, submit: () => Promise<Readonly<{deliveryReference: string}>>): Promise<Readonly<{
    status: 'completed' | 'duplicate'; deliveryReference: string;
  }>>}>;
}>;

export type AgentSubmissionCommand = Readonly<{
  actorId: string; projectId: string; projectItemId: string; role: AgentRole;
  sourceIds: readonly string[]; constraints: readonly string[]; acceptanceCriteria: readonly string[];
}>;

const bounded = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum && !value.includes('\0');

const stableKey = (value: unknown): string =>
  `agent.submit:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
const utf8Size = (value: string): number => new TextEncoder().encode(value).byteLength;

export const submitExplicitAgent = async (command: AgentSubmissionCommand, ports: AgentSubmissionPorts): Promise<Readonly<{
  status: 'completed' | 'duplicate'; deliveryReference: string;
}>> => {
  if (!bounded(command.actorId, 256) || !bounded(command.projectId, 256) ||
    !bounded(command.projectItemId, 256) || !['manager', 'developer', 'qa', 'devops'].includes(command.role) ||
    command.sourceIds.length > 20 || new Set(command.sourceIds).size !== command.sourceIds.length ||
    !command.sourceIds.every((id) => bounded(id, 256)) || command.constraints.length === 0 ||
    command.constraints.length > 40 || command.acceptanceCriteria.length === 0 || command.acceptanceCriteria.length > 40 ||
    ![...command.constraints, ...command.acceptanceCriteria].every((item) => bounded(item, 2_000))) {
    throw new Error('agent_request_invalid');
  }
  // Production execution remains behind exact approval and is not exposed by this browser seam.
  if (command.role === 'devops') throw new Error('agent_submit_denied');
  const context = await ports.resolveContext({actorId: command.actorId, projectId: command.projectId});
  if (context === null || !['project_owner', 'operator'].includes(context.requesterRole)) {
    throw new Error('agent_submit_denied');
  }
  if (!bounded(context.agentTrackerOwnerOptionId, 512) || !bounded(context.doneStatusOptionId, 512)) {
    throw new Error('agent_submit_denied');
  }
  const repository = await ports.repository.readRepository({repositoryId: context.repository.id});
  if (repository.repositoryId !== context.repository.id || repository.url !== context.repository.url) {
    throw new Error('repository_binding_mismatch');
  }
  const sources = await ports.resolveSources({actorId: command.actorId, projectId: context.projectId,
    sourceIds: command.sourceIds});
  if (sources.length !== command.sourceIds.length) throw new Error('agent_source_denied');
  if (sources.reduce((total, source) => total + utf8Size(source.content), 0) > 65_536) {
    throw new Error('agent_source_payload_too_large');
  }
  // Read the provider-native task fact only after all other request material is ready,
  // immediately before the canonical delivery transaction. The configured exact
  // provider Owner option is composition-owned and cannot be supplied by the caller.
  const snapshot = await ports.readFreshSnapshot(context);
  if (snapshot.bindingId !== context.bindingId || snapshot.items.some((item) => item.projectId !== context.projectId)) {
    throw new Error('tracker_project_mismatch');
  }
  await ports.persistSnapshot(snapshot);
  const item = snapshot.items.find((candidate) => candidate.itemId === command.projectItemId);
  if (item === undefined) throw new Error('tracker_item_unavailable');
  if (item.statusOptionId === null || item.statusOptionId === context.doneStatusOptionId ||
    item.ownerOptionId !== context.agentTrackerOwnerOptionId) {
    throw new Error('agent_submit_denied');
  }
  const normalized = {projectId: context.projectId, repositoryId: context.repository.id,
    itemId: item.itemId, observedVersion: item.version, role: command.role,
    sourceIds: sources.map((source) => source.id).sort(), constraints: command.constraints,
    acceptanceCriteria: command.acceptanceCriteria};
  const idempotencyKey = stableKey(normalized);
  const correlationId = `browser:${idempotencyKey.slice('agent.submit:'.length)}`;
  const request: AgentRoleRequest = {role: command.role, repository: {id: repository.repositoryId, url: repository.url},
    projectItem: {id: item.itemId, projectId: context.projectId, issueId: item.issueId, url: item.url},
    observedVersion: item.version, sources, constraints: command.constraints,
    acceptanceCriteria: command.acceptanceCriteria, approval: null, correlationId, idempotencyKey};
  if (!validateAgentRoleRequest(request)) throw new Error('agent_request_invalid');
  return ports.transaction.execute({workspaceId: context.workspaceId, projectId: context.projectId,
    actorId: command.actorId, idempotencyKey, correlationId, role: command.role, itemId: item.itemId,
    observedVersion: item.version, sourceCount: sources.length}, async () => {
      const delivered = await ports.delivery.submit(request);
      return {deliveryReference: delivered.deliveryReference};
    });
};
