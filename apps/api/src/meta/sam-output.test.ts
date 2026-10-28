import { describe, expect, it } from 'vitest';
import type { SamEncodedMask } from './sam-mask.ts';
import { boxIoU, parseSamImageOutput, SamOutputError } from './sam-output.ts';
import { recordedMasks, recordedOutputTexts } from './sam-test-support.ts';

interface TokenSpec {
  readonly id: number;
  readonly x1: number;
  readonly y1: number;
  /** A real recorded mask; the box takes its size. */
  readonly mask: SamEncodedMask;
  /** Override the inclusive right edge (default: from the mask width). */
  readonly x2?: number;
  readonly c?: string | undefined;
  /** Override the mask's `data=` value. */
  readonly data?: string;
}

const W = 1024;
const H = 682;
// The two smallest recorded masks: 25x275 and 22x315 (fixtures/meta/p1-05/sam-integrity.json).
const [SMALL, SMALL2] = await recordedMasks();
if (SMALL === undefined || SMALL2 === undefined) throw new Error('integrity cassette has no masks');

/** A wire record built around a real recorded mask payload. */
function record({ id, x1, y1, mask, x2, c, data }: TokenSpec): string {
  const right = x2 ?? x1 + mask.width - 1;
  const bottom = y1 + mask.height - 1;
  const conf = c === undefined ? '' : `;c=${c}`;
  const payload = data ?? `${mask.height},${mask.width},${mask.payload}`;
  return `${id}<|box;x1=${x1};y1=${y1};x2=${right};y2=${bottom};w=${W};h=${H}${conf}|><|mask;x=0;y=0${conf};data=${payload}|>`;
}

const A = { id: 0, x1: 2, y1: 3, mask: SMALL.mask, c: '0.9' };
const B = { id: 2, x1: 300, y1: 10, mask: SMALL2.mask, c: '0.5' };
/** `data=` for mask A with a different payload body. */
const dataA = (payload: string): string => `${SMALL.mask.height},${SMALL.mask.width},${payload}`;

describe('parseSamImageOutput: recorded output', () => {
  it('parses every recorded integrity response', async () => {
    const texts = await recordedOutputTexts('p1-05/sam-integrity');
    expect(texts).toHaveLength(36);
    const counts = texts.map((text) => parseSamImageOutput(text).instances.length);
    // 36 responses, 57 instances; one structure-altering edit returned no window.
    expect(counts.reduce((a, b) => a + b, 0)).toBe(57);
    expect(counts.filter((n) => n === 0)).toHaveLength(1);
    for (const text of texts) {
      const output = parseSamImageOutput(text);
      expect(text.endsWith('\n') || text === '').toBe(true);
      for (const { box, mask, score } of output.instances) {
        expect(output.sourceSize?.width).toBe(1024);
        expect(box.x1 - box.x0).toBe(mask.width);
        expect(box.y1 - box.y0).toBe(mask.height);
        expect(mask.encoding).toBe('one_bit');
        expect(score).toBeGreaterThan(0.5);
      }
    }
  });

  it('parses the recorded empty (privacy) responses as zero instances', async () => {
    for (const text of await recordedOutputTexts('p1-05/sam-privacy')) {
      expect(parseSamImageOutput(text)).toEqual({ sourceSize: undefined, instances: [] });
    }
  });
});

describe('parseSamImageOutput: hand-written cases', () => {
  it('returns no instances for empty or whitespace output', () => {
    expect(parseSamImageOutput('').instances).toEqual([]);
    expect(parseSamImageOutput('\n').instances).toEqual([]);
  });

  it('parses several instances with sparse ids into half-open pixel boxes', () => {
    const output = parseSamImageOutput(`<0f>${record(A)},${record(B)}\n`);
    expect(output.sourceSize).toEqual({ width: W, height: H });
    expect(output.instances.map((i) => [i.objectId, i.score, i.box])).toEqual([
      [0, 0.9, { x0: 2, y0: 3, x1: 27, y1: 278 }],
      [2, 0.5, { x0: 300, y0: 10, x1: 322, y1: 325 }],
    ]);
    expect(output.instances[0]?.mask).toEqual(SMALL.mask);
    expect(output.instances[1]?.mask).toEqual(SMALL2.mask);
  });

  it('accepts records without confidence', () => {
    const plain = parseSamImageOutput(`<0f>${record({ ...A, c: undefined })}`);
    expect(plain.instances[0]?.score).toBeUndefined();
  });

  it('reads the ~ marker as lossless and leaves payload validity to the decoder', () => {
    const text = `<0f>${record({ ...A, data: dataA('~!!!!#abc') })}`;
    const unchecked = parseSamImageOutput(text, { validateMasks: false });
    expect(unchecked.instances[0]?.mask).toMatchObject({
      encoding: 'lossless',
      payload: '~!!!!#abc',
    });
    expect(() => parseSamImageOutput(text)).toThrow(/Record 0: Invalid SAM mask/);
  });

  it.each([
    ['garbage', 'segmentation failed', /frame marker/],
    ['a video frame', `<3f>${record(A)}`, /frame <0f>/],
    ['two lines', `<0f>${record(A)}\n<0f>${record(B)}`, /one line/],
    ['a frame without records', '<0f>', /no records/],
    ['a missing separator', `<0f>${record(A)}${record(B)}`, /unexpected text/],
    ['a leading separator', `<0f>,${record(A)}`, /object id/],
    ['truncated output', `<0f>${record(A).slice(0, -30)}`, /SamOutputError|unexpected|expected/],
    ['a duplicate id', `<0f>${record(A)},${record({ ...B, id: 0 })}`, /appears twice/],
    ['a box past the image', `<0f>${record({ ...A, x1: W - 10 })}`, /outside/],
    ['an inverted box', `<0f>${record({ ...A, x1: 12, x2: 11 })}`, /outside/],
    [
      'a mask/box size mismatch',
      `<0f>${record({ ...A, data: `${SMALL.mask.height},${SMALL.mask.width - 1},${SMALL.mask.payload}` })}`,
      /does not match/,
    ],
    ['a payload with whitespace', `<0f>${record({ ...A, data: dataA('!abc d') })}`, /printable/],
    [
      'a payload with a delimiter',
      `<0f>${record({ ...A, data: dataA('!ab,cd') })}`,
      /printable|data/,
    ],
    ['an empty payload', `<0f>${record({ ...A, data: dataA('!') })}`, /data/],
    [
      'a truncated payload',
      `<0f>${record({ ...A, data: dataA(SMALL.mask.payload.slice(0, -3)) })}`,
      /Record 0: Invalid SAM mask/,
    ],
    [
      "another mask's payload in this box",
      `<0f>${record({ ...A, data: dataA(SMALL2.mask.payload) })}`,
      /Record 0: Invalid SAM mask/,
    ],
    ['an out-of-range score', `<0f>${record({ ...A, c: '1.5' })}`, /0\.\.1/],
    [
      'differing box and mask scores',
      `<0f>${record(A).replace(';c=0.9;data', ';c=0.8;data')}`,
      /differs/,
    ],
    ['an unknown field', `<0f>${record(A).replace(';w=', ';z=1;w=')}`, /unknown box field/],
    [
      'an unknown token',
      `<0f>${record(A).replace('<|mask', '<|point;x=1|><|mask')}`,
      /exactly one box/,
    ],
    [
      'mask before box',
      `<0f>0${record(A)
        .replace(/^0/, '')
        .replace(/(<\|box[^|]*\|>)(<\|mask[^|]*\|>)/, '$2$1')}`,
      /exactly one box/,
    ],
    ['a non-zero mask origin', `<0f>${record(A).replace('x=0;y=0', 'x=1;y=0')}`, /origin/],
    [
      'inconsistent source sizes',
      `<0f>${record(A)},${record(B).replaceAll(`w=${W}`, 'w=1025')}`,
      /source size/,
    ],
  ])('rejects %s', (_name, text, message) => {
    expect(() => parseSamImageOutput(text)).toThrow(SamOutputError);
    expect(() => parseSamImageOutput(text)).toThrow(message);
  });
});

describe('boxIoU', () => {
  it('computes intersection over union of half-open boxes', () => {
    const a = { x0: 0, y0: 0, x1: 10, y1: 10 };
    expect(boxIoU(a, a)).toBe(1);
    expect(boxIoU(a, { x0: 5, y0: 0, x1: 15, y1: 10 })).toBeCloseTo(50 / 150, 12);
    expect(boxIoU(a, { x0: 10, y0: 0, x1: 20, y1: 10 })).toBe(0);
  });
});
