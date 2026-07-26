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
  const canConfirm = enabled && csrfToken !== null && packet.runnable &&
    agentProfileId !== '' && acknowledged && !pending;

  const confirm = async () => {
    if (!canConfirm || csrfToken === null) return;
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
            agentProfileId
          })
        }
      );
      if (response.status === 201) {
        router.refresh();
        return;
      }
      setMessage(response.status === 409
        ? 'The packet hash changed. Refresh and review the current packet.'
        : 'The packet was not queued.');
    } catch {
      setMessage('The packet was not queued.');
    } finally {
      setPending(false);
    }
  };

  if (!packet.runnable) return <p className="packet-state">{packet.nonRunnableReason}</p>;
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
    <label className="packet-acknowledgement"><input
      checked={acknowledged}
      disabled={pending}
      onChange={(event) => setAcknowledged(event.target.checked)}
      type="checkbox"
    /><span>I confirm the exact packet hash <code>{packet.contentHash}</code>.</span></label>
    <button disabled={!canConfirm} onClick={() => void confirm()} type="button">
      {pending ? 'Queueing' : 'Confirm and queue'}
    </button>
    {message === null ? null : <p aria-live="polite" className="packet-message">{message}</p>}
  </div>;
}
