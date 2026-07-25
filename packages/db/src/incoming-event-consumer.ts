import type {
  IncomingEventProcessingResult,
  IncomingEventProcessor
} from '@fai-control-plane/domain';
import {eq, sql} from 'drizzle-orm';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import * as schema from './schema';

const PROCESSING_LEASE_INTERVAL = '5 minutes';

type Database = NodePgDatabase<typeof schema>;

type ClaimedIncomingEvent = Readonly<{
  id: string;
  project_id: string;
  provider: string;
  delivery_id: string;
  event_type: string;
  action: string | null;
  installation_id: string | null;
  repository_id: string | null;
  project_node_id: string | null;
  payload_sha256: string | null;
  sanitized_payload: Record<string, unknown>;
  received_at: Date;
  processing_token: string;
}>;

const unavailable = (): Error =>
  new Error('Incoming event is not available for processing.');

export const createPostgresIncomingEventProcessor = (
  db: Database
): IncomingEventProcessor => ({
  async process(eventId: string): Promise<IncomingEventProcessingResult> {
    const claimResult = await db.transaction(async (tx) => {
      const result = await tx.execute(sql`
        UPDATE incoming_events
        SET
          status = 'processing',
          attempt_count = attempt_count + 1,
          processing_token = gen_random_uuid(),
          processing_lease_expires_at = now() + ${PROCESSING_LEASE_INTERVAL}::interval,
          failure_code = NULL
        WHERE id = ${eventId}::uuid
          AND (
            status IN ('pending', 'failed')
            OR (
              status = 'processing'
              AND processing_lease_expires_at <= now()
            )
          )
        RETURNING
          id,
          project_id,
          provider,
          delivery_id,
          event_type,
          action,
          installation_id,
          repository_id,
          project_node_id,
          payload_sha256,
          sanitized_payload,
          received_at,
          processing_token
      `);
      return result.rows[0] as ClaimedIncomingEvent | undefined;
    });

    if (claimResult === undefined) {
      const [event] = await db
        .select({status: schema.incomingEvents.status})
        .from(schema.incomingEvents)
        .where(eq(schema.incomingEvents.id, eventId));
      if (event?.status === 'processed') {
        return {status: 'replayed', eventId};
      }
      throw unavailable();
    }

    return db.transaction(async (tx) => {
      const [project] = await tx
        .select({workspaceId: schema.projects.workspaceId})
        .from(schema.projects)
        .where(eq(schema.projects.id, claimResult.project_id));
      if (project === undefined) throw unavailable();

      const observation = {
        provider: claimResult.provider,
        deliveryId: claimResult.delivery_id,
        eventType: claimResult.event_type,
        action: claimResult.action,
        source: {
          installationId: claimResult.installation_id,
          repositoryId: claimResult.repository_id,
          projectNodeId: claimResult.project_node_id
        },
        payloadSha256: claimResult.payload_sha256,
        projection: claimResult.sanitized_payload
      };
      await tx.execute(sql`
        INSERT INTO canonical_events (
          workspace_id,
          project_id,
          incoming_event_id,
          event_type,
          aggregate_type,
          aggregate_id,
          deduplication_key,
          payload,
          occurred_at
        ) VALUES (
          ${project.workspaceId}::uuid,
          ${claimResult.project_id}::uuid,
          ${claimResult.id}::uuid,
          'incoming_event.observed',
          'project',
          ${claimResult.project_id}::uuid,
          ${`incoming-event:${claimResult.id}`},
          ${JSON.stringify(observation)}::jsonb,
          ${claimResult.received_at}::timestamptz
        )
        ON CONFLICT DO NOTHING
      `);
      const [canonicalEvent] = await tx
        .select({id: schema.canonicalEvents.id})
        .from(schema.canonicalEvents)
        .where(eq(schema.canonicalEvents.incomingEventId, claimResult.id));
      if (canonicalEvent === undefined) throw unavailable();
      const finalized = await tx.execute(sql`
        UPDATE incoming_events
        SET
          status = 'processed',
          processed_at = now(),
          processing_token = NULL,
          processing_lease_expires_at = NULL,
          failure_code = NULL
        WHERE id = ${claimResult.id}::uuid
          AND status = 'processing'
          AND processing_token = ${claimResult.processing_token}::uuid
        RETURNING id
      `);
      if (finalized.rows.length !== 1) throw unavailable();
      return {status: 'processed', eventId: claimResult.id};
    });
  }
});
