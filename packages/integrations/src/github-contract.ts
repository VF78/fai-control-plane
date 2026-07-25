import type {TrackerCheckConclusion} from '@fai-control-plane/domain';

export type GitHubRepositoryScopeDefinition = Readonly<{
  repositoryId: number;
  fullName: 'VF78/MSA' | 'VF78/ascon';
  ownerId: number;
  projectNumber: number;
  projectNodeId: string;
}>;

export const githubRepositoryScopeDefinitions:
readonly GitHubRepositoryScopeDefinition[] = Object.freeze([
  Object.freeze({
    repositoryId: 1278325372,
    fullName: 'VF78/MSA',
    ownerId: 75837222,
    projectNumber: 3,
    projectNodeId: 'PVT_kwHOBIUvJs4Bbefq'
  }),
  Object.freeze({
    repositoryId: 1279114011,
    fullName: 'VF78/ascon',
    ownerId: 75837222,
    projectNumber: 4,
    projectNodeId: 'PVT_kwHOBIUvJs4Bbi0Q'
  })
]);

export const githubCheckRunConclusions = [
  'action_required',
  'cancelled',
  'failure',
  'neutral',
  'skipped',
  'stale',
  'success',
  'timed_out'
] as const satisfies readonly TrackerCheckConclusion[];
