import {randomUUID} from 'node:crypto';
import {and, eq, isNull} from 'drizzle-orm';
import {
  AGENT_RUN_ACCEPTANCE_COMMAND,
  createAgentRunAcceptanceService,
  mapRunnerCompletionToDeliveryEvidence,
  parseRunnerCompletionPayload
} from '@fai-control-plane/application';
import {
  actors,
  createDatabase,
  createPostgresAgentRunAcceptanceStore
} from '@fai-control-plane/db';
import {
  createActorContextIssuer,
  type Capability
} from '@fai-control-plane/domain';
import {
  readBoundedForm,
  requireOperatorSession
} from './operator-auth-runtime';
import {isOperatorProjectSlug} from './operator-data';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const noStore = {'Cache-Control': 'no-store'} as const;
type Database = ReturnType<typeof createDatabase>['db'];

const enabledCapabilities = (value: Record<string, boolean>): Capability[] =>
  Object.entries(value).flatMap(([capability, enabled]) =>
    enabled ? [capability as Capability] : []
  );

type ReceiptHandoffResult =
  'accepted' | 'stale' | 'forbidden' | 'not_found' | 'unavailable';

const handoffError = (code: string): ReceiptHandoffResult => {
  switch (code) {
    case 'INVALID_COMMAND':
    case 'INVALID_TRANSITION':
    case 'VERSION_CONFLICT':
    case 'WORK_ITEM_BLOCKED':
    case 'IDEMPOTENCY_KEY_REUSED':
      return 'stale';
    case 'NOT_FOUND':
      return 'not_found';
    case 'CAPABILITY_DENIED':
    case 'POLICY_DENIED':
    case 'INVALID_ACTOR_CONTEXT':
      return 'forbidden';
    default:
      return 'unavailable';
  }
};

type ReceiptHandoffRuntime = Readonly<{
  execute(input: Readonly<{
    workspaceId: string;
    actorId: string;
    runId: string;
    receiptSha256: string;
    expectedWorkItemVersion: number;
  }>): Promise<ReceiptHandoffResult>;
}>;

const createRuntime = (db: Database): ReceiptHandoffRuntime => ({
  async execute(input) {
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

    const binding = `agent-run-accept:v1:${input.runId}:${input.receiptSha256}:${input.actorId}`;
    const result = await createAgentRunAcceptanceService(
      createPostgresAgentRunAcceptanceStore(db, {
        parseCompletion: parseRunnerCompletionPayload,
        evidenceFor: mapRunnerCompletionToDeliveryEvidence
      })
    ).execute({
      commandId: randomUUID(),
      workspaceId: input.workspaceId,
      correlationId: randomUUID(),
      idempotencyKey: binding,
      issuedAt: new Date().toISOString(),
      actor: actor.value,
      type: AGENT_RUN_ACCEPTANCE_COMMAND,
      payload: {
        runId: input.runId,
        receiptSha256: input.receiptSha256,
        expectedWorkItemVersion: input.expectedWorkItemVersion
      }
    });
    if (!('receipt' in result)) {
      return handoffError(result.error.code);
    }
    if (result.receipt.result.ok) return 'accepted';
    return handoffError(result.receipt.result.error.code);
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

const redirectResult = (
  request: Request,
  runId: string,
  result: ReceiptHandoffResult
): Response => {
  const requestedScope = new URL(request.url).searchParams.get('project');
  const location = new URL(
    requestedScope !== null && isOperatorProjectSlug(requestedScope)
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
    const result = await runtime.execute({
      workspaceId: authorization.runtime.config.workspaceId,
      actorId: authorization.session.actorId,
      runId,
      receiptSha256: input.expectedReceiptSha256,
      expectedWorkItemVersion: input.expectedWorkItemVersion
    });
    return redirectResult(request, runId, result);
  } catch {
    return redirectResult(request, runId, 'unavailable');
  }
}
