import {describe, expect, it, vi} from 'vitest';
import {createBitrix24DeliveryAdapter, createBitrix24IngressAdapter, type Bitrix24Config} from './bitrix24.ts';
const config: Bitrix24Config = {portalUrl: 'https://portal.example.test/', memberId: 'member', taskId: 154312,
  projectId: 'ascon', allowedAuthorIds: [101], applicationTokenRef: {id: 'app', purpose: 'verify', locator: '/app'},
  restTokenRef: {id: 'rest', purpose: 'send', locator: '/rest'}};
const secrets = {resolve: vi.fn(async (reference: {id: string}) => ({value: reference.id === 'app' ? 'verify-token' : 'rest-token'}))};
const form = () => new URLSearchParams({event: 'ONTASKCOMMENTADD', 'auth[application_token]': 'verify-token',
  'auth[domain]': 'portal.example.test', 'auth[member_id]': 'member',
  'data[FIELDS_AFTER][TASK_ID]': '154312', 'data[FIELDS_AFTER][MESSAGE_ID]': '500'});
const provider = (author = 101) => vi.fn(async (url: string | URL | Request) => String(url).includes('tasks.task.get')
  ? new Response(JSON.stringify({result: {item: {id: 154312, chat: {id: 77}}}}))
  : new Response(JSON.stringify({result: {messages: [{id: 500, chat_id: 77, author_id: author,
    text: 'Found a defect', date: '2026-08-13T00:00:00.000Z'}]}})));
describe('MVP Bitrix24 messenger adapter', () => {
  it('resolves the exact provider message instead of trusting webhook text', async () => {
    const params = form(); params.set('data[TEXT]', 'forged');
    const result = await createBitrix24IngressAdapter({config, secrets, fetch: provider()}).receive({
      headers: {'content-type': 'application/x-www-form-urlencoded'}, body: new TextEncoder().encode(params.toString())});
    expect(result).toMatchObject({status: 'accepted', message: {projectId: 'ascon', contour: 'client-edge', text: 'Found a defect'}});
    expect(JSON.stringify(result)).not.toContain('forged');
  });
  it('rejects an author outside the allowlist', async () => {
    await expect(createBitrix24IngressAdapter({config, secrets, fetch: provider(999)}).receive({
      headers: {'content-type': 'application/x-www-form-urlencoded'}, body: new TextEncoder().encode(form().toString())}))
      .resolves.toEqual({status: 'rejected', reason: 'sender_denied'});
  });
  it('sends only through the client contour', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({result: {id: '701'}})));
    const adapter = createBitrix24DeliveryAdapter({config, secrets, fetch});
    await expect(adapter.send({projectId: 'ascon', contour: 'client-edge', channelReference: 'task',
      text: 'Completed', idempotencyKey: 'key'})).resolves.toEqual({deliveryReference: 'bitrix24:701'});
    await expect(adapter.send({projectId: 'ascon', contour: 'trusted-main', channelReference: 'task',
      text: 'Completed', idempotencyKey: 'key'})).rejects.toThrow('bitrix24_message_invalid');
  });
});
