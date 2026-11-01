// Test support for the export archive: an independent ZIP reader (central directory first, then
// the local headers it points to) that asserts the structure while it parses. Imported only by
// tests.
import { crc32 } from 'node:zlib';
import { expect } from 'vitest';

export interface ParsedZipEntry {
  readonly name: string;
  readonly bytes: Buffer;
  readonly crc32: number;
  readonly flags: number;
  readonly method: number;
  readonly dosTime: number;
  readonly dosDate: number;
}

/** Every entry of a plain (non-ZIP64, stored or not) archive; fails the test on a malformed one. */
export function parseZip(zip: Buffer): ParsedZipEntry[] {
  const eocd = zip.length - 22;
  expect(zip.readUInt32LE(eocd)).toBe(0x06054b50);
  const count = zip.readUInt16LE(eocd + 10);
  expect(zip.readUInt16LE(eocd + 8)).toBe(count);
  const centralSize = zip.readUInt32LE(eocd + 12);
  const centralOffset = zip.readUInt32LE(eocd + 16);
  expect(centralOffset + centralSize).toBe(eocd);
  expect(zip.readUInt16LE(eocd + 20)).toBe(0);

  const entries: ParsedZipEntry[] = [];
  let at = centralOffset;
  for (let i = 0; i < count; i += 1) {
    expect(zip.readUInt32LE(at)).toBe(0x02014b50);
    const start = at;
    const flags = zip.readUInt16LE(at + 8);
    const method = zip.readUInt16LE(at + 10);
    const crc = zip.readUInt32LE(at + 16);
    const compressed = zip.readUInt32LE(at + 20);
    const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const localOffset = zip.readUInt32LE(at + 42);
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;

    expect(zip.readUInt32LE(localOffset)).toBe(0x04034b50);
    expect(zip.readUInt16LE(localOffset + 6)).toBe(flags);
    expect(zip.readUInt16LE(localOffset + 8)).toBe(method);
    expect(zip.readUInt32LE(localOffset + 14)).toBe(crc);
    expect(zip.readUInt32LE(localOffset + 18)).toBe(compressed);
    expect(zip.readUInt32LE(localOffset + 22)).toBe(size);
    const localName = zip.readUInt16LE(localOffset + 26);
    expect(zip.toString('utf8', localOffset + 30, localOffset + 30 + localName)).toBe(name);
    const dataStart = localOffset + 30 + localName + zip.readUInt16LE(localOffset + 28);
    const bytes = zip.subarray(dataStart, dataStart + size);
    expect(compressed).toBe(size);
    expect(crc32(bytes)).toBe(crc);
    entries.push({
      name,
      bytes,
      crc32: crc,
      flags,
      method,
      dosTime: zip.readUInt16LE(start + 12),
      dosDate: zip.readUInt16LE(start + 14),
    });
  }
  expect(at).toBe(eocd);
  return entries;
}
