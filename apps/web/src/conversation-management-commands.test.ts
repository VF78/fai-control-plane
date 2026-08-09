import {expect, it, vi} from 'vitest';
import {setConversationAccessCommand, setConversationChannelCommand} from './conversation-management-commands';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const actorId = '22222222-2222-4222-8222-222222222222';
const projectId = '33333333-3333-4333-8333-333333333333';
const channelId = '44444444-4444-4444-8444-444444444444';
const subjectActorId = '55555555-5555-4555-8555-555555555555';
const grantId = '66666666-6666-4666-8666-666666666666';
const authorization = {ok: true as const, session: {actorId, csrfToken: 'csrf'}, runtime: {config: {workspaceId, publicBaseUrl: new URL('https://app.example/')}}, sessionToken: 'session'};
const request = (
  values: Record<string, string>,
  referer = 'https://app.example/projects/msa/chats'
) => new Request('http://0.0.0.0:3000/api/conversations/channel', {
  method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded', referer},
  body: new URLSearchParams(values)
});
const deps = (runtime: object) => ({requireSession: vi.fn().mockResolvedValue(authorization) as never, getRuntime: vi.fn().mockResolvedValue(runtime)});

it('submits bounded channel state and access intents', async () => {
  const setChannel = vi.fn().mockResolvedValue('updated');
  const channelResponse = await setConversationChannelCommand(request({_csrf: 'csrf', projectId, channelId, conversationClass: 'internal', action: 'activate', expectedVersion: '0'}), deps({setChannel}) as never);
  expect(channelResponse.status).toBe(303);
  expect(channelResponse.headers.get('location')).toBe('https://app.example/projects/msa/chats');
  expect(setChannel).toHaveBeenCalledWith({workspaceId, operatorActorId: actorId, projectId, channelId, conversationClass: 'internal', desiredState: 'active', expectedVersion: null});

  const setAccess = vi.fn().mockResolvedValue('updated');
  const accessResponse = await setConversationAccessCommand(request({_csrf: 'csrf', projectId, channelId, conversationClass: 'internal', actorId: subjectActorId, grantId, expectedVersion: '0', desiredLevel: 'write'}), deps({setAccess}) as never);
  expect(accessResponse.status).toBe(303);
  expect(setAccess).toHaveBeenCalledWith({workspaceId, operatorActorId: actorId, projectId, channelId, conversationClass: 'internal', subjectActorId, grantId, expectedVersion: null, desiredLevel: 'write'});
});

it('fails closed for extra fields, foreign redirect and stale CAS', async () => {
  const malformed = await setConversationChannelCommand(request({_csrf: 'csrf', projectId, channelId, conversationClass: 'internal', action: 'activate', expectedVersion: '0', rawChatId: '1234567890'}), deps({setChannel: vi.fn()}) as never);
  expect(malformed.status).toBe(400);
  const stale = await setConversationAccessCommand(request({_csrf: 'csrf', projectId, channelId, conversationClass: 'internal', actorId: subjectActorId, grantId, expectedVersion: '2', desiredLevel: 'read'}), deps({setAccess: vi.fn().mockResolvedValue('stale')}) as never);
  expect(stale.status).toBe(409);
  const foreign = await setConversationChannelCommand(request({_csrf: 'csrf', projectId, channelId, conversationClass: 'internal', action: 'activate', expectedVersion: '0'}, 'https://evil.example/steal'), deps({setChannel: vi.fn().mockResolvedValue('updated')}) as never);
  expect(foreign.headers.get('location')).toBe('https://app.example/dashboard');
});
