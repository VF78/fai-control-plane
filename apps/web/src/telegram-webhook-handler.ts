import type {
  ConversationObservation,
  ConversationParticipantObservation
} from '@fai-control-plane/db';
import type {SecretsProvider} from '@fai-control-plane/domain';
import {
  readTelegramWebhookBody,
  verifyAndProjectTelegramWebhook,
  type TelegramWebhookConfig,
  type TelegramWebhookRejectionCode
} from '@fai-control-plane/integrations';

export type TelegramConversationStore = Readonly<{
  ingest(observation: ConversationObservation): Promise<'accepted' | 'duplicate' | 'before_activation'>;
  observeParticipant(observation: ConversationParticipantObservation): Promise<'accepted' | 'duplicate'>;
  recordFailure(provider: string, externalRef: string, code: string): Promise<void>;
}>;

export type TelegramWebhookHandlerDependencies = Readonly<{
  config: TelegramWebhookConfig;
  secrets: SecretsProvider;
  conversations: TelegramConversationStore;
}>;

const response = (status: number, outcome: string): Response =>
  Response.json({status: outcome}, {status, headers: {'Cache-Control': 'no-store'}});

const rejectionStatus = (code: TelegramWebhookRejectionCode): number => {
  if (code === 'telegram_body_too_large') return 413;
  if (code === 'telegram_media_type_invalid') return 415;
  if (code === 'telegram_secret_unavailable' || code === 'telegram_secret_config_invalid') return 503;
  if (code === 'telegram_secret_missing' || code === 'telegram_secret_invalid') return 401;
  if (
    code === 'telegram_update_unsupported' ||
    code === 'telegram_chat_unauthorized' ||
    code === 'telegram_command_unsupported'
  ) return 204;
  return 400;
};

export const createTelegramWebhookHandler = (
  dependencies: TelegramWebhookHandlerDependencies
) => async (request: Request): Promise<Response> => {
  if (request.body === null) return response(400, 'rejected');
  const body = await readTelegramWebhookBody(
    request.body,
    request.headers.get('content-length') ?? undefined
  );
  if (!body.ok) return response(body.code === 'telegram_body_too_large' ? 413 : 400, 'rejected');
  const verified = await verifyAndProjectTelegramWebhook({
    config: dependencies.config,
    secrets: dependencies.secrets,
    headers: request.headers,
    body: body.body
  });
  if (verified.outcome === 'rejected') {
    const status = rejectionStatus(verified.code);
    return status === 204
      ? new Response(null, {status, headers: {'Cache-Control': 'no-store'}})
      : response(status, 'rejected');
  }
  try {
    const accepted = 'observedLevel' in verified.observation
      ? await dependencies.conversations.observeParticipant(verified.observation)
      : await dependencies.conversations.ingest(verified.observation);
    return response(accepted === 'accepted' ? 202 : 200, accepted);
  } catch {
    await dependencies.conversations.recordFailure(
      verified.observation.provider,
      verified.observation.externalBindingRef,
      'persistence_failed'
    ).catch(() => undefined);
    return response(503, 'unavailable');
  }
};
