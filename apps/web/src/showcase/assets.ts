import { useQuery } from '@tanstack/react-query';
import type { DirectionId } from './palettes';

export const ASSET_KINDS = ['logo-concept', 'hero', 'interior', 'illustration'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

// The web app has no zod dependency, and this exploration code is removed after P4B-02, so the
// manifest is checked by hand instead of adding one.
export interface AssetItem {
  readonly id: string;
  readonly direction: DirectionId;
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

function isDirection(value: unknown): value is DirectionId {
  return value === 'A' || value === 'B' || value === 'C';
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
  if (!isDirection(direction)) return `${at}.direction must be A, B, or C`;
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
    const result = parseItem(item, index);
    if (typeof result === 'string') return { success: false, message: result };
    parsed.push(result);
  }
  return { success: true, data: { generatedAt, toolsOff, items: parsed } };
}

/**
 * The gitignored manifest written by the Muse image run. A missing file is a normal state (the
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

export function itemsFor(
  manifest: AssetManifest | undefined,
  direction: DirectionId,
  kinds: readonly AssetKind[],
): AssetItem[] {
  return (manifest?.items ?? []).filter(
    (item) => item.direction === direction && kinds.includes(item.kind),
  );
}
