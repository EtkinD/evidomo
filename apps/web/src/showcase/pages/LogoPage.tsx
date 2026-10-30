/* eslint-disable @next/next/no-img-element -- this page shows the committed files byte for byte; next/image would re-encode them */
import { Logo } from '../../components/brand/Logo';
import type { Mode } from '../palettes';
import { SampleScope } from '../samples/parts';
import { Candidate, ShowcaseShell } from '../ui';

const FAVICON_SIZES = [16, 24, 32, 48] as const;

// The committed files in public/, with the size each is generated at (P4B-03).
const ICONS = [
  { file: '/apple-touch-icon.png', label: 'apple-touch-icon', px: 180 },
  { file: '/icon-192.png', label: 'icon-192', px: 192 },
  { file: '/icon-512.png', label: 'icon-512', px: 512 },
  { file: '/icon-maskable-512.png', label: 'icon-maskable-512', px: 512 },
] as const;

function OnMode({ mode }: { mode: Mode }) {
  return (
    <SampleScope mode={mode} className="flex flex-col gap-4 rounded-box border border-base-300 p-4">
      <span className="text-xs text-base-content/70">
        {mode === 'light' ? 'Light' : 'Dark'} (component)
      </span>
      <Logo size="lg" />
      <Logo size="sm" />
      <div className="flex items-center gap-4">
        <Logo variant="mark" />
        <Logo variant="wordmark" />
      </div>
    </SampleScope>
  );
}

function StaticFiles() {
  return (
    <div className="mt-4 flex flex-col gap-4">
      <div className="rounded-box border border-base-300 bg-base-100 p-4">
        <h3 className="font-bold">favicon.svg</h3>
        <p className="mb-3 text-sm text-base-content/70">
          Follows the operating system colour scheme, not the switch above.
        </p>
        <div className="flex items-end gap-4">
          {FAVICON_SIZES.map((px) => (
            <div key={px} className="flex flex-col items-center gap-1">
              <img src="/favicon.svg" width={px} height={px} alt={`Favicon at ${px} px`} />
              <span className="font-mono text-xs text-base-content/70">{px} px</span>
            </div>
          ))}
          <div className="flex flex-col items-center gap-1">
            <img src="/favicon.ico" width={32} height={32} alt="favicon.ico" />
            <span className="font-mono text-xs text-base-content/70">.ico</span>
          </div>
        </div>
      </div>
      <div className="rounded-box border border-base-300 bg-base-100 p-4">
        <h3 className="font-bold">App icons</h3>
        <div className="mt-3 flex flex-wrap items-end gap-4">
          {ICONS.map((icon) => (
            <div key={icon.file} className="flex flex-col items-center gap-1">
              <img
                src={icon.file}
                width={96}
                height={96}
                alt={`${icon.label}, ${icon.px} by ${icon.px} pixels`}
                className="rounded-box border border-base-300"
              />
              <span className="font-mono text-xs text-base-content/70">{icon.label}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {(['light', 'dark'] as const).map((mode) => (
          <SampleScope key={mode} mode={mode} className="rounded-box border border-base-300 p-4">
            <img
              src={`/brand/evidomo-lockup-${mode}.svg`}
              height={40}
              alt={`Evidomo lockup, ${mode}`}
            />
          </SampleScope>
        ))}
      </div>
      <div className="rounded-box border border-base-300 bg-base-100 p-4">
        <h3 className="mb-3 font-bold">og.png (1200 by 630)</h3>
        <img
          src="/og.png"
          width={600}
          height={315}
          alt="Open Graph image: Evidomo lockup and the tagline Evidence for every home."
          className="max-w-full rounded-box border border-base-300"
        />
      </div>
    </div>
  );
}

export function LogoPage() {
  return (
    <ShowcaseShell title="Logo">
      <Candidate id="H-LOGO-1" title="Roof, window, and check mark with a Newsreader wordmark">
        <div className="grid gap-3 sm:grid-cols-2">
          <OnMode mode="light" />
          <OnMode mode="dark" />
        </div>
        <StaticFiles />
      </Candidate>
    </ShowcaseShell>
  );
}
