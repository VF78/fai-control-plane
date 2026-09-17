import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { definePlugin, runWorker, type PluginContext, type PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import { createRepositoryBinding, normalizeGitHubBranch, normalizeGitHubRepositoryUrl, parseRepositoryBinding,
  type ProjectRepositoryBindingView, type RepositoryAccess, type RepositoryBinding } from "./repository-binding.js";
import { createProjectTeamRoleMapping, parseProjectTeamRoleMapping, projectTeamRoleView,
  type ProjectTeamRoleView } from "./team-roles.js";

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
  },
  async onHealth() {
    return {status: "ok", message: "f(AI) repository binding is ready"};
  }
});

export default plugin;
runWorker(plugin, import.meta.url);
