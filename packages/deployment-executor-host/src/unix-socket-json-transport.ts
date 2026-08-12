import {lstat, realpath} from 'node:fs/promises';
import path from 'node:path';

// Node 22's ESM facade enumerates lazy node:http WebSocket exports and initializes
// undici. Accessing the fixed built-in module loads only the HTTP request API,
// which remains compatible with the executor's required --jitless boundary.
const nodeHttp = process.getBuiltinModule('node:http') as typeof import('node:http') | undefined;
if (nodeHttp === undefined) throw new Error('deployment_executor_transport_http_unavailable');
const httpRequest = nodeHttp.request;

const ENDPOINTS = new Set([
  '/api/deployment-executor/claim',
  '/api/deployment-executor/heartbeat',
  '/api/deployment-executor/complete'
]);
const ALLOWED_HEADERS = new Set(['authorization', 'content-type', 'x-fai-deployment-lease-token']);
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const TIMEOUT_MS = 15_000;
const SOCKET_MODE = 0o660;
const DIRECTORY_MODE = 0o770;
const fail = (code: string): never => { throw new Error(`deployment_executor_transport_${code}`); };

export type DeploymentExecutorEndpoint =
  | '/api/deployment-executor/claim'
  | '/api/deployment-executor/heartbeat'
  | '/api/deployment-executor/complete';

export interface DeploymentExecutorTransport {
  preflight(): Promise<void>;
  post(endpoint: DeploymentExecutorEndpoint, headers: Readonly<Record<string, string>>,
    body?: string): Promise<Response>;
}

export type UnixSocketTransportOptions = Readonly<{
  socketPath: string;
  expectedSocketUid: number;
  expectedSocketGid: number;
  trustedDirectoryUid: number;
  trustedDirectoryGid: number;
}>;

const absoluteSocketPath = (value: string): string => {
  if (!path.isAbsolute(value) || path.normalize(value) !== value || path.resolve(value) !== value ||
    value === path.parse(value).root || value.includes('\0')) fail('socket_path');
  return value;
};

const identity = (value: number, code: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
};

const requestHeaders = (value: Readonly<Record<string, string>>): Record<string, string> => {
  if (Object.getPrototypeOf(value) !== Object.prototype) return fail('headers');
  const result: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(value)) {
    const name = rawName.toLowerCase();
    if (!ALLOWED_HEADERS.has(name) || typeof rawValue !== 'string' || rawValue.length > 512 ||
      /[\r\n]/.test(rawValue)) return fail('headers');
    result[name] = rawValue;
  }
  return result;
};

export const createUnixSocketJsonTransport = (
  options: UnixSocketTransportOptions
): DeploymentExecutorTransport => {
  const socketPath = absoluteSocketPath(options.socketPath);
  const directory = path.dirname(socketPath);
  const expectedSocketUid = identity(options.expectedSocketUid, 'socket_uid');
  const expectedSocketGid = identity(options.expectedSocketGid, 'socket_gid');
  const trustedDirectoryUid = identity(options.trustedDirectoryUid, 'directory_uid');
  const trustedDirectoryGid = identity(options.trustedDirectoryGid, 'directory_gid');

  const preflight = async () => {
    const [directoryStat, canonicalDirectory] = await Promise.all([lstat(directory), realpath(directory)]);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || canonicalDirectory !== directory ||
      directoryStat.uid !== trustedDirectoryUid || directoryStat.gid !== trustedDirectoryGid ||
      (directoryStat.mode & 0o7777) !== DIRECTORY_MODE) fail('socket_directory_binding');
    const [socketStat, canonicalSocket] = await Promise.all([lstat(socketPath), realpath(socketPath)]);
    if (!socketStat.isSocket() || socketStat.isSymbolicLink() || canonicalSocket !== socketPath ||
      socketStat.uid !== expectedSocketUid || socketStat.gid !== expectedSocketGid ||
      (socketStat.mode & 0o7777) !== SOCKET_MODE) fail('socket_binding');
  };

  const transport: DeploymentExecutorTransport = {preflight, async post(endpoint, rawHeaders, body = '') {
    if (!ENDPOINTS.has(endpoint)) return fail('endpoint');
    if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) return fail('request_size');
    const headers = requestHeaders(rawHeaders);
    await preflight();
    return new Promise<Response>((resolve, reject) => {
      const request = httpRequest({socketPath, path: endpoint, method: 'POST', headers: {...headers,
        'content-length': String(Buffer.byteLength(body))}}, (response) => {
        const chunks: Buffer[] = []; let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > MAX_RESPONSE_BYTES) {
            response.destroy(new Error('deployment_executor_transport_response_size')); return;
          }
          chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          const payload = Buffer.concat(chunks).toString('utf8');
          resolve(Object.freeze({
            status: response.statusCode ?? 500,
            json: async (): Promise<unknown> => JSON.parse(payload) as unknown
          }) as unknown as Response);
        });
      });
      request.on('error', reject);
      request.setTimeout(TIMEOUT_MS, () => request.destroy(new Error('deployment_executor_transport_timeout')));
      request.end(body);
    });
  }};
  return Object.freeze(transport);
};
