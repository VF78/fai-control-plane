import {createHash} from 'node:crypto';
import type {AgentDeliveryPort, AgentExecutorCatalog, AgentRole, AgentRoleRequest, AgentRoutingPolicy, MessengerDeliveryInput, ProjectProcessPolicy, ProjectRole, RepositoryReadPort, SourceReference, TrackerItemFact, TrackerSnapshot} from '@fai-control-plane/domain';
import {assertAgentRoutingPolicyAvailable, parseProjectContextSnapshot, projectContextSnapshotKind,
  projectContextSnapshotMaxBytes, validateAgentRoleRequest} from '@fai-control-plane/domain';

export type AgentSubmissionContext = Readonly<{
  workspaceId: string; projectId: string; requesterRole: ProjectRole;
  bindingId: string; repository: Readonly<{id: string; url: string}>;
  agentTrackerOwnerOptionId: string;
  doneStatusOptionId: string;
  routingPolicyVersion: string;
  routingPolicy: AgentRoutingPolicy;
  executorCatalog: AgentExecutorCatalog;
  processPolicyVersion: string;
  processPolicy: ProjectProcessPolicy;
}>;

export type AgentSubmissionPorts = Readonly<{
  resolveContext(input: Readonly<{actorId: string; projectId: string}>): Promise<AgentSubmissionContext | null>;
  readFreshSnapshot(context: AgentSubmissionContext): Promise<TrackerSnapshot>;
  persistSnapshot(snapshot: TrackerSnapshot): Promise<void>;
  resolveActiveContext(input: Readonly<{actorId: string; projectId: string}>): Promise<SourceReference | null>;
  repository: RepositoryReadPort;
  delivery: AgentDeliveryPort;
  composeAcceptedNotification(item: TrackerItemFact, idempotencyKey: string): Promise<MessengerDeliveryInput>;
  transaction: Readonly<{execute(input: Readonly<{
    workspaceId: string; projectId: string; actorId: string; idempotencyKey: string; correlationId: string;
    role: AgentRole; itemId: string; issueId: string; observedVersion: string; sourceCount: number;
    processPolicyVersion: string; processStageId: string; processStageTitle: string;
    successTargetTitle: string | null; reworkTargetTitle: string | null;
    routingPolicy: AgentRoutingPolicy; executorCatalog: AgentExecutorCatalog; expectedOwnerOptionId: string;
    rootSourceReference?: string; rootCommandIdempotencyKey?: string;
    retryOf: string | null; confirmUnobservableFailure: boolean;
    notification: MessengerDeliveryInput;
  }>, submit: () => Promise<Readonly<{deliveryReference: string}>>): Promise<Readonly<{
    status: 'completed' | 'duplicate'; deliveryReference: string;
  }>>}>;
}>;

export type AgentSubmissionCommand = Readonly<{
  actorId: string; projectId: string; projectItemId: string; role: AgentRole;
  constraints: readonly string[]; acceptanceCriteria: readonly string[];
  retry?: Readonly<{deliveryReference: string; nonce: string; confirmUnobservableFailure?: boolean}>;
  root?: Readonly<{chainReference: string; sourceReference: string; commandIdempotencyKey: string}>;
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
    command.constraints.length === 0 || command.constraints.length > 40 ||
    command.acceptanceCriteria.length === 0 || command.acceptanceCriteria.length > 40 ||
    ![...command.constraints, ...command.acceptanceCriteria].every((item) => bounded(item, 2_000))) {
    throw new Error('agent_request_invalid');
  }
  if (command.retry !== undefined &&
    (!bounded(command.retry.deliveryReference, 256) || !bounded(command.retry.nonce, 128) ||
      (command.retry.confirmUnobservableFailure !== undefined && typeof command.retry.confirmUnobservableFailure !== 'boolean'))) {
    throw new Error('agent_request_invalid');
  }
  if (command.root !== undefined && (!/^browser:[a-f0-9]{64}$/.test(command.root.chainReference) ||
    !bounded(command.root.sourceReference, 512) || !bounded(command.root.commandIdempotencyKey, 512))) {
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
  try { assertAgentRoutingPolicyAvailable(context.routingPolicy, context.executorCatalog); }
  catch { throw new Error('agent_submit_denied'); }
  const repository = await ports.repository.readRepository({repositoryId: context.repository.id});
  if (repository.repositoryId !== context.repository.id || repository.url !== context.repository.url) {
    throw new Error('repository_binding_mismatch');
  }
  const activeContext = await ports.resolveActiveContext({actorId: command.actorId, projectId: context.projectId});
  if (activeContext === null || activeContext.kind !== projectContextSnapshotKind ||
    utf8Size(activeContext.content) > projectContextSnapshotMaxBytes ||
    createHash('sha256').update(activeContext.content).digest('hex') !== activeContext.sha256) {
    throw new Error('agent_context_unavailable');
  }
  let decodedContext: unknown;
  try { decodedContext = JSON.parse(activeContext.content); } catch { throw new Error('agent_context_unavailable'); }
  if (parseProjectContextSnapshot(decodedContext) === null) throw new Error('agent_context_unavailable');
  const sources = [activeContext];
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
  const processStage = context.processPolicy.stages.find((stage) => stage.title === item.statusOptionName);
  if (processStage?.automation === null || processStage === undefined ||
    processStage.automation.agentRole !== command.role || !/^[a-f0-9]{64}$/.test(context.processPolicyVersion)) {
    throw new Error('agent_submit_denied');
  }
  const processById = new Map(context.processPolicy.stages.map((stage) => [stage.id, stage]));
  const successTargetTitle = processStage.nextStageId === null ? null : processById.get(processStage.nextStageId)?.title ?? null;
  const reworkId = processStage.automation?.reworkStageId ?? null;
  const reworkTargetTitle = reworkId === null ? null : processById.get(reworkId)?.title ?? null;
  const normalized = {projectId: context.projectId, repositoryId: context.repository.id,
    itemId: item.itemId, observedVersion: item.version, role: command.role,
    processPolicyVersion: context.processPolicyVersion, processStageId: processStage.id,
    successTargetTitle, reworkTargetTitle,
    contextVersion: activeContext.sha256, constraints: command.constraints,
    acceptanceCriteria: command.acceptanceCriteria,
    ...(command.root === undefined ? {} : {chainReference: command.root.chainReference,
      sourceReference: command.root.sourceReference, rootCommand: command.root.commandIdempotencyKey}),
    ...(command.retry === undefined ? {} : {retryOf: command.retry.deliveryReference, retryNonce: command.retry.nonce})};
  const idempotencyKey = stableKey(normalized);
  const correlationId = command.root?.chainReference ?? `browser:${idempotencyKey.slice('agent.submit:'.length)}`;
  const request: AgentRoleRequest = {role: command.role, repository: {id: repository.repositoryId,
    url: repository.url, defaultBranch: repository.defaultBranch, defaultBranchSha: repository.defaultBranchSha},
    projectItem: {id: item.itemId, projectId: context.projectId, issueId: item.issueId,
      title: item.title, url: item.url},
    observedVersion: item.version, sources, constraints: command.constraints,
    acceptanceCriteria: command.acceptanceCriteria, approval: null,
    routing: {policyVersion: context.routingPolicyVersion, policy: context.routingPolicy,
      classification: 'runtime-classification-required'},
    process: {policyVersion: context.processPolicyVersion, stageId: processStage.id, stageTitle: processStage.title,
      successTargetTitle, reworkTargetTitle},
    correlationId, idempotencyKey};
  if (!validateAgentRoleRequest(request)) throw new Error('agent_request_invalid');
  const notificationKey = `${idempotencyKey}:accepted`;
  const notification = await ports.composeAcceptedNotification(item, notificationKey);
  if (notification.projectId !== context.projectId || notification.contour !== 'trusted-main' ||
    notification.idempotencyKey !== notificationKey || !bounded(notification.channelReference, 512) ||
    !bounded(notification.text, 4_000)) throw new Error('agent_notification_invalid');
  if (command.retry?.confirmUnobservableFailure === true) {
    const observed = await ports.delivery.observe(command.retry.deliveryReference);
    if (observed.status !== 'unknown') throw new Error('agent_retry_denied');
  }
  return ports.transaction.execute({workspaceId: context.workspaceId, projectId: context.projectId,
    actorId: command.actorId, idempotencyKey, correlationId, role: command.role, itemId: item.itemId,
    issueId: item.issueId,
    observedVersion: item.version, sourceCount: sources.length,
    processPolicyVersion: context.processPolicyVersion, processStageId: processStage.id,
    processStageTitle: processStage.title, successTargetTitle, reworkTargetTitle,
    routingPolicy: context.routingPolicy, executorCatalog: context.executorCatalog,
    expectedOwnerOptionId: context.agentTrackerOwnerOptionId,
    ...(command.root === undefined ? {} : {rootSourceReference: command.root.sourceReference,
      rootCommandIdempotencyKey: command.root.commandIdempotencyKey}),
    retryOf: command.retry?.deliveryReference ?? null,
    confirmUnobservableFailure: command.retry?.confirmUnobservableFailure === true, notification}, async () => {
      let delivered: Awaited<ReturnType<AgentDeliveryPort['submit']>>;
      try { delivered = await ports.delivery.submit(request); }
      catch { await new Promise<void>((resolve) => setTimeout(resolve, 250)); delivered = await ports.delivery.submit(request); }
      return {deliveryReference: delivered.deliveryReference};
    });
};
