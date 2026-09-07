import {createHash} from 'node:crypto';
import {describe, expect, it, vi} from 'vitest';
import {defaultAgentRoutingPolicy} from '@fai-control-plane/domain';
import {createHermesDeliveryAdapter} from './hermes.ts';

const request = {
  role: 'developer' as const,
  repository: {id: 'repo', url: 'https://example.test/repo', defaultBranch: 'main',
    defaultBranchSha: 'a'.repeat(40)},
  projectItem: {id: 'item', projectId: 'project', issueId: 'issue', title: 'Implement exact issue',
    url: 'https://example.test/issues/1'},
  observedVersion: 'v1', sources: [], constraints: ['No merge'], acceptanceCriteria: ['Checks pass'],
  approval: null, correlationId: `browser:${'c'.repeat(64)}`, idempotencyKey: 'delivery',
  routing: {policyVersion: createHash('sha256').update(JSON.stringify(defaultAgentRoutingPolicy)).digest('hex'),
    policy: defaultAgentRoutingPolicy, classification: 'runtime-classification-required' as const}
  ,process: {policyVersion: 'b'.repeat(64), stageId: 'in-dev', stageTitle: 'In Dev',
    successTargetTitle: 'QA', reworkTargetTitle: null}
};
const attestation = {execution: {taskClass: 'ordinary_implementation' as const,
  executor: {kind: 'cli' as const, id: 'codex-cli'}, model: 'gpt-5.6-terra', effort: 'medium' as const},
outcome: 'success' as const, transition: {itemId: 'item', fromVersion: 'v1', targetStage: 'QA'}};

describe('MVP Hermes adapter', () => {
  it('submits one compact autonomous PM reconciliation to the same bound Hermes',async()=>{
    const fetch=vi.fn<(input:string|URL|Request,init?:RequestInit)=>Promise<Response>>(async()=>
      new Response(JSON.stringify({run_id:'run_pm',status:'started'}),{status:202}));
    const adapter=createHermesDeliveryAdapter({endpoint:'https://hermes.example/v1/runs',
      credentialRef:{id:'secret',purpose:'agent_delivery',locator:'/run/agent'},
      secrets:{resolve:async()=>({value:'bearer'})},fetch});
    const pm={contract:'fai.autonomous-pm-request.v1' as const,project:{id:'project',repositoryUrl:'https://github.com/VF78/control',
      trackerUrl:'https://github.com/users/VF78/projects/1'},versions:{process:'a'.repeat(64),routing:'b'.repeat(64)},
      correlationId:'browser:'+ 'c'.repeat(64),idempotencyKey:'autonomous-pm'};
    await expect(adapter.submitReconciliation(pm)).resolves.toMatchObject({deliveryReference:'run_pm'});
    const body=JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));expect(JSON.parse(body.input)).toEqual(pm);
    expect(body.instructions).toContain('at most one');expect(body.input).not.toContain('documents');
  });

  it('parses one bounded PM selection and rejects a malformed selection',async()=>{
    const output=JSON.stringify({contract:'fai.autonomous-pm-result.v1',outcome:'selected',reason:'ready',
      selection:{itemId:'item',issueUrl:'https://github.com/VF78/control/issues/42',observedVersion:'v2'}});
    const fetch=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({run_id:'run_pm',status:'completed',output})))
      .mockResolvedValueOnce(new Response(JSON.stringify({run_id:'run_bad',status:'completed',output:JSON.stringify({
        contract:'fai.autonomous-pm-result.v1',outcome:'selected',reason:'bad',selection:{itemId:'item'}})})));
    const adapter=createHermesDeliveryAdapter({endpoint:'https://hermes.example/v1/runs',
      credentialRef:{id:'secret',purpose:'agent_delivery',locator:'/run/agent'},
      secrets:{resolve:async()=>({value:'bearer'})},fetch});
    await expect(adapter.observeReconciliation('run_pm')).resolves.toMatchObject({status:'completed',result:{outcome:'selected'}});
    await expect(adapter.observeReconciliation('run_bad')).resolves.toEqual({status:'failed'});
  });

  it('delivers the neutral role contract and returns opaque evidence', async () => {
    const fetch = vi.fn<(input:string|URL|Request,init?:RequestInit)=>Promise<Response>>(async () => new Response(JSON.stringify({run_id: 'run_ref', status: 'started'}), {status: 202}));
    const adapter = createHermesDeliveryAdapter({endpoint: 'https://agent.example.test/v1/runs',
      credentialRef: {id: 'secret', purpose: 'agent', locator: '/run/secrets/agent'},
      secrets: {resolve: async () => ({value: 'bearer'})}, fetch});
    await expect(adapter.submit(request)).resolves.toEqual({deliveryReference: 'run_ref', sessionReference: request.correlationId});
    const body = JSON.parse(fetch.mock.calls[0]?.[1]?.body as string) as {input: string; instructions: string;
      session_id: string;
      provider: string; model: string; model_options: {reasoning_effort: string}};
    expect(JSON.parse(body.input)).toMatchObject({contract: 'fai.agent-role-request.v1'});
    expect(JSON.parse(body.input)).toEqual({contract: 'fai.agent-role-request.v1',
      task: {role: 'developer', stage: {id: 'in-dev', title: 'In Dev'},
        issueUrl: 'https://example.test/issues/1'},
      versions: {process: 'b'.repeat(64), routing: request.routing.policyVersion},
      receipt: {correlationId: request.correlationId, idempotencyKey: 'delivery',
        itemId:'item',fromVersion:'v1',successTarget:'QA',reworkTarget:'In Dev',
        contract: 'fai.agent-executor-result.v1'}});
    expect(body.input).not.toContain('approval');
    expect(body.input).not.toContain('constraints');
    expect(body.input).not.toContain('acceptanceCriteria');
    expect(body.input).not.toContain('defaultBranchSha');
    expect(body.instructions).toContain('native git/gh directly');
    expect(body.instructions).toContain('Never ask Control Plane to proxy');
    expect(body.session_id).toBe(request.correlationId);
    expect(body).toMatchObject({provider: 'openai-codex', model: 'gpt-5.6-terra',
      model_options: {reasoning_effort: 'medium'}});
  });

  it('observes reversed executor keys identically with and without in-memory submission', async () => {
    const result = {contract:'fai.agent-executor-result.v1',decision:'accepted',...attestation,
      execution:{...attestation.execution,executor:{id:'codex-cli',kind:'cli'}},
      reason:'done',evidence:[{kind:'checks',result:'passed'}],deliverables:[{label:'PR',url:'https://example.test/pr/1'}]};
    const fetch = vi.fn(async (_input: unknown, init?: RequestInit) => init?.method === 'POST'
      ? new Response(JSON.stringify({run_id:'run_ref',status:'started'}),{status:202})
      : new Response(JSON.stringify({run_id:'run_ref',status:'completed',output:JSON.stringify(result)})));
    const options = {endpoint:'https://hermes.example/v1/runs',
      credentialRef:{id:'secret',purpose:'agent_delivery' as const,locator:'/run/secrets/agent'},
      secrets:{resolve:async()=>({value:'bearer'})},fetch};
    const adapter = createHermesDeliveryAdapter(options); await adapter.submit(request);
    expect(await adapter.observe('run_ref')).toEqual({status:'completed',result});
    expect(await createHermesDeliveryAdapter(options).observe('run_ref')).toEqual({status:'completed',result});
  });

  it('maps retained Hermes terminal status without exposing provider output', async () => {
    const fetch = vi.fn<(input:string|URL|Request,init?:RequestInit)=>Promise<Response>>(async () =>
      new Response(JSON.stringify({run_id: 'run_ref', status: 'failed', error: 'secret detail'})));
    const adapter = createHermesDeliveryAdapter({endpoint: 'https://hermes.example/v1/runs',
      credentialRef: {id: 'secret', purpose: 'agent_delivery', locator: '/run/secrets/agent'},
      secrets: {resolve: async () => ({value: 'bearer'})}, fetch});
    await expect(adapter.observe('run_ref')).resolves.toEqual({status: 'failed', failureCode: 'provider_failed'});
    expect(String(fetch.mock.calls[0]?.[0])).toBe('https://hermes.example/v1/runs/run_ref');
  });

  it('preserves bounded progress while a run remains active', async () => {
    const adapter = createHermesDeliveryAdapter({endpoint: 'https://hermes.example/v1/runs',
      credentialRef: {id: 'secret', purpose: 'agent_delivery', locator: '/run/secrets/agent'},
      secrets: {resolve: async () => ({value: 'bearer'})}, fetch: vi.fn(async () =>
        new Response(JSON.stringify({run_id: 'run_ref', status: 'running',
          progress: {reference: 'tool:17', observed_at: '2026-08-31T10:00:00.000Z'}}))) });
    await expect(adapter.observe('run_ref')).resolves.toEqual({status: 'started',
      progress: {reference: 'tool:17', observedAt: '2026-08-31T10:00:00.000Z'}});
  });

  it('accepts only the bounded executor-result contract and preserves stable deliverable links', async () => {
    const result = {contract: 'fai.agent-executor-result.v1', decision: 'accepted', ...attestation,
      reason: 'Ready for QA',
      evidence: [{kind: 'checks', result: 'Focused tests passed'}],
      deliverables: [{label: 'Review document', url: 'https://example.test/result.docx'}]};
    const adapter = createHermesDeliveryAdapter({endpoint: 'https://hermes.example/v1/runs',
      credentialRef: {id: 'secret', purpose: 'agent_delivery', locator: '/run/secrets/agent'},
      secrets: {resolve: async () => ({value: 'bearer'})}, fetch: vi.fn(async () =>
        new Response(JSON.stringify({run_id: 'run_ref', status: 'completed', output: JSON.stringify(result)})))});
    await expect(adapter.observe('run_ref')).resolves.toEqual({status: 'completed', result});
  });

  it('accepts one exact JSON result in a standard json fence', async () => {
    const result = {contract: 'fai.agent-executor-result.v1', decision: 'accepted', ...attestation,
      reason: 'Ready for QA', evidence: [{kind: 'checks', result: 'Focused tests passed'}],
      deliverables: [{label: 'Review', url: 'https://example.test/pr/1'}]};
    const adapter = createHermesDeliveryAdapter({endpoint: 'https://hermes.example/v1/runs',
      credentialRef: {id: 'secret', purpose: 'agent_delivery', locator: '/run/secrets/agent'},
      secrets: {resolve: async () => ({value: 'bearer'})}, fetch: vi.fn(async () =>
        new Response(JSON.stringify({run_id: 'run_ref', status: 'completed',
          output: `\`\`\`json\n${JSON.stringify(result)}\n\`\`\``})))});
    await expect(adapter.observe('run_ref')).resolves.toEqual({status: 'completed', result});
  });

  it('maps a rejected executor result to failure', async () => {
    const result = {contract: 'fai.agent-executor-result.v1', decision: 'rejected', ...attestation,
      outcome: 'rework' as const, reason: 'Repository unavailable',
      evidence: [{kind: 'source_access', result: 'No checkout'}]};
    const adapter = createHermesDeliveryAdapter({endpoint: 'https://hermes.example/v1/runs',
      credentialRef: {id: 'secret', purpose: 'agent_delivery', locator: '/run/secrets/agent'},
      secrets: {resolve: async () => ({value: 'bearer'})}, fetch: vi.fn(async () =>
        new Response(JSON.stringify({run_id: 'run_ref', status: 'completed', output: JSON.stringify(result)})))});
    await expect(adapter.observe('run_ref')).resolves.toMatchObject({status: 'failed',
      failureCode: 'agent_result_rejected', result: {...result, deliverables: []}});
  });

  it('keeps a rejected run in the current stage when no rework stage is configured', async () => {
    const rejected = {contract: 'fai.agent-executor-result.v1', decision: 'rejected',
      execution: attestation.execution, outcome: 'rework' as const,
      transition: {...attestation.transition, targetStage: 'In Dev'}, reason: 'Executor failed',
      evidence: [{kind: 'executor', result: 'Codex exited non-zero'}], deliverables: []};
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({run_id: 'run_ref', status: 'started'}), {status: 202}))
      .mockResolvedValueOnce(new Response(JSON.stringify({run_id: 'run_ref', status: 'completed',
        output: JSON.stringify(rejected)})));
    const adapter = createHermesDeliveryAdapter({endpoint: 'https://hermes.example/v1/runs',
      credentialRef: {id: 'secret', purpose: 'agent_delivery', locator: '/run/secrets/agent'},
      secrets: {resolve: async () => ({value: 'bearer'})}, fetch});
    await adapter.submit(request);
    await expect(adapter.observe('run_ref')).resolves.toEqual({status: 'failed',
      failureCode: 'agent_result_rejected', result: rejected});
  });

  it('accepts direct-agent results', async () => {
    const result = {contract: 'fai.agent-executor-result.v1', decision: 'accepted',
      execution: {taskClass: 'manager_project_ops', executor: {kind: 'direct-agent'},
        model: 'gpt-5.6-terra', effort: 'medium'}, outcome: 'success',
      transition: attestation.transition, reason: 'planned', evidence: [{kind: 'plan', result: 'ready'}]};
    const adapter = createHermesDeliveryAdapter({endpoint: 'https://hermes.example/v1/runs',
      credentialRef: {id: 'secret', purpose: 'agent_delivery', locator: '/run/secrets/agent'},
      secrets: {resolve: async () => ({value: 'bearer'})},
      fetch: vi.fn(async () => new Response(JSON.stringify({run_id: 'run_ref', status: 'completed',
        output: JSON.stringify(result)})))});
    await expect(adapter.observe('run_ref')).resolves.toMatchObject({status: 'completed'});
  });

  it.each([undefined, 'not-json', JSON.stringify({contract: 'other', decision: 'accepted'})])(
    'fails closed when a completed run has no valid executor result %#', async (output) => {
      const adapter = createHermesDeliveryAdapter({endpoint: 'https://hermes.example/v1/runs',
        credentialRef: {id: 'secret', purpose: 'agent_delivery', locator: '/run/secrets/agent'},
        secrets: {resolve: async () => ({value: 'bearer'})}, fetch: vi.fn(async () =>
          new Response(JSON.stringify({run_id: 'run_ref', status: 'completed', ...(output === undefined ? {} : {output})})))});
      await expect(adapter.observe('run_ref')).resolves.toEqual({status: 'failed', failureCode: 'agent_result_invalid'});
    });

  it('fails closed when an accepted executor result has no evidence', async () => {
    const adapter = createHermesDeliveryAdapter({endpoint: 'https://hermes.example/v1/runs',
      credentialRef: {id: 'secret', purpose: 'agent_delivery', locator: '/run/secrets/agent'},
      secrets: {resolve: async () => ({value: 'bearer'})}, fetch: vi.fn(async () =>
        new Response(JSON.stringify({run_id: 'run_ref', status: 'completed', output: JSON.stringify({
          contract: 'fai.agent-executor-result.v1', decision: 'accepted', ...attestation, reason: 'done', evidence: []
        })})))});
    await expect(adapter.observe('run_ref')).resolves.toEqual({status: 'failed', failureCode: 'agent_result_invalid'});
  });

  it('keeps an expired run unobservable instead of treating 404 as failure', async () => {
    const adapter = createHermesDeliveryAdapter({endpoint: 'https://hermes.example/v1/runs',
      credentialRef: {id: 'secret', purpose: 'agent_delivery', locator: '/run/secrets/agent'},
      secrets: {resolve: async () => ({value: 'bearer'})}, fetch: vi.fn(async (_input, init) => {
        expect(init?.headers).toMatchObject({authorization: 'Bearer bearer'});
        return new Response(JSON.stringify({error: {code: 'run_not_found'}}), {status: 404});
      })});
    await expect(adapter.observe('run_ref')).resolves.toEqual({status: 'unknown'});
  });

  it.each([null, {error: {code: 'proxy_not_found'}}, {error: 'run_not_found'}])(
    'fails closed for a generic 404 payload %#', async (payload) => {
      const adapter = createHermesDeliveryAdapter({endpoint: 'https://hermes.example/v1/runs',
        credentialRef: {id: 'secret', purpose: 'agent_delivery', locator: '/run/secrets/agent'},
        secrets: {resolve: async () => ({value: 'bearer'})}, fetch: vi.fn(async () =>
          payload === null ? new Response('<html>nginx</html>', {status: 404})
            : new Response(JSON.stringify(payload), {status: 404}))});
      await expect(adapter.observe('run_ref')).rejects.toThrow('agent_status_failed');
    });

  it('rejects a non-HTTPS agent endpoint at composition', () => {
    expect(() => createHermesDeliveryAdapter({endpoint: 'http://agent.example.test/v1/runs',
      credentialRef: {id: 'secret', purpose: 'agent', locator: '/run/secrets/agent'},
      secrets: {resolve: async () => ({value: 'bearer'})}})).toThrow('agent_endpoint_invalid');
    expect(() => createHermesDeliveryAdapter({endpoint: 'https://agent.example.test/role-requests',
      credentialRef: {id: 'secret', purpose: 'agent', locator: '/run/secrets/agent'},
      secrets: {resolve: async () => ({value: 'bearer'})}})).toThrow('agent_endpoint_invalid');
  });

  it('allows a named profile only on an explicitly trusted private HTTP gateway', () => {
    expect(() => createHermesDeliveryAdapter({endpoint: 'http://hermes-gateway:8642/p/project-control/v1/runs',
      credentialRef: {id: 'secret', purpose: 'agent', locator: '/run/secrets/agent'},
      secrets: {resolve: async () => ({value: 'bearer'})}, allowPrivateHttp: true})).not.toThrow();
    expect(() => createHermesDeliveryAdapter({endpoint: 'http://agent.example.test/p/project-control/v1/runs',
      credentialRef: {id: 'secret', purpose: 'agent', locator: '/run/secrets/agent'},
      secrets: {resolve: async () => ({value: 'bearer'})}, allowPrivateHttp: true})).toThrow('agent_endpoint_invalid');
  });

  it('rejects malformed provider evidence', async () => {
    const adapter = createHermesDeliveryAdapter({endpoint: 'https://agent.example.test/v1/runs',
      credentialRef: {id: 'secret', purpose: 'agent', locator: '/run/secrets/agent'},
      secrets: {resolve: async () => ({value: 'bearer'})},
      fetch: vi.fn(async () => new Response('{}', {status: 202}))});
    await expect(adapter.submit(request)).rejects.toThrow('agent_response_invalid');
  });
});
