import type {CommandResult} from './index.ts';

export const projectExecutionStatuses = [
  'stopped',
  'running',
  'paused',
  'blocked',
  'completed'
] as const;
export type ProjectExecutionStatus = (typeof projectExecutionStatuses)[number];

export type ProjectDecisionQueueItem = Readonly<{
  id: string;
  kind: 'approval' | 'failure' | 'provider_handoff';
  source: 'delivery_protocol' | 'approval' | 'agent_run' | 'publication';
  workItemId: string | null;
  targetId: string;
  summary: string;
  nextAction: string;
  createdAt: string | null;
}>;

export type ProjectExecutionSelection = Readonly<{
  planVersionId: string;
  workItemId: string;
  title: string;
  workItemVersion: number;
  protocolId: string;
  protocolVersion: number;
  journeyVersion: number;
  stageKey: string;
  stageName: string;
  executionMode: 'manual' | 'autonomous' | 'human_approval';
  responsibleActor: Readonly<{
    id: string;
    displayName: string;
    type: 'human' | 'agent';
    agentProfileId: string | null;
  }>;
  boundary: 'autonomous_ready' | 'autonomous_agent_required' | 'human_confirmation_required' | 'provider_handoff_required';
}>;

export type ProjectExecutionProjection = Readonly<{
  projectId: string;
  status: ProjectExecutionStatus;
  version: number;
  selection: ProjectExecutionSelection | null;
  blockReason: string | null;
  decisions: readonly ProjectDecisionQueueItem[];
  startedAt: string | null;
  pausedAt: string | null;
  completedAt: string | null;
  updatedAt: string | null;
}>;

const transitions: Readonly<Record<ProjectExecutionStatus, readonly ProjectExecutionStatus[]>> = {
  stopped: ['running', 'blocked', 'completed'],
  running: ['paused'],
  paused: ['running', 'blocked', 'completed'],
  blocked: ['paused'],
  completed: []
};

export const transitionProjectExecution = (
  from: ProjectExecutionStatus,
  to: ProjectExecutionStatus
): CommandResult<ProjectExecutionStatus> => transitions[from].includes(to)
  ? {ok: true, value: to}
  : {ok: false, error: {
      code: 'INVALID_TRANSITION',
      message: `Project execution cannot transition from ${from} to ${to}.`
    }};
