import { expect, test } from "vitest";
import { defaultTracker, configureTracker } from "./project-tracker.js";
import { projectSetupReadiness } from "./project-setup-readiness.js";

test("internal tracker can become fully ready while external readback remains pending", () => {
  const base = {repositoryReady: true, documentsReady: true, hermesReady: true, qaReady: true, teamReady: true, chatsReady: true};
  expect(projectSetupReadiness({...base, tracker: defaultTracker()}).ready).toBe(false);
  const internal = configureTracker({expectedRevision: 0, mode: "internal", requireTeam: false, requireChats: false}, defaultTracker());
  expect(projectSetupReadiness({...base, tracker: internal}).ready).toBe(true);
  const external = configureTracker({expectedRevision: 0, mode: "external", externalProjectUrl: "https://github.com/users/VF78/projects/1", requireTeam: true, requireChats: true}, defaultTracker());
  const readiness = projectSetupReadiness({...base, tracker: external});
  expect(readiness).toMatchObject({trackerReady: false, teamReady: true, chatsReady: true, ready: false});
  expect(projectSetupReadiness({...base, qaReady: false, tracker: internal})).toMatchObject({qaReady: false, ready: false});
});
