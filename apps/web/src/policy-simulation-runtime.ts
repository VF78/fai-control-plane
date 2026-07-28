import {
  createDatabase,
  createPostgresPolicySimulationStore,
  type PolicySimulationStoreResult
} from '@fai-control-plane/db';

export type PolicySimulationRuntime = Readonly<{
  simulate(input: Readonly<{
    workspaceId: string;
    actorId: string;
    taskPacketId: string;
    profileId: string;
  }>): Promise<PolicySimulationStoreResult>;
}>;

let runtimePromise: Promise<PolicySimulationRuntime> | undefined;

export const getPolicySimulationRuntime = async (): Promise<PolicySimulationRuntime> => {
  runtimePromise ??= (async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (databaseUrl === undefined || databaseUrl.length === 0) {
      throw new Error('DATABASE_URL is required for policy simulation');
    }
    const {db} = createDatabase(databaseUrl);
    return createPostgresPolicySimulationStore(db);
  })().catch((error: unknown) => {
    runtimePromise = undefined;
    throw error;
  });
  return runtimePromise;
};
