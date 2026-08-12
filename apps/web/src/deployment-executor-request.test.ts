import {expect, it} from 'vitest';
import {deploymentExecutorLeaseToken,
  readBoundedDeploymentExecutorJson} from './deployment-executor-request';

it('reads only a bounded executor payload and its separate lease header', async () => {
  const request = new Request('https://control.test/api/deployment-executor/heartbeat', {method: 'POST',
    headers: {'content-type': 'application/json', 'x-fai-deployment-lease-token': 'l'.repeat(43)},
    body: JSON.stringify({jobId: 'job'})});
  expect(deploymentExecutorLeaseToken(request)).toBe('l'.repeat(43));
  await expect(readBoundedDeploymentExecutorJson(request, 128)).resolves.toEqual({jobId: 'job'});
  const oversized = new Request('https://control.test/api/deployment-executor/complete', {method: 'POST',
    headers: {'content-length': '129'}, body: '{}'});
  await expect(readBoundedDeploymentExecutorJson(oversized, 128)).resolves.toBeNull();
});
