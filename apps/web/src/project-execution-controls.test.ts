import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect, it} from 'vitest';
import {ProjectExecutionControls} from './project-execution-controls';

const base = {projectId: 'project-1', version: 2, startedAt: '2026-08-09T10:00:00.000Z',
  pausedAt: null, completedAt: null, updatedAt: '2026-08-09T10:00:00.000Z'} as const;

it('renders one real manager command and a truthful mobile-safe decision queue', () => {
  const markup = renderToStaticMarkup(createElement(ProjectExecutionControls, {
    projectId: 'project-1', csrfToken: 'csrf', canManage: true, execution: {
      ...base, status: 'blocked', blockReason: 'human_confirmation_required',
      selection: {planVersionId: 'plan-1', workItemId: 'work-1', title: 'Проверить результат', workItemVersion: 1,
        protocolId: 'protocol-1', protocolVersion: 3, journeyVersion: 1,
        stageKey: 'acceptance', stageName: 'Приёмка', executionMode: 'human_approval',
        responsibleActor: {id: 'owner-1', displayName: 'Владелец проекта', type: 'human', agentProfileId: null},
        boundary: 'human_confirmation_required'},
      decisions: [{id: 'decision-1', kind: 'approval', source: 'delivery_protocol',
        workItemId: 'work-1', targetId: 'work-1', summary: 'Нужно явное подтверждение.',
        nextAction: 'Подтвердить вручную.', createdAt: null}]
    }
  }));
  expect(markup).toContain('fcp-orchestrator-summary');
  expect(markup).toContain('Нужно явное подтверждение.');
  expect(markup.match(/<button/g)).toHaveLength(1);
  expect(markup).toContain('Пауза');
  expect(markup).not.toContain('Запустить агента');
});
