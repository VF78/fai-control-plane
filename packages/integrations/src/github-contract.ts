import type {TrackerCheckConclusion} from '@fai-control-plane/domain';

export type GitHubRepositoryScopeDefinition = Readonly<{
  repositoryId: number;
  fullName: 'VF78/MSA' | 'VF78/ascon';
  ownerId: number;
  projectNumber: number;
  projectNodeId: string;
  projectStatusFieldNodeId: string;
  projectTargetDateFieldNodeId: string | null;
  projectStatusOptions: Readonly<Record<string, string>>;
}>;

export const githubRepositoryScopeDefinitions:
readonly GitHubRepositoryScopeDefinition[] = Object.freeze([
  Object.freeze({
    repositoryId: 1278325372,
    fullName: 'VF78/MSA',
    ownerId: 75837222,
    projectNumber: 3,
    projectNodeId: 'PVT_kwHOBIUvJs4Bbefq',
    projectStatusFieldNodeId: 'PVTSSF_lAHOBIUvJs4BbefqzhWOwBc',
    projectTargetDateFieldNodeId: null,
    projectStatusOptions: Object.freeze({
      '18997dc4': 'Backlog',
      '1f121483': 'Ready',
      f37309f6: 'In Dev',
      b4f120e4: 'QA',
      '2f615ec5': 'Acceptance',
      a6fa8659: 'Done'
    })
  }),
  Object.freeze({
    repositoryId: 1279114011,
    fullName: 'VF78/ascon',
    ownerId: 75837222,
    projectNumber: 4,
    projectNodeId: 'PVT_kwHOBIUvJs4Bbi0Q',
    projectStatusFieldNodeId: 'PVTSSF_lAHOBIUvJs4Bbi0QzhWSnmU',
    projectTargetDateFieldNodeId: 'PVTF_lAHOBIUvJs4Bbi0QzhWSnuc',
    projectStatusOptions: Object.freeze({
      f75ad846: 'Backlog',
      f1d63022: 'Ready',
      '47fc9ee4': 'In Dev',
      eccb04fa: 'QA',
      '640fe9a8': 'Acceptance',
      '98236657': 'Done'
    })
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
