import {beforeEach, expect, it, vi} from 'vitest';

const loaders = vi.hoisted(() => ({
  loadAccessData: vi.fn(),
  loadPortfolioData: vi.fn(),
  loadProjectData: vi.fn()
}));

vi.mock('./operator-data', async (importOriginal) => ({
  ...await importOriginal<typeof import('./operator-data')>(),
  loadAccessData: loaders.loadAccessData,
  loadPortfolioData: loaders.loadPortfolioData,
  loadProjectData: loaders.loadProjectData
}));

import {loadWorkspaceData} from './operator-workspace-data';

beforeEach(() => {
  loaders.loadAccessData.mockResolvedValue({state: 'ready', data: {
    memberships: [{actorId: 'vitaliy', projectId: 'msa-id', projectSlug: 'msa', active: true}]
  }});
  loaders.loadProjectData.mockImplementation(async (scope: {projectId: string; slug: string}) => ({
    state: 'ready', data: {project: {id: scope.projectId, slug: scope.slug}}
  }));
  loaders.loadPortfolioData.mockResolvedValue({state: 'ready', data: {projects: [], attention: []}});
});

it('loads dashboard project baselines only for the authenticated operator memberships', async () => {
  const data = await loadWorkspaceData({
    screen: 'dashboard', project: null, taskId: null, runId: null, agentId: null,
    scope: {environment: null, from: null, to: null}
  }, 'vitaliy');

  expect(loaders.loadProjectData).toHaveBeenCalledTimes(1);
  expect(loaders.loadProjectData).toHaveBeenCalledWith({projectId: 'msa-id', slug: 'msa'});
  expect(loaders.loadPortfolioData).toHaveBeenCalledWith([{projectId: 'msa-id', slug: 'msa'}]);
  expect(data.projectIndex).toEqual([{project: {id: 'msa-id', slug: 'msa'}}]);
});
