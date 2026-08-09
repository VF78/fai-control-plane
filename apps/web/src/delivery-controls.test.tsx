import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it} from 'vitest';
import {DeliveryJourneyAction} from './delivery-controls';

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
    expect(denied).toContain('только выбранный Product Owner');
    expect(denied).not.toContain('Зафиксировать финальную приёмку');

    const allowed = renderToStaticMarkup(createElement(DeliveryJourneyAction, {
      workItemId: '22222222-2222-4222-8222-222222222222', taskVersion: 6,
      journey: {...journey, canRecordTerminalEvidence: true}, activeProtocolId: null,
      csrfToken: 'csrf'
    }));
    expect(allowed).toContain('Зафиксировать финальную приёмку');
  });
});
