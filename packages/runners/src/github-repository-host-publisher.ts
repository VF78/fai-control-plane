import {spawn} from 'node:child_process';
import path from 'node:path';
import type {OpaqueSecretRef, SecretsProvider} from '@fai-control-plane/domain';
import type {
  RepositoryHostPublicationReceipt,
  RepositoryHostPublisher,
  RepositoryHostPublishDraftChangeInput
} from './repository-host-publisher';

const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REPOSITORY_PART_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const SAFE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,191}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[0-9a-f]{64}$/;
const DEFAULT_API_BASE_URL = 'https://api.github.com';

export type RepositoryHostProcessRequest = Readonly<{
  executable: 'git';
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
}>;

export type RepositoryHostProcessExecutor = (
  request: RepositoryHostProcessRequest
) => Promise<Readonly<{exitCode: number}>>;

type FetchLike = typeof fetch;

export type GitHubRepositoryHostPublisherOptions = Readonly<{
  repositoryTarget: string;
  owner: string;
  repository: string;
  repositoryRoot: string;
  credentialRef: OpaqueSecretRef;
  secrets: SecretsProvider;
  environment: Readonly<Record<string, string>>;
  process?: RepositoryHostProcessExecutor;
  fetch?: FetchLike;
  apiBaseUrl?: string;
}>;

const failed = (
  reason: Extract<RepositoryHostPublicationReceipt, {status: 'failed'}>['reason']
): RepositoryHostPublicationReceipt => ({status: 'failed', reason});

const safeRef = (value: string): boolean =>
  SAFE_REF_PATTERN.test(value) &&
  !value.includes('//') &&
  !value.split('/').some((part) => part === '.' || part === '..');

const validInput = (
  input: RepositoryHostPublishDraftChangeInput,
  repositoryTarget: string
): boolean =>
  input.repositoryTarget === repositoryTarget &&
  COMMIT_PATTERN.test(input.baseCommit) &&
  COMMIT_PATTERN.test(input.headCommit) &&
  input.baseCommit !== input.headCommit &&
  safeRef(input.baseRef) &&
  /^fai\/run\//.test(input.branch) &&
  UUID_PATTERN.test(input.branch.slice('fai/run/'.length)) &&
  input.title.length >= 1 && input.title.length <= 128 &&
  input.body.length >= 1 && input.body.length <= 4_096 &&
  !input.title.includes('\0') && !input.body.includes('\0') &&
  IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey);

const parseApiBaseUrl = (value: string): URL => {
  const parsed = new URL(value);
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new Error('github_repository_host_invalid_api_base_url');
  }
  return parsed;
};

const nodeProcessExecutor: RepositoryHostProcessExecutor = async (
  request
): Promise<Readonly<{exitCode: number}>> => new Promise((resolve) => {
  const child = spawn(request.executable, [...request.args], {
    cwd: request.cwd,
    env: {...request.env} as NodeJS.ProcessEnv,
    shell: false,
    stdio: 'ignore'
  });
  child.once('error', () => resolve({exitCode: 1}));
  child.once('close', (exitCode) => resolve({exitCode: exitCode ?? 1}));
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const externalChange = (
  value: unknown,
  owner: string,
  repository: string,
  headCommit?: string
): Extract<RepositoryHostPublicationReceipt, {status: 'published'}> | undefined => {
  if (!isRecord(value)) return undefined;
  const number = value.number;
  const htmlUrl = value.html_url;
  const head = value.head;
  if (
    typeof number !== 'number' ||
    !Number.isSafeInteger(number) ||
    number < 1 ||
    typeof htmlUrl !== 'string' ||
    value.draft !== true ||
    !isRecord(head) ||
    typeof head.sha !== 'string' ||
    !COMMIT_PATTERN.test(head.sha) ||
    (headCommit !== undefined && head.sha !== headCommit)
  ) {
    return undefined;
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(htmlUrl);
  } catch {
    return undefined;
  }
  if (
    parsedUrl.origin !== 'https://github.com' ||
    parsedUrl.pathname !== `/${owner}/${repository}/pull/${number}` ||
    parsedUrl.search !== '' ||
    parsedUrl.hash !== ''
  ) {
    return undefined;
  }
  return {
    status: 'published',
    externalChangeRef: String(number),
    externalChangeUrl: parsedUrl.toString(),
    externalChangeStatus: 'draft'
  };
};

export const createGitHubRepositoryHostPublisher = (
  options: GitHubRepositoryHostPublisherOptions
): RepositoryHostPublisher => {
  if (
    options.repositoryTarget.length === 0 ||
    !REPOSITORY_PART_PATTERN.test(options.owner) ||
    !REPOSITORY_PART_PATTERN.test(options.repository) ||
    !path.isAbsolute(options.repositoryRoot) ||
    path.normalize(options.repositoryRoot) !== options.repositoryRoot ||
    options.repositoryRoot === path.parse(options.repositoryRoot).root ||
    options.credentialRef.provider.length === 0 ||
    options.credentialRef.reference.length === 0 ||
    options.credentialRef.reference.includes('\0') ||
    options.credentialRef.scope.length === 0
  ) {
    throw new Error('github_repository_host_invalid_configuration');
  }
  const apiBaseUrl = parseApiBaseUrl(options.apiBaseUrl ?? DEFAULT_API_BASE_URL);
  const processExecutor = options.process ?? nodeProcessExecutor;
  const fetcher = options.fetch ?? fetch;
  const remoteUrl = `https://github.com/${options.owner}/${options.repository}.git`;

  return {
    async publishDraftChange(input) {
      if (!validInput(input, options.repositoryTarget)) {
        return failed('invalid_host_response');
      }
      let token: string;
      try {
        token = (await options.secrets.resolve(
          options.credentialRef,
          'repository_host_publish_draft_change'
        )).value;
      } catch {
        return failed('credential_unavailable');
      }
      if (
        token.length < 20 ||
        token.length > 1_024 ||
        token.includes('\0') ||
        token.includes('\n') ||
        token.includes('\r')
      ) {
        return failed('credential_unavailable');
      }

      const headers = {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-github-api-version': '2022-11-28'
      };
      const pullsPath = `/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repository)}/pulls`;
      const lookupUrl = new URL(pullsPath, apiBaseUrl);
      lookupUrl.searchParams.set('state', 'open');
      lookupUrl.searchParams.set('head', `${options.owner}:${input.branch}`);
      lookupUrl.searchParams.set('base', input.baseRef);
      let lookup: Response;
      try {
        lookup = await fetcher(lookupUrl, {method: 'GET', headers});
      } catch {
        return failed('change_lookup_failed');
      }
      if (!lookup.ok) return failed('change_lookup_failed');
      let existing: unknown;
      try {
        existing = await lookup.json();
      } catch {
        return failed('invalid_host_response');
      }
      if (!Array.isArray(existing)) return failed('invalid_host_response');
      let existingDraft:
        | Extract<RepositoryHostPublicationReceipt, {status: 'published'}>
        | undefined;
      if (existing.length > 0) {
        existingDraft = externalChange(
          existing[0],
          options.owner,
          options.repository
        );
        if (existingDraft === undefined) {
          return failed('existing_change_not_draft');
        }
      }

      const authorization = `Basic ${Buffer.from(`x-access-token:${token}`)
        .toString('base64')}`;
      const push = await processExecutor({
        executable: 'git',
        args: [
          'push',
          '--no-verify',
          remoteUrl,
          `${input.headCommit}:refs/heads/${input.branch}`
        ],
        cwd: options.repositoryRoot,
        env: {
          ...options.environment,
          GIT_TERMINAL_PROMPT: '0',
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
          GIT_CONFIG_VALUE_0: `Authorization: ${authorization}`
        }
      });
      if (push.exitCode !== 0) return failed('source_publish_failed');
      if (existingDraft !== undefined) return existingDraft;

      let created: Response;
      try {
        created = await fetcher(new URL(pullsPath, apiBaseUrl), {
          method: 'POST',
          headers,
          body: JSON.stringify({
            title: input.title,
            body: `${input.body}\n\n<!-- publication-idempotency-key:${input.idempotencyKey} -->`,
            head: input.branch,
            base: input.baseRef,
            draft: true,
            maintainer_can_modify: false
          })
        });
      } catch {
        return failed('change_create_failed');
      }
      if (created.status !== 201) return failed('change_create_failed');
      let value: unknown;
      try {
        value = await created.json();
      } catch {
        return failed('invalid_host_response');
      }
      return externalChange(
        value,
        options.owner,
        options.repository,
        input.headCommit
      ) ?? failed('invalid_host_response');
    }
  };
};
