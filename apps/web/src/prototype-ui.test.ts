import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect, it} from 'vitest';
import {derivePortfolioProjectMetrics} from './operator-data';
import {PrototypeShell, type PrototypeData} from './prototype-ui';

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

it('renders compact per-project portfolio metrics and explicit history limits', () => {
  const data = {
    access: {state: 'unconfigured'}, health: null, project: null, runs: null, projectIndex: [],
    portfolio: {state: 'ready', data: {attention: [], projects: [{id: 'msa', name: 'MSA', slug: 'msa', health: 'yellow', snapshotAt: null, synchronizedAt: new Date('2026-07-30T11:45:00.000Z'), unresolvedRiskCount: 0, metrics: {stages: {backlog: 1, ready: 1, in_dev: 2, qa: 1, acceptance: 0, done: 3}, activeWip: 3, blockedWork: 1, staleActiveWork: 1, pendingApprovals: {count: 2, oldestAt: new Date('2026-07-29T11:45:00.000Z')}, integrationFreshness: new Date('2026-07-30T11:45:00.000Z'), milestoneOutlook: {state: 'unknown', due: 0, overdue: 0}, throughputTrend: {state: 'not_enough_history', recent: 1, previous: 0}, cycleTime: {state: 'not_enough_history', averageHours: null, samples: 1}}}]}}
  } as unknown as PrototypeData;
  const markup = renderToStaticMarkup(createElement(PrototypeShell, {route: {screen: 'dashboard', project: null, taskId: null, runId: null, agentId: null, scope: {environment: null, from: null, to: null}}, data}));

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
  } as unknown as PrototypeData;
  const markup = renderToStaticMarkup(createElement(PrototypeShell, {route: {screen: 'dashboard', project: null, taskId: null, runId: null, agentId: null, scope: {environment: null, from: null, to: null}}, data}));

  expect(markup).toContain('href="/prototype/projects/msa/tasks/task-1"');
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
  const markup = renderToStaticMarkup(createElement(PrototypeShell, {
    route: {screen: 'dashboard', project: null, taskId: null, runId: null, agentId: null, scope: {environment: null, from: null, to: null}},
    data: {portfolio: {state: 'unconfigured'}, access: {state: 'unconfigured'}, project: null, runs: null, health: null, projectIndex: []}
  }));

  expect(markup).toContain('href="/prototype/dashboard"');
  expect(markup).toContain('aria-label="Dashboard"');
  expect(markup).toContain('aria-label="Projects"');
  expect(markup).toContain('aria-label="Tasks"');
  expect(markup).toContain('aria-label="Chats"');
  expect(markup).toContain('aria-label="Agents"');
  expect(markup).toContain('Control plane data is unavailable');
  expect(markup).not.toContain('Provider ID');
});

it('preserves scope and keeps the run handoff separate from an absent approval', () => {
  const data = {
    portfolio: {state: 'unconfigured'}, access: {state: 'unconfigured'}, health: null,
    project: {state: 'ready', data: {project: {id: 'project-1', workspaceId: 'workspace-1', name: 'ASCON', slug: 'ascon', description: null, defaultBranch: 'main', updatedAt: new Date()}, hermesAgentProfileId: null, snapshot: null, synchronizedAt: null, workItems: [{id: 'task-1', title: 'Bounded task', summary: null, status: 'in_dev', blocked: false, owner: null, updatedAt: new Date(), externalUrl: null, canBuildPacket: false, handoff: {label: 'Run completed', state: 'done', kind: 'run', targetId: 'run-1', href: '/runs?project=ascon#run-run-1'}}]}},
    runs: {state: 'ready', data: {runs: [{id: 'run-1', workItem: 'Bounded task', agent: 'Observed runner', status: 'done', runtimeProfile: 'read_safe', startedAt: null, completedAt: null, receipt: null, artifacts: [], canAcceptReceipt: false}], approvals: [], packets: []}}
  } as unknown as PrototypeData;
  const markup = renderToStaticMarkup(createElement(PrototypeShell, {route: {screen: 'task', project: 'ascon', taskId: 'task-1', runId: null, agentId: null, scope: {environment: 'staging', from: '2026-07-01', to: '2026-07-31'}}, data}));

  expect(markup).toContain('Responsible human</dt><dd>Unknown');
  expect(markup).toContain('Responsible agent</dt><dd>Unknown');
  expect(markup).toContain('Run or packet handoff');
  expect(markup).toContain('Approval</dt><dd>Not observed');
  expect(markup).toContain('href="/prototype/projects/ascon/runs/run-1?environment=staging&amp;from=2026-07-01&amp;to=2026-07-31"');
  expect(markup).toContain('href="/prototype/projects/ascon/overview?environment=staging&amp;from=2026-07-01&amp;to=2026-07-31"');
});

it('renders immutable protocol stages and persisted journey responsibility/evidence as facts', () => {
  const data = {
    portfolio: {state: 'unconfigured'}, access: {state: 'unconfigured'}, health: null, runs: null, projectIndex: [], csrfToken: 'csrf',
    project: {state: 'ready', data: {project: {id: '11111111-1111-4111-8111-111111111111', workspaceId: 'workspace-1', name: 'MSA', slug: 'msa', description: null, defaultBranch: 'main', updatedAt: new Date()}, hermesAgentProfileId: null, snapshot: null, synchronizedAt: null, protocol: {id: '22222222-2222-4222-8222-222222222222', projectId: '11111111-1111-4111-8111-111111111111', name: 'Delivery', version: 2, revision: 3, state: 'published', active: true, contentHash: 'a'.repeat(64), definition: {schemaVersion: 1, stages: [{key: 'development', name: 'Development', enabled: true, taskStatus: 'in_dev', responsibility: {kind: 'project_role', role: 'contributor'}, executionMode: 'manual', entryCriteria: ['Ready'], requiredEvidence: ['Implementation change'], allowedNextStageKey: null}]}}, workItems: [{id: 'task-1', title: 'Bounded task', summary: null, status: 'in_dev', blocked: false, owner: null, updatedAt: new Date(), externalUrl: null, version: 1, journey: {protocolId: '22222222-2222-4222-8222-222222222222', protocolVersion: 2, stageKey: 'development', version: 1, deadlineAt: null, stage: {name: 'Development', taskStatus: 'in_dev', executionMode: 'manual', responsibility: 'contributor', nextStage: null, actor: {displayName: 'Canonical contributor', type: 'human'}}, evidence: [{stageKey: 'development', requirement: 'Implementation change', reference: 'commit:abc123'}], requiredEvidence: ['Implementation change', 'Relevant checks']}, canBuildPacket: false, handoff: null}]}},
  } as unknown as PrototypeData;
  const protocol = renderToStaticMarkup(createElement(PrototypeShell, {route: {screen: 'protocol', project: 'msa', taskId: null, runId: null, agentId: null, scope: {environment: null, from: null, to: null}}, data}));
  const task = renderToStaticMarkup(createElement(PrototypeShell, {route: {screen: 'task', project: 'msa', taskId: 'task-1', runId: null, agentId: null, scope: {environment: null, from: null, to: null}}, data}));
  expect(protocol).toContain('Published versions are immutable');
  expect(protocol).toContain('Development');
  expect(protocol).not.toContain('disabled=""');
  expect(task).toContain('Canonical contributor');
  expect(task).toContain('commit:abc123');
  expect(task).toContain('Relevant checks');
});
