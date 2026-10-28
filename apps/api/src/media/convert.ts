import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { assertTranscriptionWav, type TranscriptionSampleRate, type WavInfo } from './wav.ts';

/** A 10-minute recording converts in a few seconds; this bounds a stuck or hostile input. */
export const DEFAULT_FFMPEG_TIMEOUT_MS = 120_000;

/** Only the tail of stderr is kept: ffmpeg prints the actual error last. */
const STDERR_TAIL_BYTES = 8 * 1024;

export class MediaConversionError extends Error {
  override name = 'MediaConversionError';
  /** Tail of ffmpeg's stderr, when the process ran. */
  readonly stderr: string;

  constructor(message: string, stderr: string, options?: ErrorOptions) {
    super(stderr === '' ? message : `${message}\n${stderr}`, options);
    this.stderr = stderr;
  }
}

export interface ConvertToWavOptions {
  /** 16 kHz (default) or 24 kHz, the two rates the transcription endpoint accepts. */
  readonly sampleRate?: TranscriptionSampleRate;
  readonly timeoutMs?: number;
  /**
   * Hard cap on the decoded output (`-t`). Header durations can be missing (browser-recorded
   * WebM) or forged, so callers enforcing a length limit set this slightly above the limit and
   * check the returned `info.durationMs`: conversion work and output size stay bounded either way.
   */
  readonly maxDurationMs?: number;
  /** Defaults to `ffmpeg` on `PATH` (installed in the API image). */
  readonly ffmpegPath?: string;
  readonly signal?: AbortSignal;
}

/**
 * `file:` forces ffmpeg's local-file protocol, so a path can never be read as an option, a
 * network URL, or a `concat:`/`subfile:` pseudo-protocol.
 */
export function fileUrl(filePath: string): string {
  return `file:${path.resolve(filePath)}`;
}

/** The exact ffmpeg arguments; exported so tests can assert there is no shell involvement. */
export function ffmpegWavArgs(
  inputPath: string,
  outputPath: string,
  sampleRate: TranscriptionSampleRate,
  maxDurationMs?: number,
): string[] {
  if (maxDurationMs !== undefined && !(Number.isInteger(maxDurationMs) && maxDurationMs > 0)) {
    throw new RangeError(`maxDurationMs must be a positive integer, got ${maxDurationMs}`);
  }
  return [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    // Demuxers that reference other resources (playlists, drefs) may only open local files.
    '-protocol_whitelist',
    'file',
    '-i',
    fileUrl(inputPath),
    // Audio only; drop video/cover-art streams and all metadata (tags can carry personal data).
    '-vn',
    '-map_metadata',
    '-1',
    '-ac',
    '1',
    '-ar',
    String(sampleRate),
    '-c:a',
    'pcm_s16le',
    // No encoder tag (LIST chunk): the output is a canonical 44-byte-header WAV.
    '-bitexact',
    ...(maxDurationMs === undefined ? [] : ['-t', (maxDurationMs / 1000).toFixed(3)]),
    '-f',
    'wav',
    fileUrl(outputPath),
  ];
}

/** Runs ffmpeg with an argument array (no shell), a SIGKILL timeout, and stderr capture. */
export function runFfmpeg(
  ffmpegPath: string,
  args: readonly string[],
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = '';
    let settled = false;
    const settle = (error?: MediaConversionError): void => {
      if (settled) return;
      settled = true;
      if (error === undefined) resolve();
      else reject(error);
    };

    const startedAt = performance.now();
    // Arguments are passed as an array with `shell: false`: no string interpolation reaches a
    // shell. `timeout` makes Node kill the process (SIGKILL) when it runs too long.
    const child = spawn(ffmpegPath, args, {
      shell: false,
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      ...(signal === undefined ? {} : { signal }),
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL_BYTES);
    });

    child.on('error', (error) => {
      const reason =
        signal?.aborted === true
          ? 'ffmpeg was aborted'
          : 'code' in error && error.code === 'ENOENT'
            ? `ffmpeg not found at "${ffmpegPath}"`
            : `ffmpeg failed to run: ${error.message}`;
      settle(new MediaConversionError(reason, stderr.trim(), { cause: error }));
    });

    child.on('close', (code, killedBy) => {
      if (code === 0) {
        settle();
        return;
      }
      const reason =
        killedBy === null
          ? `ffmpeg exited with code ${code}`
          : signal?.aborted === true
            ? 'ffmpeg was aborted'
            : killedBy === 'SIGKILL' && performance.now() - startedAt >= timeoutMs
              ? `ffmpeg timed out after ${timeoutMs} ms`
              : `ffmpeg was killed by ${killedBy}`;
      settle(new MediaConversionError(reason, stderr.trim()));
    });
  });
}

export interface ConvertedWav {
  readonly path: string;
  readonly info: WavInfo;
}

/**
 * Converts any audio ffmpeg can decode (m4a/AAC, webm/Opus, ...) to mono 16-bit PCM WAV at
 * 16 kHz (or 24 kHz), then verifies the written header instead of trusting the exit code.
 * The output file is overwritten.
 */
export async function convertToTranscriptionWav(
  inputPath: string,
  outputPath: string,
  options: ConvertToWavOptions = {},
): Promise<ConvertedWav> {
  const sampleRate = options.sampleRate ?? 16_000;
  await runFfmpeg(
    options.ffmpegPath ?? 'ffmpeg',
    ffmpegWavArgs(inputPath, outputPath, sampleRate, options.maxDurationMs),
    options.timeoutMs ?? DEFAULT_FFMPEG_TIMEOUT_MS,
    options.signal,
  );

  let info: WavInfo;
  try {
    info = assertTranscriptionWav(await readFile(outputPath));
  } catch (error) {
    throw new MediaConversionError(
      `ffmpeg succeeded but ${outputPath} is not a valid transcription WAV`,
      '',
      { cause: error },
    );
  }
  if (info.sampleRate !== sampleRate) {
    throw new MediaConversionError(
      `ffmpeg wrote ${info.sampleRate} Hz instead of the requested ${sampleRate} Hz`,
      '',
    );
  }
  if (info.dataBytes === 0) {
    throw new MediaConversionError(`${inputPath} contains no audio samples`, '');
  }
  return { path: outputPath, info };
}
