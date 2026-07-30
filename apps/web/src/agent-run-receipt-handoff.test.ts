import {expect, it, vi} from 'vitest';
import {
  acceptAgentRunReceiptCommand,
  type ReceiptHandoffCandidate,
  type ReceiptHandoffCommandDependencies
} from './agent-run-receipt-handoff';

const runId = '00000000-0000-4000-8000-000000000001';
const workItemId = '00000000-0000-4000-8000-000000000002';
const actorId = '00000000-0000-4000-8000-000000000003';
const workspaceId = '00000000-0000-4000-8000-000000000004';
const csrfToken = 'csrf-token';
const receiptSha256 = 'a'.repeat(64);
const completedAt = new Date('2026-07-28T10:00:00.000Z');

const candidate = (
  overrides: Partial<ReceiptHandoffCandidate> = {}
): ReceiptHandoffCandidate => ({
  runId,
  runStatus: 'done',
  runAttempt: 1,
  runCompletedAt: completedAt,
  runFailureCode: null,
  confirmedPacketHash: 'b'.repeat(64),
  packetContentHash: 'b'.repeat(64),
  workItemId,
  workItemStatus: 'in_dev',
  workItemVersion: 7,
  receiptRunnerId: 'workstation-runner',
  receiptAttempt: 1,
  receiptTerminal: 'done',
  receiptSha256,
  receiptSizeBytes: 512,
  receiptMetadata: {
    runId,
    attempt: 1,
    terminal: 'done',
    receiptSha256,
    receiptSizeBytes: 512,
    finalStatus: 'succeeded',
    runtimeId: 'coding-runner',
    runtimeProfile: 'write_scoped',
    durationMs: 1200,
    cost: {state: 'unknown', reason: 'runtime_usage_not_available'},
    usage: {state: 'unknown', reason: 'runtime_usage_not_available'},
    artifactStore: {
      provider: 'workstation-local',
      reference: `runs/${runId}`,
      correlationId: `artifact-run-${runId}`
    },
    receiptArtifact: {
      name: 'agent-run-receipt.json',
      reference: `runs/${runId}/agent-run-receipt.json`,
      sha256: receiptSha256,
      sizeBytes: 512
    },
    pathManifest: {
      name: 'observed-path-manifest.json',
      reference: `runs/${runId}/observed-path-manifest.json`,
      sha256: 'd'.repeat(64),
      sizeBytes: 128
    },
    changedFiles: ['apps/web/src/example.ts'],
    checks: [{name: 'focused test', status: 'passed'}],
    riskCount: 0,
    nextAction: 'review_receipt'
  },
  receiptCompletedAt: completedAt,
  ...overrides
});

const request = () => new Request(
  `https://control.example.test/api/agent-runs/${runId}/accept-receipt?project=msa`,
  {
    method: 'POST',
    headers: {'content-type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({
      _csrf: csrfToken,
      expectedWorkItemVersion: '7',
      expectedReceiptSha256: receiptSha256
    })
  }
);

const authenticated = async (
  _request: Request,
  options?: Readonly<{csrfToken?: string | null}>
) => (options?.csrfToken === csrfToken
  ? {
      ok: true,
      session: {actorId},
      runtime: {config: {workspaceId}}
    }
  : {
      ok: false,
      response: new Response(null, {status: 403})
    }) as never;

it('accepts a valid bound successful receipt and derives the fixed QA transition target', async () => {
  const transition = vi.fn(async () => 'accepted' as const);
  const dependencies: ReceiptHandoffCommandDependencies = {
    requireSession: authenticated,
    getRuntime: async () => ({
      load: async () => candidate(),
      transition
    })
  };

  const response = await acceptAgentRunReceiptCommand(
    request(),
    runId,
    dependencies
  );

  expect(response.status).toBe(303);
  expect(response.headers.get('location')).toBe(
    `https://control.example.test/projects/msa/runs/${runId}?handoff=accepted`
  );
  expect(transition).toHaveBeenCalledWith({
    workspaceId,
    actorId,
    runId,
    receiptSha256,
    workItemId,
    expectedVersion: 7
  });
});

it('fails closed when the persisted receipt is missing', async () => {
  const transition = vi.fn();
  const dependencies: ReceiptHandoffCommandDependencies = {
    requireSession: authenticated,
    getRuntime: async () => ({
      load: async () => candidate({
        receiptRunnerId: null,
        receiptAttempt: null,
        receiptTerminal: null,
        receiptSha256: null,
        receiptSizeBytes: null,
        receiptMetadata: null,
        receiptCompletedAt: null
      }),
      transition
    })
  };

  const response = await acceptAgentRunReceiptCommand(
    request(),
    runId,
    dependencies
  );

  expect(response.status).toBe(303);
  expect(response.headers.get('location')).toContain('handoff=stale');
  expect(transition).not.toHaveBeenCalled();
});

it('fails closed when artifact evidence is not bound to the run correlation', async () => {
  const transition = vi.fn();
  const dependencies: ReceiptHandoffCommandDependencies = {
    requireSession: authenticated,
    getRuntime: async () => ({
      load: async () => candidate({
        receiptMetadata: {
          ...candidate().receiptMetadata!,
          artifactStore: {
            provider: 'workstation-local',
            reference: `runs/${runId}`,
            correlationId: 'artifact-run-other-run'
          }
        }
      }),
      transition
    })
  };

  const response = await acceptAgentRunReceiptCommand(request(), runId, dependencies);

  expect(response.headers.get('location')).toContain('handoff=stale');
  expect(transition).not.toHaveBeenCalled();
});

it('fails closed when an artifact reference does not match its store', async () => {
  const transition = vi.fn();
  const dependencies: ReceiptHandoffCommandDependencies = {
    requireSession: authenticated,
    getRuntime: async () => ({
      load: async () => candidate({
        receiptMetadata: {
          ...candidate().receiptMetadata!,
          receiptArtifact: {
            ...((candidate().receiptMetadata! as Record<string, unknown>).receiptArtifact as Record<string, unknown>),
            reference: `runs/${runId}/other.json`
          }
        }
      }),
      transition
    })
  };

  const response = await acceptAgentRunReceiptCommand(request(), runId, dependencies);

  expect(response.headers.get('location')).toContain('handoff=stale');
  expect(transition).not.toHaveBeenCalled();
});
