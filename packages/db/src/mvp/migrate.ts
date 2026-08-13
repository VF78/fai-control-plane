import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createDatabase, databaseMvpReady} from './runtime.ts';

export const migrate = async (): Promise<void> => {
  const database = createDatabase();
  try {
    const existing = await database.query<{name: string}>(
      `select tablename as name from pg_tables where schemaname='public' order by tablename`
    );
    const expected = [
      'actor_external_identities', 'actors', 'approval_evidence', 'audit_events',
      'command_receipts', 'incoming_events', 'oauth_login_attempts', 'operator_sessions',
      'outbox_events', 'project_memberships', 'project_source_artifacts', 'projects',
      'secret_refs', 'tracker_bindings', 'tracker_snapshots', 'workspaces'
    ];
    const names = existing.rows.map(({name}) => name);
    if (names.length > 0) {
      if (JSON.stringify(names) !== JSON.stringify(expected) || !await databaseMvpReady(database)) {
        throw new Error('database_schema_not_mvp');
      }
      return;
    }
    const baseline = import.meta.url.includes('/dist/')
      ? new URL('../mvp-drizzle/0000_mvp.sql', import.meta.url)
      : new URL('../../mvp-drizzle/0000_mvp.sql', import.meta.url);
    const sql = await readFile(fileURLToPath(baseline), 'utf8');
    await database.query(`begin;\n${sql}\ncommit;`);
  } finally {
    await database.end();
  }
};

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await migrate();
}
