import {createHash, createHmac} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {describe, expect, it, vi} from 'vitest';
import {
  trackerCheckStatuses,
  type SecretsProvider
} from '@fai-control-plane/domain';
import {
  createGitHubAppWebhookConfig,
  GitHubWebhookConfigError,
  MAX_GITHUB_WEBHOOK_BODY_BYTES,
  readGitHubWebhookBody,
  verifyAndProjectGitHubWebhook
} from './github-webhook';

const secret = "It's a Secret to Everybody";
const deliveryId = '123e4567-e89b-42d3-a456-426614174000';

const validConfigInput = {
  webhookSecretRef: {
    provider: 'test',
    reference: 'github-webhook-secret',
    scope: ['fai-control-plane']
  },
  scopes: [
    {
      repositoryId: 1278325372,
      fullName: 'VF78/MSA',
      ownerId: 75837222,
      installationId: 1001,
      projectId: '123e4567-e89b-42d3-a456-426614174000',
      projectNumber: 3,
      projectNodeId: 'PVT_kwHOBIUvJs4Bbefq'
    },
    {
      repositoryId: 1279114011,
      fullName: 'VF78/ascon',
      ownerId: 75837222,
      installationId: 1002,
      projectId: '123e4567-e89b-42d3-a456-426614174001',
      projectNumber: 4,
      projectNodeId: 'PVT_kwHOBIUvJs4Bbi0Q'
    }
  ]
} as const;

const config = createGitHubAppWebhookConfig(validConfigInput);

function body(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function signature(rawBody: Uint8Array, signingSecret = secret): string {
  return `sha256=${createHmac('sha256', signingSecret).update(rawBody).digest('hex')}`;
}

function headers(
  event: string,
  rawBody: Uint8Array,
  overrides: Record<string, string | undefined> = {}
): Record<string, string | undefined> {
  return {
    'x-github-delivery': deliveryId,
    'x-github-event': event,
    'x-hub-signature-256': signature(rawBody),
    'content-type': 'application/json; charset=utf-8',
    ...overrides
  };
}

function secrets(value = secret): SecretsProvider {
  return {resolve: async () => ({value})};
}

function repository(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1278325372,
    full_name: 'VF78/MSA',
    owner: {id: 75837222},
    ...overrides
  };
}

function standardPayload(event: 'issues' | 'pull_request' | 'check_run', action: string) {
  const shared = {action, installation: {id: 1001}, repository: repository()};
  if (event === 'issues') {
    return {...shared, issue: {id: 501, number: 42, state: 'open'}};
  }
  if (event === 'pull_request') {
    return {
      ...shared,
      pull_request: {
        id: 502,
        number: 43,
        state: 'open',
        merged: false,
        head: {ref: 'feature/github-webhook'},
        base: {ref: 'main'}
      }
    };
  }
  return {
    ...shared,
    check_run: {id: 503, status: 'completed', conclusion: 'success', head_sha: 'a'.repeat(40)}
  };
}

async function verify(event: string, value: unknown, options: {
  readonly rawBody?: Uint8Array;
  readonly requestHeaders?: unknown;
  readonly provider?: SecretsProvider;
} = {}) {
  const rawBody = options.rawBody ?? body(value);
  return verifyAndProjectGitHubWebhook({
    config,
    secrets: options.provider ?? secrets(),
    headers: (options.requestHeaders ?? headers(event, rawBody)) as Record<
      string,
      string | undefined
    >,
    body: rawBody
  });
}

describe('GitHub App repository webhook boundary', () => {
  it('verifies GitHub documentation HMAC bytes before parsing JSON', async () => {
    const rawBody = new TextEncoder().encode('Hello, World!');
    expect(signature(rawBody)).toBe(
      'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17'
    );

    await expect(verify('issues', {}, {rawBody})).resolves.toEqual({
      outcome: 'rejected',
      code: 'github_json_invalid'
    });
  });

  it('uses UTF-8 raw bytes for Unicode HMAC input', async () => {
    const unicodeSecret = 'secr\u00e9t-\u7f18\ud83d\udd11';
    const rawBody = new TextEncoder().encode('\u043f\u0440\u0438\u0432\u0435\u0442 \ud83d\udc4b');
    expect(signature(rawBody, unicodeSecret)).toBe(
      'sha256=eef32fb7dc13700068bb0bde080c48db645308f28d642638112d57b6870cf244'
    );

    await expect(
      verify('issues', {}, {
        rawBody,
        provider: secrets(unicodeSecret),
        requestHeaders: headers('issues', rawBody, {
          'x-hub-signature-256': signature(rawBody, unicodeSecret)
        })
      })
    ).resolves.toEqual({outcome: 'rejected', code: 'github_json_invalid'});
  });

  it.each([
    ['missing', undefined, 'github_signature_missing'],
    ['malformed', 'sha256=not-a-signature', 'github_signature_malformed'],
    ['incorrect', `sha256=${'0'.repeat(64)}`, 'github_signature_invalid']
  ])('rejects %s signatures without exposing them', async (_, suppliedSignature, code) => {
    const rawBody = body(standardPayload('issues', 'opened'));
    const result = await verify('issues', {}, {
      rawBody,
      requestHeaders: headers('issues', rawBody, {'x-hub-signature-256': suppliedSignature})
    });
    expect(result).toEqual({outcome: 'rejected', code});
    expect(JSON.stringify(result)).not.toContain('sha256=');
  });

  it('rejects non-JSON media types and unsupported user-owned Project events', async () => {
    const rawBody = body({});
    await expect(
      verify('issues', {}, {rawBody, requestHeaders: headers('issues', rawBody, {'content-type': 'text/plain'})})
    ).resolves.toEqual({outcome: 'rejected', code: 'github_media_type_invalid'});
    await expect(verify('projects_v2_item', {}, {rawBody})).resolves.toEqual({
      outcome: 'rejected',
      code: 'github_project_event_unsupported'
    });
  });

  it.each([
    'application/json',
    'APPLICATION/JSON',
    'application/json; charset=utf-8',
    'application/json ; CHARSET = UTF-8'
  ])('accepts the bounded JSON Content-Type %s', async (contentType) => {
    const value = standardPayload('issues', 'opened');
    const rawBody = body(value);
    const result = await verify('issues', value, {
      rawBody,
      requestHeaders: headers('issues', rawBody, {'content-type': contentType})
    });
    expect(result.outcome).toBe('accepted');
  });

  it.each([
    'application/json;',
    'application/json; boundary=x',
    'application/json; charset=us-ascii',
    'application/json; charset="utf-8"',
    'application/json; charset=utf-8; charset=utf-8',
    'application/json; charset=utf-8; version=1',
    'application/json charset=utf-8',
    'application/json\n',
    'application/json;\r\n charset=utf-8'
  ])('rejects malformed or extended JSON Content-Type %s', async (contentType) => {
    const rawBody = body({});
    await expect(
      verify('issues', {}, {
        rawBody,
        requestHeaders: headers('issues', rawBody, {'content-type': contentType})
      })
    ).resolves.toEqual({outcome: 'rejected', code: 'github_media_type_invalid'});
  });

  it('rejects header getters and proxy reflection traps without invoking accessors', async () => {
    const rawBody = body(standardPayload('issues', 'opened'));
    let getterCalls = 0;
    const getterHeaders = headers('issues', rawBody);
    Object.defineProperty(getterHeaders, 'content-type', {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error('must not run');
      }
    });
    await expect(
      verify('issues', {}, {rawBody, requestHeaders: getterHeaders})
    ).resolves.toEqual({outcome: 'rejected', code: 'github_headers_invalid'});
    expect(getterCalls).toBe(0);

    for (const trappedHeaders of [
      new Proxy(headers('issues', rawBody), {
        getPrototypeOf() {
          throw new Error('prototype trap');
        }
      }),
      new Proxy(headers('issues', rawBody), {
        ownKeys() {
          throw new Error('ownKeys trap');
        }
      }),
      new Proxy(headers('issues', rawBody), {
        getOwnPropertyDescriptor() {
          throw new Error('descriptor trap');
        }
      })
    ]) {
      await expect(
        verify('issues', {}, {rawBody, requestHeaders: trappedHeaders})
      ).resolves.toEqual({outcome: 'rejected', code: 'github_headers_invalid'});
    }
  });

  it('acknowledges signed ping without a persistence projection', async () => {
    await expect(verify('ping', {zen: 'ignored'})).resolves.toEqual({
      outcome: 'acknowledged',
      code: 'github_ping_acknowledged'
    });
  });

  it.each([
    ['issues', ['opened', 'edited', 'closed', 'reopened', 'labeled', 'unlabeled', 'assigned', 'unassigned', 'milestoned', 'demilestoned']],
    ['pull_request', ['opened', 'edited', 'closed', 'reopened', 'synchronize', 'ready_for_review', 'converted_to_draft']],
    ['check_run', ['created', 'completed', 'rerequested', 'requested_action']]
  ] as const)('accepts every allowed %s action', async (event, actions) => {
    for (const action of actions) {
      const result = await verify(event, standardPayload(event, action));
      expect(result.outcome).toBe('accepted');
      if (result.outcome === 'accepted') expect(result.projection.action).toBe(action);
    }
  });

  it.each(trackerCheckStatuses)('accepts the %s check-run status', async (status) => {
    const result = await verify('check_run', {
      ...standardPayload('check_run', 'created'),
      check_run: {
        id: 503,
        status,
        conclusion: 'success',
        head_sha: 'a'.repeat(40)
      }
    });

    expect(result).toMatchObject({
      outcome: 'accepted',
      projection: {eventType: 'check_run', checkRun: {status}}
    });
  });

  it('rejects an unknown check-run status', async () => {
    await expect(verify('check_run', {
      ...standardPayload('check_run', 'created'),
      check_run: {
        id: 503,
        status: 'unknown',
        conclusion: 'success',
        head_sha: 'a'.repeat(40)
      }
    })).resolves.toEqual({
      outcome: 'rejected',
      code: 'github_payload_invalid'
    });
  });

  it.each([
    ['added', 'repositories_added'],
    ['removed', 'repositories_removed']
  ] as const)('accepts the installation_repositories %s action', async (action, changeKey) => {
    const result = await verify('installation_repositories', {
      action,
      installation: {id: 1001},
      [changeKey]: [repository()]
    });
    expect(result.outcome).toBe('accepted');
  });

  it.each([
    ['issues', {action: 'deleted'}],
    ['pull_request', {action: 'merged'}],
    ['check_run', {action: 'updated'}],
    ['installation_repositories', {action: 'created'}]
  ])('rejects unknown %s actions', async (event, payload) => {
    const value =
      event === 'installation_repositories'
        ? {...payload, installation: {id: 1001}, repositories_added: [repository()]}
        : {...standardPayload(event as 'issues' | 'pull_request' | 'check_run', 'opened'), ...payload};
    await expect(verify(event, value)).resolves.toEqual({
      outcome: 'rejected',
      code: 'github_action_unsupported'
    });
  });

  it('rejects an allowed action with an unknown event shape', async () => {
    await expect(
      verify('issues', {action: 'opened', installation: {id: 1001}, repository: repository()})
    ).resolves.toEqual({outcome: 'rejected', code: 'github_payload_invalid'});
  });

  it('requires the configured installation, repository ID, full name, and owner ID', async () => {
    for (const [key, replacement, expectedCode] of [
      ['installation', {id: 9999}, 'github_installation_unauthorized'],
      ['repository', repository({id: 1}), 'github_repository_unauthorized'],
      ['repository', repository({full_name: 'VF78/renamed'}), 'github_repository_unauthorized'],
      ['repository', repository({owner: {id: 1}}), 'github_repository_unauthorized']
    ] as const) {
      const value = standardPayload('issues', 'opened');
      Object.assign(value, {[key]: replacement});
      await expect(verify('issues', value)).resolves.toEqual({
        outcome: 'rejected',
        code: expectedCode
      });
    }
  });

  it('projects only allowlisted identity fields and no free text or request data', async () => {
    const pullRequestPayload = standardPayload('pull_request', 'opened');
    if (!('pull_request' in pullRequestPayload)) throw new Error('expected pull request payload');
    const value = {
      ...pullRequestPayload,
      pull_request: {
        ...pullRequestPayload.pull_request,
        title: 'Confidential title',
        body: 'Confidential body',
        html_url: 'https://github.example/private?token=leak',
        head: {ref: 'feature/github-webhook', sha: 'b'.repeat(40)},
        base: {ref: 'main'}
      },
      sender: {login: 'private-person', email: 'private@example.test'},
      headers: {authorization: 'secret'},
      token: 'secret'
    };
    const rawBody = body(value);
    const result = await verify('pull_request', value, {rawBody});
    expect(result).toMatchInlineSnapshot(`
      {
        "outcome": "accepted",
        "projection": {
          "action": "opened",
          "deliveryId": "123e4567-e89b-42d3-a456-426614174000",
          "eventType": "pull_request",
          "installationId": 1001,
          "payloadSha256": "d1dc9a73e814b06abce4d4ab166e2d497350230ba285ac69eeb76cf91b746ec3",
          "project": {
            "projectId": "123e4567-e89b-42d3-a456-426614174000",
            "projectNodeId": "PVT_kwHOBIUvJs4Bbefq",
            "projectNumber": 3,
          },
          "provider": "github",
          "pullRequest": {
            "baseRef": "main",
            "headRef": "feature/github-webhook",
            "id": 502,
            "merged": false,
            "number": 43,
            "state": "open",
          },
          "repository": {
            "fullName": "VF78/MSA",
            "ownerId": 75837222,
            "repositoryId": 1278325372,
          },
        },
      }
    `);
    const persistedShape = JSON.stringify(result);
    for (const sensitiveValue of [
      'Confidential title',
      'Confidential body',
      'private-person',
      'private@example.test',
      'github.example',
      'secret',
      'authorization'
    ]) {
      expect(persistedShape).not.toContain(sensitiveValue);
    }
    expect(result).toEqual({
      outcome: 'accepted',
      projection: expect.objectContaining({
        payloadSha256: createHash('sha256').update(rawBody).digest('hex')
      })
    });
  });

  it('rejects accessor and proxy payloads after successful signature verification', async () => {
    const rawBody = body(standardPayload('issues', 'opened'));
    let getterCalls = 0;
    const getterPayload = Object.defineProperty({}, 'action', {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error('must not run');
      }
    });
    const parseSpy = vi.spyOn(JSON, 'parse');
    try {
      parseSpy.mockReturnValueOnce(getterPayload);
      await expect(verify('issues', {}, {rawBody})).resolves.toEqual({
        outcome: 'rejected',
        code: 'github_payload_invalid'
      });
      expect(getterCalls).toBe(0);

      parseSpy.mockReturnValueOnce(
        new Proxy(
          {},
          {
            ownKeys() {
              throw new Error('payload ownKeys trap');
            }
          }
        )
      );
      await expect(verify('issues', {}, {rawBody})).resolves.toEqual({
        outcome: 'rejected',
        code: 'github_payload_invalid'
      });
    } finally {
      parseSpy.mockRestore();
    }
  });

  it('rejects missing, duplicate, unexpected, and repository-name-only scope config', () => {
    expect(() => createGitHubAppWebhookConfig({...validConfigInput, scopes: validConfigInput.scopes.slice(0, 1)})).toThrow(
      'github_webhook_config_missing_scope'
    );
    expect(() => createGitHubAppWebhookConfig({...validConfigInput, scopes: [validConfigInput.scopes[0], validConfigInput.scopes[0]]})).toThrow(
      'github_webhook_config_duplicate_scope'
    );
    expect(() =>
      createGitHubAppWebhookConfig({
        ...validConfigInput,
        scopes: [
          ...validConfigInput.scopes,
          {
            ...validConfigInput.scopes[0],
            repositoryId: 1278325999,
            fullName: 'VF78/other'
          }
        ]
      })
    ).toThrow('github_webhook_config_unexpected_scope');
    expect(() =>
      createGitHubAppWebhookConfig({
        ...validConfigInput,
        scopes: validConfigInput.scopes.map((scope) => ({
          fullName: scope.fullName,
          ownerId: scope.ownerId,
          installationId: scope.installationId,
          projectId: scope.projectId,
          projectNumber: scope.projectNumber,
          projectNodeId: scope.projectNodeId
        }))
      })
    ).toThrow('github_webhook_config_invalid');
  });

  it('rejects config getters, proxy traps, and cyclic arrays as invalid config', () => {
    function expectInvalidConfig(value: unknown) {
      try {
        createGitHubAppWebhookConfig(value);
        throw new Error('expected invalid config');
      } catch (error) {
        expect(error).toBeInstanceOf(GitHubWebhookConfigError);
        expect(error).toMatchObject({code: 'github_webhook_config_invalid'});
      }
    }

    let getterCalls = 0;
    const getterConfig = {...validConfigInput};
    Object.defineProperty(getterConfig, 'scopes', {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error('must not run');
      }
    });
    expectInvalidConfig(getterConfig);
    expect(getterCalls).toBe(0);

    const scopeWithGetter = {...validConfigInput.scopes[0]};
    Object.defineProperty(scopeWithGetter, 'repositoryId', {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error('must not run');
      }
    });
    expectInvalidConfig({
      ...validConfigInput,
      scopes: [scopeWithGetter, validConfigInput.scopes[1]]
    });
    expect(getterCalls).toBe(0);

    for (const trappedConfig of [
      new Proxy(validConfigInput, {
        getPrototypeOf() {
          throw new Error('prototype trap');
        }
      }),
      new Proxy(validConfigInput, {
        ownKeys() {
          throw new Error('ownKeys trap');
        }
      }),
      new Proxy(validConfigInput, {
        getOwnPropertyDescriptor() {
          throw new Error('descriptor trap');
        }
      })
    ]) {
      expectInvalidConfig(trappedConfig);
    }

    const cyclicScopes: unknown[] = [];
    cyclicScopes.push(cyclicScopes);
    expectInvalidConfig({...validConfigInput, scopes: cyclicScopes});

    const cyclicConfig: Record<string, unknown> = {
      scopes: [...validConfigInput.scopes]
    };
    cyclicConfig.webhookSecretRef = cyclicConfig;
    expectInvalidConfig(cyclicConfig);

    const cyclicScope: Record<string, unknown> = {
      ...validConfigInput.scopes[0]
    };
    cyclicScope.ownerId = cyclicScope;
    expectInvalidConfig({
      ...validConfigInput,
      scopes: [cyclicScope, validConfigInput.scopes[1]]
    });

    const scopesWithCycle = [...validConfigInput.scopes] as unknown[] & {
      cycle?: unknown;
    };
    scopesWithCycle.cycle = scopesWithCycle;
    expectInvalidConfig({...validConfigInput, scopes: scopesWithCycle});

    const cyclicSecretScope: unknown[] = [];
    cyclicSecretScope.push(cyclicSecretScope);
    expectInvalidConfig({
      ...validConfigInput,
      webhookSecretRef: {
        ...validConfigInput.webhookSecretRef,
        scope: cyclicSecretScope
      }
    });
  });

  it('caps a streamed body even when Content-Length is absent or false', async () => {
    async function* chunks() {
      yield new Uint8Array(MAX_GITHUB_WEBHOOK_BODY_BYTES);
      yield new Uint8Array([1]);
    }
    await expect(readGitHubWebhookBody(chunks())).resolves.toEqual({
      ok: false,
      code: 'github_body_too_large'
    });
    await expect(readGitHubWebhookBody(chunks(), 'false')).resolves.toEqual({
      ok: false,
      code: 'github_body_too_large'
    });
    async function* failedStream() {
      throw new Error('stream failure');
    }
    await expect(readGitHubWebhookBody(failedStream())).resolves.toEqual({
      ok: false,
      code: 'github_body_stream_invalid'
    });
  });

  it('reads a standard ReadableStream without implicit property access', async () => {
    const expected = new TextEncoder().encode('stream body');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(expected);
        controller.close();
      }
    });
    const result = await readGitHubWebhookBody(stream);
    expect(result).toEqual({ok: true, body: expected});

    let done = false;
    const readerOnlyStream = {
      getReader() {
        return {
          async read() {
            if (done) return {done: true, value: undefined};
            done = true;
            return {done: false, value: expected};
          },
          releaseLock() {}
        };
      }
    };
    await expect(
      readGitHubWebhookBody(readerOnlyStream as unknown as ReadableStream<Uint8Array>)
    ).resolves.toEqual({ok: true, body: expected});
  });

  it('rejects malformed async iterators and readable stream objects', async () => {
    let getterCalls = 0;
    const asyncIteratorGetter = Object.defineProperty({}, Symbol.asyncIterator, {
      get() {
        getterCalls += 1;
        throw new Error('must not run');
      }
    });
    const nextGetter = {
      [Symbol.asyncIterator]() {
        return Object.defineProperty({}, 'next', {
          get() {
            getterCalls += 1;
            throw new Error('must not run');
          }
        });
      }
    };
    const readerGetter = Object.defineProperty({}, 'getReader', {
      get() {
        getterCalls += 1;
        throw new Error('must not run');
      }
    });
    const readResultGetter = {
      getReader() {
        return {
          async read() {
            return Object.defineProperty({}, 'done', {
              get() {
                getterCalls += 1;
                throw new Error('must not run');
              }
            });
          },
          releaseLock() {}
        };
      }
    };
    const trappedStream = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('stream prototype trap');
        }
      }
    );

    for (const malformed of [
      asyncIteratorGetter,
      nextGetter,
      readerGetter,
      readResultGetter,
      trappedStream
    ]) {
      await expect(
        readGitHubWebhookBody(
          malformed as AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>
        )
      ).resolves.toEqual({ok: false, code: 'github_body_stream_invalid'});
    }
    expect(getterCalls).toBe(0);
  });

  it('does not depend on a runner package import', async () => {
    const source = await readFile(new URL('./github-webhook.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('@fai-control-plane/runners');
  });
});
