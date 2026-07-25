const sanitizedInboundPayload = Symbol('sanitizedInboundPayload');

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export type JsonObject = {[key: string]: JsonValue};

export type SanitizedInboundPayload = JsonObject & {
  readonly [sanitizedInboundPayload]: true;
};

export type VerificationEnvelope =
  | {outcome: 'unverified'; method: 'none'}
  | {
      outcome: 'verified' | 'rejected';
      method: 'hmac-sha256' | 'signature-sha256' | 'shared-token';
    };

export type PersistableInboundEvent = {
  provider: string;
  deliveryId: string;
  eventType: string;
  action?: string;
  verification: VerificationEnvelope;
  sanitizedPayload: SanitizedInboundPayload;
};

export interface InboundEventPersistence {
  persistIncomingEvent(
    event: PersistableInboundEvent
  ): Promise<{eventId: string; duplicate: boolean}>;
}

const MAX_DEPTH = 32;
const MAX_NODES = 50_000;
const MAX_STRING_LENGTH = 262_144;

const sensitiveKeys = new Set([
  'authorization',
  'proxyauthorization',
  'cookie',
  'setcookie',
  'headers',
  'httpheaders',
  'requestheaders',
  'rawheaders',
  'apikey',
  'token',
  'accesstoken',
  'refreshtoken',
  'clientsecret',
  'password',
  'passwd',
  'secret',
  'signingsecret',
  'privatekey',
  'credential',
  'credentials',
  'signature',
  'hubsignature',
  'hubsignature256',
  'xhubsignature',
  'xhubsignature256',
  'stripesignature'
]);

const sensitiveSuffixes = [
  'apikey',
  'token',
  'accesstoken',
  'refreshtoken',
  'clientsecret',
  'password',
  'passwd',
  'secret',
  'privatekey',
  'credential',
  'credentials',
  'signature'
];

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function isSensitiveInboundKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return (
    sensitiveKeys.has(normalized) ||
    sensitiveSuffixes.some((suffix) => normalized.endsWith(suffix))
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sanitizeJsonValue(
  value: unknown,
  depth: number,
  state: {nodes: number; ancestors: Set<object>}
): JsonValue {
  if (depth > MAX_DEPTH) {
    throw new TypeError('Inbound payload exceeds the maximum nesting depth');
  }
  state.nodes += 1;
  if (state.nodes > MAX_NODES) {
    throw new TypeError('Inbound payload exceeds the maximum node count');
  }

  if (value === null || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    if (value.length > MAX_STRING_LENGTH) {
      throw new TypeError('Inbound payload contains an oversized string');
    }
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Inbound payload contains a non-finite number');
    }
    return value;
  }
  if (!Array.isArray(value) && !isPlainObject(value)) {
    throw new TypeError('Inbound payload must contain only JSON values');
  }
  if (state.ancestors.has(value)) {
    throw new TypeError('Inbound payload must not contain cycles');
  }

  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => sanitizeJsonValue(item, depth + 1, state));
    }

    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !isSensitiveInboundKey(key))
        .map(([key, item]) => [
          key,
          sanitizeJsonValue(item, depth + 1, state)
        ])
    );
  } finally {
    state.ancestors.delete(value);
  }
}

export function sanitizeInboundPayload(
  payload: unknown
): SanitizedInboundPayload {
  if (!isPlainObject(payload)) {
    throw new TypeError('Inbound payload must be a JSON object');
  }

  return sanitizeJsonValue(payload, 0, {
    nodes: 0,
    ancestors: new Set()
  }) as SanitizedInboundPayload;
}

export function validateVerificationEnvelope(
  envelope: unknown
): VerificationEnvelope {
  if (!isPlainObject(envelope)) {
    throw new TypeError('Verification envelope must be an object');
  }
  const keys = Object.keys(envelope).sort();
  if (keys.length !== 2 || keys[0] !== 'method' || keys[1] !== 'outcome') {
    throw new TypeError('Verification envelope contains unsupported fields');
  }

  const {method, outcome} = envelope;
  if (outcome === 'unverified' && method === 'none') {
    return {outcome, method};
  }
  if (
    (outcome === 'verified' || outcome === 'rejected') &&
    (method === 'hmac-sha256' ||
      method === 'signature-sha256' ||
      method === 'shared-token')
  ) {
    return {outcome, method};
  }

  throw new TypeError('Verification envelope has an invalid outcome or method');
}

function requireIdentifier(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > 512
  ) {
    throw new TypeError(`${field} must be a non-empty string of at most 512 characters`);
  }
  return value;
}

export function prepareInboundEventForPersistence(input: {
  provider: unknown;
  deliveryId: unknown;
  eventType: unknown;
  action?: unknown;
  verification: unknown;
  payload: unknown;
}): PersistableInboundEvent {
  const action =
    input.action === undefined
      ? undefined
      : requireIdentifier(input.action, 'action');

  return {
    provider: requireIdentifier(input.provider, 'provider'),
    deliveryId: requireIdentifier(input.deliveryId, 'deliveryId'),
    eventType: requireIdentifier(input.eventType, 'eventType'),
    ...(action === undefined ? {} : {action}),
    verification: validateVerificationEnvelope(input.verification),
    sanitizedPayload: sanitizeInboundPayload(input.payload)
  };
}
