import { crc32 } from 'node:zlib';

// A minimal ZIP writer for the export archive (docs/architecture.md §5, "Export archive"):
// stored entries only (method 0: JPEG and the pack do not compress further), no ZIP64, no data
// descriptors, no extra fields. Sizes and CRCs are known before the first byte is written, so
// every local header is final and the archive's total length is known up front (Content-Length),
// and sequential readers (Java's ZipInputStream, `ditto` pipes) accept it. Entry names are UTF-8
// (general purpose flag bit 11). The timestamp is an argument and nothing here reads a clock, so
// the same entries always give identical bytes.

const LOCAL_HEADER_BYTES = 30;
const CENTRAL_HEADER_BYTES = 46;
const END_RECORD_BYTES = 22;

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;

/** Version 2.0: the lowest that defines the UTF-8 name flag in practice (Info-ZIP writes it). */
const VERSION_NEEDED = 20;
/** Host system 3 (Unix), so `external attributes` carry a file mode. */
const VERSION_MADE_BY = (3 << 8) | VERSION_NEEDED;
const UTF8_NAMES_FLAG = 0x0800;
const METHOD_STORED = 0;
/** Regular file, rw-r--r--. */
const EXTERNAL_ATTRIBUTES = (0o100644 << 16) >>> 0;

/** ZIP64 would start here: the format's 16- and 32-bit fields cannot hold more. */
export const ZIP_MAX_ENTRIES = 0xfffe;
export const ZIP_MAX_BYTES = 0xfffffffe;

/** The entries do not fit a plain ZIP or have a name the writer refuses. */
export class ZipError extends Error {
  override name = 'ZipError';
}

export interface ZipEntry {
  /** Path inside the archive: `/`-separated, relative, no `.` or `..` segments. */
  readonly name: string;
  readonly sizeBytes: number;
  /** CRC-32 (IEEE) of the entry's bytes, as an unsigned 32-bit integer. */
  readonly crc32: number;
}

/** CRC-32 over `chunk`, continuing from `previous` (0 to start). */
export function updateCrc32(previous: number, chunk: Uint8Array): number {
  return crc32(chunk, previous);
}

/** The DOS date and time fields (UTC, 2-second resolution), clamped to the format's range. */
export function dosDateTime(at: Date): { readonly date: number; readonly time: number } {
  const ms = at.getTime();
  if (Number.isNaN(ms)) throw new ZipError('The archive timestamp is not a valid date');
  const year = at.getUTCFullYear();
  if (year < 1980) return { date: (1 << 5) | 1, time: 0 };
  if (year > 2107) return { date: (127 << 9) | (12 << 5) | 31, time: (23 << 11) | (59 << 5) | 29 };
  return {
    date: ((year - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate(),
    time: (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | (at.getUTCSeconds() >> 1),
  };
}

function checkName(name: string): Buffer {
  const bytes = Buffer.from(name, 'utf8');
  const segments = name.split('/');
  if (
    name === '' ||
    bytes.byteLength > 0xffff ||
    // Lone surrogates do not survive UTF-8; a name must be what the reader will see.
    bytes.toString('utf8') !== name ||
    // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
    /[\\\u0000-\u001f\u007f]/.test(name) ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new ZipError('The archive has an entry name that is not a safe relative path');
  }
  return bytes;
}

export interface ZipLayout {
  /** Length of the whole archive, headers and trailer included. */
  readonly sizeBytes: number;
  /** One local header per entry, in entry order; each is followed by the entry's bytes. */
  readonly localHeaders: readonly Buffer[];
  /** The central directory and the end record: the last bytes of the archive. */
  readonly trailer: Buffer;
}

/** Validates the entries (names, limits) and lays out every header of the archive. */
export function layoutZip(entries: readonly ZipEntry[], modifiedAt: Date): ZipLayout {
  if (entries.length > ZIP_MAX_ENTRIES) throw new ZipError('The archive has too many entries');
  const { date, time } = dosDateTime(modifiedAt);
  const seen = new Set<string>();
  const names = entries.map((entry) => {
    const bytes = checkName(entry.name);
    // Case-folded: extracting onto a case-insensitive file system must not overwrite an entry.
    const key = entry.name.toLowerCase();
    if (seen.has(key)) throw new ZipError('The archive has two entries with the same name');
    seen.add(key);
    if (
      !Number.isSafeInteger(entry.sizeBytes) ||
      entry.sizeBytes < 0 ||
      !Number.isInteger(entry.crc32) ||
      entry.crc32 < 0 ||
      entry.crc32 > 0xffffffff
    ) {
      throw new ZipError('The archive has an entry with an invalid size or checksum');
    }
    return bytes;
  });

  const localHeaders: Buffer[] = [];
  const offsets: number[] = [];
  let offset = 0;
  entries.forEach((entry, i) => {
    const name = names[i];
    if (name === undefined) throw new Error('Entry name missing');
    const header = Buffer.alloc(LOCAL_HEADER_BYTES + name.byteLength);
    header.writeUInt32LE(LOCAL_SIGNATURE, 0);
    header.writeUInt16LE(VERSION_NEEDED, 4);
    header.writeUInt16LE(UTF8_NAMES_FLAG, 6);
    header.writeUInt16LE(METHOD_STORED, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(entry.crc32, 14);
    header.writeUInt32LE(entry.sizeBytes, 18);
    header.writeUInt32LE(entry.sizeBytes, 22);
    header.writeUInt16LE(name.byteLength, 26);
    header.writeUInt16LE(0, 28);
    name.copy(header, LOCAL_HEADER_BYTES);
    localHeaders.push(header);
    offsets.push(offset);
    offset += header.byteLength + entry.sizeBytes;
    if (offset > ZIP_MAX_BYTES) throw new ZipError('The archive is too large for a plain ZIP');
  });

  const centralSize = names.reduce((sum, name) => sum + CENTRAL_HEADER_BYTES + name.byteLength, 0);
  const sizeBytes = offset + centralSize + END_RECORD_BYTES;
  if (sizeBytes > ZIP_MAX_BYTES) throw new ZipError('The archive is too large for a plain ZIP');

  const trailer = Buffer.alloc(centralSize + END_RECORD_BYTES);
  let at = 0;
  entries.forEach((entry, i) => {
    const name = names[i];
    const localOffset = offsets[i];
    if (name === undefined || localOffset === undefined) throw new Error('Entry layout missing');
    trailer.writeUInt32LE(CENTRAL_SIGNATURE, at);
    trailer.writeUInt16LE(VERSION_MADE_BY, at + 4);
    trailer.writeUInt16LE(VERSION_NEEDED, at + 6);
    trailer.writeUInt16LE(UTF8_NAMES_FLAG, at + 8);
    trailer.writeUInt16LE(METHOD_STORED, at + 10);
    trailer.writeUInt16LE(time, at + 12);
    trailer.writeUInt16LE(date, at + 14);
    trailer.writeUInt32LE(entry.crc32, at + 16);
    trailer.writeUInt32LE(entry.sizeBytes, at + 20);
    trailer.writeUInt32LE(entry.sizeBytes, at + 24);
    trailer.writeUInt16LE(name.byteLength, at + 28);
    // extra field, comment, disk number, internal attributes: all zero.
    trailer.writeUInt32LE(EXTERNAL_ATTRIBUTES, at + 38);
    trailer.writeUInt32LE(localOffset, at + 42);
    name.copy(trailer, at + CENTRAL_HEADER_BYTES);
    at += CENTRAL_HEADER_BYTES + name.byteLength;
  });
  trailer.writeUInt32LE(END_SIGNATURE, at);
  // disk numbers (at + 4, + 6): zero.
  trailer.writeUInt16LE(entries.length, at + 8);
  trailer.writeUInt16LE(entries.length, at + 10);
  trailer.writeUInt32LE(centralSize, at + 12);
  trailer.writeUInt32LE(offset, at + 16);
  // comment length (at + 20): zero.
  return { sizeBytes, localHeaders, trailer };
}

/**
 * The archive's bytes, lazily: each entry's local header, then its bytes from `open(entry)`, and
 * the trailer. An entry whose stream does not yield exactly `sizeBytes` aborts the archive with
 * a `ZipError` instead of producing a corrupt one; the caller has already sent its headers, so
 * it can only cut the connection.
 */
export async function* streamZip(
  entries: readonly ZipEntry[],
  layout: ZipLayout,
  open: (entry: ZipEntry) => Promise<AsyncIterable<Uint8Array>>,
): AsyncGenerator<Uint8Array, void, undefined> {
  for (const [i, entry] of entries.entries()) {
    const header = layout.localHeaders[i];
    if (header === undefined) throw new Error('Local header missing');
    yield header;
    let written = 0;
    for await (const chunk of await open(entry)) {
      written += chunk.byteLength;
      if (written > entry.sizeBytes) break;
      yield chunk;
    }
    if (written !== entry.sizeBytes) throw new ZipError('An archive entry changed while streaming');
  }
  yield layout.trailer;
}
