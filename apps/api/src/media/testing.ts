// Test support for media code: generated inputs, no committed binaries. Imported only by tests.
import { spawnSync } from 'node:child_process';
import path from 'node:path';

// Same policy as convert.test.ts: skipped locally without ffmpeg, always run in CI (`CI` set),
// where a missing ffmpeg must fail loudly instead of silently dropping coverage.
export const ffmpegAvailable =
  spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0 &&
  spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0;
const inCI = process.env['CI'] !== undefined && process.env['CI'] !== '';
export const runFfmpegTests = ffmpegAvailable || inCI;

export interface GenerateMediaOptions {
  /** ffmpeg input arguments, e.g. `['-f', 'lavfi', '-i', 'sine=duration=2']`. */
  readonly inputs: readonly string[];
  /** Output arguments before the file name, e.g. `['-c:a', 'aac']`. */
  readonly outputArgs?: readonly string[];
}

/** Runs ffmpeg to produce `dir/file` and returns its path; throws with stderr on failure. */
export function generateMedia(dir: string, file: string, options: GenerateMediaOptions): string {
  const output = path.join(dir, file);
  const result = spawnSync(
    'ffmpeg',
    [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      ...options.inputs,
      ...(options.outputArgs ?? []),
      output,
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`ffmpeg could not generate ${file}: ${result.stderr || String(result.error)}`);
  }
  return output;
}

/** A sine tone from ffmpeg's lavfi source, encoded with `codec`. */
export function generateTone(
  dir: string,
  file: string,
  { seconds, codec, extra = [] }: { seconds: number; codec: string; extra?: readonly string[] },
): string {
  return generateMedia(dir, file, {
    inputs: ['-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${seconds}`],
    outputArgs: ['-c:a', codec, ...extra],
  });
}
