import { expect, test } from "vitest";
import { configureTracker, defaultTracker, githubProject, parseTracker, recordTrackerReadback, trackerReady } from "./project-tracker.js";

test("normalizes only GitHub Project URLs and defaults to internal Paperclip tasks", () => {
  expect(githubProject("https://github.com/orgs/VF78/projects/12/")).toMatchObject({url: "https://github.com/orgs/VF78/projects/12", owner: "VF78", number: "12"});
  expect(() => githubProject("https://github.com/VF78/fai-control-plane/issues")).toThrow("tracker_project_url_invalid");
  expect(trackerReady(defaultTracker())).toBe(false);
  expect(trackerReady(configureTracker({expectedRevision: 0, mode: "internal", requireTeam: false, requireChats: false}, defaultTracker()))).toBe(true);
  expect(parseTracker({contract: "fai.tracker.v1", revision: 2, mode: "external", provider: "github", externalProjectUrl: "https://github.com/users/VF78/projects/1", externalProjectId: "PVT_secret", requireTeam: true, requireChats: false, readback: null}).externalProjectUrl).toBe("https://github.com/users/VF78/projects/1");
});

test("external verification remains pending and stale readback cannot overwrite new configuration", () => {
  const external = configureTracker({expectedRevision: 0, mode: "external", externalProjectUrl: "https://github.com/users/VF78/projects/1", requireTeam: false, requireChats: false}, defaultTracker());
  expect(trackerReady(external)).toBe(false);
  const verified = recordTrackerReadback(external, external.revision, "https://github.com/VF78/fai-control-plane", {verified: true, checkedAt: "now"});
  expect(verified.readback?.status).toBe("verified");
  expect(verified.externalProjectId).toBeNull();
  const replaced = configureTracker({expectedRevision: verified.revision, mode: "internal", requireTeam: false, requireChats: false}, verified);
  expect(() => recordTrackerReadback(replaced, verified.revision, "https://github.com/VF78/fai-control-plane", {verified: true, checkedAt: "later"})).toThrow("tracker_revision_conflict");
});
