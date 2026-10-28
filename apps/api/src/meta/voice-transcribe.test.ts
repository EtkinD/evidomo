import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { convertToTranscriptionWav } from '../media/convert.ts';
import { encodePcm16Wav } from '../media/wav.ts';
import { createMetaClients, type MetaClients } from './clients.ts';
import { createMetaReplay } from './replay.ts';
import { transcribeAudio, type TranscribeRequest } from './transcribe.ts';
import { createInMemoryUsageRecorder, type CostEstimator } from './usage.ts';

// Record (macOS; generates nothing, expects the TTS audio from docs/model-notes.md, P1-04):
//   RECORD=1 node --env-file=.env node_modules/vitest/vitest.mjs run --project api voice-transcribe
// Replay (default, any OS) sends a 1-second silent WAV under the same declared filename: the
// cassette matches the audio part by name and type only, because the TTS audio is not committed.

const MODEL = 'muse-voice-transcribe-1.0';
const AUDIO_FILE_NAME = 'p1-04-walkthrough-nl.wav';
const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');
const SOURCE_AUDIO = path.join(REPO_ROOT, 'data/p1-04/walkthrough-nl.m4a');
const SOURCE_AUDIO_WEBM = path.join(REPO_ROOT, 'data/p1-04/walkthrough-nl.webm');
// Fictional terms from fixtures/meta/p1-04/walkthrough-nl.txt (street, town, Dutch room terms).
const KEYWORDS = [
  'Kwartelhoflaan',
  'Zandmeer',
  'NEN 2580',
  'VvE',
  'HR-ketel',
  'vlizotrap',
  'meerjarenonderhoudsplan',
];
// $0.18 per audio hour (docs/architecture.md section 10).
const USD_PER_AUDIO_MS = 0.18 / 3_600_000;
const estimateCost: CostEstimator = (usage) =>
  usage.audioDurationMs === undefined ? undefined : usage.audioDurationMs * USD_PER_AUDIO_MS;

const replay = createMetaReplay({
  cassette: 'p1-04/voice-transcribe',
  match: { ignoreFileContentFields: ['audio'] },
});
const usage = createInMemoryUsageRecorder();
let clients: MetaClients;
let audio: Uint8Array;
let workDir: string;

beforeAll(async () => {
  await replay.start();
  clients = createMetaClients({ apiKey: replay.apiKey, usage, estimateCost });
  workDir = await mkdtemp(path.join(tmpdir(), 'evidomo-p1-04-'));
  if (replay.mode === 'record') {
    const converted = await convertToTranscriptionWav(
      SOURCE_AUDIO,
      path.join(workDir, AUDIO_FILE_NAME),
    );
    // The webm (Opus) rendition of the same speech must convert to the same length.
    const fromWebm = await convertToTranscriptionWav(
      SOURCE_AUDIO_WEBM,
      path.join(workDir, 'webm.wav'),
    );
    expect(Math.abs(fromWebm.info.durationMs - converted.info.durationMs)).toBeLessThan(100);
    audio = await readFile(converted.path);
  } else {
    audio = encodePcm16Wav(new Int16Array(16_000), 16_000);
  }
});

afterEach(() => {
  usage.clear();
  replay.assertAllMatched();
});

afterAll(async () => {
  await replay.stop();
  await rm(workDir, { recursive: true, force: true });
});

function request(overrides: Partial<TranscribeRequest>): TranscribeRequest {
  return {
    model: MODEL,
    mode: 'ENDPOINTING',
    audio,
    fileName: AUDIO_FILE_NAME,
    languageBias: ['Dutch'],
    ...overrides,
  };
}

describe(`${MODEL} file transcription (${replay.mode})`, () => {
  it.each([
    { label: 'with keyword biasing', keywords: KEYWORDS },
    { label: 'without keyword biasing', keywords: undefined },
  ])(
    'returns timed turns and records audio usage $label',
    async ({ keywords }) => {
      const transcript = await transcribeAudio(
        { openai: clients.openai, usage, estimateCost },
        request(keywords === undefined ? {} : { keywords }),
      );

      // 2:49 of TTS speech (fixtures/meta/p1-04/walkthrough-nl.txt).
      expect(transcript.audioDurationMs).toBeGreaterThan(120_000);
      expect(transcript.audioDurationMs).toBeLessThan(300_000);
      expect(transcript.text).toMatch(/Zandmeer|Kwartelhof/i);
      // Measured: ENDPOINTING returned ONE turn for the whole TTS clip (its paragraph pauses are
      // too short to end a turn). Multi-turn segmentation is unverified until real audio or a
      // DIARIZATION recording exists (docs/model-notes.md, P1-04).
      expect(transcript.turns.length).toBeGreaterThanOrEqual(1);
      if (keywords !== undefined) {
        // Biased spellings that the unbiased recording got wrong ("VVE", "meerjaren onderhoudsplan").
        expect(transcript.text).toContain('VvE');
        expect(transcript.text).toContain('meerjarenonderhoudsplan');
      }
      let previousEnd = 0;
      for (const [index, turn] of transcript.turns.entries()) {
        expect(turn.index).toBe(index);
        expect(turn.text.trim()).not.toBe('');
        expect(turn.endMs).toBeGreaterThan(turn.startMs);
        expect(turn.startMs).toBeGreaterThanOrEqual(previousEnd);
        previousEnd = turn.endMs;
      }
      expect(previousEnd).toBeLessThanOrEqual(transcript.audioDurationMs);

      expect(usage.entries).toHaveLength(1);
      const [entry] = usage.entries;
      expect(entry).toMatchObject({
        sdk: 'openai',
        modelId: MODEL,
        responseId: transcript.sessionId,
        audioDurationMs: transcript.audioDurationMs,
        inputTokens: undefined,
        outputTokens: undefined,
      });
      expect(entry?.estimatedCostUsd).toBeGreaterThan(0);
      expect(entry?.estimatedCostUsd).toBeLessThan(0.02);
    },
    120_000,
  );
});
