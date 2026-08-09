import {expect, it, vi} from 'vitest';
import {
  createCodingTaskPacketCommand,
  type CodingTaskPacketCommandDependencies
} from './coding-task-packet-commands';

const workItemId = '00000000-0000-4000-8000-000000000001';
const actorId = '00000000-0000-4000-8000-000000000002';
const workspaceId = '00000000-0000-4000-8000-000000000003';
const csrfToken = 'csrf-token';

it('requires an exact CSRF form and sends only the authenticated operator and selected WorkItem to the builder', async () => {
  const create = vi.fn(async () => ({status: 'replayed' as const, projectSlug: 'new-project' as const}));
  const dependencies: CodingTaskPacketCommandDependencies = {
    requireSession: async (_request: Request, options?: Readonly<{csrfToken?: string | null}>) => options?.csrfToken === csrfToken
      ? {
          ok: true,
          session: {actorId},
          runtime: {config: {workspaceId}}
        } as never
      : {
          ok: false,
          response: new Response(null, {status: 403, headers: {'Cache-Control': 'no-store'}})
        },
    getRuntime: async () => ({create})
  } as never;
  const request = (body: string) => new Request('https://control.example.test/api/task-packets/x/build', {
    method: 'POST',
    headers: {'content-type': 'application/x-www-form-urlencoded'},
    body
  });

  const exact = await createCodingTaskPacketCommand(
    request(`_csrf=${csrfToken}`), workItemId, dependencies
  );
  expect(exact.status).toBe(303);
  expect(exact.headers.get('location')).toBe(
    `https://control.example.test/projects/new-project/tasks/${workItemId}`
  );
  expect(create).toHaveBeenCalledWith({workspaceId, actorId, workItemId});

  const inexact = await createCodingTaskPacketCommand(
    request(`_csrf=${csrfToken}&goal=forged`), workItemId, dependencies
  );
  expect(inexact.status).toBe(400);
  expect(create).toHaveBeenCalledTimes(1);

  const invalidId = await createCodingTaskPacketCommand(
    request(`_csrf=${csrfToken}`), 'not-a-uuid', dependencies
  );
  expect(invalidId.status).toBe(400);
  expect(create).toHaveBeenCalledTimes(1);
});
