import { describe, expect, it } from 'vitest';
import { DEFAULT_AFTER_AUTH_PATH, safeNextPath, withNext } from '../lib/next-path';

describe('safeNextPath', () => {
  it.each(['/projects', '/projects/42?tab=facts#gate-1', '/'])('accepts %s', (value) => {
    expect(safeNextPath(value)).toBe(value);
  });

  it.each([
    ['missing', undefined],
    ['an array (repeated query key)', ['/projects', '/other']],
    ['empty', ''],
    ['absolute URL', 'https://evil.example/projects'],
    ['protocol-relative URL', '//evil.example'],
    ['backslash trick', '/\\evil.example'],
    ['tab trick', '/\t/evil.example'],
    ['newline trick', '/\n/evil.example'],
    ['javascript: URL', 'javascript:alert(1)'],
    ['relative path without a slash', 'projects'],
    ['the login page (loop)', '/login'],
    ['the register page (loop)', '/register?next=/projects'],
    ['an overlong value', `/${'a'.repeat(3000)}`],
  ])('falls back to the default for %s', (_label, value) => {
    expect(safeNextPath(value)).toBe(DEFAULT_AFTER_AUTH_PATH);
  });

  it('keeps an encoded path on this origin', () => {
    expect(safeNextPath('/%2F%2Fevil.example')).toBe('/%2F%2Fevil.example');
  });
});

describe('withNext', () => {
  it('omits the default path and encodes anything else', () => {
    expect(withNext('/login', '/')).toBe('/login');
    expect(withNext('/login', '/projects?tab=1')).toBe('/login?next=%2Fprojects%3Ftab%3D1');
  });
});
