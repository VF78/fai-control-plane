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
