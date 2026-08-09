'use client';

import {useState} from 'react';
import {CirclePause, CirclePlay, RotateCcw} from 'lucide-react';
import type {ProjectExecutionProjection} from '@fai-control-plane/domain';

const statusLabel: Record<ProjectExecutionProjection['status'], string> = {
  stopped: 'Не запущено', running: 'Оркестратор включён', paused: 'На паузе',
  blocked: 'Нужно решение', completed: 'Завершено'
};
const kindLabel = {approval: 'Подтверждение', failure: 'Ошибка', provider_handoff: 'Передача'} as const;

export function ProjectExecutionControls({projectId, execution, csrfToken, canManage}: Readonly<{
  projectId: string;
  execution: ProjectExecutionProjection;
  csrfToken: string | null;
  canManage: boolean;
}>) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const run = async (action: 'start' | 'pause' | 'resume') => {
    setBusy(true); setNotice(null);
    try {
      const response = await fetch('/api/project-execution', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({
        _csrf: csrfToken, action, projectId, expectedVersion: execution.version, idempotencyKey: crypto.randomUUID()
      })});
      const result = await response.json().catch(() => ({})) as {status?: string; message?: string};
      if (!response.ok) throw new Error(result.message ?? result.status ?? 'Команда не принята.');
      setNotice('Команда выполнена. Audit и receipt сохранены; обновляем факты…');
      window.setTimeout(() => window.location.reload(), 350);
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Команда недоступна.'); }
    finally { setBusy(false); }
  };
  const actionable = canManage && csrfToken !== null;
  return <section className="fcp-section fcp-orchestrator" aria-label="Управление исполнением проекта">
    <div className="fcp-section-head"><div><h2>Исполнение проекта</h2><span>Канонический выбор следующей работы · без автоматического запуска runner</span></div><strong className={`fcp-orchestrator-status ${execution.status}`}>{statusLabel[execution.status]}</strong></div>
    <div className="fcp-orchestrator-summary">
      <div><span>Следующая работа</span><strong>{execution.selection?.title ?? 'Не выбрана'}</strong><small>{execution.selection === null ? (execution.blockReason ?? 'Запустите после материализации плана.') : `${execution.selection.stageName} · ${execution.selection.responsibleActor.displayName}`}</small></div>
      <div><span>Граница автономности</span><strong>{execution.selection?.boundary === 'autonomous_ready' ? 'Готово к Task Packet' : execution.selection?.boundary === 'autonomous_agent_required' ? 'Нужен активный ИИ-агент' : execution.selection?.executionMode === 'human_approval' ? 'Требуется подтверждение' : execution.selection?.executionMode === 'manual' ? 'Ручная передача' : 'Не определена'}</strong><small>Работа и AgentRun не считаются начатыми этой командой.</small></div>
      <div className="fcp-orchestrator-actions">
        {execution.status === 'stopped' ? <button className="fcp-primary-button" disabled={!actionable || busy} onClick={() => void run('start')}><CirclePlay aria-hidden="true" size={16}/>Запустить</button> : null}
        {execution.status === 'running' || execution.status === 'blocked' ? <button className="fcp-secondary" disabled={!actionable || busy} onClick={() => void run('pause')}><CirclePause aria-hidden="true" size={16}/>Пауза</button> : null}
        {execution.status === 'paused' ? <button className="fcp-primary-button" disabled={!actionable || busy} onClick={() => void run('resume')}><RotateCcw aria-hidden="true" size={16}/>Продолжить</button> : null}
        {!actionable ? <small>Управление доступно владельцу проекта или delivery-администратору в авторизованной сессии.</small> : null}
      </div>
    </div>
    <div className="fcp-decision-queue"><header><h3>Очередь решений</h3><span>{execution.decisions.length}</span></header>{execution.decisions.length === 0
      ? <p className="fcp-empty-line">Явных подтверждений, ошибок или внешних передач не зафиксировано.</p>
      : execution.decisions.map((decision) => <article key={decision.id}><span>{kindLabel[decision.kind]}</span><div><strong>{decision.summary}</strong><small>{decision.nextAction}</small></div></article>)}</div>
    <details><summary>Технические факты</summary><dl className="fcp-details"><div><dt>Версия</dt><dd>{execution.version}</dd></div><div><dt>WorkItem</dt><dd>{execution.selection?.workItemId ?? 'Не выбран'}</dd></div><div><dt>Protocol</dt><dd>{execution.selection === null ? 'Не выбран' : `${execution.selection.protocolId} · v${execution.selection.protocolVersion}`}</dd></div><div><dt>Journey</dt><dd>{execution.selection === null ? 'Не выбран' : `v${execution.selection.journeyVersion} · ${execution.selection.stageKey}`}</dd></div></dl></details>
    {notice === null ? null : <p className="fcp-command-notice">{notice}</p>}
  </section>;
}
