import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { detectLocale } from '../lib/detect-locale';
import { proxy } from '../proxy';

describe('detectLocale', () => {
  it('uses a chosen language (the cookie) before the browser language', () => {
    expect(detectLocale('nl', 'tr-TR,tr;q=0.9')).toBe('nl');
    expect(detectLocale('en', 'tr')).toBe('en');
  });

  it('ignores a cookie that is not a supported locale', () => {
    expect(detectLocale('xx', 'it')).toBe('it');
    expect(detectLocale('', 'it')).toBe('it');
  });

  it.each([
    ['tr', 'tr'],
    ['tr-TR', 'tr'],
    ['TR-tr', 'tr'],
    ['es-MX', 'es'],
    ['nl-BE,nl;q=0.8', 'nl'],
    ['it-CH', 'it'],
    ['en-GB', 'en'],
    ['en-US,en;q=0.9,tr;q=0.8', 'en'],
    ['tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7', 'tr'],
  ])('reads Accept-Language "%s" as %s', (header, expected) => {
    expect(detectLocale(undefined, header)).toBe(expected);
  });

  it('orders by quality, not by position, and keeps the order of equal qualities', () => {
    expect(detectLocale(undefined, 'de;q=0.9,es;q=0.8,nl;q=0.95')).toBe('nl');
    expect(detectLocale(undefined, 'it,es')).toBe('it');
    expect(detectLocale(undefined, 'es;q=0.5,it;q=0.5')).toBe('es');
  });

  it('skips unsupported languages, the wildcard, and a zero quality', () => {
    expect(detectLocale(undefined, 'de,fr;q=0.8,tr;q=0.1')).toBe('tr');
    expect(detectLocale(undefined, '*,nl')).toBe('nl');
    expect(detectLocale(undefined, 'tr;q=0,it;q=0.2')).toBe('it');
  });

  it('is English when nothing matches or the header is missing or broken', () => {
    expect(detectLocale(undefined, 'de-DE,fr;q=0.9')).toBe('en');
    expect(detectLocale(undefined, undefined)).toBe('en');
    expect(detectLocale(undefined, null)).toBe('en');
    expect(detectLocale(undefined, ';;,q=,')).toBe('en');
  });
});

function request(
  path: string,
  headers: Record<string, string> = {},
  localeCookie?: string,
): NextRequest {
  const incoming = new NextRequest(`http://localhost:3000${path}`, { headers });
  if (localeCookie !== undefined) incoming.cookies.set('NEXT_LOCALE', localeCookie);
  return incoming;
}

describe('proxy', () => {
  it('redirects the root to the detected language, keeping the query', () => {
    const response = proxy(request('/?ref=mail', { 'accept-language': 'tr-TR' }));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://localhost:3000/tr?ref=mail');
  });

  it('follows the language cookie over the browser language', () => {
    const response = proxy(request('/', { 'accept-language': 'tr' }, 'es'));
    expect(response.headers.get('location')).toBe('http://localhost:3000/es');
  });

  it('leaves English visitors on the unprefixed page', () => {
    expect(proxy(request('/', { 'accept-language': 'en-US' })).headers.get('location')).toBeNull();
    expect(proxy(request('/', { 'accept-language': 'de' })).headers.get('location')).toBeNull();
    expect(
      proxy(request('/', { 'accept-language': 'tr' }, 'en')).headers.get('location'),
    ).toBeNull();
  });

  it('only acts on the root, so a locale root does not redirect again', () => {
    for (const path of ['/tr', '/projects', '/login']) {
      const response = proxy(request(path, { 'accept-language': 'nl' }));
      expect(response.headers.get('location'), path).toBeNull();
    }
  });
});
