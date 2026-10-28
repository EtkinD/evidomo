import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processVoiceMemo, validateVoiceMemo, VOICE_MEMO_FORMATS } from './audio.ts';
import { MediaConversionError } from './convert.ts';
import { ffprobeArgs, MediaProbeError, probeMedia } from './probe.ts';
import { ffmpegAvailable, generateMedia, generateTone, runFfmpegTests } from './testing.ts';
import { UploadRejectedError } from './upload-error.ts';
import { assertTranscriptionWav } from './wav.ts';

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

describe('ffprobeArgs', () => {
  it('restricts demuxers and protocols and keeps a hostile path in one file: argument', () => {
    const args = ffprobeArgs('memo;$(rm -rf x).m4a', ['wav', 'mp3']);
    expect(args[args.indexOf('-protocol_whitelist') + 1]).toBe('file');
    expect(args[args.indexOf('-format_whitelist') + 1]).toBe('wav,mp3');
    expect(args.at(-1)).toBe(`file:${path.resolve('memo;$(rm -rf x).m4a')}`);
  });

  it('refuses an empty allow-list', () => {
    expect(() => ffprobeArgs('x', [])).toThrow(RangeError);
  });
});

describe.skipIf(!runFfmpegTests)('voice memo processing (real ffmpeg)', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'evidomo-audio-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('requires ffmpeg and ffprobe in CI', () => {
    expect(ffmpegAvailable, 'ffmpeg and ffprobe must be installed on the CI runner').toBe(true);
  });

  describe('probeMedia', () => {
    it('reports container, duration, and streams', async () => {
      const m4a = generateTone(dir, 'probe.m4a', { seconds: 2, codec: 'aac' });
      const probe = await probeMedia(m4a, { allowedFormats: VOICE_MEMO_FORMATS });
      expect(probe.formatName).toBe('mov,mp4,m4a,3gp,3g2,mj2');
      expect(probe.durationMs).toBeGreaterThan(1_900);
      expect(probe.streams).toEqual([
        expect.objectContaining({ codecType: 'audio', codecName: 'aac', attachedPic: false }),
      ]);
    });

    it('has no duration for a streamed WebM, as browsers record it', async () => {
      const live = generateTone(dir, 'live.webm', {
        seconds: 1,
        codec: 'libopus',
        extra: ['-f', 'webm', '-live', '1'],
      });
      const probe = await probeMedia(live, { allowedFormats: VOICE_MEMO_FORMATS });
      expect(probe.formatName).toBe('matroska,webm');
      expect(probe.durationMs).toBeUndefined();
    });

    it('fails with failure "exit" for non-media and for demuxers outside the allow-list', async () => {
      const text = path.join(dir, 'notes.m4a');
      await writeFile(text, 'just text');
      await expect(probeMedia(text, { allowedFormats: VOICE_MEMO_FORMATS })).rejects.toMatchObject({
        failure: 'exit',
      });

      const ts = generateTone(dir, 'tone.ts', {
        seconds: 1,
        codec: 'aac',
        extra: ['-f', 'mpegts'],
      });
      await expect(probeMedia(ts, { allowedFormats: VOICE_MEMO_FORMATS })).rejects.toMatchObject({
        failure: 'exit',
      });
      // Sanity: the same file probes fine when its demuxer is allowed.
      expect((await probeMedia(ts, { allowedFormats: ['mpegts'] })).formatName).toBe('mpegts');
    });

    it('fails with failure "spawn" when ffprobe is missing', async () => {
      const error: unknown = await probeMedia('x', {
        allowedFormats: ['wav'],
        ffprobePath: path.join(dir, 'no-such-ffprobe'),
      }).catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(MediaProbeError);
      expect(error).toMatchObject({ failure: 'spawn' });
      expect(String(error)).toMatch(/ffprobe not found/);
    });
  });

  describe('validateVoiceMemo', () => {
    it.each([
      { file: 'ok.m4a', codec: 'aac', container: 'mov,mp4,m4a,3gp,3g2,mj2' },
      { file: 'ok.webm', codec: 'libopus', container: 'matroska,webm', probed: 'opus' },
      { file: 'ok.ogg', codec: 'libopus', container: 'ogg', probed: 'opus' },
      { file: 'ok.mp3', codec: 'libmp3lame', container: 'mp3', probed: 'mp3' },
      { file: 'ok.wav', codec: 'pcm_s16le', container: 'wav' },
      { file: 'ok.flac', codec: 'flac', container: 'flac' },
    ])('accepts $file by content', async ({ file, codec, container, probed }) => {
      const source = generateTone(dir, file, { seconds: 1, codec });
      // The extension plays no part: the probe reads a renamed copy just the same.
      const renamed = path.join(dir, `${file}.bin`);
      await writeFile(renamed, await readFile(source));
      const result = await validateVoiceMemo(renamed);
      expect(result).toMatchObject({ container, codec: probed ?? codec });
    });

    it('rejects an empty file and one over the size limit without probing', async () => {
      const empty = path.join(dir, 'empty.m4a');
      await writeFile(empty, '');
      expect((await rejection(validateVoiceMemo(empty))).code).toBe('empty_file');

      const m4a = generateTone(dir, 'big.m4a', { seconds: 1, codec: 'aac' });
      const error = await rejection(
        validateVoiceMemo(m4a, { maxBytes: 100, ffprobePath: path.join(dir, 'no-such-ffprobe') }),
      );
      expect(error.code).toBe('file_too_large');
    });

    it('rejects non-audio content and disallowed containers', async () => {
      const text = path.join(dir, 'memo.m4a');
      await writeFile(text, 'definitely not audio');
      expect((await rejection(validateVoiceMemo(text))).code).toBe('unsupported_format');

      const ts = generateTone(dir, 'memo.ts', {
        seconds: 1,
        codec: 'aac',
        extra: ['-f', 'mpegts'],
      });
      expect((await rejection(validateVoiceMemo(ts))).code).toBe('unsupported_format');
    });

    it('rejects video files, multiple audio tracks, and codecs outside the allow-list', async () => {
      const video = generateMedia(dir, 'walk.mp4', {
        inputs: ['-f', 'lavfi', '-i', 'testsrc=duration=1', '-f', 'lavfi', '-i', 'sine=duration=1'],
        outputArgs: ['-c:v', 'mpeg4', '-c:a', 'aac'],
      });
      expect(await rejection(validateVoiceMemo(video))).toMatchObject({
        code: 'unsupported_format',
        message: expect.stringMatching(/Video/) as unknown,
      });

      const twoTracks = generateMedia(dir, 'two.mka', {
        inputs: ['-f', 'lavfi', '-i', 'sine=duration=1', '-f', 'lavfi', '-i', 'sine=duration=1'],
        outputArgs: ['-map', '0:a', '-map', '1:a', '-c:a', 'flac', '-f', 'matroska'],
      });
      expect((await rejection(validateVoiceMemo(twoTracks))).message).toMatch(/single audio track/);

      const ac3 = generateTone(dir, 'memo.mka', {
        seconds: 1,
        codec: 'ac3',
        extra: ['-f', 'matroska'],
      });
      expect((await rejection(validateVoiceMemo(ac3))).message).toMatch(/codec/);
    });

    it('rejects a declared duration over the limit before any decoding', async () => {
      const long = generateTone(dir, 'long.m4a', { seconds: 4, codec: 'aac' });
      // A missing ffmpeg proves the converter never ran: reaching it would throw a spawn error.
      const error = await rejection(
        processVoiceMemo(long, path.join(dir, 'long.wav'), {
          maxDurationMs: 2_000,
          ffmpegPath: path.join(dir, 'no-such-ffmpeg'),
        }),
      );
      expect(error.code).toBe('too_long');
      expect(error.message).toBe('The recording is longer than 2 seconds.');
    });
  });

  describe('processVoiceMemo', () => {
    it('converts to a 16 kHz mono transcription WAV and reports the measured duration', async () => {
      const source = generateTone(dir, 'memo.webm', { seconds: 2, codec: 'libopus' });
      const output = path.join(dir, 'memo.wav');
      const result = await processVoiceMemo(source, output);

      expect(result).toMatchObject({
        wavPath: output,
        sampleRate: 16_000,
        sourceContainer: 'matroska,webm',
        sourceCodec: 'opus',
      });
      expect(Math.abs(result.durationMs - 2_000)).toBeLessThan(100);
      const info = assertTranscriptionWav(await readFile(output));
      expect(info.durationMs).toBe(result.durationMs);
    });

    it('rejects a too-long recording without a declared duration after bounded decoding', async () => {
      const live = generateTone(dir, 'long-live.webm', {
        seconds: 6,
        codec: 'libopus',
        extra: ['-f', 'webm', '-live', '1'],
      });
      const output = path.join(dir, 'long-live.wav');
      const error = await rejection(processVoiceMemo(live, output, { maxDurationMs: 2_000 }));
      expect(error.code).toBe('too_long');
      // ffmpeg stopped at limit + 1 s instead of decoding all 6 s.
      expect(assertTranscriptionWav(await readFile(output)).durationMs).toBe(3_000);
    });

    it('accepts a streamed WebM within the limit', async () => {
      const live = generateTone(dir, 'short-live.webm', {
        seconds: 1,
        codec: 'libopus',
        extra: ['-f', 'webm', '-live', '1'],
      });
      const result = await processVoiceMemo(live, path.join(dir, 'short-live.wav'), {
        maxDurationMs: 2_000,
      });
      expect(result.durationMs).toBeLessThanOrEqual(2_000);
    });

    it('passes a missing ffmpeg through as a server fault, not a rejection', async () => {
      const source = generateTone(dir, 'fine.m4a', { seconds: 1, codec: 'aac' });
      await expect(
        processVoiceMemo(source, path.join(dir, 'fine.wav'), {
          ffmpegPath: path.join(dir, 'no-such-ffmpeg'),
        }),
      ).rejects.toBeInstanceOf(MediaConversionError);
    });
  });
});
