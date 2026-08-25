import {trackerPollIntervalMs} from '@fai-control-plane/domain';

export const mvpWorkerJobs = Object.freeze(['github-reconcile', 'agent-observe', 'delivery-retry'] as const);
export type MvpWorkerJob = (typeof mvpWorkerJobs)[number];

/** Human-paced MVP polling; GitHub webhooks are not the full repair source. */
export const workerTrackerPollIntervalMs = trackerPollIntervalMs;
/** Hermes work is human-paced; one local observation per minute is sufficient. */
export const workerAgentObserveIntervalMs = 60_000;
/** Local outbox retries never read GitHub, so they can remain responsive. */
export const workerRetryIntervalMs = 10_000;

export type WorkerJobHandlers = Readonly<Record<MvpWorkerJob, () => Promise<void>>>;

export const workerActive = (value: string | undefined): boolean => {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('FCP_WORKER_ACTIVE_required');
};

/** Static composition: two jobs, no queue/provider registry or dynamic routing. */
export const runWorkerJob = async (
  job: MvpWorkerJob,
  handlers: WorkerJobHandlers
): Promise<void> => handlers[job]();

export type WorkerReadiness = Readonly<{ready: boolean;
  checks: Readonly<{github: boolean; agents: boolean; notifications: boolean}>;
  lastReconcileAt: string | null; lastObserveAt: string | null; lastRetryAt: string | null; lastErrorAt: string | null}>;
export const workerReady = (input: Omit<WorkerReadiness, 'ready' | 'checks'>): WorkerReadiness => {
  const success = input.lastReconcileAt !== null && input.lastObserveAt !== null && input.lastRetryAt !== null
    ? Math.min(Date.parse(input.lastReconcileAt), Date.parse(input.lastObserveAt), Date.parse(input.lastRetryAt)) : Number.NaN;
  const cycleHealthy = Number.isFinite(success) &&
    (input.lastErrorAt === null || Date.parse(input.lastErrorAt) < success);
  const github = cycleHealthy && input.lastReconcileAt !== null;
  const agents = cycleHealthy && input.lastObserveAt !== null;
  const notifications = cycleHealthy && input.lastRetryAt !== null;
  return {...input, checks: {github, agents, notifications}, ready: github && agents && notifications};
};

export const exclusiveRunner = (task: () => Promise<void>): (() => Promise<void>) => {
  let running: Promise<void> | null = null;
  return async () => {
    running ??= task();
    try { await running; } finally { running = null; }
  };
};
