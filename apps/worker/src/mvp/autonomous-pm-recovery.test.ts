import {describe, expect, it, vi} from 'vitest';
import type {AutonomousPmDeliveryPort} from '@fai-control-plane/domain';
import {createEndpointRecoveryGate, observeAutonomousPmRun} from './runtime.ts';
import {projectRuntimeOwnership, restartProjectHermesGateway} from './docker-project-runtime.ts';

type Observation = Awaited<ReturnType<AutonomousPmDeliveryPort['observeReconciliation']>>;
const runtime = {workspaceId: 'workspace', projectId: 'project', runtimeId: 'project-hermes'};
const harness = (state: unknown, restartFails = false) => {
  const docker = vi.fn(async (method: string) => {
    if (method === 'POST' && restartFails) throw new Error('docker_engine_failed');
    return method === 'GET' ? {status: 200, body: Buffer.from(JSON.stringify({
      Name: '/project-hermes-gateway', State: state,
      Config: {Labels: projectRuntimeOwnership({...runtime, artifact: runtime}, 'gateway')}
    }))} : {status: 204, body: Buffer.alloc(0)};
  });
  const observeReconciliation = vi.fn<AutonomousPmDeliveryPort['observeReconciliation']>()
    .mockResolvedValue({status: 'unknown'});
  const notifications = new Map<string, string>();
  const notify = vi.fn(async (step: string, text: string) => {
    // Mirror the outbox's existing unique idempotency key, including the run.
    notifications.set(`agent.recovery:run_pm:${step}`, text);
  });
  const ports = {delivery: {observeReconciliation}, recoveryGate: createEndpointRecoveryGate(),
    restartUnhealthy: () => restartProjectHermesGateway(runtime, docker, true), notify};
  return {docker, observeReconciliation, notifications, notify, ports,
    poll: () => observeAutonomousPmRun('run_pm', ports)};
};

describe('autonomous PM observation recovery', () => {
  it('deduplicates confirmed approval waiting across polls and worker restart without recovering the runtime', async () => {
    const h = harness({Running:false});
    h.observeReconciliation.mockResolvedValue({status:'started',waitingFor:'human-approval'});
    for (let i = 0; i < 4; i++) await expect(h.poll()).resolves.toEqual({status:'started',waitingFor:'human-approval'});
    h.ports.recoveryGate = createEndpointRecoveryGate();
    await h.poll();
    expect([...h.notifications.keys()]).toEqual(['agent.recovery:run_pm:human-approval']);
    expect(h.docker).not.toHaveBeenCalled();
    h.observeReconciliation.mockResolvedValue({status:'started'});
    await expect(h.poll()).resolves.toEqual({status:'started'});
    expect(h.notifications.size).toBe(1);
  });

  it.each([
    [{Running: true, Health: {Status: 'healthy'}}, 0],
    [{Running: true}, 0],
    [undefined, 0],
    [{Running: false}, 1],
    [{Running: true, Health: {Status: 'unhealthy'}}, 1]
  ])('conditions recovery on exact owned runtime health: %j', async (state, restarts) => {
    const h = harness(state);
    for (let i = 0; i < 6; i++) await expect(h.poll()).resolves.toEqual({status: 'unknown'});
    expect(h.docker.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(restarts);
    expect(h.observeReconciliation.mock.calls.every(([reference]) => reference === 'run_pm')).toBe(true);
    expect([...h.notifications.keys()].filter(key => key.endsWith('reconciliation-pending'))).toHaveLength(1);
    expect(h.notify.mock.calls.filter(([step]) => step.endsWith('reconciliation-pending')).length).toBeGreaterThan(1);
    // A restarted worker continues the same receipt and notification identity.
    h.ports.recoveryGate = createEndpointRecoveryGate();
    await h.poll(); await h.poll();
    expect([...h.notifications.keys()].filter(key => key.endsWith('reconciliation-pending'))).toHaveLength(1);
  });

  it.each([
    {status: 'started'},
    {status: 'failed'},
    {status: 'completed', result: {contract: 'fai.autonomous-pm-result.v1', outcome: 'no-eligible', reason: 'No ready tasks'}}
  ] satisfies Observation[])('returns confirmed original run evidence after restart: %j', async observed => {
    const h = harness({Running: false});
    h.observeReconciliation.mockResolvedValueOnce({status: 'unknown'})
      .mockResolvedValueOnce({status: 'unknown'}).mockResolvedValueOnce(observed);
    await h.poll();
    await expect(h.poll()).resolves.toEqual(observed);
    expect(h.observeReconciliation).toHaveBeenLastCalledWith('run_pm');
    expect([...h.notifications.keys()].some(key => key.endsWith('reconciliation-pending'))).toBe(false);
  });

  it('keeps uncertainty nonterminal when observation and runtime recovery fail', async () => {
    const h = harness({Running: false}, true);
    h.observeReconciliation.mockRejectedValue(new Error('observation unavailable'));
    for (let i = 0; i < 5; i++) await expect(h.poll()).resolves.toEqual({status: 'unknown'});
    expect(h.docker.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(1);
    expect(h.notifications.size).toBe(1);
  });

  it('accepts later confirmed failure or completion after the recovery budget exhausts', async () => {
    const h = harness({Running: false});
    for (let i = 0; i < 5; i++) await h.poll();
    h.observeReconciliation.mockResolvedValueOnce({status: 'failed'});
    await expect(h.poll()).resolves.toEqual({status: 'failed'});
    h.observeReconciliation.mockResolvedValueOnce({status: 'completed', result: {
      contract: 'fai.autonomous-pm-result.v1', outcome: 'no-eligible', reason: 'No ready tasks'}});
    await expect(h.poll()).resolves.toMatchObject({status: 'completed'});
  });
});
