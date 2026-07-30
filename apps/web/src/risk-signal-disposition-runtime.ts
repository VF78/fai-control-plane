import {
  createDatabase,
  createPostgresRiskSignalDispositionStore
} from '@fai-control-plane/db';

let runtimePromise:
  | Promise<ReturnType<typeof createPostgresRiskSignalDispositionStore>>
  | undefined;

export const getRiskSignalDispositionRuntime = async () => {
  runtimePromise ??= (async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (databaseUrl === undefined || databaseUrl.length === 0) {
      throw new Error('DATABASE_URL is required for risk signal disposition.');
    }
    const {db} = createDatabase(databaseUrl);
    return createPostgresRiskSignalDispositionStore(db);
  })().catch((error) => {
    runtimePromise = undefined;
    throw error;
  });
  return runtimePromise;
};
