import {createHash, createSign} from 'node:crypto';
import {cp, mkdir, open, readFile, rename, rm, chmod, stat, unlink} from 'node:fs/promises';
import {createServer, request as httpRequest} from 'node:http';
import {spawn} from 'node:child_process';
import {dirname, join, resolve, sep} from 'node:path';
import type {RepositoryWorkFailure, RepositoryWorkPort} from '@fai-control-plane/domain';

type Fetch = typeof globalThis.fetch;
type PrepareInput = Parameters<RepositoryWorkPort['prepare']>[0];
type PublishInput = Parameters<RepositoryWorkPort['publishReview']>[0];
type Authorization = Readonly<{
  projectId: string; receiptReference: string; repository: Readonly<{id: string; url: string}>;
  issueNumber: number; base: Readonly<{ref: string; sha: string}>;
}>;
type Metadata = Authorization & Readonly<{contract: 'fai.repository-work.v1'; workReference: string;
  workspacePath: string; reviewRef: string}>;

const bounded = (value: unknown, max = 2_048): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0');
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const safeMessage = (value: string): string => value.replace(/[\0\r\n]/g, ' ').slice(0, 240) || 'Repository operation blocked';
const blocked = (code: RepositoryWorkFailure['code'], message: string): RepositoryWorkFailure =>
  ({status: 'blocked', code, message: safeMessage(message)});
const retry = (code: RepositoryWorkFailure['code'], message: string, retryAfterSeconds = 30): RepositoryWorkFailure =>
  ({status: 'retry', code, message: safeMessage(message), retryAfterSeconds});
const branchComponent = (receipt: string): string => createHash('sha256').update(receipt).digest('hex').slice(0, 24);

const parseGitHubRepository = (url: string): Readonly<{owner: string; repository: string}> | null => {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})$/.exec(url);
  return match?.[1] !== undefined && match[2] !== undefined ? {owner: match[1], repository: match[2]} : null;
};

const execute = (command: string, args: readonly string[], options: Readonly<{cwd?: string; env?: NodeJS.ProcessEnv}> = {}):
  Promise<string> => new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {cwd: options.cwd, env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe']});
    const output: Buffer[] = []; const errors: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => { if (Buffer.concat(output).byteLength < 16_384) output.push(chunk); });
    child.stderr.on('data', (chunk: Buffer) => { if (Buffer.concat(errors).byteLength < 16_384) errors.push(chunk); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolvePromise(Buffer.concat(output).toString('utf8').trim())
      : reject(new Error(`repository_git_failed:${code ?? 'unknown'}`)));
  });

const gitEnvironment = (token: string): NodeJS.ProcessEnv => ({
  NODE_ENV: process.env.NODE_ENV ?? 'production',
  PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: '/nonexistent',
  GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_PROTOCOL_FROM_USER: '0', GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
  GIT_CONFIG_KEY_1: 'http.https://github.com/.extraheader',
  GIT_CONFIG_VALUE_1: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`
});
const untrustedGitEnvironment = (): NodeJS.ProcessEnv => ({
  NODE_ENV: process.env.NODE_ENV ?? 'production',
  PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: '/nonexistent',
  GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_PROTOCOL_FROM_USER: '0'
});

export const createGitHubAppTokenProvider = (input: Readonly<{appId: string; installationId: string;
  privateKeyFile: string; fetch?: Fetch}>): Readonly<{token(): Promise<string>}> => {
  if (!/^[1-9][0-9]{0,19}$/.test(input.appId) || !/^[1-9][0-9]{0,19}$/.test(input.installationId) ||
    !input.privateKeyFile.startsWith('/')) throw new Error('github_app_configuration_invalid');
  const request = input.fetch ?? globalThis.fetch;
  return {async token() {
    const privateKey = await readFile(input.privateKeyFile, 'utf8');
    if (privateKey.length < 256 || privateKey.length > 65_536) throw new Error('github_app_key_invalid');
    const now = Math.floor(Date.now() / 1_000);
    const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${encode({alg: 'RS256', typ: 'JWT'})}.${encode({iat: now - 30, exp: now + 540, iss: input.appId})}`;
    const jwt = `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(privateKey, 'base64url')}`;
    const response = await request(`https://api.github.com/app/installations/${input.installationId}/access_tokens`, {
      method: 'POST', headers: {accept: 'application/vnd.github+json', authorization: `Bearer ${jwt}`,
        'user-agent': 'fai-repository-broker/1', 'x-github-api-version': '2022-11-28'},
      signal: AbortSignal.timeout(10_000)
    });
    const payload = response.ok ? object(await response.json()) : null;
    if (!bounded(payload?.token, 65_536)) throw new Error('github_app_token_failed');
    return payload.token;
  }};
};

export const createControlPlaneRepositoryAuthorization = (input: Readonly<{endpoint: string; tokenFile: string;
  fetch?: Fetch}>): Readonly<{authorize(value: PrepareInput): Promise<Authorization | RepositoryWorkFailure>}> => ({
  async authorize(value) {
    try {
      const bridgeToken = (await readFile(input.tokenFile, 'utf8')).trim();
      if (!bounded(bridgeToken, 512) || !input.endpoint.startsWith('https://')) return blocked('authorization_denied', 'Repository bridge is not configured');
      const response = await (input.fetch ?? globalThis.fetch)(input.endpoint, {method: 'POST',
        headers: {authorization: `Bearer ${bridgeToken}`, 'content-type': 'application/json'},
        body: JSON.stringify(value), signal: AbortSignal.timeout(10_000)});
      if (response.status === 401 || response.status === 403 || response.status === 409) {
        return blocked('authorization_denied', 'Control Plane denied repository work');
      }
      if (!response.ok) return retry('bridge_unavailable', 'Control Plane repository validation is unavailable');
      const payload = object(await response.json());
      const repository = object(payload?.repository); const base = object(payload?.base);
      if (payload?.projectId !== value.projectId || payload.receiptReference !== value.receiptReference ||
        repository?.id !== value.repository.id || repository.url !== value.repository.url ||
        payload?.issueNumber !== value.issueNumber || base?.ref !== value.base.ref || base.sha !== value.base.sha) {
        return blocked('binding_mismatch', 'Control Plane repository authorization did not match the request');
      }
      return value;
    } catch {
      return retry('bridge_unavailable', 'Control Plane repository validation is unavailable');
    }
  }
});

export const createGitHubAppRepositoryBroker = (input: Readonly<{root: string;
  stateRoot: string;
  authorize(value: PrepareInput): Promise<Authorization | RepositoryWorkFailure>;
  token(): Promise<string>; fetch?: Fetch;
  execute?: typeof execute}>): RepositoryWorkPort => {
  const root = resolve(input.root); const stateRoot = resolve(input.stateRoot);
  if (root === stateRoot || stateRoot.startsWith(`${root}${sep}`)) throw new Error('repository_broker_state_invalid');
  const request = input.fetch ?? globalThis.fetch; const run = input.execute ?? execute;
  const metadataPath = (workReference: string): string => join(stateRoot, `${workReference}.json`);
  const readMetadata = async (workReference: string): Promise<Metadata | null> => {
    try { return JSON.parse(await readFile(metadataPath(workReference), 'utf8')) as Metadata; } catch { return null; }
  };
  const withLock = async <T>(workReference: string, operation: () => Promise<T>): Promise<T | RepositoryWorkFailure> => {
    await mkdir(stateRoot, {recursive: true, mode: 0o700});
    const lockPath = join(stateRoot, `${workReference}.lock`); let lock: Awaited<ReturnType<typeof open>> | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try { lock = await open(lockPath, 'wx', 0o600); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const age = Date.now() - (await stat(lockPath)).mtimeMs;
        if (age <= 120_000 || attempt > 0) return retry('checkout_busy', 'Repository workspace is busy', 5);
        await unlink(lockPath).catch(() => undefined);
      }
    }
    if (lock === null) return retry('checkout_busy', 'Repository workspace is busy', 5);
    try { return await operation(); }
    finally { await lock.close(); await unlink(lockPath).catch(() => undefined); }
  };
  const api = async (token: string, url: string, init: RequestInit = {}): Promise<Response> => request(url, {...init,
    headers: {accept: 'application/vnd.github+json', authorization: `Bearer ${token}`,
      'content-type': 'application/json', 'user-agent': 'fai-repository-broker/1',
      'x-github-api-version': '2022-11-28'}, signal: AbortSignal.timeout(10_000)});
  return {
    async prepare(value) {
      if (!bounded(value.projectId, 256) || !bounded(value.receiptReference, 256) ||
        !bounded(value.repository.id, 256) || parseGitHubRepository(value.repository.url) === null ||
        !Number.isSafeInteger(value.issueNumber) || value.issueNumber <= 0 || value.issueNumber > 2_147_483_647 ||
        !/^refs\/heads\/[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,198}[A-Za-z0-9])?$/.test(value.base.ref) ||
        value.base.ref.includes('..') || value.base.ref.endsWith('.lock') || !sha(value.base.sha)) {
        return blocked('policy_denied', 'Repository request is outside policy');
      }
      const authorization = await input.authorize(value);
      if ('status' in authorization) return authorization;
      const workReference = createHash('sha256').update(JSON.stringify(authorization)).digest('hex');
      const workspacePath = join(root, workReference); const reviewRef = `refs/heads/fai/${value.issueNumber}/${branchComponent(value.receiptReference)}`;
      if (!workspacePath.startsWith(`${root}${sep}`)) return blocked('checkout_invalid', 'Repository workspace is invalid');
      return withLock(workReference, async () => {
        const existing = await readMetadata(workReference);
        if (existing !== null) {
          const expectedHash = createHash('sha256').update(JSON.stringify({projectId: existing.projectId,
            receiptReference: existing.receiptReference, repository: existing.repository,
            issueNumber: existing.issueNumber, base: existing.base})).digest('hex');
          if (expectedHash !== workReference || existing.workspacePath !== workspacePath ||
            existing.repository.url !== value.repository.url || existing.base.sha !== value.base.sha ||
            existing.reviewRef !== reviewRef) return blocked('checkout_invalid', 'Existing repository workspace does not match the receipt');
          try {
            const origin = await run('git', ['remote', 'get-url', 'origin'], {cwd: workspacePath});
            if (origin !== value.repository.url) return blocked('binding_mismatch', 'Existing checkout has another origin');
            return {status: 'prepared' as const, workReference, workspacePath, reviewRef};
          } catch {
            let changes = '';
            try { changes = await run('git', ['status', '--porcelain'], {cwd: workspacePath}); } catch { /* damaged cache */ }
            if (changes.length > 0) return blocked('checkout_invalid', 'Damaged checkout contains uncommitted changes');
            await rename(workspacePath, `${workspacePath}.invalid-${Date.now()}`).catch(() => undefined);
            await unlink(metadataPath(workReference)).catch(() => undefined);
          }
        }
        const temporary = join(stateRoot, `${workReference}.preparing`);
        try {
        await mkdir(root, {recursive: true, mode: 0o700});
        await rm(temporary, {recursive: true, force: true});
        await mkdir(temporary, {mode: 0o700});
        const token = await input.token(); const env = gitEnvironment(token);
        await run('git', ['init', '--initial-branch', 'fai-unborn'], {cwd: temporary});
        await run('git', ['remote', 'add', 'origin', value.repository.url], {cwd: temporary});
        await run('git', ['fetch', '--no-tags', '--depth=1', 'origin', value.base.sha], {cwd: temporary, env});
        const fetched = await run('git', ['rev-parse', 'FETCH_HEAD'], {cwd: temporary});
        if (fetched !== value.base.sha) return blocked('base_mismatch', 'GitHub base revision did not match authorization');
        await run('git', ['checkout', '--detach', value.base.sha], {cwd: temporary});
        await run('git', ['checkout', '-b', reviewRef.slice('refs/heads/'.length)], {cwd: temporary});
        const metadata: Metadata = {...authorization, contract: 'fai.repository-work.v1', workReference, workspacePath, reviewRef};
        const file = await open(metadataPath(workReference), 'wx', 0o600);
        await file.writeFile(`${JSON.stringify(metadata)}\n`); await file.close();
        await cp(temporary, workspacePath, {recursive: true, errorOnExist: true, force: false});
        await rm(temporary, {recursive: true, force: true}); await chmod(workspacePath, 0o700);
        return {status: 'prepared', workReference, workspacePath, reviewRef};
      } catch (error) {
        await rm(temporary, {recursive: true, force: true}).catch(() => undefined);
          return retry('github_unavailable', error instanceof Error ? error.message : 'GitHub checkout failed');
        }
      });
    },
    async publishReview(value) {
      if (!/^[a-f0-9]{64}$/.test(value.workReference) || !bounded(value.receiptReference, 256) ||
        !sha(value.headSha) || !bounded(value.title, 240) || !bounded(value.body, 8_000)) {
        return blocked('policy_denied', 'Review publication request is outside policy');
      }
      return withLock(value.workReference, async () => {
      const metadata = await readMetadata(value.workReference);
      if (metadata === null || metadata.receiptReference !== value.receiptReference ||
        metadata.workspacePath !== join(root, value.workReference) ||
        createHash('sha256').update(JSON.stringify({projectId: metadata.projectId,
          receiptReference: metadata.receiptReference, repository: metadata.repository,
          issueNumber: metadata.issueNumber, base: metadata.base})).digest('hex') !== value.workReference ||
        metadata.reviewRef !== `refs/heads/fai/${metadata.issueNumber}/${branchComponent(value.receiptReference)}`) {
        return blocked('authorization_denied', 'Repository receipt is not prepared');
      }
      const repository = parseGitHubRepository(metadata.repository.url);
      if (repository === null) return blocked('binding_mismatch', 'Repository binding is invalid');
      try {
        if (value.headSha === metadata.base.sha) return blocked('change_missing', 'No repository change is available for review');
        // Never expose an App token to the executor-writable checkout or its
        // .git/config. Export objects without credentials, then validate and
        // publish only from a new broker-owned bare repository.
        const publicationRoot = join(stateRoot, `${value.workReference}.publishing`);
        const bundlePath = join(publicationRoot, 'executor.bundle');
        const trustedRepository = join(publicationRoot, 'trusted.git');
        await rm(publicationRoot, {recursive: true, force: true});
        await mkdir(publicationRoot, {recursive: true, mode: 0o700});
        try {
          await run('git', ['bundle', 'create', bundlePath, 'HEAD'],
            {cwd: metadata.workspacePath, env: untrustedGitEnvironment()});
          const bundle = await stat(bundlePath);
          if (!bundle.isFile() || bundle.size <= 0 || bundle.size > 104_857_600) {
            return blocked('checkout_invalid', 'Executor repository bundle is invalid');
          }
          await mkdir(trustedRepository, {mode: 0o700});
          await run('git', ['init', '--bare'], {cwd: trustedRepository, env: untrustedGitEnvironment()});
          const token = await input.token(); const trustedEnv = gitEnvironment(token);
          await run('git', ['fetch', '--no-tags', '--depth=1', metadata.repository.url, metadata.base.sha],
            {cwd: trustedRepository, env: trustedEnv});
          await run('git', ['fetch', '--no-tags', bundlePath, 'HEAD'],
            {cwd: trustedRepository, env: untrustedGitEnvironment()});
          const imported = await run('git', ['rev-parse', 'FETCH_HEAD'],
            {cwd: trustedRepository, env: untrustedGitEnvironment()});
          if (imported !== value.headSha) return blocked('checkout_invalid', 'Executor revision did not match the requested HEAD');
          await run('git', ['merge-base', '--is-ancestor', metadata.base.sha, value.headSha],
            {cwd: trustedRepository, env: untrustedGitEnvironment()});
        const encodedRef = encodeURIComponent(metadata.reviewRef);
        const refResponse = await api(token, `https://api.github.com/repos/${repository.owner}/${repository.repository}/git/ref/${encodedRef}`);
        if (refResponse.ok) {
          const remoteSha = object(object(await refResponse.json())?.object)?.sha;
          if (remoteSha !== value.headSha) return blocked('policy_denied', 'Review branch already exists at another revision');
        } else if (refResponse.status === 404) {
          await run('git', ['push', metadata.repository.url, `${value.headSha}:${metadata.reviewRef}`],
            {cwd: trustedRepository, env: trustedEnv});
        } else return retry('github_unavailable', 'GitHub review branch is unavailable');
        const head = `${repository.owner}:${metadata.reviewRef.slice('refs/heads/'.length)}`;
        const baseBranch = metadata.base.ref.slice('refs/heads/'.length);
        const pulls = await api(token, `https://api.github.com/repos/${repository.owner}/${repository.repository}/pulls?state=open&head=${encodeURIComponent(head)}&base=${encodeURIComponent(baseBranch)}&per_page=2`);
        if (!pulls.ok) return retry('github_unavailable', 'GitHub pull request lookup failed');
        const listed = await pulls.json() as unknown;
        let pull = Array.isArray(listed) && listed.length === 1 ? object(listed[0]) : null;
        if (Array.isArray(listed) && listed.length > 1) return blocked('response_invalid', 'GitHub returned multiple review requests');
        if (pull === null) {
          const created = await api(token, `https://api.github.com/repos/${repository.owner}/${repository.repository}/pulls`, {
            method: 'POST', body: JSON.stringify({title: value.title, body: value.body,
              head: metadata.reviewRef.slice('refs/heads/'.length), base: baseBranch, maintainer_can_modify: false})});
          if (!created.ok) return retry('github_unavailable', 'GitHub pull request creation failed');
          pull = object(await created.json());
        }
        const pullUrl = pull?.html_url; const branchUrl = `${metadata.repository.url}/tree/${encodeURIComponent(metadata.reviewRef.slice(11))}`;
        if (!bounded(pullUrl) || !/^https:\/\/github\.com\//.test(pullUrl)) return blocked('response_invalid', 'GitHub pull request response is invalid');
        return {status: 'published', workReference: value.workReference, reviewRef: metadata.reviewRef,
          deliverables: [{label: 'branch', url: branchUrl}, {label: 'pull_request', url: pullUrl}]};
        } finally { await rm(publicationRoot, {recursive: true, force: true}).catch(() => undefined); }
      } catch (error) {
        return retry('github_unavailable', error instanceof Error ? error.message : 'GitHub publication failed');
      }
      });
    }
  };
};

export const createRepositoryWorkSocketAdapter = (socketPath: string): RepositoryWorkPort => {
  const call = <T>(operation: 'prepare' | 'publishReview', payload: unknown): Promise<T> => new Promise((resolvePromise, reject) => {
    const body = JSON.stringify({operation, payload});
    const request = httpRequest({socketPath, path: '/', method: 'POST', headers: {'content-type': 'application/json',
      'content-length': Buffer.byteLength(body)}}, (response) => {
      const chunks: Buffer[] = []; response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        try { resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T); } catch { reject(new Error('repository_broker_response_invalid')); }
      });
    });
    request.setTimeout(15_000, () => request.destroy(new Error('repository_broker_timeout')));
    request.on('error', reject); request.end(body);
  });
  return {prepare: (value) => call('prepare', value), publishReview: (value) => call('publishReview', value)};
};

export const serveRepositoryBroker = async (input: Readonly<{socketPath: string; port: RepositoryWorkPort}>): Promise<void> => {
  if (!input.socketPath.startsWith('/')) throw new Error('repository_broker_socket_invalid');
  await mkdir(dirname(input.socketPath), {recursive: true, mode: 0o700}); await rm(input.socketPath, {force: true});
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/') { response.writeHead(405).end(); return; }
    const chunks: Buffer[] = []; let size = 0;
    request.on('data', (chunk: Buffer) => { size += chunk.byteLength; if (size <= 32_000) chunks.push(chunk); });
    request.on('end', async () => {
      try {
        if (size === 0 || size > 32_000) throw new Error('body_invalid');
        const envelope = object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        const result = envelope?.operation === 'prepare' ? await input.port.prepare(envelope.payload as PrepareInput)
          : envelope?.operation === 'publishReview' ? await input.port.publishReview(envelope.payload as PublishInput)
          : blocked('policy_denied', 'Repository broker operation is not allowed');
        response.writeHead(200, {'content-type': 'application/json', 'cache-control': 'no-store'}).end(JSON.stringify(result));
      } catch { response.writeHead(400, {'content-type': 'application/json'}).end(JSON.stringify(blocked('response_invalid', 'Repository broker request is invalid'))); }
    });
  });
  await new Promise<void>((resolvePromise, reject) => { server.once('error', reject); server.listen(input.socketPath, resolvePromise); });
  await chmod(input.socketPath, 0o660);
};
