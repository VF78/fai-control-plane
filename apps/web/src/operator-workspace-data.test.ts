import {beforeEach, expect, it, vi} from 'vitest';

const loaders = vi.hoisted(() => ({
  loadAccessData: vi.fn(),
  loadProjectData: vi.fn()
}));

vi.mock('./operator-data', async (importOriginal) => ({
  ...await importOriginal<typeof import('./operator-data')>(),
  loadAccessData: loaders.loadAccessData,
  loadProjectData: loaders.loadProjectData
}));

import {loadWorkspaceData} from './operator-workspace-data';

beforeEach(() => {
  loaders.loadAccessData.mockResolvedValue({state: 'ready', data: {
    memberships: [{actorId: 'vitaliy', projectSlug: 'msa', active: true}]
  }});
  loaders.loadProjectData.mockImplementation(async (slug: string) => ({
    state: 'ready', data: {project: {slug}}
  }));
});

it('loads dashboard project baselines only for the authenticated operator memberships', async () => {
  const data = await loadWorkspaceData({
    screen: 'dashboard', project: null, taskId: null, runId: null, agentId: null,
    scope: {environment: null, from: null, to: null}
  }, 'vitaliy');

  expect(loaders.loadProjectData).toHaveBeenCalledTimes(1);
  expect(loaders.loadProjectData).toHaveBeenCalledWith('msa');
  expect(data.projectIndex).toEqual([{project: {slug: 'msa'}}]);
});
