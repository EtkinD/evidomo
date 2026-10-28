/**
 * RIFF/WAVE header parsing and encoding for the Voice Transcribe input format: mono 16-bit
 * integer PCM at 16 or 24 kHz (docs/architecture.md section 4).
 */

/** `WAVE_FORMAT_PCM`. ffmpeg writes this tag for mono 16-bit PCM. */
const WAVE_FORMAT_PCM = 1;

export interface WavInfo {
  /** 1 = integer PCM. */
  readonly audioFormat: number;
  readonly channels: number;
  readonly sampleRate: number;
  readonly bitsPerSample: number;
  /** Byte offset of the first sample. */
  readonly dataOffset: number;
  /** Size of the sample data in bytes. */
  readonly dataBytes: number;
  /** Duration derived from the sample data, rounded to whole milliseconds. */
  readonly durationMs: number;
}

export class WavFormatError extends Error {
  override name = 'WavFormatError';
}

function fourCC(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

/**
 * Parses a complete WAV file. Unknown chunks (`LIST`, `fact`, ...) are skipped. Throws
 * `WavFormatError` when the bytes are not a well-formed RIFF/WAVE file with a `fmt ` chunk
 * followed by a `data` chunk that fits inside the buffer.
 */
export function parseWavHeader(bytes: Uint8Array): WavInfo {
  if (bytes.byteLength < 12) {
    throw new WavFormatError(`Not a WAV file: only ${bytes.byteLength} bytes`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (fourCC(view, 0) !== 'RIFF' || fourCC(view, 8) !== 'WAVE') {
    throw new WavFormatError('Not a WAV file: missing RIFF/WAVE signature');
  }

  let format:
    | { audioFormat: number; channels: number; sampleRate: number; bitsPerSample: number }
    | undefined;
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const id = fourCC(view, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + size > bytes.byteLength) {
        throw new WavFormatError(`Malformed fmt chunk (${size} bytes)`);
      }
      format = {
        audioFormat: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bitsPerSample: view.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      if (format === undefined) {
        throw new WavFormatError('Malformed WAV file: data chunk before fmt chunk');
      }
      // Also catches 0xFFFFFFFF, which streaming muxers write when the length was unknown.
      if (body + size > bytes.byteLength) {
        throw new WavFormatError(
          `Truncated WAV file: data chunk declares ${size} bytes, ${bytes.byteLength - body} present`,
        );
      }
      const bytesPerSecond = (format.sampleRate * format.channels * format.bitsPerSample) / 8;
      if (bytesPerSecond <= 0) {
        throw new WavFormatError('Malformed fmt chunk: zero sample rate, channels, or bit depth');
      }
      return {
        ...format,
        dataOffset: body,
        dataBytes: size,
        durationMs: Math.round((size / bytesPerSecond) * 1000),
      };
    }
    // Chunks are word-aligned: an odd-sized chunk is followed by one pad byte.
    offset = body + size + (size % 2);
  }
  throw new WavFormatError('Malformed WAV file: no data chunk');
}

export type TranscriptionSampleRate = 16_000 | 24_000;
export const TRANSCRIPTION_SAMPLE_RATES: readonly TranscriptionSampleRate[] = [16_000, 24_000];

/**
 * Throws unless the WAV is mono 16-bit integer PCM at 16 or 24 kHz, the only file format the
 * Voice Transcribe file endpoint accepts. Returns the parsed header.
 */
export function assertTranscriptionWav(bytes: Uint8Array): WavInfo {
  const info = parseWavHeader(bytes);
  const problems: string[] = [];
  if (info.audioFormat !== WAVE_FORMAT_PCM) {
    problems.push(`format tag ${info.audioFormat} (need 1 = integer PCM)`);
  }
  if (info.channels !== 1) problems.push(`${info.channels} channels (need mono)`);
  if (info.bitsPerSample !== 16) problems.push(`${info.bitsPerSample}-bit (need 16-bit)`);
  if (!TRANSCRIPTION_SAMPLE_RATES.some((rate) => rate === info.sampleRate)) {
    problems.push(`${info.sampleRate} Hz (need 16000 or 24000)`);
  }
  if (problems.length > 0) {
    throw new WavFormatError(`WAV is not in the transcription format: ${problems.join(', ')}`);
  }
  return info;
}

/** Encodes mono 16-bit PCM samples as a canonical 44-byte-header WAV file. */
export function encodePcm16Wav(samples: Int16Array, sampleRate: number): Uint8Array {
  const dataBytes = samples.length * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const writeFourCC = (offset: number, value: string): void => {
    for (let i = 0; i < 4; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  };
  writeFourCC(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeFourCC(8, 'WAVE');
  writeFourCC(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, WAVE_FORMAT_PCM, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeFourCC(36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i += 1) {
    view.setInt16(44 + i * 2, samples[i] ?? 0, true);
  }
  return bytes;
}
