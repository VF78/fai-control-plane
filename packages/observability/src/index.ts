import {OTLPTraceExporter} from '@opentelemetry/exporter-trace-otlp-http';
import {SpanStatusCode, trace} from '@opentelemetry/api';
import {resourceFromAttributes} from '@opentelemetry/resources';
import {NodeSDK} from '@opentelemetry/sdk-node';
import {ATTR_SERVICE_NAME} from '@opentelemetry/semantic-conventions';

let sdk: NodeSDK | undefined;

const telemetryWarning = 'Telemetry disabled due to invalid configuration.';

export async function startTelemetry(serviceName: string) {
  if (sdk || process.env.OTEL_SDK_DISABLED === 'true') return;

  const endpoint = resolveTraceEndpoint();

  if (!endpoint) return;

  let candidate: NodeSDK | undefined;

  try {
    candidate = new NodeSDK({
      autoDetectResources: false,
      instrumentations: [],
      resource: resourceFromAttributes({[ATTR_SERVICE_NAME]: serviceName}),
      traceExporter: new OTLPTraceExporter({url: endpoint})
    });
    candidate.start();
    sdk = candidate;
  } catch {
    if (candidate) {
      try {
        await candidate.shutdown();
      } catch {
        // The application remains available even if telemetry cleanup fails.
      }
    }
    console.warn(telemetryWarning);
  }
}

export async function stopTelemetry() {
  const activeSdk = sdk;
  sdk = undefined;

  try {
    await activeSdk?.shutdown();
  } catch {
    console.warn(telemetryWarning);
  }
}

function resolveTraceEndpoint() {
  const protocol =
    process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL ??
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL;

  if (protocol && protocol !== 'http/protobuf') {
    console.warn(telemetryWarning);
    return undefined;
  }

  const baseEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const endpoint =
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
    (baseEndpoint
      ? `${baseEndpoint.replace(/\/$/, '')}/v1/traces`
      : undefined);

  if (!endpoint) return undefined;

  try {
    const url = new URL(endpoint);
    if (url.protocol === 'http:' || url.protocol === 'https:') return endpoint;
  } catch {
    // Configuration errors must not affect application startup.
  }

  console.warn(telemetryWarning);
  return undefined;
}

const allowedAttributeNames = new Set([
  'workspace.id',
  'project.id',
  'work_item.id',
  'event.id',
  'job.id',
  'run.id',
  'packet.id',
  'status',
  'messaging.destination.name',
  'messaging.operation.name',
  'messaging.message.id',
  'messaging.source.name',
  'job.retry_count'
]);

export function safeTelemetryAttributes(
  attributes: Record<string, string | number | boolean>
) {
  return Object.fromEntries(
    Object.entries(attributes).filter(([name]) =>
      allowedAttributeNames.has(name)
    )
  );
}

export type DurableJobTelemetry = Readonly<{
  queueName: string;
  jobId: string;
  retryCount?: number;
}>;

const durableJobTracer = trace.getTracer('fai-control-plane.durable-jobs');

const durableJobAttributes = (
  job: DurableJobTelemetry,
  operation: 'publish' | 'process',
  status: 'queued' | 'processing'
) => safeTelemetryAttributes({
  'messaging.destination.name': job.queueName,
  'messaging.operation.name': operation,
  'messaging.message.id': job.jobId,
  ...(job.retryCount === undefined ? {} : {'job.retry_count': job.retryCount}),
  status
});

export const recordDurableJobEnqueue = (job: DurableJobTelemetry): void => {
  durableJobTracer.startActiveSpan(
    'durable_job.enqueue',
    {attributes: durableJobAttributes(job, 'publish', 'queued')},
    (span) => {
      span.setStatus({code: SpanStatusCode.OK});
      span.end();
    }
  );
};

export const traceDurableJobExecution = async <Result>(
  job: DurableJobTelemetry,
  execute: () => Promise<Result>
): Promise<Result> => durableJobTracer.startActiveSpan(
  'durable_job.execute',
  {attributes: durableJobAttributes(job, 'process', 'processing')},
  async (span) => {
    try {
      const result = await execute();
      span.setStatus({code: SpanStatusCode.OK});
      return result;
    } catch (error) {
      // Do not record exceptions: queue payloads and error messages may be sensitive.
      span.setStatus({code: SpanStatusCode.ERROR});
      throw error;
    } finally {
      span.end();
    }
  }
);

export const recordDeadLetterQueueVisibility = (
  sourceQueueName: string
): void => {
  durableJobTracer.startActiveSpan(
    'durable_job.dead_letter_visible',
    {
      attributes: safeTelemetryAttributes({
        'messaging.destination.name': 'control-plane-dead-letter',
        'messaging.operation.name': 'receive',
        'messaging.source.name': sourceQueueName,
        status: 'failed'
      })
    },
    (span) => {
      span.setStatus({code: SpanStatusCode.OK});
      span.end();
    }
  );
};
