import {
  PHRASING_CATEGORIES,
  STAGED_IMAGE_LABEL,
  isOverridablePhrasingCategory,
  phrasingCategorySchema,
  type ClaimAuditCategory,
  type ClaimAuditWarning,
  type MarketProfile,
  type OfficeProfile,
  type PhrasingCategory,
  type PortalCopySegment,
  type PortalCopyVariant,
  type PortalFields,
  type PortalImage,
  type PortalOtherFact,
  type PortalProfileField,
} from '@evidomo/shared';
import { escapeHtml as esc } from './escape.ts';
import { packStrings, type PackStrings } from './strings.ts';

// The print-ready HTML pack: one self-contained file (inline CSS, images as data URIs, no script)
// rendered from the validated portal fields, so the HTML and the JSON cannot disagree. Every
// interpolated string is escaped; nothing here reads a clock.
//
// Why embedded images: the pack is downloaded and printed as one file, and P4-08 can serve it
// without a file route that maps relative names to artifacts. The images are also exported as
// separate files for portal uploads; the HTML costs about 4/3 of their size again.

export interface ListingPackHtmlInput {
  readonly fields: PortalFields;
  readonly market: MarketProfile;
  readonly title: string;
  readonly office: OfficeProfile;
  /** Exported image bytes by file name; every image in `fields.images` must be present. */
  readonly images: ReadonlyMap<string, Uint8Array>;
  readonly warnings: readonly ClaimAuditWarning[];
  /** The claim audit's remaining flag categories per claim ID (for Gate 2 overrides). */
  readonly flagCategories: ReadonlyMap<string, readonly ClaimAuditCategory[]>;
}

/** No network, no script: images are data URIs and the styles are inline. */
export const PACK_CONTENT_SECURITY_POLICY =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'";

const CSS = `@page{size:A4;margin:16mm 15mm 18mm}
*{box-sizing:border-box}
body{margin:0;font:10.5pt/1.5 "Helvetica Neue",Helvetica,Arial,sans-serif;color:#1d1d1f;background:#fff}
main{max-width:180mm;margin:0 auto}
h1{font-size:20pt;line-height:1.2;margin:0 0 2mm}
h2{font-size:13pt;margin:8mm 0 3mm;padding-bottom:1.5mm;border-bottom:.4mm solid #d0d0d0;break-after:avoid}
h3{font-size:11pt;margin:5mm 0 2mm;break-after:avoid}
p{margin:0 0 2.5mm}
.agency{text-transform:uppercase;letter-spacing:.08em;font-size:8.5pt;color:#555;margin:0 0 1mm}
.meta{color:#555;font-size:9pt;margin:0}
.notice{border:.6mm solid #b42318;background:#fef3f2;padding:3mm 4mm;margin:6mm 0;break-inside:avoid}
.notice h2{color:#b42318;border:0;margin:0 0 2mm;padding:0}
table{width:100%;border-collapse:collapse;font-size:9.5pt}
th,td{text-align:left;vertical-align:top;padding:1.6mm 2mm;border-bottom:.2mm solid #e2e2e2}
th{font-weight:600;color:#444}
tr{break-inside:avoid}
.missing{color:#b42318}
.note{color:#555;font-size:9pt}
.photos{display:grid;grid-template-columns:1fr 1fr;gap:4mm}
.pair{grid-column:1/-1;display:grid;grid-template-columns:1fr 1fr;gap:4mm}
figure{margin:0;break-inside:avoid}
img{display:block;width:100%;height:auto}
figcaption{font-size:8.5pt;color:#444;margin-top:1mm}
.label{display:inline-block;background:#111;color:#fff;font-weight:600;padding:0 1.6mm;border-radius:1mm;margin-right:1.5mm}
.status{font-weight:600;white-space:nowrap}
.status-pass{color:#067647}
.status-fail{color:#b42318}
.status-not_applicable{color:#555}
blockquote{margin:1mm 0 2mm;padding-left:3mm;border-left:.6mm solid #d0d0d0}
footer{margin-top:10mm;font-size:8.5pt;color:#555;border-top:.2mm solid #d0d0d0;padding-top:3mm}
@media screen{body{background:#f4f4f5}main{background:#fff;padding:14mm 15mm;margin:8mm auto;box-shadow:0 1px 4px rgba(0,0,0,.12)}}`;

/** `2026-10-29T14:03:12.000Z` → `2026-10-29 14:03` (UTC), from the stored approval time. */
export function formatApprovedAt(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

function formatNumber(value: number, language: string): string {
  // Exactly the verified value: no rounding, grouping, or locale data (deterministic).
  const text = String(value);
  return language === 'nl' ? text.replace('.', ',') : text;
}

const UNIT_DISPLAY: Readonly<Record<string, string>> = {
  m2: 'm²',
  sq_ft: 'sq ft',
  m3: 'm³',
  cu_ft: 'cu ft',
};

function withUnit(value: number, unit: string | null, language: string): string {
  const number = formatNumber(value, language);
  if (unit === null) return number;
  if (unit === 'EUR') return `€ ${number}`;
  return `${number} ${UNIT_DISPLAY[unit] ?? unit}`;
}

function scalarText(value: string | number | boolean, language: string, t: PackStrings): string {
  if (typeof value === 'boolean') return value ? t.yes : t.no;
  if (typeof value === 'number') return formatNumber(value, language);
  return value;
}

function fieldValue(field: PortalProfileField, language: string, t: PackStrings): string {
  if (field.status === 'missing') return `<span class="missing">${esc(t.missing)}</span>`;
  if (field.status === 'ambiguous') return `<span class="missing">${esc(t.ambiguous)}</span>`;
  switch (field.type) {
    case 'enum':
      return esc(field.value ?? '');
    case 'area':
    case 'volume':
    case 'money':
      return field.value === null ? '' : esc(withUnit(field.value, field.unit, language));
    case 'integer':
      // Years and counts: never grouped.
      return field.value === null ? '' : esc(String(field.value));
    case 'boolean':
      return field.value === null ? '' : esc(field.value ? t.yes : t.no);
    default: {
      const unreachable: never = field;
      throw new Error(`Unhandled field type: ${JSON.stringify(unreachable)}`);
    }
  }
}

/** `other:station_cycling_time_minutes` → `Station cycling time minutes`. */
export function humanizeKey(key: string): string {
  const words = key.replace(/^other:/, '').replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function otherValue(fact: PortalOtherFact, language: string, t: PackStrings): string {
  if (typeof fact.value === 'number') return withUnit(fact.value, fact.unit, language);
  const text = scalarText(fact.value, language, t);
  return fact.unit === null ? text : `${text} ${fact.unit}`;
}

function sourceList(sources: readonly PortalProfileField['sources'][number][], t: PackStrings) {
  return esc(sources.map((kind) => t.sources[kind]).join(', '));
}

function renderVariant(variant: PortalCopyVariant, title: string, t: PackStrings): string {
  if (variant.segments.length === 0) {
    return `<h3>${esc(title)}</h3><p class="missing">${esc(t.variantEmpty)}</p>`;
  }
  const paragraphs: string[][] = [];
  let current: number | null = null;
  for (const segment of variant.segments) {
    if (segment.paragraph !== current) {
      paragraphs.push([]);
      current = segment.paragraph;
    }
    paragraphs.at(-1)?.push(segment.text);
  }
  return `<h3>${esc(title)}</h3>${paragraphs.map((p) => `<p>${esc(p.join(' '))}</p>`).join('')}`;
}

function renderFacts(fields: PortalFields, t: PackStrings): string {
  const language = fields.outputLanguage;
  const rows = fields.facts.profile
    .map(
      (field) =>
        `<tr><th scope="row">${esc(field.label)}</th><td>${fieldValue(field, language, t)}</td>` +
        `<td>${field.type === 'area' ? esc(field.basis.label) : ''}</td>` +
        `<td>${sourceList(field.sources, t)}</td></tr>`,
    )
    .join('');
  const head =
    `<thead><tr><th scope="col">${esc(t.factColumn)}</th><th scope="col">${esc(t.valueColumn)}</th>` +
    `<th scope="col">${esc(t.basisColumn)}</th><th scope="col">${esc(t.sourceColumn)}</th></tr></thead>`;
  let html = `<section id="facts"><h2>${esc(t.factsTitle)}</h2><table>${head}<tbody>${rows}</tbody></table>`;
  if (fields.facts.other.length > 0) {
    const otherRows = fields.facts.other
      .map(
        (fact) =>
          `<tr><th scope="row">${esc(humanizeKey(fact.key))}</th>` +
          `<td>${esc(otherValue(fact, language, t))}</td><td>${esc(fact.basis ?? '')}</td>` +
          `<td>${sourceList(fact.sources, t)}</td></tr>`,
      )
      .join('');
    html += `<h3>${esc(t.otherFactsTitle)}</h3><table>${head}<tbody>${otherRows}</tbody></table>`;
  }
  if (fields.facts.presences.length > 0) {
    const items = fields.facts.presences
      .map((presence) => {
        const rooms = presence.seenIn.map((room) => humanizeKey(room).toLowerCase()).join(', ');
        return `<li>${esc(humanizeKey(presence.key))}${rooms === '' ? '' : ` (${esc(t.seenIn(rooms))})`}</li>`;
      })
      .join('');
    html += `<h3>${esc(t.presencesTitle)}</h3><ul>${items}</ul><p class="note">${esc(t.presenceNote)}</p>`;
  }
  return `${html}</section>`;
}

function photoNumber(fileName: string): number {
  return Number(/^photo-(\d+)/.exec(fileName)?.[1] ?? '0');
}

function figure(
  image: PortalImage,
  images: ReadonlyMap<string, Uint8Array>,
  t: PackStrings,
): string {
  const bytes = images.get(image.fileName);
  if (bytes === undefined) throw new Error(`No bytes for exported image ${image.fileName}`);
  const n = photoNumber(image.fileName);
  const src = `data:image/jpeg;base64,${Buffer.from(bytes).toString('base64')}`;
  let alt: string;
  let caption: string;
  if (image.kind === 'staged') {
    alt = `${t.photo(n)}, ${STAGED_IMAGE_LABEL}`;
    caption = `<span class="label">${esc(image.disclosure.label)}</span>${esc(t.photo(n))}`;
  } else {
    const parts = [t.photo(n)];
    if (image.stagedFileName !== null) parts.push(t.original);
    if (image.privacy.blurredRegions > 0) parts.push(t.blurred);
    alt = parts.join(', ');
    caption = esc(parts.join(' · '));
  }
  return (
    `<figure><img src="${src}" alt="${esc(alt)}" width="${image.width}" height="${image.height}">` +
    `<figcaption>${caption}</figcaption></figure>`
  );
}

function renderPhotos(input: ListingPackHtmlInput, t: PackStrings): string {
  const { fields } = input;
  const parts: string[] = [];
  for (let i = 0; i < fields.images.length; i += 1) {
    const image = fields.images[i];
    if (image === undefined) continue;
    const next = fields.images[i + 1];
    if (image.kind === 'staged' && next?.kind === 'original') {
      // The staged image takes the photo's place; its original is shown right next to it.
      parts.push(
        `<div class="pair">${figure(image, input.images, t)}${figure(next, input.images, t)}</div>`,
      );
      i += 1;
    } else {
      parts.push(figure(image, input.images, t));
    }
  }
  let html = `<section id="photos"><h2>${esc(t.photosTitle)}</h2>`;
  html +=
    parts.length > 0
      ? `<div class="photos">${parts.join('')}</div>`
      : `<p class="missing">${esc(t.noPhotos)}</p>`;
  if (fields.withheld.length > 0) {
    const items = fields.withheld
      .map(
        (entry) =>
          `<li>${esc(t.upload(entry.uploadPosition, entry.kind === 'staged'))}: ${esc(t.withheld[entry.reason])}</li>`,
      )
      .join('');
    html += `<h3>${esc(t.withheldTitle)}</h3><ul class="withheld">${items}</ul>`;
  }
  return `${html}</section>`;
}

interface QuotedSegment {
  readonly segment: PortalCopySegment;
  readonly variant: 'portal' | 'social';
}

function quote({ segment, variant }: QuotedSegment, t: PackStrings): string {
  return `<blockquote><span class="note">${esc(t.variantName[variant])}:</span> ${esc(segment.text)}</blockquote>`;
}

/**
 * The non-overridable phrasing categories (`exclusionary`) a claim approved as written at Gate 2
 * was flagged in: from its remaining audit flags, and from any failing `no_flagged_phrasing`
 * item that lists it as accepted. Approving such a flag is recorded but never allowed, so the
 * pack shows it as a failure, not as an operator override.
 */
function refusedCategories(input: ListingPackHtmlInput, claimId: string): PhrasingCategory[] {
  const fromFlags = (input.flagCategories.get(claimId) ?? []).flatMap((category) => {
    const parsed = phrasingCategorySchema.safeParse(category);
    return parsed.success ? [parsed.data] : [];
  });
  const fromChecklist = input.fields.publicationChecklist.items.flatMap((item) =>
    item.rule === 'no_flagged_phrasing' &&
    item.status === 'fail' &&
    item.acceptedClaimIds.includes(claimId)
      ? [item.category]
      : [],
  );
  return PHRASING_CATEGORIES.filter(
    (category) =>
      !isOverridablePhrasingCategory(category) &&
      (fromFlags.includes(category) || fromChecklist.includes(category)),
  );
}

interface Gate2Decisions {
  /** Approved as written in a category that allows it. */
  readonly overrides: readonly QuotedSegment[];
  /** Approved as written in a non-overridable category: a failure. */
  readonly refused: readonly (QuotedSegment & { readonly categories: PhrasingCategory[] })[];
  readonly edited: readonly QuotedSegment[];
}

function gate2Decisions(input: ListingPackHtmlInput): Gate2Decisions {
  const { copy } = input.fields;
  const segments: QuotedSegment[] = [
    ...copy.portal.segments.map((segment) => ({ segment, variant: 'portal' as const })),
    ...copy.social.segments.map((segment) => ({ segment, variant: 'social' as const })),
  ];
  const overrides: QuotedSegment[] = [];
  const refused: (QuotedSegment & { categories: PhrasingCategory[] })[] = [];
  for (const entry of segments) {
    if (entry.segment.origin !== 'accepted') continue;
    const categories = refusedCategories(input, entry.segment.claimId);
    if (categories.length > 0) refused.push({ ...entry, categories });
    else overrides.push(entry);
  }
  return { overrides, refused, edited: segments.filter((s) => s.segment.origin === 'edited') };
}

/** Allowed overrides and rewrites from Gate 2, quoting the published text. */
function renderOverrides(decisions: Gate2Decisions, t: PackStrings): string {
  let html = `<h3>${esc(t.overridesTitle)}</h3>`;
  html +=
    decisions.overrides.length > 0
      ? decisions.overrides.map((entry) => quote(entry, t)).join('')
      : `<p class="note">${esc(t.overridesNone)}</p>`;
  if (decisions.edited.length > 0) {
    html += `<h3>${esc(t.editedTitle)}</h3>${decisions.edited.map((entry) => quote(entry, t)).join('')}`;
  }
  return html;
}

function renderRefused(decisions: Gate2Decisions, t: PackStrings): string {
  return decisions.refused
    .map((entry) => {
      const names = entry.categories.map((category) => t.phrasingCategory[category]).join(', ');
      return `<h3 class="missing">${esc(t.refusedTitle(names))}</h3>${quote(entry, t)}`;
    })
    .join('');
}

function renderWarnings(input: ListingPackHtmlInput, t: PackStrings): string {
  if (input.warnings.length === 0) return '';
  const label = (key: string): string =>
    input.market.facts.find((fact) => fact.key === key)?.label ?? humanizeKey(key);
  const items = input.warnings
    .map((warning) => {
      switch (warning.kind) {
        case 'market_fact_unmentioned':
          return t.warningUnmentioned(
            t.variantName[warning.variant],
            label(warning.factKey),
            warning.required,
          );
        case 'variant_empty':
          return t.warningEmpty(t.variantName[warning.variant]);
        default: {
          const unreachable: never = warning;
          throw new Error(`Unhandled warning: ${JSON.stringify(unreachable)}`);
        }
      }
    })
    .map((text) => `<li>${esc(text)}</li>`)
    .join('');
  return `<h3>${esc(t.warningsTitle)}</h3><ul>${items}</ul>`;
}

function renderChecklist(input: ListingPackHtmlInput, t: PackStrings): string {
  const { publicationChecklist: checklist } = input.fields;
  const rows = checklist.items
    .map(
      (item) =>
        `<tr><th scope="row">${esc(item.label)}</th>` +
        `<td><span class="status status-${esc(item.status)}">${esc(t.status[item.status])}</span></td>` +
        `<td>${esc(item.detail)}</td></tr>`,
    )
    .join('');
  let html =
    `<section id="checklist"><h2>${esc(t.checklistTitle)}</h2><table><thead><tr>` +
    `<th scope="col">${esc(t.itemColumn)}</th><th scope="col">${esc(t.statusColumn)}</th>` +
    `<th scope="col">${esc(t.detailColumn)}</th></tr></thead><tbody>${rows}</tbody></table>`;
  // While the notice is shown, the overrides are named there instead.
  const decisions = gate2Decisions(input);
  if (checklist.summary.readyToPublish && decisions.refused.length === 0) {
    html += renderOverrides(decisions, t);
  }
  html += renderWarnings(input, t);
  return `${html}</section>`;
}

function renderNotice(input: ListingPackHtmlInput, t: PackStrings): string {
  const { publicationChecklist: checklist } = input.fields;
  const decisions = gate2Decisions(input);
  const ready = checklist.summary.readyToPublish;
  // A refused override is shown even when the market's checklist has no item for its category.
  if (ready && decisions.refused.length === 0) return '';
  const failing = checklist.items.filter((item) => item.status === 'fail');
  const failingList =
    failing.length > 0
      ? `<p>${esc(t.notReadyBody(failing.length))}</p>` +
        `<ul>${failing.map((item) => `<li>${esc(item.label)}</li>`).join('')}</ul>`
      : '';
  return (
    `<section class="notice" id="not-ready" aria-labelledby="not-ready-title">` +
    `<h2 id="not-ready-title">${esc(ready ? t.reviewTitle : t.notReadyTitle)}</h2>` +
    `${failingList}${renderRefused(decisions, t)}${renderOverrides(decisions, t)}</section>`
  );
}

function renderContact(office: OfficeProfile): string {
  const lines = (office.contactBlock ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return [office.agencyName, ...lines].map(esc).join('<br>');
}

/** Renders the pack. Deterministic: the same input always gives the same string. */
export function renderListingPackHtml(input: ListingPackHtmlInput): string {
  const { fields } = input;
  const t = packStrings(fields.outputLanguage);
  return [
    '<!doctype html>',
    `<html lang="${esc(fields.outputLanguage)}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="${esc(PACK_CONTENT_SECURITY_POLICY)}">`,
    '<meta name="referrer" content="no-referrer">',
    `<title>${esc(`${input.title} · ${t.packTitle}`)}</title>`,
    `<style>${CSS}</style>`,
    '</head>',
    '<body>',
    '<main>',
    `<header><p class="agency">${esc(input.office.agencyName)}</p><h1>${esc(input.title)}</h1>` +
      `<p class="meta">${esc(t.approved(formatApprovedAt(fields.approvedAt)))} · ${esc(t.market(input.market.name))}</p></header>`,
    renderNotice(input, t),
    `<section id="copy"><h2>${esc(t.copyTitle)}</h2>` +
      renderVariant(fields.copy.portal, t.portalTitle, t) +
      renderVariant(fields.copy.social, t.socialTitle, t) +
      '</section>',
    renderFacts(fields, t),
    renderPhotos(input, t),
    renderChecklist(input, t),
    `<footer><p>${renderContact(input.office)}</p><p>${esc(t.generated(fields.runId))}</p></footer>`,
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
