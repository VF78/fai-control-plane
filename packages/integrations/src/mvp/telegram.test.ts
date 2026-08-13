import {describe, expect, it, vi} from 'vitest';
import {createTelegramAdapter} from './telegram.ts';

const config = {projectId: 'ascon', chatId: '-1001', allowedUserIds: ['7'],
  tokenRef: {id: 'telegram', purpose: 'messenger_delivery', locator: '/token'}} as const;
const secrets = {resolve: vi.fn(async () => ({value: 'token'}))};
describe('Telegram internal contour', () => {
  it('accepts only the exact configured chat and allowlisted sender', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ok: true, result: [{update_id: 42,
      message: {message_id: 9, date: 1_786_572_000, text: '/facts', chat: {id: -1001}, from: {id: 7}}}]})));
    const result = await createTelegramAdapter({config, secrets, fetch}).poller.poll(null);
    expect(result.messages).toHaveLength(1); expect(result.highWaterUpdateId).toBe(42);
    expect(result.messages[0]?.message).toMatchObject({projectId: 'ascon', contour: 'trusted-main', text: '/facts'});
    expect(JSON.stringify(result)).not.toContain('"senderReference":"7"');
  });
  it('does not accept another chat', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ok: true, result: [{update_id: 42,
      message: {message_id: 9, date: 1_786_572_000, text: '/facts', chat: {id: -2000}, from: {id: 7}}}]})));
    await expect(createTelegramAdapter({config, secrets, fetch}).poller.poll(null)).resolves.toEqual({highWaterUpdateId: 42, messages: []});
  });
});
