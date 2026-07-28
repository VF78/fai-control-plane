import type {TrackerCheckConclusion, WorkItemStatus} from '@fai-control-plane/domain';

export type GitHubRepositoryScopeDefinition = Readonly<{
  repositoryId: number;
  fullName: 'VF78/MSA' | 'VF78/ascon';
  ownerId: number;
  projectNumber: number;
  projectNodeId: string;
  projectStatusFieldNodeId: string;
  projectStatusOptionMap: Readonly<Record<string, WorkItemStatus>>;
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
    projectStatusOptionMap: Object.freeze({
      '18997dc4': 'backlog',
      '1f121483': 'ready',
      f37309f6: 'in_dev',
      b4f120e4: 'qa',
      '2f615ec5': 'acceptance',
      a6fa8659: 'done'
    })
  }),
  Object.freeze({
    repositoryId: 1279114011,
    fullName: 'VF78/ascon',
    ownerId: 75837222,
    projectNumber: 4,
    projectNodeId: 'PVT_kwHOBIUvJs4Bbi0Q',
    projectStatusFieldNodeId: 'PVTSSF_lAHOBIUvJs4Bbi0QzhWSnmU',
    projectStatusOptionMap: Object.freeze({
      f75ad846: 'backlog',
      f1d63022: 'ready',
      '47fc9ee4': 'in_dev',
      eccb04fa: 'qa',
      '640fe9a8': 'acceptance',
      '98236657': 'done'
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
