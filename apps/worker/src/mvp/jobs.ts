export const mvpWorkerJobs = Object.freeze(['github-reconcile', 'delivery-retry'] as const);
export type MvpWorkerJob = (typeof mvpWorkerJobs)[number];

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

export type WorkerReadiness = Readonly<{ready: boolean; checks: Readonly<{github: boolean; agent: boolean}>;
  lastReconcileAt: string | null; lastRetryAt: string | null; lastErrorAt: string | null;
  lastAgentDeliveryAt: string | null; lastAgentErrorAt: string | null}>;
export const workerReady = (input: Omit<WorkerReadiness, 'ready' | 'checks'>): WorkerReadiness => {
  const success = input.lastReconcileAt !== null && input.lastRetryAt !== null
    ? Math.min(Date.parse(input.lastReconcileAt), Date.parse(input.lastRetryAt)) : Number.NaN;
  const cycleHealthy = Number.isFinite(success) &&
    (input.lastErrorAt === null || Date.parse(input.lastErrorAt) < success);
  const github = cycleHealthy && input.lastReconcileAt !== null;
  const agent = input.lastAgentDeliveryAt !== null &&
    (input.lastAgentErrorAt === null || Date.parse(input.lastAgentErrorAt) < Date.parse(input.lastAgentDeliveryAt));
  return {...input, checks: {github, agent}, ready: github && agent};
};

export const exclusiveRunner = (task: () => Promise<void>): (() => Promise<void>) => {
  let running: Promise<void> | null = null;
  return async () => {
    running ??= task();
    try { await running; } finally { running = null; }
  };
};
