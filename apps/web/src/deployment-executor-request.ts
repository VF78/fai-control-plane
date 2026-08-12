const LENGTH = /^\d{1,8}$/;

export const deploymentExecutorLeaseToken = (request: Request): string | null => {
  const value = request.headers.get('x-fai-deployment-lease-token');
  return value === null || value.length > 128 ? null : value;
};

export const readBoundedDeploymentExecutorJson = async (
  request: Request,
  maximumBytes: number
): Promise<unknown | null> => {
  const length = request.headers.get('content-length');
  if (length !== null && (!LENGTH.test(length) || Number(length) > maximumBytes)) return null;
  if (request.body === null) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const value = await reader.read();
      if (value.done) break;
      size += value.value.byteLength;
      if (size > maximumBytes) { await reader.cancel(); return null; }
      chunks.push(value.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
};
