import {describe, expect, it, vi} from 'vitest';
import {projectAgentProfileTemplateVersion, type Database} from '@fai-control-plane/db';
import {enqueueProjectFailureBlockers, githubBindingCoordinates, listWorkerProjectBindings,
  runProjectBindingsIsolated,
  type WorkerProjectBinding} from './project-runtime.ts';

const row = (projectId: string, repository: string, profile: string) => ({
  workspaceId: 'workspace', projectId, slug: projectId, bindingId: `binding-${projectId}`, provider: 'github',
  externalProjectId: `external-${projectId}`, projectUrl: `https://github.com/users/VF78/projects/${projectId === 'one' ? 1 : 2}`,
  repositoryId: `repository-${projectId}`, repositoryUrl: `https://github.com/VF78/${repository}`, cursor: null,
  trackerSecretId: 'tracker', trackerSecretPurpose: 'tracker_read', trackerSecretLocator: '/run/tracker',
  agentSecretId: 'agent', agentSecretLocator: '/run/agent', profileArtifact: JSON.stringify({
    contract: 'fai.project-agent-profile.v1', status: 'ready', profile,
    endpointPath: `/p/${profile}/v1/runs`, templateVersion: projectAgentProfileTemplateVersion
  }), trackerCapabilitiesArtifact: JSON.stringify({contract: 'fai.project-tracker-capabilities.v1',
    provider: 'github', agentOwnerOptionId: `hermes-${projectId}`, doneStatusOptionId: `done-${projectId}`,
    defaultBranch: 'main'})
});

describe('multi-project worker composition', () => {
  it('resolves separate repository, Project and verified Hermes profile for each binding', async () => {
    const database = {query: vi.fn(async () => ({rows: [
      row('one', 'control', 'project-control'), row('two', 'ascon', 'project-ascon')
    ]}))} as unknown as Database;
    const bindings = await listWorkerProjectBindings(database, 'workspace');
    expect(bindings).toHaveLength(2);
    expect(bindings.map((binding) => ({projectId: binding.projectId, repository: binding.repositoryUrl,
      project: binding.projectUrl, endpoint: binding.endpointPath, owner: binding.agentOwnerOptionId,
      done: binding.doneStatusOptionId}))).toEqual([
      {projectId: 'one', repository: 'https://github.com/VF78/control',
        project: 'https://github.com/users/VF78/projects/1', endpoint: '/p/project-control/v1/runs',
        owner: 'hermes-one', done: 'done-one'},
      {projectId: 'two', repository: 'https://github.com/VF78/ascon',
        project: 'https://github.com/users/VF78/projects/2', endpoint: '/p/project-ascon/v1/runs',
        owner: 'hermes-two', done: 'done-two'}
    ]);
    expect(githubBindingCoordinates(bindings[0]!)).toEqual({owner: 'VF78', repository: 'control', projectNumber: 1});
    expect(githubBindingCoordinates(bindings[1]!)).toEqual({owner: 'VF78', repository: 'ascon', projectNumber: 2});
  });

  it('continues other projects after one project operation fails', async () => {
    const bindings = [row('one', 'control', 'project-control'), row('two', 'ascon', 'project-ascon')]
      .map((value) => ({...value, profile: JSON.parse(value.profileArtifact).profile,
        endpointPath: JSON.parse(value.profileArtifact).endpointPath,
        agentOwnerOptionId: JSON.parse(value.trackerCapabilitiesArtifact).agentOwnerOptionId,
        doneStatusOptionId: JSON.parse(value.trackerCapabilitiesArtifact).doneStatusOptionId,
        defaultBranch: JSON.parse(value.trackerCapabilitiesArtifact).defaultBranch,
        trackerCredentialRef: {id: 'tracker', purpose: 'tracker_read', locator: '/run/tracker'},
        agentCredentialRef: {id: 'agent', purpose: 'agent_delivery', locator: '/run/agent'}})) as WorkerProjectBinding[];
    const visited: string[] = [];
    const results = await runProjectBindingsIsolated(bindings, async (binding) => {
      visited.push(binding.projectId);
      if (binding.projectId === 'one') throw new Error('provider_failed');
      return binding.endpointPath;
    });
    expect(visited).toEqual(['one', 'two']);
    expect(results).toEqual([
      {projectId: 'one', status: 'failed'},
      {projectId: 'two', status: 'completed', value: '/p/project-ascon/v1/runs'}
    ]);
  });

  it('persists one bounded project blocker without letting notification failure escape', async () => {
    const enqueue = vi.fn(async ({projectId}: Readonly<{projectId: string}>) => {
      if (projectId === 'one') throw new Error('outbox_unavailable');
    });
    await expect(enqueueProjectFailureBlockers('observe', [
      {projectId: 'one', status: 'failed'},
      {projectId: 'two', status: 'completed'},
      {projectId: 'three', status: 'failed'}
    ], enqueue)).resolves.toBeUndefined();
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue.mock.calls[1]![0]).toEqual({projectId: 'three',
      idempotencyKey: 'worker:three:observe:blocker',
      text: 'Автоматическая обработка проекта остановлена на этапе observe. Требуется проверка интеграции.'});
  });
});
