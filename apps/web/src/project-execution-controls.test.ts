import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect, it} from 'vitest';
import {ProjectExecutionControls} from './project-execution-controls';

const base = {projectId: 'project-1', version: 2, startedAt: '2026-08-09T10:00:00.000Z',
  pausedAt: null, completedAt: null, updatedAt: '2026-08-09T10:00:00.000Z'} as const;

it('renders one real manager command and a truthful mobile-safe decision queue', () => {
  const markup = renderToStaticMarkup(createElement(ProjectExecutionControls, {
    projectId: 'project-1', csrfToken: 'csrf', canManage: true,
    hasWriteCapability: true, runnerQueueAvailable: true, execution: {
      ...base, status: 'blocked', blockReason: 'human_confirmation_required',
      dispatch: null,
      selection: {planVersionId: 'plan-1', workItemId: 'work-1', title: 'Проверить результат', workItemVersion: 1,
        protocolId: 'protocol-1', protocolVersion: 3, journeyVersion: 1,
        stageKey: 'acceptance', stageName: 'Приёмка', executionMode: 'human_approval', responsibilityHash: 'a'.repeat(64),
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

it('renders immutable packet, claim, and concrete next-action facts without a success control', () => {
  const markup = renderToStaticMarkup(createElement(ProjectExecutionControls, {
    projectId: 'project-1', csrfToken: 'csrf', canManage: false,
    hasWriteCapability: true, runnerQueueAvailable: true, execution: {
      ...base, status: 'running', blockReason: null, decisions: [], selection: null,
      dispatch: {selectionHash: 'a'.repeat(64), taskPacketId: 'packet-1', taskPacketHash: 'b'.repeat(64),
        agentRunId: 'run-1', agentRunStatus: 'running', attempt: 1, failureCode: null,
        queuedAt: base.startedAt, claimedAt: base.startedAt, completedAt: null,
        nextAction: 'Monitor the runner heartbeat and wait for its immutable receipt.'}
    }
  }));
  expect(markup).toContain('packet-1');
  expect(markup).toContain('run-1 · попытка 1');
  expect(markup).toContain('Принят runner');
  expect(markup).toContain('Claim / результат');
  expect(markup).toContain('Monitor the runner heartbeat');
  expect(markup).not.toContain('success');
});

it('shows the preparation command only for the current running autonomous-ready factual selection', () => {
  const eligible = renderToStaticMarkup(createElement(ProjectExecutionControls, {
    projectId: 'project-1', csrfToken: 'csrf', canManage: true,
    hasWriteCapability: true, runnerQueueAvailable: true, execution: {
      ...base, status: 'running', blockReason: null, dispatch: null, decisions: [],
      selection: {planVersionId: 'plan-1', workItemId: 'work-1', title: 'Подготовить результат', workItemVersion: 1,
        protocolId: 'protocol-1', protocolVersion: 3, journeyVersion: 1, stageKey: 'execute', stageName: 'Исполнение',
        executionMode: 'autonomous', responsibilityHash: 'a'.repeat(64), responsibleActor: {id: 'agent-1', displayName: 'Codex', type: 'agent', agentProfileId: 'profile-1'},
        boundary: 'autonomous_ready'}
    }
  }));
  expect(eligible).toContain('Подготовить запуск агента');
  const alreadyQueued = renderToStaticMarkup(createElement(ProjectExecutionControls, {
    projectId: 'project-1', csrfToken: 'csrf', canManage: true,
    hasWriteCapability: true, runnerQueueAvailable: true, execution: {
      ...base, status: 'running', blockReason: null, decisions: [],
      selection: {planVersionId: 'plan-1', workItemId: 'work-1', title: 'Подготовить результат', workItemVersion: 1,
        protocolId: 'protocol-1', protocolVersion: 3, journeyVersion: 1, stageKey: 'execute', stageName: 'Исполнение',
        executionMode: 'autonomous', responsibilityHash: 'a'.repeat(64), responsibleActor: {id: 'agent-1', displayName: 'Codex', type: 'agent', agentProfileId: 'profile-1'},
        boundary: 'autonomous_ready'},
      dispatch: {selectionHash: 'a'.repeat(64), taskPacketId: 'packet-1', taskPacketHash: 'b'.repeat(64),
        agentRunId: 'run-1', agentRunStatus: 'queued', attempt: 0, failureCode: null,
        queuedAt: base.startedAt, claimedAt: null, completedAt: null, nextAction: 'Wait for claim.'}
    }
  }));
  expect(alreadyQueued).not.toContain('Подготовить запуск агента');
  const blocked = renderToStaticMarkup(createElement(ProjectExecutionControls, {
    projectId: 'project-1', csrfToken: 'csrf', canManage: true,
    hasWriteCapability: true, runnerQueueAvailable: true, execution: {
      ...base, status: 'blocked', blockReason: 'dispatch_policy_denied', dispatch: null, decisions: [], selection: null
    }
  }));
  expect(blocked).not.toContain('Подготовить запуск агента');
});

it('hides activation and explains missing write capability or runner transport', () => {
  const execution = {
    ...base, status: 'running' as const, blockReason: null, dispatch: null, decisions: [],
    selection: {planVersionId: 'plan-1', workItemId: 'work-1', title: 'Подготовить результат', workItemVersion: 1,
      protocolId: 'protocol-1', protocolVersion: 3, journeyVersion: 1, stageKey: 'execute', stageName: 'Исполнение',
      executionMode: 'autonomous' as const, responsibilityHash: 'a'.repeat(64), responsibleActor: {id: 'agent-1', displayName: 'Codex', type: 'agent' as const, agentProfileId: 'profile-1'},
      boundary: 'autonomous_ready' as const}
  };
  const noCapability = renderToStaticMarkup(createElement(ProjectExecutionControls, {
    projectId: 'project-1', csrfToken: 'csrf', canManage: true,
    hasWriteCapability: false, runnerQueueAvailable: true, execution
  }));
  expect(noCapability).not.toContain('Подготовить запуск агента');
  expect(noCapability).toContain('Нужна capability write:control_plane:development');
  const noTransport = renderToStaticMarkup(createElement(ProjectExecutionControls, {
    projectId: 'project-1', csrfToken: 'csrf', canManage: true,
    hasWriteCapability: true, runnerQueueAvailable: false, execution
  }));
  expect(noTransport).not.toContain('Подготовить запуск агента');
  expect(noTransport).toContain('очередь runner или локальный transport не включены');
});

it('offers one bounded retry only for the current failed autonomous dispatch', () => {
  const markup = renderToStaticMarkup(createElement(ProjectExecutionControls, {
    projectId: 'project-1', csrfToken: 'csrf', canManage: true,
    hasWriteCapability: true, runnerQueueAvailable: true, execution: {
      ...base, status: 'running', blockReason: null, decisions: [],
      selection: {planVersionId: 'plan-1', workItemId: 'work-1', title: 'Исправить результат', workItemVersion: 1,
        protocolId: 'protocol-1', protocolVersion: 3, journeyVersion: 1,
        stageKey: 'development', stageName: 'Разработка', executionMode: 'autonomous', responsibilityHash: 'a'.repeat(64),
        responsibleActor: {id: 'agent-1', displayName: 'Codex', type: 'agent', agentProfileId: 'profile-1'},
        boundary: 'autonomous_ready'},
      dispatch: {selectionHash: 'a'.repeat(64), taskPacketId: 'packet-1', taskPacketHash: 'b'.repeat(64),
        agentRunId: 'run-1', agentRunStatus: 'failed', attempt: 1, failureCode: 'process_failed',
        queuedAt: base.startedAt, claimedAt: base.startedAt, completedAt: base.startedAt,
        nextAction: 'Inspect the receipt.'}
    }
  }));
  expect(markup).toContain('Повторить в пределах политики');
  expect(markup).toContain('Правило допуска повтора');
  expect(markup).toContain('пороги допуска, а не бюджет следующего запуска');
  expect(markup).toContain('timebox остаётся в Task Packet');
  expect(markup).toContain('production или release запрещён');
});
