import {randomUUID} from 'node:crypto';
import {createActorContextIssuer} from '@fai-control-plane/domain';
import {expect, it, vi} from 'vitest';
import {
  CONVERSATION_CHANNEL_SET_COMMAND,
  createConversationChannelService,
  type ConversationChannelStore
} from './conversation-management';

const issueActor = (capabilities: readonly string[]) => {
  const actorId = randomUUID();
  const issuer = createActorContextIssuer({users: [{actorId, capabilities: capabilities as never}], agents: [], systems: []});
  if (!issuer.ok) throw new Error('issuer');
  const actor = issuer.value.issueUser(actorId);
  if (!actor.ok) throw new Error('actor');
  return actor.value;
};

it('accepts only an exact provider-neutral channel intent', async () => {
  const actor = issueActor(['write:control_plane:development']);
  const channelId = randomUUID();
  const execute = vi.fn(async (input) => ({status: 'completed' as const, receipt: {
    commandId: input.command.commandId,
    workspaceId: input.command.workspaceId,
    correlationId: input.command.correlationId,
    idempotencyKey: input.command.idempotencyKey,
    requestHash: input.requestHash,
    commandType: CONVERSATION_CHANNEL_SET_COMMAND,
    result: {ok: true as const, value: {...input.command.payload, version: 1}},
    createdAt: input.command.issuedAt
  }}));
  const service = createConversationChannelService({execute} as ConversationChannelStore);
  const command = {
    commandId: randomUUID(), workspaceId: randomUUID(), correlationId: randomUUID(),
    idempotencyKey: `conversation-channel-set:v1:${channelId}:0:active:${actor.actorId}`,
    issuedAt: '2026-08-09T10:00:00.000Z', actor, type: CONVERSATION_CHANNEL_SET_COMMAND,
    payload: {projectId: randomUUID(), channelId, conversationClass: 'internal' as const,
      desiredState: 'active' as const, provider: 'telegram', configurationRef: 'telegram:msa:internal', expectedVersion: null}
  };
  await expect(service.execute(command)).resolves.toMatchObject({status: 'completed'});
  expect(execute).toHaveBeenCalledWith(expect.objectContaining({authorized: true, requestHash: expect.stringMatching(/^[0-9a-f]{64}$/)}));
  await expect(service.execute({...command, extra: 'forged'} as never)).resolves.toMatchObject({status: 'rejected', error: {code: 'INVALID_COMMAND'}});
});

it('passes policy denial to persistence without reserving a success in application', async () => {
  const actor = issueActor([]);
  const channelId = randomUUID();
  const execute = vi.fn(async (input) => ({status: 'completed' as const, receipt: {
    commandId: input.command.commandId, workspaceId: input.command.workspaceId,
    correlationId: input.command.correlationId, idempotencyKey: input.command.idempotencyKey,
    requestHash: input.requestHash, commandType: CONVERSATION_CHANNEL_SET_COMMAND,
    result: {ok: false as const, error: input.policyError!}, createdAt: input.command.issuedAt
  }}));
  const command = {
    commandId: randomUUID(), workspaceId: randomUUID(), correlationId: randomUUID(),
    idempotencyKey: `conversation-channel-set:v1:${channelId}:0:not_used:${actor.actorId}`,
    issuedAt: '2026-08-09T10:00:00.000Z', actor, type: CONVERSATION_CHANNEL_SET_COMMAND,
    payload: {projectId: randomUUID(), channelId, conversationClass: 'client' as const,
      desiredState: 'not_used' as const, provider: null, configurationRef: null, expectedVersion: null}
  };
  await createConversationChannelService({execute} as ConversationChannelStore).execute(command);
  expect(execute).toHaveBeenCalledWith(expect.objectContaining({authorized: false, policyError: expect.objectContaining({code: 'CAPABILITY_DENIED'})}));
});
