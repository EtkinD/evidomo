import { decodeSamMask, type SamEncodedMask } from './sam-mask.ts';

/**
 * Parser for SAM 3.1 special-token output (docs/model-notes.md, P1-05; grammar from Meta's
 * "Read Segment Anything Model segmentation output"). An image result is one line:
 *
 *   <0f>id<|box;x1=..;y1=..;x2=..;y2=..;w=..;h=..[;c=..]|><|mask;x=0;y=0[;c=..];data=H,W,!…|>,id…
 *
 * Model output is untrusted. Anything that deviates from the documented grammar (unknown
 * tokens or fields, out-of-range boxes, mask rasters that do not match their box, payloads
 * the decoder rejects) throws `SamOutputError`; nothing is skipped silently.
 */

export class SamOutputError extends Error {
  override name = 'SamOutputError';
}

/**
 * Bounding box in source-image **pixels**, origin top-left, **half-open**: the box covers
 * columns `x0 ≤ x < x1` and rows `y0 ≤ y < y1`. The wire's `x2`/`y2` are inclusive, so
 * `x1 = x2 + 1`; `x1 - x0` equals the mask raster width.
 */
export interface SamBox {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

export interface SamInstance {
  /** Per-response object id (not dense, not a class). */
  readonly objectId: number;
  /** Model confidence 0..1; present only when the request set `include_confidence`. */
  readonly score: number | undefined;
  readonly box: SamBox;
  /** Encoded mask; its raster covers `box` 1:1. Decode with `decodeSamMask`. */
  readonly mask: SamEncodedMask;
}

export interface SamImageOutput {
  /** Source size echoed on every record (`w`, `h`); `undefined` for an empty result. */
  readonly sourceSize: { readonly width: number; readonly height: number } | undefined;
  /** In output order. Empty when the concept is absent (a valid result, not an error). */
  readonly instances: readonly SamInstance[];
}

const FRAME = /^<(\d+)f>/;
const RECORD_START = /^,?(\d+)(?=<\|)/;
const TOKEN = /^<\|([a-z]+)((?:;[^|]*)?)\|>/;
const INT = /^\d+$/;
const DECIMAL = /^\d+(?:\.\d+)?$/;
const MASK_DATA = /^(\d+),(\d+),([!~])(.+)$/;
const BOX_KEYS = ['x1', 'y1', 'x2', 'y2', 'w', 'h'] as const;
/**
 * Grammar-level payload check only: printable ASCII without the token delimiters. Whether the
 * characters form a valid encoding is the decoder's job (`decodeSamMask`).
 */
const PAYLOAD = /^[!-~]+$/;
const PAYLOAD_DELIMITERS = /[|;,<>]/;

function fail(message: string, record?: number): never {
  throw new SamOutputError(record === undefined ? message : `Record ${record}: ${message}`);
}

/** `;k=v;k=v` → map. Every key must be in `allowed`; duplicates are malformed. */
function readFields(
  body: string,
  token: string,
  allowed: readonly string[],
  record: number,
): Map<string, string> {
  const fields = new Map<string, string>();
  for (const part of body.split(';').slice(1)) {
    const eq = part.indexOf('=');
    if (eq <= 0) fail(`${token} field "${part}" has no value`, record);
    const key = part.slice(0, eq);
    if (!allowed.includes(key)) fail(`unknown ${token} field "${key}"`, record);
    if (fields.has(key)) fail(`repeated ${token} field "${key}"`, record);
    fields.set(key, part.slice(eq + 1));
  }
  return fields;
}

function readInt(fields: Map<string, string>, key: string, token: string, record: number): number {
  const text = fields.get(key);
  if (text === undefined) fail(`${token} is missing "${key}"`, record);
  if (!INT.test(text)) fail(`${token} "${key}" is not a non-negative integer: "${text}"`, record);
  const value = Number(text);
  if (!Number.isSafeInteger(value)) fail(`${token} "${key}" is out of range`, record);
  return value;
}

function readScore(fields: Map<string, string>, token: string, record: number): number | undefined {
  const text = fields.get('c');
  if (text === undefined) return undefined;
  const value = Number(text);
  if (!DECIMAL.test(text) || value > 1)
    fail(`${token} confidence "${text}" is not in 0..1`, record);
  return value;
}

interface ParsedRecord {
  readonly instance: SamInstance;
  readonly width: number;
  readonly height: number;
}

function parseRecord(
  objectId: number,
  tokens: readonly { name: string; body: string }[],
  record: number,
  validateMasks: boolean,
): ParsedRecord {
  const [boxToken, maskToken, ...extra] = tokens;
  if (boxToken?.name !== 'box' || maskToken?.name !== 'mask' || extra.length > 0) {
    fail(`expected exactly one box token then one mask token`, record);
  }

  const box = readFields(boxToken.body, 'box', [...BOX_KEYS, 'c'], record);
  const bx1 = readInt(box, 'x1', 'box', record);
  const by1 = readInt(box, 'y1', 'box', record);
  const bx2 = readInt(box, 'x2', 'box', record);
  const by2 = readInt(box, 'y2', 'box', record);
  const width = readInt(box, 'w', 'box', record);
  const height = readInt(box, 'h', 'box', record);
  if (width === 0 || height === 0) fail(`box source size ${width}x${height} is empty`, record);
  if (bx2 < bx1 || by2 < by1 || bx2 >= width || by2 >= height) {
    fail(`box (${bx1},${by1})-(${bx2},${by2}) is outside the ${width}x${height} image`, record);
  }

  const mask = readFields(maskToken.body, 'mask', ['x', 'y', 'c', 'data'], record);
  if (mask.get('x') !== '0' || mask.get('y') !== '0') fail('mask origin is not x=0;y=0', record);
  const data = MASK_DATA.exec(mask.get('data') ?? '');
  if (data === null) fail('mask data is not "<H>,<W>,<enc><payload>"', record);
  const maskHeight = Number(data[1]);
  const maskWidth = Number(data[2]);
  const marker = data[3] ?? '';
  const body = data[4] ?? '';
  // Measured on every recorded response and in every example in Meta's docs: the raster is the
  // box, pixel for pixel. A mismatch means we would place the mask wrongly, so reject it.
  if (maskWidth !== bx2 - bx1 + 1 || maskHeight !== by2 - by1 + 1) {
    fail(
      `mask raster ${maskWidth}x${maskHeight} does not match the ${bx2 - bx1 + 1}x${by2 - by1 + 1} box`,
      record,
    );
  }
  if (!PAYLOAD.test(body) || PAYLOAD_DELIMITERS.test(body)) {
    fail('mask payload is not printable ASCII free of token delimiters', record);
  }

  const boxScore = readScore(box, 'box', record);
  const maskScore = readScore(mask, 'mask', record);
  if (boxScore !== maskScore) {
    fail(`box confidence ${boxScore} differs from mask confidence ${maskScore}`, record);
  }

  const encoded: SamEncodedMask = {
    encoding: marker === '!' ? 'one_bit' : 'lossless',
    width: maskWidth,
    height: maskHeight,
    payload: `${marker}${body}`,
  };
  if (validateMasks) {
    try {
      decodeSamMask(encoded);
    } catch (error) {
      throw new SamOutputError(
        `Record ${record}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  return {
    instance: {
      objectId,
      score: boxScore,
      box: { x0: bx1, y0: by1, x1: bx2 + 1, y1: by2 + 1 },
      mask: encoded,
    },
    width,
    height,
  };
}

export interface ParseSamOptions {
  /**
   * Decode every mask while parsing, so a corrupt payload fails here rather than at first use.
   * Default `true`.
   */
  readonly validateMasks?: boolean;
}

/**
 * Parses the `output_text` of one SAM 3.1 **image** request. Whitespace-only text is the
 * documented zero-match result. Throws `SamOutputError` on any deviation from the grammar.
 */
export function parseSamImageOutput(text: string, options: ParseSamOptions = {}): SamImageOutput {
  const validateMasks = options.validateMasks ?? true;
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  if (lines.length === 0) return { sourceSize: undefined, instances: [] };
  if (lines.length > 1) fail(`an image result has one line, got ${lines.length}`);

  const line = (lines[0] ?? '').replace(/\r$/, '');
  const frame = FRAME.exec(line);
  if (frame === null) fail(`output does not start with a frame marker: "${line.slice(0, 40)}"`);
  if (frame[1] !== '0') fail(`an image result must be frame <0f>, got <${frame[1]}f>`);

  let rest = line.slice(frame[0].length);
  if (rest === '') fail('frame <0f> carries no records');

  const instances: SamInstance[] = [];
  const ids = new Set<number>();
  let sourceSize: { width: number; height: number } | undefined;
  while (rest !== '') {
    const index = instances.length;
    const start = RECORD_START.exec(rest);
    if (start === null || (index === 0) !== !start[0].startsWith(',')) {
      fail(`expected ${index === 0 ? 'an object id' : '"," and an object id'}`, index);
    }
    rest = rest.slice(start[0].length);
    const tokens: { name: string; body: string }[] = [];
    for (let token = TOKEN.exec(rest); token !== null; token = TOKEN.exec(rest)) {
      tokens.push({ name: token[1] ?? '', body: token[2] ?? '' });
      rest = rest.slice(token[0].length);
    }
    if (rest !== '' && !rest.startsWith(',')) {
      fail(`unexpected text after the tokens: "${rest.slice(0, 40)}"`, index);
    }

    const objectId = Number(start[1]);
    if (!Number.isSafeInteger(objectId)) fail('object id is out of range', index);
    if (ids.has(objectId)) fail(`object id ${objectId} appears twice`, index);
    ids.add(objectId);

    const parsed = parseRecord(objectId, tokens, index, validateMasks);
    if (sourceSize === undefined) {
      sourceSize = { width: parsed.width, height: parsed.height };
    } else if (sourceSize.width !== parsed.width || sourceSize.height !== parsed.height) {
      fail(
        `source size ${parsed.width}x${parsed.height} differs from ${sourceSize.width}x${sourceSize.height}`,
        index,
      );
    }
    instances.push(parsed.instance);
  }
  return { sourceSize, instances };
}

/** Intersection over union of two half-open pixel boxes (0 when either is empty). */
export function boxIoU(a: SamBox, b: SamBox): number {
  const iw = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const ih = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  if (iw <= 0 || ih <= 0) return 0;
  const intersection = iw * ih;
  const union = (a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - intersection;
  return union <= 0 ? 0 : intersection / union;
}
