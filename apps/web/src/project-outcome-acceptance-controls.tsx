'use client';

import {useState} from 'react';
import {BadgeCheck} from 'lucide-react';

export function ProjectOutcomeAcceptanceControls({
  projectId,
  baselineId,
  outcomeId,
  expectedExecutionVersion,
  weight,
  csrfToken,
  enabled
}: Readonly<{
  projectId: string;
  baselineId: string;
  outcomeId: string;
  expectedExecutionVersion: number;
  weight: number;
  csrfToken: string | null;
  enabled: boolean;
}>) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  if (!enabled || csrfToken === null || expectedExecutionVersion < 1) return null;
  const accept = async () => {
    setBusy(true); setNotice(null);
    try {
      const response = await fetch('/api/project-outcomes/accept', {
        method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify({_csrf: csrfToken, projectId, baselineId, outcomeId,
          expectedExecutionVersion})
      });
      const value = await response.json().catch(() => ({})) as {status?: string; message?: string};
      if (!response.ok) throw new Error(value.message ?? value.status ?? 'Результат не принят.');
      setNotice('Результат принят. Weighted scope и audit обновлены; загружаем факты…');
      window.setTimeout(() => window.location.reload(), 400);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Команда недоступна.');
    } finally { setBusy(false); }
  };
  return <div className="fcp-outcome-acceptance">
    <button className="fcp-primary-button" disabled={busy} onClick={() => void accept()}>
      <BadgeCheck aria-hidden="true" size={15}/>Принять результат · +{weight}
    </button>
    {notice === null ? null : <small className="fcp-command-notice">{notice}</small>}
  </div>;
}
