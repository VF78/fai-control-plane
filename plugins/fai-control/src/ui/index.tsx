import { useEffect, useRef, useState, type FormEvent } from "react";
import { useHostNavigation, usePluginAction, usePluginData, type PluginDetailTabProps } from "@paperclipai/plugin-sdk/ui";
import { createRepositoryBinding, normalizeGitHubBranch, normalizeGitHubRepositoryUrl,
  type ProjectRepositoryBindingView, type RepositoryBinding } from "../repository-binding.js";
import { projectTeamRoles, type ProjectTeamRole, type ProjectTeamRoleView } from "../team-roles.js";
import { projectDocumentCategories, type ProjectDocumentCategory } from "../project-document-contract.js";
import type { ProjectDocumentsView } from "../worker.js";
import { extractBrowserDocument } from "./document-extract.js";

const panelStyle = {display: "grid", gap: "16px", maxWidth: "760px", minWidth: 0, width: "100%"} as const;
const cardStyle = {
  display: "grid", gap: "12px", minWidth: 0, maxWidth: "100%", padding: "16px", border: "1px solid var(--border)",
  borderRadius: "12px", background: "var(--card, transparent)", boxSizing: "border-box"
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

const documentLabels: Record<ProjectDocumentCategory, string> = {passport: "Passport", specification: "Specification", architecture: "Architecture", other: "Other"};
type DraftDocument = {id: string; file: File; category: ProjectDocumentCategory; combined: boolean; asset?: Record<string, unknown>; extraction?: Awaited<ReturnType<typeof extractBrowserDocument>>};
const documentsDraftKey = (companyId: string | null, projectId: string) => `fai:documents:draft:${companyId ?? "unknown"}:${projectId}`;

function inferredCategory(name: string): ProjectDocumentCategory {
  const lower = name.toLowerCase();
  if (lower.includes("passport")) return "passport";
  if (lower.includes("spec")) return "specification";
  if (lower.includes("architect")) return "architecture";
  return "other";
}

function uploadType(file: File): string {
  const name = file.name.toLowerCase();
  if (name.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (name.endsWith(".pdf")) return "application/pdf";
  if (name.endsWith(".md")) return "text/markdown";
  return "text/plain";
}

async function browserSha256(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function documentError(error: unknown): string {
  const code = error instanceof Error ? error.message : "document_upload_failed";
  const messages: Record<string, string> = {
    document_empty: "The file is empty. Choose a readable document.",
    document_file_too_large: "The file is larger than the 10 MB native upload limit.",
    document_extraction_timeout: "Reading this document took too long. Choose a smaller readable file.",
    docx_content_too_large: "This DOCX expands beyond the safe document-context limit. Split the document before upload.",
    pdf_unreadable_or_encrypted: "This PDF is encrypted or damaged. Upload a readable text PDF.",
    pdf_worker_unavailable: "PDF reading is not available until the native plugin UI finishes loading. Reload the tab and try again.",
    document_unreadable_or_empty: "No readable text was found in this file. Choose a text PDF/DOCX or provide a readable source.",
    document_text_too_large: "The readable text is too large for the compact project context. Split the document before uploading.",
    document_version_conflict_refresh_required: "Documents changed in another session. The list was refreshed; review it and retry the selected file.",
    native_asset_company_mismatch: "The uploaded file does not belong to this company.",
    document_extraction_invalid_or_unreadable: "The document text cannot be stored as compact context. Choose a readable file."
  };
  return messages[code] ?? code;
}

export function ProjectDocumentsPanel({context}: PluginDetailTabProps) {
  const documents = usePluginData<ProjectDocumentsView>("project-documents", {companyId: context.companyId, projectId: context.entityId});
  const record = usePluginAction("record-project-document");
  const prepare = usePluginAction("prepare-project-document-context");
  const [draft, setDraft] = useState<DraftDocument[]>([]);
  const [savedChoices, setSavedChoices] = useState<Record<string, Readonly<{category: ProjectDocumentCategory; combined: boolean}>>>({});
  const [draftHydrated, setDraftHydrated] = useState(false);
  const [pending, setPending] = useState<"upload" | "context" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const uploadInFlight = useRef(false);
  const contextInFlight = useRef(false);

  useEffect(() => {
    const raw = localStorage.getItem(documentsDraftKey(context.companyId, context.entityId));
    try {
      const saved = JSON.parse(raw ?? "{}") as {choices?: unknown};
      if (saved.choices && typeof saved.choices === "object") setSavedChoices(saved.choices as Record<string, {category: ProjectDocumentCategory; combined: boolean}>);
    } catch { /* a corrupt browser-only draft never affects committed project state */ }
    setDraftHydrated(true);
  }, [context.companyId, context.entityId]);
  useEffect(() => {
    if (!draftHydrated || draft.length === 0) return;
    setSavedChoices((current) => ({...current, ...Object.fromEntries(draft.map((entry) => [entry.file.name, {category: entry.category, combined: entry.combined}]))}));
  }, [draft, draftHydrated]);
  useEffect(() => { if (draftHydrated) localStorage.setItem(documentsDraftKey(context.companyId, context.entityId), JSON.stringify({choices: savedChoices})); }, [context.companyId, context.entityId, draftHydrated, savedChoices]);

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (uploadInFlight.current || draft.length === 0 || !documents.data) return;
    uploadInFlight.current = true;
    setMessage(null); setPending("upload");
    try {
      let expectedVersion = documents.data.state.revision;
      for (const entry of draft) {
        let asset = entry.asset; let extraction = entry.extraction;
        if (!asset || !extraction) {
          extraction = await extractBrowserDocument(entry.file);
          const sha256 = await browserSha256(entry.file);
          const source = new File([entry.file], entry.file.name, {type: uploadType(entry.file)});
          const body = new FormData(); body.set("file", source); body.set("namespace", "fai-documents");
          const response = await fetch(`/api/companies/${encodeURIComponent(context.companyId ?? "")}/assets/images`, {method: "POST", credentials: "same-origin", body});
          asset = await response.json() as Record<string, unknown> & {error?: unknown};
          if (!response.ok) throw new Error(typeof asset.error === "string" ? asset.error : "native_asset_upload_failed");
          if (typeof asset.sha256 !== "string" || asset.sha256.toLowerCase() !== sha256) throw new Error("native_asset_hash_mismatch");
          setDraft((current) => current.map((item) => item.id === entry.id ? {...item, asset, extraction} : item));
        }
        const result = await record({projectId: context.entityId, companyId: context.companyId, expectedVersion, idempotencyKey: `document:${entry.id}`,
          category: entry.category, satisfies: entry.combined ? ["passport", "specification"] : entry.category === "passport" || entry.category === "specification" ? [entry.category] : [], asset, extraction}) as ProjectDocumentsView;
        expectedVersion = result.state.revision;
        setDraft((current) => current.filter((item) => item.id !== entry.id));
      }
      documents.refresh(); setMessage("Original files and readable compact context were saved. The document list now resumes from the project record.");
    } catch (error) { documents.refresh(); setMessage(`${documentError(error)} Confirmed files were kept; the remaining selected item can be retried without another native upload while this tab stays open.`); }
    finally { uploadInFlight.current = false; setPending(null); }
  }

  async function buildContext() {
    if (contextInFlight.current || !documents.data) return;
    contextInFlight.current = true;
    setMessage(null); setPending("context");
    try {
      await prepare({projectId: context.entityId, companyId: context.companyId, expectedVersion: documents.data.state.revision});
      documents.refresh(); setMessage("Versioned project context is ready. Refreshing it changes only this document context; it does not reset Hermes memory, OAuth, or chats.");
    } catch (error) { documents.refresh(); setMessage(documentError(error)); }
    finally { contextInFlight.current = false; setPending(null); }
  }

  if (documents.loading) return <p>Loading project documents…</p>;
  if (documents.error) return <p role="alert">{documents.error.message}</p>;
  const view = documents.data;
  if (!view) return <p role="alert">Project document state is unavailable.</p>;
  return <section aria-label="Documents and context" style={panelStyle}>
    <div style={cardStyle}>
      <h2>Documents and context</h2>
      <p>Passport and specification are required; one combined file can satisfy both. Architecture is optional and can remain pending Hermes proposal and approval. Originals stay in native Paperclip assets; this tab keeps only versions, source links, and bounded readable context.</p>
      {view.missingMandatory.length ? <p role="alert">Required: {view.missingMandatory.map((category) => documentLabels[category]).join(" and ")}.</p> : <p role="status">Required documents are present.</p>}
      {view.state.context ? <p role="status">Context {view.state.context.version.slice(0, 12)} · {view.contextStale ? "refresh required after document revision" : "current"}.</p> : <p>Context has not been prepared yet.</p>}
    </div>
    <form style={cardStyle} onSubmit={(event) => void upload(event)}>
      <h3>Upload readable source files</h3>
      <p>DOCX, text PDF, Markdown, and text files only. Empty or unreadable files are rejected before the record is saved. You can select several files; choose the category for each.</p>
      <input aria-label="Choose project documents" style={{minWidth: 0, maxWidth: "100%", width: "100%"}} type="file" accept=".docx,.pdf,.md,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/markdown,text/plain" multiple disabled={pending !== null}
        onChange={(event) => setDraft(Array.from(event.currentTarget.files ?? []).map((file) => ({id: crypto.randomUUID(), file, category: savedChoices[file.name]?.category ?? inferredCategory(file.name), combined: savedChoices[file.name]?.combined ?? false})))} />
      {draft.map((entry, index) => <div key={`${entry.file.name}:${index}`} style={{display: "grid", gap: "8px", minWidth: 0, gridTemplateColumns: "minmax(0, 1fr) minmax(0, .4fr)"}}>
        <span style={{minWidth: 0, overflowWrap: "anywhere"}}>{entry.file.name}</span>
        <label>Category<select style={inputStyle} value={entry.category} disabled={pending !== null} onChange={(event) => setDraft((current) => current.map((item, itemIndex) => itemIndex === index ? {...item, category: event.target.value as ProjectDocumentCategory, combined: event.target.value === "passport" || event.target.value === "specification" ? item.combined : false} : item))}>{projectDocumentCategories.map((category) => <option key={category} value={category}>{documentLabels[category]}</option>)}</select></label>
        {(entry.category === "passport" || entry.category === "specification") ? <label><input type="checkbox" checked={entry.combined} disabled={pending !== null} onChange={(event) => setDraft((current) => current.map((item, itemIndex) => itemIndex === index ? {...item, combined: event.target.checked} : item))} /> This file also satisfies passport and specification</label> : null}
      </div>)}
      <button style={buttonStyle} type="submit" disabled={pending !== null || draft.length === 0}>{pending === "upload" ? "Uploading and reading…" : "Upload documents"}</button>
    </form>
    <div style={cardStyle}>
      <h3>Document versions</h3>
      {view.state.documents.length === 0 ? <p>No documents have been recorded.</p> : <ul>{view.state.documents.map((document) => <li key={document.id}><a href={document.asset.contentPath}>{document.asset.originalFilename}</a> · {documentLabels[document.category]} v{document.revision} · {document.status} · {document.extraction.contextCharacters}/{document.extraction.totalCharacters} characters{document.extraction.truncated ? " (compact context truncated)" : ""}</li>)}</ul>}
    </div>
    <div style={cardStyle}>
      <h3>Prepare versioned context</h3>
      <p>Creates a compact context with native source links from active document versions. It never replaces the persistent Hermes workspace, memory, OAuth, or chats.</p>
      <button style={buttonStyle} type="button" disabled={pending !== null || view.missingMandatory.length > 0} onClick={() => void buildContext()}>{pending === "context" ? "Preparing context…" : view.contextStale ? "Refresh context" : "Prepare context"}</button>
      {view.state.context ? <details><summary>Inspect prepared context and sources</summary><p>Version {view.state.context.version} · {view.state.context.sourceDocumentIds.length} active source(s).</p><pre style={{whiteSpace: "pre-wrap", overflowWrap: "anywhere"}}>{view.state.context.content}</pre></details> : null}
    </div>
    {message ? <p role="status">{message}</p> : null}
  </section>;
}

export function ProjectDocumentsTab(props: PluginDetailTabProps) { return <ProjectDocumentsPanel {...props} />; }

const setupSteps = ["Project and repository", "Tracker and process", "Documents", "Agent, context, and access", "Team and chats", "Verification and first task"] as const;
function setupDraftKey(companyId: string | null, projectId: string): string { return `fai:setup:step:${companyId ?? "unknown"}:${projectId}`; }

export function ProjectSetupWizardTab({context}: PluginDetailTabProps) {
  const [step, setStep] = useState(0);
  const [stepHydrated, setStepHydrated] = useState(false);
  useEffect(() => {
    const saved = Number(localStorage.getItem(setupDraftKey(context.companyId, context.entityId)));
    if (Number.isInteger(saved) && saved >= 0 && saved < setupSteps.length) setStep(saved);
    setStepHydrated(true);
  }, [context.companyId, context.entityId]);
  useEffect(() => { if (stepHydrated) localStorage.setItem(setupDraftKey(context.companyId, context.entityId), String(step)); }, [context.companyId, context.entityId, step, stepHydrated]);
  const unavailable = (label: string) => <div style={cardStyle}><p role="status">{label} is not available yet. This wizard does not configure it or mark it ready.</p></div>;
  return <section aria-label="Project setup" style={panelStyle}>
    <div style={cardStyle}><h2>Project setup</h2><p>One resumable native setup path. Current progress is saved locally per company and project; uploaded documents resume from project-scoped plugin state.</p>
      <div role="tablist" aria-label="Setup stages" style={{display: "flex", flexWrap: "wrap", gap: "8px", minWidth: 0}}>{setupSteps.map((label, index) => <button key={label} style={{...buttonStyle, background: step === index ? "var(--accent, var(--card, transparent))" : buttonStyle.background, borderColor: step === index ? "var(--accent, var(--border))" : undefined, color: step === index ? "var(--accent-foreground, inherit)" : buttonStyle.color, fontWeight: step === index ? 700 : 400}} role="tab" aria-selected={step === index} type="button" onClick={() => setStep(index)}>{index + 1}. {label}</button>)}</div>
    </div>
    <div role="tabpanel">
      {step === 0 ? <ProjectRepositoryTab context={context} /> : null}
      {step === 1 ? unavailable("Tracker and process setup") : null}
      {step === 2 ? <ProjectDocumentsPanel context={context} /> : null}
      {step === 3 ? unavailable("Hermes, context delivery, and access setup") : null}
      {step === 4 ? <><ProjectTeamRolesTab context={context} />{unavailable("Project chat setup")}</> : null}
      {step === 5 ? unavailable("Verification and first-task setup") : null}
    </div>
  </section>;
}

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
  const [draftReady, setDraftReady] = useState(false);
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
    try {
      const raw = localStorage.getItem(`fai:repository:draft:${context.companyId ?? "unknown"}:${context.entityId}`);
      const draft = raw ? JSON.parse(raw) as {repositoryUrl?: unknown; branch?: unknown} : null;
      if (typeof draft?.repositoryUrl === "string" && typeof draft.branch === "string") { setRepositoryUrl(draft.repositoryUrl); setBranch(draft.branch); setDirty(true); }
    } catch { /* browser draft is optional */ }
    setDraftReady(true);
  }, [context.companyId, context.entityId]);
  useEffect(() => {
    if (binding.data && !dirty && draftReady) {
      setRepositoryUrl(binding.data.nativeWorkspace.repositoryUrl ?? binding.data.binding?.repositoryUrl ?? "");
      setBranch(binding.data.nativeWorkspace.branch ?? binding.data.binding?.branch ?? "main");
    }
  }, [binding.data, dirty, draftReady]);
  useEffect(() => { if (dirty) localStorage.setItem(`fai:repository:draft:${context.companyId ?? "unknown"}:${context.entityId}`, JSON.stringify({repositoryUrl, branch})); }, [branch, context.companyId, context.entityId, dirty, repositoryUrl]);

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
      setDirty(false); localStorage.removeItem(`fai:repository:draft:${context.companyId ?? "unknown"}:${context.entityId}`);
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

const teamRoleLabels: Record<ProjectTeamRole, string> = {
  owner: "Owner",
  pm: "PM",
  executor: "Executor",
  client_representative: "Client representative"
};

export function ProjectTeamRolesTab({ context }: PluginDetailTabProps) {
  const [assignments, setAssignments] = useState<Partial<Record<ProjectTeamRole, string>>>({});
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [draftReady, setDraftReady] = useState(false);
  const team = usePluginData<ProjectTeamRoleView>("project-team-roles", {companyId: context.companyId, projectId: context.entityId});
  const save = usePluginAction("save-project-team-roles");
  const hostNavigation = useHostNavigation();

  useEffect(() => {
    try {
      const raw = localStorage.getItem(`fai:team:draft:${context.companyId ?? "unknown"}:${context.entityId}`);
      const draft = raw ? JSON.parse(raw) as {assignments?: unknown} : null;
      if (draft?.assignments && typeof draft.assignments === "object") { setAssignments(draft.assignments as Partial<Record<ProjectTeamRole, string>>); setDirty(true); }
    } catch { /* browser draft is optional */ }
    setDraftReady(true);
  }, [context.companyId, context.entityId]);
  useEffect(() => { if (team.data && !dirty && draftReady) setAssignments(team.data.mapping.assignments); }, [team.data, dirty, draftReady]);
  useEffect(() => { if (dirty) localStorage.setItem(`fai:team:draft:${context.companyId ?? "unknown"}:${context.entityId}`, JSON.stringify({assignments})); }, [assignments, context.companyId, context.entityId, dirty]);

  async function saveRoles(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    setPending(true);
    try {
      await save({projectId: context.entityId, assignments});
      team.refresh();
      setDirty(false); localStorage.removeItem(`fai:team:draft:${context.companyId ?? "unknown"}:${context.entityId}`);
      setMessage("Project roles were saved. Native Paperclip access was not changed.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Project roles could not be saved.");
    } finally { setPending(false); }
  }

  if (team.loading) return <p>Loading native team members…</p>;
  if (team.error) return <p role="alert">{team.error.message}</p>;

  const activeMembers = team.data?.members.filter((member) => member.status === "active") ?? [];
  return (
    <section aria-label="Team and roles" style={panelStyle}>
      <h2>Team and roles</h2>
      <div style={cardStyle}>
        <p>Paperclip company membership is authoritative. This page stores project responsibility labels only; it never grants access, changes native roles, or sends invitations.</p>
        <a {...hostNavigation.linkProps("/company/settings/members")}>Manage native members and invitations</a>
        {team.data?.members.length === 0 ? <p role="status">No native human membership is available for this board. In local-trusted mode the Board can have no membership record; add or manage people in Paperclip before assigning project roles.</p> : null}
      </div>
      <form style={cardStyle} onSubmit={(event) => void saveRoles(event)}>
        <h3>Project responsibility</h3>
        {projectTeamRoles.map((role) => (
          <label key={role}>{teamRoleLabels[role]}
            <select style={inputStyle} disabled={pending || activeMembers.length === 0} value={assignments[role] ?? ""}
              onChange={(event) => { setDirty(true); setAssignments((current) => ({...current, [role]: event.target.value || undefined})); }}>
              <option value="">Unassigned</option>
              {activeMembers.map((member) => <option key={member.id} value={member.id}>{member.principalId} · {member.membershipRole ?? "no native role"}</option>)}
            </select>
          </label>
        ))}
        <button style={buttonStyle} type="submit" disabled={pending || activeMembers.length === 0}>{pending ? "Saving roles…" : "Save project roles"}</button>
      </form>
      <div style={cardStyle}>
        <h3>Client representative</h3>
        <p>A client representative label does not create a Paperclip viewer account or grant project access. Restricted client chat access is configured separately and is not available in this setup step yet.</p>
      </div>
      {message ? <p role="status">{message}</p> : null}
    </section>
  );
}
