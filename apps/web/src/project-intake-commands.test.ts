import {expect, it, vi} from 'vitest';
import {createProjectCommand} from './project-intake-commands';

const actorId = '11111111-1111-4111-8111-111111111111';
const workspaceId = '22222222-2222-4222-8222-222222222222';
const authorization = {ok: true as const, session: {actorId, csrfToken: 'csrf'},
  runtime: {config: {workspaceId}}, sessionToken: 'session'};
const values = () => {
  const result: Record<string, string> = {
    _csrf: 'csrf', idempotencyKey: '33333333-3333-4333-8333-333333333333',
    name: 'Новый проект', slug: 'new-project', productOwnerActorId: actorId,
    repositoryBinding: 'create_managed', trackerBinding: 'link_existing',
    internalChat: 'create_managed', clientChat: 'none', executionMode: 'manual', agentProfileId: ''
  };
  for (let index = 0; index < 8; index += 1) {
    result[`memberActorId${index}`] = '';
    result[`memberRole${index}`] = 'contributor';
  }
  return result;
};
const request = (body: Record<string, string>) => new Request('https://app.example/api/projects', {
  method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded'},
  body: new URLSearchParams(body)
});

it('submits an exact provider-neutral project intake and redirects to real setup detail', async () => {
  const create = vi.fn().mockResolvedValue({status: 'created', slug: 'new-project'});
  const close = vi.fn().mockResolvedValue(undefined);
  const response = await createProjectCommand(request(values()), {
    requireSession: vi.fn().mockResolvedValue(authorization) as never,
    getRuntime: vi.fn().mockResolvedValue({runtime: {create}, close}) as never
  });
  expect(response.status).toBe(303);
  expect(response.headers.get('location')).toBe('https://app.example/projects/new-project/setup');
  expect(create).toHaveBeenCalledWith(expect.objectContaining({workspaceId, operatorActorId: actorId,
    slug: 'new-project', repositoryBinding: 'create_managed', agentProfileId: null, members: []}));
  expect(close).toHaveBeenCalledOnce();
});

it('fails closed on CSRF, extra fields, reserved slugs, and incompatible execution profile shape', async () => {
  const deniedSession = vi.fn().mockResolvedValue({ok: false, response: new Response(null, {status: 403})});
  const denied = await createProjectCommand(request(values()), {requireSession: deniedSession as never,
    getRuntime: vi.fn() as never});
  expect(denied.status).toBe(403);
  expect(deniedSession).toHaveBeenCalledWith(expect.any(Request), {csrfToken: 'csrf'});

  for (const body of [
    {...values(), extra: 'provider-id'},
    {...values(), slug: 'api'},
    {...values(), executionMode: 'managed_agent', agentProfileId: ''}
  ]) {
    const response = await createProjectCommand(request(body), {
      requireSession: vi.fn().mockResolvedValue(authorization) as never, getRuntime: vi.fn() as never
    });
    expect(response.status).toBe(400);
  }
});

it('bounds members and requires the creator to remain authorized for the new project', async () => {
  const body = values();
  body.productOwnerActorId = '44444444-4444-4444-8444-444444444444';
  const response = await createProjectCommand(request(body), {
    requireSession: vi.fn().mockResolvedValue(authorization) as never, getRuntime: vi.fn() as never
  });
  expect(response.status).toBe(400);
});

it('rejects an oversized chunked body before authentication', async () => {
  const requireSession = vi.fn();
  const oversized = new Request('https://app.example/api/projects', {
    method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded'},
    body: new ReadableStream({start(controller) {
      controller.enqueue(new TextEncoder().encode(`name=${'x'.repeat(13 * 1024)}`));
      controller.close();
    }}), duplex: 'half'
  } as RequestInit & {duplex: 'half'});
  const response = await createProjectCommand(oversized, {
    requireSession: requireSession as never, getRuntime: vi.fn() as never
  });
  expect(response.status).toBe(400);
  expect(requireSession).not.toHaveBeenCalled();
});
