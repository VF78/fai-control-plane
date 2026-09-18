import { afterEach, expect, test } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostBinding, assertNativeHermes, contextPointer, persistHermesContext, checkHermesAccess } from "./project-hermes.js";
let root = "";
afterEach(async () => {if (root) await rm(root, {recursive: true, force: true});});
async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "fai-hermes-")));
  root = join(base, "company", "project");
  await mkdir(root, {recursive: true});
  const binding = hostBinding({companyId: "company", projectId: "project", agentId: "hermes", root, apiBaseUrl: "http://127.0.0.1:8642", runtimeWorkspace: "/opt/data/work/runtime"}, "company", "project", "hermes", base);
  await mkdir(join(root, "data/work/runtime"), {recursive: true});
  await writeFile(join(root, ".fai-project.json"), JSON.stringify({companyId: "company", projectId: "project", agentId: "hermes"}));
  return binding;
}
const context = {contract: "fai.project-context.v1" as const, version: "v1", documentRevision: 1, preparedAt: "now", sourceDocumentIds: [], content: "Project requirements"};
test("context updates preserve memory and OAuth and are idempotent", async () => {
  const binding = await fixture();
  await mkdir(join(root, "codex-home"));
  await writeFile(join(root, "codex-home/auth.json"), "host-owned-test-marker");
  await writeFile(join(root, "data/work/runtime/memory.md"), "remember project");
  expect(await persistHermesContext(binding, context)).toBe(true);
  expect(await persistHermesContext(binding, context)).toBe(false);
  const {stat} = await import("node:fs/promises");
  expect((await stat(join(root, "data/work/runtime/.fai-context/project.md"))).uid).toBe((await stat(join(root, "data/work/runtime"))).uid);
  expect(await persistHermesContext(binding, {...context, version: "v2"})).toBe(true);
  expect(await readFile(join(root, "data/work/runtime/memory.md"), "utf8")).toBe("remember project");
  expect(await readFile(join(root, "codex-home/auth.json"), "utf8")).toBe("host-owned-test-marker");
  expect(await checkHermesAccess(binding)).toEqual({oauth: true, github: false, ssh: false});
});
test("rejects foreign owner and symlink context directory", async () => {
  const binding = await fixture();
  await expect(persistHermesContext({...binding, projectId: "foreign"}, context)).rejects.toThrow("ownership_conflict");
  await mkdir(join(root, "other"));
  await symlink(join(root, "other"), join(root, "data/work/runtime/.fai-context"));
  await expect(persistHermesContext(binding, context)).rejects.toThrow();
});
test("only the existing scoped gateway with explicit context pointer is accepted", async () => {
  const binding = await fixture();
  const agent = {id: "hermes", companyId: "company", adapterType: "hermes_gateway", status: "idle", adapterConfig: {apiBaseUrl: binding.apiBaseUrl, instructions: `Read ${contextPointer(binding)}`}};
  expect(() => assertNativeHermes(agent, binding)).not.toThrow();
  expect(() => assertNativeHermes({...agent, adapterType: "hermes_local"}, binding)).toThrow();
  expect(() => assertNativeHermes({...agent, adapterConfig: {}}, binding)).toThrow();
  expect(() => assertNativeHermes({...agent, companyId: "foreign"}, binding)).toThrow();
  expect(() => hostBinding({...binding, root: "/etc"}, "company", "project", "hermes")).toThrow("binding_invalid");
});
