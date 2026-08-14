import {timingSafeEqual} from 'node:crypto';
import type {ClientConversationEnvelope, InternalConversationEnvelope} from '@fai-control-plane/domain';
import {bindHermesConversation, type HermesProfile} from './hermes-binding.ts';

type DispatchResult = Readonly<{status: 'completed' | 'duplicate' | 'denied'; referenceId?: string}>;
export type HermesActionDependencies = Readonly<{
  internalToken(): Promise<string>;
  clientToken(): Promise<string>;
  dispatchInternal(envelope: InternalConversationEnvelope): Promise<DispatchResult>;
  dispatchClient(envelope: ClientConversationEnvelope): Promise<DispatchResult>;
  projectId: string;
  telegramChatId: string;
  telegramUserIds: readonly string[];
  bitrixTaskId: string;
}>;

const equal = (left: string, right: string): boolean => {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};
const token = (request: Request): string => {
  const authorization = request.headers.get('authorization');
  if (authorization === null || !authorization.startsWith('Bearer ')) throw new Error('authentication_denied');
  const value = authorization.slice(7);
  if (value.length < 32 || value.length > 512 || value.includes('\0')) throw new Error('authentication_denied');
  return value;
};
const json = async (request: Request): Promise<Record<string, unknown>> => {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new Error('media_type_invalid');
  const text = await request.text();
  if (text.length === 0 || text.length > 32_000) throw new Error('body_invalid');
  const value = JSON.parse(text) as unknown;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('body_invalid');
  return value as Record<string, unknown>;
};

export const createHermesConversationActionHandler = (dependencies: HermesActionDependencies) =>
  async (request: Request): Promise<Response> => {
    try {
      if (request.method !== 'POST') return new Response(null, {status: 405, headers: {allow: 'POST'}});
      const bearer = token(request);
      const internal = await dependencies.internalToken();
      const client = await dependencies.clientToken();
      if (equal(internal, client)) throw new Error('authentication_denied');
      const profile: HermesProfile = equal(bearer, internal) ? 'internal'
        : equal(bearer, client) ? 'bitrix-client' : (() => { throw new Error('authentication_denied'); })();
      const body = await json(request);
      if (!Object.hasOwn(body, 'source') || !Object.hasOwn(body, 'action') || Object.keys(body).length !== 2) {
        throw new Error('body_invalid');
      }
      const envelope = bindHermesConversation({profile, source: body.source as never, action: body.action,
        projectId: dependencies.projectId, telegramChatId: dependencies.telegramChatId,
        telegramUserIds: dependencies.telegramUserIds, bitrixTaskId: dependencies.bitrixTaskId});
      const result = envelope.message.contour === 'trusted-main'
        ? await dependencies.dispatchInternal(envelope as InternalConversationEnvelope)
        : await dependencies.dispatchClient(envelope as ClientConversationEnvelope);
      if (result.status === 'denied') throw new Error('action_denied');
      return Response.json(result, {status: result.status === 'completed' ? 200 : 202,
        headers: {'cache-control': 'no-store'}});
    } catch (error) {
      const code = error instanceof Error ? error.message : 'request_failed';
      const status = code === 'authentication_denied' ? 401 : code.endsWith('_denied') ? 403 : 400;
      return Response.json({error: code}, {status, headers: {'cache-control': 'no-store'}});
    }
  };
