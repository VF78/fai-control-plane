'use client';

import {useState, type FormEvent} from 'react';
import {Clock3, Eye, RotateCcw} from 'lucide-react';

type Disposition = Readonly<{
  kind: 'acknowledged' | 'snoozed';
  reason: 'investigating' | 'awaiting_evidence' | 'planned_maintenance' | 'external_dependency';
  expiresAt: string;
  reentryCondition: 'risk_unresolved_at_expiry';
  version: number;
}> | null;

const durations = [
  {label: '4 hours', milliseconds: 4 * 60 * 60 * 1_000},
  {label: '1 day', milliseconds: 24 * 60 * 60 * 1_000},
  {label: '7 days', milliseconds: 7 * 24 * 60 * 60 * 1_000}
] as const;
const reasons = [
  {value: 'investigating', label: 'Investigating'},
  {value: 'awaiting_evidence', label: 'Awaiting evidence'},
  {value: 'planned_maintenance', label: 'Planned maintenance'},
  {value: 'external_dependency', label: 'External dependency'}
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
          ? 'Disposition changed. Refresh and retry.'
          : 'Disposition was not recorded.');
        return;
      }
      setAction(null);
      setReason('investigating');
      window.location.reload();
    } catch {
      setMessage('Disposition was not recorded.');
    } finally {
      setPending(false);
    }
  };

  return <div className="fcp-risk-disposition">
    {disposition === null ? null : <details>
      <summary>
        <Eye aria-hidden="true" size={14}/>
        Acknowledged until {new Date(disposition.expiresAt).toLocaleString()}
      </summary>
      <p>{reasons.find(({value}) => value === disposition.reason)?.label}</p>
      <small><RotateCcw aria-hidden="true" size={13}/>Returns to active attention if unresolved at expiry.</small>
    </details>}
    {csrfToken === null ? null : <div className="fcp-risk-actions" aria-label="Risk disposition">
      <button
        aria-label="Acknowledge risk"
        disabled={pending}
        onClick={() => setAction(action === 'acknowledged' ? null : 'acknowledged')}
        type="button"
      ><Eye aria-hidden="true" size={15}/>Acknowledge</button>
      <button
        aria-label="Snooze risk"
        disabled={pending}
        onClick={() => setAction(action === 'snoozed' ? null : 'snoozed')}
        type="button"
      ><Clock3 aria-hidden="true" size={15}/>Snooze</button>
    </div>}
    {action === null ? null : <form onSubmit={submit}>
      <label>
        <span className="sr-only">Reason</span>
        <select
          aria-label="Disposition reason"
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
        <span className="sr-only">Expiry</span>
        <select
          aria-label="Disposition expiry"
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
        {pending ? 'Saving…' : action === 'snoozed' ? 'Snooze' : 'Confirm'}
      </button>
      <small><RotateCcw aria-hidden="true" size={13}/>Returns if unresolved at expiry.</small>
    </form>}
    {message === null ? null : <p aria-live="polite">{message}</p>}
  </div>;
}
