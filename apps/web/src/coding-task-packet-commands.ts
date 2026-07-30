import {requireOperatorSession} from './operator-auth-runtime';
import {getCodingTaskPacketRuntime} from './coding-task-packet-runtime';

const MAX_BODY_BYTES = 2 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const noStore = {'Cache-Control': 'no-store'} as const;

type Runtime = Awaited<ReturnType<typeof getCodingTaskPacketRuntime>>;

export type CodingTaskPacketCommandDependencies = Readonly<{
  requireSession: typeof requireOperatorSession;
  getRuntime(): Promise<Runtime>;
}>;

const dependencies: CodingTaskPacketCommandDependencies = {
  requireSession: requireOperatorSession,
  getRuntime: getCodingTaskPacketRuntime
};

const readBoundedForm = async (request: Request): Promise<URLSearchParams | null> => {
  const contentType = request.headers.get('content-type')?.toLowerCase();
  const contentLength = request.headers.get('content-length');
  if (
    contentType === undefined ||
    !contentType.startsWith('application/x-www-form-urlencoded') ||
    (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_BODY_BYTES)) ||
    request.body === null
  ) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_BODY_BYTES) return null;
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
};

const csrfToken = (form: URLSearchParams | null): string | null => {
  const values = form?.getAll('_csrf') ?? [];
  return values.length === 1 && values[0]!.length > 0 && values[0]!.length <= 128
    ? values[0]!
    : null;
};

const exactForm = (form: URLSearchParams | null): Readonly<{agentProfileId?: string}> | null => {
  if (form === null) return null;
  const entries = [...form.entries()];
  if (
    entries.length === 1 &&
    entries[0]![0] === '_csrf' &&
    entries[0]![1].length > 0 &&
    entries[0]![1].length <= 128
  ) return {};
  if (
    entries.length === 2 &&
    entries[0]![0] === '_csrf' &&
    entries[0]![1].length > 0 &&
    entries[0]![1].length <= 128 &&
    entries[1]![0] === 'agentProfileId' &&
    UUID_PATTERN.test(entries[1]![1])
  ) return {agentProfileId: entries[1]![1]};
  return null;
};

const safe = (status: string, code: number): Response =>
  Response.json({status}, {status: code, headers: noStore});

export async function createCodingTaskPacketCommand(
  request: Request,
  workItemId: string,
  overrides: CodingTaskPacketCommandDependencies = dependencies
): Promise<Response> {
  const form = await readBoundedForm(request);
  const authorization = await overrides.requireSession(request, {csrfToken: csrfToken(form)});
  if (!authorization.ok) return authorization.response;
  const selection = exactForm(form);
  if (!UUID_PATTERN.test(workItemId) || selection === null) return safe('invalid_request', 400);
  try {
    const result = await (await overrides.getRuntime()).create({
      workspaceId: authorization.runtime.config.workspaceId,
      actorId: authorization.session.actorId,
      workItemId,
      ...selection
    });
    if (result.status === 'created' || result.status === 'replayed') {
      const location = new URL(
        `/projects/${result.projectSlug}/tasks/${workItemId}`,
        request.url
      ).toString();
      return new Response(null, {status: 303, headers: {...noStore, location}});
    }
    return result.status === 'forbidden'
      ? safe('forbidden', 403)
      : result.status === 'ineligible'
        ? safe('ineligible', 409)
        : safe('unavailable', 503);
  } catch {
    return safe('unavailable', 503);
  }
}
