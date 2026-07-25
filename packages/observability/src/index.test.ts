import {describe, expect, it} from 'vitest';
import {safeTelemetryAttributes} from './index';

describe('safeTelemetryAttributes', () => {
  it('drops unapproved and potentially sensitive attributes', () => {
    expect(
      safeTelemetryAttributes({
        'run.id': 'run-1',
        status: 'queued',
        prompt: 'secret context',
        'http.request.body': 'raw customer content'
      })
    ).toEqual({'run.id': 'run-1', status: 'queued'});
  });
});
