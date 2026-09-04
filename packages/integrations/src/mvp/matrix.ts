import type {MessengerDeliveryPort,OpaqueSecretRef,SecretResolverPort} from '@fai-control-plane/domain';

type Fetch=typeof globalThis.fetch;
export type MatrixConnection=Readonly<{homeserver:string;roomReference:string;login:string;password:string}>;
export type MatrixVerifiedConnection=Readonly<{roomId:string;userId:string}>;

const endpoint=(homeserver:string,path:string)=>{
  const base=new URL(homeserver);
  if(base.protocol!=='https:'||base.username!==''||base.password!==''||base.search!==''||base.hash!=='')
    throw new Error('matrix_config_invalid');
  return new URL(path,`${base.origin}/`);
};
const json=async(request:Fetch,url:URL,init:RequestInit)=>{const response=await request(url,{
  ...init,headers:{accept:'application/json','content-type':'application/json',...init.headers},
  signal:AbortSignal.timeout(6_000)});const value=await response.json().catch(()=>null) as Record<string,unknown>|null;
  if(!response.ok||value===null)throw new Error('matrix_verification_failed');return value;};
const login=async(connection:MatrixConnection,request:Fetch)=>{const value=await json(request,
  endpoint(connection.homeserver,'/_matrix/client/v3/login'),{method:'POST',body:JSON.stringify({type:'m.login.password',
    identifier:{type:'m.id.user',user:connection.login},password:connection.password,device_id:'FAI_CONTROL',
    initial_device_display_name:'f(AI) Control'})});
  if(typeof value.access_token!=='string'||typeof value.user_id!=='string')throw new Error('matrix_verification_failed');
  return {accessToken:value.access_token,userId:value.user_id};};
const bearer=(accessToken:string)=>({authorization:`Bearer ${accessToken}`});
const roomReference=(input:string)=>{const direct=input.trim();if(/^[!#][^\s:\0]+:[^\s:\0]+$/.test(direct))return direct;
  try{const link=new URL(direct);if(link.protocol!=='https:')throw new Error('matrix_config_invalid');
    const fragment=decodeURIComponent(link.hash.replace(/^#\/?/,'')).replace(/^room\//,'').split('?')[0]??'';
    if(/^[!#][^\s:\0]+:[^\s:\0]+$/.test(fragment))return fragment;
  }catch{/* normalized below */}throw new Error('matrix_config_invalid');};
const resolveRoom=async(connection:MatrixConnection,accessToken:string,request:Fetch)=>{
  const reference=roomReference(connection.roomReference);if(reference.startsWith('!'))return reference;
  const value=await json(request,endpoint(connection.homeserver,
    `/_matrix/client/v3/directory/room/${encodeURIComponent(reference)}`),{method:'GET',headers:bearer(accessToken)});
  if(typeof value.room_id!=='string')throw new Error('matrix_verification_failed');return value.room_id;};
const session=async(connection:MatrixConnection,request:Fetch)=>{const authenticated=await login(connection,request);
  const roomId=await resolveRoom(connection,authenticated.accessToken,request);const joined=await json(request,
    endpoint(connection.homeserver,'/_matrix/client/v3/joined_rooms'),{method:'GET',headers:bearer(authenticated.accessToken)});
  if(!Array.isArray(joined.joined_rooms)||!joined.joined_rooms.includes(roomId))throw new Error('matrix_verification_failed');
  return {...authenticated,roomId};};
const send=async(connection:MatrixConnection,text:string,transactionId:string,request:Fetch)=>{const current=await session(connection,request);
  const value=await json(request,endpoint(connection.homeserver,
    `/_matrix/client/v3/rooms/${encodeURIComponent(current.roomId)}/send/m.room.message/${encodeURIComponent(transactionId)}`),
  {method:'PUT',headers:bearer(current.accessToken),body:JSON.stringify({msgtype:'m.notice',body:text})});
  if(typeof value.event_id!=='string')throw new Error('matrix_delivery_failed');return {...current,eventId:value.event_id};};

export const verifyMatrixConnection=async(connection:MatrixConnection,request:Fetch=globalThis.fetch):Promise<MatrixVerifiedConnection>=>{
  const result=await session(connection,request);return {roomId:result.roomId,userId:result.userId};
};

export const createMatrixDeliveryAdapter=(input:Readonly<{config:Readonly<{projectId:string;homeserver:string;
  roomReference:string;loginRef:OpaqueSecretRef;passwordRef:OpaqueSecretRef;contour:'trusted-main'|'client-edge'}>;
  secrets:SecretResolverPort;fetch?:Fetch}>):MessengerDeliveryPort=>({send:async(message)=>{
  if(message.projectId!==input.config.projectId||message.contour!==input.config.contour||message.text.length===0||
    message.text.length>4_000||message.text.includes('\0'))throw new Error('matrix_message_invalid');
  const [loginSecret,passwordSecret]=await Promise.all([input.secrets.resolve(input.config.loginRef,'messenger_delivery'),
    input.secrets.resolve(input.config.passwordRef,'messenger_delivery')]);
  const connection={homeserver:input.config.homeserver,roomReference:input.config.roomReference,
    login:loginSecret.value,password:passwordSecret.value};
  const result=await send(connection,message.text,message.idempotencyKey,input.fetch??globalThis.fetch);
  return {deliveryReference:`matrix:${result.eventId}`};
}});
