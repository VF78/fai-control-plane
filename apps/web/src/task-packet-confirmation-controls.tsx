'use client';

import {useRouter} from 'next/navigation';
import {useState} from 'react';
import type {PolicySimulationResult} from '@fai-control-plane/domain';
import type {RunsData} from './operator-data';

type Packet = RunsData['packets'][number];

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
        setMessage('The policy simulation was not available.');
        return;
      }
      setSimulation(await response.json() as PolicySimulationResult);
    } catch {
      setMessage('The policy simulation was not available.');
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
        ? 'The queue action changed. Refresh and review the current policy preview.'
        : 'The packet was not queued.');
    } catch {
      setMessage('The packet was not queued.');
    } finally {
      setPending(false);
    }
  };

  if (selectedProfile === undefined) {
    return packet.nonRunnableReason === null ? null : <p className="packet-state">{packet.nonRunnableReason}</p>;
  }
  if (!enabled || csrfToken === null) {
    return <p className="packet-state">An authenticated operator session is required.</p>;
  }
  return <>{packet.runnable || packet.nonRunnableReason === null ? null : <p className="packet-state">{packet.nonRunnableReason}</p>}
  <div className="packet-confirmation">
    <label className="packet-profile"><span>Enabled runtime profile</span><select
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
      {simulationPending ? 'Simulating' : 'Simulate policy'}
    </button>
    {simulation === null ? null : <dl className="packet-facts simulation-result" style={{gridColumn: '1 / -1'}}>
      <div><dt>Decision</dt><dd>{simulation.decision}</dd></div>
      <div><dt>Evaluator</dt><dd>{simulation.evaluatorVersion}</dd></div>
      <div><dt>Policy</dt><dd>v{simulation.policyVersion}</dd></div>
      <div><dt>Simulation hash</dt><dd><code>{simulation.simulationHash}</code></dd></div>
      <div><dt>Context hash</dt><dd><code>{simulation.contextHash}</code></dd></div>
      <div><dt>Missing context</dt><dd>{simulation.missingContext.length === 0 ? 'None' : simulation.missingContext.join(', ')}</dd></div>
    </dl>}
    {preview == null ? null : <><dl className="packet-facts" style={{gridColumn: '1 / -1'}}>
      <div><dt>Decision</dt><dd>{preview.decision}</dd></div>
      <div><dt>Policy version</dt><dd>v{preview.policyVersion}</dd></div>
      <div><dt>Policy tuple</dt><dd>{preview.actorType} · {preview.actionCategory} · {preview.surface} · {preview.environment}</dd></div>
      <div><dt>Action hash</dt><dd><code>{preview.actionHash}</code></dd></div>
      <div><dt>Base commit</dt><dd><code>{preview.baseCommit}</code></dd></div>
      <div><dt>Stop factors</dt><dd>{preview.stopFactors.length === 0 ? 'None' : preview.stopFactors.join(' ')}</dd></div>
    </dl>
    <label className="packet-acknowledgement"><input
      checked={acknowledged}
      disabled={pending}
      onChange={(event) => setAcknowledged(event.target.checked)}
      type="checkbox"
    /><span>Required human confirmation: I confirm the exact packet hash <code>{preview.requiredHumanPacketHash}</code>.</span></label>
    <button disabled={!canConfirm} onClick={() => void confirm()} type="button">
      {pending ? 'Queueing' : 'Confirm and queue'}
    </button>
    {!canQueue ? <p className="packet-message">Only the recorded packet approver can queue this packet.</p> : null}
    </>}
    {message === null ? null : <p aria-live="polite" className="packet-message">{message}</p>}
  </div></>;
}
