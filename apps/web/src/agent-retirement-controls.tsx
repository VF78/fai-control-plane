'use client';

import {useState} from 'react';
import {UserX, X} from 'lucide-react';

export function AgentRetirementControls({
  agentId,
  agentName,
  canRetire,
  csrfToken
}: Readonly<{
  agentId: string;
  agentName: string;
  canRetire: boolean;
  csrfToken: string | null;
}>) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!canRetire || csrfToken === null) return null;

  const retire = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/agents/${encodeURIComponent(agentId)}/retire`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({_csrf: csrfToken})
      });
      const result = await response.json().catch(() => ({})) as {message?: string};
      if (!response.ok) {
        setError(result.message ?? 'Агент не выведен из эксплуатации.');
        return;
      }
      window.location.reload();
    } catch {
      setError('Вывод агента из эксплуатации недоступен.');
    } finally {
      setBusy(false);
    }
  };

  return <div className="fcp-retirement-control">
    {!confirming
      ? <button
          aria-label={`Вывести из эксплуатации ${agentName}`}
          onClick={() => setConfirming(true)}
          type="button"
        ><UserX aria-hidden="true" size={15}/>Вывести из эксплуатации</button>
      : <div role="group" aria-label={`Подтвердить вывод ${agentName} из эксплуатации`}>
          <span>Вывести агента из эксплуатации?</span>
          <button
            aria-label={`Подтвердить вывод ${agentName} из эксплуатации`}
            disabled={busy}
            onClick={() => void retire()}
            type="button"
          ><UserX aria-hidden="true" size={15}/>{busy ? 'Выполняется…' : 'Подтвердить'}</button>
          <button
            aria-label="Отменить вывод из эксплуатации"
            disabled={busy}
            onClick={() => setConfirming(false)}
            type="button"
          ><X aria-hidden="true" size={15}/>Отмена</button>
        </div>}
    {error === null ? null : <p aria-live="polite" className="fcp-command-notice error">{error}</p>}
  </div>;
}
