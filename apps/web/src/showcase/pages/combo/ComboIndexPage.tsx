import Link from 'next/link';
import { useAssetManifest } from '../../assets';
import { COMBO_LOGOS, ComboLockup, type ComboLogo } from '../../combo/logos';
import {
  COMBO_IMAGES,
  COMBO_PAGES,
  ComboImage,
  ComboScope,
  ComboShell,
  Sample,
  type ComboImageKey,
} from '../../combo/parts';
import { COMBO_SHAPE } from '../../palettes';
import type { Mode } from '../../palettes';
import { AssetFigure, NotGenerated } from '../../ui';

const FAVICON_SIZES = [
  { px: 16, cls: 'size-4' },
  { px: 24, cls: 'size-6' },
  { px: 32, cls: 'size-8' },
  { px: 48, cls: 'size-12' },
] as const;

function LogoOnMode({ logo, mode }: { logo: ComboLogo; mode: Mode }) {
  return (
    <ComboScope mode={mode} className="flex flex-col gap-4 rounded-box border border-base-300 p-4">
      <span className="text-xs text-base-content/70">{mode === 'light' ? 'Light' : 'Dark'}</span>
      <ComboLockup logo={logo} markClass="size-12" textClass="text-3xl" />
      <ComboLockup logo={logo} markClass="size-6" textClass="text-base" />
      <div className="flex items-end gap-4">
        {FAVICON_SIZES.map((size) => (
          <div key={size.px} className="flex flex-col items-center gap-1">
            <logo.Mark className={size.cls} />
            <span className="font-mono text-xs text-base-content/70">{size.px} px</span>
          </div>
        ))}
      </div>
    </ComboScope>
  );
}

function ThemeSpecimen({ mode }: { mode: Mode }) {
  return (
    <ComboScope mode={mode} className="flex flex-col gap-4 rounded-box border border-base-300 p-4">
      <span className="text-xs text-base-content/70">
        {mode === 'light' ? 'combo-light' : 'combo-dark'}
      </span>
      <div className="flex flex-wrap gap-2" aria-hidden>
        {[
          'bg-primary',
          'bg-secondary',
          'bg-accent',
          'bg-neutral',
          'bg-base-200',
          'bg-base-300',
        ].map((cls) => (
          <span key={cls} className={`size-10 rounded-field border border-base-300 ${cls}`} />
        ))}
      </div>
      <h3 className="text-3xl font-bold tracking-tight">Every claim, linked to its evidence</h3>
      <p>
        Source Sans 3 for reading: the living area is 118 m² (Wohnfläche), the energy label is B.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-primary min-h-11">
          Primary
        </button>
        <button type="button" className="btn btn-outline min-h-11">
          Outline
        </button>
        <span className="badge badge-success">Verified</span>
        <span className="badge badge-secondary">Needs review</span>
        <span className="badge badge-error">Conflict</span>
      </div>
    </ComboScope>
  );
}

function ImageSet() {
  const keys = Object.keys(COMBO_IMAGES) as ComboImageKey[];
  return (
    <ul className="mx-auto grid max-w-6xl gap-4 px-4 py-4 sm:grid-cols-2 lg:grid-cols-4">
      {keys.map((key) => (
        <li key={key} className="flex flex-col gap-2">
          <ComboImage
            image={key}
            aspect={key === 'illustration' ? 'aspect-square' : 'aspect-3/2'}
            className="rounded-box"
          />
          <code className="badge badge-outline font-mono">{COMBO_IMAGES[key].id}</code>
        </li>
      ))}
    </ul>
  );
}

function MuseReference() {
  const query = useAssetManifest();
  const item =
    query.data?.status === 'ready'
      ? query.data.manifest.items.find((candidate) => candidate.id === 'B3-LOGO-2')
      : undefined;
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-4">
      <h3 className="text-lg font-semibold">The Muse concept the two marks interpret</h3>
      <div className="max-w-xs">
        {item === undefined ? <NotGenerated what="B3-LOGO-2" /> : <AssetFigure item={item} />}
      </div>
    </div>
  );
}

export function ComboIndexPage() {
  return (
    <ComboShell title="Combination">
      <div className="mx-auto w-full max-w-6xl px-4">
        <p className="rounded-box border border-base-300 bg-base-100 p-4">
          The founder&rsquo;s mix: B2 Hearth Clay colours, B3 Hearth Canal type (Newsreader and
          Source Sans 3) and sharper shape (radius {COMBO_SHAPE.radiusSelector} /{' '}
          {COMBO_SHAPE.radiusField} / {COMBO_SHAPE.radiusBox}), and the images B2-HERO-1, B2-INT-1,
          B2-INT-2, B2-ILL-1. Themes: <code className="font-mono">combo-light</code> and{' '}
          <code className="font-mono">combo-dark</code> (showcase candidate, removed after P4B-02).
          Give feedback by <code className="font-mono">H-</code> ID, for example &ldquo;H-HERO-1
          keep, H-LOGO-3 yes, H-LIST-1 more air&rdquo;.
        </p>
      </div>

      <section aria-labelledby="samples-title" className="mx-auto w-full max-w-6xl px-4">
        <h2 id="samples-title" className="mb-3 text-2xl font-bold">
          Sample pages
        </h2>
        <ul className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {COMBO_PAGES.map((page) => (
            <li key={page.slug} className="card border border-base-300 bg-base-100">
              <div className="card-body gap-2 p-4">
                <h3 className="card-title text-lg">
                  <Link
                    href={`/showcase/combo/${page.slug}`}
                    className="link inline-flex min-h-11 items-center"
                  >
                    {page.label}
                  </Link>
                </h3>
                <p className="text-sm text-base-content/70">{page.summary}</p>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <Sample id="H-THEME-1" title="Theme specimen: colours, type, shape, buttons, badges">
        <div className="mx-auto grid max-w-6xl gap-4 px-4 py-6 md:grid-cols-2">
          <ThemeSpecimen mode="light" />
          <ThemeSpecimen mode="dark" />
        </div>
      </Sample>

      {COMBO_LOGOS.map((logo) => (
        <Sample key={logo.id} id={logo.id} title={logo.title}>
          <div className="mx-auto grid max-w-6xl gap-4 px-4 py-6 md:grid-cols-2">
            <LogoOnMode logo={logo} mode="light" />
            <LogoOnMode logo={logo} mode="dark" />
          </div>
        </Sample>
      ))}

      <Sample id="H-LOGO-REF" title="B3-LOGO-2, the Muse concept (reference)">
        <MuseReference />
      </Sample>

      <Sample id="H-IMG-1" title="The four chosen images">
        <ImageSet />
      </Sample>
    </ComboShell>
  );
}
