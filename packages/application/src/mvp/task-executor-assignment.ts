import {createHash} from 'node:crypto';
import type {AgentRole, ProjectRole, TrackerExecutorAssignmentPort, TrackerSnapshot} from '@fai-control-plane/domain';
import type {AgentSubmissionContext, AgentSubmissionPorts} from './agent-submission.ts';
import {submitExplicitAgent} from './agent-submission.ts';

export type TaskExecutor = Readonly<{kind: 'human'; candidate: Readonly<{id: string; login: string}>}> | Readonly<{kind: 'agent'}>;
type AgentTaskRole = Extract<AgentRole, 'manager' | 'developer' | 'qa' | 'devops'>;
export type TaskExecutorAssignmentCommand = Readonly<{actorId: string; projectId: string; projectItemId: string; executor: TaskExecutor;
  retry?: Readonly<{deliveryReference: string; nonce: string; confirmUnobservableFailure?: boolean}>;
  root?: Readonly<{chainReference: string; sourceReference: string; commandIdempotencyKey: string}>}>;
export type TaskExecutorAssignmentPorts = AgentSubmissionPorts & Readonly<{
  tracker: TrackerExecutorAssignmentPort;
  agentInstructions(role: AgentTaskRole): Readonly<{constraints: readonly string[]; acceptanceCriteria: readonly string[]}>;
}>;

export type TaskExecutorAssignmentResult = Readonly<{
  status: 'assigned' | 'started' | 'duplicate';
  deliveryReference?: string;
}>;

const bounded = (value: unknown, maximum = 256): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum && !value.includes('\0');
const configuredTarget = (context: AgentSubmissionContext, currentTitle: string, agentRequired: boolean) => {
  const byId = new Map(context.processPolicy.stages.map((stage) => [stage.id, stage]));
  let stage = context.processPolicy.stages.find((candidate) => candidate.title === currentTitle);
  const current = stage;
  const visited = new Set<string>();
  while (stage !== undefined && stage.automation === null && stage.nextStageId !== null && !visited.has(stage.id)) {
    visited.add(stage.id);
    stage = byId.get(stage.nextStageId);
  }
  if (stage === undefined) throw new Error('task_executor_unavailable');
  if (stage.automation === null) {
    if (agentRequired || current === undefined) throw new Error('task_executor_unavailable');
    return {title: current.title, role: null};
  }
  return {title: stage.title, role: stage.automation?.agentRole ?? null};
};

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
 * One provider-native executor assignment. Receipts keep agent delivery
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
  if (command.executor.kind === 'agent' &&
    (!bounded(context.agentTrackerOwnerOptionId, 512) || !bounded(context.doneStatusOptionId, 512))) {
    throw new Error('task_executor_unavailable');
  }
  const snapshot = await refresh(ports, context);
  const item = itemFor(snapshot, context, command.projectItemId);
  if (item.statusOptionName === null || item.blocked === null) throw new Error('task_executor_unavailable');
  const target = configuredTarget(context, item.statusOptionName, command.executor.kind === 'agent');
  const expectedBlocked = item.blocked;
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

  const alreadyAssignedAgent = executor.kind === 'agent' && target.title === item.statusOptionName &&
    item.ownerOptionId === context.agentTrackerOwnerOptionId && item.assigneeIds.length === 0 && expectedBlocked === false;
  if (!alreadyAssignedAgent) {
    try {
      await ports.tracker.startExecutor({itemId: item.itemId, issueId: item.issueId, expectedVersion: item.version,
        expectedStage: item.statusOptionName, targetStage: target.title, expectedBlocked,
        executor: executor.kind === 'human' ? {kind: 'human', candidate: executor.candidate}
          : {kind: 'agent', ownerOptionId: context.agentTrackerOwnerOptionId}});
    } catch (error) {
      await refresh(ports, context).catch(() => undefined);
      throw error;
    }
  }
  const verified = alreadyAssignedAgent ? item : itemFor(await refresh(ports, context), context, command.projectItemId);
  const expectedStage = target.title;
  const assignmentConfirmed = executor.kind === 'human'
    ? verified.ownerOptionId === null && verified.assignees.length === 1 && verified.assignees[0]?.login === executor.candidate.login
    : verified.ownerOptionId === context.agentTrackerOwnerOptionId && verified.assigneeIds.length === 0;
  if (verified.blocked !== false || verified.statusOptionName !== expectedStage || !assignmentConfirmed) {
    throw new Error('task_executor_conflict');
  }
  if (executor.kind === 'human') return {status: 'assigned'};
  const role = target.role;
  if (role === null) throw new Error('task_executor_conflict');
  const instructions = ports.agentInstructions(role);
  const delivery = await submitExplicitAgent({actorId: command.actorId, projectId: command.projectId,
    projectItemId: verified.itemId, role,
    constraints: instructions.constraints, acceptanceCriteria: instructions.acceptanceCriteria,
    ...(command.root === undefined ? {} : {root: command.root}),
    ...(command.retry === undefined ? {} : {retry: command.retry})}, ports);
  return {status: delivery.status === 'duplicate' ? 'duplicate' : 'started', deliveryReference: delivery.deliveryReference};
};

export type ProcessStartCommand = Readonly<{actorId: string; projectId: string;
  task: Readonly<{kind: 'existing'; itemId: string}>;
  sourceReference: string; idempotencyKey: string}>;
export type ProcessStartPorts = TaskExecutorAssignmentPorts;

/**
 * Starts only the exact existing provider item selected in the UI.
 */
export const startProcess = async (command: ProcessStartCommand,
  ports: ProcessStartPorts): Promise<TaskExecutorAssignmentResult & Readonly<{itemId: string; chainReference: string}>> => {
  if (!bounded(command.sourceReference, 512) || !bounded(command.idempotencyKey, 512)) {
    throw new Error('process_start_invalid');
  }
  const itemId = command.task.itemId;
  if (!bounded(itemId, 512)) throw new Error('process_start_invalid');
  const chainReference = `browser:${createHash('sha256').update(JSON.stringify({projectId: command.projectId,
    itemId, sourceReference: command.sourceReference, idempotencyKey: command.idempotencyKey})).digest('hex')}`;
  const result = await assignTaskExecutor({actorId: command.actorId, projectId: command.projectId,
    projectItemId: itemId, executor: {kind: 'agent'}, root: {chainReference,
      sourceReference: command.sourceReference, commandIdempotencyKey: command.idempotencyKey}}, ports);
  return {...result, itemId, chainReference};
};
