import {describe, expect, it} from 'vitest';
import {deterministicProjectPlanUuid, hashProjectPlanSourceManifest, simulateProjectPlan, sourceArtifactDigest, validateProjectPlanDefinition, validateSourceArtifact} from './project-plan';

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
    const artifact = {id: '10000000-0000-4000-8000-000000000001', projectId: '10000000-0000-4000-8000-000000000002', name: 'Интервью', mediaType: 'text/plain', content, sizeBytes: Buffer.byteLength(content), sha256: sourceArtifactDigest(content), provenance: {kind: 'manager_note', label: 'Встреча', capturedAt: '2026-08-09T10:00:00.000Z'}, version: 1};
    expect(validateSourceArtifact(artifact)).toMatchObject({ok: true});
    expect(validateSourceArtifact({...artifact, sha256: '0'.repeat(64)})).toMatchObject({ok: false});
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
