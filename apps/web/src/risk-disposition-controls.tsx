'use client';

import {useState, type FormEvent} from 'react';
import {Clock3, Eye, RotateCcw} from 'lucide-react';

type Disposition = Readonly<{
  kind: 'acknowledged' | 'snoozed';
  reason: 'investigating' | 'awaiting_evidence' | 'planned_maintenance' | 'external_dependency';
  expiresAt: Date;
  reentryCondition: 'risk_unresolved_at_expiry';
  version: number;
}> | null;

const durations = [
  {label: '4 часа', milliseconds: 4 * 60 * 60 * 1_000},
  {label: '1 день', milliseconds: 24 * 60 * 60 * 1_000},
  {label: '7 дней', milliseconds: 7 * 24 * 60 * 60 * 1_000}
] as const;
const reasons = [
  {value: 'investigating', label: 'Разбираемся'},
  {value: 'awaiting_evidence', label: 'Ждём подтверждение'},
  {value: 'planned_maintenance', label: 'Плановые работы'},
  {value: 'external_dependency', label: 'Внешняя зависимость'}
] as const;

export function RiskDispositionControls({
  csrfToken,
  disposition,
  expectedVersion,
  projectId,
  riskSignalId
}: Readonly<{
  csrfToken: string | null;
  disposition: Disposition;
  expectedVersion: number;
  projectId: string;
  riskSignalId: string;
}>) {
  const [action, setAction] =
    useState<'acknowledged' | 'snoozed' | null>(null);
  const [reason, setReason] =
    useState<(typeof reasons)[number]['value']>('investigating');
  const [duration, setDuration] = useState<number>(durations[0].milliseconds);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  if (csrfToken === null && disposition === null) return null;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (action === null || csrfToken === null) return;
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/risk-signals/${encodeURIComponent(riskSignalId)}/disposition`,
        {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            _csrf: csrfToken,
            action,
            commandId: crypto.randomUUID(),
            expectedVersion,
            expiresAt: new Date(Date.now() + duration).toISOString(),
            projectId,
            reason
          })
        }
      );
      if (!response.ok) {
        setMessage(response.status === 409
          ? 'Состояние риска изменилось. Обновите страницу и повторите.'
          : 'Решение по риску не сохранено.');
        return;
      }
      setAction(null);
      setReason('investigating');
      window.location.reload();
    } catch {
      setMessage('Решение по риску не сохранено.');
    } finally {
      setPending(false);
    }
  };

  return <div className="fcp-risk-disposition">
    {disposition === null ? null : <details>
      <summary>
        <Eye aria-hidden="true" size={14}/>
        Учтено до {new Date(disposition.expiresAt).toLocaleString('ru-RU')}
      </summary>
      <p>{reasons.find(({value}) => value === disposition.reason)?.label}</p>
      <small><RotateCcw aria-hidden="true" size={13}/>Вернётся в активные риски, если причина не устранена.</small>
    </details>}
    {csrfToken === null ? null : <div className="fcp-risk-actions" aria-label="Решение по риску">
      <button
        aria-label="Зафиксировать риск"
        disabled={pending}
        onClick={() => setAction(action === 'acknowledged' ? null : 'acknowledged')}
        type="button"
      ><Eye aria-hidden="true" size={15}/>Учесть</button>
      <button
        aria-label="Отложить риск"
        disabled={pending}
        onClick={() => setAction(action === 'snoozed' ? null : 'snoozed')}
        type="button"
      ><Clock3 aria-hidden="true" size={15}/>Отложить</button>
    </div>}
    {action === null ? null : <form onSubmit={submit}>
      <label>
        <span className="sr-only">Причина</span>
        <select
          aria-label="Причина решения по риску"
          autoFocus
          disabled={pending}
          onChange={(event) =>
            setReason(event.target.value as (typeof reasons)[number]['value'])}
          value={reason}
        >
          {reasons.map((item) =>
            <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>
      </label>
      <label>
        <span className="sr-only">Срок</span>
        <select
          aria-label="Срок решения по риску"
          disabled={pending}
          onChange={(event) => setDuration(Number(event.target.value))}
          value={duration}
        >
          {durations.map((item) =>
            <option key={item.milliseconds} value={item.milliseconds}>
              {item.label}
            </option>)}
        </select>
      </label>
      <button disabled={pending} type="submit">
        {pending ? 'Сохраняем…' : action === 'snoozed' ? 'Отложить' : 'Подтвердить'}
      </button>
      <small><RotateCcw aria-hidden="true" size={13}/>Риск вернётся автоматически, если останется открытым.</small>
    </form>}
    {message === null ? null : <p aria-live="polite">{message}</p>}
  </div>;
}
