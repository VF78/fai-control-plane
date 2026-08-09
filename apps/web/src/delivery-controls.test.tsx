import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it} from 'vitest';
import {DeliveryJourneyAction, DeliveryProtocolEditor} from './delivery-controls';

const journey = {
  version: 4,
  deadlineAt: null,
  protocolId: '11111111-1111-4111-8111-111111111111',
  protocolVersion: 2,
  stageKey: 'acceptance',
  requiredEvidence: ['Product Owner acceptance'],
  stage: {terminal: true, terminalEvidenceComplete: false}
};

describe('terminal delivery evidence control', () => {
  it('shows the mutation only to the selected Product Owner with write capability', () => {
    const denied = renderToStaticMarkup(createElement(DeliveryJourneyAction, {
      workItemId: '22222222-2222-4222-8222-222222222222', taskVersion: 6,
      journey: {...journey, canRecordTerminalEvidence: false}, activeProtocolId: null,
      csrfToken: 'csrf'
    }));
    expect(denied).toContain('только выбранный владелец продукта');
    expect(denied).not.toContain('Зафиксировать финальную приёмку');

    const allowed = renderToStaticMarkup(createElement(DeliveryJourneyAction, {
      workItemId: '22222222-2222-4222-8222-222222222222', taskVersion: 6,
      journey: {...journey, canRecordTerminalEvidence: true}, activeProtocolId: null,
      csrfToken: 'csrf'
    }));
    expect(allowed).toContain('Зафиксировать финальную приёмку');
  });
});

describe('manager protocol terminology', () => {
  it('renders the published default protocol in Russian without internal labels', () => {
    const markup = renderToStaticMarkup(createElement(DeliveryProtocolEditor, {
      projectId: '11111111-1111-4111-8111-111111111111', csrfToken: null,
      protocol: {
        id: '22222222-2222-4222-8222-222222222222', projectId: '11111111-1111-4111-8111-111111111111',
        name: 'Delivery', version: 1, revision: 1, state: 'published', active: true, contentHash: 'a'.repeat(64),
        definition: {schemaVersion: 1, stages: [{key: 'development', name: 'Development', enabled: true,
          taskStatus: 'in_dev', responsibility: {kind: 'project_role', role: 'contributor'}, executionMode: 'manual',
          entryCriteria: ['Task is ready for implementation'], requiredEvidence: ['Implementation change'], allowedNextStageKey: null}]}
      }
    }));

    expect(markup).toContain('Версия 1');
    expect(markup).toContain('Разработка');
    expect(markup).toContain('Исполнитель');
    expect(markup).toContain('Изменения реализации');
    expect(markup).toContain('Завершение');
    expect(markup).not.toContain('Published delivery protocol stages');
    expect(markup).not.toContain('Configured agent');
  });
});
