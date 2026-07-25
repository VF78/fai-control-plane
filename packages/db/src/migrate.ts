import {fileURLToPath} from 'node:url';
import {migrate} from 'drizzle-orm/node-postgres/migrator';
import {createDatabase} from './index';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required for migrations');
}

const migrationsFolder = fileURLToPath(
  new URL('../drizzle', import.meta.url)
);
const {db, pool} = createDatabase(databaseUrl);

try {
  await migrate(db, {migrationsFolder});
} finally {
  await pool.end();
}
