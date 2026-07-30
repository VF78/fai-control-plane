import {randomUUID} from 'node:crypto';
import {and, eq, isNull} from 'drizzle-orm';
import {createCanonicalCommandService} from '@fai-control-plane/application';
import {
  actors,
  createDatabase,
  createPostgresUnitOfWork
} from '@fai-control-plane/db';
import {
  createActorContextIssuer,
  OPERATOR_CANCELLED_BEFORE_CLAIM,
  type Capability
} from '@fai-control-plane/domain';
import {
  readBoundedForm,
  requireOperatorSession
} from './operator-auth-runtime';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const noStore = {'Cache-Control': 'no-store'} as const;
type Database = ReturnType<typeof createDatabase>['db'];

const enabledCapabilities = (value: Record<string, boolean>): Capability[] =>
  Object.entries(value).flatMap(([capability, enabled]) =>
    enabled ? [capability as Capability] : []
  );

type CancellationRuntime = Readonly<{
  cancel(input: Readonly<{
    workspaceId: string;
    actorId: string;
    runId: string;
    expectedVersion: number;
  }>): Promise<'cancelled' | 'conflict' | 'forbidden' | 'not_found' | 'unavailable'>;
}>;

const createRuntime = (db: Database): CancellationRuntime => ({
  async cancel(input) {
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

    const result = await createCanonicalCommandService({
      unitOfWork: createPostgresUnitOfWork(db)
    }).execute({
      commandId: randomUUID(),
      workspaceId: input.workspaceId,
      correlationId: randomUUID(),
      idempotencyKey: `agent-run-cancel-before-claim:${input.runId}`,
      issuedAt: new Date().toISOString(),
      actor: actor.value,
      type: 'agent_run.transition',
      payload: {
        agentRunId: input.runId,
        status: 'failed',
        expectedVersion: input.expectedVersion,
        failureCode: OPERATOR_CANCELLED_BEFORE_CLAIM
      }
    });
    if (result.status === 'key_reused') return 'conflict';
    if (result.status !== 'completed' && result.status !== 'replayed') {
      return 'unavailable';
    }
    if (result.receipt.result.ok) return 'cancelled';
    switch (result.receipt.result.error.code) {
      case 'INVALID_TRANSITION':
      case 'VERSION_CONFLICT':
        return 'conflict';
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

let runtimePromise: Promise<CancellationRuntime> | undefined;

const getRuntime = async (): Promise<CancellationRuntime> => {
  runtimePromise ??= (async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (databaseUrl === undefined || databaseUrl.length === 0) {
      throw new Error('DATABASE_URL is required for agent run cancellation');
    }
    return createRuntime(createDatabase(databaseUrl).db);
  })().catch((error: unknown) => {
    runtimePromise = undefined;
    throw error;
  });
  return runtimePromise;
};

const parse = (form: URLSearchParams | null): Readonly<{
  csrfToken: string;
  expectedVersion: number;
}> | null => {
  if (form === null) return null;
  const entries = [...form.entries()];
  if (
    entries.length !== 2 ||
    entries[0]?.[0] !== '_csrf' ||
    entries[0][1].length === 0 ||
    entries[0][1].length > 128 ||
    entries[1]?.[0] !== 'expectedVersion' ||
    !/^[1-9][0-9]*$/.test(entries[1][1])
  ) return null;
  const expectedVersion = Number(entries[1][1]);
  return Number.isSafeInteger(expectedVersion)
    ? {csrfToken: entries[0][1], expectedVersion}
    : null;
};

export async function cancelAgentRunCommand(
  request: Request,
  runId: string
): Promise<Response> {
  const input = parse(await readBoundedForm(request));
  const authorization = await requireOperatorSession(request, {
    csrfToken: input?.csrfToken ?? null
  });
  if (!authorization.ok) return authorization.response;
  if (input === null || !UUID_PATTERN.test(runId)) {
    return Response.json({status: 'invalid_request'}, {status: 400, headers: noStore});
  }
  try {
    const result = await (await getRuntime()).cancel({
      workspaceId: authorization.runtime.config.workspaceId,
      actorId: authorization.session.actorId,
      runId,
      expectedVersion: input.expectedVersion
    });
    if (result === 'cancelled') {
      const requestedScope = new URL(request.url).searchParams.get('project');
      const location = requestedScope === 'msa' || requestedScope === 'ascon'
        ? `/projects/${requestedScope}/runs/${runId}`
        : '/dashboard';
      return new Response(null, {
        status: 303,
        headers: {...noStore, location: new URL(location, request.url).toString()}
      });
    }
    const status = result === 'forbidden' ? 403
      : result === 'not_found' ? 404
      : result === 'conflict' ? 409
      : 503;
    return Response.json({status: result}, {status, headers: noStore});
  } catch {
    return Response.json({status: 'unavailable'}, {status: 503, headers: noStore});
  }
}
