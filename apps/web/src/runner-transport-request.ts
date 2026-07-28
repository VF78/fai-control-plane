const contentLengthPattern = /^\d{1,8}$/;

export const runnerLeaseToken = (request: Request): string | null => {
  const value = request.headers.get('x-fai-runner-lease-token');
  return value === null || value.length > 128 ? null : value;
};

export const readBoundedRunnerJson = async (
  request: Request,
  maximumBytes: number
): Promise<unknown | null> => {
  const contentLength = request.headers.get('content-length');
  if (
    contentLength !== null &&
    (!contentLengthPattern.test(contentLength) || Number(contentLength) > maximumBytes)
  ) return null;
  if (request.body === null) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    return null;
  }
};
