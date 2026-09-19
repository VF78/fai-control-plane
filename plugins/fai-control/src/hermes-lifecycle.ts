import { normalizeGitHubRepositoryUrl } from "./repository-binding.js";
import { githubProject } from "./project-tracker.js";
import { request } from "node:http";
import { chmod, chown, lstat, mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
export const hermesImage = "fai-hermes-project:codex-0.153.4";
export type Docker = (method: string, path: string, body?: unknown) => Promise<{status: number; body: Buffer}>;
export const docker: Docker = (method, path, body) => new Promise((resolve, reject) => {
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const req = request({socketPath: "/var/run/docker.sock", path: `/v1.45${path}`, method, headers: payload ? {"Content-Type": "application/json", "Content-Length": payload.length} : {}}, res => {
    const chunks: Buffer[] = []; let length = 0;
    res.on("data", chunk => {length += chunk.length; if (length > 128 * 1024) req.destroy(new Error("docker_response_limit")); else chunks.push(chunk);});
    res.on("end", () => resolve({status: res.statusCode ?? 500, body: Buffer.concat(chunks)}));
  });
  req.on("error", () => reject(new Error("hermes_docker_unavailable")));
  req.setTimeout(20_000, () => req.destroy());
  if (payload) req.write(payload); req.end();
});
export type ProjectRuntime = {companyId: string; projectId: string; runtimeId: string; root: string; runtimeWorkspace: string; apiBaseUrl: string | null};
export type RuntimeCheck = {runtime: ProjectRuntime; status: "image_missing" | "auth_required" | "credentials_required" | "starting" | "running" | "stopped" | "not_installed"; deviceAuth: {verificationUrl: string; userCode: string} | null};
export function projectRuntime(companyId: string, projectId: string): ProjectRuntime {
  if (!/^[a-zA-Z0-9-]+$/.test(companyId) || !/^[a-zA-Z0-9-]+$/.test(projectId)) throw new Error("hermes_scope_invalid");
  const runtimeId = `fai-${createHash("sha256").update(`${companyId}:${projectId}`).digest("hex").slice(0, 24)}`;
  return {companyId, projectId, runtimeId, root: `/var/lib/fai-control/hermes/${companyId}/${projectId}`, runtimeWorkspace: `/opt/data/work/${runtimeId}`, apiBaseUrl: null};
}
export const labels = (runtime: ProjectRuntime, component: string) => ({"fai.control-plane.managed": "true", "fai.control-plane.workspace-id": runtime.companyId, "fai.control-plane.project-id": runtime.projectId, "fai.control-plane.runtime-id": runtime.runtimeId, "fai.control-plane.component": component});
const name = (runtime: ProjectRuntime, component: string) => `${runtime.runtimeId}-${component}`;
const expect = (status: number, allowed: number[]) => {if (!allowed.includes(status)) throw new Error("hermes_docker_operation_failed");};
export async function inspectOwned(runtime: ProjectRuntime, component: string, engine: Docker) {
  const result = await engine("GET", `/containers/${name(runtime, component)}/json`);
  if (result.status === 404) return null;
  expect(result.status, [200]);
  const container = JSON.parse(result.body.toString());
  if (!Object.entries(labels(runtime, component)).every(([key, value]) => container.Config?.Labels?.[key] === value)) throw new Error("hermes_docker_ownership_conflict");
  const imageResult = await engine("GET", `/images/${encodeURIComponent(hermesImage)}/json`); expect(imageResult.status, [200]);
  const image = JSON.parse(imageResult.body.toString());
  const desired = runtimeSpec(runtime, component === "auth" ? "auth" : "gateway", image.Id);
  if (container.Image !== image.Id || JSON.stringify(container.Config?.Cmd) !== JSON.stringify(desired.Cmd) ||
      JSON.stringify(container.Config?.Entrypoint) !== JSON.stringify(component === "auth" ? ["/usr/local/bin/fai-project-device-auth"] : image.Config?.Entrypoint) ||
      !desired.Env.every(value => container.Config?.Env?.includes(value)) ||
      Boolean(container.HostConfig?.Init) !== desired.HostConfig.Init) throw new Error("hermes_runtime_spec_conflict");
  const binds = container.HostConfig?.Binds;
  if (!Array.isArray(binds) || JSON.stringify([...binds].sort()) !== JSON.stringify([...desired.HostConfig.Binds].sort()) || container.HostConfig.NetworkMode !== `${runtime.runtimeId}-network`) throw new Error("hermes_persistent_mount_conflict");
  return container;
}
type GithubCredentialInitializer = (runtime: ProjectRuntime) => Promise<boolean>;
type GithubCredentialWriter = (target: string) => Promise<boolean>;
type CredentialHelper = (input: string) => Promise<Buffer>;

async function runHostGithubCredentialHelper(input: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.FAI_GH_BIN || "gh", ["auth", "git-credential", "get"], {
      env: {...process.env, HOME: process.env.HOME || homedir(), GH_PROMPT_DISABLED: "1"},
      stdio: ["pipe", "pipe", "ignore"]
    });
    const chunks: Buffer[] = []; let length = 0; let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const fail = () => {if (!settled) {settled = true; if (timer) clearTimeout(timer); reject(new Error("host_github_credential_unavailable"));}};
    child.stdout.on("data", (chunk: Buffer) => {
      length += chunk.length;
      if (length > 4 * 1024) {child.kill(); fail();} else chunks.push(chunk);
    });
    child.on("error", fail);
    child.stdin.on("error", fail);
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {fail(); return;}
      settled = true; if (timer) clearTimeout(timer); resolve(Buffer.concat(chunks));
    });
    timer = setTimeout(() => {child.kill(); fail();}, 10_000);
    child.stdin.end(input);
  });
}

export async function writeHostGithubCredential(target: string, helper: CredentialHelper = runHostGithubCredentialHelper): Promise<boolean> {
  const input = "protocol=https\nhost=github.com\n\n";
  const output = (await helper(input)).toString("utf8");
  const password = output.split(/\r?\n/).find(line => line.startsWith("password="))?.slice("password=".length).trim();
  if (!password || !/^[A-Za-z0-9_]{20,512}$/.test(password)) return false;
  await writeFile(target, `${password}\n`, {flag: "wx", mode: 0o600});
  return true;
}

/** Seed an isolated project credential once from the Paperclip service account's
 * standard gh store. The value is never logged or returned and an existing
 * project credential is never replaced. */
export async function initializeHostGithubCredential(runtime: ProjectRuntime, writeCredential: GithubCredentialWriter = writeHostGithubCredential): Promise<boolean> {
  const target = join(runtime.root, "secrets/github-token");
  if (await lstat(target).catch(() => null)) return false;
  try {
    let created = false;
    try {
      created = await writeCredential(target);
      if (!created) return false;
      await chown(target, 10000, 10000);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      if (created) await unlink(target).catch(() => {});
      throw error;
    }
  } catch {
    return false;
  }
}

export async function prepareHost(runtime: ProjectRuntime, initializeGithub: GithubCredentialInitializer = initializeHostGithubCredential) {
  // No deletion/replacement: a foreign marker or symlink is a hard stop.
  await mkdir(runtime.root, {recursive: true, mode: 0o700});
  if (await realpath(runtime.root) !== runtime.root) throw new Error("hermes_symlink_forbidden");
  const marker = join(runtime.root, ".fai-project.json");
  if ((await lstat(marker).catch(() => null))?.isSymbolicLink()) throw new Error("hermes_symlink_forbidden");
  let stored: Record<string, unknown> | null = null;
  try {stored = JSON.parse(await readFile(marker, "utf8"));} catch (error) {if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("hermes_workspace_ownership_conflict");}
  if (stored && (stored.companyId !== runtime.companyId || stored.projectId !== runtime.projectId)) throw new Error("hermes_workspace_ownership_conflict");
  if (!stored) await writeFile(marker, JSON.stringify({companyId: runtime.companyId, projectId: runtime.projectId, runtimeId: runtime.runtimeId}), {flag: "wx", mode: 0o600});
  for (const suffix of ["data", "data/home", "data/home/.ssh", "data/work", `data/work/${runtime.runtimeId}`, "codex-home", "secrets"]) {
    const directory = join(runtime.root, suffix); await mkdir(directory, {recursive: true, mode: 0o700});
    if (await realpath(directory) !== directory) throw new Error("hermes_symlink_forbidden");
    await chmod(directory, 0o700); await chown(directory, 10000, 10000);
  }
  const hermesConfig = join(runtime.root, "data/config.yaml");
  try {await writeFile(hermesConfig, `_config_version: 34\nmodel:\n  provider: openai-codex\n  default: gpt-5.6-terra\nauxiliary:\n  free_only: true\nterminal:\n  backend: local\n  cwd: ${runtime.runtimeWorkspace}\n`, {flag: "wx", mode: 0o600}); await chown(hermesConfig, 10000, 10000);} catch (error) {if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;}
  const config = join(runtime.root, "codex-home/config.toml");
  try {await writeFile(config, 'cli_auth_credentials_store = "file"\n', {flag: "wx", mode: 0o600}); await chown(config, 10000, 10000);} catch (error) {if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;}
  await initializeGithub(runtime);
}
async function filePresent(path: string) {try {const stat = await lstat(path); return stat.isFile() && stat.size > 0 && stat.uid === 10000 && (stat.mode & 0o077) === 0;} catch {return false;}}
export const runtimeSpec = (runtime: ProjectRuntime, component: "auth" | "gateway", imageId: string) => ({
  Image: imageId,
  ...(component === "auth" ? {User: "10000:10000", Entrypoint: ["/usr/local/bin/fai-project-device-auth"], Cmd: []} : {Cmd: ["sleep", "infinity"], WorkingDir: runtime.runtimeWorkspace}),
  Env: ["HOME=/opt/data", "CODEX_HOME=/opt/data/codex-home", ...(component === "gateway" ? ["HERMES_UID=10000", "HERMES_GID=10000", "HERMES_GATEWAY_BOOTSTRAP_STATE=running", "API_SERVER_ENABLED=true", "API_SERVER_HOST=0.0.0.0", "API_SERVER_PORT=8642", "HERMES_API_SERVER_KEY_FILE=/run/secrets/agent-delivery", "HERMES_GITHUB_REPOSITORY_TOKEN_FILE=/run/secrets/github-token"] : [])],
  Labels: labels(runtime, component),
  ExposedPorts: component === "gateway" ? {"8642/tcp": {}} : {},
  HostConfig: {NetworkMode: `${runtime.runtimeId}-network`, Binds: [`${runtime.root}/data:/opt/data`, `${runtime.root}/codex-home:/opt/data/codex-home`, ...(component === "gateway" ? [`${runtime.root}/secrets/agent-delivery:/run/secrets/agent-delivery:ro`, `${runtime.root}/secrets/github-token:/run/secrets/github-token:ro`, `${runtime.root}/secrets/ssh-private-key:/opt/data/home/.ssh/id_ed25519:ro`, `${runtime.root}/secrets/ssh-known-hosts:/opt/data/home/.ssh/known_hosts:ro`] : [])], Memory: 1_073_741_824, NanoCpus: 1_000_000_000, PidsLimit: 256, Init: component === "auth", RestartPolicy: {Name: component === "gateway" ? "unless-stopped" : "no"}, ...(component === "gateway" ? {PortBindings: {"8642/tcp": [{HostIp: "127.0.0.1", HostPort: ""}]}} : {})}
});
export async function checkRuntime(runtime: ProjectRuntime, engine: Docker = docker): Promise<RuntimeCheck> {
  const gateway = await inspectOwned(runtime, "gateway", engine);
  if (gateway) {
    const port = gateway.NetworkSettings?.Ports?.["8642/tcp"]?.[0];
    if (port?.HostIp !== "127.0.0.1" || !/^\d+$/.test(port.HostPort)) throw new Error("hermes_gateway_port_conflict");
    return {runtime: {...runtime, apiBaseUrl: `http://127.0.0.1:${port.HostPort}`}, status: gateway.State?.Running ? "running" : "stopped", deviceAuth: null};
  }
  const auth = await inspectOwned(runtime, "auth", engine);
  if (!auth) return {runtime, status: "not_installed", deviceAuth: null};
  if (await filePresent(join(runtime.root, "codex-home/auth.json")) && await filePresent(join(runtime.root, "data/auth.json"))) return {runtime, status: "credentials_required", deviceAuth: null};
  const logs = await engine("GET", `/containers/${name(runtime, "auth")}/logs?stdout=1&stderr=1&tail=40`); expect(logs.status, [200]);
  // Return only the device challenge, never raw authentication logs.
  const plain = logs.body.toString().replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
  const verificationUrl = [...plain.matchAll(/https:\/\/(?:auth\.openai\.com|chatgpt\.com)\/[^\s]+/g)].at(-1)?.[0];
  const userCode = [...plain.matchAll(/\b[A-Z0-9]{4,8}-[A-Z0-9]{4,8}\b/g)].at(-1)?.[0];
  return {runtime, status: "auth_required", deviceAuth: verificationUrl && userCode ? {verificationUrl, userCode} : null};
}
export async function installRuntime(runtime: ProjectRuntime, engine: Docker = docker, initializeGithub: GithubCredentialInitializer = initializeHostGithubCredential): Promise<RuntimeCheck> {
  const image = await engine("GET", `/images/${encodeURIComponent(hermesImage)}/json`);
  if (image.status === 404) return {runtime, status: "image_missing", deviceAuth: null}; expect(image.status, [200]);
  const imageId = JSON.parse(image.body.toString()).Id;
  if (typeof imageId !== "string" || !/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error("hermes_image_identity_invalid");
  await prepareHost(runtime, initializeGithub);
  const networkName = `${runtime.runtimeId}-network`;
  const network = await engine("GET", `/networks/${networkName}`);
  if (network.status === 404) {const created = await engine("POST", "/networks/create", {Name: networkName, Driver: "bridge", Labels: labels(runtime, "network")}); expect(created.status, [201]);}
  else {expect(network.status, [200]); const existing = JSON.parse(network.body.toString()); if (!Object.entries(labels(runtime, "network")).every(([key, value]) => existing.Labels?.[key] === value) || existing.Driver !== "bridge") throw new Error("hermes_network_ownership_conflict");}
  const oauth = await filePresent(join(runtime.root, "codex-home/auth.json")) && await filePresent(join(runtime.root, "data/auth.json"));
  const component = oauth ? "gateway" : "auth";
  if (oauth && !(await Promise.all(["agent-delivery", "github-token", "ssh-private-key", "ssh-known-hosts"].map(file => filePresent(join(runtime.root, "secrets", file))))).every(Boolean)) return {runtime, status: "credentials_required", deviceAuth: null};
  const existing = await inspectOwned(runtime, component, engine);
  if (!existing) {const created = await engine("POST", `/containers/create?name=${name(runtime, component)}`, runtimeSpec(runtime, component, imageId)); expect(created.status, [201]);}
  // Never remove or recreate an existing runtime, including expired device auth.
  if (!existing?.State?.Running) {const started = await engine("POST", `/containers/${name(runtime, component)}/start`); expect(started.status, [204, 304]);}
  return checkRuntime(runtime, engine);
}
export async function restartRuntime(runtime: ProjectRuntime, engine: Docker = docker) {
  if (!await inspectOwned(runtime, "gateway", engine)) throw new Error("hermes_runtime_not_installed");
  const response = await engine("POST", `/containers/${name(runtime, "gateway")}/restart?t=10`); expect(response.status, [204]);
  return checkRuntime(runtime, engine);
}

async function waitForExec(engine: Docker, id: string) {
  const deadline = Date.now() + 18_000;
  for (;;) {
    const checked = await engine("GET", `/exec/${id}/json`); expect(checked.status, [200]);
    const result = JSON.parse(checked.body.toString());
    if (result.Running === false) return result as {Running: false; ExitCode: number};
    if (Date.now() >= deadline) throw new Error("hermes_exec_timeout");
    await new Promise<void>(resolve => setTimeout(resolve, 100));
  }
}

async function runDetachedExec(runtime: ProjectRuntime, payload: Record<string, unknown>, engine: Docker) {
  const created = await engine("POST", `/containers/${name(runtime, "gateway")}/exec`, {
    ...payload, User: "10000:10000", AttachStdout: false, AttachStderr: false
  }); expect(created.status, [201]);
  const id = JSON.parse(created.body.toString()).Id;
  if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id)) throw new Error("hermes_exec_identity_invalid");
  const started = await engine("POST", `/exec/${id}/start`, {Detach: true, Tty: false}); expect(started.status, [200]);
  return waitForExec(engine, id);
}

/** Sends one bounded notification through the existing internal Hermes profile.
 * This is a direct platform command: it neither starts an agent run nor invokes a model. */
export async function sendInternalTelegramNotification(runtime: ProjectRuntime, chatId: string, message: string, engine: Docker = docker) {
  if (!/^-?\d{1,20}$/.test(chatId) || message.length === 0 || message.length > 1_000 || message.includes("\0")) throw new Error("hermes_notification_invalid");
  const owned = await inspectOwned(runtime, "gateway", engine);
  if (!owned?.State?.Running) throw new Error("hermes_runtime_not_running");
  const result = await runDetachedExec(runtime, {
    Env: ["HERMES_HOME=/opt/data/profiles/internal"],
    Cmd: ["timeout", "15", "hermes", "send", "--quiet", "--to", `telegram:${chatId}`, message]
  }, engine);
  if (result.ExitCode !== 0) throw new Error("hermes_notification_delivery_failed");
}

export async function verifyRuntimeRepository(runtime: ProjectRuntime, httpsUrl: string, ref: string, engine: Docker = docker) {
  if (!await inspectOwned(runtime, "gateway", engine)) throw new Error("hermes_runtime_not_installed");
  const repository = normalizeGitHubRepositoryUrl(httpsUrl);
  if (!/^refs\/heads\/[A-Za-z0-9_./-]+$/.test(ref)) throw new Error("hermes_repository_binding_invalid");
  const sshUrl = `git@github.com:${repository.owner}/${repository.repository}.git`;
  const result = await runDetachedExec(runtime, {
    Env: ["HOME=/opt/data/home", "GH_CONFIG_DIR=/opt/data/home/.config/gh", "GIT_TERMINAL_PROMPT=0", "GIT_SSH_COMMAND=ssh -i /opt/data/home/.ssh/id_ed25519 -o UserKnownHostsFile=/opt/data/home/.ssh/known_hosts -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes"],
    Cmd: ["timeout", "15", "sh", "-c", 'gh auth status >/dev/null 2>&1 && git ls-remote --exit-code "$1" "$3" >/dev/null 2>&1 && git ls-remote --exit-code "$2" "$3" >/dev/null 2>&1', "fai-repository-check", httpsUrl, sshUrl, ref]
  }, engine);
  return {verified: result.Running === false && result.ExitCode === 0, checkedAt: new Date().toISOString()};
}

/** Read-only host diagnostic in the existing persistent Hermes executor; never a GitHub mutation broker. */
export async function verifyRuntimeTracker(runtime: ProjectRuntime, repositoryUrl: string, projectUrl: string, engine: Docker = docker) {
  const project = githubProject(projectUrl);
  const repository = normalizeGitHubRepositoryUrl(repositoryUrl);
  const owned = await inspectOwned(runtime, "gateway", engine);
  if (!owned?.State?.Running) throw new Error("hermes_runtime_not_running");
  const result = await runDetachedExec(runtime, {
    Env: ["HOME=/opt/data/home", "GH_CONFIG_DIR=/opt/data/home/.config/gh", "GH_PROMPT_DISABLED=1"],
    Cmd: ["timeout", "15", "sh", "-c", 'gh repo view "$1" --json nameWithOwner >/dev/null 2>&1 && gh project view "$2" --owner "$3" >/dev/null 2>&1', "fai-tracker-check", `${repository.owner}/${repository.repository}`, project.number, project.owner]
  }, engine);
  return {verified: result.Running === false && result.ExitCode === 0, projectId: null, checkedAt: new Date().toISOString()};
}
