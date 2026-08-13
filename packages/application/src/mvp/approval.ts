import {
  approvalDecisions,
  approvalKinds,
  isBoundedId,
  isHttpsUrl,
  isInstant,
  isUuid,
  type ApprovalEvidence
} from '@fai-control-plane/domain';
import type {ApprovalTransactionStore, PublishedApprovalTargetPort} from './contracts.ts';

export type ApprovalAuthority = Readonly<{
  canDecide(actorId: string, projectId: string, kind: ApprovalEvidence['kind']): Promise<boolean>;
}>;

export const decideApproval = async (input: Readonly<{
  workspaceId: string;
  request: Readonly<{
    id: string; projectId: string; kind: ApprovalEvidence['kind']; decision: ApprovalEvidence['decision'];
    actorId: string; targetReference: string; decidedAt: string; idempotencyKey: string;
  }>;
  authority: ApprovalAuthority;
  targets: PublishedApprovalTargetPort;
  transaction: ApprovalTransactionStore;
}>): Promise<'recorded' | 'duplicate' | 'conflict' | 'denied' | 'invalid'> => {
  const request = input.request;
  if (!isUuid(request.id) || !isUuid(request.projectId) ||
    !approvalKinds.includes(request.kind) || !approvalDecisions.includes(request.decision) ||
    !isUuid(request.actorId) || !isBoundedId(request.targetReference) ||
    !isInstant(request.decidedAt) || !isBoundedId(request.idempotencyKey)) return 'invalid';
  if (!await input.authority.canDecide(request.actorId, request.projectId, request.kind)) return 'denied';
  const target = await input.targets.resolve({projectId: request.projectId, targetReference: request.targetReference});
  if (target === null || !isHttpsUrl(target.url) || !isBoundedId(target.version) || target.id !== request.targetReference) {
    return 'invalid';
  }
  return input.transaction.record({workspaceId: input.workspaceId, evidence: {...request, target}});
};
