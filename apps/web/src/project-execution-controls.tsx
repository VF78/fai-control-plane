'use client';

import {useState} from 'react';
import {CirclePause, CirclePlay, PackageCheck, RefreshCcw, RotateCcw} from 'lucide-react';
import type {ProjectExecutionProjection} from '@fai-control-plane/domain';

const statusLabel: Record<ProjectExecutionProjection['status'], string> = {
  stopped: 'Не запущено', running: 'Оркестратор включён', paused: 'На паузе',
  blocked: 'Нужно решение', completed: 'Завершено'
};
const kindLabel = {approval: 'Подтверждение', failure: 'Ошибка', provider_handoff: 'Передача'} as const;
const runStatusLabel: Record<NonNullable<ProjectExecutionProjection['dispatch']>['agentRunStatus'], string> = {
  queued: 'В очереди', running: 'Принят runner', waiting_approval: 'Ждёт подтверждения',
  failed: 'Завершён с ошибкой', done: 'Результат получен'
};

export function ProjectExecutionControls({projectId, execution, csrfToken, canManage,
  hasWriteCapability, runnerQueueAvailable}: Readonly<{
  projectId: string;
  execution: ProjectExecutionProjection;
  csrfToken: string | null;
  canManage: boolean;
  hasWriteCapability: boolean;
  runnerQueueAvailable: boolean;
}>) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const run = async (action: 'start' | 'pause' | 'resume' | 'dispatch' | 'retry') => {
    setBusy(true); setNotice(null);
    try {
      const response = await fetch(action === 'dispatch' ? '/api/project-execution/dispatch'
        : action === 'retry' ? '/api/project-execution/retry' : '/api/project-execution', {
        method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(action === 'dispatch'
          ? {_csrf: csrfToken, projectId, executionVersion: execution.version}
          : action === 'retry'
            ? {_csrf: csrfToken, projectId, failedRunId: execution.dispatch!.agentRunId,
                retryRunId: crypto.randomUUID(), expectedExecutionVersion: execution.version}
          : {_csrf: csrfToken, action, projectId, expectedVersion: execution.version, idempotencyKey: crypto.randomUUID()})
      });
      const result = await response.json().catch(() => ({})) as {status?: string; message?: string};
      if (!response.ok) throw new Error(result.message ?? result.status ?? 'Команда не принята.');
      setNotice('Команда выполнена. Audit и receipt сохранены; обновляем факты…');
      window.setTimeout(() => window.location.reload(), 350);
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Команда недоступна.'); }
    finally { setBusy(false); }
  };
  const actionable = canManage && hasWriteCapability && csrfToken !== null;
  const dispatchFactual = execution.status === 'running' && execution.selection?.boundary === 'autonomous_ready' &&
    execution.dispatch === null;
  const dispatchEligible = dispatchFactual && hasWriteCapability && runnerQueueAvailable;
  const retryEligible = runnerQueueAvailable && execution.status === 'running' &&
    execution.selection?.boundary === 'autonomous_ready' && execution.dispatch?.agentRunStatus === 'failed';
  return <section className="fcp-section fcp-orchestrator" aria-label="Управление исполнением проекта">
    <div className="fcp-section-head"><div><h2>Исполнение проекта</h2><span>Канонический выбор следующей работы · без автоматического запуска runner</span></div><strong className={`fcp-orchestrator-status ${execution.status}`}>{statusLabel[execution.status]}</strong></div>
    <div className="fcp-orchestrator-summary">
      <div><span>Следующая работа</span><strong>{execution.selection?.title ?? 'Не выбрана'}</strong><small>{execution.selection === null ? (execution.blockReason ?? 'Запустите после материализации плана.') : `${execution.selection.stageName} · ${execution.selection.responsibleActor.displayName}`}</small></div>
      <div><span>Граница автономности</span><strong>{execution.selection?.boundary === 'autonomous_ready' ? 'Готово к Task Packet' : execution.selection?.boundary === 'autonomous_agent_required' ? 'Нужен активный ИИ-агент' : execution.selection?.executionMode === 'human_approval' ? 'Требуется подтверждение' : execution.selection?.executionMode === 'manual' ? 'Ручная передача' : 'Не определена'}</strong><small>Работа и AgentRun не считаются начатыми этой командой.</small></div>
      <div className="fcp-orchestrator-actions">
        {execution.status === 'stopped' ? <button className="fcp-primary-button" disabled={!actionable || busy} onClick={() => void run('start')}><CirclePlay aria-hidden="true" size={16}/>Запустить</button> : null}
        {execution.status === 'running' || execution.status === 'blocked' ? <button className="fcp-secondary" disabled={!actionable || busy} onClick={() => void run('pause')}><CirclePause aria-hidden="true" size={16}/>Пауза</button> : null}
        {execution.status === 'paused' ? <button className="fcp-primary-button" disabled={!actionable || busy} onClick={() => void run('resume')}><RotateCcw aria-hidden="true" size={16}/>Продолжить</button> : null}
        {dispatchEligible ? <button className="fcp-primary-button" disabled={!actionable || busy} onClick={() => void run('dispatch')}><PackageCheck aria-hidden="true" size={16}/>Подготовить запуск агента</button> : null}
        {retryEligible ? <button className="fcp-primary-button" disabled={!actionable || busy} onClick={() => void run('retry')}><RefreshCcw aria-hidden="true" size={16}/>Повторить в пределах политики</button> : null}
        {!canManage ? <small>Управление доступно владельцу проекта или delivery-администратору.</small>
          : !hasWriteCapability ? <small>Нужна capability write:control_plane:development; запросите её у администратора рабочей области.</small>
            : csrfToken === null ? <small>Нужна авторизованная operator-сессия.</small> : null}
        {dispatchFactual && hasWriteCapability && !runnerQueueAvailable
          ? <small>Подготовка запуска недоступна: очередь runner или локальный transport не включены.</small> : null}
        {retryEligible ? <small>Правило допуска повтора: не более 3 попыток; новая попытка не ставится в очередь после 120 минут с первой попытки, при 100 ₽ уже наблюдённой стоимости прошлых попыток или неизвестной стоимости. Это пороги допуска, а не бюджет следующего запуска; его отдельный неизменяемый timebox остаётся в Task Packet. Переход через подтверждение, production или release запрещён.</small> : null}
      </div>
    </div>
    {execution.dispatch === null
      ? <p className="fcp-empty-line">Task Packet и AgentRun для текущей версии выбора ещё не созданы.</p>
      : <div className="fcp-orchestrator-summary" aria-label="Факты передачи runner">
          <div><span>Task Packet</span><strong>{execution.dispatch.taskPacketId}</strong><small>hash {execution.dispatch.taskPacketHash.slice(0, 12)}… · selection {execution.dispatch.selectionHash.slice(0, 12)}…</small></div>
          <div><span>AgentRun</span><strong>{runStatusLabel[execution.dispatch.agentRunStatus]}</strong><small>{execution.dispatch.agentRunId} · попытка {execution.dispatch.attempt} · queued {execution.dispatch.queuedAt}</small></div>
          <div><span>Claim / результат</span><strong>{execution.dispatch.claimedAt === null ? 'Runner ещё не принял' : `Принят ${execution.dispatch.claimedAt}`}</strong><small>{execution.dispatch.completedAt === null ? execution.dispatch.nextAction : `Завершён ${execution.dispatch.completedAt}${execution.dispatch.failureCode === null ? '' : ` · ${execution.dispatch.failureCode}`}`}</small></div>
        </div>}
    <div className="fcp-decision-queue"><header><h3>Очередь решений</h3><span>{execution.decisions.length}</span></header>{execution.decisions.length === 0
      ? <p className="fcp-empty-line">Явных подтверждений, ошибок или внешних передач не зафиксировано.</p>
      : execution.decisions.map((decision) => <article key={decision.id}><span>{kindLabel[decision.kind]}</span><div><strong>{decision.summary}</strong><small>{decision.nextAction}</small></div></article>)}</div>
    <details><summary>Технические факты</summary><dl className="fcp-details"><div><dt>Версия</dt><dd>{execution.version}</dd></div><div><dt>WorkItem</dt><dd>{execution.selection?.workItemId ?? 'Не выбран'}</dd></div><div><dt>Protocol</dt><dd>{execution.selection === null ? 'Не выбран' : `${execution.selection.protocolId} · v${execution.selection.protocolVersion}`}</dd></div><div><dt>Journey</dt><dd>{execution.selection === null ? 'Не выбран' : `v${execution.selection.journeyVersion} · ${execution.selection.stageKey}`}</dd></div><div><dt>Dispatch</dt><dd>{execution.dispatch?.agentRunId ?? 'Не создан'}</dd></div></dl></details>
    {notice === null ? null : <p className="fcp-command-notice">{notice}</p>}
  </section>;
}
