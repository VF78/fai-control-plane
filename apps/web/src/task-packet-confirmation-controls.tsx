'use client';

import {useRouter} from 'next/navigation';
import {useState} from 'react';
import type {PolicySimulationResult} from '@fai-control-plane/domain';
import type {RunsData} from './operator-data';

type Packet = RunsData['packets'][number];
const decisionLabel = (value: string) => ({allow: 'Разрешено', ask: 'Нужно подтверждение', deny: 'Запрещено'}[value] ?? value);

export function TaskPacketConfirmationControls({
  packet,
  csrfToken,
  enabled,
  canQueue
}: Readonly<{
  packet: Packet;
  csrfToken: string | null;
  enabled: boolean;
  canQueue: boolean;
}>) {
  const router = useRouter();
  const [agentProfileId, setAgentProfileId] = useState(packet.profiles[0]?.id ?? '');
  const [acknowledged, setAcknowledged] = useState(false);
  const [pending, setPending] = useState(false);
  const [simulationPending, setSimulationPending] = useState(false);
  const [simulation, setSimulation] = useState<PolicySimulationResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const selectedProfile = packet.profiles.find(({id}) => id === agentProfileId);
  const preview = selectedProfile?.policyPreview;
  const canConfirm = enabled && canQueue && csrfToken !== null && packet.runnable && preview?.runnable === true &&
    acknowledged && !pending;
  const canSimulate = enabled && csrfToken !== null && agentProfileId.length > 0 &&
    !simulationPending;

  const simulate = async () => {
    if (!canSimulate || csrfToken === null) return;
    setSimulationPending(true);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/task-packets/${encodeURIComponent(packet.id)}/simulate-policy`,
        {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({_csrf: csrfToken, profileId: agentProfileId})
        }
      );
      if (!response.ok) {
        setMessage('Симуляция правила недоступна.');
        return;
      }
      setSimulation(await response.json() as PolicySimulationResult);
    } catch {
      setMessage('Симуляция правила недоступна.');
    } finally {
      setSimulationPending(false);
    }
  };

  const confirm = async () => {
    if (!canConfirm || csrfToken === null || preview == null) return;
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/task-packets/${encodeURIComponent(packet.id)}/confirm`,
        {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            _csrf: csrfToken,
            confirmedPacketHash: packet.contentHash,
            agentProfileId,
            actionHash: preview.actionHash
          })
        }
      );
      if (response.status === 201) {
        router.refresh();
        return;
      }
      setMessage(response.status === 409
        ? 'Условия запуска изменились. Обновите страницу и снова проверьте решение.'
        : 'Пакет не поставлен в очередь.');
    } catch {
      setMessage('Пакет не поставлен в очередь.');
    } finally {
      setPending(false);
    }
  };

  if (selectedProfile === undefined) {
    return packet.nonRunnableReason === null ? null : <p className="packet-state">{packet.nonRunnableReason}</p>;
  }
  if (!enabled || csrfToken === null) {
    return <p className="packet-state">Нужна авторизованная сессия оператора.</p>;
  }
  return <>{packet.runnable || packet.nonRunnableReason === null ? null : <p className="packet-state">{packet.nonRunnableReason}</p>}
  <div className="packet-confirmation">
    <label className="packet-profile"><span>Профиль исполнителя</span><select
      disabled={pending}
      onChange={(event) => {
        setAgentProfileId(event.target.value);
        setSimulation(null);
        setAcknowledged(false);
      }}
      value={agentProfileId}
    >{packet.profiles.map((profile) => <option key={profile.id} value={profile.id}>
      {profile.name} · {profile.runtimeId}
    </option>)}</select></label>
    <button disabled={!canSimulate} onClick={() => void simulate()} type="button">
      {simulationPending ? 'Проверяем…' : 'Проверить правило'}
    </button>
    {simulation === null ? null : <dl className="packet-facts simulation-result" style={{gridColumn: '1 / -1'}}>
      <div><dt>Решение</dt><dd>{decisionLabel(simulation.decision)}</dd></div>
      <div><dt>Версия проверки</dt><dd>{simulation.evaluatorVersion}</dd></div>
      <div><dt>Правило</dt><dd>v{simulation.policyVersion}</dd></div>
      <div><dt>Hash симуляции</dt><dd><code>{simulation.simulationHash}</code></dd></div>
      <div><dt>Hash контекста</dt><dd><code>{simulation.contextHash}</code></dd></div>
      <div><dt>Недостающий контекст</dt><dd>{simulation.missingContext.length === 0 ? 'Всё зафиксировано' : simulation.missingContext.join(', ')}</dd></div>
    </dl>}
    {preview == null ? null : <><dl className="packet-facts" style={{gridColumn: '1 / -1'}}>
      <div><dt>Решение</dt><dd>{decisionLabel(preview.decision)}</dd></div>
      <div><dt>Версия правила</dt><dd>v{preview.policyVersion}</dd></div>
      <div><dt>Контекст</dt><dd>{preview.actorType} · {preview.actionCategory} · {preview.surface} · {preview.environment}</dd></div>
      <div><dt>Hash действия</dt><dd><code>{preview.actionHash}</code></dd></div>
      <div><dt>Базовый commit</dt><dd><code>{preview.baseCommit}</code></dd></div>
      <div><dt>Стоп-факторы</dt><dd>{preview.stopFactors.length === 0 ? 'Нет' : preview.stopFactors.join(' ')}</dd></div>
    </dl>
    <label className="packet-acknowledgement"><input
      checked={acknowledged}
      disabled={pending}
      onChange={(event) => setAcknowledged(event.target.checked)}
      type="checkbox"
    /><span>Подтверждаю точный hash пакета <code>{preview.requiredHumanPacketHash}</code>.</span></label>
    <button disabled={!canConfirm} onClick={() => void confirm()} type="button">
      {pending ? 'Ставим в очередь…' : 'Подтвердить и поставить в очередь'}
    </button>
    {!canQueue ? <p className="packet-message">Пакет может запустить только зафиксированный утверждающий.</p> : null}
    </>}
    {message === null ? null : <p aria-live="polite" className="packet-message">{message}</p>}
  </div></>;
}
