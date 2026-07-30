'use client';

import {useState} from 'react';
import {Power, PowerOff} from 'lucide-react';

type RegistrationResponse = Readonly<{
  message?: string;
  receipt?: Readonly<{commandId: string; commandType: string}>;
}>;

export function RuntimeRegistrationControls({
  agentId,
  canManage,
  csrfToken,
  enabled,
  expectedVersion,
  projectId,
  projectName,
  registrationId
}: Readonly<{
  agentId: string;
  canManage: boolean;
  csrfToken: string | null;
  enabled: boolean;
  expectedVersion: number;
  projectId: string;
  projectName: string;
  registrationId: string;
}>) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Readonly<{
    tone: 'success' | 'error';
    text: string;
  }> | null>(null);
  if (!canManage || csrfToken === null) return null;

  const action = enabled ? 'disable' : 'enable';
  const submit = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/runtime-registrations/${encodeURIComponent(registrationId)}/state`,
        {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify({
            _csrf: csrfToken,
            action,
            agentId,
            expectedVersion,
            projectId
          })
        }
      );
      const result = await response.json().catch(() => ({})) as RegistrationResponse;
      if (!response.ok || result.receipt === undefined) {
        setNotice({
          tone: 'error',
          text: result.message ?? 'Registration state was not changed.'
        });
        return;
      }
      setNotice({
        tone: 'success',
        text: `${enabled ? 'Disabled' : 'Enabled'} · receipt ${result.receipt.commandId.slice(0, 8)}`
      });
      window.setTimeout(() => window.location.reload(), 450);
    } catch {
      setNotice({tone: 'error', text: 'Registration control is unavailable.'});
    } finally {
      setBusy(false);
    }
  };

  const Icon = enabled ? PowerOff : Power;
  return <div className="fcp-registration-control">
    <button
      aria-label={`${enabled ? 'Disable' : 'Enable'} ${projectName} runtime registration for new claims`}
      disabled={busy}
      onClick={() => void submit()}
      type="button"
    >
      <Icon aria-hidden="true" size={15}/>
      {busy ? 'Saving…' : enabled ? 'Disable' : 'Enable'}
    </button>
    <small>{enabled ? 'Stops new claims' : 'Allows new claims'}</small>
    {notice === null ? null : <p
      aria-live="polite"
      className={`fcp-command-notice ${notice.tone}`}
    >{notice.text}</p>}
  </div>;
}
