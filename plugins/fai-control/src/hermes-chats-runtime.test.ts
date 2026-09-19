import {afterEach, describe, expect, it} from "vitest";
import {chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile, realpath} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createProjectChatsState, parseProjectChatsState} from "./project-chats.js";
import {readChatRuntime, writeChatRuntime} from "./hermes-chats-runtime.js";
const roots: string[] = [];
afterEach(async () => {await Promise.all(roots.map(r => rm(r, {recursive: true, force: true}))); roots.length = 0;});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "fai-chats-"))); roots.push(root);
  const binding = {root, companyId: "company", projectId: "project", agentId: "agent", apiBaseUrl: "http://localhost:8642", runtimeWorkspace: "/opt/data/work/project"};
  await mkdir(join(root, "data")); await mkdir(join(root, "secrets")); await mkdir(join(root, "assets"));
  await writeFile(join(root, ".fai-project.json"), JSON.stringify(binding));
  await writeFile(join(root, "data/config.yaml"), "_config_version: 34\nmodel:\n  default: preserved-model\n");
  for (const [source, target] of [["profile-template/config.yaml", "internal-config.yaml"], ["client-profile-template/plugins/fai-client-issues/__init__.py", "__init__.py"], ["client-profile-template/plugins/fai-client-issues/plugin.yaml", "plugin.yaml"]]) await copyFile(join(process.cwd(), "../../infra/hermes-project", source), join(root, "assets", target));
  for (const [name, value] of [["internal-telegram-token", "123:internal_TEST"], ["client-telegram-token", "456:client_TEST"], ["client-matrix-user", "@bot:matrix.example"], ["client-matrix-password", "matrix_TEST_password"]]) await writeFile(join(root, "secrets", name), value, {mode: 0o600});
  const state = createProjectChatsState({internalEnabled: true, internalChatId: "-1001", internalParticipantIds: ["42"], clientProvider: "telegram", clientTelegramChatId: "-1002", clientTelegramParticipantIds: ["43"]}, parseProjectChatsState(null));
  return {root, binding, state, apply: (s = state) => writeChatRuntime(binding, s, "v1", join(root, "assets"))};
}
describe("host-owned native chat profiles", () => {
  it("reads back restricted scopes, preserves sessions and config, and keeps secrets off the manifest", async () => {
    const f = await fixture(); await f.apply();
    expect(await readChatRuntime(f.binding, f.state, "v1")).toBe(true);
    await chmod(join(f.root, "data/config.yaml"), 0o640);
    expect(await readChatRuntime(f.binding, f.state, "v1")).toBe(true);
    expect(await readChatRuntime(f.binding, {...f.state, revision: 2}, "v1")).toBe(false);
    expect(await readFile(join(f.root, "data/config.yaml"), "utf8")).toContain("preserved-model");
    expect(await readFile(join(f.root, "data/profiles/client/.env"), "utf8")).toContain("TELEGRAM_ALLOWED_USERS=43,42");
    expect(await readFile(join(f.root, "data/profiles/client/config.yaml"), "utf8")).not.toMatch(/terminal|client_issue/);
    expect(await readFile(join(f.root, "data/.fai-chats.json"), "utf8")).not.toContain("internal_TEST");
    await writeFile(join(f.root, "data/profiles/client/sessions.db"), "session-state");
    await f.apply({...f.state, revision: 2, client: null});
    expect(await readFile(join(f.root, "data/profiles/client/sessions.db"), "utf8")).toBe("session-state");
    expect(await readFile(join(f.root, "data/profiles/client/.env"), "utf8")).toBe("");
    expect((await lstat(join(f.root, "data/profiles/internal/.env"))).mode & 0o077).toBe(0);
    expect((await readdir(join(f.root, "data"))).some(p => /[a-f0-9]{8}-/.test(p))).toBe(false);
  });
  it("rejects unsafe secrets before writing any configuration", async () => {
    const f = await fixture(); await chmod(join(f.root, "secrets/client-telegram-token"), 0o644);
    await expect(f.apply()).rejects.toThrow("chat_host_secret_file_required");
    expect(await readdir(join(f.root, "data"))).toEqual(["config.yaml"]);
  });
  it("refuses symlinks and changed managed configuration", async () => {
    const f = await fixture(); await mkdir(join(f.root, "data/profiles")); await symlink(join(f.root, "assets"), join(f.root, "data/profiles/client"));
    await expect(f.apply()).rejects.toThrow("chat_symlink_forbidden");
    await rm(join(f.root, "data/profiles/client")); await f.apply();
    await writeFile(join(f.root, "data/profiles/client/config.yaml"), "toolsets: [terminal]\n");
    await expect(f.apply()).rejects.toThrow("chat_managed_state_conflict");
    await expect(readChatRuntime(f.binding, f.state, "v1")).rejects.toThrow("chat_managed_state_conflict");
  });
  it("normalizes Matrix links and rejects room aliases and dotenv injection", async () => {
    const f = await fixture();
    const input = {clientProvider: "element", clientElementHomeserver: "https://matrix.example", clientElementRoomReference: "https://matrix.to/#/!exact:matrix.example"};
    await f.apply(createProjectChatsState(input, f.state));
    const env = await readFile(join(f.root, "data/profiles/client/.env"), "utf8");
    expect(env).toContain("MATRIX_ALLOWED_ROOMS=!exact:matrix.example"); expect(env).not.toContain("ALLOWED_USERS");
    for (const room of ["#alias:matrix.example", "!room:matrix.example\nMATRIX_ALLOW_ALL_USERS=true", "https://evil.test/room"]) expect(() => createProjectChatsState({...input, clientElementRoomReference: room}, f.state)).toThrow();
  });
  it("rejects shared Telegram bot identities and newline secrets", async () => {
    const f = await fixture(); await writeFile(join(f.root, "secrets/client-telegram-token"), "123:internal_TEST");
    await expect(f.apply()).rejects.toThrow("chat_contours_must_be_distinct");
    await writeFile(join(f.root, "secrets/client-telegram-token"), "456:token\nTELEGRAM_ALLOW_ALL_USERS=true");
    await expect(f.apply()).rejects.toThrow("chat_host_secret_file_invalid");
  });
});
