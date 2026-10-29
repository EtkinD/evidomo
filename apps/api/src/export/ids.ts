import { createHash } from 'node:crypto';

// Content-derived artifact IDs for the exported files. The portal fields name each image's file
// artifact, so the IDs must be known before anything is stored and identical when the same run
// is exported again: random IDs would make the JSON differ on every rebuild.

/**
 * A UUIDv8 (RFC 9562, custom) from SHA-256 of the run ID and the file name. Unique per run and
 * file; the same inputs always give the same ID.
 */
export function exportArtifactId(runId: string, fileName: string): string {
  const hex = createHash('sha256').update(`evidomo:export:v1:${runId}:${fileName}`).digest('hex');
  const variant = ((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `8${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}
