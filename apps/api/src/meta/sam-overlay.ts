// Inspection tooling (docs/model-notes.md, P1-05): draws SAM boxes and masks over the source
// image so a person can check that they line up. Not used by the pipeline.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_FFMPEG_TIMEOUT_MS, fileUrl, runFfmpeg } from '../media/convert.ts';
import { encodeRgbaPng } from '../media/png.ts';
import { decodeSamMask } from './sam-mask.ts';
import type { SamInstance } from './sam-output.ts';

export type Rgb = readonly [number, number, number];

export interface OverlayLayer {
  readonly instances: readonly SamInstance[];
  readonly color: Rgb;
}

const MASK_ALPHA = 110;
const BOX_STROKE = 3;

function paint(rgba: Uint8Array, width: number, x: number, y: number, color: Rgb, alpha: number) {
  const i = (y * width + x) * 4;
  rgba[i] = color[0];
  rgba[i + 1] = color[1];
  rgba[i + 2] = color[2];
  rgba[i + 3] = alpha;
}

/**
 * A transparent RGBA layer of the image's size: each mask filled semi-transparently, each box
 * outlined opaquely, in its layer's colour. Masks are placed at their box's top-left corner.
 */
export function renderOverlayLayer(
  width: number,
  height: number,
  layers: readonly OverlayLayer[],
): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  for (const { instances, color } of layers) {
    for (const { box, mask } of instances) {
      if (box.x1 > width || box.y1 > height) {
        throw new RangeError(
          `Box (${box.x0},${box.y0})-(${box.x1},${box.y1}) exceeds ${width}x${height}`,
        );
      }
      const raster = decodeSamMask(mask);
      for (let y = 0; y < mask.height; y += 1) {
        for (let x = 0; x < mask.width; x += 1) {
          if (raster[y * mask.width + x] === 1)
            paint(rgba, width, box.x0 + x, box.y0 + y, color, MASK_ALPHA);
        }
      }
      for (let y = box.y0; y < box.y1; y += 1) {
        for (let x = box.x0; x < box.x1; x += 1) {
          const edge =
            x - box.x0 < BOX_STROKE ||
            box.x1 - 1 - x < BOX_STROKE ||
            y - box.y0 < BOX_STROKE ||
            box.y1 - 1 - y < BOX_STROKE;
          if (edge) paint(rgba, width, x, y, color, 255);
        }
      }
    }
  }
  return rgba;
}

export interface RenderOverlayOptions {
  readonly imagePath: string;
  readonly outputPath: string;
  readonly width: number;
  readonly height: number;
  readonly layers: readonly OverlayLayer[];
  readonly ffmpegPath?: string;
}

/** Writes `outputPath` (PNG): the image with the overlay layer composited by ffmpeg. */
export async function renderSamOverlayPng(options: RenderOverlayOptions): Promise<void> {
  const layer = renderOverlayLayer(options.width, options.height, options.layers);
  await mkdir(path.dirname(options.outputPath), { recursive: true });
  const dir = await mkdtemp(path.join(tmpdir(), 'sam-overlay-'));
  try {
    const layerPath = path.join(dir, 'layer.png');
    await writeFile(layerPath, encodeRgbaPng(options.width, options.height, layer));
    await runFfmpeg(
      options.ffmpegPath ?? 'ffmpeg',
      [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        fileUrl(options.imagePath),
        '-i',
        fileUrl(layerPath),
        '-filter_complex',
        '[0:v][1:v]overlay=0:0:format=auto',
        '-frames:v',
        '1',
        '-update',
        '1',
        fileUrl(options.outputPath),
      ],
      DEFAULT_FFMPEG_TIMEOUT_MS,
      undefined,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
