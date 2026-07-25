import {randomUUID} from 'node:crypto';
import type {
  IncomingEvent,
  IncomingEventAcceptance,
  IncomingEventInbox
} from '@fai-control-plane/domain';
import {describe, expect, it, vi} from 'vitest';
import {
  createIncomingEventQueueConsumer,
  createIncomingEventIngestionService,
  type VerifiedIncomingEventInput
} from './index';

const input = (
  overrides: Partial<VerifiedIncomingEventInput> = {}
): VerifiedIncomingEventInput => ({
  workspaceId: randomUUID(),
  projectId: randomUUID(),
  provider: 'github',
  deliveryId: randomUUID(),
  eventType: 'issues',
  action: 'opened',
  payloadSha256: 'a'.repeat(64),
  verification: {outcome: 'verified', method: 'hmac-sha256'},
  source: {
    kind: 'github',
    installationId: '1001',
    repositoryId: '1278325372',
    projectNodeId: 'PVT_kwHOBIUvJs4Bbefq'
  },
  projection: {issue: {id: 1, number: 2, state: 'open'}},
  ...overrides
});

describe('incoming event ingestion', () => {
  it('creates an internal envelope and delegates verified allowlisted data', async () => {
    const eventId = randomUUID();
    const receivedAt = new Date('2026-07-25T10:00:00.000Z');
    let accepted: IncomingEvent | undefined;
    const inbox: IncomingEventInbox = {
      accept: vi.fn(async (event): Promise<IncomingEventAcceptance> => {
        accepted = event;
        return {status: 'accepted', eventId: event.eventId};
      })
    };
    const service = createIncomingEventIngestionService({
      inbox,
      idGenerator: {next: () => eventId},
      clock: {now: () => receivedAt}
    });

    await expect(service.ingest(input())).resolves.toEqual({
      status: 'accepted',
      eventId
    });
    expect(accepted).toMatchObject({
      eventId,
      receivedAt: receivedAt.toISOString(),
      provider: 'github',
      verification: {outcome: 'verified', method: 'hmac-sha256'},
      projection: {issue: {id: 1, number: 2, state: 'open'}}
    });
    expect(Object.keys(accepted?.projection ?? {})).toEqual(['issue']);
  });

  it.each([
    ['unverified input', {verification: {outcome: 'unverified', method: 'none'}}],
    ['raw payload', {rawPayload: {issue: {title: 'untrusted'}}}],
    ['uppercase hash', {payloadSha256: 'A'.repeat(64)}],
    ['free-text projection field', {
      projection: {issue: {id: 1, number: 2, state: 'open', title: 'untrusted'}}
    }]
  ])('rejects %s before calling the inbox', async (_name, mutation) => {
    const inbox: IncomingEventInbox = {
      accept: vi.fn(async (event): Promise<IncomingEventAcceptance> => ({
        status: 'accepted',
        eventId: event.eventId
      }))
    };
    const service = createIncomingEventIngestionService({inbox});
    const candidate = {...input(), ...mutation} as VerifiedIncomingEventInput;

    await expect(service.ingest(candidate)).rejects.toBeInstanceOf(TypeError);
    expect(inbox.accept).not.toHaveBeenCalled();
  });

  it('accepts only an event ID queue payload and delegates it unchanged', async () => {
    const eventId = randomUUID();
    const processor = {
      process: vi.fn(async () => ({status: 'processed' as const, eventId}))
    };
    const consumer = createIncomingEventQueueConsumer({processor});

    await expect(consumer.consume({eventId})).resolves.toEqual({
      status: 'processed',
      eventId
    });
    expect(processor.process).toHaveBeenCalledWith(eventId);
    await expect(consumer.consume({eventId, projection: {issue: {id: 1}}}))
      .rejects.toThrow('incoming event queue payload contains unsupported fields.');
  });
});
