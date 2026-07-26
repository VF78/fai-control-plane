'use client';

import {useRouter} from 'next/navigation';
import {useState} from 'react';
import type {RunsData} from './operator-data';

type Packet = RunsData['packets'][number];

export function TaskPacketConfirmationControls({
  packet,
  csrfToken,
  enabled
}: Readonly<{
  packet: Packet;
  csrfToken: string | null;
  enabled: boolean;
}>) {
  const router = useRouter();
  const [agentProfileId, setAgentProfileId] = useState(packet.profiles[0]?.id ?? '');
  const [acknowledged, setAcknowledged] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const selectedProfile = packet.profiles.find(({id}) => id === agentProfileId);
  const preview = selectedProfile?.policyPreview;
  const canConfirm = enabled && csrfToken !== null && packet.runnable && preview?.runnable === true &&
    acknowledged && !pending;

  const confirm = async () => {
    if (!canConfirm || csrfToken === null || preview === undefined) return;
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

  if (preview === undefined) return <p className="packet-state">{packet.nonRunnableReason}</p>;
  if (!enabled || csrfToken === null) {
    return <p className="packet-state">An authenticated operator session is required to confirm this packet.</p>;
  }
  return <div className="packet-confirmation">
    <label className="packet-profile"><span>Enabled runtime profile</span><select
      disabled={pending}
      onChange={(event) => setAgentProfileId(event.target.value)}
      value={agentProfileId}
    >{packet.profiles.map((profile) => <option key={profile.id} value={profile.id}>
      {profile.name} · {profile.runtimeId}
    </option>)}</select></label>
    <dl className="packet-facts" style={{gridColumn: '1 / -1'}}>
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
    {message === null ? null : <p aria-live="polite" className="packet-message">{message}</p>}
  </div>;
}
