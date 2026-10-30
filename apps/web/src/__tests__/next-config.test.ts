import {
  PHASE_DEVELOPMENT_SERVER,
  PHASE_PRODUCTION_BUILD,
  PHASE_PRODUCTION_SERVER,
} from 'next/constants';
import { describe, expect, it } from 'vitest';
import nextConfig, { pageExtensionsFor } from '../../next.config';

describe('page extensions (dev-only showcase routes)', () => {
  it('adds dev.mts only for the development server', () => {
    expect(pageExtensionsFor(PHASE_DEVELOPMENT_SERVER)).toContain('dev.mts');
    expect(nextConfig(PHASE_DEVELOPMENT_SERVER).pageExtensions).toContain('dev.mts');
  });

  it.each([PHASE_PRODUCTION_BUILD, PHASE_PRODUCTION_SERVER])(
    'leaves dev.mts out of the %s phase',
    (phase) => {
      expect(pageExtensionsFor(phase)).not.toContain('dev.mts');
      expect(nextConfig(phase).pageExtensions).not.toContain('dev.mts');
    },
  );

  it('keeps the default page extensions in every phase', () => {
    for (const phase of [PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD]) {
      expect(pageExtensionsFor(phase)).toEqual(expect.arrayContaining(['tsx', 'ts', 'jsx', 'js']));
    }
  });

  it('does not let a production extension match a *.dev.mts file', () => {
    // Next builds `name.dev.tsx` through the `tsx` extension; `.dev.mts` must not end in any
    // production extension, or the showcase would be routed in production.
    const file = 'colors.dev.mts';
    for (const extension of pageExtensionsFor(PHASE_PRODUCTION_BUILD)) {
      expect(file.endsWith(`.${extension}`)).toBe(false);
    }
  });
});

describe('showcase stylesheet alias', () => {
  it('resolves to the showcase stylesheet on the dev server only', () => {
    expect(nextConfig(PHASE_DEVELOPMENT_SERVER).turbopack?.resolveAlias).toEqual({
      'showcase-styles': './src/styles/showcase.css',
    });
    for (const phase of [PHASE_PRODUCTION_BUILD, PHASE_PRODUCTION_SERVER]) {
      expect(nextConfig(phase).turbopack?.resolveAlias).toEqual({
        'showcase-styles': './src/styles/showcase-off.css',
      });
    }
  });
});
