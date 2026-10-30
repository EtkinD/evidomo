import { NextResponse, type NextRequest } from 'next/server';
import { detectLocale, LOCALE_COOKIE } from './lib/detect-locale';
import { DEFAULT_LOCALE } from './lib/i18n';

/**
 * First visit to `/`: send the visitor to their language (`/tr`, `/nl`, ...). Next's built-in
 * detection is off (`localeDetection: false` in next.config.ts) because it only matches the bare
 * language tag, and Safari sends a regional one (`tr-TR`) on its own. Every other path keeps the
 * locale it was asked for.
 */
export function proxy(request: NextRequest): NextResponse {
  // The matcher also matches the root of each locale (/tr); only the unprefixed `/` is detected.
  if (new URL(request.url).pathname !== '/') return NextResponse.next();

  const locale = detectLocale(
    request.cookies.get(LOCALE_COOKIE)?.value,
    request.headers.get('accept-language'),
  );
  if (locale === DEFAULT_LOCALE) return NextResponse.next();

  const target = new URL(`/${locale}`, request.url);
  target.search = request.nextUrl.search;
  return NextResponse.redirect(target);
}

export const config = { matcher: '/' };
