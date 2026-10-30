// Builds the responsive landing-page images from the four approved originals (B2-HERO-1,
// B2-INT-1, B2-INT-2, B2-ILL-1). The originals are gitignored; the committed output is what the
// site serves. sharp is not a declared dependency (it only arrives with Next's optional packages):
// this is a maintainer tool, run by hand.
//
//   node apps/web/scripts/build-landing-images.mjs <dir with hero-1.webp, interior-1.webp, ...>
//
// sharp drops all metadata (EXIF, XMP, ICC) unless withMetadata() is called, which is wanted here.
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';
import sharp from 'sharp';

const SOURCES = [
  { input: 'hero-1.webp', name: 'hero' },
  { input: 'interior-1.webp', name: 'interior-1' },
  { input: 'interior-2.webp', name: 'interior-2' },
  { input: 'illustration-1.webp', name: 'illustration' },
];
const WIDTHS = [640, 1280, 1920];
const QUALITY = 78;

const [sourceDir] = process.argv.slice(2);
if (sourceDir === undefined) {
  process.stderr.write('Usage: node apps/web/scripts/build-landing-images.mjs <source-dir>\n');
  process.exit(1);
}
const outDir = resolve(import.meta.dirname, '../public/images/landing');
await mkdir(outDir, { recursive: true });

for (const { input, name } of SOURCES) {
  const source = sharp(join(resolve(sourceDir), input));
  const { width, height } = await source.metadata();
  if (width === undefined || height === undefined) throw new Error(`${input}: no dimensions`);
  // Never upscale: a width above the original is capped to it and listed once.
  const widths = [...new Set(WIDTHS.map((w) => Math.min(w, width)))];
  for (const w of widths) {
    const info = await source
      .clone()
      .resize({ width: w, withoutEnlargement: true })
      .webp({ quality: QUALITY, effort: 6 })
      .toFile(join(outDir, `${name}-${w}.webp`));
    process.stdout.write(`${name}-${w}.webp ${info.width}x${info.height} ${info.size} B\n`);
  }
}
