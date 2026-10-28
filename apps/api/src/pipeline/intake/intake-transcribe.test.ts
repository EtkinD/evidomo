import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadDefinitions, type DefinitionRegistry } from '../../definitions/loader.ts';
import { convertToTranscriptionWav } from '../../media/convert.ts';
import { encodePcm16Wav } from '../../media/wav.ts';
import { createMetaClients } from '../../meta/clients.ts';
import { createMetaReplay } from '../../meta/replay.ts';
import { transcribeAudio } from '../../meta/transcribe.ts';
import { createInMemoryUsageRecorder } from '../../meta/usage.ts';
import { buildIntakeTranscribeRequest, INTAKE_AUDIO_FILE_NAME } from './handler.ts';
import {
  INTAKE_CASSETTE,
  WALKTHROUGH_FACT_FORM,
  walkthroughIntakeStep,
  walkthroughMarket,
} from './testing.ts';
import { toStoredTurns } from './turns.ts';

// The intake request (keywords from the fact form and nl v1, language bias, DIARIZATION) against
// the P1-04 TTS walkthrough. Record (macOS, needs data/p1-04/walkthrough-nl.m4a, spends ~$0.0085):
//   RECORD=1 node --env-file=<repo>/.env node_modules/vitest/vitest.mjs run --project api intake-transcribe
// Replay sends a 1-second silent WAV under the same declared filename: the cassette matches the
// audio part by name and type only (the TTS audio is not committed), every other part exactly.

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../../..');
const SOURCE_AUDIO = path.join(REPO_ROOT, 'data/p1-04/walkthrough-nl.m4a');

const replay = createMetaReplay({
  cassette: INTAKE_CASSETTE,
  match: { ignoreFileContentFields: ['audio'] },
});
const usage = createInMemoryUsageRecorder();
let registry: DefinitionRegistry;
let audio: Uint8Array;
let durationMs: number;
let workDir: string;

beforeAll(async () => {
  registry = await loadDefinitions();
  await replay.start();
  workDir = await mkdtemp(path.join(tmpdir(), 'evidomo-p2-06-'));
  if (replay.mode === 'record') {
    const converted = await convertToTranscriptionWav(
      SOURCE_AUDIO,
      path.join(workDir, INTAKE_AUDIO_FILE_NAME),
    );
    audio = await readFile(converted.path);
    durationMs = converted.info.durationMs;
  } else {
    audio = encodePcm16Wav(new Int16Array(16_000), 16_000);
    durationMs = 1000;
  }
});

afterAll(async () => {
  await replay.stop();
  await rm(workDir, { recursive: true, force: true });
});

describe(`intake transcription request (${replay.mode})`, () => {
  it('returns diarized turns for the walkthrough and records audio usage', async () => {
    const clients = createMetaClients({ apiKey: replay.apiKey, usage });
    const step = walkthroughIntakeStep(registry);
    const request = buildIntakeTranscribeRequest({
      step,
      market: walkthroughMarket(registry),
      factForm: WALKTHROUGH_FACT_FORM,
      audio,
      durationMs,
    });
    expect(request.mode).toBe('DIARIZATION');
    expect(request.languageBias).toEqual(['Dutch', 'English']);
    expect(request.keywords?.slice(0, 2)).toEqual(['Zandmeer', 'Kwartelhoflaan']);

    const transcript = await transcribeAudio({ openai: clients.openai, usage }, request);
    replay.assertAllMatched();

    // 2:49 of TTS speech (fixtures/meta/p1-04/walkthrough-nl.txt).
    expect(transcript.audioDurationMs).toBeGreaterThan(120_000);
    expect(transcript.text).toMatch(/Kwartelhoflaan/);
    expect(transcript.turns.length).toBeGreaterThanOrEqual(1);
    for (const turn of transcript.turns) {
      expect(turn.endMs).toBeGreaterThanOrEqual(turn.startMs);
      expect(turn.endMs).toBeLessThanOrEqual(transcript.audioDurationMs);
    }

    const stored = toStoredTurns(transcript.turns, {
      maxTurnMs: step.max_turn_seconds === undefined ? null : step.max_turn_seconds * 1000,
    });
    expect(stored.length).toBeGreaterThanOrEqual(transcript.turns.length);
    expect(stored.map((turn) => turn.index)).toEqual(stored.map((_, i) => i));

    expect(usage.entries).toHaveLength(1);
    expect(usage.entries[0]).toMatchObject({
      modelId: step.model,
      audioDurationMs: transcript.audioDurationMs,
      responseId: transcript.sessionId,
    });
  }, 180_000);
});
