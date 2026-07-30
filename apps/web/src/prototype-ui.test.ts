import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect, it, vi} from 'vitest';
import {deriveFleetHealth, derivePortfolioProjectMetrics} from './operator-data';
import {workspaceRoute} from './operator-workspace-route';
import {WorkspaceShell, type WorkspaceData} from './prototype-ui';

vi.mock('next/navigation', () => ({useRouter: () => ({refresh: vi.fn()})}));

it('maps only canonical workspace routes and preserves scope on deep links', () => {
  expect(workspaceRoute(['projects', 'msa', 'tasks', 'task-1'], {
    environment: 'staging', from: '2026-07-01', to: '2026-07-31'
  })).toMatchObject({screen: 'task', project: 'msa', taskId: 'task-1', scope: {environment: 'staging', from: '2026-07-01', to: '2026-07-31'}});
  expect(workspaceRoute(['projects', 'unknown', 'overview'], {})).toBeNull();
  expect(workspaceRoute(['projects', 'msa', 'runs', ''], {})).toBeNull();
  expect(workspaceRoute(['tasks'], {project: 'unknown'})).toBeNull();
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

it('marks fleet health only from an observed unexpired running lease', () => {
  const asOf = new Date('2026-07-30T12:00:00.000Z');
  const base = {actorDisabled: false, profileEnabled: true, registrations: [{enabled: true}]};
  expect(deriveFleetHealth({...base, currentRun: {status: 'running', heartbeatAt: asOf, leaseExpiresAt: new Date('2026-07-30T12:01:00.000Z')}, asOf})).toBe('healthy');
  expect(deriveFleetHealth({...base, currentRun: {status: 'running', heartbeatAt: asOf, leaseExpiresAt: new Date('2026-07-30T11:59:00.000Z')}, asOf})).toBe('stale');
  expect(deriveFleetHealth({...base, currentRun: {status: 'queued', heartbeatAt: null, leaseExpiresAt: null}, asOf})).toBe('unknown');
  expect(deriveFleetHealth({...base, profileEnabled: false, currentRun: null, asOf})).toBe('disabled');
});

it('renders compact per-project portfolio metrics and explicit history limits', () => {
  const data = {
    access: {state: 'unconfigured'}, health: null, project: null, runs: null, projectIndex: [],
    portfolio: {state: 'ready', data: {attention: [], projects: [{id: 'msa', name: 'MSA', slug: 'msa', health: 'yellow', snapshotAt: null, synchronizedAt: new Date('2026-07-30T11:45:00.000Z'), unresolvedRiskCount: 0, metrics: {stages: {backlog: 1, ready: 1, in_dev: 2, qa: 1, acceptance: 0, done: 3}, activeWip: 3, blockedWork: 1, staleActiveWork: 1, pendingApprovals: {count: 2, oldestAt: new Date('2026-07-29T11:45:00.000Z')}, integrationFreshness: new Date('2026-07-30T11:45:00.000Z'), milestoneOutlook: {state: 'unknown', due: 0, overdue: 0}, throughputTrend: {state: 'not_enough_history', recent: 1, previous: 0}, cycleTime: {state: 'not_enough_history', averageHours: null, samples: 1}}}]}}
  } as unknown as WorkspaceData;
  const markup = renderToStaticMarkup(createElement(WorkspaceShell, {route: {screen: 'dashboard', project: null, taskId: null, runId: null, agentId: null, scope: {environment: null, from: null, to: null}}, data}));

  expect(markup).toContain('Portfolio');
  expect(markup).toContain('Active WIP');
  expect(markup).toContain('Stale active');
  expect(markup).toContain('Deadline outlook');
  expect(markup).toContain('Not enough history');
  expect(markup).not.toContain('ROI');
});

it('keeps attention facts explicit and routes its primary action to the affected task', () => {
  const data = {
    access: {state: 'unconfigured'}, health: null, project: null, runs: null, projectIndex: [],
    portfolio: {state: 'ready', data: {projects: [{id: 'msa', name: 'MSA', slug: 'msa', health: 'yellow', snapshotAt: null, synchronizedAt: null, unresolvedRiskCount: 1, metrics: {stages: {backlog: 0, ready: 0, in_dev: 1, qa: 0, acceptance: 0, done: 0}, activeWip: 1, blockedWork: 0, staleActiveWork: 0, pendingApprovals: {count: 0, oldestAt: null}, integrationFreshness: null, milestoneOutlook: {state: 'unknown', due: 0, overdue: 0}, throughputTrend: {state: 'not_enough_history', recent: 0, previous: 0}, cycleTime: {state: 'not_enough_history', averageHours: null, samples: 0}}}], attention: [{id: 'risk:1', riskSignalId: '00000000-0000-4000-8000-000000000001', projectId: 'msa', workItemId: 'task-1', severity: 'red', project: 'MSA', object: 'Deployment task', reason: 'Failed verification', stage: 'qa', signalClass: 'fact', impact: 'Release is blocked', freshness: new Date('2026-07-30T10:00:00.000Z'), owner: 'Canonical owner', evidenceReferences: [{type: 'run', id: 'run-1'}], nextAction: 'Review failed verification', sourceUrl: 'https://github.com/VF78/fai-control-plane/issues/1', evidence: 'run: run-1', action: {label: 'Open source', href: 'https://github.com/VF78/fai-control-plane/issues/1'}, disposition: {kind: 'acknowledged', reason: 'investigating', expiresAt: new Date('2026-08-01T12:00:00.000Z'), reentryCondition: 'risk_unresolved_at_expiry', version: 1}, dispositionVersion: 1}, {id: 'job:1', riskSignalId: null, projectId: 'msa', workItemId: null, severity: 'red', project: 'MSA', object: 'Recovery scan', reason: 'Scheduled job is unhealthy', stage: null, signalClass: null, impact: null, freshness: new Date('2026-07-30T09:00:00.000Z'), owner: null, evidenceReferences: [], nextAction: null, sourceUrl: null, evidence: 'Scheduled job status', action: {label: 'No external record', href: null}, disposition: null, dispositionVersion: 0}]}}
  } as unknown as WorkspaceData;
  const markup = renderToStaticMarkup(createElement(WorkspaceShell, {route: {screen: 'dashboard', project: null, taskId: null, runId: null, agentId: null, scope: {environment: null, from: null, to: null}}, data}));

  expect(markup).toContain('href="/projects/msa/tasks/task-1"');
  expect(markup).toContain('Open task: Deployment task');
  expect(markup).toContain('Delivery stage</dt><dd>qa');
  expect(markup).toContain('Class</dt><dd>Fact');
  expect(markup).toContain('Release is blocked');
  expect(markup).toContain('run: run-1');
  expect(markup).toContain('Open provider source');
  expect(markup).toContain('Acknowledged until');
  expect(markup).toContain('Investigating');
  expect(markup).toContain('Returns to active attention if unresolved at expiry');
  expect(markup).toContain('Unknown</dd>');
  expect(markup).toContain('Unavailable');
});

it('keeps the web-first workspace IA and honest unavailable state', () => {
  const markup = renderToStaticMarkup(createElement(WorkspaceShell, {
    route: {screen: 'dashboard', project: null, taskId: null, runId: null, agentId: null, scope: {environment: null, from: null, to: null}},
    data: {portfolio: {state: 'unconfigured'}, access: {state: 'unconfigured'}, project: null, runs: null, health: null, projectIndex: []}
  }));

  expect(markup).toContain('href="/dashboard"');
  expect(markup).toContain('aria-label="Dashboard"');
  expect(markup).toContain('aria-label="Projects"');
  expect(markup).toContain('aria-label="Tasks"');
  expect(markup).toContain('aria-label="Chats"');
  expect(markup).toContain('aria-label="Agents"');
  expect(markup).toContain('Control plane data is unavailable');
  expect(markup).not.toContain('Provider ID');
});

it('renders persisted agent registrations and systems facts without inferring runtime liveness', () => {
  const data = {
    portfolio: {state: 'unconfigured'}, project: null, runs: null, projectIndex: [], csrfToken: 'csrf',
    health: {state: 'ready', data: {jobs: [{id: 'job-1', project: 'MSA', projectSlug: 'msa', name: 'recovery', status: 'unhealthy', heartbeatAt: null, lastSuccessAt: null, nextRunAt: null}], integrations: [], risks: [], audit: [], costLedger: []}},
    access: {state: 'ready', data: {actors: [{id: 'agent-1', displayName: 'Hermes', type: 'agent', role: 'contributor', disabledAt: null, capabilities: {}}], agentSystems: [{actorId: 'agent-1', profiles: [{id: 'profile-1', runtimeId: 'hermes', runtimeProfile: 'read_safe', enabled: true, configHash: 'a'.repeat(64), registrations: [{project: 'MSA', projectSlug: 'msa', provider: 'provider_neutral', runtimeKey: 'hermes', enabled: true}], instruction: {workspaceVersion: 3, profileVersion: 2, hash: 'b'.repeat(64), provenance: 'workspace v3 + profile v2'}, latestRun: null, fleet: {health: 'unknown', freshnessAt: null, currentWork: null, lastReceipt: null}}]}], requests: [], secretRefs: [], policy: [], hermes: {id: 'profile-1', actorId: 'agent-1', runtimeProfile: 'read_safe', allowedTools: [], forbiddenSurfaces: [], instructions: 'Observe only.', settings: {resultFormat: 'structured_v1', includeEvidence: true}, enabled: true, version: 1, configHash: 'a'.repeat(64)}, sharing: {enabled: false, projects: [], grants: []}}}
  } as unknown as WorkspaceData;
  const list = renderToStaticMarkup(createElement(WorkspaceShell, {route: {screen: 'agents', project: null, globalProject: 'all', taskId: null, runId: null, agentId: null, scope: {environment: null, from: null, to: null}}, data}));
  const detail = renderToStaticMarkup(createElement(WorkspaceShell, {route: {screen: 'agent', project: null, taskId: null, runId: null, agentId: 'agent-1', scope: {environment: null, from: null, to: null}}, data}));
  expect(list).toContain('Agents &amp; Systems');
  expect(list).toContain('heartbeat Not observed');
  expect(detail).toContain('provider_neutral/hermes');
  expect(detail).toContain('Fleet projection from persisted execution facts.');
  expect(list).toContain('Healthy requires an active observed lease');
  expect(list).toContain('No active work observed');
  expect(detail).toContain('effective hash');
  expect(detail).toContain('action="/api/agent-profiles/hermes"');
});

it('renders project membership and provider-confirmed grant facts in the access detail', () => {
  const data = {
    portfolio: {state: 'unconfigured'}, health: null, runs: null, projectIndex: [], csrfToken: 'csrf',
    project: {state: 'ready', data: {project: {id: 'project-1', workspaceId: 'workspace-1', name: 'MSA', slug: 'msa', description: null, defaultBranch: 'main', updatedAt: new Date()}, hermesAgentProfileId: null, snapshot: null, synchronizedAt: null, workItems: []}},
    access: {state: 'ready', data: {actors: [{id: 'actor-1', displayName: 'Vladimir', type: 'human', role: 'workspace_admin', disabledAt: null, capabilities: {}}], memberships: [{projectId: 'project-1', project: 'MSA', projectSlug: 'msa', actorId: 'actor-1', role: 'project_owner', active: true, version: 2}], externalIdentities: [{actorId: 'actor-1', provider: 'github', active: true}], resourceGrants: [{id: 'grant-1', projectId: 'project-1', project: 'MSA', projectSlug: 'msa', actorId: 'actor-1', resourceType: 'repository', desiredLevel: 'admin', observedProvider: 'github', observedLevel: 'admin', observedAt: new Date('2026-07-30T12:00:00.000Z'), version: 3}], agentSystems: [], requests: [{id: 'request-1', requester: 'Vladimir', targetSurface: 'repository', requestedScope: ['msa'], status: 'pending', expiresAt: null, decidedAt: null}], secretRefs: [], policy: [], hermes: null, sharing: {enabled: true, projects: [{name: 'MSA', slug: 'msa', workItems: []}], grants: []}}}
  } as unknown as WorkspaceData;
  const markup = renderToStaticMarkup(createElement(WorkspaceShell, {route: {screen: 'access', project: 'msa', taskId: null, runId: null, agentId: null, accessActorId: 'actor-1', scope: {environment: null, from: null, to: null}}, data}));

  expect(markup).toContain('People &amp; agents');
  expect(markup).toContain('project owner');
  expect(markup).toContain('Desired vs provider-confirmed access');
  expect(markup).toContain('github');
  expect(markup).toContain('href="/projects/msa/access/actor-1"');
  expect(markup).toContain('Client sharing');
  expect(markup).toContain('Sharing applies only to MSA');
  expect(markup).toContain('Access requests');
  expect(markup).toContain('Workspace records; project binding is not recorded');
  expect(markup).not.toContain('Secret refs');
});

it('preserves scope and keeps the run handoff separate from an absent approval', () => {
  const data = {
    portfolio: {state: 'unconfigured'}, access: {state: 'unconfigured'}, health: null,
    project: {state: 'ready', data: {project: {id: 'project-1', workspaceId: 'workspace-1', name: 'ASCON', slug: 'ascon', description: null, defaultBranch: 'main', updatedAt: new Date()}, hermesAgentProfileId: null, snapshot: null, synchronizedAt: null, workItems: [{id: 'task-1', title: 'Bounded task', summary: null, status: 'in_dev', blocked: false, owner: null, updatedAt: new Date(), externalUrl: null, canBuildPacket: false, handoff: {label: 'Run completed', state: 'done', kind: 'run', targetId: 'run-1', href: '/runs?project=ascon#run-run-1'}}]}},
    runs: {state: 'ready', data: {runs: [{id: 'run-1', workItem: 'Bounded task', agent: 'Observed runner', status: 'done', runtimeProfile: 'read_safe', startedAt: null, completedAt: null, receipt: null, artifacts: [], canAcceptReceipt: false}], approvals: [], packets: []}}
  } as unknown as WorkspaceData;
  const markup = renderToStaticMarkup(createElement(WorkspaceShell, {route: {screen: 'task', project: 'ascon', taskId: 'task-1', runId: null, agentId: null, scope: {environment: 'staging', from: '2026-07-01', to: '2026-07-31'}}, data}));

  expect(markup).toContain('Responsible human</dt><dd>Unknown');
  expect(markup).toContain('Responsible agent</dt><dd>Unknown');
  expect(markup).toContain('Run or packet handoff');
  expect(markup).toContain('Approval</dt><dd>Not observed');
  expect(markup).toContain('href="/projects/ascon/runs/run-1?environment=staging&amp;from=2026-07-01&amp;to=2026-07-31"');
  expect(markup).toContain('href="/projects/ascon/overview?environment=staging&amp;from=2026-07-01&amp;to=2026-07-31"');
});

it('renders the task lifecycle rail from recorded packet, approval, run, receipt, evidence, and write-back facts', () => {
  const observedAt = new Date('2026-07-30T12:00:00.000Z');
  const data = {
    portfolio: {state: 'unconfigured'}, access: {state: 'unconfigured'}, health: null, projectIndex: [],
    project: {state: 'ready', data: {project: {id: 'project-1', workspaceId: 'workspace-1', name: 'MSA', slug: 'msa', description: null, defaultBranch: 'main', updatedAt: observedAt}, hermesAgentProfileId: null, snapshot: null, synchronizedAt: null, workItems: [{id: 'task-1', title: 'Lifecycle task', summary: null, status: 'in_dev', blocked: false, owner: null, updatedAt: observedAt, externalUrl: null, canBuildPacket: false, handoff: {label: 'Run completed', state: 'done', kind: 'run', targetId: 'run-1', href: '/runs?project=msa#run-run-1'}}]}},
    runs: {state: 'ready', data: {runs: [], approvals: [], packets: []}},
    lifecycle: {state: 'ready', data: {packet: {id: 'packet-1', contentHash: 'a'.repeat(64), createdAt: observedAt}, approval: {status: 'approved', policyVersion: 3, environment: 'staging', decidedAt: observedAt, createdAt: observedAt}, run: {id: 'run-1', status: 'done', createdAt: observedAt, startedAt: observedAt, completedAt: observedAt}, receipt: {terminal: 'done', completedAt: observedAt}, artifactCount: 2, journeyEvidenceCount: 1, writeBack: {destination: 'github', eventType: 'github.project_status.write.v1', status: 'published', updatedAt: observedAt, failureCode: null}, audit: {action: 'work_item.transition', outcome: 'succeeded', occurredAt: observedAt}}}
  } as unknown as WorkspaceData;
  const markup = renderToStaticMarkup(createElement(WorkspaceShell, {route: {screen: 'task', project: 'msa', taskId: 'task-1', runId: null, agentId: null, scope: {environment: null, from: null, to: null}}, data}));

  expect(markup).toContain('aria-label="Delivery lifecycle"');
  expect(markup).toContain('Event / task');
  expect(markup).toContain('Immutable packet');
  expect(markup).toContain('Policy / approval');
  expect(markup).toContain('Execution / run');
  expect(markup).toContain('Receipt / evidence');
  expect(markup).toContain('Write-back / next');
  expect(markup).toContain('Hash aaaaaaaaaaaa');
  expect(markup).toContain('Policy v3 · staging');
  expect(markup).toContain('2 artifacts · 1 evidence');
  expect(markup).toContain('github · published');

  const unavailable = renderToStaticMarkup(createElement(WorkspaceShell, {
    route: {screen: 'task', project: 'msa', taskId: 'task-1', runId: null, agentId: null, scope: {environment: null, from: null, to: null}},
    data: {...data, lifecycle: {state: 'unavailable'}}
  }));
  expect(unavailable).toContain('Unavailable');
  expect(unavailable).toContain('PostgreSQL read unavailable');
});

it('renders immutable protocol stages and persisted journey responsibility/evidence as facts', () => {
  const data = {
    portfolio: {state: 'unconfigured'}, access: {state: 'unconfigured'}, health: null, runs: null, projectIndex: [], csrfToken: 'csrf',
    project: {state: 'ready', data: {project: {id: '11111111-1111-4111-8111-111111111111', workspaceId: 'workspace-1', name: 'MSA', slug: 'msa', description: null, defaultBranch: 'main', updatedAt: new Date()}, hermesAgentProfileId: null, snapshot: null, synchronizedAt: null, protocol: {id: '22222222-2222-4222-8222-222222222222', projectId: '11111111-1111-4111-8111-111111111111', name: 'Delivery', version: 2, revision: 3, state: 'published', active: true, contentHash: 'a'.repeat(64), definition: {schemaVersion: 1, stages: [{key: 'development', name: 'Development', enabled: true, taskStatus: 'in_dev', responsibility: {kind: 'project_role', role: 'contributor'}, executionMode: 'manual', entryCriteria: ['Ready'], requiredEvidence: ['Implementation change'], allowedNextStageKey: null}]}}, workItems: [{id: 'task-1', title: 'Bounded task', summary: null, status: 'in_dev', blocked: false, owner: null, updatedAt: new Date(), externalUrl: null, version: 1, journey: {protocolId: '22222222-2222-4222-8222-222222222222', protocolVersion: 2, stageKey: 'development', version: 1, deadlineAt: null, stage: {name: 'Development', taskStatus: 'in_dev', executionMode: 'manual', responsibility: 'contributor', nextStage: null, actor: {displayName: 'Canonical contributor', type: 'human'}}, evidence: [{stageKey: 'development', requirement: 'Implementation change', reference: 'commit:abc123'}], requiredEvidence: ['Implementation change', 'Relevant checks']}, canBuildPacket: false, handoff: null}]}},
  } as unknown as WorkspaceData;
  const protocol = renderToStaticMarkup(createElement(WorkspaceShell, {route: {screen: 'protocol', project: 'msa', taskId: null, runId: null, agentId: null, scope: {environment: null, from: null, to: null}}, data}));
  const task = renderToStaticMarkup(createElement(WorkspaceShell, {route: {screen: 'task', project: 'msa', taskId: 'task-1', runId: null, agentId: null, scope: {environment: null, from: null, to: null}}, data}));
  expect(protocol).toContain('Published versions are immutable');
  expect(protocol).toContain('Development');
  expect(protocol).not.toContain('disabled=""');
  expect(task).toContain('Canonical contributor');
  expect(task).toContain('commit:abc123');
  expect(task).toContain('Relevant checks');
});
