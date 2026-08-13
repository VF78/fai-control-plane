import {randomUUID} from 'node:crypto';
import {afterAll, describe, expect, it} from 'vitest';
import {deliverPending, reconcileTracker} from '@fai-control-plane/application';
import type {AgentRoleRequest, MessengerDeliveryInput, TrackerItemFact} from '@fai-control-plane/domain';
import {
  appendIncomingEvent,
  createDatabase,
  createStores,
  listProjectTaskViews
} from './runtime.ts';

const enabled = [
  process.env.DATABASE_URL,
  process.env.FCP_WORKSPACE_ID,
  process.env.FCP_PROJECT_ID,
  process.env.GITHUB_BINDING_ID,
  process.env.BOOTSTRAP_OWNER_ACTOR_ID
].every((value) => value !== undefined);
const database = enabled ? createDatabase() : null;

describe.skipIf(!enabled)('thin Control Plane fresh-DB E2E', () => {
  afterAll(async () => database?.end());

  it('deduplicates a GitHub delivery and exposes facts while an agent failure retries', async () => {
    await database!.query(
      `delete from outbox_events where payload->'request'->'projectItem'->>'url'=
       'https://github.com/VF78/ascon/issues/901'`
    );
    const workspaceId = process.env.FCP_WORKSPACE_ID!;
    const projectId = process.env.FCP_PROJECT_ID!;
    const bindingId = process.env.GITHUB_BINDING_ID!;
    const deliveryId = `e2e-${randomUUID()}`;
    const itemId = `item-${randomUUID()}`;
    const observedAt = new Date().toISOString();
    const incoming = {projectId, provider: 'github', providerDeliveryId: deliveryId,
      eventType: 'projects_v2_item', payloadHash: '1'.repeat(64), receivedAt: observedAt};
    await expect(appendIncomingEvent(database!, incoming)).resolves.toBe('recorded');
    await expect(appendIncomingEvent(database!, incoming)).resolves.toBe('duplicate');

    const item: TrackerItemFact = {itemId, projectId, issueId: '901', title: 'E2E task',
      url: 'https://github.com/VF78/ascon/issues/901', version: `github:updated-at:${observedAt}`,
      statusOptionId: 'backlog-option', statusOptionName: 'Backlog', targetDate: '2026-08-31',
      parentIssueId: null, subIssueIds: [], dependencyIssueIds: ['900'], assigneeIds: [], observedAt};
    const snapshot = {bindingId, externalVersion: `github:updated-at:${observedAt}`, cursor: null,
      observedAt, sourceUrl: 'https://github.com/users/VF78/projects/1', items: [item]} as const;
    const stores = createStores(database!, workspaceId);
    const agentRequest = async (
      fact: TrackerItemFact, role: AgentRoleRequest['role'], idempotencyKey: string
    ): Promise<AgentRoleRequest> => ({role, repository: {id: 'VF78/ascon', url: 'https://github.com/VF78/ascon'},
      projectItem: {id: fact.itemId, projectId: fact.projectId, issueId: fact.issueId, url: fact.url},
      observedVersion: fact.version, sources: [], constraints: ['bounded'], acceptanceCriteria: ['verified'],
      approval: null, correlationId: idempotencyKey, idempotencyKey});
    const notification = async (
      fact: TrackerItemFact, reason: string, idempotencyKey: string
    ): Promise<MessengerDeliveryInput> => ({projectId: fact.projectId, contour: 'trusted-main',
      channelReference: 'internal', text: `${reason}: ${fact.url}`, idempotencyKey});
    const input = {bindingId, workspaceId, projectId, cursor: null,
      statusMap: {backlog: 'backlog-option', ready: 'ready-option', development: 'development-option',
        qa: 'qa-option', acceptance: 'acceptance-option', done: 'done-option'},
      ports: {tracker: {readSnapshot: async () => snapshot}, snapshots: stores.snapshots,
        outbox: stores.outbox, audit: stores.audit, compose: {agentRequest, notification}}};
    await expect(reconcileTracker(input)).resolves.toMatchObject({queuedActions: 1});
    await expect(reconcileTracker(input)).resolves.toMatchObject({queuedActions: 0});

    await expect(deliverPending({limit: 20, ports: {outbox: stores.outbox,
      agent: {submit: async () => { throw new Error('fake_agent_unavailable'); }},
      internalMessenger: {send: async () => ({deliveryReference: 'unused'})},
      clientMessenger: {send: async () => ({deliveryReference: 'unused'})},
      now: () => new Date(observedAt)}})).resolves.toEqual({
        delivered: 0, retried: 1, agentDelivered: 0, agentRetried: 1
      });
    const outbox = await database!.query<{count: string; attempts: number; errorCode: string}>(
      `select count(*)::text as count,max(attempts)::int as attempts,max(last_error_code) as "errorCode"
       from outbox_events where payload->'request'->'projectItem'->>'id'=$1`, [itemId]);
    expect(outbox.rows[0]).toEqual({count: '1', attempts: 1, errorCode: 'delivery_failed'});

    const failedAt = new Date(Date.parse(observedAt) + 1_000).toISOString();
    await stores.snapshots.recordFailure({bindingId, observedAt: failedAt, errorCode: 'github_read_failed'});
    const views = await listProjectTaskViews(database!, process.env.BOOTSTRAP_OWNER_ACTOR_ID!, new Date(failedAt));
    const project = views.find((view) => view.id === projectId);
    expect(project?.tracker).toMatchObject({freshness: 'error', errorCode: 'github_read_failed'});
    expect(project?.tasks).toContainEqual(expect.objectContaining({itemId, title: 'E2E task'}));
  });
});
