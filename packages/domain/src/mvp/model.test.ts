import {describe, expect, it} from 'vitest';
import {isBoundedId, isHttpsUrl, isInstant} from './model.ts';

describe('MVP primitive validation', () => {
  it.each(['project-1', 'github:item:1', 'opaque_reference'])('accepts bounded id %s', (value) => {
    expect(isBoundedId(value)).toBe(true);
  });

  it.each(['', 'line\nbreak', 'x'.repeat(257)])('rejects unsafe id', (value) => {
    expect(isBoundedId(value)).toBe(false);
  });

  it('accepts only credential-free HTTPS references', () => {
    expect(isHttpsUrl('https://example.test/path')).toBe(true);
    expect(isHttpsUrl('http://example.test/path')).toBe(false);
    expect(isHttpsUrl('https://user:pass@example.test/path')).toBe(false);
  });

  it('validates observed instants', () => {
    expect(isInstant('2026-08-13T00:00:00.000Z')).toBe(true);
    expect(isInstant('not-a-date')).toBe(false);
  });
});
