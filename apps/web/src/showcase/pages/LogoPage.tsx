import { Lockup, LogoMark } from '../logo';
import type { Mode } from '../palettes';
import { SampleScope } from '../samples/parts';
import { Candidate, ShowcaseShell } from '../ui';

const FAVICON_SIZES = [
  { px: 16, cls: 'size-4' },
  { px: 24, cls: 'size-6' },
  { px: 32, cls: 'size-8' },
  { px: 48, cls: 'size-12' },
] as const;

function OnMode({ mode }: { mode: Mode }) {
  return (
    <SampleScope mode={mode} className="flex flex-col gap-4 rounded-box border border-base-300 p-4">
      <span className="text-xs text-base-content/70">{mode === 'light' ? 'Light' : 'Dark'}</span>
      <Lockup markClass="size-12" textClass="text-3xl" />
      <Lockup markClass="size-6" textClass="text-base" />
      <div className="flex items-end gap-4">
        {FAVICON_SIZES.map((size) => (
          <div key={size.px} className="flex flex-col items-center gap-1">
            <LogoMark className={size.cls} />
            <span className="font-mono text-xs text-base-content/70">{size.px} px</span>
          </div>
        ))}
        <div className="flex flex-col items-center gap-1">
          <span className="flex size-16 items-center justify-center rounded-box border border-base-300 bg-base-200">
            <LogoMark className="size-10" />
          </span>
          <span className="font-mono text-xs text-base-content/70">App tile</span>
        </div>
      </div>
    </SampleScope>
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
      </Candidate>
    </ShowcaseShell>
  );
}
