import {describe,expect,it} from 'vitest';
import {mergeProjectMessengerSecretRefs,parseProjectMessengerBindings} from './project-messenger-bindings.ts';

describe('project messenger bindings',()=>{
  it('accepts internal Telegram and client Element without secrets',()=>{
    expect(parseProjectMessengerBindings(JSON.stringify({contract:'fai.project-messenger-bindings.v1',channels:{internal:{provider:'telegram',status:'ready',allowedUserIds:['42'],telegram:{chatId:'-10042'}},client:{provider:'element',status:'interactive',allowedUserIds:[],element:{homeserver:'https://matrix.test',roomReference:'!client:matrix.test'}}}}))).toEqual({internal:{provider:'telegram',status:'ready',allowedUserIds:['42'],telegram:{chatId:'-10042'}},client:{provider:'element',status:'interactive',allowedUserIds:[],element:{homeserver:'https://matrix.test',roomReference:'!client:matrix.test'}}});
  });

  it('rejects a client channel falsely marked ready',()=>{
    expect(parseProjectMessengerBindings(JSON.stringify({contract:'fai.project-messenger-bindings.v1',channels:{client:{provider:'element',status:'ready',allowedUserIds:[],element:{homeserver:'https://matrix.test',roomReference:'!client:matrix.test'}}}}))).toBeNull();
  });

  it('rejects Element in the trusted internal contour',()=>{
    expect(parseProjectMessengerBindings(JSON.stringify({contract:'fai.project-messenger-bindings.v1',channels:{internal:{provider:'element',status:'ready',allowedUserIds:['@owner:matrix.test'],element:{homeserver:'https://matrix.test',roomReference:'!internal:matrix.test'}}}}))).toBeNull();
  });

  it('merges a second contour secret reference without dropping the first',()=>{
    const internal='11111111-1111-4111-8111-111111111111';
    const client='22222222-2222-4222-8222-222222222222';
    expect(mergeProjectMessengerSecretRefs(JSON.stringify({secretRefs:{'internal-telegram-bot':internal}}),
      {'client-telegram-bot':client})).toEqual({'internal-telegram-bot':internal,'client-telegram-bot':client});
  });
});
