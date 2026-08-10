import {describe, expect, it} from 'vitest';
import {deterministicProjectPlanUuid, generateProjectPlanDraft, hashProjectPlanSourceManifest, projectDossierReadiness, simulateProjectPlan, sourceArtifactDigest, validateProjectPlanDefinition, validateSourceArtifact} from './project-plan';

const assumption = {kind: 'assumption' as const, statement: 'Требует проверки Product Owner'};
const definition = {
  title: 'План запуска',
  outcomes: Array.from({length: 5}, (_, index) => ({key: `outcome_${index + 1}`, title: `Результат ${index + 1}`, weight: 20, evidence: assumption})),
  milestones: [{key: 'm1', title: 'Контрольная точка', checkpoint: 'Product Owner принимает результат', targetAt: null, evidence: assumption}],
  risks: [{key: 'r1', statement: 'Не подтверждены исходные данные', mitigation: 'Запросить подтверждение', evidence: assumption}],
  tasks: [{key: 't1', title: 'Проверить исходные данные', outcomeKeys: ['outcome_1'], milestoneKey: 'm1', dependsOn: [], acceptanceEvidence: [{description: 'Решение Product Owner', evidence: assumption}]}]
};

describe('project plan', () => {
  it('validates bounded artifacts and rejects mismatched hashes', () => {
    const content = 'Строка 1\nСтрока 2';
    const artifact = {id: '10000000-0000-4000-8000-000000000001', projectId: '10000000-0000-4000-8000-000000000002', name: 'Интервью', sourceKind: 'client_requirements', mediaType: 'text/plain', content, sizeBytes: Buffer.byteLength(content), sha256: sourceArtifactDigest(content), provenance: {kind: 'manager_note', label: 'Встреча', capturedAt: '2026-08-09T10:00:00.000Z'}, version: 1};
    expect(validateSourceArtifact(artifact)).toMatchObject({ok: true});
    expect(validateSourceArtifact({...artifact, sha256: '0'.repeat(64)})).toMatchObject({ok: false});
    expect(validateSourceArtifact({...artifact, sourceKind: 'passport'})).toMatchObject({ok: false});
    const invalidJson = '{';
    expect(validateSourceArtifact({...artifact, mediaType: 'application/json', content: invalidJson, sizeBytes: Buffer.byteLength(invalidJson), sha256: sourceArtifactDigest(invalidJson)})).toMatchObject({ok: false});
    for (const payload of [
      {token: 'short-but-secret'}, {apiKey: 'short-but-secret'}, {password: 'short-but-secret'}, {secret: 'short-but-secret'},
      {nested: {privateKey: 'short-but-secret'}}, {note: '-----BEGIN PRIVATE KEY-----\nabc'}
    ]) {
      const json = JSON.stringify(payload);
      expect(validateSourceArtifact({...artifact, mediaType: 'application/json', content: json, sizeBytes: Buffer.byteLength(json), sha256: sourceArtifactDigest(json)})).toMatchObject({ok: false});
    }
    const harmless = JSON.stringify({note: 'Уточнить, где хранится токен, без передачи значения'});
    expect(validateSourceArtifact({...artifact, mediaType: 'application/json', content: harmless, sizeBytes: Buffer.byteLength(harmless), sha256: sourceArtifactDigest(harmless)})).toMatchObject({ok: true});
  });

  it('requires five to ten outcomes totaling 100 and an acyclic graph', () => {
    expect(validateProjectPlanDefinition(definition)).toMatchObject({ok: true});
    expect(validateProjectPlanDefinition({...definition, outcomes: definition.outcomes.slice(0, 4)})).toMatchObject({ok: false});
    expect(validateProjectPlanDefinition({...definition, tasks: [{...definition.tasks[0], dependsOn: ['t1']}]})).toMatchObject({ok: false});
    expect(validateProjectPlanDefinition({...definition, milestones: [{...definition.milestones[0], targetAt: '2026-99-99'}]})).toMatchObject({ok: false});
    for (const title of ['{"apiKey":"hidden"}', '{"password":"hidden"}', 'token: hidden-value', '-----BEGIN PRIVATE KEY-----\nabc']) {
      expect(validateProjectPlanDefinition({...definition, title})).toMatchObject({ok: false});
    }
    expect(validateProjectPlanDefinition({...definition, title: 'Обсудить хранение токена без значения'})).toMatchObject({ok: true});
    const badPointer = {kind: 'citation' as const, artifactId: '10000000-0000-4000-8000-000000000001', locator: {kind: 'json_pointer' as const, pointer: '/bad~2token'}};
    expect(validateProjectPlanDefinition({...definition, outcomes: definition.outcomes.map((item, index) => index === 0 ? {...item, evidence: badPointer} : item)})).toMatchObject({ok: false});
  });

  it('reports protocol readiness without treating it as generated plan evidence', () => {
    expect(simulateProjectPlan({definition, citationsValid: true, canEdit: true, canApprove: true, protocol: null})).toMatchObject({readyForApproval: true, protocol: {state: 'not_configured'}, warnings: [expect.any(String)]});
  });

  it('assembles a deterministic editable scaffold from exact bounded evidence and explicit assumptions', () => {
    const content = '# Цель\nСократить время проверки\nПодтвердить критерии\nЗафиксировать границы';
    const artifact = validateSourceArtifact({id: '10000000-0000-4000-8000-000000000001', projectId: '10000000-0000-4000-8000-000000000002', name: 'Brief', sourceKind: 'project_passport', mediaType: 'text/markdown', content,
      sizeBytes: Buffer.byteLength(content), sha256: sourceArtifactDigest(content), provenance: {kind: 'manager_note', label: 'PO', capturedAt: '2026-08-09T10:00:00.000Z'}, version: 1});
    if (!artifact.ok) throw new Error('fixture');
    const generated = generateProjectPlanDraft([artifact.value]);
    expect(generated).toMatchObject({ok: true, value: {outcomes: {length: 5}, milestones: {length: 2}, risks: {length: 2}, tasks: {length: 5}}});
    if (!generated.ok) throw new Error('generation');
    expect(generated.value.outcomes.reduce((sum, outcome) => sum + outcome.weight, 0)).toBe(100);
    expect(generated.value.outcomes.slice(0, 4).every(({evidence}) => evidence.kind === 'citation')).toBe(true);
    expect(generated.value.outcomes[4]?.evidence).toMatchObject({kind: 'assumption'});
    expect(generateProjectPlanDraft([artifact.value])).toEqual(generated);
    expect(generateProjectPlanDraft([])).toMatchObject({ok: false});

    const repeatedContent = Array.from({length: 100}, () => 'Одинаковый факт').join('\n');
    const repeated = validateSourceArtifact({...artifact.value, content: repeatedContent, sizeBytes: Buffer.byteLength(repeatedContent), sha256: sourceArtifactDigest(repeatedContent)});
    if (!repeated.ok) throw new Error('repeated fixture');
    const deduplicated = generateProjectPlanDraft([repeated.value]); if (!deduplicated.ok) throw new Error('deduplicated generation');
    expect(deduplicated.value.outcomes.filter(({evidence}) => evidence.kind === 'citation')).toHaveLength(1);

    const scalarContent = '"корневое значение"';
    const scalar = validateSourceArtifact({...artifact.value, mediaType: 'application/json', content: scalarContent, sizeBytes: Buffer.byteLength(scalarContent), sha256: sourceArtifactDigest(scalarContent)});
    if (!scalar.ok) throw new Error('scalar fixture');
    const scalarPlan = generateProjectPlanDraft([scalar.value]);
    expect(scalarPlan).toMatchObject({ok: true});
    if (scalarPlan.ok) expect(scalarPlan.value.outcomes[0]?.evidence).toMatchObject({kind: 'citation', locator: {kind: 'line_range'}});
  });

  it('round-robins candidates across sources with a generic stable title', () => {
    const projectId = '10000000-0000-4000-8000-000000000003';
    const makeArtifact = (id: string, name: string, content: string) => validateSourceArtifact({id, projectId, name, sourceKind: 'other', mediaType: 'text/plain', content,
      sizeBytes: Buffer.byteLength(content), sha256: sourceArtifactDigest(content), provenance: {kind: 'manager_note', label: 'PO', capturedAt: '2026-08-09T10:00:00.000Z'}, version: 1});
    const long = makeArtifact('10000000-0000-4000-8000-000000000004', 'Альфа', Array.from({length: 20}, (_, index) => `Факт Альфа ${index + 1}`).join('\n'));
    const short = makeArtifact('10000000-0000-4000-8000-000000000005', 'Бета', 'Факт Бета');
    if (!long.ok || !short.ok) throw new Error('fixtures');
    const generated = generateProjectPlanDraft([short.value, long.value]); if (!generated.ok) throw new Error('generation');
    const citedIds = generated.value.outcomes.flatMap(({evidence}) => evidence.kind === 'citation' ? [evidence.artifactId] : []);
    expect(citedIds).toContain(long.value.id); expect(citedIds).toContain(short.value.id);
    expect(generated.value.title).toBe('Черновой план по выбранным источникам');
    expect(generateProjectPlanDraft([long.value, short.value])).toEqual(generated);
  });

  it('reports exactly the missing required dossier categories', () => {
    expect(projectDossierReadiness([])).toMatchObject({ready: false, required: [
      {kind: 'project_passport', present: false, remediation: 'Добавьте источник: паспорт проекта.'},
      {kind: 'client_requirements', present: false, remediation: 'Добавьте источник: требования клиента.'},
      {kind: 'acceptance_method', present: false, remediation: 'Добавьте источник: метод приёмки.'}
    ]});
    expect(projectDossierReadiness([
      {sourceKind: 'project_passport'}, {sourceKind: 'client_requirements'}, {sourceKind: 'acceptance_method'}, {sourceKind: 'other'}
    ])).toMatchObject({ready: true});
  });

  it('depends only on manifest-bound artifact id and content', () => {
    const content = JSON.stringify({result: 'Подтверждённый результат', acceptance: 'Проверка Product Owner'});
    const base = {id: '10000000-0000-4000-8000-000000000006', projectId: '10000000-0000-4000-8000-000000000007', name: 'Исходное имя', sourceKind: 'other', mediaType: 'application/json', content,
      sizeBytes: Buffer.byteLength(content), sha256: sourceArtifactDigest(content), provenance: {kind: 'manager_note', label: 'PO', capturedAt: '2026-08-09T10:00:00.000Z'}, version: 1};
    const original = validateSourceArtifact(base); const metadataChanged = validateSourceArtifact({...base, name: 'Другое имя', mediaType: 'text/plain'});
    if (!original.ok || !metadataChanged.ok) throw new Error('fixtures');
    expect(generateProjectPlanDraft([metadataChanged.value])).toEqual(generateProjectPlanDraft([original.value]));
  });
});

describe('project plan materialization identity', () => {
  it('derives stable, resource-separated UUIDs and a canonical frozen-manifest hash', () => {
    const versionId = '10000000-0000-4000-8000-000000000001';
    expect(deterministicProjectPlanUuid(versionId, 'work_item', 'task-a'))
      .toBe(deterministicProjectPlanUuid(versionId, 'work_item', 'task-a'));
    expect(deterministicProjectPlanUuid(versionId, 'work_item', 'task-a'))
      .not.toBe(deterministicProjectPlanUuid(versionId, 'milestone', 'task-a'));
    expect(hashProjectPlanSourceManifest([{artifactId: versionId, version: 1, sha256: 'a'.repeat(64)}]))
      .toMatch(/^[0-9a-f]{64}$/);
  });
});
