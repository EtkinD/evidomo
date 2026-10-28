import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processPhoto, sniffImageFormat } from './image.ts';
import { UploadRejectedError } from './upload-error.ts';

/** Tag IDs of the GPS IFD (from the IFD0 pointer 0x8825), or undefined when there is none. */
function gpsTagIds(exif: Buffer): number[] | undefined {
  const tiff = exif.subarray(0, 6).toString('latin1') === 'Exif\0\0' ? exif.subarray(6) : exif;
  const littleEndian = tiff.toString('latin1', 0, 2) === 'II';
  const u16 = (offset: number): number =>
    littleEndian ? tiff.readUInt16LE(offset) : tiff.readUInt16BE(offset);
  const u32 = (offset: number): number =>
    littleEndian ? tiff.readUInt32LE(offset) : tiff.readUInt32BE(offset);
  const ifd0 = u32(4);
  for (let i = 0; i < u16(ifd0); i += 1) {
    const entry = ifd0 + 2 + i * 12;
    if (u16(entry) === 0x8825) {
      const gps = u32(entry + 8);
      return Array.from({ length: u16(gps) }, (_, j) => u16(gps + 2 + j * 12));
    }
  }
  return undefined;
}

/** JPEG marker bytes of every segment before the scan (APPn, COM, DQT, SOF, DHT, ...). */
function jpegMarkers(jpeg: Buffer): number[] {
  const markers: number[] = [];
  let offset = 2; // after SOI
  while (offset + 4 <= jpeg.length) {
    if (jpeg[offset] !== 0xff) throw new Error(`No marker at ${offset}`);
    const marker = jpeg[offset + 1] ?? 0;
    markers.push(marker);
    if (marker === 0xda) break; // SOS: entropy-coded data follows
    offset += 2 + jpeg.readUInt16BE(offset + 2);
  }
  return markers;
}

const APP1_EXIF_XMP = 0xe1;
const APP2_ICC = 0xe2;
const APP13_IPTC = 0xed;
const COM = 0xfe;

const XMP_PACKET =
  '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
  '<rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>Test Agent</dc:creator>' +
  '</rdf:Description></rdf:RDF></x:xmpmeta>';

describe('sniffImageFormat', () => {
  it('recognizes accepted containers and HEIF brands by magic bytes', async () => {
    const tiny = sharp({ create: { width: 2, height: 2, channels: 3, background: '#000' } });
    expect(sniffImageFormat(await tiny.clone().jpeg().toBuffer())).toBe('jpeg');
    expect(sniffImageFormat(await tiny.clone().png().toBuffer())).toBe('png');
    expect(sniffImageFormat(await tiny.clone().webp().toBuffer())).toBe('webp');
    expect(sniffImageFormat(await tiny.clone().avif().toBuffer())).toBe('heif');
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheicmif1heic')]);
    expect(sniffImageFormat(heic)).toBe('heif');
  });

  it('returns undefined for everything else', async () => {
    const tiny = sharp({ create: { width: 2, height: 2, channels: 3, background: '#000' } });
    expect(sniffImageFormat(await tiny.clone().gif().toBuffer())).toBeUndefined();
    expect(sniffImageFormat(await tiny.clone().tiff().toBuffer())).toBeUndefined();
    expect(
      sniffImageFormat(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')),
    ).toBeUndefined();
    expect(sniffImageFormat(Buffer.from('%PDF-1.7'))).toBeUndefined();
    expect(sniffImageFormat(new Uint8Array())).toBeUndefined();
  });
});

describe('processPhoto', () => {
  let dir: string;
  let counter = 0;

  async function file(bytes: Uint8Array | string): Promise<string> {
    counter += 1;
    // No extension: format detection must not depend on the name.
    const filePath = path.join(dir, `upload-${counter}`);
    await writeFile(filePath, bytes);
    return filePath;
  }

  async function rejection(promise: Promise<unknown>): Promise<UploadRejectedError> {
    const error: unknown = await promise.then(
      () => undefined,
      (reason: unknown) => reason,
    );
    if (!(error instanceof UploadRejectedError)) {
      throw new Error(`Expected UploadRejectedError, got ${String(error)}`);
    }
    return error;
  }

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'evidomo-image-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('removes GPS EXIF and all other metadata, applying orientation first', async () => {
    // A 4000x3000 phone-style JPEG with GPS coordinates, camera EXIF, orientation 6 (rotate
    // 90° clockwise to display), a Display P3 ICC profile, and an XMP packet.
    const input = await sharp({
      create: { width: 4000, height: 3000, channels: 3, background: '#3080c0' },
    })
      .withIccProfile('p3')
      .withMetadata({ orientation: 6 })
      .withExifMerge({
        IFD0: { Make: 'TestCam', Model: 'Phone 1', Artist: 'Test Agent' },
        IFD3: {
          GPSLatitudeRef: 'N',
          GPSLatitude: '52/1 22/1 1234/100',
          GPSLongitudeRef: 'E',
          GPSLongitude: '4/1 53/1 5678/100',
        },
      })
      .withXmp(XMP_PACKET)
      .jpeg()
      .toBuffer();

    // Guard against a vacuous test: the input really carries all of it.
    const before = await sharp(input).metadata();
    expect(before.exif).toBeDefined();
    expect(gpsTagIds(before.exif ?? Buffer.alloc(0))).toEqual(
      expect.arrayContaining([0x0001, 0x0002, 0x0003, 0x0004]),
    );
    expect(before.orientation).toBe(6);
    expect(before.icc).toBeDefined();
    expect(before.xmp).toBeDefined();

    const result = await processPhoto(await file(input));

    // Oriented (portrait) before the long edge was capped at 2048.
    expect(result).toMatchObject({
      width: 1536,
      height: 2048,
      sourceFormat: 'jpeg',
      sourceWidth: 3000,
      sourceHeight: 4000,
    });

    const after = await sharp(result.data).metadata();
    expect(after.format).toBe('jpeg');
    expect(after.exif).toBeUndefined();
    expect(after.orientation).toBeUndefined();
    expect(after.xmp).toBeUndefined();
    expect(after.iptc).toBeUndefined();
    expect(after.icc).toBeUndefined();
    expect(after.hasProfile).toBe(false);
    expect(after.space).toBe('srgb');
    expect(after.comments).toBeUndefined();
    expect([after.width, after.height]).toEqual([1536, 2048]);

    // Byte level, independent of sharp's reader: no APP1 (EXIF/XMP), APP2 (ICC), APP13 (IPTC),
    // or COM segment, and no trace of the strings that were embedded.
    const markers = jpegMarkers(result.data);
    expect(markers).not.toContain(APP1_EXIF_XMP);
    expect(markers).not.toContain(APP2_ICC);
    expect(markers).not.toContain(APP13_IPTC);
    expect(markers).not.toContain(COM);
    const latin1 = result.data.toString('latin1');
    for (const needle of ['Exif', 'TestCam', 'Test Agent', 'xmpmeta', 'ICC_PROFILE']) {
      expect(latin1).not.toContain(needle);
    }
  });

  it('converts colors to sRGB through the embedded profile', async () => {
    // Pure P3 green is outside sRGB: converted, it clips to (near) pure sRGB green. Read
    // without the profile, the stored values would be visibly different (~117, 251, 76).
    const p3Green = await sharp({
      create: { width: 16, height: 16, channels: 3, background: '#00ff00' },
    })
      .withIccProfile('p3', { attach: true })
      .png()
      .toBuffer();
    const result = await processPhoto(await file(p3Green));
    const pixel = await sharp(result.data).raw().toBuffer();
    expect(pixel[0]).toBeLessThan(20);
    expect(pixel[1]).toBeGreaterThan(240);
    expect(pixel[2]).toBeLessThan(20);
  });

  it('flattens PNG transparency onto white and never enlarges', async () => {
    const transparent = await sharp({
      create: { width: 300, height: 200, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();
    const result = await processPhoto(await file(transparent));
    expect(result).toMatchObject({ width: 300, height: 200, sourceFormat: 'png' });
    const pixel = await sharp(result.data).raw().toBuffer();
    expect([...pixel.subarray(0, 3)].every((value) => value > 250)).toBe(true);
  });

  it('accepts WebP and honors a configured long edge', async () => {
    const webp = await sharp({
      create: { width: 1200, height: 800, channels: 3, background: '#888' },
    })
      .webp()
      .toBuffer();
    const result = await processPhoto(await file(webp), { longEdgePx: 600 });
    expect(result).toMatchObject({ width: 600, height: 400, sourceFormat: 'webp' });
    expect((await sharp(result.data).metadata()).format).toBe('jpeg');
  });

  it('rejects an empty file and a file over the size limit before decoding', async () => {
    expect(await rejection(processPhoto(await file(new Uint8Array())))).toMatchObject({
      code: 'empty_file',
    });
    const jpeg = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#000' } })
      .jpeg()
      .toBuffer();
    const error = await rejection(processPhoto(await file(jpeg), { maxBytes: jpeg.length - 1 }));
    expect(error.code).toBe('file_too_large');
  });

  it('rejects images above the pixel limit (decompression bomb guard)', async () => {
    // A flat 6000x6000 PNG is tiny on disk but 36 MP decoded.
    const bomb = await sharp({
      create: { width: 6000, height: 6000, channels: 3, background: '#fff' },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();
    expect(bomb.length).toBeLessThan(1024 * 1024);
    const error = await rejection(processPhoto(await file(bomb), { maxPixels: 25_000_000 }));
    expect(error.code).toBe('too_many_pixels');
    expect(error.message).toMatch(/25 megapixels/);
  });

  it('refuses HEIC/HEIF with a clear message', async () => {
    const avif = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#000' } })
      .avif()
      .toBuffer();
    const error = await rejection(processPhoto(await file(avif)));
    expect(error.code).toBe('heic_not_supported');
    expect(error.message).toMatch(/HEIC/);
  });

  it('rejects other formats by content, whatever the name or claimed type', async () => {
    const gif = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#000' } })
      .gif()
      .toBuffer();
    expect((await rejection(processPhoto(await file(gif)))).code).toBe('unsupported_format');
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>';
    expect((await rejection(processPhoto(await file(svg)))).code).toBe('unsupported_format');
  });

  it('rejects truncated and corrupt data without leaking decoder details', async () => {
    const jpeg = await sharp({
      create: { width: 512, height: 512, channels: 3, background: '#a52' },
    })
      .jpeg()
      .toBuffer();
    const truncated = await rejection(processPhoto(await file(jpeg.subarray(0, jpeg.length / 2))));
    expect(truncated.code).toBe('undecodable');
    expect(truncated.message).not.toMatch(/upload-|vips|\//i);
    expect(truncated.cause).toBeInstanceOf(Error);

    const garbage = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(200, 7)]);
    expect((await rejection(processPhoto(await file(garbage)))).code).toBe('undecodable');
  });
});
