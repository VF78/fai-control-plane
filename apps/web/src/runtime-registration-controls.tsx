'use client';

import {useState} from 'react';
import {Power, PowerOff, Replace as ReplaceIcon, RotateCcw, ShieldCheck} from 'lucide-react';

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
  recoveryPolicy,
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
  recoveryPolicy: Readonly<{
    enabled: boolean;
    staleThresholdSeconds: number;
    maximumAttempts: number;
    version: number;
  }> | null;
  staleRun: Readonly<{id: string; version: number}> | null;
}>) {
  const [busy, setBusy] = useState(false);
  const [replacementTargetId, setReplacementTargetId] = useState(
    replacementTargets[0]?.id ?? ''
  );
  const [recoveryEnabled, setRecoveryEnabled] = useState(recoveryPolicy?.enabled ?? false);
  const [staleThresholdSeconds, setStaleThresholdSeconds] = useState(recoveryPolicy?.staleThresholdSeconds ?? 900);
  const [maximumAttempts, setMaximumAttempts] = useState(recoveryPolicy?.maximumAttempts ?? 1);
  const [notice, setNotice] = useState<Readonly<{
    tone: 'success' | 'error';
    text: string;
  }> | null>(null);
  if (!canManage || csrfToken === null) return null;

  const submit = async (action: 'enable' | 'disable' | 'recover' | 'replace' | 'set_recovery_policy') => {
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
            ...(action === 'set_recovery_policy'
              ? {
                  enabled: recoveryEnabled,
                  expectedVersion: recoveryPolicy?.version ?? null,
                  maximumAttempts,
                  staleThresholdSeconds
                }
              : action === 'replace'
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
            ...(action === 'set_recovery_policy' ? {} : {expectedVersion}),
            projectId
          })
        }
      );
      const result = await response.json().catch(() => ({})) as RegistrationResponse;
      if (!response.ok || result.receipt === undefined) {
        setNotice({
          tone: 'error',
          text: result.message ?? 'Состояние привязки не изменено.'
        });
        return;
      }
      setNotice({
        tone: 'success',
        text: `${action === 'set_recovery_policy' ? 'Политика сохранена' : action === 'recover' ? 'Восстановлено' : action === 'replace' ? 'Заменено' : action === 'disable' ? 'Отключено' : 'Включено'} · запись ${result.receipt.commandId.slice(0, 8)}`
      });
      window.setTimeout(() => window.location.reload(), 450);
    } catch {
      setNotice({tone: 'error', text: 'Управление привязкой недоступно.'});
    } finally {
      setBusy(false);
    }
  };

  return <div className="fcp-registration-control">
    <button
      aria-label={`${enabled ? 'Отключить' : 'Включить'} runtime-привязку ${projectName} для новых запусков`}
      disabled={busy}
      onClick={() => void submit(enabled ? 'disable' : 'enable')}
      type="button"
    >
      {enabled ? <PowerOff aria-hidden="true" size={15}/> : <Power aria-hidden="true" size={15}/>}
      {busy ? 'Сохранение…' : enabled ? 'Отключить' : 'Включить'}
    </button>
    <small>{enabled ? 'Новые запуски будут остановлены' : 'Новые запуски будут разрешены'}</small>
    {!enabled || staleRun === null ? null : <button
      aria-label={`Завершить зависший запуск ${projectName}`}
      disabled={busy}
      onClick={() => void submit('recover')}
      type="button"
    >
      <RotateCcw aria-hidden="true" size={15}/>
      {busy ? 'Сохранение…' : 'Завершить зависший запуск'}
    </button>}
    {!enabled || staleRun === null ? null : <small>Завершает истёкшую аренду · история сохраняется</small>}
    {!enabled ? null : replacementTargets.length === 0
      ? <small>Замена недоступна</small>
      : <>
          <label>
            <span className="fcp-sr-only">Целевая привязка для замены {projectName}</span>
            <select
              aria-label={`Целевая привязка для замены ${projectName}`}
              disabled={busy}
              onChange={(event) => setReplacementTargetId(event.target.value)}
              value={replacementTargetId}
            >
              {replacementTargets.map((target) =>
                <option key={target.id} value={target.id}>{target.label}</option>)}
            </select>
          </label>
          <button
            aria-label={`Заменить runtime-привязку ${projectName}`}
            disabled={busy}
            onClick={() => void submit('replace')}
            type="button"
          >
            <ReplaceIcon aria-hidden="true" size={15}/>
            {busy ? 'Сохранение…' : 'Заменить'}
          </button>
          <small>Атомарное переключение · история сохраняется</small>
        </>}
    <details>
      <summary><ShieldCheck aria-hidden="true" size={15}/> Политика восстановления</summary>
      <label><input checked={recoveryEnabled} onChange={(event) => setRecoveryEnabled(event.target.checked)} type="checkbox"/> Включена</label>
      <label>Порог устаревания, секунд<input min={30} max={604800} onChange={(event) => setStaleThresholdSeconds(Number(event.target.value))} type="number" value={staleThresholdSeconds}/></label>
      <label>Максимум попыток<input min={1} max={10} onChange={(event) => setMaximumAttempts(Number(event.target.value))} type="number" value={maximumAttempts}/></label>
      <button disabled={busy} onClick={() => void submit('set_recovery_policy')} type="button">Сохранить политику</button>
      <small>Создаёт только кандидат для проверки. Никаких автоматических повторов или замен.</small>
    </details>
    {notice === null ? null : <p
      aria-live="polite"
      className={`fcp-command-notice ${notice.tone}`}
    >{notice.text}</p>}
  </div>;
}
