import type {AgentRole, ProjectRole, TrackerExecutorAssignmentPort, TrackerSnapshot} from '@fai-control-plane/domain';
import type {AgentSubmissionContext, AgentSubmissionPorts} from './agent-submission.ts';
import {submitExplicitAgent} from './agent-submission.ts';

export type TaskExecutor = Readonly<{kind: 'human'; candidate: Readonly<{id: string; login: string}>}> | Readonly<{kind: 'hermes'}>;
type HermesTaskRole = Extract<AgentRole, 'developer' | 'qa'>;
export type TaskExecutorAssignmentCommand = Readonly<{actorId: string; projectId: string; projectItemId: string; executor: TaskExecutor}>;
export type TaskExecutorAssignmentPorts = AgentSubmissionPorts & Readonly<{
  tracker: TrackerExecutorAssignmentPort;
  agentInstructions(role: HermesTaskRole): Readonly<{constraints: readonly string[]; acceptanceCriteria: readonly string[]}>;
}>;

export type TaskExecutorAssignmentResult = Readonly<{
  status: 'assigned' | 'started' | 'duplicate' | 'status_sync_failed';
  deliveryReference?: string;
}>;

const bounded = (value: unknown, maximum = 256): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum && !value.includes('\0');
const roleFor = (stage: string | null): HermesTaskRole | null => stage === 'Ready' || stage === 'In Dev' ? 'developer' : stage === 'QA' ? 'qa' : null;
const allowed = (stage: string | null, blocked: boolean | null, executor: TaskExecutor): boolean =>
  blocked !== true && stage !== null && !['Backlog', 'Blocked', 'Done'].includes(stage) &&
  (executor.kind === 'human' || (stage !== 'Acceptance' && roleFor(stage) !== null));

const itemFor = (snapshot: TrackerSnapshot, context: AgentSubmissionContext, itemId: string) => {
  if (snapshot.bindingId !== context.bindingId || snapshot.items.some((item) => item.projectId !== context.projectId)) {
    throw new Error('tracker_project_mismatch');
  }
  const item = snapshot.items.find((candidate) => candidate.itemId === itemId);
  if (item === undefined) throw new Error('tracker_item_unavailable');
  return item;
};

const refresh = async (ports: TaskExecutorAssignmentPorts, context: AgentSubmissionContext): Promise<TrackerSnapshot> => {
  const snapshot = await ports.readFreshSnapshot(context);
  await ports.persistSnapshot(snapshot);
  return snapshot;
};

/**
 * One GitHub-native executor assignment. Receipts keep Hermes delivery
 * idempotent; no local task/run state is introduced.
 */
export const assignTaskExecutor = async (
  command: TaskExecutorAssignmentCommand,
  ports: TaskExecutorAssignmentPorts
): Promise<TaskExecutorAssignmentResult> => {
  const human = command.executor.kind === 'human' ? command.executor : null;
  if (!bounded(command.actorId) || !bounded(command.projectId) || !bounded(command.projectItemId) ||
    (human !== null && (!bounded(human.candidate.id, 512) || !bounded(human.candidate.login, 256)))) {
    throw new Error('task_executor_request_invalid');
  }
  const context = await ports.resolveContext({actorId: command.actorId, projectId: command.projectId});
  if (context === null || !['project_owner', 'operator'].includes(context.requesterRole as ProjectRole)) {
    throw new Error('task_executor_denied');
  }
  if (command.executor.kind === 'hermes' &&
    (!bounded(context.agentTrackerOwnerOptionId, 512) || !bounded(context.doneStatusOptionId, 512))) {
    throw new Error('task_executor_unavailable');
  }
  const snapshot = await refresh(ports, context);
  const item = itemFor(snapshot, context, command.projectItemId);
  if (!allowed(item.statusOptionName, item.blocked, command.executor)) throw new Error('task_executor_unavailable');

  const executor = command.executor;
  if (executor.kind === 'human') {
    const candidates = await ports.tracker.listAssignableUsers();
    if (!candidates.some((candidate) => candidate.id === executor.candidate.id && candidate.login === executor.candidate.login)) {
      throw new Error('task_executor_candidate_unavailable');
    }
    try {
      await ports.tracker.assignHumanExecutor({itemId: item.itemId, issueId: item.issueId, expectedVersion: item.version,
        candidate: executor.candidate});
    } catch (error) {
      await refresh(ports, context).catch(() => undefined);
      throw error;
    }
    const verifiedSnapshot = await refresh(ports, context);
    const verified = itemFor(verifiedSnapshot, context, command.projectItemId);
    const expectedStage = item.statusOptionName === 'Ready' ? 'In Dev' : item.statusOptionName;
    if (verified.ownerOptionId !== null || verified.statusOptionName !== expectedStage || verified.assignees.length !== 1 ||
      verified.assignees[0]?.login !== executor.candidate.login) throw new Error('task_executor_conflict');
    return {status: 'assigned'};
  }

  try {
    await ports.tracker.assignHermesExecutor({itemId: item.itemId, issueId: item.issueId, expectedVersion: item.version,
      hermesOwnerOptionId: context.agentTrackerOwnerOptionId});
  } catch (error) {
    await refresh(ports, context).catch(() => undefined);
    throw error;
  }
  const verifiedSnapshot = await refresh(ports, context);
  const verified = itemFor(verifiedSnapshot, context, command.projectItemId);
  const role = roleFor(verified.statusOptionName);
  if (verified.ownerOptionId !== context.agentTrackerOwnerOptionId || verified.assigneeIds.length !== 0 || role === null) {
    throw new Error('task_executor_conflict');
  }
  const instructions = ports.agentInstructions(role);
  const delivery = await submitExplicitAgent({actorId: command.actorId, projectId: command.projectId,
    projectItemId: verified.itemId, role,
    constraints: instructions.constraints, acceptanceCriteria: instructions.acceptanceCriteria}, ports);
  // In Dev and QA already express the active stage in GitHub. Starting Hermes
  // must preserve it; only Ready needs the post-receipt transition to In Dev.
  if (verified.statusOptionName !== 'Ready') {
    return {status: delivery.status === 'duplicate' ? 'duplicate' : 'started',
      deliveryReference: delivery.deliveryReference};
  }
  const startedSnapshot = await refresh(ports, context);
  const started = itemFor(startedSnapshot, context, command.projectItemId);
  try {
    await ports.tracker.startHermesExecutor({itemId: started.itemId, issueId: started.issueId,
      expectedVersion: started.version, hermesOwnerOptionId: context.agentTrackerOwnerOptionId});
  } catch {
    // A receipt makes this retry status-only: exact Hermes assignment is a no-op
    // and submitExplicitAgent returns its existing delivery reference.
    return {status: 'status_sync_failed', deliveryReference: delivery.deliveryReference};
  }
  await refresh(ports, context);
  return {status: delivery.status === 'duplicate' ? 'duplicate' : 'started', deliveryReference: delivery.deliveryReference};
};
