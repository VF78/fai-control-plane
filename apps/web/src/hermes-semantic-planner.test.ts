import {expect, it, vi} from 'vitest';
import {createHermesSemanticPlanner, hermesSemanticPlannerLimits} from './hermes-semantic-planner';

const artifact = {id: '10000000-0000-4000-8000-000000000001', projectId: '10000000-0000-4000-8000-000000000002', name: 'Passport', sourceKind: 'project_passport' as const, mediaType: 'text/plain' as const, content: 'Confirmed scope\nAcceptance method', sizeBytes: 33, sha256: 'a'.repeat(64), sourceFile: null, provenance: {kind: 'manager_note' as const, label: 'PO', capturedAt: '2026-08-10T10:00:00.000Z'}, version: 1 as const};
const citation = {kind: 'citation' as const, artifactId: artifact.id, locator: {kind: 'line_range' as const, startLine: 1, endLine: 1}};
const definition = {title: 'Hermes plan', outcomes: Array.from({length: 5}, (_, index) => ({key: `outcome_${index + 1}`, title: `Outcome ${index + 1}`, weight: 20, evidence: citation})), milestones: [{key: 'm1', title: 'Acceptance', checkpoint: 'PO accepts', targetAt: null, evidence: citation}], risks: [{key: 'r1', statement: 'Interpretation', mitigation: 'Review source', evidence: citation}], tasks: [{key: 't1', title: 'Prepare', outcomeKeys: ['outcome_1'], milestoneKey: 'm1', dependsOn: [], acceptanceEvidence: [{description: 'Check source', evidence: citation}]}]};
const request = {idempotencyKey: 'project_plan.draft.generate.v1:plan:0:manifest', sourceManifest: [{artifactId: artifact.id, version: 1, sha256: artifact.sha256}], artifacts: [artifact]};

it('is disabled by default and never calls Hermes', async () => {
  const fetch = vi.fn(); const readToken = vi.fn();
  await expect(createHermesSemanticPlanner({environment: {}, fetch, readToken}).generate(request)).resolves.toMatchObject({ok: false, error: {code: 'INVALID_TRANSITION'}});
  expect(fetch).not.toHaveBeenCalled(); expect(readToken).not.toHaveBeenCalled();
});

it('sends only bounded selected corpus with a stable idempotency identity to a private endpoint', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({definition}), {headers: {'content-type': 'application/json'}}));
  const planner = createHermesSemanticPlanner({environment: {HERMES_SEMANTIC_PLANNING_ENABLED: 'true', HERMES_SEMANTIC_PLANNING_URL: 'http://127.0.0.1:8787/v1/plan', HERMES_SEMANTIC_PLANNING_TOKEN_FILE: '/run/secrets/hermes'}, readToken: async () => 'token', fetch});
  await expect(planner.generate(request)).resolves.toMatchObject({ok: true, value: {title: 'Hermes plan'}});
  expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:8787/v1/plan', expect.objectContaining({redirect: 'error', headers: expect.objectContaining({'idempotency-key': request.idempotencyKey, authorization: 'Bearer token'})}));
  const body = JSON.parse(fetch.mock.calls[0]![1].body as string);
  expect(body).toEqual({schema: 'project_plan_definition_v1', idempotencyKey: request.idempotencyKey, sourceManifest: request.sourceManifest, sources: [{id: artifact.id, sourceKind: artifact.sourceKind, mediaType: artifact.mediaType, sha256: artifact.sha256, content: artifact.content}]});
});

it('allows HTTPS to a literal private address while retaining the redirect block', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({definition}), {headers: {'content-type': 'application/json'}}));
  const planner = createHermesSemanticPlanner({environment: {HERMES_SEMANTIC_PLANNING_ENABLED: 'true', HERMES_SEMANTIC_PLANNING_URL: 'https://10.1.2.3/v1/plan', HERMES_SEMANTIC_PLANNING_TOKEN_FILE: '/run/secrets/hermes'}, readToken: async () => 'token', fetch});
  await expect(planner.generate(request)).resolves.toMatchObject({ok: true});
  expect(fetch).toHaveBeenCalledWith('https://10.1.2.3/v1/plan', expect.objectContaining({redirect: 'error'}));
});

it('cancels a response with an invalid declared content length', async () => {
  const response = new Response('not read', {headers: {'content-type': 'application/json', 'content-length': 'invalid'}});
  const cancel = vi.spyOn(response.body!, 'cancel');
  const planner = createHermesSemanticPlanner({environment: {HERMES_SEMANTIC_PLANNING_ENABLED: 'true', HERMES_SEMANTIC_PLANNING_URL: 'http://127.0.0.1/v1/plan', HERMES_SEMANTIC_PLANNING_TOKEN_FILE: '/run/secrets/hermes'}, readToken: async () => 'token', fetch: async () => response});
  await expect(planner.generate(request)).resolves.toMatchObject({ok: false});
  expect(cancel).toHaveBeenCalledOnce();
});

it('fails closed for public/unsafe HTTP SSRF, token, redirects, response media and invalid citations', async () => {
  const fetch = vi.fn(); const base = {HERMES_SEMANTIC_PLANNING_ENABLED: 'true', HERMES_SEMANTIC_PLANNING_TOKEN_FILE: '/run/secrets/hermes'};
  await expect(createHermesSemanticPlanner({environment: {...base, HERMES_SEMANTIC_PLANNING_URL: 'https://example.com/plan'}, readToken: async () => 'token', fetch}).generate(request)).resolves.toMatchObject({ok: false});
  await expect(createHermesSemanticPlanner({environment: {...base, HERMES_SEMANTIC_PLANNING_URL: 'http://localhost/plan'}, readToken: async () => 'token', fetch}).generate(request)).resolves.toMatchObject({ok: false});
  await expect(createHermesSemanticPlanner({environment: {...base, HERMES_SEMANTIC_PLANNING_URL: 'http://10.1.2.3/plan'}, readToken: async () => 'token', fetch}).generate(request)).resolves.toMatchObject({ok: false});
  await expect(createHermesSemanticPlanner({environment: {...base, HERMES_SEMANTIC_PLANNING_URL: 'http://127.0.0.1/plan'}, readToken: async () => 'bad token', fetch}).generate(request)).resolves.toMatchObject({ok: false});
  const timeout = createHermesSemanticPlanner({environment: {...base, HERMES_SEMANTIC_PLANNING_URL: 'http://127.0.0.1/plan'}, readToken: async () => 'token', fetch: async () => { throw new Error('timeout'); }});
  await expect(timeout.generate(request)).resolves.toMatchObject({ok: false});
  const malformed = createHermesSemanticPlanner({environment: {...base, HERMES_SEMANTIC_PLANNING_URL: 'http://127.0.0.1/plan'}, readToken: async () => 'token', fetch: async () => new Response('x'.repeat(hermesSemanticPlannerLimits.responseBytes + 1))});
  await expect(malformed.generate(request)).resolves.toMatchObject({ok: false});
  const redirect = createHermesSemanticPlanner({environment: {...base, HERMES_SEMANTIC_PLANNING_URL: 'http://127.0.0.1/plan'}, readToken: async () => 'token', fetch: async () => new Response(JSON.stringify({definition}), {headers: {'content-type': 'text/plain'}})});
  await expect(redirect.generate(request)).resolves.toMatchObject({ok: false});
  const foreign = {...definition, outcomes: definition.outcomes.map((outcome) => ({...outcome, evidence: {...citation, artifactId: '10000000-0000-4000-8000-000000000099'}}))};
  const mismatch = createHermesSemanticPlanner({environment: {...base, HERMES_SEMANTIC_PLANNING_URL: 'http://127.0.0.1/plan'}, readToken: async () => 'token', fetch: async () => new Response(JSON.stringify({definition: foreign}), {headers: {'content-type': 'application/json'}})});
  await expect(mismatch.generate(request)).resolves.toMatchObject({ok: false, error: {code: 'INVALID_COMMAND'}});
});
