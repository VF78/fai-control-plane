import type {Pool} from 'pg';

const databaseNamePattern = /^[a-z][a-z0-9_]*$/;

const delay = async (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Waits for suite-owned pools to disconnect instead of terminating PostgreSQL backends. */
export const dropDatabaseWhenDisconnected = async (
  adminPool: Pool,
  databaseName: string,
  timeoutMs = 5_000
): Promise<void> => {
  if (!databaseNamePattern.test(databaseName)) {
    throw new Error('Integration database name is invalid.');
  }
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await adminPool.query<{count: string}>(
      `SELECT count(*)
       FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [databaseName]
    );
    if (Number(result.rows[0]?.count) === 0) break;
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for integration database connections to close.');
    }
    await delay(25);
  }
  await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
};
