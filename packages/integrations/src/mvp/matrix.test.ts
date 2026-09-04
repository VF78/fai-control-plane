import {describe,expect,it,vi} from 'vitest';
import {createMatrixDeliveryAdapter,verifyMatrixConnection} from './matrix.ts';

const connection={homeserver:'https://matrix.example',roomReference:'#project:matrix.example',login:'owner',password:'secret'};
const matrixFetch=()=>vi.fn<typeof globalThis.fetch>(async(input,init)=>{const url=String(input);
  if(url.endsWith('/login'))return Response.json({access_token:'access',user_id:'@owner:matrix.example'});
  if(url.includes('/directory/room/'))return Response.json({room_id:'!project:matrix.example'});
  if(url.endsWith('/joined_rooms'))return Response.json({joined_rooms:['!project:matrix.example']});
  if(url.includes('/send/m.room.message/'))return Response.json({event_id:'$event'});
  return Response.json({method:init?.method},{status:404});});

describe('Matrix messenger adapter',()=>{
  it('verifies password login and membership without sending into a possibly encrypted room',async()=>{const fetch=matrixFetch();
    await expect(verifyMatrixConnection(connection,fetch)).resolves.toEqual({roomId:'!project:matrix.example',userId:'@owner:matrix.example'});
    expect(fetch).toHaveBeenCalledTimes(3);expect(fetch.mock.calls.some(([url])=>String(url).includes('/send/'))).toBe(false);});

  it('accepts a Matrix or Element room link',async()=>{for(const roomReference of [
    'https://matrix.to/#/%23project%3Amatrix.example','https://matrix.to/#/!project:matrix.example?via=matrix.example',
    'https://app.element.io/#/room/%23project%3Amatrix.example']){
    const fetch=matrixFetch();await expect(verifyMatrixConnection({...connection,roomReference},fetch)).resolves.toMatchObject({
      roomId:'!project:matrix.example'});expect(fetch.mock.calls.some(([url])=>String(url).includes('/joined_rooms'))).toBe(true);
    if(roomReference.includes('%23'))expect(fetch.mock.calls.some(([url])=>String(url).includes('%23project%3Amatrix.example'))).toBe(true);
  }});

  it('delivers only the configured project contour through secret refs',async()=>{const fetch=matrixFetch();const secrets={resolve:vi.fn(async(ref)=>({value:ref.id==='login'?'owner':'secret'}))};
    const delivery=createMatrixDeliveryAdapter({config:{projectId:'project',homeserver:connection.homeserver,
      roomReference:connection.roomReference,loginRef:{id:'login',purpose:'messenger_delivery',locator:'/login'},
      passwordRef:{id:'password',purpose:'messenger_delivery',locator:'/password'},contour:'client-edge'},secrets,fetch});
    await expect(delivery.send({projectId:'project',contour:'client-edge',channelReference:'matrix:client',text:'Ready',
      idempotencyKey:'notice-1'})).resolves.toEqual({deliveryReference:'matrix:$event'});
    await expect(delivery.send({projectId:'project',contour:'trusted-main',channelReference:'matrix:internal',text:'No',
      idempotencyKey:'notice-2'})).rejects.toThrow('matrix_message_invalid');});
});
