'use client';

import {useEffect, useRef, useState, type FormEvent} from 'react';
import {useRouter} from 'next/navigation';
import type {ProjectContextStatusView} from '@fai-control-plane/db';
import type {AgentExecutorCatalog, AgentRoutingPolicy} from '@fai-control-plane/domain';

type Result = {error?: string; status?: string; version?: string};
const post = async (path: string, body: Record<string, unknown>): Promise<Result> => {
  const response = await fetch(path, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
  const value = await response.json().catch(() => ({})) as Result;
  if (!response.ok) throw new Error(value.error ?? 'request_failed');
  return value;
};
const useCommand = () => {
  const [notice, setNotice] = useState<string | null>(null);
  const router = useRouter();
  return {notice, run: async (request: () => Promise<Result>, success?: (result: Result) => string) => { try { const result = await request(); router.refresh(); setNotice(success?.(result) ?? result.status ?? 'Сохранено'); } catch (error) { setNotice(error instanceof Error ? error.message : 'request_failed'); } }};
};
const id = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;

export function LogoutControl() {
  const {notice, run} = useCommand();
  return <div className="fcp-logout"><button type="button" onClick={() => void run(async () => {
    const result = await post('/api/auth/logout', {}); window.location.assign('/'); return result;
  })}>Выйти</button><Notice value={notice}/></div>;
}

export function SourceAddControl({projectId}: Readonly<{projectId: string}>) {
  const {notice, run} = useCommand();
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = new FormData(event.currentTarget); void run(() => post(`/api/projects/${projectId}/sources`, {kind: form.get('kind'), name: form.get('name'), mediaType: 'text/plain', contentText: form.get('contentText'), sourceUrl: empty(form.get('sourceUrl')), provenance: form.get('provenance')})); };
  return <details className="fcp-control"><summary>Добавить источник</summary><form onSubmit={submit}><label>Название<input name="name" required maxLength={200}/></label><label>Тип<input name="kind" defaultValue="operator_note" required maxLength={64}/></label><label>Ссылка на источник <input name="sourceUrl" type="url"/></label><label>Происхождение<input name="provenance" defaultValue="operator" required maxLength={500}/></label><label>Содержание<textarea name="contentText" required maxLength={200000}/></label><button className="fcp-primary">Сохранить источник</button></form><Notice value={notice}/></details>;
}

export function AgentRoutingControl({projectId, canManage, policy, executorCatalog}: Readonly<{
  projectId: string; canManage: boolean; policy: AgentRoutingPolicy; executorCatalog: AgentExecutorCatalog;
}>) {
  const {notice, run} = useCommand();
  if (!canManage) return <p className="fcp-control-note">Изменение исполнения доступно только владельцу проекта.</p>;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    const routes = policy.routes.map((route) => {
      const prefix = route.taskClass;
      const executor = String(form.get(`${prefix}:executor`));
      return {...route,
        executor: executor === 'direct-agent' ? {kind: 'direct-agent'} : {kind: 'cli', id: executor},
        model: String(form.get(`${prefix}:model`)), effort: String(form.get(`${prefix}:effort`)),
        runtimeAcceptance: 'required', humanGate: String(form.get(`${prefix}:humanGate`))};
    });
    void run(() => post(`/api/projects/${projectId}/agent-routing`, {
      policy: {contract: 'fai.agent-routing.v1', routes}, idempotencyKey: `agent-routing:${id()}`
    }), (result) => result.version === undefined ? 'Исполнение сохранено.' : `Сохранена неизменяемая версия ${result.version.slice(0, 12)}.`);
  };
  const codexReady = executorCatalog['codex-cli']?.available ?? false;
  return <details className="fcp-control fcp-hermes-editor"><summary>Изменить исполнение и модель</summary><form onSubmit={submit}><p>Классы определяет Hermes; обязательная приёмка и контроль человека зафиксированы политикой.</p>{policy.routes.map((route) => { const executorEditable = editableExecutors.has(route.taskClass); const direct = route.executor.kind === 'direct-agent'; const executor = direct ? 'direct-agent' : route.executor.id; return <fieldset key={route.taskClass}><legend>{routingClassLabel[route.taskClass]}</legend><input type="hidden" name={`${route.taskClass}:humanGate`} value={route.humanGate}/><label>Исполнитель{executorEditable ? <select name={`${route.taskClass}:executor`} defaultValue={executor}><option value="direct-agent">Hermes</option><option value="codex-cli" disabled={!codexReady}>Codex CLI{codexReady ? '' : ' · runtime не подтверждён'}</option><option value="claude-code-cli" disabled>Claude Code CLI · недоступен</option></select> : <><span className="fcp-hermes-editor-fixed">{direct ? 'Hermes' : 'Codex CLI'}</span><input type="hidden" name={`${route.taskClass}:executor`} value={executor}/></>}</label><label>Модель<select name={`${route.taskClass}:model`} defaultValue={route.model}><option value="gpt-5.6-terra">GPT-5.6 Terra</option><option value="gpt-5.6-sol">GPT-5.6 Sol</option></select></label><label>Усилие<select name={`${route.taskClass}:effort`} defaultValue={route.effort}><option value="medium">Среднее</option><option value="high">Высокое</option></select></label><small>Приёмка Hermes обязательна · {routingGateLabel[route.humanGate]}</small></fieldset>; })}{codexReady ? null : <p className="fcp-control-note">Сохранение недоступно, пока Control Plane не подтвердит runtime Codex CLI.</p>}<button className="fcp-primary" disabled={!codexReady}>Сохранить неизменяемую версию</button></form><Notice value={notice}/></details>;
}

const contextSourceLabel: Readonly<Record<string,string>> = {
  'repo:agents':'AGENTS.md', 'repo:ai-context':'docs/AI_CONTEXT.md',
  'repo:adr-0006':'ADR 0006 · Lifecycle gates',
  'composition:project-process-policy':'ASCON process policy'
};
const contextTime = (value: string) => new Intl.DateTimeFormat('ru-RU', {day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',timeZone:'Europe/Moscow'}).format(new Date(value));

export function HermesContextControl({projectId, canManage, context}: Readonly<{
  projectId: string; canManage: boolean; context: ProjectContextStatusView|null;
}>) {
  const router = useRouter(); const [pending,setPending] = useState(false);
  const [outcome,setOutcome] = useState<Readonly<{tone:'success'|'error';text:string}>|null>(null);
  const snapshot = context?.snapshot ?? null; const size = snapshot === null ? 0 : new TextEncoder().encode(snapshot.content).byteLength;
  const status = outcome?.tone === 'error' ? 'Ошибка' : context === null ? 'Не настроен' : context.status === 'stale' ? 'Требуется обновление' : 'Актуален';
  const tone = outcome?.tone === 'error' ? 'error' : context?.status === 'current' ? 'success' : 'warning';
  const refresh = async () => { if (pending) return; setPending(true); setOutcome(null);
    try { const result = await post(`/api/projects/${projectId}/context/refresh`, {idempotencyKey:`project-context:${id()}`});
      setOutcome({tone:'success',text:result.status === 'duplicate'
        ? `Контекст уже актуален · sha256:${result.version?.slice(0,12) ?? 'подтверждён'}.`
        : `Контекст актуализирован · sha256:${result.version?.slice(0,12) ?? 'подтверждён'} активна для новых задач.`});
      router.refresh();
    } catch { setOutcome({tone:'error',text:'Не удалось актуализировать контекст. Активная версия сохранена; повторите после устранения ошибки источника.'}); }
    finally { setPending(false); }
  };
  return <section className="fcp-context-card"><header><div><strong>АКТИВНАЯ ВЕРСИЯ КОНТЕКСТА</strong><p>Canonical sources Control Plane · точная версия выдаётся исполнителю.</p></div><span className={`fcp-context-state ${tone}`}><i aria-hidden="true"/>{status}</span></header><dl className="fcp-context-facts"><div><dt>АКТИВНАЯ ВЕРСИЯ</dt><dd>{snapshot === null ? 'Не настроена' : `sha256:${snapshot.sha256.slice(0,8)}…${snapshot.sha256.slice(-4)}`}<small>{context?.status === 'stale' ? 'последняя версия сохранена' : 'активна для Hermes'}</small></dd></div><div><dt>ПОСЛЕДНЕЕ ОБНОВЛЕНИЕ</dt><dd>{snapshot === null ? 'Не настроено' : contextTime(snapshot.createdAt)}<small>{snapshot?.provenance.startsWith('control-plane:') ? 'МСК · owner command' : snapshot?.provenance ?? ''}</small></dd></div><div><dt>ИСТОЧНИКОВ</dt><dd>{context?.sources.length ?? 0}<small>canonical</small></dd></div><div><dt>РАЗМЕР КОНТЕКСТА</dt><dd>{size.toLocaleString('ru-RU')} / 4 000<small>байт</small></dd></div></dl><div className="fcp-context-sources-head"><span>Канонические источники</span><span>Доставка: Hermes</span></div><ul className="fcp-context-source-list" aria-label="Канонические источники контекста">{context?.sources.map((source) => <li key={source.key}><div><strong>{contextSourceLabel[source.key] ?? source.key}</strong><small>{source.provenance} · sha256:{source.version.slice(0,8)}…{source.version.slice(-4)}</small></div><span>Источник</span></li>) ?? <li><div><strong>Источники не настроены</strong><small>Сборка недоступна</small></div></li>}</ul><div className="fcp-context-application"><span>Применение контекста</span><p>Новые задачи получают точный контекст сразу. В активном чате он применяется со следующего сообщения — без сброса чата.</p></div><div className="fcp-context-action"><p>{canManage ? 'Владелец или оператор проекта может запустить сборку. Редактирование, история версий и сброс контекста не предусмотрены.' : 'Актуализация доступна владельцу или оператору проекта.'}</p>{canManage ? <button type="button" className="fcp-primary" disabled={pending} onClick={() => void refresh()}>{pending ? 'Актуализируем…' : 'Актуализировать контекст'}</button> : null}</div>{outcome === null ? null : <p className={`fcp-context-outcome ${outcome.tone}`} role="status">{outcome.tone === 'error' ? '! ' : ''}{outcome.text}</p>}</section>;
}

const editableExecutors = new Set(['manager_project_ops', 'architecture_design', 'critical_decision', 'release_preflight']);
const routingClassLabel: Record<AgentRoutingPolicy['routes'][number]['taskClass'], string> = {manager_project_ops:'Управление проектом',ordinary_implementation:'Обычная реализация',ui_responsive:'Интерфейс и адаптивность',complex_implementation:'Сложная реализация',qa_audit:'Проверка и аудит',architecture_design:'Архитектура и дизайн',critical_decision:'Критическое решение',release_preflight:'Предрелизная проверка',protected_operation:'Защищённая операция'};
const routingGateLabel: Record<AgentRoutingPolicy['routes'][number]['humanGate'], string> = {none:'контроль человека не требуется',product_visual:'нужно согласование UI/UX',architecture_decision:'нужно архитектурное решение',production_exact:'нужно точное production-подтверждение'};

export function ApprovalControl({projectId, taskId}: Readonly<{projectId: string; taskId: string | null}>) {
  const {notice, run} = useCommand();
  if (taskId === null) return <p className="fcp-control-note">Чтобы зафиксировать точное согласование, выберите карточку GitHub Project.</p>;
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = new FormData(event.currentTarget); void run(() => post(`/api/approvals/${id()}`, {projectId, targetReference: taskId, kind: form.get('kind'), decision: form.get('decision'), idempotencyKey: id()})); };
  return <details className="fcp-control"><summary>Зафиксировать согласование</summary><form onSubmit={submit}><label>Вид<select name="kind" defaultValue="acceptance"><option value="plan">План</option><option value="internal_operation">Внутренняя операция</option><option value="acceptance">Приёмка</option><option value="client_uat">Клиентское UAT</option></select></label><label>Решение<select name="decision"><option value="approved">Согласовано</option><option value="rejected">Отклонено</option></select></label><button className="fcp-primary">Зафиксировать точную версию</button></form><Notice value={notice}/></details>;
}

export function AccessControls({projectId, canManage, members}: Readonly<{projectId: string; canManage: boolean; members: readonly {membershipId: string; displayName: string; role: string}[]}>) {
  const {notice, run} = useCommand();
  if (!canManage) return <p className="fcp-control-note">Изменение состава доступно только project owner.</p>;
  const onboard = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = new FormData(event.currentTarget); const telegramUserId = empty(form.get('telegramUserId')); const bitrix24UserId = empty(form.get('bitrix24UserId')); void run(() => post('/api/access/onboarding', {projectId, displayName: form.get('displayName'), githubUserId: form.get('githubUserId'), role: form.get('role'), ...(telegramUserId === null ? {} : {telegramUserId}), ...(bitrix24UserId === null ? {} : {bitrix24UserId})})); };
  const membership = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = new FormData(event.currentTarget); const selected = members.find((member) => member.membershipId === form.get('membershipId')); if (selected !== undefined) void run(() => post(`/api/access/memberships/${selected.membershipId}`, {role: form.get('role'), active: form.get('active') === 'on'})); };
  return <section className="fcp-controls"><details className="fcp-control"><summary>Добавить участника</summary><form onSubmit={onboard}><label>Имя<input name="displayName" required maxLength={200}/></label><label>Роль<select name="role"><option value="operator">operator</option><option value="contributor">contributor</option><option value="client">client</option></select></label><label>GitHub numeric ID <input name="githubUserId" inputMode="numeric" pattern="[1-9][0-9]*"/></label><label>Telegram ID <input name="telegramUserId" inputMode="numeric"/></label><label>Bitrix24 ID <input name="bitrix24UserId"/></label><small>Для команды нужен GitHub ID; клиенту достаточно GitHub или Bitrix24. Доступ к чат-комнатам здесь не меняется.</small><button className="fcp-primary">Добавить</button></form></details><details className="fcp-control"><summary>Изменить членство</summary><form onSubmit={membership}><label>Участник<select name="membershipId">{members.map((member) => <option key={member.membershipId} value={member.membershipId}>{member.displayName} · {member.role}</option>)}</select></label><label>Новая роль<select name="role" defaultValue="" required><option value="" disabled>Выберите роль</option><option value="project_owner">project owner</option><option value="operator">operator</option><option value="contributor">contributor</option><option value="client">client</option></select></label><label className="fcp-check"><input name="active" type="checkbox" defaultChecked/> Активен</label><button className="fcp-primary">Сохранить доступ</button></form></details><Notice value={notice}/></section>;
}

type AssignableUser = Readonly<{id: string; login: string; name: string|null}>;
type ConfirmedRun = Readonly<{deliveryReference: string; occurredAt: string}>;
export function TaskExecutorControl({projectId, task, currentExecutor, confirmedRun}: Readonly<{projectId: string; currentExecutor: string; confirmedRun: ConfirmedRun|null; task: {itemId: string; status: string|null; blocked: boolean|null}}>) {
  const [users, setUsers] = useState<readonly AssignableUser[]|null>(null); const [selected, setSelected] = useState('');
  const [confirming, setConfirming] = useState(false); const [notice, setNotice] = useState<string|null>(null); const [pending, setPending] = useState(false);
  const [noticeTone, setNoticeTone] = useState<'success'|'error'|null>(null);
  const confirmRef = useRef<HTMLDivElement>(null); const actionRef = useRef<HTMLButtonElement>(null); const router = useRouter();
  useEffect(() => { let active = true; void fetch(`/api/tasks/executor?projectId=${encodeURIComponent(projectId)}`).then(async (response) => {
    const value = await response.json().catch(() => ({})) as {users?: AssignableUser[]; error?: string}; if (!response.ok) throw new Error(value.error ?? 'provider_error');
    if (active) setUsers(value.users ?? []);
  }).catch(() => { if (active) { setNoticeTone('error'); setNotice('GitHub не подтвердил список доступных пользователей. Обновите задачу.'); } }); return () => { active = false; }; }, [projectId]);
  const choice = selected === 'hermes' ? 'hermes' : users?.find((user) => `human:${user.id}` === selected);
  const human = choice !== undefined && choice !== 'hermes' ? choice : null;
  const activeRun = currentExecutor === 'Hermes' ? confirmedRun : null;
  const unavailable = task.blocked === true || task.status === null || ['Backlog', 'Blocked', 'Done'].includes(task.status);
  const effects = human === null ? task.status === 'Ready' ? 'GitHub: Owner станет Hermes, Assignee очистится; Hermes получит явную команду, статус перейдёт в In Dev.' : `GitHub: Owner станет Hermes, Assignee очистится; Hermes получит явную команду, статус ${task.status} сохранится.` : `GitHub: Assignee станет @${human.login}, Owner очистится${task.status === 'Ready' ? ', статус перейдёт в In Dev' : `; статус ${task.status} сохранится`}; уведомление человеку не отправляется.`;
  useEffect(() => { if (confirming) requestAnimationFrame(() => confirmRef.current?.focus()); }, [confirming]);
  const execute = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); if (pending || choice === undefined) return; setPending(true); setNotice(null); setNoticeTone(null);
    try { const result = await post('/api/tasks/executor', {projectId, projectItemId: task.itemId, executor: human === null ? {kind: 'hermes'} : {kind: 'human', candidate: {id: human.id, login: human.login}}}); setConfirming(false); setNoticeTone('success');
      setNotice(result.status === 'status_sync_failed' ? 'Команда принята Hermes, но GitHub ещё не подтвердил In Dev. Повторная доставка заблокирована квитанцией.' : result.status === 'duplicate' ? 'Запуск уже был подтверждён: повторная команда Hermes не отправлена.' : human === null ? 'Запуск подтверждён: Hermes принял команду.' : 'Исполнитель назначен в GitHub.'); router.refresh();
    } catch (error) { const code = error instanceof Error ? error.message : 'request_failed'; if (code === 'assignment_partial') router.refresh(); setNoticeTone('error'); setNotice(code === 'task_conflict' ? 'Команда не выполнена: задача уже изменилась в GitHub. Обновите страницу и проверьте исполнителя.' : code === 'candidate_unavailable' ? 'Команда не выполнена: пользователь больше не доступен. Выберите другого.' : code === 'operation_unavailable' ? 'Команда не выполнена: назначение недоступно для текущей стадии или конфигурации.' : code === 'assignment_partial' ? 'GitHub применил операцию частично. Не повторяйте команду до проверки исполнителя и статуса.' : code === 'delivery_failed' ? 'GitHub назначил Hermes, но запуск не подтверждён. Не повторяйте команду до проверки квитанции.' : code === 'provider_error' ? 'Запуск не подтверждён: GitHub или Hermes не ответил. Не повторяйте команду до проверки квитанции.' : 'Команда не подтверждена. Обновите задачу и проверьте её состояние перед повтором.');
    } finally { setPending(false); }
  };
  if (unavailable) return <section className="fcp-task-executor"><header><div><h2>Исполнитель</h2><p>Назначение доступно после Ready и до Done.</p></div></header><p className="fcp-control-note">Для текущего статуса GitHub Project назначение недоступно.</p></section>;
  const form = <form onSubmit={(event) => void execute(event)}><label>Кому назначить<select value={selected} onChange={(event) => { setSelected(event.target.value); setConfirming(false); }} disabled={pending}><option value="">{users === null ? 'Загружаем пользователей GitHub…' : 'Выберите исполнителя'}</option><optgroup label="Люди">{users?.map((user) => <option key={user.id} value={`human:${user.id}`}>{user.name === null ? `@${user.login}` : `${user.name} · @${user.login}`}</option>)}</optgroup>{task.status === 'Acceptance' || activeRun !== null ? null : <optgroup label="Агенты"><option value="hermes">Hermes</option></optgroup>}</select></label>{confirming ? <div className="fcp-task-confirm" role="status" tabIndex={-1} ref={confirmRef}><strong>{human === null ? 'Hermes' : `${human.name ?? human.login} · @${human.login}`}</strong><p>{effects}</p>{human === null ? <small>Hermes delivery — явная внешняя операция; merge, release, deploy и production недоступны.</small> : null}<div><button className="fcp-primary" disabled={pending}>{pending ? 'Сохраняем…' : 'Подтвердить и начать'}</button><button type="button" onClick={() => { setConfirming(false); actionRef.current?.focus(); }} disabled={pending}>Отмена</button></div></div> : <button type="button" className="fcp-primary" ref={actionRef} disabled={pending || choice === undefined} onClick={() => setConfirming(true)}>{activeRun === null ? 'Назначить и начать' : 'Подтвердить смену исполнителя'}</button>}</form>;
  return <section className="fcp-task-executor"><header><div><h2>Исполнитель</h2><p>GitHub остаётся источником назначения и статуса.</p></div><span>{currentExecutor}</span></header>{activeRun === null ? form : <><div className="fcp-task-outcome" role="status"><strong>Запуск Hermes подтверждён</strong><p>Hermes принял команду. Текущий этап GitHub Project: {task.status ?? 'не подтверждён'}.</p><small>Квитанция {activeRun.deliveryReference} · {new Intl.DateTimeFormat('ru-RU', {day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',timeZone:'Europe/Moscow'}).format(new Date(activeRun.occurredAt))}</small></div><details className="fcp-task-reassign"><summary>Сменить исполнителя</summary>{form}</details></>}<Notice value={notice} tone={noticeTone}/></section>;
}

function empty(value: FormDataEntryValue | null): string | null { return typeof value === 'string' && value.trim().length > 0 ? value : null; }
function Notice({value, tone}: Readonly<{value: string | null; tone?: 'success'|'error'|null}>) { return value === null ? null : <p className={`fcp-command-notice${tone === null || tone === undefined ? '' : ` ${tone}`}`} role="status">{value}</p>; }
