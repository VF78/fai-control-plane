import {OTLPTraceExporter} from '@opentelemetry/exporter-trace-otlp-http';
import {resourceFromAttributes} from '@opentelemetry/resources';
import {NodeSDK} from '@opentelemetry/sdk-node';
import {ATTR_SERVICE_NAME} from '@opentelemetry/semantic-conventions';

let sdk: NodeSDK | undefined;

export async function startTelemetry(serviceName: string) {
  if (sdk || process.env.OTEL_SDK_DISABLED === 'true') return;

  const baseEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const endpoint =
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
    (baseEndpoint
      ? `${baseEndpoint.replace(/\/$/, '')}/v1/traces`
      : undefined);

  if (!endpoint) return;

  sdk = new NodeSDK({
    resource: resourceFromAttributes({[ATTR_SERVICE_NAME]: serviceName}),
    traceExporter: new OTLPTraceExporter({url: endpoint})
  });

  sdk.start();
}

export async function stopTelemetry() {
  await sdk?.shutdown();
  sdk = undefined;
}

const allowedAttributeNames = new Set([
  'workspace.id',
  'project.id',
  'work_item.id',
  'event.id',
  'job.id',
  'run.id',
  'packet.id',
  'status'
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
