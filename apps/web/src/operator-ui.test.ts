import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect, it} from 'vitest';
import {HealthView, OperatorShell} from './operator-ui';

it('renders actual operator deep links while preserving selected project scope', () => {
  const markup = renderToStaticMarkup(createElement(
    OperatorShell,
    {active: 'runs', scope: 'ascon', session: null},
    createElement('h1', undefined, 'Runs')
  ));

  expect(markup).toContain('href="/projects/ascon"');
  expect(markup).toContain('href="/runs?project=ascon"');
  expect(markup).toContain('href="/health?project=ascon"');
  expect(markup).toContain('aria-current="page"');
});

it('renders persisted audit actor, target and policy facts', () => {
  const occurredAt = new Date('2026-07-26T12:00:00.000Z');
  const markup = renderToStaticMarkup(createElement(HealthView, {data: {
    jobs: [],
    integrations: [],
    risks: [],
    audit: [{
      id: 'audit-1',
      project: 'ASCON',
      projectSlug: 'ascon',
      actor: 'Vladimir',
      action: 'task_packet.confirm',
      targetType: 'task_packet',
      targetId: 'packet-1',
      policyDecision: 'ask',
      outcome: 'success',
      reasonCode: 'human_confirmation',
      occurredAt
    }]
  }}));

  expect(markup).toContain('ASCON · Vladimir');
  expect(markup).toContain('task_packet · packet-1');
  expect(markup).toContain('ask · success');
  expect(markup).toContain('human_confirmation');
});
