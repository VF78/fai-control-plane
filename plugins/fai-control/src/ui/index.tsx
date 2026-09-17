import { useEffect, useState, type FormEvent } from "react";
import { useHostNavigation, usePluginAction, usePluginData, type PluginDetailTabProps } from "@paperclipai/plugin-sdk/ui";
import { createRepositoryBinding, normalizeGitHubBranch, normalizeGitHubRepositoryUrl,
  type ProjectRepositoryBindingView, type RepositoryBinding } from "../repository-binding.js";

const panelStyle = {display: "grid", gap: "16px", maxWidth: "760px"} as const;
const cardStyle = {
  display: "grid", gap: "12px", padding: "16px", border: "1px solid var(--border)",
  borderRadius: "12px", background: "var(--card, transparent)"
} as const;
const inputStyle = {
  boxSizing: "border-box", display: "block", width: "100%", marginTop: "6px", padding: "9px 10px",
  border: "1px solid var(--border)", borderRadius: "8px", background: "var(--background)", color: "inherit"
} as const;
const branchInputStyle = {...inputStyle, maxWidth: "320px"} as const;
const buttonStyle = {
  justifySelf: "start", padding: "8px 12px", border: "1px solid var(--border)", borderRadius: "8px",
  background: "var(--card, transparent)", color: "inherit", cursor: "pointer"
} as const;

function accessLabel(binding: RepositoryBinding | null): string {
  if (!binding || binding.access.status === "not_checked") return "Access has not been checked.";
  if (binding.access.status === "verified") return `Access checked ${binding.access.checkedAt ?? ""}.`;
  return `Access was not verified (${binding.access.reason ?? "unknown"}).`;
}

export function ProjectRepositoryTab({ context }: PluginDetailTabProps) {
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [branch, setBranch] = useState("main");
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState<"applying" | "checking" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const binding = usePluginData<ProjectRepositoryBindingView>("project-repository-binding", {
    companyId: context.companyId,
    projectId: context.entityId
  });
  const save = usePluginAction("save-project-repository-binding");
  const verify = usePluginAction("verify-project-repository-binding");
  const hostNavigation = useHostNavigation();
  const taskReady = binding.data?.binding?.access.status === "verified" &&
    binding.data.nativeWorkspace.branch !== null && binding.data.nativeWorkspace.matchesBinding;

  useEffect(() => {
    if (binding.data && !dirty) {
      setRepositoryUrl(binding.data.nativeWorkspace.repositoryUrl ?? binding.data.binding?.repositoryUrl ?? "");
      setBranch(binding.data.nativeWorkspace.branch ?? binding.data.binding?.branch ?? "main");
    }
  }, [binding.data, dirty]);

  async function applyNativeWorkspace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    setPending("applying");
    try {
      const workspaceId = binding.data?.nativeWorkspace.workspaceId;
      if (!workspaceId) throw new Error("native_workspace_required");
      const companyId = context.companyId;
      if (!companyId) throw new Error("company_scope_required");
      const candidate = createRepositoryBinding({repositoryUrl, branch});
      const response = await fetch(
        `/api/projects/${encodeURIComponent(context.entityId)}/workspaces/${encodeURIComponent(workspaceId)}?companyId=${encodeURIComponent(companyId)}`,
        {
          method: "PATCH",
          credentials: "same-origin",
          headers: {"Content-Type": "application/json"},
          body: JSON.stringify({repoUrl: candidate.repositoryUrl, repoRef: candidate.branch, defaultRef: candidate.branch})
        }
      );
      const payload = await response.json() as {error?: unknown; repoUrl?: unknown; repoRef?: unknown; defaultRef?: unknown};
      if (!response.ok) throw new Error(typeof payload.error === "string" ? payload.error : "native_workspace_update_failed");
      const readbackUrl = typeof payload.repoUrl === "string" ? normalizeGitHubRepositoryUrl(payload.repoUrl).repositoryUrl : null;
      const readbackRef = typeof payload.repoRef === "string" ? payload.repoRef : payload.defaultRef;
      const readbackBranch = typeof readbackRef === "string" ? normalizeGitHubBranch(readbackRef).branch : null;
      if (readbackUrl !== candidate.repositoryUrl || readbackBranch !== candidate.branch) {
        throw new Error("native_workspace_readback_mismatch");
      }
      await save({projectId: context.entityId, repositoryUrl: candidate.repositoryUrl, branch: candidate.branch});
      binding.refresh();
      setDirty(false);
      setMessage("Repository and branch were applied to the native workspace. Verify access before using a task.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Native workspace could not be updated.");
    } finally { setPending(null); }
  }

  async function verifyAccess() {
    setMessage(null);
    setPending("checking");
    try {
      await verify({projectId: context.entityId});
      binding.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Repository access could not be checked.");
    } finally { setPending(null); }
  }

  if (binding.loading) return <p>Loading repository binding…</p>;
  if (binding.error) return <p role="alert">{binding.error.message}</p>;

  return (
    <section aria-label="Repository binding" style={panelStyle}>
      <h2>Required GitHub repository</h2>
      {binding.data?.binding ? (
        <div style={cardStyle}>
          <p><a href={binding.data.binding.repositoryUrl}>{binding.data.binding.repositoryUrl}</a> · branch {binding.data.binding.branch}</p>
          <p>{accessLabel(binding.data.binding)}</p>
          {binding.data.nativeWorkspace.branch === null ? <p role="alert">The native workspace has no configured branch. Apply the checked branch below before creating a task.</p> : null}
          {!binding.data.nativeWorkspace.matchesBinding ? <p role="alert">The native workspace differs from the saved binding. Apply the repository and branch below to make the workspace authoritative.</p> : null}
          <button style={buttonStyle} type="button" disabled={pending !== null} onClick={() => void verifyAccess()}>
            {pending === "checking" ? "Checking access…" : "Check repository access"}
          </button>
        </div>
      ) : (
        <p>Set the GitHub repository and branch on the native workspace below. The plugin only records the matching binding and access check.</p>
      )}
      <form style={cardStyle} onSubmit={(event) => void applyNativeWorkspace(event)}>
        <label>GitHub repository URL
          <input style={inputStyle} required disabled={pending !== null} value={repositoryUrl} placeholder="https://github.com/owner/repository" onChange={(event) => { setDirty(true); setRepositoryUrl(event.target.value); }} />
        </label>
        <label>Branch
          <input style={branchInputStyle} required disabled={pending !== null} value={branch} onChange={(event) => { setDirty(true); setBranch(event.target.value); }} />
        </label>
        <button style={buttonStyle} type="submit" disabled={pending !== null || !binding.data?.nativeWorkspace.workspaceId}>{pending === "applying" ? "Applying native workspace…" : "Apply repository and branch"}</button>
      </form>
      <div style={cardStyle}>
        <h3>First task</h3>
        {taskReady ? (
          <>
            <p>Create the first task in this Paperclip project. Keep its branch, pull request, and result references with the task.</p>
            <a {...hostNavigation.linkProps(`/projects/${context.entityId}/issues`)}>Open project tasks</a>
          </>
        ) : <p>Apply the native repository and branch, then verify repository access before creating the first task here.</p>}
        <p>Project agent setup is still required before tasks can run.</p>
      </div>
      {message ? <p role="status">{message}</p> : null}
    </section>
  );
}
