import { spawn } from 'node:child_process';
import path from 'node:path';
import { z } from 'zod';

/** Probing reads headers (and a few packets); seconds mean a pathological input. */
export const DEFAULT_FFPROBE_TIMEOUT_MS = 15_000;

/** `-show_entries` keeps the JSON tiny; anything larger is not ffprobe answering our query. */
const STDOUT_LIMIT_BYTES = 256 * 1024;
const STDERR_TAIL_BYTES = 8 * 1024;

export type MediaProbeFailure = 'spawn' | 'exit' | 'timeout' | 'output';

export class MediaProbeError extends Error {
  override name = 'MediaProbeError';
  /**
   * `exit`/`timeout`: ffprobe could not read the input (a property of the file). `spawn`/
   * `output`: the probe itself is broken (missing binary, unexpected output), not the file.
   */
  readonly failure: MediaProbeFailure;
  readonly stderr: string;

  constructor(failure: MediaProbeFailure, message: string, stderr: string, options?: ErrorOptions) {
    super(stderr === '' ? message : `${message}\n${stderr}`, options);
    this.failure = failure;
    this.stderr = stderr;
  }
}

export interface ProbedStream {
  readonly index: number;
  /** `audio`, `video`, `data`, `subtitle`, ... */
  readonly codecType: string;
  readonly codecName: string | undefined;
  readonly durationMs: number | undefined;
  /** Embedded cover art: a still image stored as a video stream. */
  readonly attachedPic: boolean;
}

export interface MediaProbe {
  /** Demuxer name, e.g. `mov,mp4,m4a,3gp,3g2,mj2` or `matroska,webm`. */
  readonly formatName: string;
  /** Container duration, when the header declares one (streamed WebM often does not). */
  readonly durationMs: number | undefined;
  readonly streams: readonly ProbedStream[];
}

export interface ProbeMediaOptions {
  /** Demuxers ffprobe may use (`-format_whitelist`); anything else fails to open. */
  readonly allowedFormats: readonly string[];
  readonly timeoutMs?: number;
  /** Defaults to `ffprobe` on `PATH` (shipped with ffmpeg in the API image). */
  readonly ffprobePath?: string;
  readonly signal?: AbortSignal;
}

// ffprobe prints numbers as decimal strings; a stream without the field omits the key.
const seconds = z
  .string()
  .regex(/^\d+(\.\d+)?$/)
  .transform((value) => Math.round(Number(value) * 1000));

const ffprobeOutputSchema = z.object({
  format: z.object({
    format_name: z.string().min(1),
    duration: seconds.optional(),
  }),
  streams: z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        codec_type: z.string().default('unknown'),
        codec_name: z.string().optional(),
        duration: seconds.optional(),
        disposition: z.object({ attached_pic: z.number().int().optional() }).optional(),
      }),
    )
    .default([]),
});

/** The exact ffprobe arguments; exported so tests can assert the hardening flags. */
export function ffprobeArgs(inputPath: string, allowedFormats: readonly string[]): string[] {
  if (allowedFormats.length === 0) throw new RangeError('allowedFormats must not be empty');
  return [
    '-v',
    'error',
    '-hide_banner',
    // Defense in depth against demuxers that open other resources (HLS playlists, concat lists,
    // mov drefs): only allow-listed demuxers, and they may only open local files.
    '-protocol_whitelist',
    'file',
    '-format_whitelist',
    allowedFormats.join(','),
    '-show_entries',
    'format=format_name,duration:stream=index,codec_type,codec_name,duration:stream_disposition=attached_pic',
    '-of',
    'json',
    // `file:` keeps the path from being read as an option, URL, or pseudo-protocol.
    `file:${path.resolve(inputPath)}`,
  ];
}

function runFfprobe(
  ffprobePath: string,
  args: readonly string[],
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (result: { stdout: string } | MediaProbeError): void => {
      if (settled) return;
      settled = true;
      if (result instanceof MediaProbeError) reject(result);
      else resolve(result.stdout);
    };

    const startedAt = performance.now();
    // Argument array with `shell: false`: nothing is shell-parsed. Node SIGKILLs on timeout.
    const child = spawn(ffprobePath, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      ...(signal === undefined ? {} : { signal }),
    });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.length > STDOUT_LIMIT_BYTES) {
        child.kill('SIGKILL');
        settle(new MediaProbeError('output', 'ffprobe output exceeded the size limit', ''));
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL_BYTES);
    });

    child.on('error', (error) => {
      const reason =
        signal?.aborted === true
          ? 'ffprobe was aborted'
          : 'code' in error && error.code === 'ENOENT'
            ? `ffprobe not found at "${ffprobePath}"`
            : `ffprobe failed to run: ${error.message}`;
      settle(new MediaProbeError('spawn', reason, stderr.trim(), { cause: error }));
    });

    child.on('close', (code, killedBy) => {
      if (code === 0) {
        settle({ stdout });
        return;
      }
      if (killedBy === null) {
        settle(new MediaProbeError('exit', `ffprobe exited with code ${code}`, stderr.trim()));
      } else if (signal?.aborted === true) {
        settle(new MediaProbeError('spawn', 'ffprobe was aborted', stderr.trim()));
      } else if (killedBy === 'SIGKILL' && performance.now() - startedAt >= timeoutMs) {
        settle(new MediaProbeError('timeout', `ffprobe timed out after ${timeoutMs} ms`, ''));
      } else {
        settle(new MediaProbeError('spawn', `ffprobe was killed by ${killedBy}`, stderr.trim()));
      }
    });
  });
}

/** Reads container and stream information with ffprobe, without decoding the media. */
export async function probeMedia(
  inputPath: string,
  options: ProbeMediaOptions,
): Promise<MediaProbe> {
  const stdout = await runFfprobe(
    options.ffprobePath ?? 'ffprobe',
    ffprobeArgs(inputPath, options.allowedFormats),
    options.timeoutMs ?? DEFAULT_FFPROBE_TIMEOUT_MS,
    options.signal,
  );

  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch (error) {
    throw new MediaProbeError('output', 'ffprobe printed invalid JSON', '', { cause: error });
  }
  const parsed = ffprobeOutputSchema.safeParse(json);
  if (!parsed.success) {
    throw new MediaProbeError('output', 'ffprobe output has an unexpected shape', '', {
      cause: parsed.error,
    });
  }
  return {
    formatName: parsed.data.format.format_name,
    durationMs: parsed.data.format.duration,
    streams: parsed.data.streams.map((stream) => ({
      index: stream.index,
      codecType: stream.codec_type,
      codecName: stream.codec_name,
      durationMs: stream.duration,
      attachedPic: stream.disposition?.attached_pic === 1,
    })),
  };
}
