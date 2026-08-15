import {afterEach, describe, expect, it} from 'vitest';
import {requireCsrf} from './runtime.ts';

describe('browser command CSRF boundary', () => {
  afterEach(() => { delete process.env.AUTH_PUBLIC_BASE_URL; });
  it('accepts only the configured same origin', () => {
    process.env.AUTH_PUBLIC_BASE_URL = 'https://app.f-ai.studio/';
    expect(() => requireCsrf(new Request('https://app.f-ai.studio/api/agents/submit',
      {headers: {origin: 'https://app.f-ai.studio'}}))).not.toThrow();
    expect(() => requireCsrf(new Request('https://app.f-ai.studio/api/agents/submit',
      {headers: {origin: 'https://evil.example'}}))).toThrow('csrf_denied');
  });
});
