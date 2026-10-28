import { describe, expect, it } from 'vitest';
import { assertTranscriptionWav, encodePcm16Wav, parseWavHeader, WavFormatError } from './wav.ts';

/** Builds a WAV with arbitrary fmt values and optional extra chunks, for negative cases. */
function wav(options: {
  channels?: number;
  sampleRate?: number;
  bitsPerSample?: number;
  audioFormat?: number;
  dataBytes?: number;
  declaredDataBytes?: number;
  chunkBeforeData?: { id: string; size: number };
}): Uint8Array {
  const channels = options.channels ?? 1;
  const sampleRate = options.sampleRate ?? 16_000;
  const bits = options.bitsPerSample ?? 16;
  const dataBytes = options.dataBytes ?? 3_200;
  const extra = options.chunkBeforeData;
  const extraBytes = extra === undefined ? 0 : 8 + extra.size + (extra.size % 2);
  const bytes = new Uint8Array(44 + extraBytes + dataBytes);
  const view = new DataView(bytes.buffer);
  const put = (offset: number, id: string): void => {
    for (let i = 0; i < 4; i += 1) view.setUint8(offset + i, id.charCodeAt(i));
  };
  put(0, 'RIFF');
  view.setUint32(4, bytes.byteLength - 8, true);
  put(8, 'WAVE');
  put(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, options.audioFormat ?? 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, (sampleRate * channels * bits) / 8, true);
  view.setUint16(32, (channels * bits) / 8, true);
  view.setUint16(34, bits, true);
  let offset = 36;
  if (extra !== undefined) {
    put(offset, extra.id);
    view.setUint32(offset + 4, extra.size, true);
    offset += extraBytes;
  }
  put(offset, 'data');
  view.setUint32(offset + 4, options.declaredDataBytes ?? dataBytes, true);
  return bytes;
}

describe('parseWavHeader', () => {
  it('reads format and duration from a canonical header', () => {
    expect(parseWavHeader(wav({ dataBytes: 32_000 }))).toEqual({
      audioFormat: 1,
      channels: 1,
      sampleRate: 16_000,
      bitsPerSample: 16,
      dataOffset: 44,
      dataBytes: 32_000,
      durationMs: 1_000,
    });
  });

  it('skips unknown chunks, including the pad byte after an odd-sized one', () => {
    const info = parseWavHeader(wav({ chunkBeforeData: { id: 'LIST', size: 27 }, dataBytes: 48 }));
    expect(info.dataOffset).toBe(44 + 8 + 28);
    expect(info.dataBytes).toBe(48);
  });

  it('rejects non-WAV, truncated, and chunkless input', () => {
    expect(() => parseWavHeader(new TextEncoder().encode('not a wav file at all'))).toThrow(
      WavFormatError,
    );
    expect(() => parseWavHeader(new Uint8Array(4))).toThrow(WavFormatError);
    expect(() => parseWavHeader(wav({ dataBytes: 100, declaredDataBytes: 0xffffffff }))).toThrow(
      /Truncated/,
    );
    expect(() => parseWavHeader(wav({}).slice(0, 36))).toThrow(/no data chunk/);
  });
});

describe('assertTranscriptionWav', () => {
  it('accepts mono 16-bit PCM at 16 and 24 kHz', () => {
    expect(assertTranscriptionWav(wav({ sampleRate: 16_000 })).sampleRate).toBe(16_000);
    expect(assertTranscriptionWav(wav({ sampleRate: 24_000 })).sampleRate).toBe(24_000);
  });

  it('names every violated constraint', () => {
    expect(() =>
      assertTranscriptionWav(wav({ channels: 2, sampleRate: 44_100, bitsPerSample: 24 })),
    ).toThrow(/2 channels.*24-bit.*44100 Hz/);
    expect(() => assertTranscriptionWav(wav({ audioFormat: 3, bitsPerSample: 16 }))).toThrow(
      /format tag 3/,
    );
  });
});

describe('encodePcm16Wav', () => {
  it('round-trips through the parser', () => {
    const bytes = encodePcm16Wav(new Int16Array([0, 1, -1, 32767, -32768]), 24_000);
    const info = assertTranscriptionWav(bytes);
    expect(info).toMatchObject({ sampleRate: 24_000, dataOffset: 44, dataBytes: 10 });
    const view = new DataView(bytes.buffer);
    expect(view.getInt16(44 + 3 * 2, true)).toBe(32767);
    expect(view.getInt16(44 + 4 * 2, true)).toBe(-32768);
  });
});
