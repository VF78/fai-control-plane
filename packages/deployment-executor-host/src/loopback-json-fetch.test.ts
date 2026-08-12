import {createServer} from 'node:http';
import {afterEach, describe, expect, it} from 'vitest';
import {createLoopbackJsonFetch} from './loopback-json-fetch';

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) =>
    new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe('deployment executor loopback transport', () => {
  it('posts bounded JSON with only the deployment lease header', async () => {
    const server = createServer((request, response) => {
      expect(request.headers['x-fai-deployment-lease-token']).toBe('l'.repeat(32));
      response.writeHead(200, {'content-type': 'application/json'}); response.end('{"ok":true}');
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('test_server_address');
    const response = await createLoopbackJsonFetch()(new URL(`http://127.0.0.1:${address.port}/heartbeat`), {
      method: 'POST', headers: {'content-type': 'application/json',
        'x-fai-deployment-lease-token': 'l'.repeat(32)}, body: '{}'
    });
    expect(response.status).toBe(200);
  });

  it('rejects remote hosts and unrelated headers', async () => {
    const fetcher = createLoopbackJsonFetch();
    await expect(fetcher(new URL('https://example.test/'), {method: 'POST'})).rejects.toThrow('request');
    await expect(fetcher(new URL('http://127.0.0.1:13000/'), {method: 'POST',
      headers: {'x-fai-runner-lease-token': 'x'.repeat(32)}})).rejects.toThrow('headers');
  });
});
