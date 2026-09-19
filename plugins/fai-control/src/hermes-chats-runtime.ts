import {createHash, randomUUID} from "node:crypto";
import {chown, lstat, mkdir, readFile, realpath, rename, unlink, writeFile} from "node:fs/promises";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import type {HermesHostBinding} from "./project-hermes.js";
import {parseProjectChatsState, type ProjectChatsState} from "./project-chats.js";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const markerName = ".fai-chats.json";
type Manifest = {agentId: string; revision: number; contextVersion: string; base: string; files: Record<string, string>; signature: string};
const signature = (state: ProjectChatsState) => hash(JSON.stringify(state));
export const chatSecretFiles = (state: ProjectChatsState) => [
  ...(state.internal ? ["internal-telegram-token"] : []),
  ...(state.client?.provider === "telegram" ? ["client-telegram-token"] : []),
  ...(state.client?.provider === "element" ? ["client-matrix-user", "client-matrix-password"] : [])
];
async function safePath(root: string, relative: string) {
  const path = join(root, relative);
  let parent = path;
  while (parent !== root) {
    const stat = await lstat(parent).catch((e: NodeJS.ErrnoException) => {if (e.code === "ENOENT") return null; throw e;});
    if (stat?.isSymbolicLink()) throw new Error("chat_symlink_forbidden");
    if (stat && !stat.isFile() && !stat.isDirectory()) throw new Error("chat_unsupported_file_type");
    parent = dirname(parent);
  }
  return path;
}
async function owned(binding: HermesHostBinding) {
  if (await realpath(binding.root) !== binding.root) throw new Error("chat_symlink_forbidden");
  const marker = JSON.parse(await readFile(await safePath(binding.root, ".fai-project.json"), "utf8"));
  if (marker.companyId !== binding.companyId || marker.projectId !== binding.projectId || marker.agentId !== binding.agentId) throw new Error("chat_host_ownership_conflict");
  const data = await safePath(binding.root, "data");
  const owner = await lstat(data);
  if (!owner.isDirectory()) throw new Error("chat_host_ownership_conflict");
  return {data, owner};
}
async function loadManifest(binding: HermesHostBinding): Promise<Manifest | null> {
  try {
    const m = JSON.parse(await readFile(await safePath(binding.root, `data/${markerName}`), "utf8")) as Manifest;
    if (m.agentId !== binding.agentId || typeof m.base !== "string" || !m.files || Object.entries(m.files).some(([p, h]) => !/^(?:config\.yaml|profiles\/(?:internal|client)\/(?:\.env|config\.yaml|SOUL\.md|plugins\/fai-client-issues\/(?:__init__\.py|plugin\.yaml)))$/.test(p) || !/^[a-f0-9]{64}$/.test(h))) throw new Error("chat_managed_state_conflict");
    return m;
  } catch (e) {if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw new Error("chat_managed_state_conflict");}
}
async function verifyFiles(binding: HermesHostBinding, m: Manifest) {
  const owner = await lstat(join(binding.root, "data"));
  for (const [path, digest] of Object.entries(m.files)) {
    const full = await safePath(binding.root, `data/${path}`);
    const stat = await lstat(full);
    const unsafePermissions = path === "config.yaml" ? (stat.mode & 0o037) !== 0 : (stat.mode & 0o077) !== 0;
    if (!stat.isFile() || stat.uid !== owner.uid || stat.gid !== owner.gid || unsafePermissions || hash(await readFile(full, "utf8")) !== digest) throw new Error("chat_managed_state_conflict");
  }
}
export async function readChatRuntime(binding: HermesHostBinding, state: ProjectChatsState, contextVersion: string) {
  await owned(binding);
  const m = await loadManifest(binding);
  if (!m || m.revision !== state.revision || m.contextVersion !== contextVersion || m.signature !== signature(state)) return false;
  await verifyFiles(binding, m);
  return true;
}
export async function writeChatRuntime(binding: HermesHostBinding, state: ProjectChatsState, contextVersion: string,
  assets = join(dirname(fileURLToPath(import.meta.url)), "chat-assets")) {
  if (JSON.stringify(parseProjectChatsState(state)) !== JSON.stringify(state)) throw new Error("chat_metadata_invalid");
  const {data, owner} = await owned(binding);
  const prior = await loadManifest(binding);
  if (prior) await verifyFiles(binding, prior);
  if (!prior) {
    for (const profile of ["internal", "client"]) if (await lstat(await safePath(binding.root, `data/profiles/${profile}`)).catch(() => null)) throw new Error("chat_foreign_profile_configuration");
    const rootEnv = await readFile(await safePath(binding.root, "data/.env"), "utf8").catch((e: NodeJS.ErrnoException) => {if (e.code === "ENOENT") return ""; throw e;});
    if (/^\s*(?:export\s+)?(?:TELEGRAM_|MATRIX_)/m.test(rootEnv)) throw new Error("chat_foreign_gateway_configuration");
  }
  const configPath = await safePath(binding.root, "data/config.yaml");
  const base = prior?.base ?? await readFile(configPath, "utf8");
  if (!prior && /^(?:gateway|profiles)\s*:/m.test(base)) throw new Error("chat_foreign_gateway_configuration");
  const secrets: Record<string, string> = {};
  for (const name of chatSecretFiles(state)) {
    const path = await safePath(binding.root, `secrets/${name}`);
    const stat = await lstat(path).catch(() => null);
    if (!stat?.isFile() || ![0, owner.uid].includes(stat.uid) || (stat.mode & 0o077) || stat.size > 4096) throw new Error("chat_host_secret_file_required");
    const value = (await readFile(path, "utf8")).replace(/\r?\n$/, "");
    if (!value || !/^[\x21-\x7e]+$/.test(value) || /['"\\`$#]/.test(value)) throw new Error("chat_host_secret_file_invalid");
    if (name.endsWith("telegram-token") && !/^\d+:[A-Za-z0-9_-]+$/.test(value)) throw new Error("chat_host_secret_file_invalid");
    if (name === "client-matrix-user" && !/^@[^:]+:[A-Za-z0-9.-]+(?::\d+)?$/.test(value)) throw new Error("chat_host_secret_file_invalid");
    secrets[name] = value;
  }
  const files: Record<string, string> = {};
  // Install the retained issue tool assets, but do not enable their external tracker
  // mutation until an explicit project tracker binding is available.
  const routes: {name: string; platform: string; chat_id: string; profile: string}[] = [];
  const telegramEnv = (token: string, chat: string, users: readonly string[]) => `TELEGRAM_BOT_TOKEN=${token}\nTELEGRAM_ALLOWED_USERS=${users.join(",")}\nTELEGRAM_GROUP_ALLOWED_USERS=${users.join(",")}\nTELEGRAM_ALLOWED_CHATS=${chat}\nTELEGRAM_GROUP_ALLOWED_CHATS=${chat}\n`;
  if (state.internal) {
    routes.push({name: "fai-internal", platform: "telegram", chat_id: state.internal.chatId, profile: "internal"});
    files["profiles/internal/.env"] = telegramEnv(secrets["internal-telegram-token"], state.internal.chatId, state.internal.participantIds);
    files["profiles/internal/config.yaml"] = (await readFile(join(assets, "internal-config.yaml"), "utf8")).replace("/opt/data/work/project", binding.runtimeWorkspace);
    files["profiles/internal/SOUL.md"] = `You are the internal project Hermes. Read ${binding.runtimeWorkspace}/.fai-context/project.md before project work. Follow its process and approval gates. Never operate another project.\n`;
  }
  if (state.client) {
    const c = state.client;
    if (c.provider === "telegram") {
      if (c.telegram.chatId === state.internal?.chatId || secrets["client-telegram-token"] === secrets["internal-telegram-token"]) throw new Error("chat_contours_must_be_distinct");
      routes.push({name: "fai-client", platform: "telegram", chat_id: c.telegram.chatId, profile: "client"});
      files["profiles/client/.env"] = telegramEnv(secrets["client-telegram-token"], c.telegram.chatId, [...new Set([...c.telegram.participantIds, ...state.internal?.participantIds ?? []])]);
    } else {
      routes.push({name: "fai-client", platform: "matrix", chat_id: c.element.roomReference, profile: "client"});
      files["profiles/client/.env"] = `MATRIX_USER_ID=${secrets["client-matrix-user"]}\nMATRIX_PASSWORD=${secrets["client-matrix-password"]}\nMATRIX_HOMESERVER=${c.element.homeserver}\nMATRIX_ALLOWED_ROOMS=${c.element.roomReference}\nMATRIX_ALLOW_ALL_USERS=true\nMATRIX_REQUIRE_MENTION=true\nMATRIX_DEVICE_ID=FCP_CLIENT\nMATRIX_E2EE_MODE=off\n`;
    }
    files["profiles/client/config.yaml"] = `_config_version: 34\nplugins:\n  enabled: []\nagent:\n  max_turns: 12\nplatform_toolsets:\n  telegram: [clarify]\n  matrix: [clarify]\ntoolsets: [clarify]\n`;
    files["profiles/client/SOUL.md"] = "Use only facts from this client conversation. Answer and clarify. Never access internal context, history, files, credentials, tools, approvals or deployment. Issue reporting is unavailable until the project tracker is configured; never claim a report was created.\n";
    for (const name of ["__init__.py", "plugin.yaml"]) files[`profiles/client/plugins/fai-client-issues/${name}`] = await readFile(join(assets, name), "utf8");
  }
  // Disabled contours keep their sessions, but lose credentials and executable routes.
  for (const profile of ["internal", "client"]) if (!routes.some(r => r.profile === profile) && prior?.files[`profiles/${profile}/.env`]) files[`profiles/${profile}/.env`] = "";
  files["config.yaml"] = `${base.trimEnd()}\ngateway:\n  multiplex_profiles: true\n  multiplex_profile_allowlist: ${JSON.stringify(routes.map(r => r.profile))}\n  profile_routes: ${JSON.stringify(routes)}\n`;
  // Validate the entire write set before touching any target. Existing unowned files are a hard stop.
  for (const relative of Object.keys(files)) {
    const path = await safePath(binding.root, `data/${relative}`);
    if (relative !== "config.yaml" && !prior?.files[relative] && await lstat(path).catch(() => null)) throw new Error("chat_foreign_profile_configuration");
  }
  const next: Manifest = {agentId: binding.agentId, revision: state.revision, contextVersion, base, files: {...prior?.files}, signature: signature(state)};
  const atomic = async (relative: string, content: string) => {
    const target = await safePath(binding.root, `data/${relative}`);
    await mkdir(dirname(target), {recursive: true, mode: 0o700});
    // Every newly created parent must be accessible by the runtime UID.
    for (let p = dirname(target); p !== data; p = dirname(p)) await chown(p, owner.uid, owner.gid);
    const tmp = `${target}.${randomUUID()}`;
    try {await writeFile(tmp, content, {flag: "wx", mode: 0o600}); await chown(tmp, owner.uid, owner.gid); await rename(tmp, target);} finally {await unlink(tmp).catch(() => {});}
  };
  for (const [path, content] of Object.entries(files)) {await atomic(path, content); next.files[path] = hash(content);}
  await atomic(markerName, JSON.stringify(next));
  if (!await readChatRuntime(binding, state, contextVersion)) throw new Error("chat_readback_failed");
}
