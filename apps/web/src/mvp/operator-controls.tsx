'use client';

import {useState, type FormEvent} from 'react';
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

export function AgentSubmitControlClient({projectId, tasks, sources}: Readonly<{
  projectId: string; tasks: readonly {itemId: string; issueId: string; title: string}[];
  sources: readonly {id: string; name: string; kind: string}[];
}>) {
  const [notice, setNotice] = useState<string | null>(null); const [pending, setPending] = useState(false); const router = useRouter();
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setPending(true); setNotice(null); const form = new FormData(event.currentTarget);
    const lines = (name: string) => String(form.get(name) ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    try {
      const result = await post('/api/agents/submit', {projectId, projectItemId: form.get('projectItemId'), role: form.get('role'),
        sourceIds: form.getAll('sourceIds'), constraints: lines('constraints'), acceptanceCriteria: lines('acceptanceCriteria')});
      router.refresh();
      setNotice(result.status === 'duplicate' ? 'Дубликат: эта точная команда уже была передана Hermes.'
        : 'Команда принята: Hermes начал внешнюю работу. Receipt и audit зафиксированы.');
    } catch (error) { const code = error instanceof Error ? error.message : 'request_failed'; setNotice(code.endsWith('_denied')
      ? 'Отказано: нужны активное членство и роль project owner или operator.' : code === 'agent_source_payload_too_large'
        ? 'Выбранные источники превышают 64 KiB. Выберите меньше источников или сократите их текст.' : code === 'provider_error'
        ? 'Ошибка провайдера: Hermes или GitHub не подтвердил операцию.' : `Команда не отправлена: ${code}`);
    } finally { setPending(false); }
  };
  if (tasks.length === 0) return <p className="fcp-control-note">Для явной команды нужна не-Done задача свежего GitHub Project snapshot с Owner = Hermes.</p>;
  return <details className="fcp-control fcp-agent-submit"><summary>Передать роль Hermes</summary><p className="fcp-warning"><b>Внимание:</b> отправка сразу запускает внешнюю работу Hermes. Это не меняет статус задачи, не публикует, не развёртывает и не даёт production-доступ.</p><form onSubmit={(event) => void submit(event)}><label>Задача GitHub Project<select name="projectItemId" required>{tasks.map((task) => <option key={task.itemId} value={task.itemId}>#{task.issueId} · {task.title}</option>)}</select></label><label>Роль<select name="role" defaultValue="developer"><option value="manager">manager</option><option value="developer">developer</option><option value="qa">qa</option></select></label><label>Ограничения — по одному на строку<textarea name="constraints" required maxLength={8000}/></label><label>Критерии приёмки — по одному на строку<textarea name="acceptanceCriteria" required maxLength={8000}/></label>{sources.length === 0 ? <p className="fcp-control-note">Без дополнительных Control Plane sources.</p> : <fieldset><legend>Передать выбранный текст Hermes (всего до 64 KiB)</legend>{sources.map((source) => <label className="fcp-check" key={source.id}><input type="checkbox" name="sourceIds" value={source.id}/>{source.name} · {source.kind}</label>)}</fieldset>}<label className="fcp-check fcp-confirm"><input type="checkbox" required/> Я понимаю, что это явный внешний запуск Hermes</label><button className="fcp-primary" disabled={pending}>{pending ? 'Передача…' : 'Запустить Hermes'}</button></form><Notice value={notice}/></details>;
}

function empty(value: FormDataEntryValue | null): string | null { return typeof value === 'string' && value.trim().length > 0 ? value : null; }
function Notice({value}: Readonly<{value: string | null}>) { return value === null ? null : <p className="fcp-command-notice" role="status">{value}</p>; }
