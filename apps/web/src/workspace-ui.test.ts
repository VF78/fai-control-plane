import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect, it, vi} from 'vitest';
import type {ProjectPlanDefinition} from '@fai-control-plane/domain';
import {
  deriveFleetHealth,
  derivePortfolioProjectMetrics,
  deriveRuntimeAvailabilityAlerts,
  type AccessData
} from './operator-data';
import {workspaceRoute} from './operator-workspace-route';
import type {ProjectData} from './operator-data';
import {WorkspaceShell as ProviderWorkspaceShell, type WorkspaceData} from './workspace-ui';
import {ProjectPlanControls} from './project-plan-controls';
import {RiskDispositionControls} from './risk-disposition-controls';
import {ProjectExecutionControls} from './project-execution-controls';

vi.mock('next/navigation', () => ({useRouter: () => ({refresh: vi.fn()})}));

const statusName = (status: string): string => ({
  backlog: 'Backlog', ready: 'Ready', in_dev: 'In Dev', qa: 'QA',
  acceptance: 'Acceptance', done: 'Done'
}[status] ?? status);

/** Keeps unrelated historical UI fixtures focused while task screens use provider facts. */
const withProviderMirror = (project: ProjectData): ProjectData => {
  if ((project as Partial<ProjectData>).tracker !== undefined) return project;
  const repository = project.project.slug === 'ascon' ? 'VF78/ascon' : 'VF78/MSA';
  return {
    ...project,
    runnerQueueEnabled: project.runnerQueueEnabled ?? false,
    deployments: project.deployments ?? [],
    tracker: {
      project: {
        id: project.project.id,
        name: project.project.name,
        slug: project.project.slug,
        version: project.project.version ?? 1,
        source: {provider: 'github', repository, url: `https://github.com/${repository}`},
        observedAt: project.synchronizedAt?.toISOString() ?? null,
        freshness: project.synchronizedAt === null ? 'unavailable' : 'fresh',
        error: project.synchronizedAt === null ? 'provider_snapshot_unavailable' : null
      },
      tasks: project.workItems.map((item, index) => ({
        id: item.id,
        issueExternalId: `github:issue:${index + 1}`,
        title: item.title,
        requirements: item.summary,
        state: item.status === 'done' ? 'closed' : 'open',
        status: {optionExternalId: null, optionName: statusName(item.status)},
        assignees: item.owner === null ? [] : [{externalId: `github:user:${item.owner}`, login: item.owner}],
        targetDate: null,
        parentIssueExternalId: null,
        subIssueExternalIds: [],
        dependencyExternalIds: [],
        sourceUrl: item.externalUrl ?? `https://github.com/${repository}/issues/${index + 1}`,
        observedVersion: `github:test:${item.id}`
      })),
      pullRequests: [],
      checks: []
    }
  };
};

const normalizeWorkspaceData = (data: WorkspaceData): WorkspaceData => ({
  ...data,
  project: data.project?.state === 'ready' && data.project.data !== null
    ? {...data.project, data: withProviderMirror(data.project.data)}
    : data.project,
  projectIndex: data.projectIndex.map(withProviderMirror)
});

function WorkspaceShell(props: Parameters<typeof ProviderWorkspaceShell>[0]) {
  return createElement(ProviderWorkspaceShell, {...props, data: normalizeWorkspaceData(props.data)});
}

const providerTask = (
  id: string,
  title: string,
  optionName = 'In Dev'
): ProjectData['tracker']['tasks'][number] => ({
  id,
  issueExternalId: `github:issue:${id}`,
  title,
  requirements: `Requirements for ${title}`,
  state: optionName === 'Done' ? 'closed' : 'open',
  status: {optionExternalId: `option:${optionName}`, optionName},
  assignees: [],
  targetDate: null,
  parentIssueExternalId: null,
  subIssueExternalIds: [],
  dependencyExternalIds: [],
  sourceUrl: `https://github.com/VF78/MSA/issues/${id}`,
  observedVersion: `github:item:${id}`
});

const providerProject = (
  tasks: readonly ProjectData['tracker']['tasks'][number][] = [],
  input: Readonly<{name?: string; slug?: 'msa' | 'ascon'; error?: string | null}> = {}
): ProjectData => {
  const name = input.name ?? 'MSA';
  const slug = input.slug ?? 'msa';
  const observedAt = new Date('2026-08-12T12:00:00.000Z');
  const repository = slug === 'ascon' ? 'VF78/ascon' : 'VF78/MSA';
  return {
    project: {id: `${slug}-id`, workspaceId: 'workspace-1', name, slug,
      description: null, defaultBranch: 'main', version: 1, updatedAt: observedAt},
    runnerQueueEnabled: false,
    deployments: [],
    tracker: {
      project: {id: `${slug}-id`, name, slug, version: 1,
        source: {provider: 'github', repository, url: `https://github.com/${repository}`},
        observedAt: observedAt.toISOString(), freshness: 'fresh', error: input.error ?? null},
      tasks,
      pullRequests: [],
      checks: []
    },
    agentProfiles: [],
    snapshot: null,
    synchronizedAt: observedAt,
    protocol: null,
    execution: {projectId: `${slug}-id`, status: 'stopped', version: 0, selection: null,
      dispatch: null, blockReason: null, decisions: [], startedAt: null, pausedAt: null,
      completedAt: null, updatedAt: null},
    workItems: []
  } as unknown as ProjectData;
};

const projectWorkspace = (project: ProjectData): WorkspaceData => ({
  portfolio: {state: 'unconfigured'},
  access: {state: 'unconfigured'},
  project: {state: 'ready', data: project},
  runs: null,
  health: null,
  projectIndex: [project]
});

it('renders the canonical risk decision controls in Russian', () => {
  const markup = renderToStaticMarkup(createElement(RiskDispositionControls, {
    csrfToken: 'csrf', disposition: null, expectedVersion: 0,
    projectId: 'project-1', riskSignalId: 'risk-1'
  }));
  expect(markup).toContain('Решение по риску');
  expect(markup).toContain('Учесть');
  expect(markup).toContain('Отложить');
  expect(markup).not.toContain('Disposition');
});

it('maps only canonical workspace routes and preserves scope on deep links', () => {
  expect(workspaceRoute(['projects', 'msa', 'tasks', 'task-1'], {
    environment: 'staging', from: '2026-07-01', to: '2026-07-31'
  })).toMatchObject({screen: 'task', project: 'msa', taskId: 'task-1', scope: {environment: 'staging', from: '2026-07-01', to: '2026-07-31'}});
  expect(workspaceRoute(['projects', 'unknown', 'overview'], {})).toMatchObject({screen: 'overview', project: 'unknown'});
  expect(workspaceRoute(['projects', 'msa', 'runs', ''], {})).toBeNull();
  expect(workspaceRoute(['tasks'], {project: 'unknown'})).toMatchObject({screen: 'global_tasks', globalProject: 'unknown'});
  expect(workspaceRoute(['tasks'], {project: 'msa', status: 'qa', attention: 'only', owner: 'Hermes'}))
    .toMatchObject({screen: 'global_tasks', globalProject: 'msa', taskFilters: {status: 'qa', attention: true, owner: 'Hermes'}});
  expect(workspaceRoute(['projects', 'msa', 'tasks'], {}))
    .toMatchObject({screen: 'tasks', taskFilters: {view: 'board', status: 'all', attention: false, owner: null}});
  expect(workspaceRoute(['projects', 'msa', 'tasks'], {view: 'blocked', status: 'qa'}))
    .toMatchObject({screen: 'tasks', taskFilters: {view: 'blocked', status: 'qa'}});
  expect(workspaceRoute(['projects', 'msa', 'runs', 'run-1'], {handoff: 'accepted'}))
    .toMatchObject({screen: 'run', handoffResult: 'accepted'});
  expect(workspaceRoute(['people'], {})).toMatchObject({screen: 'people', project: null});
});

it('keeps project setup read-only around the GitHub binding', () => {
  const project = {
    ...providerProject(),
    setup: {id: 'setup-1', state: 'pending' as const, version: 1, lastErrorCode: null,
      configuration: {repositoryBinding: 'link_existing' as const, trackerBinding: 'link_existing' as const,
        internalChat: 'none' as const, clientChat: 'none' as const, executionMode: 'manual' as const,
        agentProfileId: null}}
  };
  const markup = renderToStaticMarkup(createElement(WorkspaceShell, {
    route: workspaceRoute(['projects', 'msa', 'setup'], {})!,
    data: projectWorkspace(project)
  }));
  expect(markup).toContain('Задачи, статусы, назначения, даты и зависимости изменяются в GitHub Project');
  expect(markup).toContain('Открыть GitHub Project');
  expect(markup).not.toContain('План проекта');
  expect(markup).not.toContain('Исходные материалы');
  expect(markup).not.toContain('Материализовать');
});
it('distinguishes edit-only delivery authority from Product Owner approval', () => {
  const markup = renderToStaticMarkup(createElement(ProjectPlanControls, {
    projectId: '22222222-2222-4222-8222-222222222222',
    csrfToken: 'csrf', canEdit: true, canApprove: false,
    plan: {artifacts: [], draft: null, approved: null, approvedSourceManifest: [], approvedSourceManifestHash: null, approvedSimulation: null, materialization: null}
  }));
  expect(markup).toContain('Редактирование доступно');
  expect(markup).toContain('активный Product Owner');
  expect(markup).not.toContain('Утвердить версию');
});

it('allows draft generation only from a selected complete dossier', () => {
  const artifact = (id: string, sourceKind: 'project_passport' | 'solution_architecture' | 'client_requirements' | 'acceptance_method') => ({
    id, name: sourceKind, sourceKind, mediaType: 'text/plain', content: 'Подтверждённый текст', sizeBytes: 22,
    sha256: 'a'.repeat(64), sourceFile: null, version: 1,
    provenance: {kind: 'manager_note' as const, label: 'PO', capturedAt: '2026-08-09T10:00:00.000Z'}
  });
  const base = {draft: null, approved: null, approvedSourceManifest: [], approvedSourceManifestHash: null,
    approvedSimulation: null, materialization: null, plannerEligibility: {eligible: true, remediation: 'Hermes ready'}};
  const incomplete = renderToStaticMarkup(createElement(ProjectPlanControls, {
    projectId: '22222222-2222-4222-8222-222222222222', csrfToken: 'csrf', canEdit: true, canApprove: true,
    plan: {...base, artifacts: [artifact('11111111-1111-4111-8111-111111111111', 'project_passport')]}
  }));
  const buttonFor = (markup: string) => {
    const labelAt = markup.indexOf('Собрать черновик через Hermes');
    return markup.slice(markup.lastIndexOf('<button', labelAt), markup.indexOf('</button>', labelAt) + '</button>'.length);
  };
  const incompleteButton = buttonFor(incomplete);
  expect(incomplete).toContain('Добавьте источник: требования клиента.');
  expect(incompleteButton).toContain('disabled');
  const complete = renderToStaticMarkup(createElement(ProjectPlanControls, {
    projectId: '22222222-2222-4222-8222-222222222222', csrfToken: 'csrf', canEdit: true, canApprove: true,
    plan: {...base, artifacts: [artifact('11111111-1111-4111-8111-111111111111', 'project_passport'), artifact('22222222-2222-4222-8222-222222222222', 'solution_architecture'), artifact('33333333-3333-4333-8333-333333333333', 'client_requirements')]}
  }));
  const completeButton = buttonFor(complete);
  expect(completeButton).not.toContain('disabled');
});

it('does not present Hermes planning as global project capability', () => {
  const artifact = (id: string, sourceKind: 'project_passport' | 'client_requirements' | 'acceptance_method') => ({id, name: sourceKind, sourceKind, mediaType: 'text/plain', content: 'Подтверждённый текст', sizeBytes: 22, sha256: 'a'.repeat(64), sourceFile: null, version: 1, provenance: {kind: 'manager_note' as const, label: 'PO', capturedAt: '2026-08-09T10:00:00.000Z'}});
  const markup = renderToStaticMarkup(createElement(ProjectPlanControls, {projectId: '22222222-2222-4222-8222-222222222222', csrfToken: 'csrf', canEdit: true, canApprove: true,
    plan: {artifacts: [artifact('11111111-1111-4111-8111-111111111111', 'project_passport'), artifact('22222222-2222-4222-8222-222222222222', 'client_requirements'), artifact('33333333-3333-4333-8333-333333333333', 'acceptance_method')], draft: null, approved: null, approvedSourceManifest: [], approvedSourceManifestHash: null, approvedSimulation: null, materialization: null, plannerEligibility: {eligible: false, remediation: 'Hermes profile не назначен этому проекту.'}}}));
  const labelAt = markup.indexOf('Собрать черновик через Hermes');
  expect(markup).toContain('Hermes profile не назначен этому проекту.');
  expect(markup.slice(markup.lastIndexOf('<button', labelAt), markup.indexOf('</button>', labelAt))).toContain('disabled');
});

it('keeps ASCON/manual-Codex drafting, simulation, and saving available when Hermes is ineligible', () => {
  const draft = {id: '11111111-1111-4111-8111-111111111111', projectId: '22222222-2222-4222-8222-222222222222', revision: 1,
    state: 'draft' as const, definition: {title: 'Ручной план', outcomes: [], milestones: [], risks: [], tasks: []},
    contentHash: 'a'.repeat(64), approvedVersion: null, approvedByActorId: null, approvedAt: null};
  const markup = renderToStaticMarkup(createElement(ProjectPlanControls, {projectId: draft.projectId, csrfToken: 'csrf', canEdit: true, canApprove: true,
    plan: {artifacts: [], draft, approved: null, approvedSourceManifest: [], approvedSourceManifestHash: null, approvedSimulation: null,
      materialization: null, plannerEligibility: {eligible: false, remediation: 'Hermes не назначен ASCON.'}}}));
  const button = (label: string) => {
    const index = markup.indexOf(label);
    return markup.slice(markup.lastIndexOf('<button', index), markup.indexOf('</button>', index));
  };
  expect(markup).toContain('Для ручного планирования Hermes не нужен');
  expect(button('Собрать черновик через Hermes')).toContain('disabled');
  expect(button('Проверить последствия')).not.toContain('disabled');
  expect(button('Сохранить черновик')).not.toContain('disabled');
});

it('renders a truthful materialization summary without an execution start action', () => {
  const approved = {id: '22222222-2222-4222-8222-222222222222', projectId: '33333333-3333-4333-8333-333333333333', revision: 2, state: 'approved' as const,
    definition: {title: 'План', outcomes: [], milestones: [], risks: [], tasks: []}, contentHash: 'a'.repeat(64), approvedVersion: 1,
    approvedByActorId: '44444444-4444-4444-8444-444444444444', approvedAt: '2026-08-09T10:00:00.000Z'};
  const markup = renderToStaticMarkup(createElement(ProjectPlanControls, {projectId: approved.projectId, csrfToken: 'csrf', canEdit: true, canApprove: true,
    plan: {artifacts: [], draft: null, approved, approvedSourceManifest: [], approvedSourceManifestHash: 'b'.repeat(64), approvedSimulation: null,
      materialization: {id: '55555555-5555-4555-8555-555555555555', projectId: approved.projectId, planId: approved.id,
        planVersionId: '66666666-6666-4666-8666-666666666666', planVersion: 1, planHash: approved.contentHash, sourceManifestHash: 'b'.repeat(64),
        baselineId: '77777777-7777-4777-8777-777777777777', outcomeCount: 5, milestoneCount: 2, workItemCount: 6, dependencyCount: 4,
        journeyCount: 0, publicationIntentCount: 0, createdAt: '2026-08-09T10:00:00.000Z'}}}));
  expect(markup).toContain('План материализован');
  expect(markup).toContain('Внешние bindings не настроены');
  expect(markup).toContain('Запуск исполнения остаётся отдельным решением');
  expect(markup).toContain('Новый черновик заблокирован');
  expect(markup).toContain('scope-delta re-plan');
  expect(markup).not.toContain('Start execution');
});

it('shows schedule facts for approved plans and keeps legacy approved plans readable', () => {
  const base = {id: '22222222-2222-4222-8222-222222222222', projectId: '33333333-3333-4333-8333-333333333333', revision: 2, state: 'approved' as const,
    outcomes: [], risks: [], tasks: [], contentHash: 'a'.repeat(64), approvedVersion: 1,
    approvedByActorId: '44444444-4444-4444-8444-444444444444', approvedAt: '2026-08-09T10:00:00.000Z'};
  const plan = (milestones: ProjectPlanDefinition['milestones']) => ({...base, definition: {title: 'План', outcomes: base.outcomes, milestones, risks: base.risks, tasks: base.tasks}});
  const dated = renderToStaticMarkup(createElement(ProjectPlanControls, {projectId: base.projectId, csrfToken: 'csrf', canEdit: true, canApprove: true,
    plan: {artifacts: [], draft: null, approved: plan([{key: 'm2', title: 'Финал', checkpoint: 'PO принимает', targetAt: '2026-09-20', evidence: {kind: 'assumption', statement: 'Подтвердить'}}, {key: 'm1', title: 'Стартовая приёмка', checkpoint: 'PO принимает', targetAt: '2026-09-12', evidence: {kind: 'assumption', statement: 'Подтвердить'}}]), approvedSourceManifest: [], approvedSourceManifestHash: null, approvedSimulation: null, materialization: null}}));
  expect(dated).toContain('Утверждённый план и сроки');
  expect(dated).toContain('Ближайшая контрольная точка: Стартовая приёмка · 2026-09-12');
  expect(dated).toContain('Финальная дата плана: 2026-09-20');
  const legacy = renderToStaticMarkup(createElement(ProjectPlanControls, {projectId: base.projectId, csrfToken: 'csrf', canEdit: true, canApprove: true,
    plan: {artifacts: [], draft: null, approved: plan([{key: 'm1', title: 'Приёмка', checkpoint: 'PO принимает', targetAt: null, evidence: {kind: 'assumption', statement: 'Подтвердить'}}]), approvedSourceManifest: [], approvedSourceManifestHash: null, approvedSimulation: null, materialization: null}}));
  expect(legacy).toContain('Утверждённый legacy-план · сроки не заполнены');
  expect(legacy).toContain('Укажите плановую дату для контрольных точек: «Приёмка».');
  expect(legacy).toContain('scope-delta re-plan');
});

it('renders a dynamic authorized project card, manager intake, and resumable setup detail', () => {
  const actorId = '11111111-1111-4111-8111-111111111111';
  const projectId = '22222222-2222-4222-8222-222222222222';
  const project = {project: {id: projectId, workspaceId: 'workspace-1', name: 'Dynamic', slug: 'dynamic-project',
    description: null, defaultBranch: 'main', updatedAt: new Date()}, setup: {id: 'setup-1', state: 'pending',
    version: 1, lastErrorCode: null, configuration: {repositoryBinding: 'create_managed', trackerBinding: 'link_existing',
      internalChat: 'none', clientChat: 'none', executionMode: 'manual', agentProfileId: null}},
    agentProfiles: [], snapshot: null, synchronizedAt: null, workItems: []};
  const access = {canRetireAgents: false, instructionBaselines: [], actors: [{id: actorId, displayName: 'Manager',
    type: 'human', role: 'workspace_admin', disabledAt: null, capabilities: {'write:control_plane:development': true}}],
    memberships: [{id: 'membership-1', projectId, project: 'Dynamic', projectSlug: 'dynamic-project', actorId,
      roles: ['project_owner'], active: true, version: 1, canManage: true}], externalIdentities: [], resourceGrants: [],
    agentSystems: [], requests: [], secretRefs: [], policy: [], sharing: {enabled: false, projects: [], grants: []}};
  const base = {portfolio: {state: 'unconfigured'}, project: null, runs: null, health: null, projectIndex: [project],
    csrfToken: 'csrf', operatorActorId: actorId, access: {state: 'ready', data: access}} as unknown as WorkspaceData;
  const projectsMarkup = renderToStaticMarkup(createElement(WorkspaceShell, {route: workspaceRoute(['projects'], {})!, data: base}));
  expect(projectsMarkup).toContain('Dynamic');
  expect(projectsMarkup).toContain('/projects/dynamic-project/setup');
  expect(projectsMarkup).toContain('action="/api/projects"');
  expect(projectsMarkup).toContain('Создать проект');
  expect(projectsMarkup).toContain('Участники и роли');
  expect(projectsMarkup).toContain('Можно настроить позже');
  const detailMarkup = renderToStaticMarkup(createElement(WorkspaceShell, {route: workspaceRoute(['projects', 'dynamic-project', 'setup'], {})!,
    data: {...base, project: {state: 'ready', data: project}} as unknown as WorkspaceData}));
  expect(detailMarkup).toContain('Владелец продукта');
  expect(detailMarkup).toContain('Состояние: Неизвестно');
  expect(detailMarkup).not.toContain('PO + Developer');
  expect(detailMarkup).toContain('Ожидает настройки');
  expect(detailMarkup).toContain('Создать управляемый');
  expect(detailMarkup).toContain('Связать существующий');
  expect(detailMarkup).not.toContain('observation-backed');
  expect(detailMarkup).not.toContain('Все обязательные ресурсы подтверждены');
});

it('renders authenticated, version-checked instruction publication and rollback controls', () => {
  const data = {
    portfolio: {state: 'unconfigured'}, project: null, runs: null, health: null, projectIndex: [], csrfToken: 'csrf',
    access: {state: 'ready', data: {
      canRetireAgents: false,
      instructionBaselines: [{workspaceId: 'workspace-1', current: {id: 'version-2', version: 2, instructions: 'Use evidence.', createdAt: new Date('2026-08-09T12:00:00.000Z'), rollbackOfVersionId: null}, previous: {id: 'version-1', version: 1, instructions: 'Use facts.', createdAt: new Date('2026-08-08T12:00:00.000Z'), rollbackOfVersionId: null}}],
      actors: [], memberships: [], externalIdentities: [], resourceGrants: [], agentSystems: [], requests: [], secretRefs: [], policy: [], sharing: {enabled: false, projects: [], grants: []}
    }}
  } as unknown as WorkspaceData;
  const markup = renderToStaticMarkup(createElement(WorkspaceShell, {
    route: workspaceRoute(['people'], {})!, data
  }));
  expect(markup).toContain('Управление · расширенные настройки');
  expect(markup).toContain('Версия 2');
  expect(markup).toContain('Разница с версией 1');
  expect(markup).toContain('action="/api/instructions/versions"');
  expect(markup).toContain('Опубликовать версию');
  expect(markup).toContain('Откатить к версии 1');
});

it('derives portfolio facts from persisted work, approval, milestone, and transition records', () => {
  const asOf = new Date('2026-07-30T12:00:00.000Z');
  const metrics = derivePortfolioProjectMetrics({
    projectId: 'msa', asOf, integrationFreshness: new Date('2026-07-30T11:45:00.000Z'),
    items: [
      {id: 'one', projectId: 'msa', status: 'in_dev', blocked: false, updatedAt: new Date('2026-07-20T12:00:00.000Z')},
      {id: 'two', projectId: 'msa', status: 'qa', blocked: true, updatedAt: new Date('2026-07-30T11:00:00.000Z')},
      {id: 'three', projectId: 'msa', status: 'done', blocked: true, updatedAt: asOf}
    ],
    approvals: [{projectId: 'msa', createdAt: new Date('2026-07-28T12:00:00.000Z')}],
    milestones: [{projectId: 'msa', targetAt: new Date('2026-07-29T12:00:00.000Z'), closedAt: null}],
    deadlines: [],
    transitions: [
      {workItemId: 'one', projectId: 'msa', toStatus: 'in_dev', createdAt: new Date('2026-05-21T12:00:00.000Z')},
      {workItemId: 'one', projectId: 'msa', toStatus: 'done', createdAt: new Date('2026-06-01T12:00:00.000Z')},
      {workItemId: 'one', projectId: 'msa', toStatus: 'done', createdAt: new Date('2026-06-02T12:00:00.000Z')}
    ]
  });

  expect(metrics.stages).toMatchObject({in_dev: 1, qa: 1, done: 1});
  expect(metrics.activeWip).toBe(2);
  expect(metrics.blockedWork).toBe(1);
  expect(metrics.staleActiveWork).toBe(1);
  expect(metrics.pendingApprovals).toEqual({count: 1, oldestAt: new Date('2026-07-28T12:00:00.000Z')});
  expect(metrics.milestoneOutlook).toEqual({state: 'dated', due: 0, overdue: 1});
  expect(metrics.throughputTrend.state).toBe('not_enough_history');
  expect(metrics.cycleTime.state).toBe('not_enough_history');
  expect(metrics.cycleTime.samples).toBe(1);
});

it('derives fleet health from availability observations with run-lease fallback', () => {
  const asOf = new Date('2026-07-30T12:00:00.000Z');
  const base = {actorDisabled: false, profileEnabled: true, registrations: [{enabled: true}]};
  expect(deriveFleetHealth({...base, currentRun: {status: 'running', heartbeatAt: asOf, leaseExpiresAt: new Date('2026-07-30T12:01:00.000Z')}, asOf})).toBe('healthy');
  expect(deriveFleetHealth({...base, currentRun: {status: 'running', heartbeatAt: asOf, leaseExpiresAt: new Date('2026-07-30T11:59:00.000Z')}, asOf})).toBe('stale');
  expect(deriveFleetHealth({...base, currentRun: {status: 'queued', heartbeatAt: null, leaseExpiresAt: null}, asOf})).toBe('unknown');
  expect(deriveFleetHealth({...base, profileEnabled: false, currentRun: null, asOf})).toBe('disabled');
  expect(deriveFleetHealth({
    ...base,
    registrations: [{enabled: true, availability: {
      health: 'healthy', freshnessAt: asOf,
      components: {
        service: {state: 'healthy', observedAt: asOf, evidenceReference: 'probe:service'},
        scheduler: {state: 'healthy', observedAt: asOf, evidenceReference: 'probe:scheduler'},
        delivery: {state: 'healthy', observedAt: asOf, evidenceReference: 'report:1'}
      }
    }}],
    currentRun: null,
    asOf
  })).toBe('healthy');
  expect(deriveFleetHealth({...base, registrations: [], currentRun: null, asOf})).toBe('not_configured');
});

it('renders a separate weighted-scope progress card for every accessible project', () => {
  const observedAt = new Date('2026-08-04T15:02:00.000Z');
  const project = {project: {id: 'msa', workspaceId: 'workspace-1', name: 'MSA', slug: 'msa' as const, description: null, defaultBranch: 'main', updatedAt: observedAt}, agentProfiles: [], snapshot: null, synchronizedAt: null, protocol: null, workItems: [], scopeBaseline: {id: 'baseline-1', version: 1, approvedAt: observedAt, updatedAt: observedAt, checkpoint: null, observations: [{acceptedWeight: 45, totalWeight: 100, observedAt}], outcomes: [
    {key: 'foundation', title: 'Foundation', weight: 5, state: 'accepted' as const, acceptedBy: 'Vladimir', acceptedAt: observedAt, evidenceReference: '#91'},
    {key: 'matching', title: 'Matching', weight: 20, state: 'accepted' as const, acceptedBy: 'Vladimir', acceptedAt: observedAt, evidenceReference: '#91'},
    {key: 'documents', title: 'Documents', weight: 20, state: 'accepted' as const, acceptedBy: 'Vladimir', acceptedAt: observedAt, evidenceReference: '#91'},
    {key: 'api', title: 'API', weight: 20, state: 'review' as const, acceptedBy: null, acceptedAt: null, evidenceReference: '#91'},
    {key: 'feedback', title: 'Feedback', weight: 10, state: 'in_progress' as const, acceptedBy: null, acceptedAt: null, evidenceReference: '#91'},
    {key: 'security', title: 'Security', weight: 10, state: 'in_progress' as const, acceptedBy: null, acceptedAt: null, evidenceReference: '#91'},
    {key: 'e2e', title: 'E2E', weight: 10, state: 'in_progress' as const, acceptedBy: null, acceptedAt: null, evidenceReference: '#91'},
    {key: 'release', title: 'Release', weight: 5, state: 'not_started' as const, acceptedBy: null, acceptedAt: null, evidenceReference: '#91'}
  ]}};
  const data = {
    access: {state: 'unconfigured'}, health: null, project: null, runs: null, projectIndex: [project],
    portfolio: {state: 'ready', data: {attention: [], projects: [{id: 'msa', name: 'MSA', slug: 'msa', health: 'yellow', snapshotAt: null, synchronizedAt: new Date('2026-07-30T11:45:00.000Z'), unresolvedRiskCount: 0, metrics: {stages: {backlog: 1, ready: 1, in_dev: 2, qa: 1, acceptance: 0, done: 3}, activeWip: 3, blockedWork: 1, staleActiveWork: 1, pendingApprovals: {count: 2, oldestAt: new Date('2026-07-29T11:45:00.000Z')}, integrationFreshness: new Date('2026-07-30T11:45:00.000Z'), milestoneOutlook: {state: 'unknown', due: 0, overdue: 0}, throughputTrend: {state: 'not_enough_history', recent: 1, previous: 0}, cycleTime: {state: 'not_enough_history', averageHours: null, samples: 1}}}]}}
  } as unknown as WorkspaceData;
  const markup = renderToStaticMarkup(createElement(WorkspaceShell, {route: {screen: 'dashboard', project: null, taskId: null, runId: null, agentId: null, scope: {environment: null, from: null, to: null}}, data}));

  expect(markup).toContain('Обзор проектов');
  expect(markup).toContain('MSA');
  expect(markup).toContain('45 / 100');
  expect(markup).toContain('Принято 45');
  expect(markup).toContain('На проверке 20');
  expect(markup).toContain('В работе 30');
  expect(markup).toContain('Не начато 5');
  expect(markup).toContain('href="/projects/msa/overview"');
  expect(markup).not.toContain('Active WIP');
  expect(markup).not.toContain('Все проекты');
});

it('shows canonical project risk on the dashboard without mixing operational compatibility rows', () => {
  const project = {project: {id: 'msa', workspaceId: 'workspace-1', name: 'MSA', slug: 'msa' as const, description: null, defaultBranch: 'main', updatedAt: new Date()}, agentProfiles: [], snapshot: null, synchronizedAt: null, protocol: null, workItems: []};
  const data = {
    access: {state: 'unconfigured'}, health: null, project: null, runs: null, projectIndex: [project],
    portfolio: {state: 'ready', data: {projects: [{id: 'msa', name: 'MSA', slug: 'msa', health: 'yellow', snapshotAt: null, synchronizedAt: null, unresolvedRiskCount: 1, metrics: {stages: {backlog: 0, ready: 0, in_dev: 1, qa: 0, acceptance: 0, done: 0}, activeWip: 1, blockedWork: 0, staleActiveWork: 0, pendingApprovals: {count: 0, oldestAt: null}, integrationFreshness: null, milestoneOutlook: {state: 'unknown', due: 0, overdue: 0}, throughputTrend: {state: 'not_enough_history', recent: 0, previous: 0}, cycleTime: {state: 'not_enough_history', averageHours: null, samples: 0}}}], attention: [{id: 'risk:1', riskSignalId: '00000000-0000-4000-8000-000000000001', projectId: 'msa', workItemId: 'task-1', severity: 'red', project: 'MSA', object: 'Deployment task', reason: 'Failed verification', stage: 'qa', signalClass: 'fact', impact: 'Release is blocked', freshness: new Date('2026-07-30T10:00:00.000Z'), owner: 'Canonical owner', evidenceReferences: [{type: 'run', id: 'run-1'}], nextAction: 'Review failed verification', sourceUrl: 'https://github.com/VF78/fai-control-plane/issues/1', evidence: 'run: run-1', action: {label: 'Open source', href: 'https://github.com/VF78/fai-control-plane/issues/1'}, disposition: {kind: 'acknowledged', reason: 'investigating', expiresAt: new Date('2026-08-01T12:00:00.000Z'), reentryCondition: 'risk_unresolved_at_expiry', version: 1}, dispositionVersion: 1}, {id: 'job:1', riskSignalId: null, projectId: 'msa', workItemId: null, severity: 'red', project: 'MSA', object: 'Recovery scan', reason: 'Scheduled job is unhealthy', stage: null, signalClass: null, impact: null, freshness: new Date('2026-07-30T09:00:00.000Z'), owner: null, evidenceReferences: [], nextAction: null, sourceUrl: null, evidence: 'Scheduled job status', action: {label: 'No external record', href: null}, disposition: null, dispositionVersion: 0}]}}
  } as unknown as WorkspaceData;
  const markup = renderToStaticMarkup(createElement(WorkspaceShell, {route: {screen: 'dashboard', project: null, taskId: null, runId: null, agentId: null, scope: {environment: null, from: null, to: null}}, data}));

  expect(markup).toContain('Обзор проектов');
  expect(markup).toContain('MSA');
  expect(markup).toContain('Failed verification');
  expect(markup).toContain('Canonical owner');
  expect(markup).toContain('Review failed verification');
  expect(markup).not.toContain('Deployment task');
  expect(markup).not.toContain('Recovery scan');
  expect(markup).not.toContain('Release is blocked');
});

it('keeps the web-first workspace IA and honest unavailable state', () => {
  const markup = renderToStaticMarkup(createElement(WorkspaceShell, {
    route: {screen: 'dashboard', project: null, taskId: null, runId: null, agentId: null, scope: {environment: null, from: null, to: null}},
    data: {portfolio: {state: 'unconfigured'}, access: {state: 'unconfigured'}, project: null, runs: null, health: null, projectIndex: []}
  }));

  expect(markup).toContain('Доступные проекты');
  expect(markup).toContain('Рабочие разделы');
  expect(markup).toContain('Контроль');
  expect(markup).toContain('Настройки');
  expect(markup).not.toContain('Изменение проекта и интеграций — следующий этап');
  expect(markup).not.toContain('Все проекты');
  expect(markup).toContain('Нет доступных проектов');
  expect(markup).not.toContain('Provider ID');
});

it('keeps project overview on provider facts instead of a local progress surrogate', () => {
  const project = {
    ...providerProject([providerTask('1', 'Provider task')]),
    scopeBaseline: {id: 'baseline-1', version: 1, approvedAt: new Date(), updatedAt: new Date(),
      checkpoint: null, observations: [], outcomes: [{key: 'accepted', title: 'Legacy outcome',
        weight: 100, state: 'accepted' as const, acceptedBy: 'Vladimir', acceptedAt: new Date(),
        evidenceReference: '#91'}]}
  };
  const markup = renderToStaticMarkup(createElement(WorkspaceShell, {
    route: workspaceRoute(['projects', 'msa', 'overview'], {})!,
    data: projectWorkspace(project)
  }));
  expect(markup).toContain('Источник истины');
  expect(markup).toContain('Read mirror, без локального task lifecycle');
  expect(markup).toContain('Provider task');
  expect(markup).not.toContain('Legacy outcome');
  expect(markup).not.toContain('Управленческий маршрут');
});
it('does not expose local execution activation from the provider overview', () => {
  const project = providerProject([providerTask('1', 'Provider task')]);
  const markup = renderToStaticMarkup(createElement(WorkspaceShell, {
    route: workspaceRoute(['projects', 'msa', 'overview'], {})!,
    data: projectWorkspace(project)
  }));
  expect(markup).toContain('Источник истины');
  expect(markup).not.toContain('Подготовить запуск агента');
  expect(markup).not.toContain('Запустить исполнение');
  expect(markup).not.toContain('write:control_plane:development');
});
it('keeps the provider overview structurally simple at the 390px breakpoint', () => {
  const project = providerProject([providerTask('1', 'ASCON task', 'QA')], {
    name: 'ASCON', slug: 'ascon'
  });
  const markup = renderToStaticMarkup(createElement(WorkspaceShell, {
    route: workspaceRoute(['projects', 'ascon', 'overview'], {})!,
    data: projectWorkspace(project)
  }));
  expect(markup).toContain('Источник истины');
  expect(markup).toContain('Открытые задачи');
  expect(markup).toContain('ASCON task');
  expect(markup).not.toContain('fcp-management-route-step');
  expect(markup).not.toContain('Исполнение / запуски');
  expect(markup).not.toContain('Развёртывание');
});
it('keeps autonomous QA truthful and actionable only after a structured pass at the 390px structure', () => {
  const selection = {planVersionId: 'plan-1', workItemId: 'work-1', title: 'QA work',
    workItemVersion: 4, protocolId: 'protocol-1', protocolVersion: 2, journeyVersion: 3,
    stageKey: 'qa', stageName: 'Quality assurance', executionMode: 'autonomous',
    responsibleActor: {id: 'agent-1', displayName: 'Hermes', type: 'agent', agentProfileId: 'profile-1'},
    boundary: 'autonomous_ready'};
  const base = {projectId: 'project-1', status: 'running', version: 7, selection,
    dispatch: null, blockReason: null, decisions: [], startedAt: null, pausedAt: null,
    completedAt: null, updatedAt: null};
  const unavailable = renderToStaticMarkup(createElement(ProjectExecutionControls, {
    projectId: 'project-1', execution: base as never, csrfToken: 'csrf', canManage: true,
    hasWriteCapability: true, runnerQueueAvailable: true, autonomousQaStage: true,
    autonomousQaTransportAvailable: false
  }));
  expect(unavailable).toContain('Codex CLI — исполнитель, но не заменяет Hermes-оркестратор');
  expect(unavailable).toContain('Hermes 0.18.2 → Codex CLI');
  expect(unavailable).toContain('Идентификация не настроена');
  expect(unavailable).not.toContain('Подготовить запуск агента');

  const receipt = renderToStaticMarkup(createElement(ProjectExecutionControls, {
    projectId: 'project-1', csrfToken: 'csrf', canManage: true, hasWriteCapability: true,
    runnerQueueAvailable: true, autonomousQaStage: true, autonomousQaTransportAvailable: true,
    execution: {...base, dispatch: {selectionHash: 'a'.repeat(64), taskPacketId: 'packet-1',
      taskPacketHash: 'b'.repeat(64), agentRunId: 'run-1', agentRunStatus: 'done', attempt: 1,
      failureCode: null, queuedAt: '2026-08-09T10:00:00.000Z', claimedAt: '2026-08-09T10:01:00.000Z',
      completedAt: '2026-08-09T10:02:00.000Z', nextAction: 'Явно принять manager command.',
      qa: {receiptId: 'receipt-1', outcome: 'passed',
        checks: [{name: 'focused', status: 'passed', reference: 'Артефакт 12345678 · sha256 abcdef123456…'}],
        artifacts: [{kind: 'report', reference: 'Артефакт 12345678 · sha256 abcdef123456…'}],
        failures: [], risks: [],
        recordedAt: '2026-08-09T10:02:00.000Z', approvalId: 'approval-1', approvalStatus: 'pending'}}
    } as never
  }));
  expect(receipt).toContain('Структурированный QA receipt');
  expect(receipt).toContain('focused: passed (Артефакт 12345678 · sha256 abcdef123456…)');
  expect(receipt).not.toContain('qa://');
  expect(receipt).toContain('Ожидается manager / Product Owner');
  expect(receipt).toContain('Принять machine QA');
});

it('keeps the selected workspace area when changing between authorized projects', () => {
  const project = (name: 'MSA' | 'ASCON', slug: 'msa' | 'ascon') => ({project: {id: slug, workspaceId: 'workspace-1', name, slug, description: null, defaultBranch: 'main', version: 1, updatedAt: new Date()}, runnerQueueEnabled: false, deployments: [], agentProfiles: [], snapshot: null, synchronizedAt: null, protocol: null, execution: {projectId: slug, status: 'stopped' as const, version: 0, selection: null, dispatch: null, blockReason: null, decisions: [], startedAt: null, pausedAt: null, completedAt: null, updatedAt: null}, workItems: []});
  const markup = renderToStaticMarkup(createElement(WorkspaceShell, {
    route: {screen: 'global_tasks', project: null, globalProject: 'msa', taskId: null, runId: null, agentId: null, scope: {environment: null, from: null, to: null}},
    data: {portfolio: {state: 'unconfigured'}, access: {state: 'unconfigured'}, project: null, runs: null, health: null, projectIndex: [project('MSA', 'msa'), project('ASCON', 'ascon')]}
  }));

  expect(markup).toContain('href="/projects/msa/tasks"');
  expect(markup).toContain('href="/projects/ascon/tasks"');
  expect(markup).not.toContain('project=all');
  expect(markup).not.toContain('>Все</a>');
});

it('keeps the five workspace areas explicit and deferred actions non-operative', () => {
  const markup = renderToStaticMarkup(createElement(WorkspaceShell, {
    route: {screen: 'people', project: null, taskId: null, runId: null, agentId: null, scope: {environment: null, from: null, to: null}},
    data: {portfolio: {state: 'unconfigured'}, access: {state: 'unconfigured'}, project: null, runs: null, health: null, projectIndex: []}
  }));
  expect(markup).toContain('Рабочие разделы');
  expect(markup).toContain('Контроль');
  expect(markup).toContain('Доступы недоступны');
  expect(markup).not.toContain('Manage members');
});

it('renders only the fixed MSA and ASCON roster memberships in People & Access', () => {
  const data = {
    portfolio: {state: 'unconfigured'}, project: null, runs: null, health: null, projectIndex: [],
    access: {state: 'ready', data: {
      canRetireAgents: false,
      actors: [
        {id: 'vladimir', displayName: 'Vladimir', type: 'human', role: 'workspace_admin', disabledAt: null, capabilities: {}},
        {id: 'vitaliy', displayName: 'Vitaliy', type: 'human', role: 'contributor', disabledAt: null, capabilities: {}},
        {id: 'hermes', displayName: 'Hermes', type: 'agent', role: 'contributor', disabledAt: null, capabilities: {}}
      ],
      memberships: [
        {projectId: 'msa', project: 'MSA', projectSlug: 'msa', actorId: 'vladimir', roles: ['project_owner'], active: true, version: 1},
        {projectId: 'msa', project: 'MSA', projectSlug: 'msa', actorId: 'vitaliy', roles: ['contributor'], active: true, version: 1},
        {projectId: 'msa', project: 'MSA', projectSlug: 'msa', actorId: 'hermes', roles: ['agent'], active: true, version: 1},
        {projectId: 'ascon', project: 'ASCON', projectSlug: 'ascon', actorId: 'vladimir', roles: ['project_owner'], active: true, version: 1},
        {projectId: 'ascon', project: 'ASCON', projectSlug: 'ascon', actorId: 'vitaliy', roles: ['contributor'], active: false, version: 2},
        {projectId: 'ascon', project: 'ASCON', projectSlug: 'ascon', actorId: 'hermes', roles: ['agent'], active: false, version: 2}
      ], externalIdentities: [], resourceGrants: [], agentSystems: [], requests: [], secretRefs: [], policy: [], sharing: {enabled: false, projects: [], grants: []}
    }}
  } as unknown as WorkspaceData;
  const markup = renderToStaticMarkup(createElement(WorkspaceShell, {
    route: {screen: 'people', project: null, taskId: null, runId: null, agentId: null, scope: {environment: null, from: null, to: null}}, data
  }));
  expect(markup).toContain('Vladimir</strong><small>MSA · Владелец продукта · человек');
  expect(markup).toContain('Vitaliy</strong><small>MSA · Разработчик · человек');
  expect(markup).toContain('Hermes</strong><small>MSA · ИИ-агент</small>');
  expect(markup).toContain('Vladimir</strong><small>ASCON · Владелец продукта · человек');
  expect(markup).not.toContain('Vitaliy</strong><small>ASCON');
  expect(markup).not.toContain('Hermes</strong><small>ASCON');
  expect(markup).not.toContain('href="/projects/ascon/access/hermes"');
  expect(markup).toContain('Роль зафиксирована');
  expect(markup).toContain('Неизвестно');
  expect(markup).not.toContain('Add person');
});

it('renders real authenticated onboarding forms only inside People and Agents management disclosure', () => {
  const access = {
    canRetireAgents: false,
    actors: [{id: 'owner', displayName: 'Owner', type: 'human', role: 'workspace_admin', disabledAt: null, capabilities: {}}],
    memberships: [{projectId: '11111111-1111-4111-8111-111111111111', project: 'MSA', projectSlug: 'msa', actorId: 'owner', roles: ['project_owner'], active: true, version: 1, canManage: true}],
    externalIdentities: [], resourceGrants: [], agentSystems: [], requests: [], secretRefs: [], policy: [],
    sharing: {enabled: false, projects: [], grants: []}
  };
  const data = {portfolio: {state: 'unconfigured'}, project: null, runs: null, health: null, projectIndex: [], csrfToken: 'csrf', access: {state: 'ready', data: access}} as unknown as WorkspaceData;
  const people = renderToStaticMarkup(createElement(WorkspaceShell, {route: workspaceRoute(['people'], {})!, data}));
  const agents = renderToStaticMarkup(createElement(WorkspaceShell, {route: workspaceRoute(['agents'], {project: 'msa'})!, data}));
  for (const markup of [people, agents]) {
    expect(markup).toContain('action="/api/access/onboarding"');
    expect(markup).toContain('type="hidden" name="_csrf" value="csrf"');
    expect(markup).not.toContain('подключение новых агентов запланировано');
  }
  expect(people).toContain('Добавить человека');
  expect(agents).toContain('Управление · добавить агента');
  expect(agents).toContain('Секреты и настройки провайдера не принимаются');
});

it('renders the same provider-native task facts in desktop and mobile project views', () => {
  const task = {
    ...providerTask('PVTI_MSA_1', 'MSA provider task', 'QA'),
    assignees: [{externalId: 'github:user:vitaliy', login: 'vitaliy'}],
    targetDate: '2026-08-31',
    dependencyExternalIds: ['github:issue:9']
  };
  const project = providerProject([task]);
  const other = providerProject([providerTask('PVTI_ASCON_1', 'ASCON task', 'Done')], {
    name: 'ASCON', slug: 'ascon'
  });
  const data = {...projectWorkspace(project), projectIndex: [project, other]};
  const markup = renderToStaticMarkup(createElement(WorkspaceShell, {
    route: workspaceRoute(['projects', 'msa', 'tasks'], {})!, data
  }));
  expect(markup.match(/MSA provider task/g)).toHaveLength(2);
  expect(markup).toContain('QA');
  expect(markup).toContain('vitaliy');
  expect(markup).toContain('Зависимости: 1');
  expect(markup).toContain('2026-08-31');
  expect(markup).not.toContain('ASCON task');
  expect(markup).not.toContain('Перевести:');
  expect(markup).not.toContain('Требует внимания');
});
it('does not impose an arbitrary local cap on provider tasks', () => {
  const tasks = Array.from({length: 25}, (_, index) =>
    providerTask(String(index), `Provider task ${index}`, 'Done'));
  const project = providerProject(tasks);
  const markup = renderToStaticMarkup(createElement(WorkspaceShell, {
    route: workspaceRoute(['projects', 'msa', 'tasks'], {})!,
    data: projectWorkspace(project)
  }));
  expect(markup).toContain('Provider task 0');
  expect(markup).toContain('Provider task 24');
  expect(markup).not.toContain('Показаны последние 20');
  expect(markup).not.toContain('name="status"');
});
it('does not infer a provider assignee from a local protocol role', () => {
  const project = {
    ...providerProject([providerTask('PVTI_MSA_1', 'Unassigned provider task')]),
    protocol: {id: 'protocol-1', projectId: 'msa-id', name: 'Delivery', version: 1, revision: 1,
      state: 'published' as const, active: true, contentHash: 'a'.repeat(64), definition: {
        schemaVersion: 1 as const, stages: [{key: 'development', name: 'Development', enabled: true,
          taskStatus: 'in_dev' as const, responsibility: {kind: 'project_role' as const, role: 'contributor' as const},
          executionMode: 'manual' as const, entryCriteria: ['Ready'], requiredEvidence: ['Change'],
          allowedNextStageKey: null}]}}
  };
  const markup = renderToStaticMarkup(createElement(WorkspaceShell, {
    route: workspaceRoute(['projects', 'msa', 'tasks'], {})!,
    data: projectWorkspace(project)
  }));
  expect(markup).toContain('Не назначен');
  expect(markup).not.toContain('По протоколу');
  expect(markup).not.toContain('Перевести:');
});
it('shows only active project memberships and denies a direct cross-project route', () => {
  const project = {id: 'msa-id', workspaceId: 'workspace-1', name: 'MSA', slug: 'msa' as const, description: null, defaultBranch: 'main', updatedAt: new Date()};
  const data = {
    portfolio: {state: 'ready', data: {attention: [], projects: [
      {id: 'msa-id', name: 'MSA', slug: 'msa', health: 'green', snapshotAt: null, synchronizedAt: null, unresolvedRiskCount: 0, metrics: {}},
      {id: 'ascon-id', name: 'ASCON', slug: 'ascon', health: 'green', snapshotAt: null, synchronizedAt: null, unresolvedRiskCount: 0, metrics: {}}
    ]}},
    access: {state: 'ready', data: {canRetireAgents: false, actors: [{id: 'vitaliy', displayName: 'Vitaliy', type: 'human', role: 'developer', disabledAt: null, capabilities: {}}], memberships: [{projectId: 'msa-id', project: 'MSA', projectSlug: 'msa', actorId: 'vitaliy', roles: ['contributor'], active: true, version: 1}], externalIdentities: [], resourceGrants: [], agentSystems: [], requests: [], secretRefs: [], policy: [], sharing: {enabled: false, projects: [], grants: []}}},
    project: {state: 'ready', data: {project, agentProfiles: [], snapshot: null, synchronizedAt: null, protocol: null, workItems: []}}, runs: null, health: null, projectIndex: [], operatorActorId: 'vitaliy'
  } as unknown as WorkspaceData;
  const allowed = renderToStaticMarkup(createElement(WorkspaceShell, {route: workspaceRoute(['projects', 'msa', 'tasks'], {})!, data}));
  const denied = renderToStaticMarkup(createElement(WorkspaceShell, {route: workspaceRoute(['projects', 'ascon', 'tasks'], {})!, data}));

  expect(allowed).toContain('href="/projects/msa/tasks"');
  expect(allowed).not.toContain('href="/projects/ascon/tasks"');
  expect(denied).toContain('Проект недоступен');
});

it('keeps every global surface within the operator membership and rejects unauthorized query scopes', () => {
  const data = {
    portfolio: {state: 'ready', data: {attention: [{id: 'ascon-risk', projectId: 'ascon-id', workItemId: null, severity: 'red', project: 'ASCON', object: 'ASCON secret attention', reason: 'Restricted', stage: null, signalClass: 'fact', impact: 'Restricted', freshness: new Date(), owner: null, evidenceReferences: [], nextAction: null, sourceUrl: null, evidence: 'restricted', action: {label: 'None', href: null}, disposition: null, dispositionVersion: 0}], projects: [
      {id: 'msa-id', name: 'MSA', slug: 'msa', health: 'green', snapshotAt: null, synchronizedAt: null, unresolvedRiskCount: 0, metrics: {}},
      {id: 'ascon-id', name: 'ASCON', slug: 'ascon', health: 'red', snapshotAt: null, synchronizedAt: null, unresolvedRiskCount: 1, metrics: {}}
    ]}},
    access: {state: 'ready', data: {canRetireAgents: false, actors: [
      {id: 'vitaliy', displayName: 'Vitaliy', type: 'human', role: 'developer', disabledAt: null, capabilities: {}},
      {id: 'ascon-agent', displayName: 'ASCON agent', type: 'agent', role: 'contributor', disabledAt: null, capabilities: {}}
    ], memberships: [
      {projectId: 'msa-id', project: 'MSA', projectSlug: 'msa', actorId: 'vitaliy', roles: ['contributor'], active: true, version: 1},
      {projectId: 'ascon-id', project: 'ASCON', projectSlug: 'ascon', actorId: 'ascon-agent', roles: ['agent'], active: true, version: 1}
    ], externalIdentities: [], resourceGrants: [], agentSystems: [], requests: [], secretRefs: [], policy: [], sharing: {enabled: false, projects: [], grants: []}}},
    health: {state: 'ready', data: {jobs: [
      {id: 'msa-job', project: 'MSA', projectSlug: 'msa', name: 'MSA health', status: 'healthy', heartbeatAt: null, lastSuccessAt: null, nextRunAt: null},
      {id: 'ascon-job', project: 'ASCON', projectSlug: 'ascon', name: 'ASCON secret health', status: 'unhealthy', heartbeatAt: null, lastSuccessAt: null, nextRunAt: null}
    ], integrations: [], risks: [], audit: [], costLedger: []}},
    conversations: {state: 'ready', data: {projects: [{id: 'ascon-id', name: 'ASCON', slug: 'ascon', channels: [{conversationClass: 'internal', state: 'ready', freshnessAt: new Date(), failure: null, participants: [], messages: [{id: 'ascon-message', participantId: 'none', author: 'ASCON', sentAt: new Date(), text: 'ASCON secret conversation', attachmentSummary: null, reply: false, threaded: false}]}]}]}},
    project: null, runs: null, projectIndex: [
      {project: {id: 'msa-id', workspaceId: 'workspace-1', name: 'MSA', slug: 'msa' as const, description: null, defaultBranch: 'main', updatedAt: new Date()}, agentProfiles: [], snapshot: null, synchronizedAt: null, protocol: null, workItems: []},
      {project: {id: 'ascon-id', workspaceId: 'workspace-1', name: 'ASCON', slug: 'ascon' as const, description: null, defaultBranch: 'main', updatedAt: new Date()}, agentProfiles: [], snapshot: null, synchronizedAt: null, protocol: null, workItems: []}
    ], operatorActorId: 'vitaliy'
  } as unknown as WorkspaceData;
  const dashboard = renderToStaticMarkup(createElement(WorkspaceShell, {route: workspaceRoute(['dashboard'], {})!, data}));
  const people = renderToStaticMarkup(createElement(WorkspaceShell, {route: workspaceRoute(['people'], {})!, data}));
  const agents = renderToStaticMarkup(createElement(WorkspaceShell, {route: workspaceRoute(['agents'], {project: 'msa'})!, data}));
  const deniedAgents = renderToStaticMarkup(createElement(WorkspaceShell, {route: workspaceRoute(['agents'], {project: 'ascon'})!, data}));
  const deniedChats = renderToStaticMarkup(createElement(WorkspaceShell, {route: workspaceRoute(['chats'], {project: 'ascon'})!, data}));

  expect(dashboard).toContain('MSA');
  expect(dashboard).not.toContain('ASCON');
  expect(dashboard).not.toContain('ASCON secret attention');
  expect(people).toContain('Vitaliy');
  expect(people).not.toContain('ASCON agent');
  expect(agents).toContain('MSA health');
  expect(agents).not.toContain('ASCON secret health');
  expect(deniedAgents).toContain('Проект недоступен');
  expect(deniedAgents).not.toContain('ASCON secret health');
  expect(deniedChats).toContain('Проект недоступен');
  expect(deniedChats).not.toContain('ASCON secret conversation');
});

it('keeps the legacy global tasks route project-scoped instead of rendering a mixed board', () => {
  const project = {id: 'msa-id', workspaceId: 'workspace-1', name: 'MSA', slug: 'msa' as const, description: null, defaultBranch: 'main', updatedAt: new Date()};
  const data = {portfolio: {state: 'unconfigured'}, access: {state: 'unconfigured'}, project: null, runs: null, health: null, projectIndex: [{project, agentProfiles: [], snapshot: null, synchronizedAt: null, protocol: null, workItems: []}]} as unknown as WorkspaceData;
  const markup = renderToStaticMarkup(createElement(WorkspaceShell, {route: workspaceRoute(['tasks'], {project: 'all'})!, data}));

  expect(markup).toContain('общая смешанная очередь не поддерживается');
  expect(markup).toContain('href="/projects/msa/tasks"');
  expect(markup).not.toContain('All projects');
  expect(markup).not.toContain('name="project"');
});

it('keeps the legacy global chats route project-first', () => {
  const data = {
    portfolio: {state: 'unconfigured'}, access: {state: 'unconfigured'}, project: null,
    runs: null, health: null, projectIndex: [],
    conversations: {state: 'ready', data: {projects: [{
      id: 'msa-id', name: 'MSA', slug: 'msa', channels: [
        {
          conversationClass: 'internal', state: 'ready',
          freshnessAt: new Date('2026-07-30T12:00:00.000Z'), failure: null,
          participants: [{id: 'p1', displayName: 'Vladimir', resolution: 'resolved', controlPlaneAccess: 'project owner', lastObservedAt: new Date('2026-07-30T12:00:00.000Z')}],
          messages: [{id: 'm1', participantId: 'p1', author: 'Vladimir', sentAt: new Date('2026-07-30T12:00:00.000Z'), text: '<unsafe>', attachmentSummary: null, reply: false, threaded: false}]
        },
        {
          conversationClass: 'client', state: 'not_configured',
          freshnessAt: null, failure: null, participants: [], messages: []
        }
      ]
    }]}}
  } as unknown as WorkspaceData;
  const markup = renderToStaticMarkup(createElement(WorkspaceShell, {
    route: {screen: 'global_chats', project: null, globalProject: 'msa', taskId: null, runId: null, agentId: null, scope: {environment: null, from: null, to: null}},
    data
  }));
  expect(markup).toContain('Чаты проекта');
  expect(markup).not.toContain('&lt;unsafe&gt;');
  expect(markup).not.toContain('Not configured. No verified chat binding');
});

it('renders chat intent, provider observation, read-only messages and manager controls separately', () => {
  const projectId = '11111111-1111-4111-8111-111111111111';
  const actorId = '22222222-2222-4222-8222-222222222222';
  const channelId = '33333333-3333-4333-8333-333333333333';
  const project = {id: projectId, workspaceId: '44444444-4444-4444-8444-444444444444', name: 'MSA', slug: 'msa' as const, description: null, defaultBranch: 'main', updatedAt: new Date()};
  const data = {
    portfolio: {state: 'unconfigured'}, runs: null, health: null, projectIndex: [], csrfToken: 'csrf', operatorActorId: actorId,
    project: {state: 'ready', data: {project, agentProfiles: [], snapshot: null, synchronizedAt: null, execution: {status: 'stopped', version: 0}, protocol: null, workItems: []}},
    access: {state: 'ready', data: {canRetireAgents: false, actors: [{id: actorId, displayName: 'Vladimir', type: 'human', role: 'workspace_admin', disabledAt: null, capabilities: {'write:control_plane:development': true}}], memberships: [{projectId, project: 'MSA', projectSlug: 'msa', actorId, roles: ['project_owner'], active: true, version: 1, canManage: true}], externalIdentities: [], resourceGrants: [], agentSystems: [], requests: [], secretRefs: [], policy: [], sharing: {enabled: false, projects: [], grants: []}}},
    conversations: {state: 'ready', data: {projects: [{id: projectId, name: 'MSA', slug: 'msa', channels: [{
      conversationClass: 'internal', state: 'ready', configuration: {id: channelId, desiredState: 'active', provider: 'telegram', version: 1}, freshnessAt: new Date('2026-08-09T12:00:00.000Z'), failure: null,
      access: [{actorId, displayName: 'Vladimir', roles: ['project_owner'], grantId: null, grantVersion: null, desiredLevel: 'write', observedLevel: 'read', observedAt: new Date('2026-08-09T11:59:00.000Z'), confirmation: 'mismatch'}],
      participants: [{id: 'p1', displayName: 'Vladimir', resolution: 'resolved', observedLevel: 'read', observedAt: new Date('2026-08-09T11:59:00.000Z'), lastObservedAt: new Date('2026-08-09T12:00:00.000Z')}],
      messages: [{id: 'm1', participantId: 'p1', author: 'Vladimir', sentAt: new Date('2026-08-09T12:00:00.000Z'), text: 'Готово к проверке', attachmentSummary: null, reply: false, threaded: false}]
    }, {conversationClass: 'client', state: 'not_used', configuration: {id: '55555555-5555-4555-8555-555555555555', desiredState: 'not_used', provider: null, version: 1}, freshnessAt: null, failure: null, access: [], participants: [], messages: []}]}]}}
  } as unknown as WorkspaceData;
  const markup = renderToStaticMarkup(createElement(WorkspaceShell, {route: workspaceRoute(['projects', 'msa', 'chats'], {})!, data}));
  expect(markup).toContain('желаемый: Запись');
  expect(markup).toContain('факт: Чтение');
  expect(markup).toContain('Есть расхождение');
  expect(markup).toContain('Готово к проверке');
  expect(markup).toContain('action="/api/conversations/access"');
  expect(markup).toContain('action="/api/conversations/channel"');
  expect(markup).toContain('Изменение участника выполняется в Telegram');
});

it('renders persisted agent registrations and authorized new-claim controls without inferring liveness', () => {
  const unavailable = {
    health: 'unknown' as const,
    freshnessAt: null,
    components: {
      service: {state: 'unknown' as const, observedAt: null, evidenceReference: null},
      scheduler: {state: 'unknown' as const, observedAt: null, evidenceReference: null},
      delivery: {state: 'unknown' as const, observedAt: null, evidenceReference: null}
    }
  };
  const data = {
    portfolio: {state: 'unconfigured'}, project: null, runs: null, projectIndex: [], csrfToken: 'csrf',
    health: {state: 'ready', data: {jobs: [{id: 'job-1', project: 'MSA', projectSlug: 'msa', name: 'recovery', status: 'unhealthy', heartbeatAt: null, lastSuccessAt: null, nextRunAt: null}], integrations: [], risks: [], audit: [], costLedger: []}},
    access: {state: 'ready', data: {actors: [{id: 'agent-1', displayName: 'Hermes', type: 'agent', role: 'contributor', disabledAt: null, capabilities: {}}], memberships: [{projectId: 'project-1', project: 'MSA', projectSlug: 'msa', actorId: 'agent-1', roles: ['agent'], active: true, version: 1}], agentSystems: [{actorId: 'agent-1', profiles: [{id: 'profile-1', runtimeId: 'hermes', runtimeProfile: 'read_safe', allowedTools: [], forbiddenSurfaces: [], instructions: 'Observe only.', settings: {resultFormat: 'structured_v1', includeEvidence: true}, enabled: true, version: 1, configHash: 'a'.repeat(64), registrations: [{id: 'registration-1', projectId: 'project-1', project: 'MSA', projectSlug: 'msa', provider: 'provider_neutral', runtimeKey: 'hermes', enabled: true, version: 3, updatedAt: new Date('2026-07-30T11:00:00.000Z'), availability: unavailable, canManage: true}], instruction: {workspaceVersion: 3, profileVersion: 2, hash: 'b'.repeat(64), provenance: 'workspace v3 + profile v2'}, latestRun: null, fleet: {health: 'unknown', freshnessAt: null, currentWork: null, lastReceipt: null}}]}], requests: [], secretRefs: [], policy: [], sharing: {enabled: false, projects: [], grants: []}}}
  } as unknown as WorkspaceData;
  const list = renderToStaticMarkup(createElement(WorkspaceShell, {route: {screen: 'agents', project: null, globalProject: 'msa', taskId: null, runId: null, agentId: null, scope: {environment: null, from: null, to: null}}, data}));
  const detail = renderToStaticMarkup(createElement(WorkspaceShell, {route: {screen: 'agent', project: null, taskId: null, runId: null, agentId: 'agent-1', scope: {environment: null, from: null, to: null}}, data}));
  expect(list).toContain('Агенты и системы');
  expect(list).toContain('Последний heartbeat');
  expect(detail).toContain('provider_neutral/hermes');
  expect(detail).toContain('Работоспособность, текущая работа и результаты из подтверждённых наблюдений.');
  expect(list).toContain('Работоспособность, текущая работа и последние результаты');
  expect(list).toContain('Активной задачи нет');
  expect(detail).toContain('hash действующей версии');
  expect(detail).toContain('action="/api/agent-profiles/profile-1"');
  expect(detail).toContain('версия привязки 3');
  expect(detail).toContain('aria-label="Отключить runtime-привязку MSA для новых запусков"');
  expect(detail).toContain('Новые запуски будут остановлены');
  expect(detail).toContain('Замена недоступна');
  if (data.access.state !== 'ready') throw new Error('Expected ready access fixture.');
  const claudeProfile = {
    ...data.access.data.agentSystems[0]!.profiles[0]!,
    id: 'profile-claude',
    runtimeId: 'claude',
    runtimeProfile: 'fake_safe',
    instructions: 'Return the same portable result.',
    registrations: []
  };
  const claudeData = {
    ...data,
    access: {state: 'ready', data: {
      ...data.access.data,
      agentSystems: [{actorId: 'agent-1', profiles: [claudeProfile]}]
    }}
  } as unknown as WorkspaceData;
  const claudeDetail = renderToStaticMarkup(createElement(WorkspaceShell, {route: {screen: 'agent', project: null, taskId: null, runId: null, agentId: 'agent-1', scope: {environment: null, from: null, to: null}}, data: claudeData}));
  expect(claudeDetail).toContain('claude · fake_safe');
  expect(claudeDetail).toContain('action="/api/agent-profiles/profile-claude"');
  const replacementData: WorkspaceData = {...data, access: {state: 'ready', data: {
    ...data.access.data,
    actors: [
      ...data.access.data.actors,
      {id: 'agent-2', displayName: 'Codex', type: 'agent', role: 'contributor', disabledAt: null, capabilities: {}}
    ],
    memberships: [{
      id: 'membership-agent-2',
      projectId: 'project-1',
      project: 'MSA',
      projectSlug: 'msa',
      actorId: 'agent-2',
      roles: ['agent'],
      active: true,
      version: 1,
      canManage: true
    }],
    agentSystems: [
      ...data.access.data.agentSystems,
      {
        actorId: 'agent-2',
        profiles: [{
          id: 'profile-2',
          runtimeId: 'codex',
          runtimeProfile: 'read_safe',
          allowedTools: [],
          forbiddenSurfaces: [],
          instructions: 'Observe only.',
          settings: {resultFormat: 'structured_v1', includeEvidence: true},
          enabled: true,
          version: 1,
          configHash: 'c'.repeat(64),
          registrations: [{
            id: 'registration-2',
            projectId: 'project-1',
            project: 'MSA',
            projectSlug: 'msa',
            provider: 'provider_neutral',
            runtimeKey: 'codex',
            enabled: false,
            version: 2,
            updatedAt: new Date('2026-07-30T11:00:00.000Z'),
            availability: {
              ...unavailable,
              health: 'disabled',
              components: {
                service: {state: 'disabled', observedAt: null, evidenceReference: null},
                scheduler: {state: 'disabled', observedAt: null, evidenceReference: null},
                delivery: {state: 'disabled', observedAt: null, evidenceReference: null}
              }
            },
            canManage: true
          }],
          instruction: null,
          latestRun: null,
          fleet: {health: 'disabled', freshnessAt: null, currentWork: null, lastReceipt: null}
        }]
      }
    ]
  }}};
  const replacement = renderToStaticMarkup(createElement(WorkspaceShell, {route: {screen: 'agent', project: null, taskId: null, runId: null, agentId: 'agent-1', scope: {environment: null, from: null, to: null}}, data: replacementData}));
  expect(replacement).toContain('aria-label="Целевая привязка для замены MSA"');
  expect(replacement).toContain('Codex · codex/read_safe');
  expect(replacement).toContain('aria-label="Заменить runtime-привязку MSA"');
  expect(replacement).toContain('Атомарное переключение · история сохраняется');
  const staleData: WorkspaceData = {...data, access: {state: 'ready', data: {
    ...data.access.data,
    agentSystems: data.access.data.agentSystems.map((system) => ({
      ...system,
      profiles: system.profiles.map((profile) => ({
        ...profile,
        fleet: {
          ...profile.fleet,
          health: 'stale' as const,
          currentWork: {
            id: 'run-1',
            version: 4,
            status: 'running',
            title: 'Recover runtime',
            project: 'MSA',
            projectSlug: 'msa' as const,
            startedAt: new Date('2026-07-30T08:00:00.000Z')
          }
        }
      }))
    }))
  }}};
  const stale = renderToStaticMarkup(createElement(WorkspaceShell, {route: {screen: 'agent', project: null, taskId: null, runId: null, agentId: 'agent-1', scope: {environment: null, from: null, to: null}}, data: staleData}));
  expect(stale).toContain('aria-label="Завершить зависший запуск MSA"');
  expect(stale).toContain('Завершает истёкшую аренду · история сохраняется');
  const readOnlyData: WorkspaceData = {...data, access: {state: 'ready', data: {
    ...data.access.data,
    agentSystems: data.access.data.agentSystems.map((system) => ({
      ...system,
      profiles: system.profiles.map((profile) => ({
        ...profile,
        registrations: profile.registrations.map((registration) => ({
          ...registration,
          canManage: false
        }))
      }))
    }))
  }}};
  const readOnly = renderToStaticMarkup(createElement(WorkspaceShell, {route: {screen: 'agent', project: null, taskId: null, runId: null, agentId: 'agent-1', scope: {environment: null, from: null, to: null}}, data: readOnlyData}));
  expect(readOnly).not.toContain('runtime registration for new claims');
});

it('shows owned Hermes availability attention and treats ASCON no-bot scope as configured absence', () => {
  const observedAt = new Date('2026-07-30T12:00:00.000Z');
  const staleAvailability = {
    health: 'stale' as const,
    freshnessAt: observedAt,
    components: {
      service: {state: 'healthy' as const, observedAt, evidenceReference: 'probe:service'},
      scheduler: {state: 'stale' as const, observedAt: new Date('2026-07-30T10:00:00.000Z'), evidenceReference: 'probe:scheduler'},
      delivery: {state: 'healthy' as const, observedAt, evidenceReference: 'report:daily'}
    }
  };
  const access = {
    canRetireAgents: false,
    actors: [
      {id: 'vladimir', displayName: 'Vladimir', type: 'human', role: 'workspace_admin', disabledAt: null, capabilities: {}},
      {id: 'hermes', displayName: 'Hermes', type: 'agent', role: 'contributor', disabledAt: null, capabilities: {}}
    ],
    memberships: [
      {projectId: 'msa-id', project: 'MSA', projectSlug: 'msa', actorId: 'vladimir', roles: ['project_owner'], active: true, version: 1},
      {projectId: 'msa-id', project: 'MSA', projectSlug: 'msa', actorId: 'hermes', roles: ['agent'], active: true, version: 1},
      {projectId: 'ascon-id', project: 'ASCON', projectSlug: 'ascon', actorId: 'vladimir', roles: ['project_owner'], active: true, version: 1}
    ],
    externalIdentities: [], resourceGrants: [],
    agentSystems: [{actorId: 'hermes', profiles: [{
      id: 'profile-hermes', runtimeId: 'hermes', runtimeProfile: 'read_safe',
      enabled: true, configHash: 'a'.repeat(64), allowedTools: [], forbiddenSurfaces: [],
      instructions: 'Observe.', settings: {resultFormat: 'structured_v1', includeEvidence: true}, version: 1,
      registrations: [{
        id: 'registration-hermes', projectId: 'msa-id', project: 'MSA', projectSlug: 'msa',
        provider: 'provider_neutral', runtimeKey: 'hermes', enabled: true, version: 1,
        updatedAt: observedAt, availability: staleAvailability, canManage: false
      }],
      instruction: null, latestRun: null,
      fleet: {health: 'stale', freshnessAt: observedAt, currentWork: null, lastReceipt: null}
    }]}],
    requests: [], secretRefs: [], policy: [], sharing: {enabled: false, projects: [], grants: []}
  } as unknown as AccessData;
  const alerts = deriveRuntimeAvailabilityAlerts(access);
  expect(alerts).toMatchObject([{
    project: 'MSA',
    object: 'Hermes availability',
    reason: 'scheduler: stale',
    owner: 'Vladimir',
    severity: 'red',
    nextAction: 'Refresh the provider-neutral observations and inspect stale components.'
  }]);
  const metrics = {stages: {backlog: 0, ready: 0, in_dev: 0, qa: 0, acceptance: 0, done: 0}, activeWip: 0, blockedWork: 0, staleActiveWork: 0, pendingApprovals: {count: 0, oldestAt: null}, integrationFreshness: null, milestoneOutlook: {state: 'unknown', due: 0, overdue: 0}, throughputTrend: {state: 'not_enough_history', recent: 0, previous: 0}, cycleTime: {state: 'not_enough_history', averageHours: null, samples: 0}};
  const data = {
    portfolio: {state: 'ready', data: {projects: [
      {id: 'msa-id', name: 'MSA', slug: 'msa', health: 'yellow', snapshotAt: null, synchronizedAt: null, unresolvedRiskCount: 0, metrics},
      {id: 'ascon-id', name: 'ASCON', slug: 'ascon', health: 'green', snapshotAt: null, synchronizedAt: null, unresolvedRiskCount: 0, metrics}
    ], attention: []}},
    access: {state: 'ready', data: access},
    project: null, runs: {state: 'ready', data: {runs: [], approvals: [], packets: []}},
    health: null, projectIndex: []
  } as unknown as WorkspaceData;
  const dashboard = renderToStaticMarkup(createElement(WorkspaceShell, {
    route: {screen: 'dashboard', project: null, taskId: null, runId: null, agentId: null, scope: {environment: null, from: null, to: null}},
    data
  }));
  expect(dashboard).toContain('Обзор проектов');
  expect(dashboard).not.toContain('Hermes availability');
  expect(dashboard).not.toContain('scheduler: stale');
  const ascon = renderToStaticMarkup(createElement(WorkspaceShell, {
    route: {screen: 'agents', project: null, globalProject: 'ascon', taskId: null, runId: null, agentId: null, scope: {environment: null, from: null, to: null}},
    data
  }));
  expect(ascon).toContain('Управляемого агента нет');
  expect(ascon).toContain('Владимир работает напрямую через Codex');
  expect(ascon).not.toContain('Hermes</strong>');
});

it('renders project membership and provider-confirmed grant facts in the access detail', () => {
  const data = {
    portfolio: {state: 'unconfigured'}, health: null, runs: null, projectIndex: [], csrfToken: 'csrf',
    project: {state: 'ready', data: {project: {id: 'project-1', workspaceId: 'workspace-1', name: 'MSA', slug: 'msa', description: null, defaultBranch: 'main', updatedAt: new Date()}, agentProfiles: [], snapshot: null, synchronizedAt: null, workItems: []}},
    access: {state: 'ready', data: {actors: [{id: 'actor-1', displayName: 'Vladimir', type: 'human', role: 'workspace_admin', disabledAt: null, capabilities: {}}], memberships: [{id: 'membership-1', projectId: 'project-1', project: 'MSA', projectSlug: 'msa', actorId: 'actor-1', roles: ['project_owner', 'contributor'], active: true, version: 2, canManage: true}], externalIdentities: [{actorId: 'actor-1', provider: 'github', active: true}], resourceGrants: [{id: 'grant-1', projectId: 'project-1', project: 'MSA', projectSlug: 'msa', actorId: 'actor-1', resourceType: 'repository', desiredLevel: 'admin', observedProvider: 'github', observedLevel: 'admin', observedAt: new Date('2026-07-30T12:00:00.000Z'), observationState: 'confirmed', remediation: null, providerAccessUrl: null, version: 3}], agentSystems: [], requests: [{id: 'request-1', requester: 'Vladimir', targetSurface: 'repository', requestedScope: ['msa'], status: 'pending', expiresAt: null, decidedAt: null}], secretRefs: [], policy: [], sharing: {enabled: true, projects: [{name: 'MSA', slug: 'msa', workItems: []}], grants: []}}}
  } as unknown as WorkspaceData;
  const markup = renderToStaticMarkup(createElement(WorkspaceShell, {route: {screen: 'access', project: 'msa', taskId: null, runId: null, agentId: null, accessActorId: 'actor-1', scope: {environment: null, from: null, to: null}}, data}));

  expect(markup).toContain('Карта доступов проекта');
  expect(markup).toContain('Владелец продукта · Разработчик');
  expect(markup).toContain('Требуемый и подтверждённый уровень');
  expect(markup).toContain('github');
  expect(markup).toContain('href="/projects/msa/access/actor-1"');
  expect(markup).toContain('Доступ клиента');
  expect(markup).toContain('Ссылка ограничена проектом MSA');
  expect(markup).toContain('Запросы доступа');
  expect(markup).toContain('Управляемые заявки рабочей области');
  expect(markup).toContain('action="/api/access/memberships/membership-1"');
  expect(markup).toMatch(/name="roleContributor" checked=""/);
  expect(markup).toMatch(/name="roleProjectOwner" checked=""/);
  expect(markup).toContain('action="/api/access/grants/grant-1"');
  expect(markup).toContain('После сохранения Control Plane покажет расхождение');
  expect(markup).not.toContain('Secret refs');
});

it('deep-links only a safe provider-confirmed access observation', () => {
  const data = {
    portfolio: {state: 'unconfigured'}, health: null, runs: null, projectIndex: [], csrfToken: 'csrf',
    project: {state: 'ready', data: {project: {id: 'project-1', workspaceId: 'workspace-1', name: 'MSA', slug: 'msa', description: null, defaultBranch: 'main', updatedAt: new Date()}, agentProfiles: [], snapshot: null, synchronizedAt: null, workItems: []}},
    access: {state: 'ready', data: {
      actors: [{id: 'actor-1', displayName: 'Vladimir', type: 'human', role: 'workspace_admin', disabledAt: null, capabilities: {}}],
      memberships: [{projectId: 'project-1', project: 'MSA', projectSlug: 'msa', actorId: 'actor-1', roles: ['project_owner'], active: true, version: 2}],
      externalIdentities: [],
      resourceGrants: [
        {id: 'grant-1', projectId: 'project-1', project: 'MSA', projectSlug: 'msa', actorId: 'actor-1', resourceType: 'repository', desiredLevel: 'admin', observedProvider: 'github', observedLevel: 'admin', observedAt: new Date('2026-07-30T12:00:00.000Z'), observationState: 'confirmed', remediation: null, providerAccessUrl: 'https://github.com/VF78/MSA/settings/access', version: 3},
        {id: 'grant-2', projectId: 'project-1', project: 'MSA', projectSlug: 'msa', actorId: 'actor-1', resourceType: 'tracker', desiredLevel: 'write', observedProvider: null, observedLevel: null, observedAt: null, observationState: 'unsupported', remediation: 'GitHub Project V2 не поддерживает проверку прав участников через этот адаптер. Проверьте доступ в GitHub.', providerAccessUrl: null, version: 1},
        {id: 'grant-3', projectId: 'project-1', project: 'MSA', projectSlug: 'msa', actorId: 'actor-1', resourceType: 'internal_chat', desiredLevel: 'write', observedProvider: 'telegram', observedLevel: 'read', observedAt: new Date('2026-07-30T12:00:00.000Z'), observationState: 'confirmed', remediation: null, providerAccessUrl: null, version: 1}
      ],
      agentSystems: [], requests: [], secretRefs: [], policy: [],
      sharing: {enabled: true, projects: [{name: 'MSA', slug: 'msa', workItems: []}], grants: []}
    }}
  } as unknown as WorkspaceData;
  const markup = renderToStaticMarkup(createElement(WorkspaceShell, {route: {screen: 'access', project: 'msa', taskId: null, runId: null, agentId: null, accessActorId: 'actor-1', scope: {environment: null, from: null, to: null}}, data}));

  expect(markup).toContain('Требуемый уровень: admin');
  expect(markup).toContain('Подтверждено');
  expect(markup).toContain('Не поддерживается');
  expect(markup).toContain('GitHub Project V2 не поддерживает проверку прав участников');
  expect(markup).toContain('Проверено 30 июл.');
  expect(markup).toContain('Проверка ещё не зафиксирована');
  expect(markup.match(/>Подтверждено</g)).toHaveLength(2);
  expect(markup.match(/>Не поддерживается</g)).toHaveLength(1);
  expect(markup).toContain('href="https://github.com/VF78/MSA/settings/access"');
  expect(markup).toContain('Открыть у провайдера');
  expect(markup).toContain('Не настроено');
  expect(markup).not.toContain('javascript:');
});

it('keeps provider task detail independent from local runs and approvals', () => {
  const project = providerProject([providerTask('PVTI_ASCON_1', 'Bounded provider task')], {
    name: 'ASCON', slug: 'ascon'
  });
  const data = {...projectWorkspace(project), runs: {state: 'ready' as const, data: {
    runs: [{id: 'run-1', workItemId: 'local-task', workItem: 'Legacy run', agent: 'Runner',
      status: 'done', runtimeProfile: 'read_safe', startedAt: null, completedAt: null,
      receipt: null, artifacts: [], canAcceptReceipt: false}], approvals: [], packets: []}}};
  const markup = renderToStaticMarkup(createElement(WorkspaceShell, {
    route: {...workspaceRoute(['projects', 'ascon', 'tasks', 'PVTI_ASCON_1'], {
      environment: 'staging', from: '2026-07-01', to: '2026-07-31'
    })!},
    data
  }));
  expect(markup).toContain('GitHub Project');
  expect(markup).toContain('PVTI_ASCON_1');
  expect(markup).not.toContain('Legacy run');
  expect(markup).not.toContain('Подтверждение</dt>');
  expect(markup).not.toContain('/runs/run-1');
});
it('does not read or render the retired PostgreSQL lifecycle on a provider task route', () => {
  const project = providerProject([providerTask('PVTI_MSA_1', 'Provider lifecycle truth')]);
  const data = {...projectWorkspace(project), lifecycle: {state: 'ready', data: {
    packet: {id: 'legacy-packet'}, approval: {status: 'approved'}, run: {id: 'legacy-run'},
    receipt: {terminal: 'done'}, artifactCount: 2, journeyEvidenceCount: 1,
    writeBack: {destination: 'github', status: 'published'}, audit: {action: 'work_item.transition'}
  }}} as unknown as WorkspaceData;
  const markup = renderToStaticMarkup(createElement(WorkspaceShell, {
    route: workspaceRoute(['projects', 'msa', 'tasks', 'PVTI_MSA_1'], {})!, data
  }));
  expect(markup).toContain('Provider lifecycle truth');
  expect(markup).toContain('Единственный источник task lifecycle');
  expect(markup).not.toContain('Delivery lifecycle');
  expect(markup).not.toContain('legacy-packet');
  expect(markup).not.toContain('work_item.transition');
});
it('keeps provider tasks separate from the legacy run route', () => {
  const task = providerTask('PVTI_MSA_1', 'Provider task');
  const project = providerProject([task]);
  const queuedRun = {id: 'run-1', project: 'MSA', projectSlug: 'msa', workItemId: 'local-task',
    workItem: 'Legacy local run', agent: 'Hermes', status: 'queued', runtimeProfile: 'read_safe',
    attempt: 1, packetGoal: 'Legacy goal', timeboxMinutes: 30, startedAt: null, completedAt: null,
    heartbeatAt: null, failureCode: null, version: 2, workItemVersion: 3,
    canAcceptReceipt: false, approverActorId: null, receipt: null, artifacts: []};
  const data = {...projectWorkspace(project), runs: {state: 'ready' as const,
    data: {runs: [queuedRun], approvals: [], packets: []}}};
  const taskMarkup = renderToStaticMarkup(createElement(WorkspaceShell, {
    route: workspaceRoute(['projects', 'msa', 'tasks', task.id], {})!, data
  }));
  expect(taskMarkup).toContain('Provider task');
  expect(taskMarkup).not.toContain('Собрать пакет задачи');
  expect(taskMarkup).not.toContain('Legacy local run');

  const runMarkup = renderToStaticMarkup(createElement(WorkspaceShell, {
    route: workspaceRoute(['projects', 'msa', 'runs', 'run-1'], {})!, data
  }));
  expect(runMarkup).toContain('Legacy local run');
  expect(runMarkup).toContain('Ожидать безопасного получения задания');
  expect(runMarkup).not.toContain(`href="/projects/msa/tasks/${task.id}"`);
});
it('keeps protocol facts separate from provider task facts', () => {
  const project = {
    ...providerProject([providerTask('PVTI_MSA_1', 'Bounded provider task')]),
    protocol: {id: 'protocol-1', projectId: 'msa-id', name: 'Delivery', version: 2, revision: 3,
      state: 'published' as const, active: true, contentHash: 'a'.repeat(64), definition: {
        schemaVersion: 1 as const, stages: [{key: 'development', name: 'Development', enabled: true,
          taskStatus: 'in_dev' as const, responsibility: {kind: 'project_role' as const, role: 'contributor' as const},
          executionMode: 'manual' as const, entryCriteria: ['Ready'],
          requiredEvidence: ['Implementation change'], allowedNextStageKey: null}]}}
  };
  const data = projectWorkspace(project);
  const protocol = renderToStaticMarkup(createElement(WorkspaceShell, {
    route: workspaceRoute(['projects', 'msa', 'protocol'], {})!, data
  }));
  const task = renderToStaticMarkup(createElement(WorkspaceShell, {
    route: workspaceRoute(['projects', 'msa', 'tasks', 'PVTI_MSA_1'], {})!, data
  }));
  expect(protocol).toContain('Разработка');
  expect(protocol).toContain('Изменения реализации');
  expect(task).toContain('Bounded provider task');
  expect(task).not.toContain('Canonical contributor');
  expect(task).not.toContain('commit:abc123');
  expect(task).not.toContain('Relevant checks');
});
