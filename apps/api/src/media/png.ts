import { crc32, deflateSync } from 'node:zlib';

const SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/**
 * Minimal PNG encoder for 8-bit RGBA rasters (no filtering, zlib deflate). Enough for
 * inspection overlays without an image library; not tuned for size.
 */
export function encodeRgbaPng(width: number, height: number, rgba: Uint8Array): Buffer {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError(`PNG size must be positive integers, got ${width}x${height}`);
  }
  if (rgba.length !== width * height * 4) {
    throw new RangeError(`RGBA buffer has ${rgba.length} bytes, expected ${width * height * 4}`);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  // Bytes 10-12 stay 0: deflate compression, adaptive filtering, no interlace.

  const stride = width * 4;
  const scanlines = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    // Each scanline starts with its filter type; 0 = none.
    scanlines.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(scanlines)),
    chunk('IEND', new Uint8Array(0)),
  ]);
}
