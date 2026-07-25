import {drizzle} from 'drizzle-orm/node-postgres';
import {Pool} from 'pg';
import * as schema from './schema';

export * from './schema';
export {createPostgresUnitOfWork} from './persistence';

export function createDatabase(connectionString: string) {
  const pool = new Pool({connectionString});
  const db = drizzle(pool, {schema});

  return {db, pool};
}
