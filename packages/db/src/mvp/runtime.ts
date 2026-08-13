import {createHash, randomUUID} from 'node:crypto';
import pg from 'pg';
import type {
  ApprovalKind,
  TrackerSnapshot
} from '@fai-control-plane/domain';
import {validateTrackerSnapshot} from '@fai-control-plane/domain';
import type {
  ApprovalTransactionStore,
  AuditStore,
  ConversationCompletionStore,
  OutboxRecord,
  OutboxStore,
  ReceiptStore,
  SnapshotStore,
  PublishedApprovalTargetPort
} from '@fai-control-plane/application';

const {Pool} = pg;
export type Database = InstanceType<typeof Pool>;

export const createDatabase = (connectionString = process.env.DATABASE_URL): Database => {
  if (connectionString !== undefined && connectionString.length > 0) return new Pool({connectionString, max: 10, idleTimeoutMillis: 30_000});
  if ([process.env.PGHOST,process.env.PGUSER,process.env.PGDATABASE,process.env.PGPASSWORD].some((value) => !value)) {
    throw new Error('database_configuration_required');
  }
  return new Pool({host: process.env.PGHOST,port: Number(process.env.PGPORT ?? 5432),user: process.env.PGUSER,
    database: process.env.PGDATABASE,password: process.env.PGPASSWORD,max:10,idleTimeoutMillis:30_000});
};

export const databaseReady = async (database: Database): Promise<boolean> => {
  try {
    const result = await database.query<{ok: number}>('select 1 as ok');
    return result.rows[0]?.ok === 1;
  } catch {
    return false;
  }
};

export const databaseMvpReady = async (database: Database): Promise<boolean> => {
  if (!await databaseReady(database)) return false;
  const result = await database.query<{count: string}>(
    `select count(*)::text as count from information_schema.tables
     where table_schema='public' and table_name=any($1::text[])`, [[
      'workspaces','actors','oauth_login_attempts','operator_sessions','projects','project_memberships',
      'actor_external_identities','project_source_artifacts','secret_refs','tracker_bindings','tracker_snapshots',
      'incoming_events','approval_evidence','command_receipts','outbox_events','audit_events']]);
  const column = await database.query(
    `select 1 from information_schema.columns where table_schema='public'
     and table_name='incoming_events' and column_name='action_payload'`);
  return result.rows[0]?.count === '16' && column.rowCount === 1;
};

export const pendingInterpretationCount = async (database: Database): Promise<number> => {
  const result = await database.query<{count: string}>(
    `select count(*)::text as count from incoming_events
     where processed_at is null and event_type='conversation.pending_interpretation'`);
  return Number(result.rows[0]?.count ?? 0);
};

export type ProjectRow = Readonly<{
  id: string; workspaceId: string; slug: string; name: string; repositoryUrl: string;
}>;

export const listProjects = async (database: Database, actorId: string): Promise<readonly ProjectRow[]> => {
  const result = await database.query<ProjectRow>(
    `select p.id, p.workspace_id as "workspaceId", p.slug, p.name, p.repository_url as "repositoryUrl"
     from projects p join project_memberships m on m.project_id = p.id
     where m.actor_id = $1 and m.active = true order by p.name`, [actorId]
  );
  return result.rows;
};

export const findActorByExternalIdentity = async (
  database: Database,
  provider: string,
  subjectHash: string
): Promise<Readonly<{id: string; workspaceId: string; enabled: boolean}> | null> => {
  const result = await database.query<{id: string; workspaceId: string; enabled: boolean}>(
    `select a.id, a.workspace_id as "workspaceId", a.enabled
     from actors a join actor_external_identities i on i.actor_id = a.id
     where i.provider = $1 and i.subject_hash = $2`, [provider, subjectHash]
  );
  return result.rows[0] ?? null;
};

export const subjectHash = (provider: string, subject: string): string =>
  createHash('sha256').update(`${provider}\0${subject}`).digest('hex');

export const createSession = async (
  database: Database, actorId: string, tokenHash: string, expiresAt: string
): Promise<void> => {
  await database.query(
    'insert into operator_sessions(actor_id,token_hash,expires_at) values ($1,$2,$3)',
    [actorId, tokenHash, expiresAt]
  );
};

export const actorForSession = async (database: Database, tokenHash: string): Promise<Readonly<{
  actorId: string; workspaceId: string;
}> | null> => {
  const result = await database.query<{actorId: string; workspaceId: string}>(
    `select a.id as "actorId", a.workspace_id as "workspaceId"
     from operator_sessions s join actors a on a.id = s.actor_id
     where s.token_hash = $1 and s.revoked_at is null and s.expires_at > now() and a.enabled = true`, [tokenHash]
  );
  return result.rows[0] ?? null;
};

export const revokeSession = async (database: Database, tokenHash: string): Promise<void> => {
  await database.query('update operator_sessions set revoked_at = now() where token_hash = $1 and revoked_at is null', [tokenHash]);
};

export const beginOauthAttempt = async (
  database: Database, workspaceId: string, stateHash: string, verifierHash: string, expiresAt: string
): Promise<void> => {
  await database.query(
    'insert into oauth_login_attempts(workspace_id,state_hash,verifier_hash,expires_at) values ($1,$2,$3,$4)',
    [workspaceId, stateHash, verifierHash, expiresAt]
  );
};

export const consumeOauthAttempt = async (
  database: Database, stateHash: string, verifierHash: string
): Promise<string | null> => {
  const result = await database.query<{workspaceId: string}>(
    `update oauth_login_attempts set consumed_at = now()
     where state_hash = $1 and verifier_hash = $2 and consumed_at is null and expires_at > now()
     returning workspace_id as "workspaceId"`, [stateHash, verifierHash]
  );
  return result.rows[0]?.workspaceId ?? null;
};

export const addSourceArtifact = async (database: Database, input: Readonly<{
  projectId: string; actorId: string; kind: string; name: string; mediaType: string;
  sha256: string; contentText: string; sourceUrl: string | null; provenance: string;
}>): Promise<string> => {
  const id = randomUUID();
  const result = await database.query(
    `insert into project_source_artifacts
      (id,project_id,created_by_actor_id,kind,name,media_type,sha256,content_text,source_url,provenance)
     select $1,$2,$3,$4,$5,$6,$7,$8,$9,$10 where exists (
       select 1 from project_memberships where project_id=$2 and actor_id=$3 and active=true
     )`, [id, input.projectId, input.actorId, input.kind, input.name, input.mediaType,
      input.sha256, input.contentText, input.sourceUrl, input.provenance]
  );
  if (result.rowCount !== 1) throw new Error('source_membership_denied');
  return id;
};

export const appendIncomingEvent = async (database: Database, input: Readonly<{
  projectId: string; provider: string; providerDeliveryId: string; eventType: string; payloadHash: string;
  actionPayload?: Readonly<Record<string, unknown>>; receivedAt: string;
}>): Promise<'recorded' | 'duplicate'> => {
  const payload = input.actionPayload === undefined ? null : JSON.stringify(input.actionPayload);
  if (payload !== null && Buffer.byteLength(payload) > 16_000) throw new Error('incoming_payload_too_large');
  const result = await database.query(
    `insert into incoming_events(project_id,provider,provider_delivery_id,event_type,payload_hash,action_payload,received_at)
     values($1,$2,$3,$4,$5,$6,$7) on conflict(provider,provider_delivery_id) do nothing returning id`,
    [input.projectId, input.provider, input.providerDeliveryId, input.eventType, input.payloadHash, payload, input.receivedAt]
  );
  return result.rowCount === 1 ? 'recorded' : 'duplicate';
};

export type PendingIncomingEvent = Readonly<{
  id: string; projectId: string; provider: string; providerDeliveryId: string;
  eventType: string; actionPayload: Readonly<Record<string, unknown>> | null;
}>;
export const readPendingIncomingEvents = async (database: Database, limit: number): Promise<readonly PendingIncomingEvent[]> => {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('incoming_limit_invalid');
  const result = await database.query<PendingIncomingEvent>(
    `update incoming_events set processed_at=now()
     where id in (select id from incoming_events where event_type='conversation.action' and action_payload is not null
       and (processed_at is null or processed_at < now() - interval '5 minutes')
       order by received_at limit $1 for update skip locked)
     returning id,project_id as "projectId",provider,provider_delivery_id as "providerDeliveryId",
       event_type as "eventType",action_payload as "actionPayload"`, [limit]);
  return result.rows;
};
export const releaseIncomingEvent = async (database: Database, id: string): Promise<void> => {
  await database.query('update incoming_events set processed_at=null where id=$1 and action_payload is not null', [id]);
};
export const completeIncomingEvent = async (database: Database, id: string, processedAt: string): Promise<void> => {
  const result = await database.query(
    'update incoming_events set processed_at=$2,action_payload=null where id=$1 and action_payload is not null', [id, processedAt]);
  if (result.rowCount !== 1) throw new Error('incoming_completion_conflict');
};

export const latestTelegramUpdateId = async (database: Database, projectId: string): Promise<number | null> => {
  const result = await database.query<{providerDeliveryId: string}>(
    `select provider_delivery_id as "providerDeliveryId" from incoming_events
     where project_id=$1 and provider in ('telegram','telegram-cursor') order by received_at desc limit 1`, [projectId]);
  const value = result.rows[0]?.providerDeliveryId;
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
};

export const createStores = (database: Database, workspaceId: string): Readonly<{
  receipts: ReceiptStore; snapshots: SnapshotStore;
  outbox: OutboxStore; audit: AuditStore; completion: ConversationCompletionStore;
}> => ({
  receipts: {
    async exists(idempotencyKey) {
      const value = await database.query('select 1 from command_receipts where idempotency_key=$1', [idempotencyKey]);
      return value.rowCount === 1;
    },
    async record(value) {
      await database.query(
        `insert into command_receipts(project_id,idempotency_key,command_type,result_reference,occurred_at)
         values($1,$2,$3,$4,$5) on conflict(idempotency_key) do nothing`,
        [value.projectId, value.idempotencyKey, value.commandType, value.resultReference, value.occurredAt]
      );
    }
  },
  snapshots: {async replace(snapshot: TrackerSnapshot) {
    if (!validateTrackerSnapshot(snapshot)) throw new Error('tracker_snapshot_invalid');
    const client = await database.connect();
    try {
      await client.query('begin');
      await client.query('select 1 from tracker_bindings where id=$1 for update', [snapshot.bindingId]);
      await client.query(
        `insert into tracker_snapshots(binding_id,external_version,cursor,source_url,facts,observed_at)
         values($1,$2,$3,$4,$5,$6) on conflict(binding_id,external_version) do nothing`,
        [snapshot.bindingId, snapshot.externalVersion, snapshot.cursor, snapshot.sourceUrl,
          JSON.stringify({items: snapshot.items}), snapshot.observedAt]
      );
      await client.query('update tracker_bindings set cursor=$2 where id=$1', [snapshot.bindingId, snapshot.cursor]);
      await client.query('commit');
    } catch (error) { await client.query('rollback'); throw error; }
    finally { client.release(); }
  }},
  outbox: {
    async enqueue(value: OutboxRecord) {
      const result = await database.query(
        `insert into outbox_events(project_id,topic,idempotency_key,payload,available_at)
         values($1,$2,$3,$4,$5) on conflict(idempotency_key) do nothing returning id`,
        [value.projectId, value.topic, value.idempotencyKey, JSON.stringify(value.payload), value.availableAt]
      );
      return result.rowCount === 1 ? 'enqueued' : 'duplicate';
    },
    async claim(limit, now) {
      const result = await database.query<OutboxRecord & {id: string; attempts: number}>(
        `update outbox_events set claimed_at=$2
         where id in (select id from outbox_events where delivered_at is null and available_at <= $2
           and (claimed_at is null or claimed_at < $2::timestamptz - interval '5 minutes')
           order by available_at limit $1 for update skip locked)
         returning id,project_id as "projectId",topic,idempotency_key as "idempotencyKey",payload,attempts,
           available_at as "availableAt"`, [limit, now]
      );
      return result.rows;
    },
    async complete(id, deliveryReference, occurredAt) {
      await database.query(
        'update outbox_events set delivered_at=$2,delivery_reference=$3,claimed_at=null where id=$1',
        [id, occurredAt, deliveryReference]
      );
    },
    async retry(id, nextAttemptAt, errorCode) {
      await database.query(
        'update outbox_events set attempts=attempts+1,available_at=$2,last_error_code=$3,claimed_at=null where id=$1',
        [id, nextAttemptAt, errorCode]
      );
    }
  },
  audit: {async append(value) {
    if (value.workspaceId !== workspaceId) throw new Error('audit_workspace_mismatch');
    await database.query(
      `insert into audit_events(workspace_id,project_id,actor_id,action,target_reference,correlation_id,details,occurred_at)
       values($1,$2,$3,$4,$5,$6,$7,$8)`,
      [value.workspaceId, value.projectId, value.actorId, value.action, value.targetReference,
        value.correlationId, JSON.stringify(value.details), value.occurredAt]
    );
  }},
  completion: {async complete(value) {
    if (value.workspaceId !== workspaceId) throw new Error('completion_workspace_mismatch');
    const client = await database.connect();
    try {
      await client.query('begin');
      const receipt = await client.query(
        `insert into command_receipts(project_id,actor_id,idempotency_key,command_type,result_reference,occurred_at)
         values($1,$2,$3,$4,$5,$6) on conflict(idempotency_key) do nothing returning id`,
        [value.projectId,value.actorId,value.idempotencyKey,value.commandType,value.resultReference,value.occurredAt]);
      if (receipt.rowCount !== 1) { await client.query('rollback'); return 'duplicate'; }
      await client.query(
        `insert into audit_events(workspace_id,project_id,actor_id,action,target_reference,correlation_id,details,occurred_at)
         values($1,$2,$3,$4,$5,$6,$7,$8)`,
        [value.workspaceId,value.projectId,value.actorId,value.action,value.targetReference,value.correlationId,
          JSON.stringify(value.details),value.occurredAt]);
      await client.query('commit'); return 'recorded';
    } catch (error) { await client.query('rollback'); throw error; }
    finally { client.release(); }
  }}
});

export const createApprovalPersistence = (database: Database): Readonly<{
  targets: PublishedApprovalTargetPort; transaction: ApprovalTransactionStore;
}> => ({
  targets: {async resolve(input) {
    const result = await database.query<{facts: {items?: ApprovalTargetFact[]}}>(
      `select s.facts from tracker_snapshots s join tracker_bindings b on b.id=s.binding_id
       where b.project_id=$1 order by s.observed_at desc limit 1`, [input.projectId]
    );
    const fact = result.rows[0]?.facts.items?.find((item) =>
      item.itemId === input.targetReference || item.issueId === input.targetReference);
    return fact === undefined ? null : {id: input.targetReference, url: fact.url, version: fact.version};
  }},
  transaction: {async record(input) {
    const client = await database.connect();
    try {
      await client.query('begin isolation level serializable');
      await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [input.evidence.idempotencyKey]);
      const current = await client.query<{facts: {items?: ApprovalTargetFact[]}}>(
        `select s.facts from tracker_snapshots s join tracker_bindings b on b.id=s.binding_id
         where b.project_id=$1 order by s.observed_at desc limit 1`, [input.evidence.projectId]);
      const currentFact = current.rows[0]?.facts.items?.find((item) => item.itemId === input.evidence.target.id ||
        item.issueId === input.evidence.target.id);
      if (currentFact?.version !== input.evidence.target.version || currentFact.url !== input.evidence.target.url) {
        await client.query('rollback'); return 'conflict';
      }
      const existing = await client.query<{decision: string; targetVersion: string}>(
        'select decision,target_version as "targetVersion" from approval_evidence where idempotency_key=$1 for update',
        [input.evidence.idempotencyKey]
      );
      if (existing.rows[0] !== undefined) {
        await client.query('rollback');
        return existing.rows[0].decision === input.evidence.decision &&
          existing.rows[0].targetVersion === input.evidence.target.version ? 'duplicate' : 'conflict';
      }
      const value = input.evidence;
      await client.query(
        `insert into approval_evidence
         (id,project_id,actor_id,kind,decision,target_reference,target_url,target_version,idempotency_key,decided_at)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [value.id,value.projectId,value.actorId,value.kind,value.decision,value.target.id,value.target.url,
          value.target.version,value.idempotencyKey,value.decidedAt]
      );
      await client.query(
        `insert into command_receipts(project_id,actor_id,idempotency_key,command_type,result_reference,occurred_at)
         values($1,$2,$3,'approval.decide',$4,$5)`,
        [value.projectId,value.actorId,value.idempotencyKey,value.id,value.decidedAt]
      );
      await client.query(
        `insert into audit_events(workspace_id,project_id,actor_id,action,target_reference,correlation_id,details,occurred_at)
         values($1,$2,$3,$4,$5,$6,$7,$8)`,
        [input.workspaceId,value.projectId,value.actorId,`approval.${value.decision}`,value.target.id,
          value.idempotencyKey,JSON.stringify({kind:value.kind,targetVersion:value.target.version}),value.decidedAt]
      );
      await client.query('commit');
      return 'recorded';
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally { client.release(); }
  }}
});

type ApprovalTargetFact = Readonly<{itemId: string; issueId: string; url: string; version: string}>;

export const canGovernMembership = async (database: Database, actorId: string, projectId: string): Promise<boolean> => {
  const result = await database.query<{role: string}>(
    'select role from project_memberships where actor_id=$1 and project_id=$2 and active=true', [actorId, projectId]);
  return result.rows[0]?.role === 'project_owner';
};

export const resolveActiveHumanMember = async (database: Database, projectId: string, senderReference: string): Promise<Readonly<{actorId: string}> | null> => {
  const result = await database.query<{actorId: string}>(
    `select a.id as "actorId" from actor_external_identities i
     join actors a on a.id=i.actor_id
     join project_memberships m on m.actor_id=a.id and m.project_id=$1
     where i.subject_hash=$2 and a.kind='human' and a.enabled=true and m.active=true`, [projectId, senderReference]);
  return result.rows[0] ?? null;
};

export const canApprove = async (
  database: Database, actorId: string, projectId: string, kind: ApprovalKind
): Promise<boolean> => {
  const result = await database.query<{role: string}>(
    'select role from project_memberships where actor_id=$1 and project_id=$2 and active=true',
    [actorId, projectId]
  );
  const role = result.rows[0]?.role;
  if (kind === 'client_uat') return role === 'project_owner' || role === 'client';
  if (kind === 'internal_operation') return role === 'project_owner' || role === 'operator';
  return role === 'project_owner';
};
