import { trackerReady, type TrackerBinding } from "./project-tracker.js";

export type ProjectSetupReadinessInput = Readonly<{
  repositoryReady: boolean;
  tracker: TrackerBinding;
  documentsReady: boolean;
  hermesReady: boolean;
  teamReady: boolean;
  chatsReady: boolean;
}>;

export type ProjectSetupReadiness = Readonly<{
  repositoryReady: boolean;
  trackerReady: boolean;
  documentsReady: boolean;
  hermesReady: boolean;
  teamReady: boolean;
  chatsReady: boolean;
  ready: boolean;
}>;

/** Pure setup projection. It neither creates work nor invents native task policy. */
export function projectSetupReadiness(input: ProjectSetupReadinessInput): ProjectSetupReadiness {
  const trackerIsReady = trackerReady(input.tracker);
  const teamIsReady = !input.tracker.requireTeam || input.teamReady;
  const chatsAreReady = !input.tracker.requireChats || input.chatsReady;
  return {
    repositoryReady: input.repositoryReady,
    trackerReady: trackerIsReady,
    documentsReady: input.documentsReady,
    hermesReady: input.hermesReady,
    teamReady: teamIsReady,
    chatsReady: chatsAreReady,
    ready: input.repositoryReady && trackerIsReady && input.documentsReady && input.hermesReady && teamIsReady && chatsAreReady
  };
}
