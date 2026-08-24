import {createHash, randomUUID} from 'node:crypto';
import pg from 'pg';
import type {
  ApprovalKind,
  MessengerDeliveryInput,
  OpaqueSecretRef,
  ProjectRole,
  SourceReference,
  TrackerSnapshot
} from '@fai-control-plane/domain';
import {trackerStaleAfterMs, validateTrackerSnapshot} from '@fai-control-plane/domain';
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

export const trackerSnapshotFreshness = (observedAt: Date | null, now: Date): 'fresh' | 'stale' | 'unavailable' =>
  observedAt === null ? 'unavailable' : now.getTime() - observedAt.getTime() > trackerStaleAfterMs ? 'stale' : 'fresh';

// Forward-compatible read of snapshots written before optional Phase A fields.
// Missing facts stay absent/unknown: they never become a local lifecycle fact.
const normalizeTrackerItems = (value: unknown): TrackerSnapshot['items'] => Array.isArray(value)
  ? value.map((item) => typeof item === 'object' && item !== null
    ? {...item,
      ...(!('ownerOptionId' in item) ? {ownerOptionId: null} : {}),
      ...(!('assignees' in item) ? {assignees: []} : {})
    } : item) as TrackerSnapshot['items']
  : [];

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
  return result.rows[0]?.count === '16';
};

export type ProjectRow = Readonly<{
  id: string; workspaceId: string; slug: string; name: string; repositoryUrl: string;
}>;

export type ProjectTaskView = ProjectRow & Readonly<{
  tracker: Readonly<{
    provider?: string | null;
    configured?: boolean;
    sourceUrl: string | null;
    observedAt: string | null;
    freshness: 'fresh' | 'stale' | 'error' | 'unavailable';
    errorCode: string | null;
  }>;
  tasks: readonly TrackerSnapshot['items'][number][];
}>;

export type ProjectSourceView = Readonly<{
  id: string; projectId: string; kind: string; name: string; mediaType: string;
  sha256: string; sourceUrl: string | null; provenance: string; createdAt: string;
}>;

export type ApprovalEvidenceView = Readonly<{
  id: string; projectId: string; kind: string; decision: 'approved' | 'rejected';
  targetReference: string; targetUrl: string; targetVersion: string; decidedAt: string;
}>;

/**
 * Safe operator evidence.  This is deliberately a read projection: it exposes
 * neither secret locators nor event/outbox payloads, and it does not turn the
 * Control Plane into a messenger or Hermes runtime.
 */
export type ProjectOperatorEvidenceView = Readonly<{
  projectId: string;
  people: readonly Readonly<{
    membershipId: string; actorId: string; displayName: string; kind: 'human' | 'agent' | 'system'; role: string; active: boolean;
    identityBindings: readonly Readonly<{provider: string; subjectHash: string}>[];
  }>[];
  ingress: readonly Readonly<{provider: string; lastReceivedAt: string; count: number}>[];
  conversations: readonly Readonly<{contour: 'trusted-main' | 'client-edge'; lastOccurredAt: string; count: number}>[];
  messenger: Readonly<{pending: number; delivered: number; failed: number; lastOccurredAt: string | null}>;
  agentSubmissions: Readonly<{
    count: number;
    lastOccurredAt: string | null;
    recent: readonly Readonly<{targetReference: string; deliveryReference: string; occurredAt: string}>[];
  }>;
  receipts: readonly Readonly<{commandType: string; resultReference: string; occurredAt: string}>[];
  audit: readonly Readonly<{action: string; targetReference: string; occurredAt: string}>[];
}>;

export const listProjectOperatorEvidenceViews = async (
  database: Database,
  actorId: string
): Promise<readonly ProjectOperatorEvidenceView[]> => {
  type PersonRow = {projectId: string; membershipId: string; actorId: string; displayName: string; kind: 'human' | 'agent' | 'system'; role: string; active: boolean;
    provider: string | null; subjectHash: string | null};
  type IngressRow = {projectId: string; provider: string; lastReceivedAt: Date; count: string};
  type DeliveryRow = {projectId: string; pending: string; delivered: string;
    failed: string; lastOccurredAt: Date | null};
  type ReceiptRow = {projectId: string; commandType: string; resultReference: string; occurredAt: Date};
  type AuditRow = {projectId: string; action: string; targetReference: string; occurredAt: Date};
  type ConversationRow = {projectId: string; contour: 'trusted-main' | 'client-edge'; lastOccurredAt: Date; count: string};
  type AgentSubmissionRow = {projectId: string; lastOccurredAt: Date; count: string};
  type AgentSubmissionEvidenceRow = {projectId: string; targetReference: string; deliveryReference: string; occurredAt: Date};
  const scope = `select p.id from projects p join project_memberships m on m.project_id=p.id
    where m.actor_id=$1 and m.active=true`;
  const [people, ingress, deliveries, receipts, audit, conversations, agentSubmissions, agentSubmissionEvidence] = await Promise.all([
    database.query<PersonRow>(`select m.project_id as "projectId",m.id as "membershipId",a.id as "actorId",a.display_name as "displayName",a.kind,m.role,m.active,
      i.provider,i.subject_hash as "subjectHash" from project_memberships m join actors a on a.id=m.actor_id
      left join actor_external_identities i on i.actor_id=a.id where m.project_id in (${scope})
      order by a.display_name,i.provider`, [actorId]),
    database.query<IngressRow>(`select project_id as "projectId",provider,max(received_at) as "lastReceivedAt",count(*)::text as count
      from incoming_events where project_id in (${scope}) group by project_id,provider`, [actorId]),
    database.query<DeliveryRow>(`select project_id as "projectId",
      count(*) filter(where delivered_at is null and last_error_code is null)::text as pending,
      count(*) filter(where delivered_at is not null)::text as delivered,
      count(*) filter(where delivered_at is null and last_error_code is not null)::text as failed,
      max(coalesce(delivered_at,claimed_at,created_at)) as "lastOccurredAt" from outbox_events
      where project_id in (${scope}) and topic='messenger-notification' group by project_id`, [actorId]),
    database.query<ReceiptRow>(`select project_id as "projectId",command_type as "commandType",result_reference as "resultReference",occurred_at as "occurredAt"
      from command_receipts where project_id in (${scope}) order by occurred_at desc limit 80`, [actorId]),
    database.query<AuditRow>(`select project_id as "projectId",action,target_reference as "targetReference",occurred_at as "occurredAt"
      from audit_events where project_id in (${scope}) order by occurred_at desc limit 80`, [actorId]),
    database.query<ConversationRow>(`select project_id as "projectId",details->>'contour' as contour,
      max(occurred_at) as "lastOccurredAt",count(*)::text as count from audit_events
      where project_id in (${scope}) and action like 'conversation.%'
        and details->>'contour' in ('trusted-main','client-edge')
      group by project_id,details->>'contour'`, [actorId]),
    database.query<AgentSubmissionRow>(`select project_id as "projectId",max(occurred_at) as "lastOccurredAt",
      count(*)::text as count from command_receipts where project_id in (${scope}) and command_type='agent.submit'
      group by project_id`, [actorId]),
    database.query<AgentSubmissionEvidenceRow>(`select a.project_id as "projectId",a.target_reference as "targetReference",
      r.result_reference as "deliveryReference",r.occurred_at as "occurredAt" from audit_events a
      join command_receipts r on r.project_id=a.project_id and r.actor_id is not distinct from a.actor_id
        and r.occurred_at=a.occurred_at and r.command_type='agent.submit'
      where a.project_id in (${scope}) and a.action='agent.submit' order by r.occurred_at desc limit 80`, [actorId])
  ]);
  const ids = await listProjects(database, actorId);
  return ids.map((project) => {
    const memberRows = people.rows.filter((row) => row.projectId === project.id);
    const members = [...new Map(memberRows.map((row) => [row.actorId, {
      membershipId: row.membershipId, actorId: row.actorId, displayName: row.displayName, kind: row.kind, role: row.role, active: row.active,
      identityBindings: memberRows.filter((item) => item.actorId === row.actorId && item.provider !== null && item.subjectHash !== null)
        .map((item) => ({provider: item.provider!, subjectHash: item.subjectHash!}))
    }])).values()];
    const summary = () => {
      const row = deliveries.rows.find((item) => item.projectId === project.id);
      return {pending: Number(row?.pending ?? 0), delivered: Number(row?.delivered ?? 0), failed: Number(row?.failed ?? 0),
        lastOccurredAt: row?.lastOccurredAt?.toISOString() ?? null};
    };
    const agentSubmission = agentSubmissions.rows.find((row) => row.projectId === project.id);
    return {projectId: project.id, people: members,
      ingress: ingress.rows.filter((row) => row.projectId === project.id).map((row) => ({provider: row.provider,
        lastReceivedAt: row.lastReceivedAt.toISOString(), count: Number(row.count)})),
      conversations: conversations.rows.filter((row) => row.projectId === project.id).map((row) => ({contour: row.contour,
        lastOccurredAt: row.lastOccurredAt.toISOString(), count: Number(row.count)})),
      messenger: summary(),
      agentSubmissions: {count: Number(agentSubmission?.count ?? 0),
        lastOccurredAt: agentSubmission?.lastOccurredAt.toISOString() ?? null,
        recent: agentSubmissionEvidence.rows.filter((row) => row.projectId === project.id)
          .map((row) => ({targetReference: row.targetReference, deliveryReference: row.deliveryReference,
            occurredAt: row.occurredAt.toISOString()}))},
      receipts: receipts.rows.filter((row) => row.projectId === project.id).slice(0, 8).map((row) => ({...row, occurredAt: row.occurredAt.toISOString()})),
      audit: audit.rows.filter((row) => row.projectId === project.id).slice(0, 8).map((row) => ({...row, occurredAt: row.occurredAt.toISOString()}))};
  });
};

export const listProjects = async (database: Database, actorId: string): Promise<readonly ProjectRow[]> => {
  const result = await database.query<ProjectRow>(
    `select p.id, p.workspace_id as "workspaceId", p.slug, p.name, p.repository_url as "repositoryUrl"
     from projects p join project_memberships m on m.project_id = p.id
     where m.actor_id = $1 and m.active = true order by p.name`, [actorId]
  );
  return result.rows;
};

export const projectAgentDeliveryConfigured = async (
  database: Database,
  actorId: string,
  projectId: string
): Promise<boolean> => {
  const result = await database.query<{configured: boolean}>(
    `select exists(select 1 from projects p
       join project_memberships m on m.project_id=p.id and m.actor_id=$1 and m.active=true
       join secret_refs s on s.workspace_id=p.workspace_id and s.purpose='agent_delivery'
       where p.id=$2 and s.locator like '/%') as configured`, [actorId, projectId]
  );
  return result.rows[0]?.configured === true;
};

export const listProjectTaskViews = async (
  database: Database,
  actorId: string,
  now = new Date()
): Promise<readonly ProjectTaskView[]> => {
  type Row = ProjectRow & Readonly<{
    bindingId: string | null;
    provider: string | null;
    externalVersion: string | null;
    cursor: string | null;
    sourceUrl: string | null;
    facts: Readonly<{items?: TrackerSnapshot['items']}> | null;
    observedAt: Date | null;
    attemptAt: Date | null;
    attemptErrorCode: string | null;
  }>;
  const result = await database.query<Row>(
    `select p.id,p.workspace_id as "workspaceId",p.slug,p.name,p.repository_url as "repositoryUrl",
       b.id as "bindingId",b.provider,ok.external_version as "externalVersion",ok.cursor,ok.source_url as "sourceUrl",
       ok.facts,ok.observed_at as "observedAt",attempt.observed_at as "attemptAt",
       attempt.error_code as "attemptErrorCode"
     from projects p join project_memberships m on m.project_id=p.id and m.actor_id=$1 and m.active=true
     left join tracker_bindings b on b.project_id=p.id and b.enabled=true
     left join lateral (select external_version,cursor,source_url,facts,observed_at from tracker_snapshots
       where binding_id=b.id and error_code is null order by observed_at desc,created_at desc limit 1) ok on true
     left join lateral (select observed_at,error_code from tracker_snapshots
       where binding_id=b.id order by observed_at desc,created_at desc limit 1) attempt on true
     order by p.name`, [actorId]
  );
  return result.rows.map((row) => {
    let tasks: readonly TrackerSnapshot['items'][number][] = [];
    let projectionError: string | null = null;
    const observedAt = row.observedAt?.toISOString() ?? null;
    if (row.bindingId !== null && row.externalVersion !== null && row.sourceUrl !== null && observedAt !== null) {
      const snapshot: TrackerSnapshot = {bindingId: row.bindingId, externalVersion: row.externalVersion,
        cursor: row.cursor, sourceUrl: row.sourceUrl, observedAt, items: normalizeTrackerItems(row.facts?.items)};
      if (validateTrackerSnapshot(snapshot)) tasks = snapshot.items;
      else projectionError = 'tracker_snapshot_invalid';
    }
    const providerError = row.attemptErrorCode !== null &&
      (row.observedAt === null || (row.attemptAt?.getTime() ?? 0) >= row.observedAt.getTime())
      ? row.attemptErrorCode
      : null;
    const errorCode = projectionError ?? providerError;
    const freshness = errorCode !== null ? 'error' as const : trackerSnapshotFreshness(row.observedAt, now);
    return {id: row.id, workspaceId: row.workspaceId, slug: row.slug, name: row.name,
      repositoryUrl: row.repositoryUrl, tracker: {provider: row.provider, configured: row.bindingId !== null,
        sourceUrl: row.sourceUrl, observedAt, freshness, errorCode}, tasks};
  });
};

export const listProjectSourceViews = async (
  database: Database,
  actorId: string
): Promise<readonly ProjectSourceView[]> => {
  const result = await database.query<Omit<ProjectSourceView, 'createdAt'> & {createdAt: Date}>(
    `select s.id,s.project_id as "projectId",s.kind,s.name,s.media_type as "mediaType",s.sha256,
       s.source_url as "sourceUrl",s.provenance,s.created_at as "createdAt"
     from project_source_artifacts s join project_memberships m on m.project_id=s.project_id
     where m.actor_id=$1 and m.active=true order by s.created_at desc`, [actorId]
  );
  return result.rows.map((row) => ({...row, createdAt: row.createdAt.toISOString()}));
};

export const listApprovalEvidenceViews = async (
  database: Database,
  actorId: string
): Promise<readonly ApprovalEvidenceView[]> => {
  const result = await database.query<Omit<ApprovalEvidenceView, 'decidedAt'> & {decidedAt: Date}>(
    `select a.id,a.project_id as "projectId",a.kind,a.decision,a.target_reference as "targetReference",
       a.target_url as "targetUrl",a.target_version as "targetVersion",a.decided_at as "decidedAt"
     from approval_evidence a join project_memberships m on m.project_id=a.project_id
     where m.actor_id=$1 and m.active=true order by a.decided_at desc`, [actorId]
  );
  return result.rows.map((row) => ({...row, decidedAt: row.decidedAt.toISOString()}));
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
  actorId: string; workspaceId: string; displayName: string;
}> | null> => {
  const result = await database.query<{actorId: string; workspaceId: string; displayName: string}>(
    `select a.id as "actorId", a.workspace_id as "workspaceId", a.display_name as "displayName"
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
  const result = await database.query<{id: string}>(
    `insert into project_source_artifacts
      (id,project_id,created_by_actor_id,kind,name,media_type,sha256,content_text,source_url,provenance)
     select $1,$2,$3,$4,$5,$6,$7,$8,$9,$10 where exists (
       select 1 from project_memberships where project_id=$2 and actor_id=$3 and active=true
     ) on conflict(project_id,sha256) do update set sha256=excluded.sha256 returning id`, [id, input.projectId, input.actorId, input.kind, input.name, input.mediaType,
      input.sha256, input.contentText, input.sourceUrl, input.provenance]
  );
  if (result.rowCount !== 1) throw new Error('source_membership_denied');
  return result.rows[0]!.id;
};

export const appendIncomingEvent = async (database: Database, input: Readonly<{
  projectId: string; provider: string; providerDeliveryId: string; eventType: string; payloadHash: string;
  receivedAt: string;
}>): Promise<'recorded' | 'duplicate'> => {
  const result = await database.query(
    `insert into incoming_events(project_id,provider,provider_delivery_id,event_type,payload_hash,received_at)
     values($1,$2,$3,$4,$5,$6) on conflict(provider,provider_delivery_id) do nothing returning id`,
    [input.projectId, input.provider, input.providerDeliveryId, input.eventType, input.payloadHash, input.receivedAt]
  );
  return result.rowCount === 1 ? 'recorded' : 'duplicate';
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
  snapshots: {
    async readLatest(bindingId: string) {
      const result = await database.query<{
        externalVersion: string; cursor: string | null; sourceUrl: string; facts: {items?: unknown}; observedAt: Date;
      }>(`select external_version as "externalVersion",cursor,source_url as "sourceUrl",facts,
          observed_at as "observedAt" from tracker_snapshots
        where binding_id=$1 and error_code is null order by observed_at desc,created_at desc limit 1`, [bindingId]);
      const row = result.rows[0];
      if (row === undefined) return null;
      if (!Array.isArray(row.facts.items)) throw new Error('tracker_snapshot_invalid');
      const snapshot: TrackerSnapshot = {bindingId, externalVersion: row.externalVersion, cursor: row.cursor,
        sourceUrl: row.sourceUrl, observedAt: row.observedAt.toISOString(),
        items: normalizeTrackerItems(row.facts.items)};
      if (!validateTrackerSnapshot(snapshot)) throw new Error('tracker_snapshot_invalid');
      return snapshot;
    },
    async replace(snapshot: TrackerSnapshot) {
      if (!validateTrackerSnapshot(snapshot)) throw new Error('tracker_snapshot_invalid');
      const client = await database.connect();
      try {
        await client.query('begin');
        await client.query('select 1 from tracker_bindings where id=$1 for update', [snapshot.bindingId]);
        await client.query(
          `insert into tracker_snapshots(binding_id,external_version,cursor,source_url,facts,observed_at)
           values($1,$2,$3,$4,$5,$6) on conflict(binding_id,external_version) do update set
             cursor=excluded.cursor,source_url=excluded.source_url,facts=excluded.facts,observed_at=excluded.observed_at`,
          [snapshot.bindingId, snapshot.externalVersion, snapshot.cursor, snapshot.sourceUrl,
            JSON.stringify({items: snapshot.items}), snapshot.observedAt]
        );
        await client.query('update tracker_bindings set cursor=$2 where id=$1', [snapshot.bindingId, snapshot.cursor]);
        await client.query('commit');
      } catch (error) { await client.query('rollback'); throw error; }
      finally { client.release(); }
    },
    async recordFailure(input) {
      if (!Number.isFinite(Date.parse(input.observedAt)) || !/^[a-z0-9_]{1,100}$/.test(input.errorCode)) {
        throw new Error('tracker_failure_invalid');
      }
      const version = `error:${input.observedAt}:${input.errorCode}`;
      const result = await database.query(
        `insert into tracker_snapshots(binding_id,external_version,cursor,source_url,facts,observed_at,error_code)
         select id,$2,cursor,project_url,'{"items":[]}'::jsonb,$3,$4 from tracker_bindings where id=$1
         on conflict(binding_id,external_version) do nothing`,
        [input.bindingId, version, input.observedAt, input.errorCode]
      );
      if (result.rowCount !== 1) {
        const existing = await database.query(
          'select 1 from tracker_snapshots where binding_id=$1 and external_version=$2',
          [input.bindingId, version]
        );
        if (existing.rowCount !== 1) throw new Error('tracker_binding_missing');
      }
    }
  },
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
         where id in (select id from outbox_events where topic='messenger-notification'
           and delivered_at is null and available_at <= $2
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

export const resolveActiveHumanMember = async (database: Database, projectId: string, senderReference: string): Promise<Readonly<{
  actorId: string;
  role: 'project_owner' | 'operator' | 'contributor' | 'client';
}> | null> => {
  const result = await database.query<{actorId: string; role: 'project_owner' | 'operator' | 'contributor' | 'client'}>(
    `select a.id as "actorId",m.role from actor_external_identities i
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

export type AgentSubmissionBinding = Readonly<{
  workspaceId: string; projectId: string; requesterRole: ProjectRole; bindingId: string;
  provider: string; externalProjectId: string; projectUrl: string; repositoryId: string; repositoryUrl: string;
  cursor: string | null; trackerCredentialRef: OpaqueSecretRef; agentCredentialRef: OpaqueSecretRef | null;
}>;

export const resolveAgentSubmissionBinding = async (
  database: Database, actorId: string, projectId: string
): Promise<AgentSubmissionBinding | null> => {
  type Row = Omit<AgentSubmissionBinding, 'trackerCredentialRef' | 'agentCredentialRef'> & Readonly<{
    trackerSecretId: string; trackerSecretPurpose: string; trackerSecretLocator: string;
    agentSecretId: string | null; agentSecretLocator: string | null;
  }>;
  const result = await database.query<Row>(
    `select p.workspace_id as "workspaceId",p.id as "projectId",m.role as "requesterRole",
       b.id as "bindingId",b.provider,b.external_project_id as "externalProjectId",b.project_url as "projectUrl",
       b.repository_id as "repositoryId",b.repository_url as "repositoryUrl",b.cursor,
       tracker_secret.id as "trackerSecretId",tracker_secret.purpose as "trackerSecretPurpose",
       tracker_secret.locator as "trackerSecretLocator",agent_secret.id as "agentSecretId",
       agent_secret.locator as "agentSecretLocator"
     from projects p join project_memberships m on m.project_id=p.id and m.actor_id=$1 and m.active=true
     join tracker_bindings b on b.project_id=p.id and b.enabled=true
     join secret_refs tracker_secret on tracker_secret.id=b.secret_ref_id and tracker_secret.workspace_id=p.workspace_id
     left join secret_refs agent_secret on agent_secret.workspace_id=p.workspace_id and agent_secret.purpose='agent_delivery'
     where p.id=$2`, [actorId, projectId]);
  const row = result.rows[0];
  if (row === undefined || row.trackerSecretPurpose !== 'tracker_read') return null;
  return {...row,
    trackerCredentialRef: {id: row.trackerSecretId, purpose: 'tracker_read', locator: row.trackerSecretLocator},
    agentCredentialRef: row.agentSecretId === null || row.agentSecretLocator === null ? null
      : {id: row.agentSecretId, purpose: 'agent_delivery', locator: row.agentSecretLocator}};
};

export const resolveAgentSourceReferences = async (database: Database, input: Readonly<{
  actorId: string; projectId: string; sourceIds: readonly string[];
}>): Promise<readonly SourceReference[]> => {
  if (input.sourceIds.length === 0) return [];
  const result = await database.query<SourceReference>(
    `select s.id,s.sha256,s.kind,s.provenance,s.content_text as content from project_source_artifacts s
     join project_memberships m on m.project_id=s.project_id and m.actor_id=$1 and m.active=true
     where s.project_id=$2 and s.id=any($3::uuid[])`, [input.actorId, input.projectId, input.sourceIds]);
  const byId = new Map(result.rows.map((row) => [row.id, row]));
  return input.sourceIds.flatMap((id) => byId.get(id) ?? []);
};

/** Holds a project-scoped idempotency lock across the external delivery and canonical receipt/audit commit. */
export const executeAgentSubmissionTransaction = async (database: Database, input: Readonly<{
  workspaceId: string; projectId: string; actorId: string; idempotencyKey: string; correlationId: string;
  role: string; itemId: string; observedVersion: string; sourceCount: number;
  notification: MessengerDeliveryInput;
}>, submit: () => Promise<Readonly<{deliveryReference: string}>>): Promise<Readonly<{
  status: 'completed' | 'duplicate'; deliveryReference: string;
}>> => {
  const client = await database.connect();
  try {
    await client.query('begin');
    await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [input.idempotencyKey]);
    const existing = await client.query<{deliveryReference: string}>(
      `select result_reference as "deliveryReference" from command_receipts
       where idempotency_key=$1 and command_type='agent.submit'`, [input.idempotencyKey]);
    if (existing.rows[0] !== undefined) {
      await client.query('rollback');
      return {status: 'duplicate', deliveryReference: existing.rows[0].deliveryReference};
    }
    const delivered = await submit();
    const occurredAt = new Date().toISOString();
    await client.query(
      `insert into command_receipts(project_id,actor_id,idempotency_key,command_type,result_reference,occurred_at)
       values($1,$2,$3,'agent.submit',$4,$5)`,
      [input.projectId,input.actorId,input.idempotencyKey,delivered.deliveryReference,occurredAt]);
    await client.query(
      `insert into audit_events(workspace_id,project_id,actor_id,action,target_reference,correlation_id,details,occurred_at)
       values($1,$2,$3,'agent.submit',$4,$5,$6,$7)`,
      [input.workspaceId,input.projectId,input.actorId,input.itemId,input.correlationId,
        JSON.stringify({role: input.role, observedVersion: input.observedVersion, sourceCount: input.sourceCount}),occurredAt]);
    await client.query(
      `insert into outbox_events(project_id,topic,idempotency_key,payload,available_at)
       values($1,'messenger-notification',$2,$3,$4) on conflict(idempotency_key) do nothing`,
      [input.projectId,input.notification.idempotencyKey,JSON.stringify({message: input.notification}),occurredAt]);
    await client.query('commit');
    return {status: 'completed', deliveryReference: delivered.deliveryReference};
  } catch (error) { await client.query('rollback'); throw error; }
  finally { client.release(); }
};
