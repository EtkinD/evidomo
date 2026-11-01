import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  dosDateTime,
  layoutZip,
  streamZip,
  updateCrc32,
  ZIP_MAX_BYTES,
  ZIP_MAX_ENTRIES,
  ZipError,
  type ZipEntry,
} from './zip.ts';
import { parseZip } from './zip-testing.ts';

// The stored ZIP writer, checked against an independent reader (`zip-testing.ts`: central directory
// first, then local headers) and, when available, against Info-ZIP `unzip -t`.

async function build(
  files: readonly { name: string; bytes: Buffer }[],
  modifiedAt = new Date(Date.UTC(2026, 9, 29, 10, 9, 30)),
  chunk = 7,
): Promise<Buffer> {
  const entries: ZipEntry[] = files.map((f) => ({
    name: f.name,
    sizeBytes: f.bytes.byteLength,
    crc32: crc32(f.bytes),
  }));
  const layout = layoutZip(entries, modifiedAt);
  const parts: Uint8Array[] = [];
  const bytesOf = new Map(files.map((f) => [f.name, f.bytes]));
  // Small chunks, to prove the writer does not depend on how a source splits its bytes.
  const pieces = (bytes: Buffer): AsyncIterable<Uint8Array> => {
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < bytes.byteLength; i += chunk) chunks.push(bytes.subarray(i, i + chunk));
    return Readable.from(chunks);
  };
  const open = (entry: ZipEntry): Promise<AsyncIterable<Uint8Array>> => {
    const bytes = bytesOf.get(entry.name);
    if (bytes === undefined) return Promise.reject(new Error('unknown entry'));
    return Promise.resolve(pieces(bytes));
  };
  for await (const part of streamZip(entries, layout, open)) parts.push(part);
  const zip = Buffer.concat(parts);
  expect(zip.byteLength).toBe(layout.sizeBytes);
  return zip;
}

const FILES = [
  { name: 'listing-pack.html', bytes: Buffer.from('<!doctype html><p>Grüße, 家</p>', 'utf8') },
  { name: 'portal-fields.json', bytes: Buffer.from('{"a":1}\n') },
  { name: 'photo-01.jpg', bytes: Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251)) },
  { name: 'empty.bin', bytes: Buffer.alloc(0) },
];

describe('stored ZIP writer', () => {
  it('round-trips names, bytes, CRCs, and sizes through the central directory', async () => {
    const entries = parseZip(await build(FILES));
    expect(entries.map((e) => e.name)).toEqual(FILES.map((f) => f.name));
    entries.forEach((entry, i) => {
      expect(entry.bytes.equals(FILES[i]?.bytes ?? Buffer.alloc(1))).toBe(true);
      expect(entry.method).toBe(0);
      // UTF-8 names, no data descriptor.
      expect(entry.flags).toBe(0x0800);
    });
  });

  it('is deterministic and independent of source chunking', async () => {
    const a = await build(FILES, undefined, 3);
    const b = await build(FILES, undefined, 4096);
    expect(a.equals(b)).toBe(true);
  });

  it('writes the given UTC time, not the clock', async () => {
    const [entry] = parseZip(await build(FILES, new Date(Date.UTC(2026, 9, 29, 10, 9, 31))));
    expect(entry?.dosDate).toBe(((2026 - 1980) << 9) | (10 << 5) | 29);
    expect(entry?.dosTime).toBe((10 << 11) | (9 << 5) | 15);
  });

  it('clamps timestamps to the DOS range', () => {
    expect(dosDateTime(new Date(Date.UTC(1970, 0, 1)))).toEqual({ date: 33, time: 0 });
    expect(dosDateTime(new Date(Date.UTC(2200, 0, 1))).date >> 9).toBe(127);
    expect(() => dosDateTime(new Date(Number.NaN))).toThrow(ZipError);
  });

  it('continues a CRC across chunks like one pass', () => {
    const data = Buffer.from('evidomo export archive');
    const split = updateCrc32(updateCrc32(0, data.subarray(0, 5)), data.subarray(5));
    expect(split).toBe(crc32(data));
  });

  it('refuses unsafe, duplicate, and oversized entries', () => {
    const at = new Date(0);
    const entry = (name: string, sizeBytes = 1): ZipEntry => ({ name, sizeBytes, crc32: 0 });
    for (const name of [
      '',
      '/abs',
      '../x',
      'a/../b',
      'a//b',
      './a',
      'a\\b',
      'a\0b',
      'dir/',
      '\ud800',
    ]) {
      expect(() => layoutZip([entry(name)], at), JSON.stringify(name)).toThrow(ZipError);
    }
    expect(() => layoutZip([entry('A.jpg'), entry('a.JPG')], at)).toThrow(ZipError);
    expect(() => layoutZip([entry('a', -1)], at)).toThrow(ZipError);
    expect(() => layoutZip([{ name: 'a', sizeBytes: 1, crc32: 2 ** 32 }], at)).toThrow(ZipError);
    expect(() => layoutZip([entry('a', ZIP_MAX_BYTES)], at)).toThrow(ZipError);
    expect(() =>
      layoutZip(
        Array.from({ length: 3 }, (_, i) => entry(`f${i}`, Math.floor(ZIP_MAX_BYTES / 2))),
        at,
      ),
    ).toThrow(ZipError);
    expect(() =>
      layoutZip(
        Array.from({ length: ZIP_MAX_ENTRIES + 1 }, (_, i) => entry(`f${i}`, 0)),
        at,
      ),
    ).toThrow(ZipError);
  });

  it('aborts instead of producing an archive when a source changes size', async () => {
    const entries: ZipEntry[] = [{ name: 'a.bin', sizeBytes: 10, crc32: 0 }];
    const layout = layoutZip(entries, new Date(0));
    for (const length of [9, 11]) {
      const drain = async (): Promise<void> => {
        const open = (): Promise<AsyncIterable<Uint8Array>> =>
          Promise.resolve(Readable.from([Buffer.alloc(length)]));
        for await (const part of streamZip(entries, layout, open)) void part;
      };
      await expect(drain(), `length ${length}`).rejects.toThrow(ZipError);
    }
  });

  const hasUnzip = spawnSync('unzip', ['-v']).status === 0;
  it.skipIf(!hasUnzip)('passes `unzip -t` and extracts the same bytes', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'evidomo-zip-'));
    try {
      const zipPath = path.join(dir, 'a.zip');
      await writeFile(zipPath, await build(FILES));
      const tested = execFileSync('unzip', ['-t', zipPath], { encoding: 'utf8' });
      expect(tested).toContain('No errors detected');
      const outDir = path.join(dir, 'out');
      execFileSync('unzip', ['-q', zipPath, '-d', outDir]);
      for (const file of FILES) {
        expect((await readFile(path.join(outDir, file.name))).equals(file.bytes)).toBe(true);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
