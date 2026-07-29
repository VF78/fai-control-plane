import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect, it} from 'vitest';
import {PrototypeShell, type PrototypeData} from './prototype-ui';

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
