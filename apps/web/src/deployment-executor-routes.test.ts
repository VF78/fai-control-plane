import {afterEach, expect, it} from 'vitest';
import {POST as claim} from '../app/api/deployment-executor/claim/route';
import {POST as complete} from '../app/api/deployment-executor/complete/route';
import {POST as heartbeat} from '../app/api/deployment-executor/heartbeat/route';

afterEach(() => { delete process.env.DEPLOYMENT_EXECUTOR_TRANSPORT_ENABLED; });

it('never accepts deployment executor credentials on browser/TCP routes', async () => {
  process.env.DEPLOYMENT_EXECUTOR_TRANSPORT_ENABLED = 'true';
  await expect(claim()).resolves.toMatchObject({status: 404});
  await expect(heartbeat()).resolves.toMatchObject({status: 404});
  await expect(complete()).resolves.toMatchObject({status: 404});
});
