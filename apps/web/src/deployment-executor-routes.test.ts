import {afterEach, expect, it} from 'vitest';
import {POST as claim} from '../app/api/deployment-executor/claim/route';
import {POST as complete} from '../app/api/deployment-executor/complete/route';
import {POST as heartbeat} from '../app/api/deployment-executor/heartbeat/route';

afterEach(() => { delete process.env.DEPLOYMENT_EXECUTOR_TRANSPORT_ENABLED; });

it('keeps all privileged deployment executor endpoints fail-closed until separately activated', async () => {
  const request = () => new Request('https://control.test/api/deployment-executor', {method: 'POST'});
  await expect(claim(request())).resolves.toMatchObject({status: 503});
  await expect(heartbeat(request())).resolves.toMatchObject({status: 503});
  await expect(complete(request())).resolves.toMatchObject({status: 503});
});
