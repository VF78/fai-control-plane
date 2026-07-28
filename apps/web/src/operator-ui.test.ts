import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect, it} from 'vitest';
import {HealthView, OperatorShell, ProjectView, RunsView} from './operator-ui';

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
    costLedger: [],
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

it('links a WorkItem handoff state to the exact persisted approval', () => {
  const projectMarkup = renderToStaticMarkup(createElement(ProjectView, {
    csrfToken: null,
    data: {
      project: {
        id: 'project-1',
        workspaceId: 'workspace-1',
        name: 'ASCON',
        slug: 'ascon',
        description: null,
        defaultBranch: 'main',
        updatedAt: new Date('2026-07-28T10:00:00.000Z')
      },
      hermesAgentProfileId: null,
      snapshot: null,
      synchronizedAt: null,
      workItems: [{
        id: 'work-1',
        title: 'Review bounded handoff',
        summary: null,
        status: 'ready',
        blocked: false,
        owner: 'Vladimir',
        updatedAt: new Date('2026-07-28T10:00:00.000Z'),
        externalUrl: 'https://github.com/VF78/ascon/issues/1',
        canBuildPacket: false,
        handoff: {
          label: 'Approval pending',
          state: 'pending',
          href: '/runs?project=ascon#approval-approval-1'
        }
      }]
    }
  }));
  const runsMarkup = renderToStaticMarkup(createElement(RunsView, {
    csrfToken: null,
    operatorActorId: null,
    data: {
      packets: [],
      runs: [],
      approvals: [{
        id: 'approval-1',
        project: 'ASCON',
        projectSlug: 'ascon',
        actionCategory: 'deploy',
        surface: 'runner',
        environment: 'production',
        status: 'pending',
        policyVersion: 1,
        expiresAt: new Date('2026-07-29T10:00:00.000Z'),
        decidedAt: null
      }]
    }
  }));

  expect(projectMarkup).toContain('href="/runs?project=ascon#approval-approval-1"');
  expect(projectMarkup).toContain('Approval pending');
  expect(runsMarkup).toContain('id="approval-approval-1"');
});
