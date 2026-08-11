import type {AutonomousQaClaimTransport} from '@fai-control-plane/db';

/**
 * The installed workstation transport has a Codex CLI runtime only. Checklist E
 * will replace this composition value after the exact Hermes endpoint, identity,
 * and data scope are approved; an environment flag alone cannot make it usable.
 */
export const autonomousQaClaimTransport: AutonomousQaClaimTransport = Object.freeze({
  status: 'unavailable',
  reason: 'Hermes QA transport identity and endpoint are not configured.'
});

const available = (transport: AutonomousQaClaimTransport): boolean =>
  transport.status === 'available';

export const autonomousQaTransportAvailable = available(autonomousQaClaimTransport);
