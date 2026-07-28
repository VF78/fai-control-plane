import {
  createDatabase,
  createPostgresCostValueLedgerStore
} from '@fai-control-plane/db';

let runtimePromise:
  | Promise<ReturnType<typeof createPostgresCostValueLedgerStore>>
  | undefined;

export const getCostValueLedgerRuntime = async () => {
  runtimePromise ??= (async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (databaseUrl === undefined || databaseUrl.length === 0) {
      throw new Error('DATABASE_URL is required for the run ledger');
    }
    const {db} = createDatabase(databaseUrl);
    return createPostgresCostValueLedgerStore(db);
  })();
  return runtimePromise;
};
