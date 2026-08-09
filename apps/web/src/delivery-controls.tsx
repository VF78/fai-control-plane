'use client';

import {useMemo, useState} from 'react';
import {ArrowRight, CheckCircle2, CircleDot, FileCheck2, Play, Save, Send, ShieldAlert, Sparkles, UserRound} from 'lucide-react';
import type {DeliveryProtocol, DeliveryProtocolDefinition} from '@fai-control-plane/domain';

type Notice = Readonly<{tone: 'success' | 'error' | 'neutral'; text: string}>;
type ProtocolResponse = Readonly<{receipt?: {commandId: string; commandType: string}; simulation?: {valid: boolean; simulationHash: string; violations: readonly string[]}}>;

const roleOptions = ['project_owner', 'contributor', 'reviewer', 'workspace_owner'] as const;
const taskStatuses = ['backlog', 'ready', 'in_dev', 'qa', 'acceptance', 'done'] as const;
const modes = ['manual', 'human_approval', 'autonomous'] as const;
const roleLabels: Record<string, string> = {
  project_owner: 'Владелец продукта', contributor: 'Исполнитель', reviewer: 'Ревьюер', workspace_owner: 'Владелец пространства', client_viewer: 'Представитель клиента'
};
const statusLabels: Record<(typeof taskStatuses)[number], string> = {
  backlog: 'Бэклог', ready: 'Готово к работе', in_dev: 'В разработке', qa: 'QA', acceptance: 'Приёмка', done: 'Завершено'
};
const modeLabels: Record<(typeof modes)[number], string> = {
  manual: 'Вручную', human_approval: 'С подтверждением', autonomous: 'Автономно'
};
const stageLabels: Record<string, string> = {
  intake: 'Постановка', development: 'Разработка', qa: 'QA', staging: 'Тестовый контур', acceptance: 'Приёмка'
};
const evidenceLabels: Record<string, string> = {
  'Accepted task brief': 'Принятая постановка задачи',
  'Implementation change': 'Изменения реализации',
  'Relevant checks': 'Результаты проверок',
  'QA result': 'Результат QA',
  'Staging verification': 'Проверка тестового контура',
  'Product Owner acceptance': 'Приёмка владельцем продукта'
};
const clone = (definition: DeliveryProtocolDefinition): DeliveryProtocolDefinition => structuredClone(definition);
const roleOf = (stage: DeliveryProtocolDefinition['stages'][number]) =>
  stage.responsibility.kind === 'project_role' ? stage.responsibility.role : 'project_owner';
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const responsibilityLabel = (stage: DeliveryProtocolDefinition['stages'][number]) => stage.responsibility.kind === 'project_role'
  ? roleLabels[stage.responsibility.role] ?? stage.responsibility.role
  : stage.responsibility.actorType === 'agent' ? 'Назначенный ИИ-агент' : 'Назначенный сотрудник';
const stageLabel = (stage: DeliveryProtocolDefinition['stages'][number]) => stageLabels[stage.key] ?? stage.name;

function ProtocolStageRead({stage, next}: {stage: DeliveryProtocolDefinition['stages'][number]; next: string}) {
  return <div className="fcp-protocol-read-stage" role="row"><div><CircleDot aria-hidden="true" size={16}/><strong>{stageLabel(stage)}</strong><small>{stage.enabled ? statusLabels[stage.taskStatus] : 'Отключено'}</small></div><div><UserRound aria-hidden="true" size={15}/><span>{responsibilityLabel(stage)}</span><small>{modeLabels[stage.executionMode]}</small></div><div><FileCheck2 aria-hidden="true" size={15}/><span>{stage.requiredEvidence.map((item) => evidenceLabels[item] ?? item).join(', ')}</span></div><div><ArrowRight aria-hidden="true" size={15}/><span>{next}</span></div></div>;
}

async function mutate(path: string, body: Record<string, unknown>): Promise<ProtocolResponse> {
  const response = await fetch(path, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
  const value = await response.json().catch(() => ({})) as ProtocolResponse & {status?: string; message?: string};
  if (!response.ok) throw new Error(value.message ?? value.status ?? 'The canonical command was not accepted.');
  return value;
}

export function DeliveryProtocolEditor({projectId, protocol, csrfToken}: {
  projectId: string; protocol: DeliveryProtocol | null; csrfToken: string | null;
}) {
  const original = protocol?.definition ?? null;
  const [definition, setDefinition] = useState<DeliveryProtocolDefinition | null>(original === null ? null : clone(original));
  const [simulation, setSimulation] = useState<ProtocolResponse['simulation']>();
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const changed = useMemo(() => original !== null && definition !== null && !same(original, definition), [definition, original]);
  const editable = protocol?.state === 'draft' && csrfToken !== null;
  const update = (index: number, patch: Partial<DeliveryProtocolDefinition['stages'][number]>) => setDefinition((current) => current === null ? null : {
    ...current, stages: current.stages.map((stage, candidate) => candidate === index ? {...stage, ...patch} : stage)
  });
  const request = async (action: 'create_default' | 'create_revision' | 'draft' | 'simulate' | 'publish' | 'activate') => {
    if (csrfToken === null) return setNotice({tone: 'error', text: 'Нужна авторизованная сессия руководителя.'});
    setBusy(true); setNotice(null);
    try {
      const result = await mutate('/api/delivery-protocol', action === 'create_default'
        ? {_csrf: csrfToken, action, projectId}
        : action === 'create_revision' || action === 'publish' || action === 'activate'
          ? {_csrf: csrfToken, action, projectId, protocolId: protocol!.id, expectedRevision: protocol!.revision}
          : {_csrf: csrfToken, action, projectId, ...(protocol === null ? {} : {protocolId: protocol.id, expectedRevision: protocol.revision}), definition});
      if (result.simulation !== undefined) setSimulation(result.simulation);
      setNotice(result.receipt === undefined
        ? {tone: 'neutral', text: result.simulation?.valid ? 'Симуляция пройдена без изменений данных.' : 'Симуляция обнаружила нарушения протокола.'}
        : {tone: 'success', text: `Команда ${result.receipt.commandType} сохранена. Обновляем факты…`});
      if (result.receipt !== undefined) window.setTimeout(() => window.location.reload(), 450);
    } catch (error) { setNotice({tone: 'error', text: error instanceof Error ? error.message : 'Команда недоступна.'}); }
    finally { setBusy(false); }
  };
  if (protocol === null) return <section className="fcp-delivery-empty">
    <ShieldAlert aria-hidden="true" size={20}/><div><h2>Не настроено</h2><p>Протокол работы для проекта ещё не сохранён.</p></div>
    {csrfToken === null ? <p className="fcp-muted">Войдите, чтобы создать стандартный черновик.</p> : <button className="fcp-primary-button" disabled={busy} onClick={() => void request('create_default')}><Sparkles aria-hidden="true" size={16}/>Создать стандартный черновик</button>}
    {notice === null ? null : <p className={`fcp-command-notice ${notice.tone}`}>{notice.text}</p>}
  </section>;
  return <section className="fcp-protocol-editor">
    <div className="fcp-protocol-facts"><span>Версия {protocol.version}</span><span>Редакция {protocol.revision}</span><span>{protocol.state === 'draft' ? 'Черновик' : protocol.state === 'published' ? 'Опубликован' : 'Архивный'}</span><span>{protocol.active ? 'Активен' : 'Неактивен'}</span></div>
    {editable ? <div className="fcp-protocol-table" role="table" aria-label="Этапы протокола работы">
      <div className="fcp-protocol-head" role="row"><span>Этап</span><span>Статус</span><span>Ответственный</span><span>Режим</span><span>Подтверждения</span><span>Далее</span></div>
      {definition?.stages.map((stage, index) => <div className="fcp-protocol-stage" role="row" key={stage.key}>
        <label>Этап<input aria-label={`${stage.name}: название этапа`} value={stage.name} onChange={(event) => update(index, {name: event.target.value})}/><small>{stage.key}</small></label>
        <label>Статус<select aria-label={`${stage.name}: статус задачи`} value={stage.taskStatus} onChange={(event) => update(index, {taskStatus: event.target.value as typeof stage.taskStatus})}>{taskStatuses.map((status) => <option value={status} key={status}>{statusLabels[status]}</option>)}</select><span className="fcp-check"><input aria-label={`${stage.name}: этап включён`} checked={stage.enabled} onChange={(event) => update(index, {enabled: event.target.checked})}/>Включён</span></label>
        <label>Ответственный<select aria-label={`${stage.name}: ответственный`} value={roleOf(stage)} onChange={(event) => update(index, {responsibility: {kind: 'project_role', role: event.target.value as typeof roleOptions[number]}})}>{roleOptions.map((role) => <option value={role} key={role}>{roleLabels[role]}</option>)}</select></label>
        <label>Режим<select aria-label={`${stage.name}: режим исполнения`} value={stage.executionMode} onChange={(event) => update(index, {executionMode: event.target.value as typeof stage.executionMode})}>{modes.map((mode) => <option value={mode} key={mode}>{modeLabels[mode]}</option>)}</select></label>
        <label>Подтверждения<input aria-label={`${stage.name}: обязательные подтверждения`} value={stage.requiredEvidence.join(', ')} onChange={(event) => update(index, {requiredEvidence: event.target.value.split(',').map((item) => item.trim()).filter(Boolean)})}/></label>
        <label>Далее<select aria-label={`${stage.name}: следующий этап`} value={stage.allowedNextStageKey ?? ''} onChange={(event) => update(index, {allowedNextStageKey: event.target.value || null})}><option value="">Завершение</option>{definition.stages.slice(index + 1).map((item) => <option value={item.key} key={item.key}>{item.name}</option>)}</select></label>
      </div>)}
    </div> : <div className="fcp-protocol-read" role="table" aria-label="Опубликованные этапы протокола работы">{protocol.definition.stages.map((stage) => {
      const next = protocol.definition.stages.find((candidate) => candidate.key === stage.allowedNextStageKey);
      return <ProtocolStageRead stage={stage} key={stage.key} next={stage.allowedNextStageKey === null ? 'Завершение' : next === undefined ? stage.allowedNextStageKey : stageLabel(next)}/>;
    })}</div>}
    <div className="fcp-protocol-actions">{protocol.state === 'draft' ? <>
      <button className="fcp-secondary" disabled={!editable || busy || !changed} onClick={() => void request('draft')}><Save aria-hidden="true" size={16}/>Сохранить черновик</button>
      <button className="fcp-secondary" disabled={!editable || busy} onClick={() => void request('simulate')}><CheckCircle2 aria-hidden="true" size={16}/>Проверить</button>
      <button className="fcp-primary-button" disabled={!editable || busy || simulation?.valid !== true} onClick={() => void request('publish')}><Send aria-hidden="true" size={16}/>Опубликовать</button>
    </> : protocol.state === 'published' && !protocol.active ? <button className="fcp-primary-button" disabled={csrfToken === null || busy} onClick={() => void request('activate')}><Play aria-hidden="true" size={16}/>Активировать</button> : protocol.state === 'published' ? <><button className="fcp-primary-button" disabled={csrfToken === null || busy} onClick={() => void request('create_revision')}><Save aria-hidden="true" size={16}/>Создать черновик изменений</button><p className="fcp-muted">Активная версия останется неизменной до публикации и активации новой.</p></> : <p className="fcp-muted">Архивная версия доступна только для чтения.</p>}</div>
    {changed ? <p className="fcp-diff"><strong>Изменения</strong> {definition?.stages.filter((stage, index) => !same(stage, original?.stages[index])).map((stage) => stage.name).join(', ') || 'Нет изменений этапов'}</p> : null}
    {simulation === undefined ? null : <p className={`fcp-command-notice ${simulation.valid ? 'success' : 'error'}`}>{simulation.valid ? `Проверка пройдена · ${simulation.simulationHash.slice(0, 12)}` : simulation.violations.join(' ')}</p>}
    {notice === null ? null : <p className={`fcp-command-notice ${notice.tone}`}>{notice.text}</p>}
  </section>;
}

export function DeliveryJourneyAction({workItemId, taskVersion, journey, activeProtocolId, csrfToken,
  terminal, terminalEvidenceComplete, requiredEvidence}: {workItemId: string; taskVersion: number;
  activeProtocolId: string | null; csrfToken: string | null;
  journey: {version: number; deadlineAt: Date | null; protocolId: string; protocolVersion: number;
    stageKey: string; requiredEvidence?: readonly string[]; canRecordTerminalEvidence?: boolean;
    stage?: Readonly<{
      terminal?: boolean; terminalEvidenceComplete?: boolean;
    }> | null;} | null;
  terminal?: boolean; terminalEvidenceComplete?: boolean; requiredEvidence?: readonly string[];}) {
  const [notice, setNotice] = useState<Notice | null>(null); const [busy, setBusy] = useState(false); const [evidence, setEvidence] = useState('');
  const isTerminal = terminal ?? journey?.stage?.terminal ?? false;
  const hasTerminalEvidence = terminalEvidenceComplete ?? journey?.stage?.terminalEvidenceComplete ?? false;
  const evidenceRequirements = requiredEvidence ?? journey?.requiredEvidence ?? [];
  const submit = async () => { if (csrfToken === null) return; setBusy(true); try { const action = journey === null ? 'start' : 'advance'; const result = await mutate(`/api/delivery-journeys/${workItemId}`, journey === null ? {_csrf: csrfToken, action, protocolId: activeProtocolId, expectedWorkItemVersion: taskVersion, deadlineAt: null} : {_csrf: csrfToken, action, expectedWorkItemVersion: taskVersion, expectedJourneyVersion: journey.version, evidenceReferences: evidence === '' ? [] : evidence.split('\n').filter(Boolean).map((reference) => ({requirement: reference.split(':')[0]?.trim() ?? '', reference: reference.slice(reference.indexOf(':') + 1).trim()}))}); if (result.receipt === undefined) throw new Error('Сохранённая квитанция команды не получена.'); setNotice({tone: 'success', text: `Команда ${result.receipt.commandType} сохранена. Обновляем факты…`}); window.setTimeout(() => window.location.reload(), 450); } catch (error) { setNotice({tone: 'error', text: error instanceof Error ? error.message : 'Команда недоступна.'}); } finally {setBusy(false);} };
  if (csrfToken === null || taskVersion < 1 || (journey === null && activeProtocolId === null)) return null;
  return <div className="fcp-journey-action">{journey === null ? <button className="fcp-primary-button" disabled={busy} onClick={() => void submit()}><Play aria-hidden="true" size={16}/>Начать цикл исполнения</button> : hasTerminalEvidence ? <p className="fcp-command-notice success">Финальные подтверждения зафиксированы. Результат можно принять в скопе проекта.</p> : isTerminal && journey.canRecordTerminalEvidence !== true ? <p className="fcp-command-notice neutral">Финальную приёмку фиксирует только выбранный владелец продукта с правом записи.</p> : <><label>{isTerminal ? 'Финальные подтверждения владельца продукта' : 'Подтверждения этапа'}<textarea aria-label="Подтверждения этапа" value={evidence} onChange={(event) => setEvidence(event.target.value)} placeholder={evidenceRequirements.length === 0 ? 'Требование: ссылка на сохранённое подтверждение' : evidenceRequirements.map((item) => `${evidenceLabels[item] ?? item}: ссылка на сохранённое подтверждение`).join('\n')} /></label><button className="fcp-primary-button" disabled={busy} onClick={() => void submit()}><Send aria-hidden="true" size={16}/>{isTerminal ? 'Зафиксировать финальную приёмку' : 'Перейти к следующему этапу'}</button></>}{notice === null ? null : <p className={`fcp-command-notice ${notice.tone}`}>{notice.text}</p>}</div>;
}
