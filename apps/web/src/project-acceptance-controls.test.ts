import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect, it} from 'vitest';
import {ProjectAcceptanceControls} from './project-acceptance-controls';

const base = {projectId: 'project', status: 'blocked' as const, blockReason: 'uat_required', version: 4,
  selection: null, dispatch: null, decisions: [], startedAt: '2026-08-11T10:00:00.000Z', pausedAt: null,
  completedAt: null, updatedAt: '2026-08-11T10:00:00.000Z'};

it('renders Russian progressive disclosure for immutable UAT and the strict completion gate', () => {
  const prepare = renderToStaticMarkup(createElement(ProjectAcceptanceControls, {projectId: 'project', execution: base,
    deployments: [], csrfToken: 'csrf', canProductOwner: true, canClientRepresentative: false}));
  expect(prepare).toContain('Подготовить неизменяемый протокол UAT'); expect(prepare).toContain('<details');
  const acceptance = {protocol: {id: 'protocol', planVersionId: 'plan', materializationId: 'materialization',
    baselineId: 'baseline', contentHash: 'a'.repeat(64), checklist: [{key: 'outcome:result', title: 'Result',
      requiredEvidence: ['accepted_outcome_evidence']}], requiredSmokeChecks: ['health'], preparedByActorId: 'owner',
    requiredDeploymentEnvironment: 'production' as const, deploymentId: null,
    deploymentLifecycleVersion: null, deploymentReleasePackageHash: null, preparedAt: base.startedAt}, version: 5,
    latestResult: {id: 'result', outcome: 'passed' as const, checks: [],
      recordedByActorId: 'owner', recordedAt: base.startedAt}, signoffs: {productOwner: {actorId: 'owner',
      evidenceReference: 'signoff:po', signedAt: base.startedAt}, clientRepresentative: {actorId: 'client',
      evidenceReference: 'signoff:client', signedAt: base.startedAt}}, release: {state: 'not_required' as const,
      deploymentId: null, blocker: null, waiver: {actorId: 'owner', reason: 'No deployment.', waivedAt: base.startedAt}},
    completionReady: true, blockers: []};
  const ready = renderToStaticMarkup(createElement(ProjectAcceptanceControls, {projectId: 'project',
    execution: {...base, acceptance}, deployments: [], csrfToken: 'csrf', canProductOwner: true,
    canClientRepresentative: false}));
  expect(ready).toContain('Завершить проект'); expect(ready).toContain('Представитель клиента');
  expect(ready).toContain('Не требуется · waiver PO');
});
