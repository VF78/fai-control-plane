import {describe, expect, it, vi} from 'vitest';
import {createTelegramDeliveryAdapter} from './telegram.ts';

const config = {projectId: 'ascon', chatId: '-1001',
  tokenRef: {id: 'telegram', purpose: 'messenger_delivery', locator: '/token'}} as const;
const secrets = {resolve: vi.fn(async () => ({value: 'token'}))};
describe('Telegram internal contour', () => {
  it('delivers only trusted-main messages to the fixed project chat', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      new Response(JSON.stringify({ok: true, result: {message_id: 9}})));
    const delivery = createTelegramDeliveryAdapter({config, secrets, fetch});
    await expect(delivery.send({projectId: 'ascon', contour: 'trusted-main', channelReference: 'telegram:internal',
      text: 'Status changed', idempotencyKey: 'delivery-1'})).resolves.toEqual({deliveryReference: 'telegram:9'});
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({chat_id: '-1001', text: 'Status changed'});
    await expect(delivery.send({projectId: 'other', contour: 'trusted-main', channelReference: 'telegram:internal',
      text: 'Status changed', idempotencyKey: 'delivery-2'})).rejects.toThrow('telegram_message_invalid');
  });

  it('delivers a client-edge notification without accepting an internal contour',async()=>{
    const fetch=vi.fn<typeof globalThis.fetch>(async()=>new Response(JSON.stringify({ok:true,result:{message_id:10}})));
    const delivery=createTelegramDeliveryAdapter({config:{...config,contour:'client-edge'},secrets,fetch});
    await expect(delivery.send({projectId:'ascon',contour:'client-edge',channelReference:'telegram:client',
      text:'Статус обновлён',idempotencyKey:'client-delivery'})).resolves.toEqual({deliveryReference:'telegram:10'});
    await expect(delivery.send({projectId:'ascon',contour:'trusted-main',channelReference:'telegram:internal',
      text:'Нельзя',idempotencyKey:'wrong-contour'})).rejects.toThrow('telegram_message_invalid');
  });
});
