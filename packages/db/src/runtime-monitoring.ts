import type {createDatabase} from './index';
import type {RuntimeAvailabilityComponent} from '@fai-control-plane/domain';
import {runtimeAvailabilityObservations} from './schema';

type Database = ReturnType<typeof createDatabase>['db'];

export type RuntimeAvailabilityObservationInput = Readonly<{
  runtimeRegistrationId: string;
  component: RuntimeAvailabilityComponent;
  state: 'available' | 'unavailable';
  observedAt: Date;
  evidenceReference: string;
}>;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const controlCharacters = /[\u0000-\u001f\u007f]/;

export const runtimeObservationFromEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
  observedAt = new Date()
): RuntimeAvailabilityObservationInput => {
  const runtimeRegistrationId = environment.RUNTIME_REGISTRATION_ID ?? '';
  const component = environment.RUNTIME_OBSERVATION_COMPONENT;
  const state = environment.RUNTIME_OBSERVATION_STATE;
  const evidenceReference = environment.RUNTIME_OBSERVATION_EVIDENCE ?? '';
  if (
    !uuidPattern.test(runtimeRegistrationId) ||
    (component !== 'service' && component !== 'scheduler' && component !== 'delivery') ||
    (state !== 'available' && state !== 'unavailable') ||
    Number.isNaN(observedAt.getTime()) ||
    evidenceReference.length < 1 ||
    evidenceReference.length > 500 ||
    controlCharacters.test(evidenceReference)
  ) throw new Error('Runtime availability observation environment is invalid.');
  return {runtimeRegistrationId, component, state, observedAt, evidenceReference};
};

export const createPostgresRuntimeAvailabilityStore = (db: Database) => ({
  async record(input: RuntimeAvailabilityObservationInput): Promise<'recorded' | 'replayed'> {
    if (
      !uuidPattern.test(input.runtimeRegistrationId) ||
      Number.isNaN(input.observedAt.getTime()) ||
      input.evidenceReference.length < 1 ||
      input.evidenceReference.length > 500 ||
      controlCharacters.test(input.evidenceReference)
    ) throw new Error('Runtime availability observation is invalid.');
    const rows = await db.insert(runtimeAvailabilityObservations).values(input)
      .onConflictDoNothing()
      .returning({id: runtimeAvailabilityObservations.id});
    return rows.length === 0 ? 'replayed' : 'recorded';
  }
});
