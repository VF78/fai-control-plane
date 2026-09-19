export type TelegramChat = Readonly<{chatId: string; participantIds: readonly string[]}>;
export type ElementChat = Readonly<{homeserver: string; roomReference: string}>;
export type ClientChat = Readonly<
  | {provider: "telegram"; telegram: TelegramChat}
  | {provider: "element"; element: ElementChat}
>;

export type ProjectChatsState = Readonly<{
  contract: "fai.project-chats.v1";
  revision: number;
  internal: TelegramChat | null;
  client: ClientChat | null;
}>;

export type ProjectChatsView = Readonly<{
  state: ProjectChatsState;
  nativeCapability: "host_messenger_binding_required" | "configuration_verified";
  expectedHermesRevision?: number;
  contextVersion?: string;
  secretFiles?: readonly string[];
  reason: string;
}>;

const emptyState = (): ProjectChatsState => ({contract: "fai.project-chats.v1", revision: 0, internal: null, client: null});

function telegramId(value: unknown, field: string, allowNegative = false): string {
  if (typeof value !== "string" || !(allowNegative ? /^-?\d{1,20}$/ : /^\d{1,20}$/).test(value)) throw new Error(`${field}_invalid`);
  return value;
}

function participantIds(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) throw new Error(`${field}_invalid`);
  const ids = value.map((entry) => telegramId(entry, field));
  if (new Set(ids).size !== ids.length) throw new Error(`${field}_invalid`);
  return ids;
}

function parseTelegram(value: unknown): TelegramChat | null {
  if (!value || typeof value !== "object") return null;
  try {
    const candidate = value as Record<string, unknown>;
    return {chatId: telegramId(candidate.chatId, "telegram_chat_id", true), participantIds: participantIds(candidate.participantIds, "telegram_participants")};
  } catch { return null; }
}

function element(value: unknown): ElementChat | null {
  if (!value || typeof value !== "object") return null;
  try {
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.homeserver !== "string" || candidate.homeserver.length > 300 || typeof candidate.roomReference !== "string" || candidate.roomReference.length > 700) return null;
    const homeserver = new URL(candidate.homeserver);
    if (homeserver.protocol !== "https:" || homeserver.username || homeserver.password || homeserver.search || homeserver.hash || homeserver.pathname !== "/") return null;
    let room = candidate.roomReference;
    if (room.startsWith("https://matrix.to/#/")) room = decodeURIComponent(room.slice("https://matrix.to/#/".length).split("?")[0]);
    if (!/^![A-Za-z0-9._~-]+:[A-Za-z0-9.-]+(?::[0-9]+)?$/.test(room)) return null;
    return {homeserver: homeserver.toString().replace(/\/$/, ""), roomReference: room};
  } catch { return null; }
}

export function parseProjectChatsState(value: unknown): ProjectChatsState {
  if (!value || typeof value !== "object") return emptyState();
  const candidate = value as Record<string, unknown>;
  if (candidate.contract !== "fai.project-chats.v1" || !Number.isInteger(candidate.revision) || (candidate.revision as number) < 0) return emptyState();
  const internal = parseTelegram(candidate.internal);
  let client: ClientChat | null = null;
  if (candidate.client && typeof candidate.client === "object") {
    const raw = candidate.client as Record<string, unknown>;
    const telegram = raw.provider === "telegram" ? parseTelegram(raw.telegram) : null;
    const matrix = raw.provider === "element" ? element(raw.element) : null;
    if (telegram) client = {provider: "telegram", telegram};
    if (matrix) client = {provider: "element", element: matrix};
  }
  return {contract: "fai.project-chats.v1", revision: candidate.revision as number, internal, client};
}

export function createProjectChatsState(input: unknown, prior: ProjectChatsState): ProjectChatsState {
  if (!input || typeof input !== "object") throw new Error("chat_configuration_required");
  const value = input as Record<string, unknown>;
  const internal = value.internalEnabled === true ? {
    chatId: telegramId(value.internalChatId, "internal_telegram_chat_id", true),
    participantIds: participantIds(value.internalParticipantIds, "internal_telegram_participants")
  } : null;
  let client: ClientChat | null = null;
  if (value.clientProvider === "telegram") {
    client = {provider: "telegram", telegram: {
      chatId: telegramId(value.clientTelegramChatId, "client_telegram_chat_id", true),
      participantIds: participantIds(value.clientTelegramParticipantIds, "client_telegram_participants")
    }};
  } else if (value.clientProvider === "element") {
    const parsed = element({homeserver: value.clientElementHomeserver, roomReference: value.clientElementRoomReference});
    if (!parsed) throw new Error("client_element_binding_invalid");
    client = {provider: "element", element: parsed};
  } else if (value.clientProvider !== "deferred") throw new Error("client_chat_provider_invalid");
  return {contract: "fai.project-chats.v1", revision: prior.revision + 1, internal, client};
}

export function projectChatsView(state: ProjectChatsState): ProjectChatsView {
  return {state, nativeCapability: "host_messenger_binding_required", reason: "Настройка сохранена, но текущая конфигурация Hermes ещё не подтверждена. Подготовьте host-файлы, актуальный контекст и примените сохранённые каналы. Отложенные каналы не считаются готовыми."};
}
