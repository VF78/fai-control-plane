import {describe, expect, it} from 'vitest';
import {redirectWithCookies} from './oauth.ts';

describe('OAuth redirects', () => {
  it('returns a redirect with mutable headers and every Set-Cookie value', () => {
    const response = redirectWithCookies(new URL('https://github.com/login/oauth/authorize?state=state'), [
      'fcp_oauth=state.verifier; HttpOnly; Path=/',
      'fcp_session=session; HttpOnly; Path=/'
    ]);

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://github.com/login/oauth/authorize?state=state');
    expect((response.headers as Headers & {getSetCookie(): string[]}).getSetCookie()).toEqual([
      'fcp_oauth=state.verifier; HttpOnly; Path=/',
      'fcp_session=session; HttpOnly; Path=/'
    ]);
    expect(() => response.headers.append('x-oauth-test', 'mutable')).not.toThrow();
    expect(response.headers.get('x-oauth-test')).toBe('mutable');
  });
});
