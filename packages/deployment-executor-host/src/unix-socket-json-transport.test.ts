import {createServer} from 'node:http';
import {chmod, lstat, mkdtemp, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createUnixSocketJsonTransport} from './unix-socket-json-transport';

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(servers.splice(0).map((server) =>
    new Promise<void>((resolve) => server.close(() => resolve()))));
});

const fixture = async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'fai-deployment-socket-')));
  await chmod(directory, 0o755);
  const directoryStat = await lstat(directory);
  const socketPath = path.join(directory, 'control.sock');
  const server = createServer((request, response) => {
    expect(request.headers.authorization).toBe('Bearer ' + 't'.repeat(32));
    expect(request.headers['x-fai-deployment-lease-token']).toBe('l'.repeat(32));
    response.writeHead(200, {'content-type': 'application/json'}); response.end('{"ok":true}');
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => { server.off('error', reject); resolve(); });
  });
  await chmod(socketPath, 0o660);
  const socketStat = await lstat(socketPath);
  return {directory, directoryStat, socketPath, socketStat, transport: createUnixSocketJsonTransport({
    socketPath, expectedSocketUid: socketStat.uid, expectedSocketGid: socketStat.gid,
    trustedDirectoryUid: directoryStat.uid, trustedDirectoryGid: directoryStat.gid
  })};
};

describe('deployment executor Unix-socket transport', () => {
  it('posts bounded JSON only through the owner-bound socket', async () => {
    vi.stubGlobal('fetch', () => { throw new Error('global_fetch_must_not_run'); });
    vi.stubGlobal('Response', class { constructor() { throw new Error('global_response_must_not_run'); } });
    const {transport} = await fixture();
    const response = await transport.post('/api/deployment-executor/heartbeat', {
      authorization: 'Bearer ' + 't'.repeat(32), 'content-type': 'application/json',
      'x-fai-deployment-lease-token': 'l'.repeat(32)
    }, '{}');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ok: true});
  });

  it('rejects a local squatter socket, unsafe permissions, and unrelated headers', async () => {
    const value = await fixture();
    const wrongOwner = createUnixSocketJsonTransport({socketPath: value.socketPath,
      expectedSocketUid: value.socketStat.uid + 1, expectedSocketGid: value.socketStat.gid,
      trustedDirectoryUid: value.directoryStat.uid, trustedDirectoryGid: value.directoryStat.gid});
    await expect(wrongOwner.preflight()).rejects.toThrow('socket_binding');
    await chmod(value.directory, 0o777);
    await expect(value.transport.preflight()).rejects.toThrow('socket_directory_binding');
    await chmod(value.directory, 0o755);
    await chmod(value.socketPath, 0o666);
    await expect(value.transport.preflight()).rejects.toThrow('socket_binding');
    await chmod(value.socketPath, 0o660);
    await expect(value.transport.post('/api/deployment-executor/claim', {
      authorization: 'Bearer ' + 't'.repeat(32), 'x-untrusted': 'value'
    })).rejects.toThrow('headers');
  });
});
