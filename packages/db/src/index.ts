import {drizzle} from 'drizzle-orm/node-postgres';
import {Pool} from 'pg';
import * as schema from './schema';

export * from './schema';
export {
  reconcileRiskSignal,
  reconcileRiskSignalSet,
  type RiskSignalCondition,
  type RiskSignalEvidenceReference,
  type RiskSignalReconciliation,
  type RiskSignalSetMember
} from './risk-signal';
export {
  RISK_SIGNAL_REENTRY_CONDITION,
  createPostgresRiskSignalDispositionStore,
  riskSignalDispositionReasons,
  type RiskSignalDisposition,
  type RiskSignalDispositionCommand,
  type RiskSignalDispositionReason,
  type RiskSignalDispositionResult
} from './risk-signal-disposition';
export {
  createPostgresNotificationDeliveryReceiptStore,
  ensureNotificationIntentForRiskSignal,
  loadFailedNotificationDeliveryFacts,
  type FailedNotificationDeliveryFact,
  type NotificationDeliveryReceipt,
  type NotificationDeliveryReceiptCommand,
  type NotificationDeliveryReceiptResult,
  type NotificationIntentInput
} from './notification-intent';
export {
  CONVERSATION_MESSAGE_LIMIT,
  createPostgresConversationStore,
  loadConversationRows,
  type ConversationBindingConfiguration,
  type ConversationIdentityConfiguration,
  type ConversationObservation,
  type ConversationParticipantObservation
} from './conversations';
export {createPostgresConversationChannelStore} from './conversation-management';
export {createPostgresUnitOfWork} from './persistence';
export {
  isRuntimeAvailable,
  isTaskPacketProfileEligible,
  matchesTaskPacketProfileSnapshot
} from './runtime-availability';
export {
  createPostgresDeliveryProtocolStore
} from './delivery-protocol';
export {createPostgresDeliveryJourneyStore} from './delivery-journey';
export {createPostgresGovernedQaStore} from './governed-qa';
export {createPostgresDeploymentEvidenceStore} from './release-evidence';
export {createPostgresProjectOutcomeAcceptanceStore} from './project-outcome-acceptance';
export {createPostgresProjectAcceptanceStore, loadProjectAcceptanceProjection} from './project-acceptance';
export {
  createPostgresAgentRunAcceptanceStore,
  type PostgresAgentRunAcceptanceOptions
} from './agent-run-acceptance';
export {createPostgresProjectPlanStore} from './project-plan';
export {
  createPostgresAgentRunRetryContinuationStore,
  createPostgresProjectExecutionDispatcher,
  createPostgresProjectExecutionStore,
  loadProjectExecutionProjection,
  type ProjectExecutionDispatchInput,
  type ProjectExecutionDispatchResult
} from './project-orchestration';
export {
  createPostgresGitHubProjectStatusPublisher,
} from './github-project-status-writeback';
export {createPostgresTrackerSnapshotProjector} from './tracker-snapshot-projection';
export {
  createPostgresTrackerEvidenceProjectionReader
} from './tracker-evidence-projection';
export {
  createPostgresProjectTaskProjectionReader
} from './project-task-projection';
export {
  createPostgresTrackerStatusObservationProcessor,
  type TrackerStatusObservationProcessorResult
} from './tracker-status-observation-processor';
export {
  activeWorkItemStaleAfterMs,
  createPostgresHealthcheckProducer,
  HEALTHCHECK_QUEUE,
  healthcheckCron,
  healthcheckStaleAfterMs,
  pendingApprovalStaleAfterMs
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
export {
  createPostgresQaIntakeProducer,
  QA_INTAKE_QUEUE,
  qaIntakeCron
} from './qa-intake';
export {
  createPostgresQaIntakeTaskPacketConsumer,
  type QaIntakeTaskPacketCommandExecutor,
  type QaIntakeTaskPacketConsumerResult
} from './qa-intake-task-packet';
export {
  createPostgresPmQaBotRunner,
  type PmQaBotResult
} from './pm-qa-bot';
export {createPostgresRunnerClaimStore} from './runner-claim';
export {createPostgresProjectShareStore} from './project-share';
export {createPostgresInstructionVersionStore} from './instruction-versioning';
export {
  createPostgresPolicySimulationStore,
  type PolicySimulationStoreResult
} from './policy-simulation';
export {
  COST_LEDGER_COMMAND,
  VALUE_LEDGER_COMMAND,
  createPostgresCostValueLedgerStore,
  ledgerRoi,
  parseLedgerRecord,
  type CostState,
  type LedgerCost,
  type LedgerRecord,
  type LedgerRoi,
  type ValueEvidence
} from './cost-value-ledger';

export function createDatabase(connectionString: string) {
  const pool = new Pool({connectionString});
  const db = drizzle(pool, {schema});

  return {db, pool};
}
