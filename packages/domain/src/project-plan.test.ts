import {describe, expect, it} from 'vitest';
import secretContract from './high-confidence-secret-contract.json';
import {containsHighConfidenceSecretContent} from './index';
import {deterministicProjectPlanUuid, hashProjectPlanDefinition, hashProjectPlanSourceManifest, projectDossierReadiness, projectPlanScheduleReadiness, simulateProjectPlan, sourceArtifactDigest, validateAssignedProjectPlanDefinition, validateProjectPlanDefinition, validateSourceArtifact, type ProjectPlanDefinition} from './project-plan';

const assumption = {kind: 'assumption' as const, statement: 'Требует проверки Product Owner'};
const definition: ProjectPlanDefinition = {
  title: 'План запуска',
  outcomes: Array.from({length: 5}, (_, index) => ({key: `outcome_${index + 1}`, title: `Результат ${index + 1}`, weight: 20, evidence: assumption})),
  milestones: [{key: 'm1', title: 'Контрольная точка', checkpoint: 'Product Owner принимает результат', targetAt: null, evidence: assumption}],
  risks: [{key: 'r1', statement: 'Не подтверждены исходные данные', mitigation: 'Запросить подтверждение', evidence: assumption}],
  tasks: [{key: 't1', title: 'Проверить исходные данные', responsibility: {kind: 'project_role', role: 'project_owner'}, outcomeKeys: ['outcome_1'], milestoneKey: 'm1', dependsOn: [], acceptanceEvidence: [{description: 'Решение Product Owner', evidence: assumption}]}]
};

describe('project plan', () => {
  it('enforces the canonical high-confidence outbound secret contract', () => {
    for (const value of secretContract.reject) expect(containsHighConfidenceSecretContent(value)).toBe(true);
    for (const value of secretContract.allow) expect(containsHighConfidenceSecretContent(value)).toBe(false);
  });
  it('validates bounded artifacts and rejects mismatched hashes', () => {
    const content = 'Строка 1\nСтрока 2';
    const artifact = {id: '10000000-0000-4000-8000-000000000001', projectId: '10000000-0000-4000-8000-000000000002', name: 'Интервью', sourceKind: 'client_requirements', mediaType: 'text/plain', content, sizeBytes: Buffer.byteLength(content), sha256: sourceArtifactDigest(content), sourceFile: null, provenance: {kind: 'manager_note', label: 'Встреча', capturedAt: '2026-08-09T10:00:00.000Z'}, version: 1};
    expect(validateSourceArtifact(artifact)).toMatchObject({ok: true});
    expect(validateSourceArtifact({...artifact, sha256: '0'.repeat(64)})).toMatchObject({ok: false});
    expect(validateSourceArtifact({...artifact, sourceKind: 'passport'})).toMatchObject({ok: false});
    expect(validateSourceArtifact({...artifact, sourceFile: {filename: 'brief.pdf', mediaType: 'application/pdf', rawSizeBytes: 4, rawSha256: 'a'.repeat(64), extractionMethod: 'pdfjs_text_v1', extractionVersion: 1}, provenance: {...artifact.provenance, kind: 'manager_upload'}})).toMatchObject({ok: true});
    expect(validateSourceArtifact({...artifact, sourceFile: {filename: '../brief.pdf', mediaType: 'application/pdf', rawSizeBytes: 4, rawSha256: 'a'.repeat(64), extractionMethod: 'pdfjs_text_v1', extractionVersion: 1}})).toMatchObject({ok: false});
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
    expect(validateProjectPlanDefinition({...definition, tasks: [{...definition.tasks[0], responsibility: {kind: 'agent_profile', agentProfileId: 'not-a-uuid'}}]})).toMatchObject({ok: false});
    expect(validateProjectPlanDefinition({...definition, milestones: [{...definition.milestones[0], targetAt: '2026-99-99'}]})).toMatchObject({ok: false});
    for (const title of ['{"apiKey":"hidden"}', '{"password":"hidden"}', 'token: hidden-value', '-----BEGIN PRIVATE KEY-----\nabc']) {
      expect(validateProjectPlanDefinition({...definition, title}), title).toMatchObject({ok: false});
    }
    expect(validateProjectPlanDefinition({...definition, title: 'Обсудить хранение токена без значения'})).toMatchObject({ok: true});
    const badPointer = {kind: 'citation' as const, artifactId: '10000000-0000-4000-8000-000000000001', locator: {kind: 'json_pointer' as const, pointer: '/bad~2token'}};
    expect(validateProjectPlanDefinition({...definition, outcomes: definition.outcomes.map((item, index) => index === 0 ? {...item, evidence: badPointer} : item)})).toMatchObject({ok: false});
  });

  it('keeps immutable legacy plans valid and hashed as written, while gating new assignment work', () => {
    const legacyTask = {...definition.tasks[0]!}; delete legacyTask.responsibility;
    const legacy = {...definition, tasks: [legacyTask]};
    const frozenHash = hashProjectPlanDefinition(legacy);
    expect(validateProjectPlanDefinition(legacy)).toMatchObject({ok: true});
    expect(validateAssignedProjectPlanDefinition(legacy)).toMatchObject({ok: false, error: {code: 'INVALID_COMMAND'}});
    expect(hashProjectPlanDefinition(legacy)).toBe(frozenHash);
    expect(simulateProjectPlan({definition: legacy, citationsValid: true, canEdit: true, canApprove: true, protocol: null}))
      .toMatchObject({readyForApproval: false, blockers: expect.arrayContaining([expect.stringContaining('responsibility')])});
  });

  it('reports protocol readiness without treating it as generated plan evidence', () => {
    const dated = {...definition, milestones: [{...definition.milestones[0]!, targetAt: '2026-08-21'}]};
    expect(simulateProjectPlan({definition: dated, citationsValid: true, canEdit: true, canApprove: true, protocol: null})).toMatchObject({readyForApproval: true, protocol: {state: 'not_configured'}, warnings: [expect.any(String)]});
  });

  it('keeps drafts structurally valid while requiring a complete schedule for approval', () => {
    expect(projectPlanScheduleReadiness(definition)).toMatchObject({ready: false, earliestMilestone: null, finalTargetAt: null,
      missingMilestones: [{key: 'm1', title: 'Контрольная точка'}], remediation: expect.stringContaining('Контрольная точка')});
    const dated = {...definition, milestones: [
      {...definition.milestones[0]!, targetAt: '2026-09-12'},
      {...definition.milestones[0]!, key: 'm2', title: 'Финальная приёмка', targetAt: '2026-09-20'}
    ]};
    expect(projectPlanScheduleReadiness(dated)).toMatchObject({ready: true,
      earliestMilestone: {key: 'm1', title: 'Контрольная точка', targetAt: '2026-09-12'}, finalTargetAt: '2026-09-20'});
    expect(simulateProjectPlan({definition, citationsValid: true, canEdit: true, canApprove: true, protocol: null}))
      .toMatchObject({readyForApproval: false, blockers: [expect.stringContaining('Контрольная точка')]});
  });

  it('reports exactly the missing required dossier categories', () => {
    expect(projectDossierReadiness([])).toMatchObject({ready: false, required: [
      {kind: 'project_passport', present: false, remediation: 'Добавьте источник: паспорт проекта.'},
      {kind: 'solution_architecture', present: false, remediation: 'Добавьте источник: архитектура решения.'},
      {kind: 'client_requirements', present: false, remediation: 'Добавьте источник: требования клиента.'}
    ]});
    expect(projectDossierReadiness([
      {sourceKind: 'project_passport'}, {sourceKind: 'solution_architecture'}, {sourceKind: 'client_requirements'}, {sourceKind: 'acceptance_method'}, {sourceKind: 'architecture_constraints'}, {sourceKind: 'other'}
    ])).toMatchObject({ready: true});
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
