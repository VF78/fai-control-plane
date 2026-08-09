import {createHash} from 'node:crypto';
import {canonicalJson, containsHighConfidenceSecretContent, type CommandResult} from './index.ts';

export const sourceArtifactMediaTypes = [
  'text/plain',
  'text/markdown',
  'application/json'
] as const;
export type SourceArtifactMediaType = (typeof sourceArtifactMediaTypes)[number];

export type SourceArtifact = Readonly<{
  id: string;
  projectId: string;
  name: string;
  mediaType: SourceArtifactMediaType;
  content: string;
  sizeBytes: number;
  sha256: string;
  provenance: Readonly<{
    kind: 'manager_note' | 'manager_upload';
    label: string;
    capturedAt: string;
  }>;
  version: 1;
}>;

export type PlanEvidence =
  | Readonly<{
      kind: 'citation';
      artifactId: string;
      locator:
        | Readonly<{kind: 'whole_artifact'}>
        | Readonly<{kind: 'line_range'; startLine: number; endLine: number}>
        | Readonly<{kind: 'json_pointer'; pointer: string}>;
    }>
  | Readonly<{kind: 'assumption'; statement: string}>;

export type ProjectPlanDefinition = Readonly<{
  title: string;
  outcomes: readonly Readonly<{
    key: string;
    title: string;
    weight: number;
    evidence: PlanEvidence;
  }>[];
  milestones: readonly Readonly<{
    key: string;
    title: string;
    checkpoint: string;
    targetAt: string | null;
    evidence: PlanEvidence;
  }>[];
  risks: readonly Readonly<{
    key: string;
    statement: string;
    mitigation: string;
    evidence: PlanEvidence;
  }>[];
  tasks: readonly Readonly<{
    key: string;
    title: string;
    outcomeKeys: readonly string[];
    milestoneKey: string;
    dependsOn: readonly string[];
    acceptanceEvidence: readonly Readonly<{
      description: string;
      evidence: PlanEvidence;
    }>[];
  }>[];
}>;

export type ProjectPlan = Readonly<{
  id: string;
  projectId: string;
  revision: number;
  state: 'draft' | 'approved';
  definition: ProjectPlanDefinition;
  contentHash: string;
  approvedVersion: number | null;
  approvedByActorId: string | null;
  approvedAt: string | null;
}>;

export type ProjectPlanSimulation = Readonly<{
  simulationHash: string;
  planHash: string;
  readyForApproval: boolean;
  protocol: Readonly<{
    state: 'ready' | 'not_configured' | 'invalid';
    protocolId: string | null;
    simulationHash: string | null;
  }>;
  capabilities: Readonly<{
    canEdit: boolean;
    canApprove: boolean;
  }>;
  blockers: readonly string[];
  warnings: readonly string[];
}>;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const keyPattern = /^[a-z][a-z0-9_-]{0,47}$/;
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const text = (value: unknown, max: number) =>
  typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= max;
const invalid = <T>(message: string): CommandResult<T> => ({
  ok: false,
  error: {code: 'INVALID_COMMAND', message}
});
const secretKey = (key: string) => {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return ['password', 'passwd', 'token', 'secret', 'secrets', 'apikey', 'privatekey', 'credential', 'credentials', 'authorization'].includes(normalized) ||
    ['password', 'token', 'secret', 'apikey', 'privatekey'].some((suffix) => normalized.endsWith(suffix));
};
const containsStructuredSecret = (value: unknown): boolean => {
  if (typeof value === 'string') {
    if (containsHighConfidenceSecretContent(value)) return true;
    const trimmed = value.trim();
    if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return false;
    try { return containsStructuredSecret(JSON.parse(trimmed)); } catch { return false; }
  }
  if (Array.isArray(value)) return value.some(containsStructuredSecret);
  if (!isObject(value)) return false;
  return Object.entries(value).some(([key, nested]) => secretKey(key) || containsStructuredSecret(nested));
};

export const sourceArtifactDigest = (content: string) =>
  createHash('sha256').update(content, 'utf8').digest('hex');

export const validateSourceArtifact = (value: unknown): CommandResult<SourceArtifact> => {
  if (!isObject(value) || !exact(value, [
    'id', 'projectId', 'name', 'mediaType', 'content', 'sizeBytes', 'sha256', 'provenance', 'version'
  ])) return invalid('Source artifact shape is invalid.');
  if (!uuid.test(value.id as string) || !uuid.test(value.projectId as string) ||
    !text(value.name, 160) || !sourceArtifactMediaTypes.includes(value.mediaType as SourceArtifactMediaType) ||
    typeof value.content !== 'string' || value.content.includes('\u0000') || Buffer.byteLength(value.content, 'utf8') < 1 ||
    Buffer.byteLength(value.content, 'utf8') > 256 * 1024 || value.sizeBytes !== Buffer.byteLength(value.content, 'utf8') ||
    value.sha256 !== sourceArtifactDigest(value.content) || containsHighConfidenceSecretContent(value.content) ||
    containsHighConfidenceSecretContent(`${value.name}\n${isObject(value.provenance) ? String(value.provenance.label ?? '') : ''}`) || value.version !== 1 || !isObject(value.provenance) ||
    !exact(value.provenance, ['kind', 'label', 'capturedAt']) ||
    !['manager_note', 'manager_upload'].includes(value.provenance.kind as string) || !text(value.provenance.label, 160)) {
    return invalid('Source artifact metadata does not match its bounded content.');
  }
  try {
    if (new Date(value.provenance.capturedAt as string).toISOString() !== value.provenance.capturedAt) {
      return invalid('Source artifact provenance timestamp is invalid.');
    }
  } catch { return invalid('Source artifact provenance timestamp is invalid.'); }
  if (value.mediaType === 'application/json') {
    try {
      if (containsStructuredSecret(JSON.parse(value.content))) return invalid('JSON source artifact contains secret-like fields or values.');
    } catch { return invalid('JSON source artifact content is invalid.'); }
  }
  return {ok: true, value: value as unknown as SourceArtifact};
};

const evidence = (value: unknown): value is PlanEvidence => {
  if (!isObject(value)) return false;
  if (value.kind === 'assumption') return exact(value, ['kind', 'statement']) && text(value.statement, 500);
  if (value.kind !== 'citation' || !exact(value, ['kind', 'artifactId', 'locator']) ||
    !uuid.test(value.artifactId as string) || !isObject(value.locator)) return false;
  if (value.locator.kind === 'whole_artifact') return exact(value.locator, ['kind']);
  if (value.locator.kind === 'line_range') return exact(value.locator, ['kind', 'startLine', 'endLine']) &&
    Number.isSafeInteger(value.locator.startLine) && Number.isSafeInteger(value.locator.endLine) &&
    (value.locator.startLine as number) > 0 && (value.locator.endLine as number) >= (value.locator.startLine as number) &&
    (value.locator.endLine as number) <= 100_000;
  return value.locator.kind === 'json_pointer' && exact(value.locator, ['kind', 'pointer']) &&
    typeof value.locator.pointer === 'string' && value.locator.pointer.startsWith('/') && value.locator.pointer.length <= 500 &&
    !/~(?![01])/u.test(value.locator.pointer);
};

export const validateProjectPlanDefinition = (value: unknown): CommandResult<ProjectPlanDefinition> => {
  if (!isObject(value) || !exact(value, ['title', 'outcomes', 'milestones', 'risks', 'tasks']) || !text(value.title, 160) ||
    !Array.isArray(value.outcomes) || value.outcomes.length < 5 || value.outcomes.length > 10 ||
    !Array.isArray(value.milestones) || value.milestones.length < 1 || value.milestones.length > 20 ||
    !Array.isArray(value.risks) || value.risks.length < 1 || value.risks.length > 30 ||
    !Array.isArray(value.tasks) || value.tasks.length < 1 || value.tasks.length > 60) {
    return invalid('Plan must contain 5–10 outcomes and bounded milestones, risks and tasks.');
  }
  if (containsStructuredSecret(value)) return invalid('Plan content must not contain secret-like fields or values.');
  const outcomes = value.outcomes;
  const milestones = value.milestones;
  const tasks = value.tasks;
  const validKey = (candidate: unknown) => typeof candidate === 'string' && keyPattern.test(candidate);
  if (outcomes.some((item) => !isObject(item) || !exact(item, ['key', 'title', 'weight', 'evidence']) ||
    !validKey(item.key) || !text(item.title, 240) || !Number.isSafeInteger(item.weight) ||
    (item.weight as number) < 1 || (item.weight as number) > 100 || !evidence(item.evidence)) ||
    outcomes.reduce((total, item) => total + (item as {weight: number}).weight, 0) !== 100) {
    return invalid('Outcome keys must be unique and weights must total 100.');
  }
  const outcomeKeys = outcomes.map((item) => (item as {key: string}).key);
  if (new Set(outcomeKeys).size !== outcomeKeys.length) return invalid('Outcome keys must be unique.');
  const isoDate = (candidate: unknown) => {
    if (typeof candidate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return false;
    try { return new Date(`${candidate}T00:00:00.000Z`).toISOString().slice(0, 10) === candidate; } catch { return false; }
  };
  if (milestones.some((item) => !isObject(item) || !exact(item, ['key', 'title', 'checkpoint', 'targetAt', 'evidence']) ||
    !validKey(item.key) || !text(item.title, 240) || !text(item.checkpoint, 500) ||
    !(item.targetAt === null || isoDate(item.targetAt)) ||
    !evidence(item.evidence))) return invalid('Milestone shape is invalid.');
  const milestoneKeys = milestones.map((item) => (item as {key: string}).key);
  if (new Set(milestoneKeys).size !== milestoneKeys.length) return invalid('Milestone keys must be unique.');
  if (value.risks.some((item) => !isObject(item) || !exact(item, ['key', 'statement', 'mitigation', 'evidence']) ||
    !validKey(item.key) || !text(item.statement, 500) || !text(item.mitigation, 500) || !evidence(item.evidence))) {
    return invalid('Risk shape is invalid.');
  }
  const riskKeys = value.risks.map((item) => (item as {key: string}).key);
  if (new Set(riskKeys).size !== riskKeys.length) return invalid('Risk keys must be unique.');
  if (tasks.some((item) => !isObject(item) || !exact(item, ['key', 'title', 'outcomeKeys', 'milestoneKey', 'dependsOn', 'acceptanceEvidence']) ||
    !validKey(item.key) || !text(item.title, 240) || !Array.isArray(item.outcomeKeys) || item.outcomeKeys.length < 1 ||
    item.outcomeKeys.length > outcomeKeys.length || new Set(item.outcomeKeys).size !== item.outcomeKeys.length ||
    item.outcomeKeys.some((key) => !outcomeKeys.includes(key as string)) || !milestoneKeys.includes(item.milestoneKey as string) ||
    !Array.isArray(item.dependsOn) || !Array.isArray(item.acceptanceEvidence) || item.acceptanceEvidence.length < 1 ||
    item.acceptanceEvidence.length > 12 || item.acceptanceEvidence.some((entry) => !isObject(entry) ||
      !exact(entry, ['description', 'evidence']) || !text(entry.description, 500) || !evidence(entry.evidence)))) {
    return invalid('Task graph or acceptance evidence is invalid.');
  }
  const taskKeys = tasks.map((item) => (item as {key: string}).key);
  if (new Set(taskKeys).size !== taskKeys.length) return invalid('Task keys must be unique.');
  const dependencies = new Map(tasks.map((item) => [
    (item as {key: string}).key,
    (item as {dependsOn: unknown[]}).dependsOn
  ]));
  if ([...dependencies].some(([key, deps]) => new Set(deps).size !== deps.length || deps.some((dep) => dep === key || !taskKeys.includes(dep as string)))) {
    return invalid('Task dependencies must reference other unique task keys.');
  }
  const visiting = new Set<string>(); const visited = new Set<string>();
  const cyclic = (key: string): boolean => {
    if (visiting.has(key)) return true;
    if (visited.has(key)) return false;
    visiting.add(key);
    for (const dep of dependencies.get(key) ?? []) if (cyclic(dep as string)) return true;
    visiting.delete(key); visited.add(key); return false;
  };
  if (taskKeys.some(cyclic)) return invalid('Task dependency graph must be acyclic.');
  return {ok: true, value: value as unknown as ProjectPlanDefinition};
};

export const hashProjectPlanDefinition = (definition: ProjectPlanDefinition) =>
  createHash('sha256').update(canonicalJson(definition as never)).digest('hex');

export const simulateProjectPlan = (input: Readonly<{
  definition: unknown;
  citationsValid: boolean;
  canEdit: boolean;
  canApprove: boolean;
  protocol: Readonly<{protocolId: string; simulationHash: string; valid: boolean}> | null;
}>): ProjectPlanSimulation => {
  const plan = validateProjectPlanDefinition(input.definition);
  const blockers = [
    ...(plan.ok ? [] : [plan.error.message]),
    ...(input.citationsValid ? [] : ['Одна или несколько цитат не подтверждены источниками этого проекта.']),
    ...(input.canApprove ? [] : ['У оператора нет роли Product Owner для утверждения плана.'])
  ];
  const protocol = input.protocol === null
    ? {state: 'not_configured' as const, protocolId: null, simulationHash: null}
    : {state: input.protocol.valid ? 'ready' as const : 'invalid' as const, protocolId: input.protocol.protocolId, simulationHash: input.protocol.simulationHash};
  const facts = {
    planHash: plan.ok ? hashProjectPlanDefinition(plan.value) : '',
    readyForApproval: blockers.length === 0,
    protocol,
    capabilities: {canEdit: input.canEdit, canApprove: input.canApprove},
    blockers,
    warnings: protocol.state === 'not_configured'
      ? ['Протокол delivery ещё не настроен; план можно утвердить, но исполнение потребует отдельной настройки.']
      : protocol.state === 'invalid' ? ['Текущий протокол delivery не проходит проверку готовности.'] : []
  };
  return {
    simulationHash: createHash('sha256').update(canonicalJson(facts as never)).digest('hex'),
    ...facts
  };
};
