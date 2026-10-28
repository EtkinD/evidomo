// Test support for the P1-06 Muse Image fixtures (imported only by `muse-image-*.test.ts`).
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { MetaImageResult } from './images.ts';
import type { ReplayMode } from './replay.ts';

/** Optional: `P1_06_EXPORT_DIR=<dir>` writes each returned image there (works in replay too). */
export const P1_06_EXPORT_DIR = process.env['P1_06_EXPORT_DIR'];

const EXTENSIONS = { jpeg: 'jpg', png: 'png', webp: 'webp' } as const;

/**
 * Writes the returned image to the export directory and, in record mode, appends one metrics
 * line (latency is only meaningful for live calls). No-op without `P1_06_EXPORT_DIR`.
 */
export async function exportImageResult(
  id: string,
  result: MetaImageResult,
  mode: ReplayMode,
  extra: Readonly<Record<string, unknown>> = {},
): Promise<void> {
  if (P1_06_EXPORT_DIR === undefined || P1_06_EXPORT_DIR === '') return;
  await mkdir(P1_06_EXPORT_DIR, { recursive: true });
  const [image] = result.images;
  if (image === undefined) return;
  await writeFile(path.join(P1_06_EXPORT_DIR, `${id}.${EXTENSIONS[image.format]}`), image.bytes);
  if (mode === 'record') {
    const line = {
      id,
      ...extra,
      width: image.width,
      height: image.height,
      container: image.format,
      outputFormat: result.outputFormat,
      bytes: image.bytes.byteLength,
      latencyMs: Math.round(result.usage.latencyMs),
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      images: result.usage.images,
      estimatedCostUsd: result.usage.estimatedCostUsd,
    };
    await appendFile(path.join(P1_06_EXPORT_DIR, 'metrics.jsonl'), `${JSON.stringify(line)}\n`);
  }
}
