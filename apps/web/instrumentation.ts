export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const {startTelemetry} = await import('@fai-control-plane/observability');
  await startTelemetry('fai-control-plane-web');
}
