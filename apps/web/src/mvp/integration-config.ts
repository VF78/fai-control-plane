export type IntegrationChannel = Readonly<{
  provider: 'telegram'|'element'|null;
  configured: boolean;
  allowedUserIds: readonly string[];
  allowedUsers: number;
  status: 'ready'|'interactive'|'pending_verification'|null;
  telegram?: Readonly<{chatId:string}>;
  element?: Readonly<{homeserver:string;roomReference:string}>;
}>;
export type IntegrationConfig = Readonly<{
  hermes: boolean;
  channels: Readonly<Record<'internal'|'client',IntegrationChannel>>;
}>;

type StoredChannel = Readonly<{
  provider:'telegram'|'element';allowedUserIds?:readonly string[];allowedUsers?:readonly string[];
  status?:'ready'|'interactive'|'pending_verification';
  telegram?:Readonly<{chatId:string}>;element?:Readonly<{homeserver:string;roomReference:string}>;
}>;
type ProjectRuntimeConfig = Readonly<{
  telegramChatId?:string|null;telegramAllowedUserIds?:readonly string[];
}> | null;

const channel=(stored:StoredChannel|undefined):IntegrationChannel=>{const allowedUserIds=stored?.allowedUserIds??stored?.allowedUsers??[];return ({
  provider:stored?.provider??null,
  configured:stored?.status==='ready'||stored?.status==='interactive',
  allowedUserIds,
  allowedUsers:allowedUserIds.length,
  status:stored?.status??null,
  ...(stored?.telegram===undefined?{}:{telegram:stored.telegram}),
  ...(stored?.element===undefined?{}:{element:stored.element})
});};

export const integrationConfig = (runtime:ProjectRuntimeConfig=null,
  channels:Readonly<Partial<Record<'internal'|'client',StoredChannel>>>={}):IntegrationConfig=>{
  const legacyInternal:StoredChannel|undefined=runtime?.telegramChatId===undefined||runtime.telegramChatId===null
    ?undefined:{provider:'telegram',status:'ready',allowedUserIds:runtime.telegramAllowedUserIds??[],
      telegram:{chatId:runtime.telegramChatId}};
  return {hermes:runtime!==null,channels:{
    internal:channel(channels.internal??legacyInternal),
    client:channel(channels.client)
  }};
};
