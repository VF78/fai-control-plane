import {createDatabase} from './index';
import {
  createPostgresRuntimeAvailabilityStore,
  runtimeObservationFromEnvironment
} from './runtime-monitoring';

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.length === 0) {
  throw new Error('DATABASE_URL is required.');
}
const database = createDatabase(databaseUrl);
try {
  const result = await createPostgresRuntimeAvailabilityStore(database.db)
    .record(runtimeObservationFromEnvironment(process.env));
  process.stdout.write(`${result}\n`);
} finally {
  await database.pool.end();
}
