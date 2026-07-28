import {
  afterEach,
  describe,
  expect,
  it,
  vi
} from 'vitest';
import {POST} from './route';

const request = () =>
  new Request('http://control-plane.test/api/webhooks/github', {
    method: 'POST',
    body: '{}'
  });

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('GitHub webhook route availability', () => {
  it('is undiscoverable while GitHub synchronization is disabled', async () => {
    vi.stubEnv('GITHUB_SYNC_ENABLED', 'false');
    vi.stubEnv('GITHUB_INGRESS_ENABLED', 'false');

    const response = await POST(request());

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({status: 'not_found'});
  });

  it('remains undiscoverable until the incoming-event consumer is enabled', async () => {
    vi.stubEnv('GITHUB_SYNC_ENABLED', 'true');
    vi.stubEnv('GITHUB_INGRESS_ENABLED', 'false');

    const response = await POST(request());

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({status: 'not_found'});
  });

  it('fails closed without reflecting runtime configuration errors', async () => {
    vi.stubEnv('GITHUB_SYNC_ENABLED', 'true');
    vi.stubEnv('GITHUB_INGRESS_ENABLED', 'true');
    vi.stubEnv('DATABASE_URL', '');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({status: 'unavailable'});
    expect(logged).toHaveBeenCalledWith(
      'GitHub webhook request could not be processed.'
    );
  });
});
