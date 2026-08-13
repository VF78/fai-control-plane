export const mvpWorkerJobs = Object.freeze(['github-reconcile', 'delivery-retry'] as const);
export type MvpWorkerJob = (typeof mvpWorkerJobs)[number];

export type WorkerJobHandlers = Readonly<Record<MvpWorkerJob, () => Promise<void>>>;

/** Static composition: two jobs, no queue/provider registry or dynamic routing. */
export const runWorkerJob = async (
  job: MvpWorkerJob,
  handlers: WorkerJobHandlers
): Promise<void> => handlers[job]();

export type WorkerReadiness = Readonly<{ready: boolean; lastReconcileAt: string | null;
  lastRetryAt: string | null; lastErrorAt: string | null}>;
export const workerReady = (input: Omit<WorkerReadiness, 'ready'>): WorkerReadiness => {
  const success = input.lastReconcileAt !== null && input.lastRetryAt !== null
    ? Math.min(Date.parse(input.lastReconcileAt), Date.parse(input.lastRetryAt)) : Number.NaN;
  return {...input, ready: Number.isFinite(success) &&
    (input.lastErrorAt === null || Date.parse(input.lastErrorAt) < success)};
};

export const exclusiveRunner = (task: () => Promise<void>): (() => Promise<void>) => {
  let running: Promise<void> | null = null;
  return async () => {
    running ??= task();
    try { await running; } finally { running = null; }
  };
};
