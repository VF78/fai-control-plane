import {createServer} from 'node:http';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createLoopbackJsonFetch, isNumericLoopbackHostname} from './loopback-json-fetch';

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe('bounded loopback JSON transport', () => {
  it('posts bounded JSON without Node global fetch', async () => {
    vi.stubGlobal('fetch', () => { throw new Error('global_fetch_must_not_run'); });
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        expect(request.method).toBe('POST');
        expect(request.headers.authorization).toBe('Bearer test-token');
        expect(Buffer.concat(chunks).toString('utf8')).toBe('{"ok":true}');
        response.writeHead(200, {'content-type': 'application/json'});
        response.end('{"accepted":true}');
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('test_server_address');
    const response = await createLoopbackJsonFetch()(new URL(`http://127.0.0.1:${address.port}/claim`), {
      method: 'POST', headers: {authorization: 'Bearer test-token', 'content-type': 'application/json'},
      body: '{"ok":true}'
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({accepted: true});
  });

  it('rejects non-loopback and unsupported request surfaces', async () => {
    const fetcher = createLoopbackJsonFetch();
    await expect(fetcher(new URL('https://example.com/'), {method: 'POST'})).rejects.toThrow('request');
    await expect(fetcher(new URL('http://localhost/'), {method: 'POST'})).rejects.toThrow('request');
    await expect(fetcher(new URL('http://127.0.0.1:13000/'), {
      method: 'POST', headers: {'x-unsupported': 'value'}
    })).rejects.toThrow('headers');
    expect(isNumericLoopbackHostname(new URL('http://127.0.0.1/').hostname)).toBe(true);
    expect(isNumericLoopbackHostname(new URL('http://[::1]/').hostname)).toBe(true);
  });
});
