import {expect, it, vi} from 'vitest';
import {
  confirmTaskPacketCommand,
  type TaskPacketConfirmationCommandDependencies
} from './task-packet-confirmation-commands';
import {buildAgentRunQueuePolicyPreview} from './operator-data';

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
    isQueueEnabled: () => true,
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
        agentProfileId: profileId,
        actionHash: 'd'.repeat(64)
      })
    }
  ), packetId, dependencies);

  expect(response.status).toBe(409);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(queue).not.toHaveBeenCalled();
});

it('rejects a stale policy preview before issuing a queue command', async () => {
  const queue = vi.fn();
  const currentPacket = {
    packetId,
    contentHash: 'a'.repeat(64),
    agentProfileId: profileId,
    baseCommit: 'b'.repeat(40),
    approverActorId: '00000000-0000-4000-8000-000000000004'
  };
  const stalePreview = buildAgentRunQueuePolicyPreview({
    ...currentPacket,
    approverActorId: '00000000-0000-4000-8000-000000000005'
  });
  expect(stalePreview).toMatchObject({
    actorType: 'human',
    actionCategory: 'write',
    surface: 'control_plane',
    environment: 'development',
    decision: 'allow',
    policyVersion: 1,
    requiredHumanPacketHash: currentPacket.contentHash
  });
  expect(buildAgentRunQueuePolicyPreview({
    ...currentPacket,
    approverActorId: '00000000-0000-4000-8000-000000000005'
  }).actionHash).toBe(stalePreview.actionHash);
  const dependencies: TaskPacketConfirmationCommandDependencies = {
    requireSession: async () => ({
      ok: true,
      session: {actorId: '00000000-0000-4000-8000-000000000004'},
      runtime: {config: {workspaceId}}
    }) as never,
    isQueueEnabled: () => true,
    getRuntime: async () => ({
      load: async () => currentPacket,
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
        confirmedPacketHash: currentPacket.contentHash,
        agentProfileId: profileId,
        actionHash: stalePreview.actionHash
      })
    }
  ), packetId, dependencies);

  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({status: 'action_changed'});
  expect(queue).not.toHaveBeenCalled();
});

it('does not load or queue a packet while the runner transport is disabled', async () => {
  const getRuntime = vi.fn();
  const response = await confirmTaskPacketCommand(new Request(
    `https://control.example.test/api/task-packets/${packetId}/confirm`,
    {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        _csrf: 'csrf-token',
        confirmedPacketHash: 'a'.repeat(64),
        agentProfileId: profileId,
        actionHash: 'd'.repeat(64)
      })
    }
  ), packetId, {
    requireSession: async () => ({
      ok: true,
      session: {actorId: '00000000-0000-4000-8000-000000000004'},
      runtime: {config: {workspaceId}}
    }) as never,
    isQueueEnabled: () => false,
    getRuntime
  });

  expect(response.status).toBe(503);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({status: 'runner_disabled'});
  expect(getRuntime).not.toHaveBeenCalled();
});
