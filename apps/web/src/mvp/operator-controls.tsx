'use client';

import {useEffect, useRef, useState, type FormEvent} from 'react';
import {useRouter} from 'next/navigation';

type Result = {error?: string; status?: string};
const post = async (path: string, body: Record<string, unknown>): Promise<Result> => {
  const response = await fetch(path, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
  const value = await response.json().catch(() => ({})) as Result;
  if (!response.ok) throw new Error(value.error ?? 'request_failed');
  return value;
};
const useCommand = () => {
  const [notice, setNotice] = useState<string | null>(null);
  const router = useRouter();
  return {notice, run: async (request: () => Promise<Result>) => { try { const result = await request(); router.refresh(); setNotice(result.status ?? 'Сохранено'); } catch (error) { setNotice(error instanceof Error ? error.message : 'request_failed'); } }};
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
export function TaskExecutorControl({projectId, task, currentExecutor}: Readonly<{projectId: string; currentExecutor: string; task: {itemId: string; status: string|null; blocked: boolean|null}}>) {
  const [users, setUsers] = useState<readonly AssignableUser[]|null>(null); const [selected, setSelected] = useState('');
  const [confirming, setConfirming] = useState(false); const [notice, setNotice] = useState<string|null>(null); const [pending, setPending] = useState(false);
  const confirmRef = useRef<HTMLDivElement>(null); const actionRef = useRef<HTMLButtonElement>(null); const router = useRouter();
  useEffect(() => { let active = true; void fetch(`/api/tasks/executor?projectId=${encodeURIComponent(projectId)}`).then(async (response) => {
    const value = await response.json().catch(() => ({})) as {users?: AssignableUser[]; error?: string}; if (!response.ok) throw new Error(value.error ?? 'provider_error');
    if (active) setUsers(value.users ?? []);
  }).catch(() => { if (active) setNotice('GitHub не подтвердил список доступных пользователей. Обновите задачу.'); }); return () => { active = false; }; }, [projectId]);
  const choice = selected === 'hermes' ? 'hermes' : users?.find((user) => `human:${user.id}` === selected);
  const human = choice !== undefined && choice !== 'hermes' ? choice : null;
  const unavailable = task.blocked === true || task.status === null || ['Backlog', 'Blocked', 'Done'].includes(task.status);
  const effects = human === null ? task.status === 'Ready' ? 'GitHub: Owner станет Hermes, Assignee очистится; Hermes получит явную команду, статус перейдёт в In Dev.' : `GitHub: Owner станет Hermes, Assignee очистится; Hermes получит явную команду, статус ${task.status} сохранится.` : `GitHub: Assignee станет @${human.login}, Owner очистится${task.status === 'Ready' ? ', статус перейдёт в In Dev' : `; статус ${task.status} сохранится`}; уведомление человеку не отправляется.`;
  useEffect(() => { if (confirming) requestAnimationFrame(() => confirmRef.current?.focus()); }, [confirming]);
  const execute = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); if (pending || choice === undefined) return; setPending(true); setNotice(null);
    try { const result = await post('/api/tasks/executor', {projectId, projectItemId: task.itemId, executor: human === null ? {kind: 'hermes'} : {kind: 'human', candidate: {id: human.id, login: human.login}}}); router.refresh(); setConfirming(false);
      setNotice(result.status === 'status_sync_failed' ? 'Hermes получил команду, но GitHub не подтвердил In Dev. Повторите: вторая отправка не произойдёт.' : result.status === 'duplicate' ? 'Повтор подтверждён: Hermes уже получил эту точную команду.' : human === null ? 'Hermes назначен. GitHub и доставка подтверждены.' : 'Исполнитель назначен в GitHub.');
    } catch (error) { const code = error instanceof Error ? error.message : 'request_failed'; if (code === 'assignment_partial') router.refresh(); setNotice(code === 'task_conflict' ? 'Задача уже изменилась в GitHub. Обновите страницу и проверьте исполнителя.' : code === 'candidate_unavailable' ? 'Пользователь больше не доступен для назначения. Выберите другого.' : code === 'operation_unavailable' ? 'Назначение недоступно для текущей стадии или конфигурации.' : code === 'assignment_partial' ? 'GitHub применил операцию только частично. Данные обновлены — проверьте исполнителя и статус перед повтором.' : code === 'delivery_failed' ? 'Hermes назначен в GitHub, но запуск не подтверждён. Повторите запуск из этой задачи.' : code === 'provider_error' ? 'GitHub или Hermes недоступен. Повторите позже.' : 'Не удалось сохранить назначение. Обновите задачу и повторите.');
    } finally { setPending(false); }
  };
  if (unavailable) return <section className="fcp-task-executor"><header><div><h2>Исполнитель</h2><p>Назначение доступно после Ready и до Done.</p></div></header><p className="fcp-control-note">Для текущего статуса GitHub Project назначение недоступно.</p></section>;
  return <section className="fcp-task-executor"><header><div><h2>Исполнитель</h2><p>GitHub остаётся источником назначения и статуса.</p></div><span>{currentExecutor}</span></header><form onSubmit={(event) => void execute(event)}><label>Кому назначить<select value={selected} onChange={(event) => { setSelected(event.target.value); setConfirming(false); }} disabled={pending}><option value="">{users === null ? 'Загружаем пользователей GitHub…' : 'Выберите исполнителя'}</option><optgroup label="Люди">{users?.map((user) => <option key={user.id} value={`human:${user.id}`}>{user.name === null ? `@${user.login}` : `${user.name} · @${user.login}`}</option>)}</optgroup>{task.status === 'Acceptance' ? null : <optgroup label="Агенты"><option value="hermes">Hermes</option></optgroup>}</select></label>{confirming ? <div className="fcp-task-confirm" role="status" tabIndex={-1} ref={confirmRef}><strong>{human === null ? 'Hermes' : `${human.name ?? human.login} · @${human.login}`}</strong><p>{effects}</p>{human === null ? <small>Hermes delivery — явная внешняя операция; merge, release, deploy и production недоступны.</small> : null}<div><button className="fcp-primary" disabled={pending}>{pending ? 'Сохраняем…' : 'Подтвердить и начать'}</button><button type="button" onClick={() => { setConfirming(false); actionRef.current?.focus(); }} disabled={pending}>Отмена</button></div></div> : <button type="button" className="fcp-primary" ref={actionRef} disabled={pending || choice === undefined} onClick={() => setConfirming(true)}>Назначить и начать</button>}</form><Notice value={notice}/></section>;
}

function empty(value: FormDataEntryValue | null): string | null { return typeof value === 'string' && value.trim().length > 0 ? value : null; }
function Notice({value}: Readonly<{value: string | null}>) { return value === null ? null : <p className="fcp-command-notice" role="status">{value}</p>; }
