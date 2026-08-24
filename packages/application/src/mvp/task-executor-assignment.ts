import type {AgentRole, ProjectRole, TrackerExecutorAssignmentPort, TrackerSnapshot} from '@fai-control-plane/domain';
import type {AgentSubmissionContext, AgentSubmissionPorts} from './agent-submission.ts';
import {submitExplicitAgent} from './agent-submission.ts';

export type TaskExecutor = Readonly<{kind: 'human'; candidate: Readonly<{id: string; login: string}>}> | Readonly<{kind: 'hermes'}>;
type HermesTaskRole = Extract<AgentRole, 'developer' | 'qa'>;
export type TaskExecutorAssignmentCommand = Readonly<{actorId: string; projectId: string; projectItemId: string; executor: TaskExecutor;
  retry?: Readonly<{deliveryReference: string; nonce: string; confirmUnobservableFailure?: boolean}>}>;
export type TaskExecutorAssignmentPorts = AgentSubmissionPorts & Readonly<{
  tracker: TrackerExecutorAssignmentPort;
  agentInstructions(role: HermesTaskRole): Readonly<{constraints: readonly string[]; acceptanceCriteria: readonly string[]}>;
}>;

export type TaskExecutorAssignmentResult = Readonly<{
  status: 'assigned' | 'started' | 'duplicate';
  deliveryReference?: string;
}>;

const bounded = (value: unknown, maximum = 256): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum && !value.includes('\0');
const startStages = ['Backlog', 'Ready', 'In Dev', 'QA', 'Acceptance'] as const;
type StartStage = typeof startStages[number];
const roleFor = (stage: StartStage): HermesTaskRole | null => ['Backlog', 'Ready', 'In Dev'].includes(stage) ? 'developer' : stage === 'QA' ? 'qa' : null;
const allowed = (stage: string | null, blocked: boolean | null, executor: TaskExecutor): stage is StartStage =>
  blocked !== null && stage !== null && startStages.includes(stage as StartStage) &&
  (executor.kind === 'human' || roleFor(stage as StartStage) !== null);

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
  const expectedBlocked = item.blocked as boolean;
  if (command.retry?.confirmUnobservableFailure === true) {
    const observed = await ports.delivery.observe(command.retry.deliveryReference);
    if (observed.status !== 'unknown') throw new Error('agent_retry_denied');
  }

  const executor = command.executor;
  if (executor.kind === 'human') {
    const candidates = await ports.tracker.listAssignableUsers();
    if (!candidates.some((candidate) => candidate.id === executor.candidate.id && candidate.login === executor.candidate.login)) {
      throw new Error('task_executor_candidate_unavailable');
    }
  }

  try {
    await ports.tracker.startExecutor({itemId: item.itemId, issueId: item.issueId, expectedVersion: item.version,
      expectedStage: item.statusOptionName, expectedBlocked,
      executor: executor.kind === 'human' ? {kind: 'human', candidate: executor.candidate}
        : {kind: 'agent', ownerOptionId: context.agentTrackerOwnerOptionId}});
  } catch (error) {
    await refresh(ports, context).catch(() => undefined);
    throw error;
  }
  const verifiedSnapshot = await refresh(ports, context);
  const verified = itemFor(verifiedSnapshot, context, command.projectItemId);
  const expectedStage = item.statusOptionName === 'Backlog' || item.statusOptionName === 'Ready' ? 'In Dev' : item.statusOptionName;
  const assignmentConfirmed = executor.kind === 'human'
    ? verified.ownerOptionId === null && verified.assignees.length === 1 && verified.assignees[0]?.login === executor.candidate.login
    : verified.ownerOptionId === context.agentTrackerOwnerOptionId && verified.assigneeIds.length === 0;
  if (verified.blocked !== false || verified.statusOptionName !== expectedStage || !assignmentConfirmed) {
    throw new Error('task_executor_conflict');
  }
  if (executor.kind === 'human') return {status: 'assigned'};
  const role = roleFor(expectedStage);
  if (role === null) throw new Error('task_executor_conflict');
  const instructions = ports.agentInstructions(role);
  const delivery = await submitExplicitAgent({actorId: command.actorId, projectId: command.projectId,
    projectItemId: verified.itemId, role,
    constraints: instructions.constraints, acceptanceCriteria: instructions.acceptanceCriteria,
    ...(command.retry === undefined ? {} : {retry: command.retry})}, ports);
  return {status: delivery.status === 'duplicate' ? 'duplicate' : 'started', deliveryReference: delivery.deliveryReference};
};
