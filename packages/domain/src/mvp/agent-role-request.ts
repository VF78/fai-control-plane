import {createHash} from 'node:crypto';
import type {AgentRoleRequest} from './ports.ts';
import {approvalKinds, isBoundedId, isHttpsUrl} from './model.ts';
import {parseAgentRoutingPolicy} from './routing-policy.ts';

const boundedText = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum && !value.includes('\0');
const utf8Size = (value: string): number => new TextEncoder().encode(value).byteLength;

export const validateAgentRoleRequest = (value: AgentRoleRequest): boolean => {
  if (!['manager', 'developer', 'qa', 'devops'].includes(value.role) ||
    !isBoundedId(value.repository.id) || !isHttpsUrl(value.repository.url) ||
    !boundedText(value.repository.defaultBranch, 256) ||
    !/^[a-f0-9]{40}$/.test(value.repository.defaultBranchSha) ||
    !isBoundedId(value.projectItem.id) || !isBoundedId(value.projectItem.projectId) ||
    !isBoundedId(value.projectItem.issueId) || !boundedText(value.projectItem.title, 512) ||
    !isHttpsUrl(value.projectItem.url) ||
    !isBoundedId(value.observedVersion) || !isBoundedId(value.correlationId) ||
    !isBoundedId(value.idempotencyKey) || value.sources.length > 20 ||
    value.constraints.length > 40 || value.acceptanceCriteria.length > 40) return false;
  if (value.routing.classification !== 'runtime-classification-required' ||
    !/^[a-f0-9]{64}$/.test(value.routing.policyVersion) || parseAgentRoutingPolicy(value.routing.policy) === null ||
    createHash('sha256').update(JSON.stringify(value.routing.policy)).digest('hex') !== value.routing.policyVersion) return false;
  if (!/^[a-f0-9]{64}$/.test(value.process.policyVersion) || !isBoundedId(value.process.stageId) ||
    !boundedText(value.process.stageTitle, 200) ||
    (value.process.successTargetTitle !== null && !boundedText(value.process.successTargetTitle, 200)) ||
    (value.process.reworkTargetTitle !== null && !boundedText(value.process.reworkTargetTitle, 200))) return false;
  if (![...value.constraints, ...value.acceptanceCriteria].every((item) => boundedText(item, 2_000))) {
    return false;
  }
  if (!value.sources.every((source) => isBoundedId(source.id) &&
    /^[a-f0-9]{64}$/.test(source.sha256) && isBoundedId(source.kind) &&
    boundedText(source.provenance, 512) && boundedText(source.content, 65_536)) ||
    value.sources.reduce((total, source) => total + utf8Size(source.content), 0) > 65_536) return false;
  if (value.role === 'devops') {
    return value.approval !== null && value.approval.kind === 'production' &&
      approvalKinds.includes(value.approval.kind) && value.approval.decision === 'approved' &&
      value.approval.target.version === value.observedVersion;
  }
  return value.approval === null;
};

/** Compact hand-off to the persistent project Hermes. Repository, documents,
 * profile configuration, issue text and chat history remain in its persistent
 * project context and provider tools. */
export const renderAgentRoleRequest = (request: AgentRoleRequest): string => JSON.stringify({
  contract: 'fai.agent-role-request.v1',
  task: {role: request.role, stage: {id: request.process.stageId, title: request.process.stageTitle},
    issueUrl: request.projectItem.url},
  versions: {process: request.process.policyVersion, routing: request.routing.policyVersion},
  ...(request.approval === null ? {} : {approval: {kind: request.approval.kind,
    decision: request.approval.decision, targetReference: request.approval.target.id,
    targetVersion: request.approval.target.version}}),
  receipt: {correlationId: request.correlationId, idempotencyKey: request.idempotencyKey,
    contract: 'fai.agent-executor-result.v1'}
});
