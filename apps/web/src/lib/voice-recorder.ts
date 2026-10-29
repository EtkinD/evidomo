import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { isAllowedAudioType } from './capture';

/**
 * In preference order: WebM/Opus (Chrome, Edge, Firefox, Safari 18.4+), then MP4/AAC (older
 * Safari). Every base type is on the upload allow-list (`VOICE_MEMO_UPLOAD_CONTENT_TYPES`).
 */
export const RECORDER_MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/mp4',
  'audio/webm',
  'audio/ogg;codecs=opus',
] as const;

/** The first candidate this browser can record, or null (the browser then picks its own). */
export function pickRecorderMimeType(): string | null {
  return RECORDER_MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type)) ?? null;
}

export type RecorderSupport =
  | { status: 'checking' }
  | { status: 'supported' }
  | { status: 'unsupported'; reason: 'insecure_context' | 'no_recorder' };

type SupportKey = 'checking' | 'supported' | 'insecure_context' | 'no_recorder';

export function detectRecorderSupport(): SupportKey {
  if (typeof MediaRecorder === 'undefined') return 'no_recorder';
  // getUserMedia exists only in secure contexts (HTTPS or localhost).
  if (typeof navigator.mediaDevices?.getUserMedia !== 'function') {
    return window.isSecureContext ? 'no_recorder' : 'insecure_context';
  }
  return 'supported';
}

function toSupport(key: SupportKey): RecorderSupport {
  return key === 'checking' || key === 'supported'
    ? { status: key }
    : { status: 'unsupported', reason: key };
}

const serverSupport = (): SupportKey => 'checking';

// Capabilities do not change while the page is open.
const subscribeNever = (): (() => void) => () => {};

export type RecorderState =
  | { phase: 'idle' }
  | { phase: 'requesting' }
  | { phase: 'recording'; elapsedMs: number }
  | { phase: 'recorded'; blob: Blob; url: string; durationMs: number }
  | { phase: 'failed'; reason: 'denied' | 'no_microphone' | 'unusable_format' | 'error' };

const TICK_MS = 250;
/**
 * Stop this long before the limit: the server rejects a memo over its limit (`too_long`), and
 * the timer, the encoder, and the last chunk all add a little to what was measured.
 */
export const STOP_MARGIN_MS = 1500;

export interface VoiceRecorder {
  support: RecorderSupport;
  state: RecorderState;
  start: () => Promise<void>;
  stop: () => void;
  /** Drops the recording (or failure) and returns to idle. */
  reset: () => void;
}

function errorName(error: unknown): string {
  return error instanceof DOMException || error instanceof Error ? error.name : '';
}

/** Records the microphone into one blob, stopping by itself at `maxMs`. */
interface Internals {
  recorder: MediaRecorder | null;
  stream: MediaStream | null;
  timer: ReturnType<typeof setInterval> | null;
  /** Removes the `visibilitychange` listener of the running recording. */
  stopWatchingVisibility: (() => void) | null;
  url: string | null;
  /** Bumped by reset/unmount so a late getUserMedia answer or stop event is ignored. */
  generation: number;
}

/** Stops everything the recorder holds: the recording, the microphone, the timer, the preview. */
function teardown(internals: Internals): void {
  internals.generation += 1;
  const active = internals.recorder;
  internals.recorder = null;
  if (active !== null) {
    active.ondataavailable = null;
    active.onstop = null;
    active.onerror = null;
    if (active.state !== 'inactive') active.stop();
  }
  releaseMicrophone(internals);
  if (internals.url !== null) URL.revokeObjectURL(internals.url);
  internals.url = null;
}

function releaseMicrophone(internals: Internals): void {
  if (internals.timer !== null) clearInterval(internals.timer);
  internals.timer = null;
  internals.stopWatchingVisibility?.();
  internals.stopWatchingVisibility = null;
  internals.stream?.getTracks().forEach((track) => track.stop());
  internals.stream = null;
}

/** Records the microphone into one blob, stopping by itself at `maxMs`. */
export function useVoiceRecorder(maxMs: number): VoiceRecorder {
  const supportKey = useSyncExternalStore(subscribeNever, detectRecorderSupport, serverSupport);
  const [state, setState] = useState<RecorderState>({ phase: 'idle' });
  const ref = useRef<Internals>({
    recorder: null,
    stream: null,
    timer: null,
    stopWatchingVisibility: null,
    url: null,
    generation: 0,
  });

  useEffect(() => {
    const internals = ref.current;
    return () => teardown(internals);
  }, []);

  async function start(): Promise<void> {
    const internals = ref.current;
    teardown(internals);
    const mine = internals.generation;
    setState({ phase: 'requesting' });
    let media: MediaStream;
    try {
      media = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      if (mine !== internals.generation) return;
      const name = errorName(error);
      setState({
        phase: 'failed',
        reason:
          name === 'NotAllowedError' || name === 'SecurityError'
            ? 'denied'
            : name === 'NotFoundError' || name === 'OverconstrainedError'
              ? 'no_microphone'
              : 'error',
      });
      return;
    }
    if (mine !== internals.generation) {
      media.getTracks().forEach((track) => track.stop());
      return;
    }
    internals.stream = media;

    let active: MediaRecorder;
    try {
      const mimeType = pickRecorderMimeType();
      active =
        mimeType === null ? new MediaRecorder(media) : new MediaRecorder(media, { mimeType });
    } catch {
      releaseMicrophone(internals);
      setState({ phase: 'failed', reason: 'error' });
      return;
    }
    const type = active.mimeType;
    if (!isAllowedAudioType(type)) {
      releaseMicrophone(internals);
      setState({ phase: 'failed', reason: 'unusable_format' });
      return;
    }

    const chunks: Blob[] = [];
    const startedAt = Date.now();
    const limitMs = Math.max(TICK_MS, maxMs - STOP_MARGIN_MS);
    // Background tabs throttle timers, so the limit is also checked whenever the browser wakes
    // the page or hands over data, not only on the tick. Returns true when it stopped.
    const enforceLimit = (): boolean => {
      if (Date.now() - startedAt < limitMs || active.state === 'inactive') return false;
      active.stop();
      return true;
    };
    active.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
      enforceLimit();
    };
    active.onstop = () => {
      if (mine !== internals.generation) return;
      releaseMicrophone(internals);
      internals.recorder = null;
      if (chunks.length === 0) {
        setState({ phase: 'failed', reason: 'error' });
        return;
      }
      const blob = new Blob(chunks, { type });
      internals.url = URL.createObjectURL(blob);
      setState({
        phase: 'recorded',
        blob,
        url: internals.url,
        // Measured, not clamped: what the server will measure too.
        durationMs: Date.now() - startedAt,
      });
    };
    active.onerror = () => {
      if (mine !== internals.generation) return;
      teardown(internals);
      setState({ phase: 'failed', reason: 'error' });
    };

    internals.recorder = active;
    try {
      active.start();
    } catch {
      teardown(internals);
      setState({ phase: 'failed', reason: 'error' });
      return;
    }
    setState({ phase: 'recording', elapsedMs: 0 });
    internals.timer = setInterval(() => {
      if (enforceLimit()) return;
      setState({ phase: 'recording', elapsedMs: Date.now() - startedAt });
    }, TICK_MS);
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') enforceLimit();
    };
    document.addEventListener('visibilitychange', onVisible);
    internals.stopWatchingVisibility = () =>
      document.removeEventListener('visibilitychange', onVisible);
  }

  return {
    support: toSupport(supportKey),
    state,
    start,
    stop: () => {
      const active = ref.current.recorder;
      if (active !== null && active.state !== 'inactive') active.stop();
    },
    reset: () => {
      teardown(ref.current);
      setState({ phase: 'idle' });
    },
  };
}
