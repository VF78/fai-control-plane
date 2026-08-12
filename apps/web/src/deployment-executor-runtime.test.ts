import {createHash} from 'node:crypto';
import {expect, it} from 'vitest';
import {authenticateDeploymentExecutorBearer} from './deployment-executor-runtime';

it('authenticates only the exact deployment-executor bearer token', () => {
  const token = 'deployment-executor-token-000000000000000000000000';
  const hash = createHash('sha256').update(token).digest();
  expect(authenticateDeploymentExecutorBearer(`Bearer ${token}`, hash)).toBe(true);
  expect(authenticateDeploymentExecutorBearer('Bearer local-runner-token-00000000000000000000000000000', hash)).toBe(false);
  expect(authenticateDeploymentExecutorBearer(null, hash)).toBe(false);
});
