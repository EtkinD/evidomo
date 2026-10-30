// Generates the static brand files in apps/web/public from the logo geometry and the Evidomo
// theme colours. Run from the repository root:  node apps/web/scripts/brand-assets.mjs
// (uses `sharp`, already installed). See apps/web/public/brand/README.md.
//
// The mark geometry is the one in apps/web/src/components/brand/Logo.tsx (H-LOGO-1). Static
// files cannot load fonts, so the wordmark and tagline are outlined Newsreader paths produced
// once by brand-wordmark-outline.py (SIL Open Font License; the font itself is not committed).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

// Hex values of the oklch tokens in src/styles/globals.css (evidomo-light / evidomo-dark).
// Keep in sync with the theme: a test compares them with site.webmanifest.
const LIGHT = {
  base100: '#fefbf5',
  base200: '#f8f3e9',
  content: '#382a23',
  primary: '#985438',
  secondary: '#445a38',
  secondaryContent: '#f6faf3',
  // Used by the Open Graph images only.
  base300: '#ede5d8',
  accent: '#ecc980',
  accentContent: '#3f2810',
};
const DARK = {
  base100: '#28201a',
  base200: '#201914',
  content: '#ebe7df',
  primary: '#e5a284',
  secondary: '#a1bf92',
  secondaryContent: '#121b0d',
};

const WORDMARK = {
  unitsPerEm: 2000,
  width: 7945.0,
  capHeight: 1340,
  xHeight: 852,
  d: 'M988 -969V-708V-448H879L858 -641H385V-776H858L879 -969ZM1278 -956 1200 -945 998 -1275 1087 -1213H385V-1352H1042L1163 -1422H1210ZM1022 -78 1249 -442 1322 -431 1236 76H1183L1058 0H385V-139H1093ZM73 0V-57L224 -114V-1238L73 -1295V-1352H552V0ZM2291 -798 1960 7H1756L1392 -789L1271 -838V-894H1824V-837L1711 -800L1987 -162L1913 -161L2151 -798L2041 -837V-894H2391V-837ZM2682 -1112Q2601 -1112 2553.5 -1158Q2506 -1204 2506 -1275Q2506 -1346 2553.5 -1391Q2601 -1436 2682 -1436Q2763 -1436 2810 -1391Q2857 -1346 2857 -1275Q2857 -1204 2810 -1158Q2763 -1112 2682 -1112ZM2847 -920 2833 -694V-102L2958 -52V0H2415V-52L2539 -102V-675Q2526 -693 2504.5 -710.5Q2483 -728 2457 -744.5Q2431 -761 2403 -775V-822L2791 -920ZM3675 -614Q3675 -697 3635.5 -748.5Q3596 -800 3516 -800Q3451 -800 3404.5 -765.5Q3358 -731 3334 -657Q3310 -583 3310 -466Q3310 -355 3336 -283.5Q3362 -212 3411 -177Q3460 -142 3528 -142Q3576 -142 3628 -155.5Q3680 -169 3727 -200V-115Q3661 -72 3612 -44Q3563 -16 3525.5 -0.5Q3488 15 3456.5 20.5Q3425 26 3394 26Q3267 26 3180.5 -28Q3094 -82 3050 -179Q3006 -276 3006 -403Q3006 -529 3048.5 -625Q3091 -721 3165 -787Q3239 -853 3332 -886.5Q3425 -920 3526 -920Q3583 -920 3634 -911.5Q3685 -903 3738.5 -885.5Q3792 -868 3855 -838L3675 -819V-1179Q3661 -1197 3638.5 -1213Q3616 -1229 3587.5 -1244Q3559 -1259 3524 -1274V-1329L3945 -1436H3987L3969 -1213V-188Q3980 -177 3995.5 -165Q4011 -153 4029.5 -141.5Q4048 -130 4067.5 -120.5Q4087 -111 4106 -104V-59L3751 25H3715L3675 -146ZM4627 -96Q4682 -96 4722 -126Q4762 -156 4783.5 -224Q4805 -292 4805 -407Q4805 -537 4784 -623.5Q4763 -710 4722 -754Q4681 -798 4619 -798Q4565 -798 4524.5 -768Q4484 -738 4462 -670Q4440 -602 4440 -487Q4440 -357 4461 -270Q4482 -183 4524 -139.5Q4566 -96 4627 -96ZM4614 26Q4465 26 4357.5 -31.5Q4250 -89 4192.5 -193Q4135 -297 4135 -435Q4135 -579 4197.5 -688Q4260 -797 4371.5 -858.5Q4483 -920 4632 -920Q4781 -920 4888.5 -862.5Q4996 -805 5053.5 -701.5Q5111 -598 5111 -459Q5111 -316 5048.5 -206Q4986 -96 4874 -35Q4762 26 4614 26ZM5596 -712V-95L5690 -52V0H5178V-52L5302 -102V-660Q5280 -689 5248.5 -711.5Q5217 -734 5166 -758V-803L5497 -920H5536ZM6171 -627V-95L6266 -52V0H5783V-52L5878 -95V-588Q5878 -631 5863 -657Q5848 -683 5817.5 -696Q5787 -709 5742 -709Q5689 -709 5642.5 -695Q5596 -681 5565 -657L5530 -706Q5597 -775 5648.5 -817Q5700 -859 5742.5 -881.5Q5785 -904 5825 -912Q5865 -920 5909 -920Q6000 -920 6057.5 -885.5Q6115 -851 6143 -785.5Q6171 -720 6171 -627ZM6746 -609V-102L6873 -52V0H6359V-52L6453 -95V-588Q6453 -631 6438 -657Q6423 -683 6392.5 -696Q6362 -709 6317 -709Q6264 -709 6217.5 -695Q6171 -681 6140 -657L6104 -706Q6172 -775 6223.5 -817Q6275 -859 6317.5 -881.5Q6360 -904 6400 -912Q6440 -920 6485 -920Q6620 -920 6683 -841Q6746 -762 6746 -609ZM7399 -96Q7454 -96 7494 -126Q7534 -156 7555.5 -224Q7577 -292 7577 -407Q7577 -537 7556 -623.5Q7535 -710 7494 -754Q7453 -798 7391 -798Q7337 -798 7296.5 -768Q7256 -738 7234 -670Q7212 -602 7212 -487Q7212 -357 7233 -270Q7254 -183 7296 -139.5Q7338 -96 7399 -96ZM7386 26Q7237 26 7129.5 -31.5Q7022 -89 6964.5 -193Q6907 -297 6907 -435Q6907 -579 6969.5 -688Q7032 -797 7143.5 -858.5Q7255 -920 7404 -920Q7553 -920 7660.5 -862.5Q7768 -805 7825.5 -701.5Q7883 -598 7883 -459Q7883 -316 7820.5 -206Q7758 -96 7646 -35Q7534 26 7386 26Z',
};

const ROOF = 'M6 30 32 9l26 21';
const CHECK = 'm24 42 6 6 11-12';
// Visual centre of the mark inside its 64-unit box (the roof stroke reaches y = 6, the window y = 56).
const MARK_CENTER = { x: 32, y: 31 };

function markElements(c) {
  return (
    `<path d="${ROOF}" stroke="${c.primary}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>` +
    `<rect x="15" y="29" width="34" height="27" rx="5" fill="${c.secondary}"/>` +
    `<path d="${CHECK}" stroke="${c.secondaryContent}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`
  );
}

function wrap(width, height, body, extra = '') {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"${extra}>${body}</svg>\n`;
}

// Lockup geometry (matches the in-app lockup: wordmark font size = mark size / 1.5).
const LOCKUP_GAP = 12;
const FONT_SIZE = 64 / 1.5;
const WORD_SCALE = FONT_SIZE / WORDMARK.unitsPerEm;
const WORD_W = WORDMARK.width * WORD_SCALE;
const LOCKUP_W = Math.ceil(64 + LOCKUP_GAP + WORD_W);
const BASELINE = MARK_CENTER.y + (WORDMARK.capHeight * WORD_SCALE) / 2;

function lockupElements(c) {
  return (
    markElements(c) +
    `<path transform="translate(${64 + LOCKUP_GAP} ${BASELINE.toFixed(2)}) scale(${WORD_SCALE.toFixed(6)})" d="${WORDMARK.d}" fill="${c.content}"/>`
  );
}

const lockupSvg = (c) => wrap(LOCKUP_W, 64, lockupElements(c), ' role="img" aria-label="Evidomo"');

const faviconSvg =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -1 64 64" width="64" height="64" fill="none">` +
  `<style>.roof{stroke:${LIGHT.primary}}.window{fill:${LIGHT.secondary}}.check{stroke:${LIGHT.secondaryContent}}` +
  `@media (prefers-color-scheme:dark){.roof{stroke:${DARK.primary}}.window{fill:${DARK.secondary}}.check{stroke:${DARK.secondaryContent}}}</style>` +
  `<path class="roof" d="${ROOF}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>` +
  `<rect class="window" x="15" y="29" width="34" height="27" rx="5"/>` +
  `<path class="check" d="${CHECK}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>` +
  `</svg>\n`;

// A square tile with the mark centred; `fraction` is the mark's share of the tile edge.
function tileSvg(size, fraction, radiusFraction = 0) {
  const k = (size * fraction) / 64;
  const tx = size / 2 - MARK_CENTER.x * k;
  const ty = size / 2 - MARK_CENTER.y * k;
  const rx = size * radiusFraction;
  return wrap(
    size,
    size,
    `<rect width="${size}" height="${size}" rx="${rx}" fill="${LIGHT.base200}"/>` +
      `<g transform="translate(${tx.toFixed(3)} ${ty.toFixed(3)}) scale(${k.toFixed(5)})">${markElements(LIGHT)}</g>`,
  );
}

// --- Open Graph images, one per locale ------------------------------------------------------
// The annotated-dossier look of the landing page: a masthead rule, the tagline in Newsreader at
// display size with a footnote mark, and the hero photograph as a print on a stack of sheets with
// numbered pins and citation lines. The tagline outlines per language come from
// brand-og-outlines.json (see brand-wordmark-outline.py --og).
const OG_OUTLINES = JSON.parse(
  await readFile(join(dirname(fileURLToPath(import.meta.url)), 'brand-og-outlines.json'), 'utf8'),
);
const OG_LOCALES = ['en', 'tr', 'nl', 'it', 'es'];

async function ogPhotoDataUri() {
  const jpeg = await sharp(join(publicDir, 'images', 'landing', 'hero-1280.webp'))
    .resize(840, 560)
    .jpeg({ quality: 88 })
    .toBuffer();
  return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
}

function ogSvg(locale, photo) {
  const W = 1200;
  const H = 630;
  const lines = OG_OUTLINES.taglines[locale];
  const size = 100;
  const lineGap = 106;
  // Three lines start at 290; a two-line tagline sits half a line lower, so the block stays centred.
  const firstBaseline = 290 + ((3 - lines.length) * lineGap) / 2;
  const tagline = lines
    .map((line, i) => {
      const k = size / line.unitsPerEm;
      return `<path transform="translate(72 ${(firstBaseline + i * lineGap).toFixed(1)}) scale(${k.toFixed(6)})" d="${line.d}" fill="${LIGHT.content}"/>`;
    })
    .join('');
  // The footnote mark after the last line, as on the landing page's headline.
  const last = lines[lines.length - 1];
  const lastK = size / last.unitsPerEm;
  const markK = 34 / OG_OUTLINES.digits['1'].unitsPerEm;
  const footnote = `<path transform="translate(${(72 + last.width * lastK + 8).toFixed(1)} ${(firstBaseline + (lines.length - 1) * lineGap - size * 0.58).toFixed(1)}) scale(${markK.toFixed(6)})" d="${OG_OUTLINES.digits['1'].d}" fill="${LIGHT.primary}"/>`;

  // The print: a frame around the photograph, tilted a little, on two sheets underneath.
  const px = 656;
  const py = 176;
  const pw = 444;
  const ph = 324;
  const inner = { x: px + 12, y: py + 12, w: 420, h: 280 };
  const pins = [
    { n: '1', x: 0.73, y: 0.22 },
    { n: '2', x: 0.22, y: 0.45 },
    { n: '3', x: 0.45, y: 0.86 },
  ].map((pin) => ({ ...pin, cx: inner.x + pin.x * inner.w, cy: inner.y + pin.y * inner.h }));
  const hairline = `rgba(56,42,35,0.55)`;
  const leaders = pins
    .map(
      (pin) =>
        `<line x1="${pin.cx.toFixed(1)}" y1="${pin.cy.toFixed(1)}" x2="1126" y2="${pin.cy.toFixed(1)}" stroke="${hairline}" stroke-width="4.5"/>` +
        `<line x1="${pin.cx.toFixed(1)}" y1="${pin.cy.toFixed(1)}" x2="1126" y2="${pin.cy.toFixed(1)}" stroke="${LIGHT.base100}" stroke-width="2.5"/>`,
    )
    .join('');
  const badges = pins
    .map(
      (pin) =>
        `<circle cx="1126" cy="${pin.cy.toFixed(1)}" r="15" fill="${LIGHT.secondary}" stroke="${LIGHT.base100}" stroke-width="3"/>` +
        `<path transform="translate(${(1126 - 32.5 * 0.55).toFixed(2)} ${(pin.cy - 42 * 0.55 + 1).toFixed(2)}) scale(0.55)" d="${CHECK}" stroke="${LIGHT.secondaryContent}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`,
    )
    .join('');
  const pinMarks = pins
    .map((pin) => {
      const digit = OG_OUTLINES.digits[pin.n];
      const k = 19 / digit.unitsPerEm;
      return (
        `<circle cx="${pin.cx.toFixed(1)}" cy="${pin.cy.toFixed(1)}" r="16" fill="${LIGHT.accent}" stroke="${LIGHT.base100}" stroke-width="3"/>` +
        `<path transform="translate(${(pin.cx - (digit.width * k) / 2).toFixed(2)} ${(pin.cy + 19 * 0.34).toFixed(2)}) scale(${k.toFixed(6)})" d="${digit.d}" fill="${LIGHT.accentContent}"/>`
      );
    })
    .join('');

  const centre = `${px + pw / 2} ${py + ph / 2}`;
  return wrap(
    W,
    H,
    `<defs>` +
      `<filter id="sheet" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="12" stdDeviation="14" flood-color="${LIGHT.content}" flood-opacity="0.26"/></filter>` +
      `<filter id="grain" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="7"/><feColorMatrix values="0 0 0 0 0.22  0 0 0 0 0.165  0 0 0 0 0.137  0 0 0 0.16 0"/></filter>` +
      `</defs>` +
      `<rect width="${W}" height="${H}" fill="${LIGHT.base200}"/>` +
      `<rect width="${W}" height="${H}" filter="url(#grain)"/>` +
      // The masthead: the lockup over a double rule, as in the app's header.
      `<g transform="translate(72 52) scale(1.4)">${lockupElements(LIGHT)}</g>` +
      `<line x1="72" y1="148" x2="1128" y2="148" stroke="rgba(56,42,35,0.4)" stroke-width="1.5"/>` +
      `<line x1="72" y1="154" x2="1128" y2="154" stroke="rgba(56,42,35,0.22)" stroke-width="1.5"/>` +
      tagline +
      footnote +
      `<rect x="72" y="${(firstBaseline + (lines.length - 1) * lineGap + 44).toFixed(0)}" width="64" height="4" rx="2" fill="${LIGHT.primary}"/>` +
      `<g filter="url(#sheet)"><rect x="${px + 14}" y="${py + 20}" width="${pw}" height="${ph}" fill="${LIGHT.base300}" transform="rotate(4 ${centre})"/></g>` +
      `<g filter="url(#sheet)"><rect x="${px - 6}" y="${py + 8}" width="${pw}" height="${ph}" fill="${LIGHT.base100}" transform="rotate(-3 ${centre})"/></g>` +
      `<g transform="rotate(-1 ${centre})">` +
      `<g filter="url(#sheet)"><rect x="${px}" y="${py}" width="${pw}" height="${ph}" fill="${LIGHT.base100}"/></g>` +
      `<image href="${photo}" x="${inner.x}" y="${inner.y}" width="${inner.w}" height="${inner.h}" preserveAspectRatio="xMidYMid slice"/>` +
      leaders +
      pinMarks +
      badges +
      `</g>`,
    ` role="img" aria-label="Evidomo"`,
  );
}

const png = (svg, size) =>
  sharp(Buffer.from(svg), { density: 384 })
    .resize(size.w, size.h ?? size.w)
    .png()
    .toBuffer();

// ICO container: a header, one directory entry per image, then the PNG payloads.
function ico(images) {
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach(({ size, data }, i) => {
    const at = 6 + 16 * i;
    head.writeUInt8(size, at);
    head.writeUInt8(size, at + 1);
    head.writeUInt16LE(1, at + 4);
    head.writeUInt16LE(32, at + 6);
    head.writeUInt32LE(data.length, at + 8);
    head.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...images.map((i) => i.data)]);
}

async function write(rel, data) {
  const file = join(publicDir, rel);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, data);
  console.log(`wrote public/${rel}`);
}

await write('favicon.svg', faviconSvg);
await write(
  'brand/evidomo-mark.svg',
  wrap(
    64,
    62,
    `<g transform="translate(0 -1)">${markElements(LIGHT)}</g>`,
    ' role="img" aria-label="Evidomo"',
  ),
);
await write('brand/evidomo-lockup-light.svg', lockupSvg(LIGHT));
await write('brand/evidomo-lockup-dark.svg', lockupSvg(DARK));

await write('apple-touch-icon.png', await png(tileSvg(180, 0.64), { w: 180 }));
await write('icon-192.png', await png(tileSvg(192, 0.64), { w: 192 }));
await write('icon-512.png', await png(tileSvg(512, 0.64), { w: 512 }));
// Maskable: the mark stays inside the central safe zone (a circle of 40% of the edge).
await write('icon-maskable-512.png', await png(tileSvg(512, 0.6), { w: 512 }));

const tile = (px) => png(tileSvg(px, 0.78, 0.2), { w: px });
await write(
  'favicon.ico',
  ico([
    { size: 16, data: await tile(16) },
    { size: 32, data: await tile(32) },
  ]),
);

const ogPhoto = await ogPhotoDataUri();
for (const locale of OG_LOCALES) {
  await write(`og-${locale}.png`, await png(ogSvg(locale, ogPhoto), { w: 1200, h: 630 }));
}
