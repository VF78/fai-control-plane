/** Binding metadata only. Native Core owns issues/runs; external business fields never live here. */
export type TrackerBinding = {
  contract: "fai.tracker.v1"; revision: number; mode: "internal" | "external";
  provider: "paperclip" | "github"; externalProjectUrl: string | null; externalProjectId: string | null;
  requireTeam: boolean; requireChats: boolean;
  readback: {status: "verified" | "unverified"; checkedAt: string; repositoryUrl: string; projectId: string} | null;
};
export type TrackerReadback = Readonly<{verified: boolean; checkedAt: string}>;
export const defaultTracker = (): TrackerBinding => ({contract: "fai.tracker.v1", revision: 0, mode: "internal", provider: "paperclip", externalProjectUrl: null, externalProjectId: null, requireTeam: false, requireChats: false, readback: null});
export function githubProject(url: unknown) {
  if (typeof url !== "string") throw new Error("tracker_project_url_required");
  const match = /^https:\/\/github\.com\/(users|orgs)\/([A-Za-z0-9-]+)\/projects\/([1-9][0-9]*)\/?$/.exec(url.trim());
  if (!match) throw new Error("tracker_project_url_invalid");
  return {url: `https://github.com/${match[1]}/${match[2]}/projects/${match[3]}`, owner: match[2], number: match[3]};
}
export function configureTracker(input: Record<string, unknown>, current: TrackerBinding): TrackerBinding {
  if (input.expectedRevision !== current.revision) throw new Error("tracker_revision_conflict");
  if (input.mode !== "internal" && input.mode !== "external") throw new Error("tracker_mode_invalid");
  const url = input.mode === "external" ? githubProject(input.externalProjectUrl).url : null;
  return {...defaultTracker(), revision: current.revision + 1, mode: input.mode, provider: input.mode === "external" ? "github" : "paperclip", externalProjectUrl: url, requireTeam: input.requireTeam === true, requireChats: input.requireChats === true};
}
export function parseTracker(value: unknown): TrackerBinding {
  if (!value || typeof value !== "object") return defaultTracker();
  const v = value as TrackerBinding;
  if (v.contract !== "fai.tracker.v1" || !Number.isSafeInteger(v.revision) || v.revision < 0) throw new Error("tracker_binding_invalid");
  const clean = configureTracker({...v, expectedRevision: v.revision}, v);
  const readback = v.readback;
  return {...clean, revision: v.revision, externalProjectId: typeof v.externalProjectId === "string" && /^PVT_[A-Za-z0-9_-]+$/.test(v.externalProjectId) ? v.externalProjectId : null,
    readback: readback && ["verified", "unverified"].includes(readback.status) && typeof readback.checkedAt === "string" && typeof readback.repositoryUrl === "string" && typeof readback.projectId === "string" ? {status: readback.status, checkedAt: readback.checkedAt, repositoryUrl: readback.repositoryUrl, projectId: readback.projectId} : null};
}
export function trackerReady(binding: TrackerBinding) { return binding.mode === "internal"; }

/** A successful GitHub readback confirms credentials only. No external write connector exists yet. */
export function recordTrackerReadback(current: TrackerBinding, expectedRevision: number, repositoryUrl: string, result: TrackerReadback): TrackerBinding {
  if (expectedRevision !== current.revision || current.mode !== "external" || !current.externalProjectUrl) throw new Error("tracker_revision_conflict");
  return {...current, revision: current.revision + 1, externalProjectId: null, readback: {
    status: result.verified ? "verified" : "unverified", checkedAt: result.checkedAt, repositoryUrl, projectId: ""
  }};
}
