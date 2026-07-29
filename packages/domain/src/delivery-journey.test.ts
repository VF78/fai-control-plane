import {describe, expect, it} from 'vitest';
import {
  defaultDeliveryProtocolDefinition,
  validateDeliveryProtocolDefinition,
  validateDeliveryEvidenceReferences
} from './index';

describe('delivery journey', () => {
  it('accepts custom stable keys because canonical task status belongs to the stage', () => {
    const definition = defaultDeliveryProtocolDefinition();
    const custom = {
      ...definition,
      stages: definition.stages.map((stage, index, stages) => ({
        ...stage,
        key: `custom_${index}`,
        allowedNextStageKey: index === stages.length - 1 ? null : `custom_${index + 1}`
      }))
    };
    expect(validateDeliveryProtocolDefinition(custom)).toMatchObject({ok: true});
    expect(custom.stages.map((stage) => stage.taskStatus))
      .toEqual(['ready', 'in_dev', 'qa', 'acceptance', 'done']);
  });
  it('requires exactly one reference for every required evidence item', () => {
    const stage = defaultDeliveryProtocolDefinition().stages[1]!;
    expect(validateDeliveryEvidenceReferences(stage, [
      {requirement: 'Implementation change', reference: 'artifact://change/1'},
      {requirement: 'Relevant checks', reference: 'artifact://checks/1'}
    ])).toMatchObject({ok: true});
    expect(validateDeliveryEvidenceReferences(stage, [
      {requirement: 'Implementation change', reference: 'artifact://change/1'}
    ])).toMatchObject({ok: false});
  });
});
