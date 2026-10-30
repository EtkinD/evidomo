import { useQuery } from '@tanstack/react-query';
export const ASSET_KINDS = ['hero', 'interior', 'illustration'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

// The founder's four approved images (P4B-02). The gitignored manifest still lists every image the
// exploration generated; only these IDs are ever read from it. The IDs keep their original names so
// earlier feedback still points at the same pictures.
export const APPROVED_IMAGES = {
  hero: {
    id: 'B2-HERO-1',
    alt: 'A bright, empty canal-house living room with a limewashed brick wall and oak floor',
  },
  floor: {
    id: 'B2-INT-1',
    alt: 'Morning light across an oak herringbone floor that meets clay kitchen tiles',
  },
  fireplace: {
    id: 'B2-INT-2',
    alt: 'A limewashed brick fireplace with an oak mantel and a small plant',
  },
  illustration: {
    id: 'B2-ILL-1',
    alt: 'A rounded house with its front door open and a potted plant by the step',
  },
} as const;

export type ApprovedImageKey = keyof typeof APPROVED_IMAGES;

export const APPROVED_IMAGE_IDS: readonly string[] = Object.values(APPROVED_IMAGES).map(
  (image) => image.id,
);

// The web app has no zod dependency and this is dev-only code, so the manifest is checked by hand
// instead of adding one.
export interface AssetItem {
  readonly id: string;
  readonly direction: string;
  readonly kind: AssetKind;
  readonly file: string;
  readonly prompt: string;
  readonly width: number;
  readonly height: number;
}

export interface AssetManifest {
  readonly generatedAt: string;
  readonly toolsOff: 'generations' | 'edit-json';
  readonly items: readonly AssetItem[];
}

export const ASSET_BASE = '/showcase-assets';

export type ManifestResult =
  | { status: 'ready'; manifest: AssetManifest }
  | { status: 'missing' }
  | { status: 'invalid'; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isKind(value: unknown): value is AssetKind {
  return ASSET_KINDS.some((kind) => kind === value);
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function parseItem(value: unknown, index: number): AssetItem | string {
  const at = `items[${index}]`;
  if (!isRecord(value)) return `${at} is not an object`;
  const { id, direction, kind, file, prompt, width, height } = value;
  if (typeof id !== 'string' || id === '') return `${at}.id is missing`;
  if (typeof direction !== 'string' || direction === '') return `${at}.direction is missing`;
  if (!isKind(kind)) return `${at}.kind is not a known kind`;
  if (typeof file !== 'string' || file === '') return `${at}.file is missing`;
  if (typeof prompt !== 'string') return `${at}.prompt is missing`;
  if (!isPositiveInt(width) || !isPositiveInt(height))
    return `${at} needs a positive integer width and height`;
  return { id, direction, kind, file, prompt, width, height };
}

export type ManifestCheck =
  | { readonly success: true; readonly data: AssetManifest }
  | { readonly success: false; readonly message: string };

export function parseManifest(value: unknown): ManifestCheck {
  if (!isRecord(value)) return { success: false, message: 'The manifest is not an object' };
  const { generatedAt, toolsOff, items } = value;
  if (typeof generatedAt !== 'string') return { success: false, message: 'generatedAt is missing' };
  if (toolsOff !== 'generations' && toolsOff !== 'edit-json')
    return { success: false, message: 'toolsOff must be generations or edit-json' };
  if (!Array.isArray(items)) return { success: false, message: 'items is not a list' };
  const parsed: AssetItem[] = [];
  for (const [index, item] of items.entries()) {
    // Unapproved images are neither shown nor validated.
    if (
      !isRecord(item) ||
      typeof item['id'] !== 'string' ||
      !APPROVED_IMAGE_IDS.includes(item['id'])
    )
      continue;
    const result = parseItem(item, index);
    if (typeof result === 'string') return { success: false, message: result };
    parsed.push(result);
  }
  return { success: true, data: { generatedAt, toolsOff, items: parsed } };
}

/**
 * The gitignored manifest written by the Muse image run, reduced to the approved images. A missing file is a normal state (the
 * assets are not generated yet); a malformed one is reported, not silently ignored.
 */
export async function fetchManifest(): Promise<ManifestResult> {
  const response = await fetch(`${ASSET_BASE}/manifest.json`);
  if (!response.ok) return { status: 'missing' };
  // Next serves an HTML 404 page with a 200 for some missing static paths in dev; JSON parsing
  // fails on it, which is the same "not generated yet" state.
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { status: 'missing' };
  }
  const parsed = parseManifest(body);
  if (!parsed.success) return { status: 'invalid', message: parsed.message };
  return { status: 'ready', manifest: parsed.data };
}

export function useAssetManifest() {
  return useQuery({
    queryKey: ['showcase', 'assets-manifest'],
    queryFn: fetchManifest,
    retry: false,
    staleTime: 30_000,
  });
}

export function assetUrl(item: AssetItem): string {
  return `${ASSET_BASE}/${item.file}`;
}
