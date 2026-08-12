import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect, it} from 'vitest';
import {ReleaseEvidenceControls} from './release-evidence-controls';

it('shows Russian desired/requested/approved/observed truth and production next action progressively', () => {
  const unknown = {availability: 'unknown' as const};
  const known = <T,>(value: T) => ({availability: 'known' as const, value});
  const markup = renderToStaticMarkup(createElement(ReleaseEvidenceControls, {projectId: 'project', projectVersion: 1,
    materialization: {id: 'materialization', planVersionId: 'plan'}, workItems: [{id: 'task', title: 'Ready',
      sourcePlanVersionId: 'plan', status: 'acceptance', blocked: false, journey: {stage: {taskStatus: 'acceptance',
        terminal: false, terminalEvidenceComplete: false, protocolFinalizable: true}}}], csrfToken: 'csrf', canManage: true,
    deployments: [{id: 'deployment', workItemId: null, environment: 'production', revision: 'git-commit:abc', status: 'requested',
      version: 1, externalRef: null, approvedBy: unknown, startedAt: null, completedAt: null,
      desired: known({environment: 'production' as const, reference: {kind: 'commit' as const, reference: 'git-commit:abc'},
        planVersionId: 'plan', materializationId: 'materialization', workItemId: null}),
      releasePackage: known({value: {schemaVersion: 1 as const, sourceCommit: 'a'.repeat(40),
        artifactReference: 'artifact:release-package:1', artifactSha256: 'b'.repeat(64)}, sha256: 'c'.repeat(64)}),
      executorJob: unknown,
      requested: known({by: unknown, at: '2026-08-11T10:00:00.000Z'}),
      approval: known({state: 'pending' as const, by: unknown, at: null}), externalEvidence: unknown,
      nextAction: 'approve_production' as const}]}));
  expect(markup).toContain('Желаемое, запрос, подтверждение и наблюдаемый факт разделены');
  expect(markup).toContain('Ожидает отдельного решения');
  expect(markup).toContain('artifact:release-package:1');
  expect(markup).toContain('Executor job');
  expect(markup).toContain('Точный commit SHA');
  expect(markup).toContain('Подтвердить продакшен');
  expect(markup).toContain('<details');
});
