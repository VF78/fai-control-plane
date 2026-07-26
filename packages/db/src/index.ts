import {drizzle} from 'drizzle-orm/node-postgres';
import {Pool} from 'pg';
import * as schema from './schema';

export * from './schema';
export {createPostgresUnitOfWork} from './persistence';
export {
  createPostgresGitHubProjectStatusPublisher,
} from './github-project-status-writeback';
export {createPostgresTrackerSnapshotProjector} from './tracker-snapshot-projection';
export {
  createPostgresHealthcheckProducer,
  HEALTHCHECK_QUEUE,
  healthcheckCron
} from './healthcheck';
export {
  createPostgresTrackerRepositoryReadScopeAuthorizer
} from './tracker-repository-read-authorizer';
export {
  createPostgresIncomingEventProcessor
} from './incoming-event-consumer';
export {
  createPostgresTelegramStatusPublisher,
  createPostgresTelegramStatusResponseOutbox,
  formatTelegramStatusResponse
} from './telegram-status-response';
export {
  createPostgresIncomingEventInbox,
  INCOMING_EVENT_QUEUE,
  type PgBossTransactionalSender
} from './incoming-event-inbox';
export {
  createPostgresRecoveryScanProducer,
  RECOVERY_SCAN_QUEUE,
  recoveryScanCron
} from './recovery-scan';
export {
  createPostgresDailyPmReportProducer,
  DAILY_PM_REPORT_QUEUE,
  dailyPmReportCron
} from './daily-pm-report';
export {
  createPostgresPmReportCheckProducer,
  PM_REPORT_CHECK_QUEUE,
  pmReportCheckCron
} from './pm-report-check';
export {createPostgresRunnerClaimStore} from './runner-claim';
export {createPostgresProjectShareStore} from './project-share';

export function createDatabase(connectionString: string) {
  const pool = new Pool({connectionString});
  const db = drizzle(pool, {schema});

  return {db, pool};
}
