'use client';

import {useState} from 'react';
import {Power, PowerOff, Replace as ReplaceIcon, RotateCcw} from 'lucide-react';

type RegistrationResponse = Readonly<{
  message?: string;
  receipt?: Readonly<{commandId: string; commandType: string}>;
}>;

export function RuntimeRegistrationControls({
  agentId,
  agentProfileId,
  canManage,
  csrfToken,
  enabled,
  expectedVersion,
  projectId,
  projectName,
  registrationId,
  replacementTargets,
  staleRun
}: Readonly<{
  agentId: string;
  agentProfileId: string;
  canManage: boolean;
  csrfToken: string | null;
  enabled: boolean;
  expectedVersion: number;
  projectId: string;
  projectName: string;
  registrationId: string;
  replacementTargets: readonly Readonly<{
    id: string;
    version: number;
    label: string;
  }>[];
  staleRun: Readonly<{id: string; version: number}> | null;
}>) {
  const [busy, setBusy] = useState(false);
  const [replacementTargetId, setReplacementTargetId] = useState(
    replacementTargets[0]?.id ?? ''
  );
  const [notice, setNotice] = useState<Readonly<{
    tone: 'success' | 'error';
    text: string;
  }> | null>(null);
  if (!canManage || csrfToken === null) return null;

  const submit = async (action: 'enable' | 'disable' | 'recover' | 'replace') => {
    if (action === 'recover' && staleRun === null) return;
    const replacementTarget = replacementTargets.find(
      (target) => target.id === replacementTargetId
    );
    if (action === 'replace' && replacementTarget === undefined) return;
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
            ...(action === 'replace'
              ? {
                  targetExpectedVersion: replacementTarget?.version,
                  targetRegistrationId: replacementTarget?.id
                }
              : {agentId}),
            ...(action === 'recover'
              ? {
                  agentProfileId,
                  expectedRunVersion: staleRun?.version,
                  runId: staleRun?.id
                }
              : {}),
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
        text: `${action === 'recover' ? 'Recovery' : action === 'replace' ? 'Replacement' : action === 'disable' ? 'Disabled' : 'Enabled'} · receipt ${result.receipt.commandId.slice(0, 8)}`
      });
      window.setTimeout(() => window.location.reload(), 450);
    } catch {
      setNotice({tone: 'error', text: 'Registration control is unavailable.'});
    } finally {
      setBusy(false);
    }
  };

  return <div className="fcp-registration-control">
    <button
      aria-label={`${enabled ? 'Disable' : 'Enable'} ${projectName} runtime registration for new claims`}
      disabled={busy}
      onClick={() => void submit(enabled ? 'disable' : 'enable')}
      type="button"
    >
      {enabled ? <PowerOff aria-hidden="true" size={15}/> : <Power aria-hidden="true" size={15}/>}
      {busy ? 'Saving…' : enabled ? 'Disable' : 'Enable'}
    </button>
    <small>{enabled ? 'Stops new claims' : 'Allows new claims'}</small>
    {!enabled || staleRun === null ? null : <button
      aria-label={`Recover ${projectName} stale runtime registration for new claims`}
      disabled={busy}
      onClick={() => void submit('recover')}
      type="button"
    >
      <RotateCcw aria-hidden="true" size={15}/>
      {busy ? 'Saving…' : 'Recover'}
    </button>}
    {!enabled || staleRun === null ? null : <small>Ends expired lease · preserves history</small>}
    {!enabled ? null : replacementTargets.length === 0
      ? <small>Replacement not available</small>
      : <>
          <label>
            <span className="fcp-sr-only">Replacement target for {projectName}</span>
            <select
              aria-label={`Replacement target for ${projectName}`}
              disabled={busy}
              onChange={(event) => setReplacementTargetId(event.target.value)}
              value={replacementTargetId}
            >
              {replacementTargets.map((target) =>
                <option key={target.id} value={target.id}>{target.label}</option>)}
            </select>
          </label>
          <button
            aria-label={`Replace ${projectName} runtime registration`}
            disabled={busy}
            onClick={() => void submit('replace')}
            type="button"
          >
            <ReplaceIcon aria-hidden="true" size={15}/>
            {busy ? 'Saving…' : 'Replace'}
          </button>
          <small>Atomic switch · preserves history</small>
        </>}
    {notice === null ? null : <p
      aria-live="polite"
      className={`fcp-command-notice ${notice.tone}`}
    >{notice.text}</p>}
  </div>;
}
