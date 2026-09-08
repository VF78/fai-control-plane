import {submitExplicitAgent, type AgentSubmissionPorts} from './agent-submission.ts';

export type AgentContinuationStore = Readonly<{
  /** Resolves only the latest accepted role in the explicitly-started chain and enforces the configured bound. */
  resolveActor(input: Readonly<{projectId: string; itemId: string; role: 'manager'|'developer'|'qa'|'devops';
    afterRoles: readonly ('manager'|'developer'|'qa'|'devops')[]; maxStarts: number}>):
      Promise<Readonly<{actorId: string; chainReference: string; limitReached: boolean}> | null>;
}>;

export const continueExplicitAgentChain = async (input: Readonly<{
  projectId: string;
  item: Readonly<{projectId: string; itemId: string}>;
  stage: Readonly<{agentRole: 'manager'|'developer'|'qa'|'devops'; afterRoles: readonly ('manager'|'developer'|'qa'|'devops')[]; maxStarts: number}> | null;
  stores: AgentContinuationStore;
  ports: AgentSubmissionPorts;
  notifyLimitReached?(chainReference: string, role: string, maxStarts: number): Promise<void>;
  instructions(role: 'manager'|'developer'|'qa'|'devops'): Readonly<{constraints: readonly string[]; acceptanceCriteria: readonly string[]}>;
}>): Promise<'not-authorized' | 'limit-reached' | 'started' | 'duplicate'> => {
  // The observed provider-native stage is the only trigger. No local status is inferred.
  if (input.item.projectId !== input.projectId || input.stage === null) return 'not-authorized';
  const role = input.stage.agentRole;
  // DevOps is never an automatic continuation: the same explicit assignment
  // seam starts it only after exact production approval has been recorded.
  if (role === 'devops') return 'not-authorized';
  const chain = await input.stores.resolveActor({projectId: input.projectId, itemId: input.item.itemId,
    role, afterRoles: input.stage.afterRoles, maxStarts: input.stage.maxStarts});
  if (chain === null) return 'not-authorized';
  if (chain.limitReached) {
    await input.notifyLimitReached?.(chain.chainReference, role, input.stage.maxStarts);
    return 'limit-reached';
  }
  const instructions = input.instructions(role);
  const result = await submitExplicitAgent({actorId: chain.actorId, chainReference: chain.chainReference,
    projectId: input.projectId, projectItemId: input.item.itemId,
    role, constraints: instructions.constraints, acceptanceCriteria: instructions.acceptanceCriteria}, input.ports);
  return result.status === 'duplicate' ? 'duplicate' : 'started';
};
