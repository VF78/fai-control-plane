'use client';

import {useEffect, useRef, useState, type FormEvent, type ReactNode} from 'react';
import {Pencil, X} from 'lucide-react';
import type {ProjectContextStatusView, ProjectExecutionModeView} from '@fai-control-plane/db';
import type {AgentExecutorCatalog, AgentRoutingPolicy} from '@fai-control-plane/domain';
import {AsyncButton, CommandNoticeView, useAsyncCommand} from './async-command.tsx';

type Result = {error?: string; status?: string; version?: string; projectId?:string; slug?:string; profile?:string|null};
const post = async (path: string, body: Record<string, unknown>): Promise<Result> => {
  const response = await fetch(path, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
  const value = await response.json().catch(() => ({})) as Result;
  if (!response.ok) throw new Error(value.error ?? 'request_failed');
  return value;
};
const taskExecutorErrorNotice = (code: string): string => ({
  task_conflict: 'Команда не выполнена: задача уже изменилась в GitHub. Обновите страницу и проверьте исполнителя.',
  candidate_unavailable: 'Команда не выполнена: пользователь больше не доступен. Выберите другого.',
  operation_unavailable: 'Назначение недоступно для текущей стадии или конфигурации.',
  retry_unavailable: 'Повтор отклонён: предыдущая попытка не подтверждена как завершившаяся.',
  assignment_partial: 'GitHub применил операцию частично. Не повторяйте команду до проверки исполнителя и статуса.',
  delivery_failed: 'GitHub назначил Hermes, но запуск не подтверждён. Не повторяйте команду до проверки квитанции.',
  context_unavailable: 'Запуск Hermes недоступен: сначала актуализируйте контекст проекта в разделе «Процесс».',
  execution_unavailable: 'Запуск Hermes недоступен: настройки исполнения проекта не готовы.',
  profile_unavailable: 'Профиль ИИ агента недоступен после восстановления. Задача не запущена.',
  provider_error: 'GitHub или Hermes не подтвердил операцию. Не повторяйте команду до проверки квитанции.'
}[code] ?? 'Команда не подтверждена. Обновите задачу и проверьте её состояние перед повтором.');
const id = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;

export function LogoutControl() {
  const command = useAsyncCommand();
  return <div className="fcp-logout"><AsyncButton type="button" pending={command.pending} pendingLabel="Выходим…" onClick={() => void command.run(async () => {
    const result = await post('/api/auth/logout', {}); window.location.assign('/'); return result;
  }, {success: 'Сеанс завершён.', refresh: false})}>Выйти</AsyncButton><CommandNoticeView notice={command.notice}/></div>;
}

export function SourceAddControl({projectId}: Readonly<{projectId: string}>) {
  const command = useAsyncCommand();
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = new FormData(event.currentTarget); void command.run(() => post(`/api/projects/${projectId}/sources`, {kind: form.get('kind'), name: form.get('name'), mediaType: 'text/plain', contentText: form.get('contentText'), sourceUrl: empty(form.get('sourceUrl')), provenance: form.get('provenance')}), {success: 'Источник добавлен.'}); };
  return <details className="fcp-control"><summary>Добавить источник</summary><form onSubmit={submit} aria-busy={command.pending}><label>Название<input name="name" required maxLength={200} disabled={command.pending}/></label><label>Тип<input name="kind" defaultValue="operator_note" required maxLength={64} disabled={command.pending}/></label><label>Ссылка на источник <input name="sourceUrl" type="url" disabled={command.pending}/></label><label>Происхождение<input name="provenance" defaultValue="operator" required maxLength={500} disabled={command.pending}/></label><label>Содержание<textarea name="contentText" required maxLength={200000} disabled={command.pending}/></label><AsyncButton pending={command.pending} pendingLabel="Сохраняем…">Сохранить источник</AsyncButton></form><CommandNoticeView notice={command.notice}/></details>;
}

export function ProjectDocumentUploadControl({projectId}:Readonly<{projectId:string}>) {
  const command=useAsyncCommand();
  const error=(value:unknown):string=>({
    project_document_pdf_text_layer_required:'В PDF нет текстового слоя. Загрузите текстовый PDF или DOCX.',
    project_document_set_too_large:'Лимит набора: до 10 файлов и 100 МиБ.',
    project_document_invalid:'Файл не распознан. Поддерживаются DOCX, PDF с текстовым слоем, MD и TXT до 50 МиБ.',
    project_document_denied:'Загружать документы может владелец проекта.'
  }[value instanceof Error?value.message:'']??'Документ не загружен. Проверьте файл и повторите.');
  const submit=(event:FormEvent<HTMLFormElement>)=>{event.preventDefault();const form=new FormData(event.currentTarget);
    form.append('idempotencyKey',`project-document:${id()}`);
    void command.run(async()=>{const response=await fetch(`/api/projects/${projectId}/documents`,{method:'POST',body:form});
      const value=await response.json().catch(()=>({})) as Result;if(!response.ok)throw new Error(value.error??'request_failed');
      return value;},{success:'Документ загружен как новая неизменяемая версия.',error});};
  return <details className="fcp-control"><summary>Загрузить документ</summary><form onSubmit={submit} aria-busy={command.pending}>
    <label>Категория<select name="category" required disabled={command.pending} defaultValue="requirements">
      <option value="requirements">Требования / ТЗ</option><option value="passport">Паспорт проекта</option>
      <option value="combined">Требования + паспорт</option><option value="architecture">Архитектура</option>
      <option value="supplemental">Дополнительный</option></select></label>
    <label>Оригинал DOCX, PDF, MD или TXT<input name="file" type="file" required
      accept=".docx,.pdf,.md,.txt,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/pdf,text/markdown,text/plain"
      disabled={command.pending}/></label><small>До 50 МиБ на файл и 100 МиБ на активный набор. PDF должен содержать текстовый слой.</small>
    <AsyncButton pending={command.pending} pendingLabel="Загружаем…">Загрузить версию</AsyncButton>
  </form><CommandNoticeView notice={command.notice}/></details>;
}

export function ProjectRegistrationControl() {
  const command=useAsyncCommand();
  const submit=(event:FormEvent<HTMLFormElement>)=>{event.preventDefault();const form=new FormData(event.currentTarget);
    void command.run(()=>post('/api/projects',{name:form.get('name'),slug:form.get('slug'),projectUrl:form.get('projectUrl'),
      repositoryUrl:form.get('repositoryUrl'),idempotencyKey:`project-register:${id()}`}),
      {success:'Проект подключён. Теперь выберите его и активируйте ИИ агента.'});};
  return <details className="fcp-control"><summary>Подключить проект</summary><form onSubmit={submit} aria-busy={command.pending}>
    <label>Название<input name="name" required maxLength={200} disabled={command.pending}/></label>
    <label>Короткое имя<input name="slug" required maxLength={100} pattern="[a-z0-9][a-z0-9-]+[a-z0-9]" placeholder="fai-control-plane" disabled={command.pending}/></label>
    <label>Ссылка на GitHub Project<input name="projectUrl" type="url" required placeholder="https://github.com/users/VF78/projects/1" disabled={command.pending}/></label>
    <label>Ссылка на репозиторий<input name="repositoryUrl" type="url" required placeholder="https://github.com/VF78/fai-control-plane" disabled={command.pending}/></label>
    <small>Секреты не вводятся: используются защищённые подключения рабочего пространства.</small>
    <AsyncButton pending={command.pending} pendingLabel="Подключаем…">Подключить</AsyncButton>
  </form><CommandNoticeView notice={command.notice}/></details>;
}

export function ProjectAgentActivationControl({projectId,status,profile,documentsReady}:Readonly<{projectId:string;
  status:'not_configured'|'configuring'|'awaiting_architecture'|'ready'|'error';profile:string|null;
  documentsReady:boolean}>) {
  const command=useAsyncCommand(); const activate=()=>void command.run(()=>post(`/api/projects/${projectId}/agent-profile`,
    {idempotencyKey:`agent-profile:${id()}`,force:status==='ready'||status==='error'}),
    {success:(result)=>result.status==='ready'?'ИИ агент готов к работе.':'Настройка не подтверждена.',
      error:(error)=>error instanceof Error&&error.message==='project_documents_required'
        ?'Сначала загрузите ТЗ и паспорт проекта или один объединённый документ.'
        :error instanceof Error&&error.message==='agent_profile_probe_failed'
          ?'Профиль создан, но Hermes ещё не подтвердил готовность. Повторите активацию после запуска gateway.'
          :'Не удалось активировать ИИ агента. Существующая конфигурация не изменена.'});
  const title=!documentsReady?'Нужны документы':status==='not_configured'?'Готов к настройке':
    status==='configuring'?'Настраивается':status==='awaiting_architecture'?'Ожидает согласования архитектуры':
      status==='ready'?'ИИ агент готов':'Ошибка настройки';
  const detail=!documentsReady?'Загрузите ТЗ и паспорт проекта или один объединённый документ.':
    status==='configuring'?'Hermes собирает компактный контекст в фоне.':
      status==='awaiting_architecture'?'Согласуйте точную версию архитектурного предложения; повторный анализ не требуется.':
        status==='ready'?`Постоянный профиль ${profile??''} активен для этого проекта.`:profile===null
          ?'Будет создан отдельный постоянный Hermes-профиль из общего шаблона.':
          `Профиль ${profile} сохранён и может быть настроен повторно.`;
  return <div className="fcp-agent-activation"><div><strong>{title}</strong><small>{detail}</small></div>
    <AsyncButton type="button" disabled={!documentsReady||status==='configuring'||status==='awaiting_architecture'}
      pending={command.pending} pendingLabel="Настраиваем…" onClick={activate}>
      {status==='ready'||status==='error'?'Обновить настройку':'Настроить ИИ агента'}
    </AsyncButton>
    <CommandNoticeView notice={command.notice}/></div>;
}

export function ArchitectureProposalDecision({projectId,proposalSha}:Readonly<{projectId:string;
  proposalSha:string}>) {
  const command=useAsyncCommand();
  const approve=()=>void command.run(()=>post(`/api/approvals/${id()}`,{projectId,targetReference:proposalSha,
    kind:'plan',decision:'approved',idempotencyKey:`architecture-approval:${id()}`}),
  {success:'Архитектурное предложение согласовано. ИИ агент станет готов после обработки worker.'});
  return <div className="fcp-agent-activation"><div><strong>Архитектурное предложение готово</strong>
    <small><a href={`/api/projects/${projectId}/sources?architectureProposal=${proposalSha}`}>Скачать точную версию</a> и согласуйте её без повторного анализа документов.</small></div>
    <AsyncButton type="button" pending={command.pending} pendingLabel="Согласуем…" onClick={approve}>
      Согласовать архитектуру</AsyncButton><CommandNoticeView notice={command.notice}/></div>;
}

export function ProjectExecutionModeControl({projectId, mode, canManage}: Readonly<{
  projectId: string; mode: ProjectExecutionModeView; canManage: boolean;
}>) {
  const command = useAsyncCommand(); const autonomous = mode.mode === 'autonomous';
  const change = () => void command.run(() => post(`/api/projects/${projectId}/execution-mode`, {
    mode: autonomous ? 'manual' : 'autonomous', idempotencyKey: `project-execution-mode:${id()}`
  }), {success: autonomous ? 'Автономный режим остановлен.' : 'Автономный режим включён.'});
  return <div className="fcp-agent-activation fcp-project-execution-mode"><div>
    <strong>{autonomous ? 'Автономное выполнение включено' : 'Ручной запуск задач'}</strong>
    <small>{autonomous ? 'Worker запускает по одной готовой задаче и останавливается на согласовании или блокере.'
      : 'Новые задачи запускаются только человеком в разделе «Задачи».'}</small></div>
    {canManage ? <AsyncButton type="button" className={autonomous ? 'fcp-secondary' : undefined}
      pending={command.pending} pendingLabel={autonomous ? 'Останавливаем…' : 'Включаем…'} onClick={change}>
      {autonomous ? 'Остановить' : 'Включить автономно'}</AsyncButton> : null}
    <CommandNoticeView notice={command.notice}/></div>;
}

export function AgentRoutingControl({projectId, canManage, policy, executorCatalog}: Readonly<{
  projectId: string; canManage: boolean; policy: AgentRoutingPolicy; executorCatalog: AgentExecutorCatalog;
}>) {
  const command = useAsyncCommand();
  type Field = 'executor'|'model'|'effort';
  const [draft, setDraft] = useState(policy);
  const [saved, setSaved] = useState(policy);
  const [editing, setEditing] = useState<{taskClass: AgentRoutingPolicy['routes'][number]['taskClass']; field: Field}|null>(null);
  const update = (taskClass: AgentRoutingPolicy['routes'][number]['taskClass'], change: (route: AgentRoutingPolicy['routes'][number]) => AgentRoutingPolicy['routes'][number]) => setDraft((current) => ({...current, routes: current.routes.map((route) => route.taskClass === taskClass ? change(route) : route)}));
  const save = () => void command.run(() => post(`/api/projects/${projectId}/agent-routing`, {policy: draft, idempotencyKey: `agent-routing:${id()}`}), {success: () => { setSaved(draft); setEditing(null); return 'Настройка сохранена.'; }});
  const cancel = () => { setDraft(saved); setEditing(null); };
  const codexReady = executorCatalog['codex-cli']?.available ?? false;
  return <div className="fcp-agent-routing-editor">{draft.routes.map((route) => {
    const executor = route.executor.kind === 'direct-agent' ? 'direct-agent' : route.executor.id;
    const active = (field: Field) => editing?.taskClass === route.taskClass && editing.field === field;
    const open = (field: Field) => setEditing({taskClass: route.taskClass, field});
    return <article key={route.taskClass}><h3>{routingClassLabel[route.taskClass]}</h3><div className="fcp-agent-routing-fields">
      <RoutingSetting label="Исполнитель" value={route.executor.kind === 'direct-agent' ? 'Hermes' : route.executor.id === 'codex-cli' ? 'Codex CLI' : 'Claude Code CLI'} editing={active('executor')} editable={canManage && codexReady && editing === null && editableExecutors.has(route.taskClass)} pending={command.pending} onEdit={() => open('executor')} onSave={save} onCancel={cancel} editor={<select aria-label="Исполнитель" value={executor} disabled={command.pending} onChange={(event) => update(route.taskClass, (current) => ({...current, executor: event.target.value === 'direct-agent' ? {kind:'direct-agent'} : {kind:'cli', id:event.target.value}}))}><option value="direct-agent">Hermes</option><option value="codex-cli">Codex CLI</option><option value="claude-code-cli" disabled>Claude Code CLI</option></select>}/>
      <RoutingSetting label="Модель" value={route.model === 'gpt-5.6-terra' ? 'GPT-5.6 Terra' : 'GPT-5.6 Sol'} editing={active('model')} editable={canManage && codexReady && editing === null} pending={command.pending} onEdit={() => open('model')} onSave={save} onCancel={cancel} editor={<select aria-label="Модель" value={route.model} disabled={command.pending} onChange={(event) => update(route.taskClass, (current) => ({...current, model:event.target.value}))}><option value="gpt-5.6-terra">GPT-5.6 Terra</option><option value="gpt-5.6-sol">GPT-5.6 Sol</option></select>}/>
      <RoutingSetting label="Рассуждение" value={route.effort === 'high' ? 'Высокое' : 'Среднее'} editing={active('effort')} editable={canManage && codexReady && editing === null} pending={command.pending} onEdit={() => open('effort')} onSave={save} onCancel={cancel} editor={<select aria-label="Рассуждение" value={route.effort} disabled={command.pending} onChange={(event) => update(route.taskClass, (current) => ({...current, effort:event.target.value as AgentRoutingPolicy['routes'][number]['effort']}))}><option value="medium">Среднее</option><option value="high">Высокое</option></select>}/>
      <RoutingSetting label="Приёмка агентом" value="Обязательна" editing={false} editable={false} pending={command.pending} onEdit={() => undefined} onSave={save} onCancel={() => undefined} editor={null}/>
      <RoutingSetting label="Контроль человека" value={routingGateLabel[route.humanGate]} editing={false} editable={false} pending={command.pending} onEdit={() => undefined} onSave={save} onCancel={() => undefined} editor={null}/>
    </div></article>;
  })}<CommandNoticeView notice={command.notice}/>{!canManage ? <p className="fcp-control-note">Редактирование доступно владельцу проекта.</p> : codexReady ? null : <p className="fcp-control-note">Редактирование станет доступно после подключения Codex CLI.</p>}</div>;
}

function RoutingSetting({label, value, editing, editable, pending, editor, onEdit, onSave, onCancel}: Readonly<{label:string; value:string; editing:boolean; editable:boolean; pending:boolean; editor:ReactNode; onEdit:()=>void; onSave:()=>void; onCancel:()=>void}>) {
  return <div className="fcp-agent-routing-setting"><span>{label}</span>{editing ? <form onSubmit={(event) => { event.preventDefault(); onSave(); }} aria-busy={pending}>{editor}<div><AsyncButton pending={pending} pendingLabel="Сохраняем…">Сохранить</AsyncButton><AsyncButton type="button" className="fcp-icon-button" pending={false} pendingLabel="" disabled={pending} aria-label="Отменить" onClick={onCancel}><X aria-hidden="true" size={15}/></AsyncButton></div></form> : <div><strong>{value}</strong>{editable ? <AsyncButton type="button" className="fcp-icon-button" pending={false} pendingLabel="" disabled={pending} aria-label={`Изменить: ${label}`} onClick={onEdit}><Pencil aria-hidden="true" size={14}/></AsyncButton> : null}</div>}</div>;
}

const contextSourceLabel: Readonly<Record<string,string>> = {
  'repo:agents':'AGENTS.md', 'repo:passport':'Паспорт проекта',
  'composition:project-process-policy':'Процесс проекта'
};
const contextTime = (value: string) => new Intl.DateTimeFormat('ru-RU', {day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',timeZone:'Europe/Moscow'}).format(new Date(value));

export function HermesContextControl({projectId, canManage, context}: Readonly<{
  projectId: string; canManage: boolean; context: ProjectContextStatusView|null;
}>) {
  const command = useAsyncCommand();
  const snapshot = context?.snapshot ?? null; const size = snapshot === null ? 0 : new TextEncoder().encode(snapshot.content).byteLength;
  const status = command.notice?.tone === 'error' ? 'Требует внимания' : context === null ? 'Не настроен' : context.status === 'stale' ? 'Требуется обновление' : 'Актуален';
  const tone = command.notice?.tone === 'error' ? 'error' : context?.status === 'current' ? 'success' : 'warning';
  const refresh = () => void command.run(() => post(`/api/projects/${projectId}/context/refresh`, {idempotencyKey:`project-context:${id()}`}), {success: 'Контекст актуализирован и будет применён к новым задачам.', error: 'Не удалось актуализировать контекст. Активная версия сохранена.'});
  return <section className="fcp-context-card"><header><div><strong>КОНТЕКСТ ИИ АГЕНТА</strong><p>Подтверждённые источники применяются к новым задачам.</p></div><span className={`fcp-context-state ${tone}`}><i aria-hidden="true"/>{status}</span></header><dl className="fcp-context-facts"><div><dt>СОСТОЯНИЕ</dt><dd>{snapshot === null ? 'Не настроен' : 'Готов к использованию'}<small>{context?.status === 'stale' ? 'требуется обновление' : 'активен для ИИ агента'}</small></dd></div><div><dt>ПОСЛЕДНЕЕ ОБНОВЛЕНИЕ</dt><dd>{snapshot === null ? 'Не настроено' : contextTime(snapshot.createdAt)}<small>МСК</small></dd></div><div><dt>ИСТОЧНИКОВ</dt><dd>{context?.sources.length ?? 0}<small>подтверждённые</small></dd></div><div><dt>ОБЪЁМ</dt><dd>{size === 0 ? 'Нет данных' : 'В пределах лимита'}<small>проверен при сборке</small></dd></div></dl><div className="fcp-context-sources-head"><span>Подтверждённые источники</span><span>Готов к применению</span></div><ul className="fcp-context-source-list" aria-label="Подтверждённые источники контекста">{context?.sources.map((source) => <li key={source.key}><div><strong>{contextSourceLabel[source.key] ?? 'Источник проекта'}</strong><small>Подтверждённый источник</small></div><span>Источник</span></li>) ?? <li><div><strong>Источники не настроены</strong><small>Сборка недоступна</small></div></li>}</ul><div className="fcp-context-application"><span>Применение контекста</span><p>Новые задачи получают контекст сразу. В активном чате он применяется со следующего сообщения.</p></div><div className="fcp-context-action"><p>{canManage ? 'Владелец или оператор проекта может запустить сборку.' : 'Актуализация доступна владельцу или оператору проекта.'}</p>{canManage ? <AsyncButton type="button" pending={command.pending} pendingLabel="Актуализируем…" onClick={refresh}>Актуализировать контекст</AsyncButton> : null}</div><CommandNoticeView notice={command.notice}/></section>;
}

const editableExecutors = new Set(['manager_project_ops', 'architecture_design', 'critical_decision', 'release_preflight']);
const routingClassLabel: Record<AgentRoutingPolicy['routes'][number]['taskClass'], string> = {manager_project_ops:'Управление проектом',ordinary_implementation:'Обычная реализация',ui_responsive:'Интерфейс и адаптивность',complex_implementation:'Сложная реализация',qa_audit:'Проверка и аудит',architecture_design:'Архитектура и дизайн',critical_decision:'Критическое решение',release_preflight:'Предрелизная проверка',protected_operation:'Защищённая операция'};
const routingGateLabel: Record<AgentRoutingPolicy['routes'][number]['humanGate'], string> = {none:'контроль человека не требуется',product_visual:'нужно согласование UI/UX',architecture_decision:'нужно архитектурное решение',production_exact:'нужно точное production-подтверждение'};

export function ApprovalControl({projectId, taskId}: Readonly<{projectId: string; taskId: string | null}>) {
  const command = useAsyncCommand();
  if (taskId === null) return <p className="fcp-control-note">Чтобы зафиксировать точное согласование, выберите карточку GitHub Project.</p>;
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = new FormData(event.currentTarget); void command.run(() => post(`/api/approvals/${id()}`, {projectId, targetReference: taskId, kind: form.get('kind'), decision: form.get('decision'), idempotencyKey: id()}), {success: 'Согласование зафиксировано.'}); };
  return <details className="fcp-control"><summary>Зафиксировать согласование</summary><form onSubmit={submit} aria-busy={command.pending}><label>Вид<select name="kind" defaultValue="acceptance" disabled={command.pending}><option value="plan">План</option><option value="internal_operation">Внутренняя операция</option><option value="acceptance">Приёмка</option><option value="client_uat">Клиентское UAT</option></select></label><label>Решение<select name="decision" disabled={command.pending}><option value="approved">Согласовано</option><option value="rejected">Отклонено</option></select></label><AsyncButton pending={command.pending} pendingLabel="Фиксируем…">Зафиксировать</AsyncButton></form><CommandNoticeView notice={command.notice}/></details>;
}

export function AccessControls({projectId, canManage, members}: Readonly<{projectId: string; canManage: boolean; members: readonly {membershipId: string; displayName: string; role: string}[]}>) {
  const command = useAsyncCommand();
  if (!canManage) return <p className="fcp-control-note">Изменение состава доступно только project owner.</p>;
  const onboard = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = new FormData(event.currentTarget); const telegramUserId = empty(form.get('telegramUserId')); const bitrix24UserId = empty(form.get('bitrix24UserId')); void command.run(() => post('/api/access/onboarding', {projectId, displayName: form.get('displayName'), githubUserId: form.get('githubUserId'), role: form.get('role'), ...(telegramUserId === null ? {} : {telegramUserId}), ...(bitrix24UserId === null ? {} : {bitrix24UserId})}), {success: 'Участник добавлен.'}); };
  const membership = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = new FormData(event.currentTarget); const selected = members.find((member) => member.membershipId === form.get('membershipId')); if (selected !== undefined) void command.run(() => post(`/api/access/memberships/${selected.membershipId}`, {role: form.get('role'), active: form.get('active') === 'on'}), {success: 'Доступ сохранён.'}); };
  return <section className="fcp-controls"><details className="fcp-control"><summary>Добавить участника</summary><form onSubmit={onboard} aria-busy={command.pending}><label>Имя<input name="displayName" required maxLength={200} disabled={command.pending}/></label><label>Роль<select name="role" disabled={command.pending}><option value="operator">Оператор</option><option value="contributor">Участник</option><option value="client">Клиент</option></select></label><label>GitHub ID <input name="githubUserId" inputMode="numeric" pattern="[1-9][0-9]*" disabled={command.pending}/></label><label>Telegram ID <input name="telegramUserId" inputMode="numeric" disabled={command.pending}/></label><label>Bitrix24 ID <input name="bitrix24UserId" disabled={command.pending}/></label><small>Для команды нужен GitHub ID; клиенту достаточно GitHub или Bitrix24.</small><AsyncButton pending={command.pending} pendingLabel="Добавляем…">Добавить</AsyncButton></form></details><details className="fcp-control"><summary>Изменить членство</summary><form onSubmit={membership} aria-busy={command.pending}><label>Участник<select name="membershipId" disabled={command.pending}>{members.map((member) => <option key={member.membershipId} value={member.membershipId}>{member.displayName} · {member.role}</option>)}</select></label><label>Новая роль<select name="role" defaultValue="" required disabled={command.pending}><option value="" disabled>Выберите роль</option><option value="project_owner">Владелец проекта</option><option value="operator">Оператор</option><option value="contributor">Участник</option><option value="client">Клиент</option></select></label><label className="fcp-check"><input name="active" type="checkbox" defaultChecked disabled={command.pending}/> Активен</label><AsyncButton pending={command.pending} pendingLabel="Сохраняем…">Сохранить доступ</AsyncButton></form></details><CommandNoticeView notice={command.notice}/></section>;
}

type AssignableUser = Readonly<{id: string; login: string; name: string|null}>;
type ConfirmedRun = Readonly<{deliveryReference: string; occurredAt: string; status: 'started'|'completed'|'failed'}>;
export function TaskExecutorControl({projectId, task, currentExecutor, confirmedRun}: Readonly<{projectId: string; currentExecutor: string; confirmedRun: ConfirmedRun|null; task: {itemId: string; status: string|null; blocked: boolean|null}}>) {
  const [users, setUsers] = useState<readonly AssignableUser[]|null>(null); const [selected, setSelected] = useState('');
  const [confirming, setConfirming] = useState(false);
  const runStatus: 'started'|'completed'|'failed' = confirmedRun?.status ?? 'started';
  const confirmRef = useRef<HTMLDivElement>(null); const actionRef = useRef<HTMLButtonElement>(null); const command = useAsyncCommand();
  useEffect(() => { let active = true; void fetch(`/api/tasks/executor?projectId=${encodeURIComponent(projectId)}`).then(async (response) => {
    const value = await response.json().catch(() => ({})) as {users?: AssignableUser[]; error?: string}; if (!response.ok) throw new Error(value.error ?? 'provider_error');
    if (active) setUsers(value.users ?? []);
  }).catch(() => { if (active) setUsers([]); }); return () => { active = false; }; }, [projectId]);
  const choice = selected === 'hermes' ? 'hermes' : users?.find((user) => `human:${user.id}` === selected);
  const human = choice !== undefined && choice !== 'hermes' ? choice : null;
  const activeRun = confirmedRun;
  const unavailable = task.blocked === null || task.status === null || ['Blocked', 'Done'].includes(task.status);
  const startsDevelopment = task.status === 'Backlog' || task.status === 'Ready';
  const unblock = task.blocked === true ? ' Blocked станет No.' : '';
  const effects = human === null ? `GitHub: Owner станет Hermes, Assignee очистится.${unblock}${startsDevelopment ? ' Этап станет In Dev.' : ` Этап ${task.status} сохранится.`} Hermes получит явную команду.` : `GitHub: Assignee станет @${human.login}, Owner очистится.${unblock}${startsDevelopment ? ' Этап станет In Dev.' : ` Этап ${task.status} сохранится.`} Уведомление человеку не отправляется.`;
  useEffect(() => { if (confirming) requestAnimationFrame(() => confirmRef.current?.focus()); }, [confirming]);
  const retryAttempt = () => { if (activeRun === null) return; void command.run(() => post('/api/tasks/executor', {projectId, projectItemId: task.itemId, executor: {kind: 'hermes'}, retry: {deliveryReference: activeRun.deliveryReference, nonce: crypto.randomUUID()}}), {success: 'Новая попытка Hermes запущена.', error: (error) => taskExecutorErrorNotice(error instanceof Error ? error.message : 'request_failed')}); };
  const execute = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); if (choice === undefined) return; void command.run(() => post('/api/tasks/executor', {projectId, projectItemId: task.itemId, executor: human === null ? {kind: 'hermes'} : {kind: 'human', candidate: {id: human.id, login: human.login}}}), {success: (result) => { setConfirming(false); return result.status === 'duplicate' ? 'Команда уже была подтверждена.' : human === null ? 'Запуск Hermes подтверждён.' : 'Исполнитель назначен.'; }, error: (error) => taskExecutorErrorNotice(error instanceof Error ? error.message : 'request_failed')}); };
  if (unavailable) return <section className="fcp-task-executor"><header><div><h2>Исполнитель</h2><p>Назначение недоступно только для терминального или неизвестного этапа.</p></div></header><p className="fcp-control-note">Для текущего статуса GitHub Project назначение недоступно.</p></section>;
  const form = <form onSubmit={execute} aria-busy={command.pending}><label>Кому назначить<select value={selected} onChange={(event) => { setSelected(event.target.value); setConfirming(false); }} disabled={command.pending}><option value="">{users === null ? 'Загружаем пользователей…' : 'Выберите исполнителя'}</option><optgroup label="Люди">{users?.map((user) => <option key={user.id} value={`human:${user.id}`}>{user.name === null ? `@${user.login}` : `${user.name} · @${user.login}`}</option>)}</optgroup>{task.status === 'Acceptance' || (activeRun !== null && runStatus !== 'completed') ? null : <optgroup label="Агенты"><option value="hermes">Hermes</option></optgroup>}</select></label>{confirming ? <div className="fcp-task-confirm" role="status" tabIndex={-1} ref={confirmRef}><strong>{human === null ? 'Hermes' : `${human.name ?? human.login} · @${human.login}`}</strong><p>{effects}</p>{human === null ? <small>Запуск Hermes — явная внешняя операция; merge, release, deploy и production недоступны.</small> : null}<div><AsyncButton pending={command.pending} pendingLabel="Запускаем…">Подтвердить и начать</AsyncButton><AsyncButton type="button" className="fcp-secondary" pending={command.pending} pendingLabel="Отменяем…" onClick={() => { setConfirming(false); actionRef.current?.focus(); }}>Отмена</AsyncButton></div></div> : <AsyncButton type="button" ref={actionRef} pending={command.pending} pendingLabel="Готовим…" disabled={choice === undefined} onClick={() => setConfirming(true)}>{activeRun === null ? 'Назначить и начать' : 'Подтвердить смену исполнителя'}</AsyncButton>}</form>;
  const runTitle = runStatus === 'completed' ? 'Запуск Hermes завершён' : runStatus === 'failed' ? 'Запуск Hermes завершился ошибкой' : 'Запуск Hermes выполняется';
  const runAction = runStatus === 'failed' ? <AsyncButton type="button" pending={command.pending} pendingLabel="Запускаем…" onClick={retryAttempt}>Запустить заново</AsyncButton> : null;
  return <section className="fcp-task-executor"><header><div><h2>Исполнитель</h2><p>GitHub остаётся источником назначения и статуса.</p></div><span>{currentExecutor}</span></header>{activeRun === null ? form : <><div className="fcp-task-outcome" role="status"><strong>{runTitle}</strong><p>{runStatus === 'started' ? `Текущий этап: ${task.status ?? 'не подтверждён'}. Worker проверяет результат автоматически раз в минуту.` : `Текущий этап: ${task.status ?? 'не подтверждён'}.`}</p><small>{new Intl.DateTimeFormat('ru-RU', {day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',timeZone:'Europe/Moscow'}).format(new Date(activeRun.occurredAt))}</small><div>{runAction}</div></div><details className="fcp-task-reassign"><summary>{runStatus === 'completed' ? 'Начать текущий этап или сменить исполнителя' : 'Сменить исполнителя'}</summary>{form}</details></>}<CommandNoticeView notice={command.notice}/></section>;
}

function empty(value: FormDataEntryValue | null): string | null { return typeof value === 'string' && value.trim().length > 0 ? value : null; }
