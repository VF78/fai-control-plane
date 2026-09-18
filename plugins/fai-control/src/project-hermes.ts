import { randomUUID } from "node:crypto";
import { chown, lstat, mkdir, readFile, realpath, rename, writeFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { renderHermesContext } from "./hermes-instructions.js";
import type { ProjectDocumentContext } from "./project-documents.js";

export type HermesHostBinding = {companyId: string; projectId: string; agentId: string; root: string; apiBaseUrl: string; runtimeWorkspace: string};
export type HermesSetupState = {agentId: string; revision: number; contextVersion: string | null};
export type HermesSetupView = {state: HermesSetupState | null; contextStale: boolean; hostConfigured: boolean; connected: boolean; access: {oauth: boolean; github: boolean; ssh: boolean}; reason: string | null};
export function hostBinding(raw: unknown, companyId: string, projectId: string, agentId: string, baseRoot = "/var/lib/fai-control/hermes"): HermesHostBinding {
  if (!/^[a-zA-Z0-9-]+$/.test(companyId) || !/^[a-zA-Z0-9-]+$/.test(projectId)) throw new Error("hermes_scope_invalid");
  if (!raw || typeof raw !== "object") throw new Error("hermes_host_binding_required");
  const value = raw as Record<string, unknown>;
  if (value.companyId !== companyId || value.projectId !== projectId || value.agentId !== agentId ||
      typeof value.root !== "string" || !value.root.startsWith("/") || resolve(value.root) !== value.root || value.root !== join(baseRoot, companyId, projectId) ||
      typeof value.apiBaseUrl !== "string" || !/^https?:\/\//.test(value.apiBaseUrl) ||
      typeof value.runtimeWorkspace !== "string" || !/^\/opt\/data\/work\/[a-z0-9-]+$/.test(value.runtimeWorkspace)) throw new Error("hermes_host_binding_invalid");
  const url = new URL(value.apiBaseUrl as string);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) throw new Error("hermes_gateway_url_invalid");
  return value as HermesHostBinding;
}
export const contextPointer = (binding: HermesHostBinding) => `${binding.runtimeWorkspace}/.fai-context/project.md`;
export function assertNativeHermes(agent: {id: string; companyId: string; adapterType: string; adapterConfig: Record<string, unknown>; status: string} | null, binding: HermesHostBinding) {
  if (!agent || agent.id !== binding.agentId || agent.companyId !== binding.companyId || agent.adapterType !== "hermes_gateway" || agent.status === "terminated") throw new Error("hermes_native_identity_invalid");
  if (agent.adapterConfig.apiBaseUrl !== binding.apiBaseUrl) throw new Error("hermes_gateway_binding_mismatch");
  const instructions = agent.adapterConfig.instructions;
  if (typeof instructions !== "string" || !instructions.includes(contextPointer(binding))) throw new Error("hermes_context_pointer_required");
}
async function ownedWorkspace(binding: HermesHostBinding) {
  const root = await realpath(binding.root);
  if (root !== binding.root) throw new Error("hermes_symlink_forbidden");
  const marker = JSON.parse(await readFile(join(root, ".fai-project.json"), "utf8"));
  if (marker.companyId !== binding.companyId || marker.projectId !== binding.projectId || marker.agentId !== binding.agentId) throw new Error("hermes_workspace_ownership_conflict");
  const workspace = join(root, "data", "work", binding.runtimeWorkspace.split("/").at(-1)!);
  if (await realpath(workspace) !== workspace) throw new Error("hermes_symlink_forbidden");
  return workspace;
}
export async function persistHermesContext(binding: HermesHostBinding, context: ProjectDocumentContext) {
  const workspace = await ownedWorkspace(binding);
  const owner = await lstat(workspace);
  const directory = join(workspace, ".fai-context");
  await mkdir(directory, {recursive: true, mode: 0o700});
  if ((await lstat(directory)).isSymbolicLink() || await realpath(directory) !== directory) throw new Error("hermes_symlink_forbidden");
  await chown(directory, owner.uid, owner.gid);
  const content = renderHermesContext(context);
  const target = join(directory, "project.md");
  const prior = await lstat(target).catch(() => null);
  if (prior?.isFile() && prior.uid === owner.uid && prior.gid === owner.gid && (prior.mode & 0o777) === 0o600 && await readFile(target, "utf8") === content) return false;
  const temporary = join(directory, `.project-${randomUUID()}`);
  try { await writeFile(temporary, content, {mode: 0o600, flag: "wx"}); await chown(temporary, owner.uid, owner.gid); await rename(temporary, target); }
  finally { await unlink(temporary).catch(() => {}); }
  return true;
}
export async function checkHermesAccess(binding: HermesHostBinding) {
  await ownedWorkspace(binding);
  const regular = async (path: string) => { try {const stat = await lstat(path); return stat.isFile() && !stat.isSymbolicLink() && stat.size > 0;} catch {return false;} };
  // Presence is deliberately not a claim of remote authorization or paid-provider readiness.
  return {oauth: await regular(join(binding.root, "codex-home", "auth.json")), github: await regular(join(binding.root, "secrets", "github-token")), ssh: await regular(join(binding.root, "secrets", "ssh-private-key"))};
}
export function parseHermesSetup(raw: unknown): HermesSetupState | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.agentId !== "string" || !Number.isInteger(value.revision) || Number(value.revision) < 1 || (value.contextVersion !== null && typeof value.contextVersion !== "string")) return null;
  return value as HermesSetupState;
}
