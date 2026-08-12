import {expect, it, vi} from 'vitest';
import {hashSemanticProjectPlanningContext} from '@fai-control-plane/application';
import {hashProjectPlanSourceManifest} from '@fai-control-plane/domain';
import {checkHermesSemanticPlannerHealth, createHermesSemanticPlanner, hermesSemanticPlannerLimits, hermesSemanticPlanningConfiguration} from './hermes-semantic-planner';

const artifact = {id: '10000000-0000-4000-8000-000000000001', projectId: '10000000-0000-4000-8000-000000000002', name: 'Passport', sourceKind: 'project_passport' as const, mediaType: 'text/plain' as const, content: 'Confirmed scope\nAcceptance method', sizeBytes: 33, sha256: 'a'.repeat(64), sourceFile: null, provenance: {kind: 'manager_note' as const, label: 'PO', capturedAt: '2026-08-10T10:00:00.000Z'}, version: 1 as const};
const citation = {kind: 'citation' as const, artifactId: artifact.id, locator: {kind: 'line_range' as const, startLine: 1, endLine: 1}};
const definition = {title: 'Hermes plan', outcomes: Array.from({length: 5}, (_, index) => ({key: `outcome_${index + 1}`, title: `Outcome ${index + 1}`, weight: 20, evidence: citation})), milestones: [{key: 'm1', title: 'Acceptance', checkpoint: 'PO accepts', targetAt: null, evidence: citation}], risks: [{key: 'r1', statement: 'Interpretation', mitigation: 'Review source', evidence: citation}], tasks: [{key: 't1', title: 'Prepare', responsibility: {kind: 'project_role' as const, role: 'project_owner' as const}, outcomeKeys: ['outcome_1'], milestoneKey: 'm1', dependsOn: [], acceptanceEvidence: [{description: 'Check source', evidence: citation}]}]};
const planningContext = {schemaVersion: 1 as const, projectId: artifact.projectId, deliveryProtocol: {id: '10000000-0000-4000-8000-000000000003', revision: 1, contentHash: 'b'.repeat(64), stages: [{key: 'delivery', name: 'Delivery', taskStatus: 'in_dev' as const, responsibility: {kind: 'project_role' as const, role: 'contributor' as const}, executionMode: 'manual' as const, requiredEvidence: ['Change'], allowedNextStageKey: null}]}, responsibilityCandidates: [{kind: 'project_role' as const, role: 'project_owner' as const}]};
const sourceManifest = [{artifactId: artifact.id, version: 1, sha256: artifact.sha256}];
const request = {idempotencyKey: 'project_plan.draft.generate.v1:plan:0:manifest', sourceManifest,
  sourceManifestHash: hashProjectPlanSourceManifest(sourceManifest), artifacts: [artifact], planningContext,
  planningContextHash: hashSemanticProjectPlanningContext(planningContext)};
const configured = {HERMES_SEMANTIC_PLANNING_ENABLED: 'true', HERMES_SEMANTIC_PLANNING_SOCKET: hermesSemanticPlannerLimits.socketPath, HERMES_SEMANTIC_PLANNING_TOKEN_FILE: hermesSemanticPlannerLimits.tokenFile, FCP_RELEASE_COMMIT: 'c'.repeat(40)};

it('is disabled by default and never contacts the Hermes UDS', async () => {
  const exchange = vi.fn(); const readToken = vi.fn();
  await expect(createHermesSemanticPlanner({environment: {}, exchange, readToken}).generate(request)).resolves.toMatchObject({ok: false, error: {code: 'INVALID_TRANSITION'}});
  expect(exchange).not.toHaveBeenCalled(); expect(readToken).not.toHaveBeenCalled();
  expect(hermesSemanticPlanningConfiguration({}).configured).toBe(false);
});

it('sends the exact bounded project context through only the canonical authenticated UDS', async () => {
  const exchange = vi.fn().mockResolvedValue(JSON.stringify({definition}));
  const planner = createHermesSemanticPlanner({environment: configured, readToken: async () => 't'.repeat(32), exchange});
  await expect(planner.generate(request)).resolves.toMatchObject({ok: true, value: {title: 'Hermes plan'}});
  expect(exchange).toHaveBeenCalledWith(hermesSemanticPlannerLimits.socketPath, expect.any(String));
  const body = JSON.parse(exchange.mock.calls[0]![1]);
  expect(body).toEqual({schemaVersion: 1, operation: 'project_plan.draft.generate', idempotencyKey: request.idempotencyKey,
    sourceManifest: request.sourceManifest, sourceManifestHash: request.sourceManifestHash, planningContextHash: request.planningContextHash,
    planningContext, sources: [{id: artifact.id, sourceKind: artifact.sourceKind, mediaType: artifact.mediaType,
      sha256: artifact.sha256, content: artifact.content}], authentication: {scheme: 'bearer', token: 't'.repeat(32)}});
  expect(JSON.stringify(body.planningContext)).not.toContain('provider');
  expect(JSON.stringify(body.sources)).not.toContain('sourceFile');
});

it('uses authenticated bounded live health and rejects malformed or unavailable replies', async () => {
  const exchange = vi.fn(async (_socket: string, body: string) => {
    const request = JSON.parse(body);
    return JSON.stringify({status: 'ready', operation: 'health', nonce: request.nonce,
      releaseCommit: 'c'.repeat(40), configSha256: 'd'.repeat(64)});
  });
  await expect(checkHermesSemanticPlannerHealth({environment: configured, readToken: async () => 't'.repeat(32), exchange}))
    .resolves.toEqual({healthy: true, remediation: expect.any(String), releaseCommit: 'c'.repeat(40)});
  expect(exchange).toHaveBeenCalledWith(hermesSemanticPlannerLimits.socketPath, expect.any(String), hermesSemanticPlannerLimits.healthTimeoutMs);
  await expect(checkHermesSemanticPlannerHealth({environment: configured, readToken: async () => 'short', exchange}))
    .resolves.toMatchObject({healthy: false});
  await expect(checkHermesSemanticPlannerHealth({environment: configured, readToken: async () => 't'.repeat(32), exchange: async () => '{}'}))
    .resolves.toMatchObject({healthy: false});
  await expect(checkHermesSemanticPlannerHealth({environment: configured, readToken: async () => 't'.repeat(32), exchange: async (_socket, body) => JSON.stringify({status: 'ready', operation: 'health', nonce: JSON.parse(body).nonce, releaseCommit: 'e'.repeat(40), configSha256: 'd'.repeat(64)})}))
    .resolves.toMatchObject({healthy: false});
});

it('rejects drifted CAS hashes and outbound secrets before contacting the socket', async () => {
  const exchange = vi.fn();
  const planner = createHermesSemanticPlanner({environment: configured, readToken: async () => 't'.repeat(32), exchange});
  await expect(planner.generate({...request, sourceManifestHash: '0'.repeat(64)})).resolves.toMatchObject({ok: false});
  await expect(planner.generate({...request, artifacts: [{...artifact, content: 'postgresql://user:password@db/plans'}]}))
    .resolves.toMatchObject({ok: false});
  expect(exchange).not.toHaveBeenCalled();
});

it('fails closed on transport drift, invalid auth, runtime failure and malformed output', async () => {
  const exchange = vi.fn(); const base = {readToken: async () => 't'.repeat(32), exchange};
  await expect(createHermesSemanticPlanner({...base, environment: {...configured, HERMES_SEMANTIC_PLANNING_SOCKET: '/tmp/planner.sock'}}).generate(request)).resolves.toMatchObject({ok: false});
  await expect(createHermesSemanticPlanner({...base, environment: configured, readToken: async () => 'short'}).generate(request)).resolves.toMatchObject({ok: false});
  await expect(createHermesSemanticPlanner({...base, environment: configured, exchange: async () => { throw new Error('down'); }}).generate(request)).resolves.toMatchObject({ok: false});
  await expect(createHermesSemanticPlanner({...base, environment: configured, exchange: async () => 'x'.repeat(hermesSemanticPlannerLimits.responseBytes + 1)}).generate(request)).resolves.toMatchObject({ok: false});
  await expect(createHermesSemanticPlanner({...base, environment: configured, exchange: async () => JSON.stringify({definition, extra: true})}).generate(request)).resolves.toMatchObject({ok: false});
});

it('rejects citations and responsibilities outside the frozen corpus and candidates', async () => {
  const base = {environment: configured, readToken: async () => 't'.repeat(32)};
  const foreignCitation = {...definition, outcomes: definition.outcomes.map((outcome) => ({...outcome, evidence: {...citation, artifactId: '20000000-0000-4000-8000-000000000001'}}))};
  await expect(createHermesSemanticPlanner({...base, exchange: async () => JSON.stringify({definition: foreignCitation})}).generate(request)).resolves.toMatchObject({ok: false, error: {code: 'INVALID_COMMAND'}});
  const foreignResponsibility = {...definition, tasks: [{...definition.tasks[0]!, responsibility: {kind: 'agent_profile', agentProfileId: '20000000-0000-4000-8000-000000000002'}}]};
  await expect(createHermesSemanticPlanner({...base, exchange: async () => JSON.stringify({definition: foreignResponsibility})}).generate(request)).resolves.toMatchObject({ok: false, error: {code: 'INVALID_COMMAND'}});
});
