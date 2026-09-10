import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {Database} from './runtime.ts';

/** Provider-neutral observed facts, never an execution lifecycle or billing record. */
export type ExecutionUsage = Readonly<{
  provider: string; sessionReference: string; parentSessionReference: string | null;
  itemId: string | null;
  contexts: readonly Readonly<{model: string | null; effort: string | null}>[];
  totals: Readonly<{input: number | null; cachedInput: number | null; output: number | null;
    reasoningOutput: number | null; total: number | null}>;
  completeness: 'incomplete' | 'unknown'; reasons: readonly string[];
  // Cached input/reasoning output are subsets. Parent/child samples are not additive.
  aggregation: 'unknown'; provenance: 'native-session-metadata';
}>;
const keys = ['input','cachedInput','output','reasoningOutput','total'] as const;
const reasonCodes = new Set(['session-coverage-unknown','identity-conflict','parent-identity-unknown',
  'malformed-envelope','malformed-event','oversized-event','context-partial','context-missing','contexts-truncated',
  'usage-partial','usage-invalid','usage-decreased','usage-missing','source-unavailable',
  'child-inclusion-unknown','auxiliary-usage-unknown','task-unattributed']);
const identifier = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_.:/-]{1,512}$/.test(v);
const object = (v: unknown): Record<string,unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string,unknown> : {};
const canonicalContexts = (contexts: ExecutionUsage['contexts']) =>
  [...new Map(contexts.map(c => [JSON.stringify([c.model,c.effort]),{model:c.model,effort:c.effort}])).entries()]
    .sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([,c]) => c);

/** Reconstruct the allowlisted shape: structural typing must not serialize extra raw fields.
 * Unknown diagnostics are rejected; they could contain arbitrary messages or credentials.
 */
export const normalizeExecutionUsage = (input: unknown): ExecutionUsage | null => {
  const v = object(input); const t = object(v.totals);
  if (!identifier(v.provider) || !identifier(v.sessionReference) ||
    !(v.parentSessionReference == null || identifier(v.parentSessionReference)) ||
    !(v.itemId == null || identifier(v.itemId)) ||
    !Array.isArray(v.contexts) || v.contexts.length > 32 ||
    !v.contexts.every(c => {const context=object(c); return (context.model === null || identifier(context.model)) &&
      (context.effort === null || identifier(context.effort));}) ||
    !keys.every(k => t[k] == null || Number.isSafeInteger(t[k]) && (t[k] as number) >= 0) ||
    !['incomplete','unknown'].includes(String(v.completeness)) || !Array.isArray(v.reasons) || v.reasons.length > 32 ||
    !v.reasons.every(r => typeof r === 'string' && reasonCodes.has(r)) ||
    v.aggregation !== 'unknown' || v.provenance !== 'native-session-metadata') return null;
  const totals = Object.fromEntries(keys.map(k => [k,t[k] ?? null])) as ExecutionUsage['totals'];
  if (totals.cachedInput !== null && totals.input !== null && totals.cachedInput > totals.input ||
    totals.reasoningOutput !== null && totals.output !== null && totals.reasoningOutput > totals.output ||
    totals.input !== null && totals.output !== null && totals.total !== null && totals.input + totals.output !== totals.total) return null;
  const reasons = new Set<string>([...v.reasons,'session-coverage-unknown','child-inclusion-unknown','auxiliary-usage-unknown']);
  if (keys.some(k => totals[k] === null)) reasons.add('usage-partial');
  if (keys.every(k => totals[k] === null)) reasons.add('usage-missing');
  if (v.itemId == null) reasons.add('task-unattributed');
  const contexts = canonicalContexts(v.contexts as ExecutionUsage['contexts']);
  if (contexts.length === 0) reasons.add('context-missing');
  if (contexts.some(c => c.model === null || c.effort === null)) reasons.add('context-partial');
  return {provider:v.provider,sessionReference:v.sessionReference,parentSessionReference:v.parentSessionReference ?? null,
    itemId:v.itemId ?? null,contexts,totals,completeness:keys.every(k => totals[k] === null) ? 'unknown' : 'incomplete',
    reasons:[...reasons].sort(),aggregation:'unknown',provenance:'native-session-metadata'} as ExecutionUsage;
};

/** Keep coherent cumulative samples, never component-wise maxima or sums. Missing optional
 * identity may be enriched, but contradictory known identities cannot retarget a session.
 */
const mergeExecutionUsage = (prior: ExecutionUsage | null, next: ExecutionUsage): ExecutionUsage | null => {
  if (prior === null) return next;
  if (prior.provider !== next.provider || prior.sessionReference !== next.sessionReference ||
    prior.itemId !== null && next.itemId !== null && prior.itemId !== next.itemId ||
    prior.parentSessionReference !== null && next.parentSessionReference !== null &&
      prior.parentSessionReference !== next.parentSessionReference) return null;
  const decreased = keys.some(k => prior.totals[k] !== null && next.totals[k] !== null && next.totals[k]! < prior.totals[k]!);
  const missing = keys.some(k => prior.totals[k] !== null && next.totals[k] === null);
  const totals = decreased || missing ? prior.totals : next.totals;
  const contexts = canonicalContexts([...prior.contexts,...next.contexts]);
  return {...next,itemId:prior.itemId ?? next.itemId,parentSessionReference:prior.parentSessionReference ?? next.parentSessionReference,
    totals,contexts:contexts.slice(0,32),completeness:keys.every(k => totals[k] === null) ? 'unknown' : 'incomplete',
    reasons:[...new Set([...prior.reasons,...next.reasons,...(decreased ? ['usage-decreased'] : []),
      ...(missing ? ['usage-partial'] : []),...(contexts.length > 32 ? ['contexts-truncated'] : [])])].sort()};
};
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export type ExecutionUsageWriteResult = 'recorded' | 'duplicate' | 'invalid' | 'denied' | 'conflict' | 'unavailable';

/** Internal observation command: workspace/project scope comes from trusted composition.
 * Existing project/session advisory lock serializes read/merge/write; receipt uniqueness
 * commits exactly one audit revision. Item identity is checked against confirmed tracker facts.
 * Audit is append-only; its latest revision is the logical session upsert. Only changed,
 * bounded metadata is retained with existing receipts/audit; no new retention lifecycle.
 * Failure is a result, not an exception that can enter task recovery.
 */
export const recordExecutionUsage = async (database: Database, scope: Readonly<{workspaceId: string; projectId: string}>,
  observation: unknown): Promise<ExecutionUsageWriteResult> => {
  const normalized = normalizeExecutionUsage(observation);
  if (normalized === null) return 'invalid';
  let client: PoolClient | undefined;
  try {
    client = await database.connect();
    await client.query('begin');
    await client.query("set local statement_timeout='2000ms'");
    await client.query("set local lock_timeout='250ms'");
    const reference = `usage:${digest([normalized.provider,normalized.sessionReference])}`;
    await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify([scope.projectId,reference])]);
    const authorized = await client.query(`select 1 from projects p where p.id=$1 and p.workspace_id=$2
      and ($3::text is null or exists(select 1 from tracker_bindings b
        join lateral (select facts from tracker_snapshots where binding_id=b.id and error_code is null
          order by observed_at desc limit 1) s on true
        cross join lateral jsonb_array_elements(s.facts->'items') fact
        where b.project_id=p.id and b.enabled=true and fact->>'itemId'=$3))`,
    [scope.projectId,scope.workspaceId,normalized.itemId]);
    if (authorized.rows.length !== 1) { await client.query('rollback'); return 'denied'; }
    const existing = await client.query<{details: {usage: unknown; revision: number}}>(
      `select details from audit_events where project_id=$1 and workspace_id=$2
       and action='agent.usage.observed' and target_reference=$3
       order by (details->>'revision')::bigint desc limit 1`, [scope.projectId,scope.workspaceId,reference]);
    const previous = existing.rows[0]?.details;
    const prior = previous === undefined ? null : normalizeExecutionUsage(previous.usage);
    if (previous !== undefined && (prior === null || !Number.isSafeInteger(previous.revision) || previous.revision < 1 ||
      previous.revision >= Number.MAX_SAFE_INTEGER)) { await client.query('rollback'); return 'unavailable'; }
    const usage = mergeExecutionUsage(prior,normalized);
    if (usage === null) { await client.query('rollback'); return 'conflict'; }
    if (prior !== null && JSON.stringify(prior) === JSON.stringify(usage)) {
      await client.query('rollback'); return 'duplicate';
    }
    const revision = (previous?.revision ?? 0) + 1;
    const key = `agent.usage:${digest([scope.workspaceId,scope.projectId,reference,revision,usage])}`;
    const occurredAt = new Date().toISOString();
    const receipt = await client.query(`insert into command_receipts(project_id,idempotency_key,command_type,result_reference,occurred_at)
      values($1,$2,'agent.usage.observe',$3,$4) on conflict(idempotency_key) do nothing`,
    [scope.projectId,key,reference,occurredAt]);
    if (receipt.rowCount !== 1) { await client.query('rollback'); return 'duplicate'; }
    await client.query(`insert into audit_events(workspace_id,project_id,action,target_reference,correlation_id,details,occurred_at)
      values($1,$2,'agent.usage.observed',$3,$4,$5,$6)`,
    [scope.workspaceId,scope.projectId,reference,key,JSON.stringify({revision,usage}),occurredAt]);
    await client.query('commit'); return 'recorded';
  } catch {
    try { await client?.query('rollback'); } catch { /* No raw database/provider error enters business records. */ }
    return 'unavailable';
  } finally { try { client?.release(); } catch { /* Optional observation must not block processing. */ } }
};

export type ExecutionUsageSummary = Readonly<{combinedTotal:number|null; taskTotals:Readonly<Record<string,number|null>>}>;

/** Lower bound of observed tokens. Cumulative revisions are merged, related sessions
 * contribute their maximum (child inclusion is unknown), independent families add.
 * No task lifecycle filter: QA, rework and unsuccessful attempts still consume tokens.
 */
export const summarizeExecutionUsage = (observations: readonly ExecutionUsage[]): ExecutionUsageSummary => {
  const sessions = new Map<string,ExecutionUsage>();
  const key = (provider:string,reference:string) => JSON.stringify([provider,reference]);
  for (const observation of observations) {
    const normalized = normalizeExecutionUsage(observation);
    if (normalized === null) continue;
    const id = key(normalized.provider,normalized.sessionReference);
    const prior = sessions.get(id);
    const merged = mergeExecutionUsage(prior ?? null,normalized);
    sessions.set(id,merged ?? {...prior!,reasons:[...prior!.reasons,'identity-conflict']});
  }
  const parents = new Map<string,string>();
  const root = (id:string):string => { const parent=parents.get(id); if(parent===undefined)return id; const result=root(parent);parents.set(id,result);return result; };
  const join = (a:string,b:string) => { const left=root(a),right=root(b);if(left!==right)parents.set(left,right); };
  for (const [id,session] of sessions) if(session.parentSessionReference!==null)join(id,key(session.provider,session.parentSessionReference));
  const families = new Map<string,ExecutionUsage[]>();
  for(const [id,session] of sessions){const family=root(id);families.set(family,[...(families.get(family)??[]),session]);}
  let combinedTotal:number|null=null;
  const providerTotals=new Map<string,number>();
  const uncertainTotals=new Map<string,number>();
  const taskTotals:Record<string,number|null>=Object.create(null);
  const add=(a:number|null,b:number)=>a===null?b:a+b;
  for(const family of families.values()){
    if(family.some(s=>s.reasons.includes('identity-conflict')))continue;
    const totals=family.flatMap(s=>s.totals.total===null?[]:[s.totals.total]);
    if(totals.length===0)continue;
    const total=Math.max(...totals);
    const provider=family[0]!.provider;
    if(family.some(s=>s.reasons.includes('parent-identity-unknown'))){
      uncertainTotals.set(provider,Math.max(uncertainTotals.get(provider)??0,total));continue;
    }
    providerTotals.set(provider,(providerTotals.get(provider)??0)+total);
    const item=family[0]!.itemId;
    if(item!==null && family.every(s=>s.itemId===item && !s.reasons.includes('parent-identity-unknown')))
      taskTotals[item]=add(taskTotals[item]??null,total);
  }
  for(const provider of new Set([...providerTotals.keys(),...uncertainTotals.keys()]))
    combinedTotal=add(combinedTotal,Math.max(providerTotals.get(provider)??0,uncertainTotals.get(provider)??0));
  for(const item of Object.keys(taskTotals))if(!Number.isSafeInteger(taskTotals[item]))taskTotals[item]=null;
  return {combinedTotal:Number.isSafeInteger(combinedTotal)?combinedTotal:null,taskTotals};
};

/** Membership-scoped latest samples, never sums of audit history or parent/child totals.
 * Task identity stays on each session; absent/unattributed/auxiliary usage is not zero.
 */
export const readExecutionUsage = async (database: Database, actorId: string, projectId: string) => {
  const sessions: Array<ExecutionUsage & {observedAt:string}> = [];
  try {
    const result = await database.query<{usage: unknown; observedAt: Date}>(`select distinct on (a.target_reference)
      a.details->'usage' as usage,a.occurred_at as "observedAt" from audit_events a
      join projects p on p.id=a.project_id and p.workspace_id=a.workspace_id
      where a.project_id=$2 and a.action='agent.usage.observed' and exists(select 1 from project_memberships m
        join actors actor on actor.id=m.actor_id and actor.workspace_id=p.workspace_id where m.project_id=a.project_id
        and m.actor_id=$1 and m.active=true and actor.enabled=true and m.role in ('project_owner','operator','contributor'))
      order by a.target_reference,(a.details->>'revision')::bigint desc`, [actorId,projectId]);
    let invalid = false;
    for (const row of result.rows) {
      const usage = normalizeExecutionUsage(row.usage);
      if (usage === null || !(row.observedAt instanceof Date) || !Number.isFinite(row.observedAt.getTime())) invalid = true;
      else sessions.push({...usage,observedAt:row.observedAt.toISOString()});
    }
    return {sessions,...summarizeExecutionUsage(sessions),completeness:sessions.length === 0 ? 'unknown' as const : 'incomplete' as const,
      aggregation:'unknown' as const,availability:invalid ? 'partial' as const : 'available' as const};
  } catch {
    return {sessions:[],combinedTotal:null,taskTotals:{} as Readonly<Record<string,number|null>>,completeness:'unknown' as const,aggregation:'unknown' as const,availability:'unavailable' as const};
  }
};

/** Current confirmed tracker facts, independent of task entry channel or local submit receipts. */
export const listExecutionUsageTasks = async (database: Database, scope: Readonly<{
  workspaceId:string;projectId:string;repositoryUrl:string
}>): Promise<readonly {itemId:string;url:string}[]> => {
  const client=await database.connect();
  try {
    await client.query('begin read only');
    await client.query("set local statement_timeout='2000ms'");
    await client.query("set local lock_timeout='250ms'");
    const result = await client.query<{itemId:string;url:string}>(`select fact->>'itemId' as "itemId",fact->>'url' as url
    from projects p join tracker_bindings b on b.project_id=p.id
    join lateral (select facts from tracker_snapshots where binding_id=b.id and error_code is null
      order by observed_at desc limit 1) s on true cross join lateral jsonb_array_elements(s.facts->'items') fact
    where p.id=$1 and p.workspace_id=$2 and b.repository_url=$3 and b.enabled=true`,
    [scope.projectId,scope.workspaceId,scope.repositoryUrl]);
    await client.query('commit');return result.rows;
  } catch {
    await client.query('rollback');throw new Error('execution_usage_tracker_unavailable');
  } finally {client.release();}
};
