import {randomUUID} from 'node:crypto';
import {afterAll, describe, expect, it} from 'vitest';
import {deliverPending, reconcileTracker} from '@fai-control-plane/application';
import type {MessengerDeliveryInput, TrackerItemFact} from '@fai-control-plane/domain';
import {
  appendIncomingEvent,
  createDatabase,
  createStores,
  listApprovalEvidenceViews,
  listProjectSourceViews,
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

  it('deduplicates a GitHub delivery and exposes facts while a human notification retries', async () => {
    await database!.query(
      `delete from outbox_events where payload->'message'->>'text' like
       'Статус задачи изменён:%https://github.com/VF78/ascon/issues/901'`
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

    const initialItem: TrackerItemFact = {itemId, projectId, issueId: '901', title: 'E2E task',
      url: 'https://github.com/VF78/ascon/issues/901', version: `github:updated-at:${observedAt}`,
      statusOptionId: 'ready-option', statusOptionName: 'Ready', ownerOptionId: null,
      blocked: false, targetDate: '2026-08-31',
      parentIssueId: null, subIssueIds: [], dependencyIssueIds: ['900'], assigneeIds: [], assignees: [], observedAt};
    let snapshot = {bindingId, externalVersion: `github:updated-at:${observedAt}`, cursor: null,
      observedAt, sourceUrl: 'https://github.com/users/VF78/projects/1', items: [initialItem]} as const;
    const stores = createStores(database!, workspaceId);
    const statusChanged = async (
      prior: TrackerItemFact, fact: TrackerItemFact, idempotencyKey: string
    ): Promise<MessengerDeliveryInput> => ({projectId: fact.projectId, contour: 'trusted-main',
      channelReference: 'internal',
      text: `Статус задачи изменён: ${prior.statusOptionName} → ${fact.statusOptionName}\n${fact.url}`,
      idempotencyKey});
    const input = {bindingId, workspaceId, projectId, cursor: null,
      ports: {tracker: {readSnapshot: async () => snapshot}, snapshots: stores.snapshots,
        outbox: stores.outbox, audit: stores.audit, compose: {statusChanged}}};
    await expect(reconcileTracker(input)).resolves.toMatchObject({queuedActions: 0});
    const changedAt=new Date(Date.parse(observedAt)+1_000).toISOString();
    const item:TrackerItemFact={...initialItem,version:`github:updated-at:${changedAt}`,
      statusOptionId:'acceptance-option',statusOptionName:'Acceptance',observedAt:changedAt};
    snapshot={...snapshot,externalVersion:`github:updated-at:${changedAt}`,observedAt:changedAt,items:[item]} as const;
    await expect(reconcileTracker(input)).resolves.toMatchObject({queuedActions: 1});
    await expect(reconcileTracker(input)).resolves.toMatchObject({queuedActions: 0});

    const refreshedAt = new Date(Date.parse(changedAt) + 5 * 60_000).toISOString();
    snapshot = {...snapshot, observedAt: refreshedAt,
      items: [{...item, observedAt: refreshedAt}]} as const;
    await expect(reconcileTracker(input)).resolves.toMatchObject({queuedActions: 0});
    const refreshed = await database!.query<{count: string; observedAt: Date}>(
      `select count(*)::text as count,max(observed_at) as "observedAt" from tracker_snapshots
       where binding_id=$1 and external_version=$2`, [bindingId, snapshot.externalVersion]
    );
    expect(refreshed.rows[0]).toEqual({count: '1', observedAt: new Date(refreshedAt)});
    const freshViews = await listProjectTaskViews(database!, process.env.BOOTSTRAP_OWNER_ACTOR_ID!,
      new Date(Date.parse(refreshedAt) + 15 * 60_000));
    expect(freshViews.find((view) => view.id === projectId)?.tracker.freshness).toBe('fresh');
    const staleViews = await listProjectTaskViews(database!, process.env.BOOTSTRAP_OWNER_ACTOR_ID!,
      new Date(Date.parse(refreshedAt) + 15 * 60_000 + 1));
    expect(staleViews.find((view) => view.id === projectId)?.tracker.freshness).toBe('stale');

    await expect(deliverPending({limit: 20, ports: {outbox: stores.outbox,
      internalMessenger: {send: async () => { throw new Error('fake_messenger_unavailable'); }},
      clientMessenger: {send: async () => ({deliveryReference: 'unused'})},
      now: () => new Date(changedAt)}})).resolves.toEqual({
        delivered: 0, retried: 1
      });
    const outbox = await database!.query<{count: string; attempts: number; errorCode: string}>(
      `select count(*)::text as count,max(attempts)::int as attempts,max(last_error_code) as "errorCode"
       from outbox_events where payload->'message'->>'text' like
       'Статус задачи изменён:%https://github.com/VF78/ascon/issues/901'`);
    expect(outbox.rows[0]).toEqual({count: '1', attempts: 1, errorCode: 'delivery_failed'});

    const failedAt = new Date(Date.parse(refreshedAt) + 1_000).toISOString();
    await stores.snapshots.recordFailure({bindingId, observedAt: failedAt, errorCode: 'github_read_failed'});
    const views = await listProjectTaskViews(database!, process.env.BOOTSTRAP_OWNER_ACTOR_ID!, new Date(failedAt));
    const project = views.find((view) => view.id === projectId);
    expect(project?.tracker).toMatchObject({freshness: 'error', errorCode: 'github_read_failed'});
    expect(project?.tasks).toContainEqual(expect.objectContaining({itemId, title: 'E2E task'}));

    const actorId = process.env.BOOTSTRAP_OWNER_ACTOR_ID!;
    const evidenceKey = `e2e-evidence-${randomUUID()}`;
    await database!.query(
      `insert into project_source_artifacts
       (project_id,created_by_actor_id,kind,name,media_type,sha256,content_text,source_url,provenance)
       values ($1,$2,'document','E2E source','text/plain',$3,'bounded','https://example.test/source','e2e')`,
      [projectId, actorId, randomUUID().replaceAll('-', '').padEnd(64, '0')]
    );
    await database!.query(
      `insert into approval_evidence
       (project_id,actor_id,kind,decision,target_reference,target_url,target_version,idempotency_key,decided_at)
       values ($1,$2,'internal_operation','approved','e2e-target','https://example.test/target','v1',$3,$4)`,
      [projectId, actorId, evidenceKey, observedAt]
    );
    await expect(listProjectSourceViews(database!, actorId)).resolves.toContainEqual(
      expect.objectContaining({projectId, name: 'E2E source', provenance: 'e2e'})
    );
    await expect(listApprovalEvidenceViews(database!, actorId)).resolves.toContainEqual(
      expect.objectContaining({projectId, targetReference: 'e2e-target', decision: 'approved'})
    );
  });
});
