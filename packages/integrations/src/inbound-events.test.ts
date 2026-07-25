import {describe, expect, it} from 'vitest';
import {
  prepareInboundEventForPersistence,
  sanitizeInboundPayload,
  validateVerificationEnvelope
} from './inbound-events';

describe('inbound event persistence boundary', () => {
  it('recursively removes request headers and secret-bearing fields', () => {
    const payload = sanitizeInboundPayload({
      issue: {
        title: 'Keep me',
        password: 'remove me',
        metadata: {
          access_token: 'remove me',
          csrfToken: 'remove me',
          token_count: 12,
          requestHeaders: {'x-request-id': 'also remove me'}
        }
      },
      deliveries: [
        {id: 1, 'X-Api-Key': 'remove me'},
        {id: 2, nested: {clientSecret: 'remove me', state: 'open'}}
      ],
      headers: {accept: 'application/json'}
    });

    expect(payload).toEqual({
      issue: {
        title: 'Keep me',
        metadata: {token_count: 12}
      },
      deliveries: [{id: 1}, {id: 2, nested: {state: 'open'}}]
    });
  });

  it('removes generic and suffixed tokens without removing token_count', () => {
    expect(
      sanitizeInboundPayload({
        token: 'remove me',
        nested: {csrfToken: 'remove me', token_count: 3},
        items: [{pagination_token: 'remove me', token_count: 4}]
      })
    ).toEqual({
      nested: {token_count: 3},
      items: [{token_count: 4}]
    });
  });

  it.each([
    'Authorization',
    'proxy-authorization',
    'Cookie',
    'Set-Cookie',
    'X-Hub-Signature-256',
    'Stripe-Signature',
    'x_custom_signature'
  ])('removes sensitive header name %s at any depth', (headerName) => {
    expect(
      sanitizeInboundPayload({nested: [{headersLike: {[headerName]: 'secret'}}]})
    ).toEqual({nested: [{headersLike: {}}]});
  });

  it('rejects non-JSON and cyclic payloads', () => {
    expect(() => sanitizeInboundPayload({createdAt: new Date()})).toThrow(
      'only JSON values'
    );

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => sanitizeInboundPayload(cyclic)).toThrow('must not contain cycles');
  });

  it('allows only the minimal verification envelope', () => {
    expect(
      validateVerificationEnvelope({
        outcome: 'verified',
        method: 'hmac-sha256'
      })
    ).toEqual({outcome: 'verified', method: 'hmac-sha256'});
    expect(() =>
      validateVerificationEnvelope({
        outcome: 'verified',
        method: 'hmac-sha256',
        signature: 'secret'
      })
    ).toThrow('unsupported fields');
    expect(() =>
      validateVerificationEnvelope({outcome: 'verified', method: 'none'})
    ).toThrow('invalid outcome or method');
  });

  it('prepares a durable async persistence record without raw headers', () => {
    const event = prepareInboundEventForPersistence({
      provider: 'tracker',
      deliveryId: 'delivery-1',
      eventType: 'work_item.updated',
      verification: {outcome: 'unverified', method: 'none'},
      payload: {id: 42, authorization: 'secret'}
    });

    expect(event).toEqual({
      provider: 'tracker',
      deliveryId: 'delivery-1',
      eventType: 'work_item.updated',
      verification: {outcome: 'unverified', method: 'none'},
      sanitizedPayload: {id: 42}
    });
    expect(event).not.toHaveProperty('headers');
    expect(event).not.toHaveProperty('payload');
  });
});
