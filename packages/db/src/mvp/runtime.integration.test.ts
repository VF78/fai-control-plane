import {randomUUID} from 'node:crypto';
import {afterAll, describe, expect, it} from 'vitest';
import {
  appendIncomingEvent,
  completeIncomingEvent,
  createDatabase,
  readPendingIncomingEvents
} from './runtime.ts';

const enabled = process.env.DATABASE_URL !== undefined && process.env.FCP_PROJECT_ID !== undefined;
const database = enabled ? createDatabase() : null;

describe.skipIf(!enabled)('MVP incoming-event claim', () => {
  afterAll(async () => database?.end());

  it('claims and completes one bounded action without leaving its payload', async () => {
    const delivery = `integration-${randomUUID()}`;
    await appendIncomingEvent(database!, {
      projectId: process.env.FCP_PROJECT_ID!,
      provider: 'integration',
      providerDeliveryId: delivery,
      eventType: 'conversation.action',
      payloadHash: '0'.repeat(64),
      actionPayload: {message: {projectId: process.env.FCP_PROJECT_ID}, action: {type: 'project_facts.read'}},
      receivedAt: new Date().toISOString()
    });
    const claimed = (await readPendingIncomingEvents(database!, 100)).find(
      (event) => event.providerDeliveryId === delivery
    );
    expect(claimed?.actionPayload).not.toBeNull();
    await completeIncomingEvent(database!, claimed!.id, new Date().toISOString());
    const stored = await database!.query<{processed: boolean; payload: unknown}>(
      `select processed_at is not null as processed, action_payload as payload
       from incoming_events where provider=$1 and provider_delivery_id=$2`,
      ['integration', delivery]
    );
    expect(stored.rows[0]).toEqual({processed: true, payload: null});
  });
});
