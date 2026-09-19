import {configureTracker, parseTracker, recordTrackerReadback} from "./project-tracker.js";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { renderHermesContext } from "./hermes-instructions.js";
import { readChatRuntime, writeChatRuntime, chatSecretFiles } from "./hermes-chats-runtime.js";
import { docker, inspectOwned, projectRuntime, checkRuntime, installRuntime, restartRuntime, verifyRuntimeRepository, verifyRuntimeTracker } from "./hermes-lifecycle.js";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { definePlugin, runWorker, type PluginContext, type PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import { createRepositoryBinding, normalizeGitHubBranch, normalizeGitHubRepositoryUrl, parseRepositoryBinding,
  type ProjectRepositoryBindingView, type RepositoryAccess, type RepositoryBinding } from "./repository-binding.js";
import { createProjectTeamRoleMapping, parseProjectTeamRoleMapping, projectTeamRoleView,
  type ProjectTeamRoleView } from "./team-roles.js";
import { addProjectDocument, missingMandatoryDocuments, parseProjectDocumentState, prepareProjectContext,
  type ProjectDocumentState } from "./project-documents.js";
import { createProjectChatsState, parseProjectChatsState, projectChatsView, type ProjectChatsView } from "./project-chats.js";

import { hostBinding, assertNativeHermes, persistHermesContext, checkHermesAccess, parseHermesSetup, type HermesSetupView } from "./project-hermes.js";

const execFileAsync = promisify(execFile);
const stateKey = (projectId: string) => ({
  scopeKind: "project" as const,
  scopeId: projectId,
  namespace: "repository",
  stateKey: "binding"
});
const accessStateKey = (projectId: string) => ({
  scopeKind: "project" as const,
  scopeId: projectId,
  namespace: "repository",
  stateKey: "access"
});
const teamRolesStateKey = (projectId: string) => ({
  scopeKind: "project" as const,
  scopeId: projectId,
  namespace: "team",
  stateKey: "roles"
});
const documentsStateKey = (projectId: string) => ({
  scopeKind: "project" as const,
  scopeId: projectId,
  namespace: "documents",
  stateKey: "register"
});
const hermesBindingKey = (projectId: string) => ({scopeKind: "project" as const, scopeId: projectId, namespace: "hermes", stateKey: "host-binding"});
const hermesStateKey = (projectId: string) => ({scopeKind: "project" as const, scopeId: projectId, namespace: "hermes", stateKey: "setup"});
const trackerStateKey = (projectId: string) => ({scopeKind: "project" as const, scopeId: projectId, namespace: "tracker", stateKey: "binding"});
const chatsStateKey = (projectId: string) => ({scopeKind: "project" as const, scopeId: projectId, namespace: "chats", stateKey: "configuration"});
async function projectHostBinding(ctx: PluginContext, companyId: string, projectId: string, agentId: string) {
  const config = await ctx.config.get(companyId);
  const bindings = config.hermesHostBindings as Record<string, unknown> | undefined;
  if (bindings && Object.entries(bindings).some(([id, raw]) => id !== projectId && raw && typeof raw === "object" && (raw as {agentId?: unknown}).agentId === agentId)) throw new Error("hermes_identity_shared_between_projects");
  const stored = await ctx.state.get(hermesBindingKey(projectId));
  return hostBinding(stored ?? bindings?.[projectId], companyId, projectId, agentId);
}
async function hermesView(ctx: PluginContext, projectId: string, companyId: string): Promise<HermesSetupView> {
  await requireProject(ctx, projectId, companyId);
  const state = parseHermesSetup(await ctx.state.get(hermesStateKey(projectId)));
  const docs = parseProjectDocumentState(await ctx.state.get(documentsStateKey(projectId)));
  const base = {state, contextStale: !docs.context || docs.context.documentRevision !== docs.revision || state?.contextVersion !== docs.context.version, hostConfigured: false, connected: false, access: {oauth: false, github: false, ssh: false}, reason: null};
  if (!state) {
    const config = await ctx.config.get(companyId);
    const candidate = (await ctx.state.get(hermesBindingKey(projectId)) ?? (config.hermesHostBindings as Record<string, unknown> | undefined)?.[projectId]) as {agentId?: unknown} | undefined;
    try {
      if (typeof candidate?.agentId === "string") {
        const binding = await projectHostBinding(ctx, companyId, projectId, candidate.agentId);
        assertNativeHermes(await ctx.agents.get(binding.agentId, companyId), binding);
        await checkHermesAccess(binding);
        base.hostConfigured = true;
      }
    } catch { /* an incomplete host entry never enables connection */ }
    return base;
  }
  try {
    const binding = await projectHostBinding(ctx, companyId, projectId, state.agentId);
    base.hostConfigured = true;
    assertNativeHermes(await ctx.agents.get(state.agentId, companyId), binding);
    return {...base, connected: true, access: await checkHermesAccess(binding)};
  } catch {return {...base, reason: "Hermes identity, host ownership, or context pointer needs operator verification."};}
}
const documentMutationTails = new Map<string, Promise<void>>();

async function serializeDocumentMutation<T>(projectId: string, task: () => Promise<T>): Promise<T> {
  const previous = documentMutationTails.get(projectId) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const current = previous.then(() => new Promise<void>((resolve) => { release = resolve; }));
  documentMutationTails.set(projectId, current);
  await previous;
  try { return await task(); }
  finally {
    release?.();
    if (documentMutationTails.get(projectId) === current) documentMutationTails.delete(projectId);
  }
}

function inputString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string") throw new Error(`${key}_required`);
  return value;
}

async function requireProject(ctx: PluginContext, projectId: string, companyId: string) {
  if (!companyId) throw new Error("company_scope_required");
  const project = await ctx.projects.get(projectId, companyId);
  if (project === null) throw new Error("project_not_found");
  return project;
}

function actionCompany(params: Record<string, unknown>, context: PluginPerformActionContext): string {
  const companyId = context.companyId;
  if (!companyId) throw new Error("company_scope_required");
  if (typeof params.companyId === "string" && params.companyId !== companyId) throw new Error("company_scope_mismatch");
  return companyId;
}

async function requireHostOperator(ctx: PluginContext, context: PluginPerformActionContext, companyId: string) {
  if (context.actor.type !== "user" || !context.actor.userId) throw new Error("hermes_host_admin_required");
  const members = await ctx.access.members.list({companyId});
  if (!members.some(member => member.principalType === "user" && member.principalId === context.actor.userId && member.status === "active" && ["owner", "admin"].includes(member.membershipRole ?? ""))) throw new Error("hermes_host_admin_required");
}

async function readBinding(ctx: PluginContext, projectId: string): Promise<RepositoryBinding | null> {
  const binding = parseRepositoryBinding(await ctx.state.get(stateKey(projectId)));
  if (!binding) return null;
  const accessRecord = await ctx.state.get(accessStateKey(projectId));
  if (!accessRecord || typeof accessRecord !== "object") return binding;
  const candidate = accessRecord as {repositoryUrl?: unknown; ref?: unknown; access?: unknown};
  const access = candidate.access as Partial<RepositoryAccess> | undefined;
  if (candidate.repositoryUrl !== binding.repositoryUrl || candidate.ref !== binding.ref || !access ||
    (access.status !== "verified" && access.status !== "unverified")) return binding;
  return {...binding, access: {
    status: access.status,
    ...(typeof access.checkedAt === "string" ? {checkedAt: access.checkedAt} : {}),
    ...(access.reason === "git_unavailable" || access.reason === "access_denied_or_ref_missing" ||
      access.reason === "verification_timeout" ? {reason: access.reason} : {})
  }};
}

async function bindingView(ctx: PluginContext, projectId: string, companyId: string): Promise<ProjectRepositoryBindingView> {
  const project = await requireProject(ctx, projectId, companyId);
  const binding = await readBinding(ctx, projectId);
  const nativeUrl = project.codebase.repoUrl === null ? null : (() => {
    try { return normalizeGitHubRepositoryUrl(project.codebase.repoUrl).repositoryUrl; } catch { return null; }
  })();
  const nativeRef = project.codebase.repoRef ?? project.codebase.defaultRef;
  const nativeBranch = nativeRef === null ? null : (() => {
    try { return normalizeGitHubBranch(nativeRef).branch; } catch { return null; }
  })();
  return {binding, nativeWorkspace: {
    workspaceId: project.codebase.workspaceId,
    repositoryUrl: nativeUrl,
    branch: nativeBranch,
    matchesBinding: binding !== null && nativeUrl === binding.repositoryUrl && nativeBranch === binding.branch
  }};
}

async function teamRolesView(ctx: PluginContext, projectId: string, companyId: string): Promise<ProjectTeamRoleView> {
  await requireProject(ctx, projectId, companyId);
  const [members, stored] = await Promise.all([
    ctx.access.members.list({companyId}),
    ctx.state.get(teamRolesStateKey(projectId))
  ]);
  return projectTeamRoleView(members, parseProjectTeamRoleMapping(stored));
}

export type ProjectDocumentsView = Readonly<{
  state: ProjectDocumentState;
  missingMandatory: readonly ("passport" | "specification")[];
  contextStale: boolean;
}>;

async function documentsView(ctx: PluginContext, projectId: string, companyId: string): Promise<ProjectDocumentsView> {
  await requireProject(ctx, projectId, companyId);
  const state = parseProjectDocumentState(await ctx.state.get(documentsStateKey(projectId)));
  return {state, missingMandatory: missingMandatoryDocuments(state), contextStale: state.context !== null && state.context.documentRevision !== state.revision};
}

async function chatsView(ctx: PluginContext, projectId: string, companyId: string): Promise<ProjectChatsView> {
  await requireProject(ctx, projectId, companyId);
  const state = parseProjectChatsState(await ctx.state.get(chatsStateKey(projectId)));
  const view = {...projectChatsView(state), secretFiles: chatSecretFiles(state)};
  const setup = parseHermesSetup(await ctx.state.get(hermesStateKey(projectId)));
  if (!setup) return view;
  const docs = parseProjectDocumentState(await ctx.state.get(documentsStateKey(projectId)));
  if (!docs.context || docs.context.documentRevision !== docs.revision || setup.contextVersion !== docs.context.version) return view;
  const base = {...view, expectedHermesRevision: setup.revision, contextVersion: docs.context.version};
  try {
    const binding = await projectHostBinding(ctx, companyId, projectId, setup.agentId);
    assertNativeHermes(await ctx.agents.get(setup.agentId, companyId), binding);
    const runtime = await checkRuntime(projectRuntime(companyId, projectId));
    if ((state.internal || state.client) && runtime.status === "running" && runtime.runtime.apiBaseUrl === binding.apiBaseUrl && await readChatRuntime(binding, state, docs.context.version)) return {...base, nativeCapability: "configuration_verified", reason: "Конфигурация профилей прочитана с host, Hermes запущен. Доставка требует проверки сообщением. Создание клиентских задач недоступно до привязки трекера."};
  } catch { /* Never expose filesystem or provider errors containing private data. */ }
  return base;
}

function expectedVersion(params: Record<string, unknown>): number {
  const version = params.expectedVersion;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0) throw new Error("document_version_required");
  return version;
}

function idempotencyKey(params: Record<string, unknown>): string {
  const key = params.idempotencyKey;
  if (typeof key !== "string" || !/^[A-Za-z0-9:_-]{1,120}$/.test(key)) throw new Error("idempotency_key_invalid");
  return key;
}

async function verifyWithNativeGit(binding: RepositoryBinding): Promise<RepositoryAccess> {
  const command = process.env.FAI_GIT_BIN ||
    (process.platform === "darwin" && existsSync("/Library/Developer/CommandLineTools/usr/bin/git")
      ? "/Library/Developer/CommandLineTools/usr/bin/git" : "git");
  try {
    await execFileAsync(command, ["ls-remote", "--exit-code", binding.repositoryUrl, binding.ref], {
      timeout: 20_000,
      maxBuffer: 4 * 1024,
      env: {...process.env, GIT_TERMINAL_PROMPT: "0"}
    });
    return {status: "verified", checkedAt: new Date().toISOString()};
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? (error as {code?: unknown}).code : undefined;
    return {
      status: "unverified",
      checkedAt: new Date().toISOString(),
      reason: code === "ENOENT" ? "git_unavailable" : code === "ETIMEDOUT" ? "verification_timeout" : "access_denied_or_ref_missing"
    };
  }
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.data.register("project-tracker", async (params) => {
      await requireProject(ctx, inputString(params, "projectId"), inputString(params, "companyId"));
      return parseTracker(await ctx.state.get(trackerStateKey(inputString(params, "projectId"))));
    });
    ctx.actions.register("save-project-tracker", async (params, context) => {
      const companyId = actionCompany(params, context); const projectId = inputString(params, "projectId");
      await requireHostOperator(ctx, context, companyId); await requireProject(ctx, projectId, companyId);
      return serializeDocumentMutation(projectId, async () => {
        if (!await readBinding(ctx, projectId)) throw new Error("repository_required");
        const binding = configureTracker(params, parseTracker(await ctx.state.get(trackerStateKey(projectId))));
        await ctx.state.set(trackerStateKey(projectId), binding); return binding;
      });
    });
    ctx.actions.register("verify-project-tracker", async (params, context) => {
      const companyId = actionCompany(params, context); const projectId = inputString(params, "projectId");
      await requireHostOperator(ctx, context, companyId); await requireProject(ctx, projectId, companyId);
      return serializeDocumentMutation(projectId, async () => {
        const binding = parseTracker(await ctx.state.get(trackerStateKey(projectId)));
        if (params.expectedRevision !== binding.revision) throw new Error("tracker_revision_conflict");
        const repository = await bindingView(ctx, projectId, companyId);
        if (!repository.binding || !repository.nativeWorkspace.matchesBinding || !binding.externalProjectUrl) throw new Error("tracker_repository_or_project_required");
        let readback: Awaited<ReturnType<typeof verifyRuntimeTracker>> = {verified: false, projectId: null, checkedAt: new Date().toISOString()};
        try { readback = await verifyRuntimeTracker(projectRuntime(companyId, projectId), repository.binding.repositoryUrl, binding.externalProjectUrl); } catch { /* replace stale success with bounded failure */ }
        const next = recordTrackerReadback(binding, params.expectedRevision as number, repository.binding.repositoryUrl, readback);
        await ctx.state.set(trackerStateKey(projectId), next); return next;
      });
    });
    ctx.data.register("project-hermes-runtime", async (params) => {
      const companyId = inputString(params, "companyId"); const projectId = inputString(params, "projectId");
      await requireProject(ctx, projectId, companyId);
      const runtime = projectRuntime(companyId, projectId);
      const agents = await ctx.agents.list({companyId});
      const candidates = agents.filter(agent => agent.name === `${runtime.runtimeId} Hermes` && agent.adapterType === "hermes_gateway" && agent.status !== "terminated");
      if (candidates.length > 1) throw new Error("hermes_duplicate_identity_operator_action_required");
      return {...await checkRuntime(runtime), nativeAgentId: candidates[0]?.id ?? null};
    });
    ctx.actions.register("install-project-hermes-runtime", async (params, context) => {
      const companyId = actionCompany(params, context); const projectId = inputString(params, "projectId");
      await requireHostOperator(ctx, context, companyId);
      await requireProject(ctx, projectId, companyId);
      return serializeDocumentMutation(projectId, () => installRuntime(projectRuntime(companyId, projectId)));
    });
    ctx.actions.register("restart-project-hermes-runtime", async (params, context) => {
      const companyId = actionCompany(params, context); const projectId = inputString(params, "projectId");
      await requireHostOperator(ctx, context, companyId);
      await requireProject(ctx, projectId, companyId);
      const state = parseHermesSetup(await ctx.state.get(hermesStateKey(projectId)));
      if (!state || params.expectedRevision !== state.revision) throw new Error("hermes_version_conflict_refresh_required");
      const agent = await ctx.agents.get(state.agentId, companyId);
      if (!agent || agent.status !== "paused") throw new Error("hermes_pause_native_agent_before_restart");
      return serializeDocumentMutation(projectId, () => restartRuntime(projectRuntime(companyId, projectId)));
    });
    ctx.actions.register("verify-project-hermes-repository", async (params, context) => {
      const companyId = actionCompany(params, context); const projectId = inputString(params, "projectId");
      await requireHostOperator(ctx, context, companyId); await requireProject(ctx, projectId, companyId);
      const binding = await readBinding(ctx, projectId);
      if (!binding) throw new Error("repository_binding_not_configured");
      return serializeDocumentMutation(projectId, () => verifyRuntimeRepository(projectRuntime(companyId, projectId), binding.repositoryUrl, binding.ref));
    });
    ctx.actions.register("connect-installed-project-hermes", async (params, context) => {
      const companyId = actionCompany(params, context); const projectId = inputString(params, "projectId"); const agentId = inputString(params, "agentId");
      await requireHostOperator(ctx, context, companyId);
      await requireProject(ctx, projectId, companyId);
      return serializeDocumentMutation(projectId, async () => {
        const current = parseHermesSetup(await ctx.state.get(hermesStateKey(projectId)));
        if (current && current.agentId !== agentId) throw new Error("hermes_persistent_identity_conflict");
        const checked = await checkRuntime(projectRuntime(companyId, projectId));
        if (checked.status !== "running" || !checked.runtime.apiBaseUrl) throw new Error("hermes_running_gateway_required");
        const binding = hostBinding({...checked.runtime, agentId}, companyId, projectId, agentId);
        const agent = await ctx.agents.get(agentId, companyId);
        assertNativeHermes(agent, binding);
        if (agent?.name !== `${binding.runtimeWorkspace.split("/").at(-1)} Hermes`) throw new Error("hermes_native_project_name_mismatch");
        const markerPath = join(binding.root, ".fai-project.json");
        const marker = JSON.parse(await readFile(markerPath, "utf8"));
        if (marker.companyId !== companyId || marker.projectId !== projectId || (marker.agentId && marker.agentId !== agentId)) throw new Error("hermes_workspace_ownership_conflict");
        await writeFile(markerPath, JSON.stringify({...marker, agentId}), {mode: 0o600});
        await ctx.state.set(hermesBindingKey(projectId), binding);
        return hermesView(ctx, projectId, companyId);
      });
    });
    ctx.data.register("project-hermes-setup", async (params) => hermesView(ctx, inputString(params, "projectId"), inputString(params, "companyId")));
    ctx.actions.register("apply-project-hermes-context", async (params, context) => {
      const projectId = inputString(params, "projectId");
      const companyId = actionCompany(params, context);
      return serializeDocumentMutation(projectId, async () => {
        await requireHostOperator(ctx, context, companyId);
      await requireProject(ctx, projectId, companyId);
        const current = parseHermesSetup(await ctx.state.get(hermesStateKey(projectId)));
        const agentId = inputString(params, "agentId");
        if (current && current.agentId !== agentId) throw new Error("hermes_persistent_identity_conflict");
        if (params.expectedRevision !== (current?.revision ?? 0)) throw new Error("hermes_version_conflict_refresh_required");
        const binding = await projectHostBinding(ctx, companyId, projectId, agentId);
        assertNativeHermes(await ctx.agents.get(agentId, companyId), binding);
        const docs = parseProjectDocumentState(await ctx.state.get(documentsStateKey(projectId)));
        if (!docs.context || docs.context.documentRevision !== docs.revision || missingMandatoryDocuments(docs).length) throw new Error("hermes_current_context_required");
        if (params.contextVersion !== docs.context.version) throw new Error("hermes_context_version_conflict");
        await persistHermesContext(binding, docs.context);
        if (current?.contextVersion !== docs.context.version) await ctx.state.set(hermesStateKey(projectId), {agentId, revision: (current?.revision ?? 0) + 1, contextVersion: docs.context.version});
        return hermesView(ctx, projectId, companyId);
      });
    });
    ctx.data.register("project-repository-binding", async (params) => {
      const projectId = inputString(params, "projectId");
      const companyId = inputString(params, "companyId");
      return await bindingView(ctx, projectId, companyId);
    });
    ctx.data.register("project-team-roles", async (params) => {
      const projectId = inputString(params, "projectId");
      const companyId = inputString(params, "companyId");
      return await teamRolesView(ctx, projectId, companyId);
    });
    ctx.data.register("project-documents", async (params) => {
      const projectId = inputString(params, "projectId");
      const companyId = inputString(params, "companyId");
      return await documentsView(ctx, projectId, companyId);
    });
    ctx.data.register("project-hermes-chats", async (params) => chatsView(ctx, inputString(params, "projectId"), inputString(params, "companyId")));

    ctx.actions.register("save-project-repository-binding", async (params, context) => {
      const projectId = inputString(params, "projectId");
      const companyId = actionCompany(params, context);
      const project = await requireProject(ctx, projectId, companyId);
      const binding = createRepositoryBinding({
        repositoryUrl: inputString(params, "repositoryUrl"),
        branch: inputString(params, "branch")
      });
      if (project.codebase.repoUrl === null) throw new Error("native_workspace_repository_required");
      if (normalizeGitHubRepositoryUrl(project.codebase.repoUrl).repositoryUrl !== binding.repositoryUrl) {
        throw new Error("native_workspace_repository_mismatch");
      }
      const nativeRef = project.codebase.repoRef ?? project.codebase.defaultRef;
      if (nativeRef === null) throw new Error("native_workspace_ref_required");
      if (normalizeGitHubBranch(nativeRef).ref !== binding.ref) {
        throw new Error("native_workspace_ref_mismatch");
      }
      await ctx.state.set(stateKey(projectId), binding);
      return await bindingView(ctx, projectId, companyId);
    });

    ctx.actions.register("verify-project-repository-binding", async (params, context) => {
      const projectId = inputString(params, "projectId");
      const companyId = actionCompany(params, context);
      await requireProject(ctx, projectId, companyId);
      const binding = await readBinding(ctx, projectId);
      if (!binding) throw new Error("repository_binding_not_configured");
      const access = await verifyWithNativeGit(binding);
      await ctx.state.set(accessStateKey(projectId), {
        repositoryUrl: binding.repositoryUrl,
        ref: binding.ref,
        access
      });
      return await bindingView(ctx, projectId, companyId);
    });

    ctx.actions.register("save-project-team-roles", async (params, context) => {
      const projectId = inputString(params, "projectId");
      const companyId = actionCompany(params, context);
      await requireProject(ctx, projectId, companyId);
      const members = await ctx.access.members.list({companyId});
      const mapping = createProjectTeamRoleMapping(params, members);
      await ctx.state.set(teamRolesStateKey(projectId), mapping);
      return await teamRolesView(ctx, projectId, companyId);
    });
    ctx.actions.register("apply-project-hermes-chats", async (params, context) => {
      const companyId = actionCompany(params, context); const projectId = inputString(params, "projectId");
      await requireHostOperator(ctx, context, companyId); await requireProject(ctx, projectId, companyId);
      return serializeDocumentMutation(projectId, async () => {
        const state = parseProjectChatsState(await ctx.state.get(chatsStateKey(projectId)));
        const setup = parseHermesSetup(await ctx.state.get(hermesStateKey(projectId)));
        const docs = parseProjectDocumentState(await ctx.state.get(documentsStateKey(projectId)));
        if (!setup || params.expectedHermesRevision !== setup.revision || params.expectedRevision !== state.revision) throw new Error("chat_configuration_conflict_refresh_required");
        if (!docs.context || docs.context.documentRevision !== docs.revision || missingMandatoryDocuments(docs).length || setup.contextVersion !== docs.context.version || params.contextVersion !== docs.context.version) throw new Error("hermes_current_context_required");
        const binding = await projectHostBinding(ctx, companyId, projectId, setup.agentId);
        const agent = await ctx.agents.get(setup.agentId, companyId);
        assertNativeHermes(agent, binding);
        if (agent?.status !== "paused") throw new Error("hermes_pause_native_agent_before_restart");
        const contextPath = join(binding.root, "data", "work", binding.runtimeWorkspace.split("/").at(-1)!, ".fai-context/project.md");
        if (await readFile(contextPath, "utf8") !== renderHermesContext(docs.context)) throw new Error("hermes_current_context_required");
        const runtime = projectRuntime(companyId, projectId);
        const checked = await checkRuntime(runtime);
        if (checked.runtime.apiBaseUrl !== binding.apiBaseUrl) throw new Error("hermes_gateway_binding_mismatch");
        if (!await inspectOwned(runtime, "gateway", docker)) throw new Error("hermes_runtime_not_installed");
        // Stop the same owned gateway before changing multiple files. Failure leaves it stopped.
        const stopped = await docker("POST", `/containers/${runtime.runtimeId}-gateway/stop?t=10`);
        if (![204, 304].includes(stopped.status)) throw new Error("hermes_docker_operation_failed");
        try { await writeChatRuntime(binding, state, docs.context.version); }
        catch { throw new Error("chat_apply_failed_gateway_stopped_check_host_contract"); }
        const readbackAgent = await ctx.agents.get(setup.agentId, companyId);
        assertNativeHermes(readbackAgent, binding);
        if (readbackAgent?.status !== "paused") throw new Error("hermes_pause_native_agent_before_restart");
        await restartRuntime(runtime);
        return chatsView(ctx, projectId, companyId);
      });
    });
    ctx.actions.register("save-project-hermes-chats", async (params, context) => {
      const projectId = inputString(params, "projectId");
      const companyId = actionCompany(params, context);
      await requireHostOperator(ctx, context, companyId);
      await requireProject(ctx, projectId, companyId);
      return serializeDocumentMutation(projectId, async () => {
      const current = parseProjectChatsState(await ctx.state.get(chatsStateKey(projectId)));
      if (params.expectedRevision !== current.revision) throw new Error("chat_configuration_conflict_refresh_required");
      const next = createProjectChatsState(params, current);
      await ctx.state.set(chatsStateKey(projectId), next);
      return chatsView(ctx, projectId, companyId);
      });
    });
    ctx.actions.register("record-project-document", async (params, context) => {
      const projectId = inputString(params, "projectId");
      const companyId = actionCompany(params, context);
      return await serializeDocumentMutation(projectId, async () => {
        await requireProject(ctx, projectId, companyId);
        const asset = params.asset;
        if (!asset || typeof asset !== "object" || (asset as {companyId?: unknown}).companyId !== companyId) throw new Error("native_asset_company_mismatch");
        const state = parseProjectDocumentState(await ctx.state.get(documentsStateKey(projectId)));
        const key = idempotencyKey(params);
        if (!state.receipts[key] && expectedVersion(params) !== state.revision) throw new Error("document_version_conflict_refresh_required");
        const category = params.category;
        if (category !== "passport" && category !== "specification" && category !== "architecture" && category !== "other") throw new Error("document_category_invalid");
        const satisfies = Array.isArray(params.satisfies) ? params.satisfies : [];
        const next = addProjectDocument(state, {category, satisfies: satisfies as never[], asset, extraction: params.extraction, idempotencyKey: key, now: new Date().toISOString()});
        if (next !== state) await ctx.state.set(documentsStateKey(projectId), next);
        return await documentsView(ctx, projectId, companyId);
      });
    });
    ctx.actions.register("prepare-project-document-context", async (params, context) => {
      const projectId = inputString(params, "projectId");
      const companyId = actionCompany(params, context);
      return await serializeDocumentMutation(projectId, async () => {
        await requireProject(ctx, projectId, companyId);
        const state = parseProjectDocumentState(await ctx.state.get(documentsStateKey(projectId)));
        if (expectedVersion(params) !== state.revision) throw new Error("document_version_conflict_refresh_required");
        const next = prepareProjectContext(state, new Date().toISOString());
        await ctx.state.set(documentsStateKey(projectId), next);
        return await documentsView(ctx, projectId, companyId);
      });
    });
  },
  async onHealth() {
    return {status: "ok", message: "f(AI) repository binding is ready"};
  }
});

export default plugin;
runWorker(plugin, import.meta.url);
