import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { convertToTranscriptionWav, ffmpegWavArgs, MediaConversionError } from './convert.ts';

// These tests run the real ffmpeg binary (the API image installs it). Locally they are skipped
// when ffmpeg is missing; in CI (`CI` set) they always run, so a runner without ffmpeg fails
// loudly instead of silently dropping the converter's coverage.
const ffmpegAvailable = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const inCI = process.env['CI'] !== undefined && process.env['CI'] !== '';
const runFfmpegTests = ffmpegAvailable || inCI;

describe('ffmpegWavArgs', () => {
  it('pins the output format and forces the file protocol for both paths', () => {
    const args = ffmpegWavArgs('in put;$(rm -rf x).m4a', '/tmp/out.wav', 16_000);
    expect(args).toEqual(
      expect.arrayContaining(['-nostdin', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le']),
    );
    // The hostile name stays a single argv entry behind `file:`; nothing is shell-parsed.
    expect(args[args.indexOf('-i') + 1]).toBe(`file:${path.resolve('in put;$(rm -rf x).m4a')}`);
    expect(args.at(-1)).toBe('file:/tmp/out.wav');
    // Nested resources (playlists, references) may only be local files.
    expect(args[args.indexOf('-protocol_whitelist') + 1]).toBe('file');
    expect(args.indexOf('-protocol_whitelist')).toBeLessThan(args.indexOf('-i'));
    expect(args).not.toContain('-t');
  });

  it('adds an output duration cap in seconds when asked', () => {
    const args = ffmpegWavArgs('in.webm', '/tmp/out.wav', 16_000, 601_000);
    expect(args[args.indexOf('-t') + 1]).toBe('601.000');
    expect(args.indexOf('-t')).toBeGreaterThan(args.indexOf('-i'));
  });

  it('rejects a non-positive or fractional duration cap', () => {
    expect(() => ffmpegWavArgs('in', 'out', 16_000, 0)).toThrow(RangeError);
    expect(() => ffmpegWavArgs('in', 'out', 16_000, 1.5)).toThrow(RangeError);
  });
});

describe.skipIf(!runFfmpegTests)('convertToTranscriptionWav (real ffmpeg)', () => {
  let dir: string;

  /** Generates a stereo sine tone with ffmpeg's lavfi source, encoded with `codec`. */
  function tone(file: string, codec: string, seconds: number, sampleRate: number): string {
    const output = path.join(dir, file);
    const result = spawnSync(
      'ffmpeg',
      [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=440:sample_rate=${sampleRate}:duration=${seconds}`,
        '-ac',
        '2',
        '-c:a',
        codec,
        output,
      ],
      { encoding: 'utf8' },
    );
    if (result.status !== 0) {
      throw new Error(
        `ffmpeg could not generate ${file}: ${result.stderr || String(result.error)}`,
      );
    }
    return output;
  }

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'evidomo-convert-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('requires ffmpeg in CI', () => {
    expect(ffmpegAvailable, 'ffmpeg must be installed on the CI runner').toBe(true);
  });

  it.each([
    { input: 'tone.m4a', codec: 'aac', rate: 44_100 },
    { input: 'tone.webm', codec: 'libopus', rate: 48_000 },
  ])('converts $codec ($input) to 16 kHz mono 16-bit PCM WAV', async ({ input, codec, rate }) => {
    const source = tone(input, codec, 2, rate);
    const output = path.join(dir, `${input}.wav`);

    const result = await convertToTranscriptionWav(source, output);

    expect(result.path).toBe(output);
    expect(result.info).toMatchObject({
      audioFormat: 1,
      channels: 1,
      sampleRate: 16_000,
      bitsPerSample: 16,
      dataOffset: 44,
    });
    // Lossy codecs add encoder delay/padding (tens of ms); the duration must stay close.
    expect(Math.abs(result.info.durationMs - 2_000)).toBeLessThan(100);
  });

  it('converts to 24 kHz when asked', async () => {
    const source = tone('tone24.webm', 'libopus', 1, 48_000);
    const result = await convertToTranscriptionWav(source, path.join(dir, 'tone24.wav'), {
      sampleRate: 24_000,
    });
    expect(result.info.sampleRate).toBe(24_000);
  });

  it('stops decoding at maxDurationMs', async () => {
    const source = tone('capped.m4a', 'aac', 5, 44_100);
    const result = await convertToTranscriptionWav(source, path.join(dir, 'capped.wav'), {
      maxDurationMs: 2_000,
    });
    expect(result.info.durationMs).toBe(2_000);
  });

  it('fails with ffmpeg stderr when the input is not audio', async () => {
    const bogus = path.join(dir, 'not-audio.m4a');
    await writeFile(bogus, 'this is text, not audio');
    const error: unknown = await convertToTranscriptionWav(bogus, path.join(dir, 'x.wav')).catch(
      (rejection: unknown) => rejection,
    );
    expect(error).toBeInstanceOf(MediaConversionError);
    expect(error instanceof MediaConversionError ? error.stderr : '').not.toBe('');
    expect(String(error)).toMatch(/exited with code/);
  });

  it('kills ffmpeg at the timeout', async () => {
    const source = tone('long.m4a', 'aac', 30, 44_100);
    await expect(
      convertToTranscriptionWav(source, path.join(dir, 'long.wav'), { timeoutMs: 1 }),
    ).rejects.toThrow(/timed out after 1 ms/);
  });

  it('reports a missing ffmpeg binary', async () => {
    await expect(
      convertToTranscriptionWav('in.m4a', path.join(dir, 'y.wav'), {
        ffmpegPath: path.join(dir, 'no-such-ffmpeg'),
      }),
    ).rejects.toThrow(/ffmpeg not found/);
  });
});
