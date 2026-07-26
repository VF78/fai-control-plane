import {expect, it, vi} from 'vitest';
import {
  confirmTaskPacketCommand,
  type TaskPacketConfirmationCommandDependencies
} from './task-packet-confirmation-commands';

const packetId = '00000000-0000-4000-8000-000000000001';
const profileId = '00000000-0000-4000-8000-000000000002';
const workspaceId = '00000000-0000-4000-8000-000000000003';

it('rejects a stale authenticated packet hash before issuing a queue command', async () => {
  const queue = vi.fn();
  const dependencies: TaskPacketConfirmationCommandDependencies = {
    requireSession: async () => ({
      ok: true,
      session: {actorId: '00000000-0000-4000-8000-000000000004'},
      runtime: {config: {workspaceId}}
    }) as never,
    getRuntime: async () => ({
      load: async () => ({
        packetId,
        contentHash: 'a'.repeat(64),
        agentProfileId: profileId,
        baseCommit: 'b'.repeat(40)
      }),
      queue
    })
  };
  const response = await confirmTaskPacketCommand(new Request(
    `https://control.example.test/api/task-packets/${packetId}/confirm`,
    {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        _csrf: 'csrf-token',
        confirmedPacketHash: 'c'.repeat(64),
        agentProfileId: profileId
      })
    }
  ), packetId, dependencies);

  expect(response.status).toBe(409);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(queue).not.toHaveBeenCalled();
});
