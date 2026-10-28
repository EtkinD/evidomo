import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMetaClients, ForbiddenModelError } from './clients.ts';
import { editMetaImage, generateMetaImage, ImageDecodeError, imageDimensions } from './images.ts';
import { createInMemoryUsageRecorder, createTokenPriceEstimator } from './usage.ts';

// 5x3 images encoded by ffmpeg (metadata stripped).
const PNG_5X3 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAUAAAADCAIAAADUVFKvAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAEElEQVR4nGP8x4ACWBjw8wEvwgEIH5KrmAAAAABJRU5ErkJggg==',
  'base64',
);
const JPEG_5X3 = Buffer.from(
  '/9j/4AAQSkZJRgABAgAAAQABAAD//gAPTGF2YzYzLjEuMTAyAP/bAEMACAQEBAQEBQUFBQUFBgYGBgYGBgYGBgYGBgcHBwgICAcHBwYGBwcICAgICQkJCAgICAkJCgoKDAwLCw4ODhERFP/EAEwAAQEAAAAAAAAAAAAAAAAAAAAGAQEBAAAAAAAAAAAAAAAAAAAGBxABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIAAMABQMBIgACEQADEQD/2gAMAwEAAhEDEQA/AIsATX9//9k=',
  'base64',
);

/** A RIFF/WEBP header with one chunk; only the bytes the size parser reads are meaningful. */
function webp(chunk: 'VP8 ' | 'VP8L' | 'VP8X', payload: number[]): Uint8Array {
  const bytes = new Uint8Array(40);
  bytes.set(Buffer.from('RIFF'), 0);
  bytes.set(Buffer.from('WEBP'), 8);
  bytes.set(Buffer.from(chunk), 12);
  bytes.set(payload, 20);
  return bytes;
}

describe('imageDimensions', () => {
  it('reads PNG and JPEG headers', () => {
    expect(imageDimensions(PNG_5X3)).toEqual({ format: 'png', width: 5, height: 3 });
    expect(imageDimensions(JPEG_5X3)).toEqual({ format: 'jpeg', width: 5, height: 3 });
  });

  it('reads the three WebP variants', () => {
    // VP8X: canvas width-1 and height-1 as 24-bit little endian at offsets 24 and 27.
    expect(imageDimensions(webp('VP8X', [0, 0, 0, 0, 0xff, 0x05, 0, 0xff, 0x03, 0]))).toEqual({
      format: 'webp',
      width: 1536,
      height: 1024,
    });
    // VP8 (lossy): start code 9d 01 2a, then 14-bit little-endian width and height.
    expect(
      imageDimensions(webp('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, 0x00, 0x06, 0x00, 0x04])),
    ).toEqual({ format: 'webp', width: 1536, height: 1024 });
    // VP8L (lossless): signature 0x2f, then 14-bit width-1 and height-1 packed into 28 bits.
    const w = 1535;
    const h = 1023;
    const bits = w | (h << 14);
    expect(
      imageDimensions(
        webp('VP8L', [0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, bits >>> 24]),
      ),
    ).toEqual({ format: 'webp', width: 1536, height: 1024 });
  });

  it('rejects anything else', () => {
    expect(() => imageDimensions(new Uint8Array([1, 2, 3]))).toThrow(ImageDecodeError);
    expect(() => imageDimensions(JPEG_5X3.subarray(0, 40))).toThrow(ImageDecodeError);
  });
});

describe('image calls (stubbed fetch, no network)', () => {
  const usage = createInMemoryUsageRecorder();
  const estimateCost = createTokenPriceEstimator({ 'image-model': { usdPerImage: 0.01 } });
  const clients = createMetaClients({ apiKey: 'k', usage, estimateCost, maxRetries: 0 });
  const requests: Request[] = [];

  function stubFetch(): void {
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return Promise.resolve(
        Response.json({
          created: 1,
          data: [{ b64_json: PNG_5X3.toString('base64') }],
          output_format: 'png',
          usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
        }),
      );
    });
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    requests.length = 0;
    usage.clear();
  });

  it('edits through POST /images/edits as multipart and records one image', async () => {
    stubFetch();
    const result = await editMetaImage(clients, {
      modelId: 'image-model',
      prompt: 'add a sofa',
      images: [JPEG_5X3],
      size: '1536x1024',
      outputFormat: 'jpeg',
    });

    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request?.url).toBe('https://api.meta.ai/v1/images/edits');
    const form = await request?.formData();
    expect(form?.get('model')).toBe('image-model');
    expect(form?.get('prompt')).toBe('add a sofa');
    expect(form?.get('size')).toBe('1536x1024');
    expect(form?.get('output_format')).toBe('jpeg');
    expect(form?.get('mask')).toBeNull();
    const image = form?.get('image');
    expect(image).toBeInstanceOf(Blob);
    expect(image instanceof Blob ? image.type : undefined).toBe('image/jpeg');

    expect(result.images).toHaveLength(1);
    expect(result.images[0]).toMatchObject({ format: 'png', width: 5, height: 3 });
    expect(result.outputFormat).toBe('png');
    expect(usage.entries).toEqual([result.usage]);
    expect(result.usage).toMatchObject({
      sdk: 'ai-sdk',
      modelId: 'image-model',
      images: 1,
      inputTokens: 100,
      outputTokens: 50,
      estimatedCostUsd: 0.01,
    });
  });

  it('generates through POST /images/generations as JSON', async () => {
    stubFetch();
    await generateMetaImage(clients, { modelId: 'image-model', prompt: 'an empty room' });
    const [request] = requests;
    expect(request?.url).toBe('https://api.meta.ai/v1/images/generations');
    expect(await request?.json()).toEqual({
      model: 'image-model',
      prompt: 'an empty room',
      n: 1,
      response_format: 'b64_json',
    });
  });

  it('rejects Contributor-mode models and edits without an input image', async () => {
    stubFetch();
    await expect(
      generateMetaImage(clients, { modelId: 'image-model-contributor', prompt: 'x' }),
    ).rejects.toThrow(ForbiddenModelError);
    await expect(
      editMetaImage(clients, { modelId: 'image-model', prompt: 'x', images: [] }),
    ).rejects.toThrow(TypeError);
    expect(requests).toHaveLength(0);
  });
});
