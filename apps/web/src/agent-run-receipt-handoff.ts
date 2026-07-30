import {randomUUID} from 'node:crypto';
import {and, eq, isNull} from 'drizzle-orm';
import {
  createCanonicalCommandService,
  parseRunnerCompletionPayload
} from '@fai-control-plane/application';
import {
  actors,
  agentRunReceipts,
  agentRuns,
  createDatabase,
  createPostgresUnitOfWork,
  projects,
  taskPackets,
  workItems
} from '@fai-control-plane/db';
import {
  createActorContextIssuer,
  type Capability,
  type WorkItemStatus
} from '@fai-control-plane/domain';
import {
  readBoundedForm,
  requireOperatorSession
} from './operator-auth-runtime';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const noStore = {'Cache-Control': 'no-store'} as const;
type Database = ReturnType<typeof createDatabase>['db'];

const enabledCapabilities = (value: Record<string, boolean>): Capability[] =>
  Object.entries(value).flatMap(([capability, enabled]) =>
    enabled ? [capability as Capability] : []
  );

export type ReceiptHandoffCandidate = Readonly<{
  runId: string;
  runStatus: string;
  runAttempt: number;
  runCompletedAt: Date | null;
  runFailureCode: string | null;
  confirmedPacketHash: string;
  packetContentHash: string;
  workItemId: string;
  workItemStatus: WorkItemStatus;
  workItemVersion: number;
  receiptRunnerId: string | null;
  receiptAttempt: number | null;
  receiptTerminal: string | null;
  receiptSha256: string | null;
  receiptSizeBytes: number | null;
  receiptMetadata: Record<string, unknown> | null;
  receiptCompletedAt: Date | null;
}>;

type ReceiptHandoffResult =
  'accepted' | 'stale' | 'forbidden' | 'not_found' | 'unavailable';

type ReceiptHandoffRuntime = Readonly<{
  load(input: Readonly<{
    workspaceId: string;
    runId: string;
  }>): Promise<ReceiptHandoffCandidate | null>;
  transition(input: Readonly<{
    workspaceId: string;
    actorId: string;
    runId: string;
    receiptSha256: string;
    workItemId: string;
    expectedVersion: number;
  }>): Promise<ReceiptHandoffResult>;
}>;

const createRuntime = (db: Database): ReceiptHandoffRuntime => ({
  async load(input) {
    const [candidate] = await db.select({
      runId: agentRuns.id,
      runStatus: agentRuns.status,
      runAttempt: agentRuns.attempt,
      runCompletedAt: agentRuns.completedAt,
      runFailureCode: agentRuns.failureCode,
      confirmedPacketHash: agentRuns.confirmedPacketHash,
      packetContentHash: taskPackets.contentHash,
      workItemId: workItems.id,
      workItemStatus: workItems.status,
      workItemVersion: workItems.version,
      receiptRunnerId: agentRunReceipts.runnerId,
      receiptAttempt: agentRunReceipts.attempt,
      receiptTerminal: agentRunReceipts.terminal,
      receiptSha256: agentRunReceipts.receiptSha256,
      receiptSizeBytes: agentRunReceipts.receiptSizeBytes,
      receiptMetadata: agentRunReceipts.metadata,
      receiptCompletedAt: agentRunReceipts.completedAt
    }).from(agentRuns)
      .innerJoin(taskPackets, eq(taskPackets.id, agentRuns.taskPacketId))
      .innerJoin(projects, eq(projects.id, taskPackets.projectId))
      .innerJoin(workItems, and(
        eq(workItems.id, taskPackets.workItemId),
        eq(workItems.projectId, taskPackets.projectId)
      ))
      .leftJoin(agentRunReceipts, eq(agentRunReceipts.agentRunId, agentRuns.id))
      .where(and(
        eq(agentRuns.id, input.runId),
        eq(projects.workspaceId, input.workspaceId),
        isNull(workItems.deletedAt)
      ))
      .limit(1);
    return candidate ?? null;
  },

  async transition(input) {
    const [operator] = await db.select({capabilities: actors.capabilities})
      .from(actors)
      .where(and(
        eq(actors.id, input.actorId),
        eq(actors.workspaceId, input.workspaceId),
        eq(actors.type, 'human'),
        eq(actors.authMode, 'user'),
        isNull(actors.disabledAt)
      ))
      .limit(1);
    if (operator === undefined) return 'forbidden';
    const issuer = createActorContextIssuer({
      users: [{
        actorId: input.actorId,
        capabilities: enabledCapabilities(operator.capabilities)
      }],
      agents: [],
      systems: []
    });
    if (!issuer.ok) return 'forbidden';
    const actor = issuer.value.issueUser(input.actorId);
    if (!actor.ok) return 'forbidden';

    const binding = `agent-run-receipt-handoff:${input.runId}:${input.receiptSha256}`;
    const result = await createCanonicalCommandService({
      unitOfWork: createPostgresUnitOfWork(db)
    }).execute({
      commandId: randomUUID(),
      workspaceId: input.workspaceId,
      correlationId: binding,
      idempotencyKey: binding,
      issuedAt: new Date().toISOString(),
      actor: actor.value,
      type: 'work_item.transition',
      payload: {
        workItemId: input.workItemId,
        status: 'qa',
        expectedVersion: input.expectedVersion
      }
    });
    if (result.status === 'key_reused') return 'stale';
    if (result.status !== 'completed' && result.status !== 'replayed') {
      return 'unavailable';
    }
    if (result.receipt.result.ok) return 'accepted';
    switch (result.receipt.result.error.code) {
      case 'INVALID_TRANSITION':
      case 'VERSION_CONFLICT':
      case 'WORK_ITEM_BLOCKED':
        return 'stale';
      case 'NOT_FOUND':
        return 'not_found';
      case 'CAPABILITY_DENIED':
      case 'POLICY_DENIED':
        return 'forbidden';
      default:
        return 'unavailable';
    }
  }
});

let runtimePromise: Promise<ReceiptHandoffRuntime> | undefined;

const getRuntime = async (): Promise<ReceiptHandoffRuntime> => {
  runtimePromise ??= (async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (databaseUrl === undefined || databaseUrl.length === 0) {
      throw new Error('DATABASE_URL is required for receipt handoff');
    }
    return createRuntime(createDatabase(databaseUrl).db);
  })().catch((error: unknown) => {
    runtimePromise = undefined;
    throw error;
  });
  return runtimePromise;
};

export type ReceiptHandoffCommandDependencies = Readonly<{
  requireSession: typeof requireOperatorSession;
  getRuntime: () => Promise<ReceiptHandoffRuntime>;
}>;

const dependencies: ReceiptHandoffCommandDependencies = {
  requireSession: requireOperatorSession,
  getRuntime
};

const parse = (form: URLSearchParams | null): Readonly<{
  csrfToken: string;
  expectedWorkItemVersion: number;
  expectedReceiptSha256: string;
}> | null => {
  if (form === null || [...form.keys()].some((key) =>
    !['_csrf', 'expectedWorkItemVersion', 'expectedReceiptSha256'].includes(key)
  )) return null;
  const csrfTokens = form.getAll('_csrf');
  const versions = form.getAll('expectedWorkItemVersion');
  const receiptHashes = form.getAll('expectedReceiptSha256');
  if (
    csrfTokens.length !== 1 ||
    csrfTokens[0]!.length === 0 ||
    csrfTokens[0]!.length > 128 ||
    versions.length !== 1 ||
    !/^[1-9][0-9]*$/.test(versions[0]!) ||
    receiptHashes.length !== 1 ||
    !SHA256_PATTERN.test(receiptHashes[0]!)
  ) return null;
  const expectedWorkItemVersion = Number(versions[0]);
  return Number.isSafeInteger(expectedWorkItemVersion)
    ? {
        csrfToken: csrfTokens[0]!,
        expectedWorkItemVersion,
        expectedReceiptSha256: receiptHashes[0]!
      }
    : null;
};

const validCandidate = (
  candidate: ReceiptHandoffCandidate,
  input: Readonly<{
    expectedWorkItemVersion: number;
    expectedReceiptSha256: string;
  }>
): boolean => {
  const receipt = parseRunnerCompletionPayload(candidate.receiptMetadata);
  const workItemVersionMatches =
    (candidate.workItemStatus === 'in_dev' &&
      candidate.workItemVersion === input.expectedWorkItemVersion) ||
    (candidate.workItemStatus === 'qa' &&
      candidate.workItemVersion === input.expectedWorkItemVersion + 1);
  return (
    candidate.runStatus === 'done' &&
    candidate.runFailureCode === null &&
    candidate.runCompletedAt !== null &&
    candidate.runAttempt > 0 &&
    candidate.confirmedPacketHash === candidate.packetContentHash &&
    candidate.receiptRunnerId !== null &&
    candidate.receiptRunnerId.length > 0 &&
    candidate.receiptAttempt === candidate.runAttempt &&
    candidate.receiptTerminal === 'done' &&
    candidate.receiptSha256 === input.expectedReceiptSha256 &&
    candidate.receiptSizeBytes !== null &&
    candidate.receiptCompletedAt !== null &&
    candidate.runCompletedAt.getTime() === candidate.receiptCompletedAt.getTime() &&
    receipt !== null &&
    receipt.runId === candidate.runId &&
    receipt.attempt === candidate.runAttempt &&
    receipt.terminal === 'done' &&
    receipt.finalStatus === 'succeeded' &&
    receipt.receiptSha256 === candidate.receiptSha256 &&
    receipt.receiptSizeBytes === candidate.receiptSizeBytes &&
    workItemVersionMatches
  );
};

const redirectResult = (
  request: Request,
  runId: string,
  result: ReceiptHandoffResult
): Response => {
  const requestedScope = new URL(request.url).searchParams.get('project');
  const location = new URL(
    requestedScope === 'msa' || requestedScope === 'ascon'
      ? `/projects/${requestedScope}/runs/${runId}`
      : '/dashboard',
    request.url
  );
  location.searchParams.set('handoff', result);
  return new Response(null, {
    status: 303,
    headers: {...noStore, location: location.toString()}
  });
};

export async function acceptAgentRunReceiptCommand(
  request: Request,
  runId: string,
  overrides: ReceiptHandoffCommandDependencies = dependencies
): Promise<Response> {
  const input = parse(await readBoundedForm(request));
  const authorization = await overrides.requireSession(request, {
    csrfToken: input?.csrfToken ?? null
  });
  if (!authorization.ok) return authorization.response;
  if (input === null || !UUID_PATTERN.test(runId)) {
    return Response.json({status: 'invalid_request'}, {status: 400, headers: noStore});
  }
  try {
    const runtime = await overrides.getRuntime();
    const candidate = await runtime.load({
      workspaceId: authorization.runtime.config.workspaceId,
      runId
    });
    if (candidate === null) return redirectResult(request, runId, 'not_found');
    if (!validCandidate(candidate, input)) {
      return redirectResult(request, runId, 'stale');
    }
    const result = await runtime.transition({
      workspaceId: authorization.runtime.config.workspaceId,
      actorId: authorization.session.actorId,
      runId,
      receiptSha256: input.expectedReceiptSha256,
      workItemId: candidate.workItemId,
      expectedVersion: input.expectedWorkItemVersion
    });
    return redirectResult(request, runId, result);
  } catch {
    return redirectResult(request, runId, 'unavailable');
  }
}
