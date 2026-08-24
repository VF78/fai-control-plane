import type {TrackerItemFact} from '@fai-control-plane/domain';
import {submitExplicitAgent, type AgentSubmissionPorts} from './agent-submission.ts';

export type AgentContinuationStore = Readonly<{
  /** Resolves only the latest accepted role in the explicitly-started chain and enforces the configured bound. */
  resolveActor(input: Readonly<{projectId: string; itemId: string; role: 'manager'|'developer'|'qa';
    afterRoles: readonly ('manager'|'developer'|'qa')[]; maxStarts: number}>): Promise<string | null>;
}>;

export const continueExplicitAgentChain = async (input: Readonly<{
  projectId: string;
  item: TrackerItemFact;
  stage: Readonly<{agentRole: 'manager'|'developer'|'qa'; afterRoles: readonly ('manager'|'developer'|'qa')[]; maxStarts: number}> | null;
  stores: AgentContinuationStore;
  ports: AgentSubmissionPorts;
  instructions(role: 'manager'|'developer'|'qa'): Readonly<{constraints: readonly string[]; acceptanceCriteria: readonly string[]}>;
}>): Promise<'not-authorized' | 'started' | 'duplicate'> => {
  // The observed provider-native stage is the only trigger. No local status is inferred.
  if (input.item.projectId !== input.projectId || input.stage === null) return 'not-authorized';
  const role = input.stage.agentRole;
  const actorId = await input.stores.resolveActor({projectId: input.projectId, itemId: input.item.itemId,
    role, afterRoles: input.stage.afterRoles, maxStarts: input.stage.maxStarts});
  if (actorId === null) return 'not-authorized';
  const instructions = input.instructions(role);
  const result = await submitExplicitAgent({actorId, projectId: input.projectId, projectItemId: input.item.itemId,
    role, constraints: instructions.constraints, acceptanceCriteria: instructions.acceptanceCriteria}, input.ports);
  return result.status === 'duplicate' ? 'duplicate' : 'started';
};
