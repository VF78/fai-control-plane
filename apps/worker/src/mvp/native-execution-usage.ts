/** Passive Codex JSONL metadata normalization. No filesystem discovery, persistence,
 * task attribution, executor selection or parent/child aggregation lives here.
 */
export type NativeUsageTotals = Readonly<{
  input: number | null;
  /** Included in input, not additional input. */
  cachedInput: number | null;
  output: number | null;
  /** Included in output, not additional output. */
  reasoningOutput: number | null;
  total: number | null;
}>;
export type NativeUsageContext = Readonly<{model: string | null; effort: string | null}>;
export type NativeUsageReason = 'session-coverage-unknown' | 'identity-conflict' | 'parent-identity-unknown' |
  'malformed-envelope' | 'malformed-event' | 'oversized-event' | 'context-partial' | 'context-missing' |
  'contexts-truncated' | 'usage-partial' | 'usage-invalid' | 'usage-decreased' | 'usage-missing' | 'source-unavailable';
export type NativeExecutionUsage = Readonly<{
  sessionReference: string | null;
  parentSessionReference: string | null;
  contexts: readonly NativeUsageContext[];
  latestContext: NativeUsageContext | null;
  totals: NativeUsageTotals;
  completeness: 'incomplete' | 'unknown';
  reasons: readonly NativeUsageReason[];
}>;
const object = (v: unknown): Record<string,unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string,unknown> : {};
const identity = (v: unknown): string | null =>
  typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v) ? v : null;
const label = (v: unknown): string | null =>
  typeof v === 'string' && /^[A-Za-z0-9_.:/-]{1,128}$/.test(v) ? v : null;
const count = (v: unknown): number | null => Number.isSafeInteger(v) && (v as number) >= 0 ? v as number : null;
const emptyTotals = (): NativeUsageTotals => ({input:null,cachedInput:null,output:null,reasoningOutput:null,total:null});
const keys = ['input','cachedInput','output','reasoningOutput','total'] as const;

/** Read only native envelope headers, including the ordinal emitted by newer CLIs.
 * Share this selector with cwd extraction so identity and task linkage cannot diverge.
 */
export const nativeEnvelopeType = (line: string): string | null =>
  /^\s*\{\s*(?:(?:"timestamp"\s*:\s*"[^"\n]*"|"ordinal"\s*:\s*[0-9]+)\s*,\s*)*"type"\s*:\s*"([a-z_]+)"/.exec(line.slice(0,256))?.[1] ?? null;

/** Native envelopes put timestamp/ordinal/type before payload. Select event types before decoding;
 * message/tool envelopes are skipped, never returned. The optional session_meta envelope
 * contributes only session/parent IDs; all remaining metadata fields are discarded.
 *
 * Results describe observed cumulative counters, not complete session consumption. A live,
 * truncated or ephemeral source cannot establish coverage, including auxiliary/child usage.
 */
export const parseNativeUsage = async (lines: AsyncIterable<string> | Iterable<string>): Promise<NativeExecutionUsage> => {
  let sessionReference: string | null = null; let parentSessionReference: string | null = null;
  let identityConflict = false; let totals = emptyTotals(); let threadTotals = emptyTotals();
  let latestContext: NativeUsageContext | null = null;
  const reasons = new Set<NativeUsageReason>(['session-coverage-unknown']);
  const contexts: NativeUsageContext[] = [];
  try {
    for await (const line of lines) {
      if (typeof line !== 'string') { reasons.add('malformed-envelope'); continue; }
      if (line.length > 4_194_304) { reasons.add('oversized-event'); continue; }
      if (line.trim() === '') continue;
      const type = nativeEnvelopeType(line);
      if (!type) { reasons.add('malformed-envelope'); continue; }
      if (!['session_meta','turn_context','event_msg','token_usage_record'].includes(type)) continue;
      // Native token_count puts its discriminator first. Never inspect message contents.
      if (type === 'event_msg' && !/"payload"\s*:\s*\{\s*"type"\s*:\s*"token_count"/.test(line.slice(0,256))) continue;
      let value: Record<string,unknown>;
      try { value = object(JSON.parse(line)); } catch { reasons.add('malformed-event'); continue; }
      const p = object(value.payload);
      if (type === 'session_meta') {
        const next = identity(p.id);
        const parent = identity(object(object(object(p.source).subagent).thread_spawn).parent_thread_id);
        if (object(p.source).subagent !== undefined && parent === null) reasons.add('parent-identity-unknown');
        if (next === null) { reasons.add('malformed-event'); continue; }
        if (sessionReference !== null && (sessionReference !== next || parentSessionReference !== parent)) {
          identityConflict = true; reasons.add('identity-conflict');
        }
        if (!identityConflict) { sessionReference = next; parentSessionReference = parent; }
      } else if (type === 'turn_context') {
        const context = {model:label(p.model),effort:label(p.effort)};
        latestContext = context;
        if (context.model === null || context.effort === null) reasons.add('context-partial');
        if (!contexts.some(c => c.model === context.model && c.effort === context.effort)) {
          if (contexts.length < 32) contexts.push(context); else reasons.add('contexts-truncated');
        }
      } else if (type === 'token_usage_record' || p.type === 'token_count') {
        const threadSample = type === 'token_usage_record';
        // Native per-thread counters survive turn resets. Never add them to the
        // older turn-scoped token_count stream or to individual response usage.
        if (threadSample && (sessionReference === null || p.thread_id !== sessionReference)) {
          reasons.add('usage-invalid'); continue;
        }
        const previous = threadSample ? threadTotals : totals;
        const u = object(threadSample ? p.thread_token_usage : object(p.info).total_token_usage);
        const raw = [u.input_tokens,u.cached_input_tokens,u.output_tokens,u.reasoning_output_tokens,u.total_tokens];
        const next: NativeUsageTotals = {input:count(raw[0]),cachedInput:count(raw[1]),output:count(raw[2]),
          reasoningOutput:count(raw[3]),total:count(raw[4])};
        if (raw.some(v => v !== undefined && v !== null && count(v) === null) ||
          next.input !== null && next.cachedInput !== null && next.cachedInput > next.input ||
          next.output !== null && next.reasoningOutput !== null && next.reasoningOutput > next.output ||
          next.input !== null && next.output !== null && next.total !== null && next.input + next.output !== next.total) {
          reasons.add('usage-invalid'); continue;
        }
        if (keys.some(k => previous[k] !== null && next[k] !== null && next[k]! < previous[k]!)) {
          reasons.add('usage-decreased'); continue;
        }
        if (keys.some(k => next[k] === null)) {
          reasons.add('usage-partial');
          // Preserve a previous coherent sample; do not synthesize a sample by filling gaps.
          if (!threadSample && keys.every(k => totals[k] === null)) totals = next;
          continue;
        }
        if (threadSample) threadTotals = next;
        else totals = next;
      }
    }
  } catch { reasons.add('source-unavailable'); }
  if (threadTotals.total !== null) totals = threadTotals;
  if (contexts.length === 0) reasons.add('context-missing');
  if (keys.every(k => totals[k] === null)) reasons.add('usage-missing');
  // A concatenation of different sessions cannot supply one meaningful session total.
  if (identityConflict) { sessionReference = null; parentSessionReference = null; totals = emptyTotals(); }
  return {sessionReference,parentSessionReference,contexts,latestContext,totals,
    completeness:keys.every(k => totals[k] === null) ? 'unknown' : 'incomplete',reasons:[...reasons].sort()};
};
