import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => ({
  exporterUrls: [] as string[],
  sdkOptions: [] as unknown[],
  sdkShutdown: vi.fn<() => Promise<void>>(),
  sdkStart: vi.fn()
}));

vi.mock('@opentelemetry/exporter-trace-otlp-http', () => ({
  OTLPTraceExporter: vi.fn(function ({url}: {url: string}) {
    mocks.exporterUrls.push(url);
  })
}));

vi.mock('@opentelemetry/sdk-node', () => ({
  NodeSDK: vi.fn(function (options: unknown) {
    mocks.sdkOptions.push(options);
    return {
      shutdown: mocks.sdkShutdown,
      start: mocks.sdkStart
    };
  })
}));

const {safeTelemetryAttributes, startTelemetry, stopTelemetry} = await import(
  './index'
);

const telemetryEnvironment = [
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_PROTOCOL',
  'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
  'OTEL_EXPORTER_OTLP_TRACES_PROTOCOL',
  'OTEL_SDK_DISABLED'
] as const;

let originalEnvironment: Record<string, string | undefined>;

beforeEach(() => {
  originalEnvironment = Object.fromEntries(
    telemetryEnvironment.map((name) => [name, process.env[name]])
  );
  mocks.exporterUrls.length = 0;
  mocks.sdkOptions.length = 0;
  mocks.sdkShutdown.mockReset().mockResolvedValue(undefined);
  mocks.sdkStart.mockReset();
  for (const name of telemetryEnvironment) delete process.env[name];
});

afterEach(async () => {
  await stopTelemetry();
  for (const name of telemetryEnvironment) {
    const value = originalEnvironment[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  vi.restoreAllMocks();
});

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

describe('startTelemetry', () => {
  it('fails open for malformed endpoints without logging configuration values', async () => {
    const endpoint = 'not-a-url?api_key=top-secret';
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = endpoint;

    await expect(startTelemetry('worker')).resolves.toBeUndefined();

    expect(mocks.sdkStart).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith(
      'Telemetry disabled due to invalid configuration.'
    );
    expect(warning.mock.calls.flat().join(' ')).not.toContain(endpoint);
    expect(warning.mock.calls.flat().join(' ')).not.toContain('top-secret');
  });

  it('fails open for unsupported OTLP protocols', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = 'https://otel.example/v1/traces';
    process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL = 'grpc';

    await expect(startTelemetry('worker')).resolves.toBeUndefined();

    expect(mocks.sdkStart).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith(
      'Telemetry disabled due to invalid configuration.'
    );
  });

  it('disables automatic resource detection and instrumentations', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://otel.example';

    await startTelemetry('worker');

    expect(mocks.exporterUrls).toEqual(['https://otel.example/v1/traces']);
    expect(mocks.sdkOptions).toHaveLength(1);
    expect(mocks.sdkOptions[0]).toMatchObject({
      autoDetectResources: false,
      instrumentations: []
    });
  });

  it('can retry after initialization fails and restart after shutdown', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = 'https://otel.example/v1/traces';
    mocks.sdkStart.mockImplementationOnce(() => {
      throw new Error('exporter initialization failed');
    });

    await expect(startTelemetry('worker')).resolves.toBeUndefined();
    await expect(startTelemetry('worker')).resolves.toBeUndefined();
    await stopTelemetry();
    await expect(startTelemetry('worker')).resolves.toBeUndefined();

    expect(mocks.sdkStart).toHaveBeenCalledTimes(3);
    expect(mocks.sdkShutdown).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalledWith(
      'Telemetry disabled due to invalid configuration.'
    );
  });

  it('allows telemetry to restart after shutdown fails', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = 'https://otel.example/v1/traces';

    await startTelemetry('worker');
    mocks.sdkShutdown.mockRejectedValueOnce(new Error('shutdown failed'));

    await expect(stopTelemetry()).resolves.toBeUndefined();
    await expect(startTelemetry('worker')).resolves.toBeUndefined();

    expect(mocks.sdkStart).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalledWith(
      'Telemetry disabled due to invalid configuration.'
    );
  });
});
