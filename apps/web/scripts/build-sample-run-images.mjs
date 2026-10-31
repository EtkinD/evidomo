// Builds the web copies of the sample run's synthetic photos (landing page: the specimen and the
// ledger). Sources are committed fixtures only, all model-generated for this project:
// fixtures/samples/synthetic-interiors/ (see its README) and the recorded staged image of the demo
// cassette (fixtures/meta/p3-10/synthetic-walkthrough.files/). Never point this at ../samples/.
// sharp is not a declared dependency (it only arrives with Next's optional packages): this is a
// maintainer tool, run by hand from the repository root.
//
//   node apps/web/scripts/build-sample-run-images.mjs
//
// sharp drops all metadata (EXIF, XMP, ICC) unless withMetadata() is called, which is wanted here.
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';
import sharp from 'sharp';

const root = resolve(import.meta.dirname, '../../..');
const interiors = join(root, 'fixtures/samples/synthetic-interiors');
const SOURCES = [
  // The pack's cover photo (the model ranked it 1 of 11).
  { input: join(interiors, 'living-empty.edit-add-sofa.jpg'), name: 'cover' },
  // The photo that contradicts the spoken "laminate" at Gate 1.
  { input: join(interiors, 'bedroom-empty.edit-add-bed.jpg'), name: 'bedroom' },
  // The empty room the staging step furnished, and the recorded Muse Image result.
  { input: join(interiors, 'living-empty.jpg'), name: 'staging-before' },
  {
    input: join(
      root,
      'fixtures/meta/p3-10/synthetic-walkthrough.files/a4f99820359539d45ae5eec9091f8334197e49e3db7dd51d34f0a11f632feac1.jpg',
    ),
    name: 'staging-after',
  },
];
const WIDTHS = [480, 960];
const QUALITY = 76;

const outDir = resolve(import.meta.dirname, '../public/images/sample-run');
await mkdir(outDir, { recursive: true });

for (const { input, name } of SOURCES) {
  for (const w of WIDTHS) {
    const info = await sharp(input)
      .resize({ width: w, withoutEnlargement: true })
      .webp({ quality: QUALITY, effort: 6 })
      .toFile(join(outDir, `${name}-${w}.webp`));
    process.stdout.write(`${name}-${w}.webp ${info.width}x${info.height} ${info.size} B\n`);
  }
}
