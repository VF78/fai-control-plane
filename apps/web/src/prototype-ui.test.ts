import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect, it} from 'vitest';
import {PrototypeShell, type PrototypeData} from './prototype-ui';

it('keeps the five workspace areas deep-linkable and does not invent unavailable portfolio facts', () => {
  const markup = renderToStaticMarkup(createElement(PrototypeShell, {
    route: {area: 'portfolio', tab: 'overview', selected: null, scope: {project: null, environment: null, from: null, to: null}},
    data: {
      portfolio: {state: 'unconfigured'},
      access: {state: 'unconfigured'},
      project: null,
      runs: null,
      health: null
    }
  }));

  expect(markup).toContain('href="/prototype/portfolio"');
  expect(markup).toContain('href="/prototype/delivery/overview"');
  expect(markup).toContain('href="/prototype/conversations"');
  expect(markup).toContain('href="/prototype/people-access"');
  expect(markup).toContain('href="/prototype/agents-systems"');
  expect(markup).toContain('Project and signal records are unavailable');
  expect(markup).toContain('Environment</b>Not configured');
});

it('shows a linked run agent as an execution observation, not task responsibility', () => {
  const data = {
    portfolio: {state: 'unconfigured'}, access: {state: 'unconfigured'}, health: null,
    project: {state: 'ready', data: {project: {id: 'project-1', workspaceId: 'workspace-1', name: 'ASCON', slug: 'ascon', description: null, defaultBranch: 'main', updatedAt: new Date()}, hermesAgentProfileId: null, snapshot: null, synchronizedAt: null, workItems: [{id: 'task-1', title: 'Bounded task', summary: null, status: 'in_dev', blocked: false, owner: null, updatedAt: new Date(), externalUrl: null, canBuildPacket: false, handoff: {label: 'Run completed', state: 'done', kind: 'run', targetId: 'run-1', href: '/runs?project=ascon#run-run-1'}}]}},
    runs: {state: 'ready', data: {runs: [{id: 'run-1', agent: 'Observed runner'}], approvals: [], packets: []}}
  } as unknown as PrototypeData;
  const markup = renderToStaticMarkup(createElement(PrototypeShell, {route: {area: 'delivery', tab: 'tasks', selected: 'task-1', scope: {project: 'ascon', environment: null, from: null, to: null}}, data}));

  expect(markup).toContain('Responsible agent</dt><dd>Unknown');
  expect(markup).toContain('Observed execution agent</dt><dd>Observed runner');
  expect(markup).toContain('href="/prototype/delivery/runs/run-1?project=ascon"');
});
