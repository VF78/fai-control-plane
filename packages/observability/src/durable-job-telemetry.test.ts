import {beforeEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => {
  const span = {
    end: vi.fn(),
    setStatus: vi.fn()
  };
  return {
    span,
    startActiveSpan: vi.fn((
      _name: string,
      _options: unknown,
      callback: (activeSpan: typeof span) => unknown
    ) => callback(span))
  };
});

vi.mock('@opentelemetry/api', () => ({
  SpanStatusCode: {OK: 1, ERROR: 2},
  trace: {getTracer: () => ({startActiveSpan: mocks.startActiveSpan})}
}));

vi.mock('@opentelemetry/exporter-trace-otlp-http', () => ({
  OTLPTraceExporter: vi.fn()
}));

vi.mock('@opentelemetry/resources', () => ({
  resourceFromAttributes: vi.fn()
}));

vi.mock('@opentelemetry/sdk-node', () => ({NodeSDK: vi.fn()}));

const {
  recordDeadLetterQueueVisibility,
  recordDurableJobEnqueue,
  traceDurableJobExecution
} = await import('./index');

beforeEach(() => {
  mocks.startActiveSpan.mockClear();
  mocks.span.end.mockClear();
  mocks.span.setStatus.mockClear();
});

describe('durable job telemetry', () => {
  it('records enqueue correlation with only queue and job identifiers', () => {
    recordDurableJobEnqueue({
      queueName: 'incoming-event.process.v1',
      jobId: 'job-1'
    });

    expect(mocks.startActiveSpan).toHaveBeenCalledWith(
      'durable_job.enqueue',
      {
        attributes: {
          'messaging.destination.name': 'incoming-event.process.v1',
          'messaging.operation.name': 'publish',
          'messaging.message.id': 'job-1',
          status: 'queued'
        }
      },
      expect.any(Function)
    );
    expect(mocks.span.setStatus).toHaveBeenCalledWith({code: 1});
    expect(mocks.span.end).toHaveBeenCalledOnce();
  });

  it('marks failed execution without recording the thrown error', async () => {
    const rawError = new Error('customer text must not reach telemetry');

    await expect(traceDurableJobExecution({
      queueName: 'incoming-event.process.v1',
      jobId: 'job-1',
      retryCount: 2
    }, async () => {
      throw rawError;
    })).rejects.toBe(rawError);

    expect(mocks.startActiveSpan).toHaveBeenCalledWith(
      'durable_job.execute',
      {
        attributes: {
          'messaging.destination.name': 'incoming-event.process.v1',
          'messaging.operation.name': 'process',
          'messaging.message.id': 'job-1',
          'job.retry_count': 2,
          status: 'processing'
        }
      },
      expect.any(Function)
    );
    expect(mocks.span.setStatus).toHaveBeenCalledWith({code: 2});
    expect(mocks.span.end).toHaveBeenCalledOnce();
    expect(mocks.span).not.toHaveProperty('recordException');
  });

  it('records DLQ visibility by source queue without payloads or counts', () => {
    recordDeadLetterQueueVisibility('incoming-event.process.v1');

    expect(mocks.startActiveSpan).toHaveBeenCalledWith(
      'durable_job.dead_letter_visible',
      {
        attributes: {
          'messaging.destination.name': 'control-plane-dead-letter',
          'messaging.operation.name': 'receive',
          'messaging.source.name': 'incoming-event.process.v1',
          status: 'failed'
        }
      },
      expect.any(Function)
    );
  });
});
