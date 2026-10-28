import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { encodePcm16Wav } from '../media/wav.ts';
import { createMetaClients, ForbiddenModelError, META_BASE_URL } from './clients.ts';
import { cassettePath, readCassette } from './fixtures.ts';
import {
  parseTranscribeResponse,
  transcribeAudio,
  TRANSCRIBE_MAX_DURATION_MS,
  TranscriptionInputError,
  TranscriptionResponseError,
  type TranscribeRequest,
} from './transcribe.ts';
import { createInMemoryUsageRecorder } from './usage.ts';

const MODEL = 'muse-voice-transcribe-1.0';
const silentWav = encodePcm16Wav(new Int16Array(1_600), 16_000);

describe('parseTranscribeResponse', () => {
  it('maps the recorded ENDPOINTING responses to typed turns', async () => {
    const cassette = await readCassette(cassettePath('p1-04/voice-transcribe'));
    expect(cassette.interactions).toHaveLength(2);
    for (const interaction of cassette.interactions) {
      const { body } = interaction.response;
      expect(body.type).toBe('json');
      const transcript = parseTranscribeResponse(body.type === 'json' ? body.value : undefined);

      expect(transcript.sessionId).not.toBe('');
      expect(transcript.audioDurationMs).toBe(168_800);
      // One turn spanning the clip; ENDPOINTING sends no speaker label.
      expect(transcript.turns).toHaveLength(1);
      const [turn] = transcript.turns;
      expect(turn).toEqual({ index: 0, text: transcript.text, startMs: 0, endMs: 168_300 });
      expect(turn?.text).toContain('92 vierkante meter');
      expect(turn?.text).toContain("zo'n 95 vierkante meter");
    }
  });

  it('orders turns by turnId and keeps DIARIZATION speaker labels', () => {
    const transcript = parseTranscribeResponse({
      sessionId: 's',
      transcript: 'Hallo. Dag.',
      audioDurationMs: 4_000,
      turns: [
        { turnId: 7, startMs: 2_000, endMs: 3_500, transcript: 'Dag.', speaker: 'B' },
        { turnId: 3, startMs: 100, endMs: 1_500, transcript: 'Hallo.', speaker: 'A' },
      ],
      futureField: true,
    });
    expect(transcript.turns).toEqual([
      { index: 0, speaker: 'A', text: 'Hallo.', startMs: 100, endMs: 1_500 },
      { index: 1, speaker: 'B', text: 'Dag.', startMs: 2_000, endMs: 3_500 },
    ]);
  });

  it('accepts PUSH_TO_TALK responses, which have no turns', () => {
    const transcript = parseTranscribeResponse({
      sessionId: 's',
      transcript: 'Hallo.',
      audioDurationMs: 1_000,
      turns: [],
    });
    expect(transcript.turns).toEqual([]);
    expect(transcript.text).toBe('Hallo.');
  });

  it.each([
    ['missing audioDurationMs', { sessionId: 's', transcript: '', turns: [] }],
    [
      'endMs before startMs',
      {
        sessionId: 's',
        transcript: 'x',
        audioDurationMs: 1,
        turns: [{ turnId: 0, startMs: 900, endMs: 100, transcript: 'x' }],
      },
    ],
    [
      'fractional timestamps',
      {
        sessionId: 's',
        transcript: 'x',
        audioDurationMs: 1,
        turns: [{ turnId: 0, startMs: 0.5, endMs: 100, transcript: 'x' }],
      },
    ],
    ['an error body', { error: { message: 'nope' } }],
  ])('rejects %s', (_label, body) => {
    expect(() => parseTranscribeResponse(body)).toThrow(TranscriptionResponseError);
  });
});

describe('transcribeAudio', () => {
  // Parsed inside the handler: the request body is no longer readable after it returns.
  const requests: Array<{ url: string; form: FormData }> = [];
  const server = setupServer(
    http.post(`${META_BASE_URL}/asr/transcribe`, async ({ request }) => {
      requests.push({ url: request.url, form: await request.formData() });
      return HttpResponse.json({
        sessionId: new URL(request.url).searchParams.get('sessionId') ?? 'generated',
        transcript: 'Hallo.',
        audioDurationMs: 100,
        turns: [{ turnId: 0, startMs: 0, endMs: 90, transcript: 'Hallo.' }],
      });
    }),
  );
  const usage = createInMemoryUsageRecorder();
  const clients = createMetaClients({ apiKey: 'k', usage, maxRetries: 0 });
  const deps = {
    openai: clients.openai,
    usage,
    estimateCost: () => 0.5,
  };
  const base: TranscribeRequest = { model: MODEL, mode: 'ENDPOINTING', audio: silentWav };

  beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
  afterEach(() => {
    requests.length = 0;
    usage.clear();
  });
  afterAll(() => server.close());

  it('sends the settings as a JSON part and the WAV as an audio part', async () => {
    const transcript = await transcribeAudio(deps, {
      ...base,
      fileName: 'clip.wav',
      keywords: [' VvE ', 'NEN 2580', 'VvE'],
      languageBias: [],
      sessionId: 'abc',
    });

    expect(requests).toHaveLength(1);
    const [sent] = requests;
    expect(new URL(sent?.url ?? '').search).toBe('?sessionId=abc');
    const form = sent?.form;
    const settings = form?.get('request');
    const audio = form?.get('audio');
    expect(settings).toBeInstanceOf(Blob);
    expect(settings instanceof Blob ? settings.type : '').toBe('application/json');
    // Keywords are trimmed and de-duplicated; an empty languageBias is omitted, not sent as [].
    expect(JSON.parse(settings instanceof Blob ? await settings.text() : '{}')).toEqual({
      model: MODEL,
      audioEncoding: 'WAV',
      mode: 'ENDPOINTING',
      keywords: ['VvE', 'NEN 2580'],
    });
    expect(audio).toBeInstanceOf(File);
    expect(audio instanceof File ? [audio.name, audio.type, audio.size] : []).toEqual([
      'clip.wav',
      'audio/wav',
      silentWav.byteLength,
    ]);

    expect(transcript.sessionId).toBe('abc');
    expect(usage.entries).toEqual([
      expect.objectContaining({
        sdk: 'openai',
        modelId: MODEL,
        responseId: 'abc',
        audioDurationMs: 100,
        estimatedCostUsd: 0.5,
        inputTokens: undefined,
      }),
    ]);
  });

  it.each<[string, Partial<TranscribeRequest>, RegExp | (new (...args: never[]) => Error)]>([
    ['a Contributor-mode model', { model: `${MODEL}-contributor` }, ForbiddenModelError],
    ['non-WAV audio', { audio: new TextEncoder().encode('not audio') }, /not a transcribable WAV/],
    [
      'stereo audio',
      {
        audio: (() => {
          const wav = encodePcm16Wav(new Int16Array(16), 16_000);
          new DataView(wav.buffer).setUint16(22, 2, true);
          return wav;
        })(),
      },
      /not a transcribable WAV/,
    ],
    [
      'audio over 10 minutes',
      {
        audio: encodePcm16Wav(
          new Int16Array((TRANSCRIBE_MAX_DURATION_MS / 1000 + 1) * 16_000),
          16_000,
        ),
      },
      /at most 600000 ms/,
    ],
    ['an empty keyword', { keywords: ['VvE', ' '] }, /keywords must not contain empty strings/],
  ])('rejects %s before sending anything', async (_label, overrides, expected) => {
    const call = transcribeAudio(deps, { ...base, ...overrides });
    if (expected instanceof RegExp) {
      await expect(call).rejects.toThrow(TranscriptionInputError);
      await expect(call).rejects.toThrow(expected);
    } else {
      await expect(call).rejects.toThrow(expected);
    }
    expect(requests).toHaveLength(0);
    expect(usage.entries).toHaveLength(0);
  });

  it('records no usage when the response is malformed', async () => {
    server.use(
      http.post(`${META_BASE_URL}/asr/transcribe`, () => HttpResponse.json({ transcript: 'x' }), {
        once: true,
      }),
    );
    await expect(transcribeAudio(deps, base)).rejects.toThrow(TranscriptionResponseError);
    expect(usage.entries).toHaveLength(0);
  });
});
