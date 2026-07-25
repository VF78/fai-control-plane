import {OTLPTraceExporter} from '@opentelemetry/exporter-trace-otlp-http';
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
