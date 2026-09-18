import { expect, test, vi } from "vitest";
vi.mock("node:fs/promises", () => ({
  chmod: vi.fn(), chown: vi.fn(), mkdir: vi.fn(), writeFile: vi.fn(),
  realpath: vi.fn(async (value: string) => value),
  lstat: vi.fn(async () => {throw Object.assign(new Error(), {code: "ENOENT"});}),
  readFile: vi.fn(async () => {throw Object.assign(new Error(), {code: "ENOENT"});})
}));
import { checkRuntime, installRuntime, inspectOwned, labels, projectRuntime, restartRuntime, runtimeSpec, verifyRuntimeRepository, type Docker } from "./hermes-lifecycle.js";
const runtime = projectRuntime("company", "project");
const image = {Id: `sha256:${"a".repeat(64)}`, Config: {Entrypoint: ["/init"]}};
const response = (status: number, body: unknown = {}) => ({status, body: Buffer.from(typeof body === "string" ? body : JSON.stringify(body))});
const container = (component: "auth" | "gateway") => {
  const spec = runtimeSpec(runtime, component, image.Id);
  return {Image: image.Id, Config: {...spec, Entrypoint: component === "auth" ? ["/usr/local/bin/fai-project-device-auth"] : ["/init"]}, HostConfig: spec.HostConfig, State: {Running: true}, NetworkSettings: {Ports: {"8642/tcp": [{HostIp: "127.0.0.1", HostPort: "42000"}]}}};
};
test("missing exact pinned image is explicit and does not mutate Docker", async () => {
  const engine = vi.fn<Docker>(async () => response(404));
  expect((await installRuntime(runtime, engine)).status).toBe("image_missing");
  expect(engine.mock.calls).toHaveLength(1);
});
test("install creates exact owned resources and returns only the device challenge", async () => {
  let auth = false;
  const engine = vi.fn<Docker>(async (method, path) => {
    if (path.startsWith("/images/")) return response(200, image);
    if (path === "/networks/create") return response(201);
    if (path.startsWith("/networks/")) return response(404);
    if (path.includes("/containers/create")) {auth = true; return response(201);}
    if (path.includes("-auth/json")) return auth ? response(200, container("auth")) : response(404);
    if (path.includes("-auth/start")) return response(204);
    if (path.includes("/logs?")) return response(200, "noise that must not be returned https://auth.openai.com/codex/device ABCD-EFGH");
    return response(404);
  });
  const checked = await installRuntime(runtime, engine);
  expect(checked.status).toBe("auth_required");
  expect(checked.deviceAuth).toEqual({verificationUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-EFGH"});
  const created = engine.mock.calls.find(([method, path]) => method === "POST" && path.includes("/containers/create"));
  expect(created?.[2]).toMatchObject({Image: image.Id, Labels: labels(runtime, "auth")});
  expect(engine.mock.calls.every(([, path]) => !path.includes("prune") && !path.includes("containers/json"))).toBe(true);
  expect(JSON.stringify(checked)).not.toContain("noise");
});
test("restart rejects foreign labels, changed image or persistent mounts before mutation", async () => {
  for (const mutated of [
    {...container("gateway"), Image: `sha256:${"b".repeat(64)}`},
    {...container("gateway"), HostConfig: {Binds: [], NetworkMode: `${runtime.runtimeId}-network`}},
    {...container("gateway"), Config: {Labels: {...labels(runtime, "gateway"), "fai.control-plane.project-id": "foreign"}}}
  ]) {
    const engine = vi.fn<Docker>(async (_, path) => response(200, path.startsWith("/images/") ? image : mutated));
    await expect(restartRuntime(runtime, engine)).rejects.toThrow();
    expect(engine.mock.calls.every(([method]) => method === "GET")).toBe(true);
  }
});
test("owned restart preserves exact mounts and never creates or deletes resources", async () => {
  const engine = vi.fn<Docker>(async (method, path) => method === "POST" ? response(204) : response(200, path.startsWith("/images/") ? image : container("gateway")));
  expect((await restartRuntime(runtime, engine)).status).toBe("running");
  expect(engine.mock.calls.filter(([method]) => method === "POST").map(([, path]) => path)).toEqual([`/containers/${runtime.runtimeId}-gateway/restart?t=10`]);
  expect((await checkRuntime(runtime, engine)).runtime.apiBaseUrl).toBe("http://127.0.0.1:42000");
});


test("canonical repository URL verifies HTTPS and SSH without requiring .git", async () => {
  const id = "c".repeat(64);
  const engine = vi.fn<Docker>(async (method, path) => {
    if (path.startsWith("/images/")) return response(200, image);
    if (path.endsWith("/exec")) return response(201, {Id: id});
    if (path.endsWith("/start")) return response(200);
    if (path === `/exec/${id}/json`) return response(200, {Running: false, ExitCode: 0});
    return response(200, container("gateway"));
  });
  expect((await verifyRuntimeRepository(runtime, "https://github.com/VF78/fai-control-plane", "refs/heads/main", engine)).verified).toBe(true);
  const command = (engine.mock.calls.find(([, path]) => path.endsWith("/exec"))?.[2] as {Cmd: string[]}).Cmd;
  expect(command.slice(-3)).toEqual(["https://github.com/VF78/fai-control-plane", "git@github.com:VF78/fai-control-plane.git", "refs/heads/main"]);
});

test("native instruction retry preserves original text and uses real newlines", async () => {
  const {mergeHermesInstructions, renderHermesContext} = await import("./hermes-instructions.js");
  const original = "Approved project instructions.\nKeep existing memory.";
  const added = "Read /opt/data/work/runtime/.fai-context/project.md";
  const once = mergeHermesInstructions(original, added);
  expect(once).toBe(`${original}\n${added}`);
  expect(once).not.toContain("\\n");
  expect(mergeHermesInstructions(once, added)).toBe(once);
  expect(mergeHermesInstructions(added, added)).toBe(added);
  const context = renderHermesContext({contract: "fai.project-context.v1", version: "v1", documentRevision: 1, preparedAt: "now", sourceDocumentIds: [], content: "Approved requirements."});
  expect(context).toContain("# Project execution policy\nHermes owns");
  expect(context).toContain("\n\n# Prepared project context\nVersion: v1\n\nApproved requirements.\n");
  expect(context).not.toContain("\\n");
});
