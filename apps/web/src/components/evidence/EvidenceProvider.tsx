import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { EvidenceUrls } from '../../lib/evidence-urls';

/** One span of a recording to play. `id` tells turns apart (the same recording has many). */
export interface AudioClip {
  id: string;
  url: string;
  startMs: number;
  endMs: number;
}

interface EvidenceAudio {
  playingId: string | null;
  /** The clip whose audio could not be played, until another clip is started. */
  failedId: string | null;
  /**
   * The clip that starts after the recording ends (a stand-in or truncated file): there is
   * nothing to play for it, and the screen says so, until another clip is started.
   */
  unavailableId: string | null;
  /** Starts the clip, or stops it when it is the one playing. Any other clip is stopped first. */
  toggle: (clip: AudioClip) => void;
}

interface EvidenceContextValue {
  urls: EvidenceUrls;
  audio: EvidenceAudio;
}

const EvidenceContext = createContext<EvidenceContextValue | null>(null);

/** How often playback is checked against the end of the turn (`timeupdate` is too coarse). */
export const CLIP_CHECK_INTERVAL_MS = 100;

/**
 * Supplies the evidence file URLs and the page's single audio element to the evidence
 * components, so two turns can never play at once. Mount one per page.
 */
export function EvidenceProvider({ urls, children }: { urls: EvidenceUrls; children: ReactNode }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const loadedUrlRef = useRef<string | null>(null);
  const cancelRef = useRef<(() => void) | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [failedId, setFailedId] = useState<string | null>(null);
  const [unavailableId, setUnavailableId] = useState<string | null>(null);

  const halt = useCallback(() => {
    cancelRef.current?.();
    cancelRef.current = null;
    audioRef.current?.pause();
    setPlayingId(null);
  }, []);

  useEffect(
    () => () => {
      cancelRef.current?.();
      audioRef.current?.pause();
    },
    [],
  );

  const toggle = useCallback(
    (clip: AudioClip) => {
      if (playingId === clip.id) {
        halt();
        return;
      }
      halt();
      setFailedId(null);
      setUnavailableId(null);
      audioRef.current ??= new Audio();
      const audio = audioRef.current;
      // A previous load that failed or never produced metadata must not be reused as is.
      if (audio.error !== null || audio.readyState === 0) loadedUrlRef.current = null;
      audio.preload = 'metadata';

      let active = true;
      // The end is only watched once the seek to the start happened.
      let seeked = false;
      const timer = setInterval(checkEnd, CLIP_CHECK_INTERVAL_MS);
      const cleanup = () => {
        active = false;
        clearInterval(timer);
        audio.removeEventListener('loadedmetadata', onMetadata);
        audio.removeEventListener('timeupdate', checkEnd);
        audio.removeEventListener('error', fail);
        audio.removeEventListener('ended', finish);
        audio.removeEventListener('pause', onPause);
      };
      function finish() {
        if (!active) return;
        cleanup();
        cancelRef.current = null;
        audio.pause();
        setPlayingId(null);
      }
      // Pausing the previous clip queues a `pause` event that can arrive after this clip started;
      // only a pause that leaves the element paused (media keys, an interruption) ends playback.
      function onPause() {
        if (audio.paused) finish();
      }
      function fail() {
        if (!active) return;
        finish();
        loadedUrlRef.current = null;
        setFailedId(clip.id);
      }
      // False when there is nothing to play (the clip is gone or starts after the recording ends).
      function onMetadata() {
        seek();
      }
      function seek(): boolean {
        if (!active) return false;
        audio.removeEventListener('loadedmetadata', onMetadata);
        // Seeking past the end would just end playback with no word. Say it instead.
        if (Number.isFinite(audio.duration) && clip.startMs / 1000 >= audio.duration) {
          finish();
          setUnavailableId(clip.id);
          return false;
        }
        audio.currentTime = clip.startMs / 1000;
        seeked = true;
        return true;
      }
      // `timeupdate` comes from the media clock, so it still fires on time when a background tab
      // throttles the interval.
      function checkEnd() {
        if (seeked && audio.currentTime * 1000 >= clip.endMs) finish();
      }

      cancelRef.current = cleanup;
      setPlayingId(clip.id);
      audio.addEventListener('error', fail);
      audio.addEventListener('ended', finish);
      audio.addEventListener('pause', onPause);
      audio.addEventListener('timeupdate', checkEnd);
      if (loadedUrlRef.current !== clip.url) {
        loadedUrlRef.current = clip.url;
        audio.src = clip.url;
      }
      // Already-loaded metadata decides now: an unavailable clip must not be played at all.
      if (audio.readyState >= 1) {
        if (!seek()) return;
      } else audio.addEventListener('loadedmetadata', onMetadata);
      // Called inside the click, as iOS Safari requires; the seek follows when it can.
      audio.play().catch((error: unknown) => {
        // A newer clip interrupting this one rejects with AbortError; that is not a failure.
        if (error instanceof DOMException && error.name === 'AbortError') return;
        fail();
      });
    },
    [halt, playingId],
  );

  const value = useMemo<EvidenceContextValue>(
    () => ({ urls, audio: { playingId, failedId, unavailableId, toggle } }),
    [urls, playingId, failedId, unavailableId, toggle],
  );
  return <EvidenceContext.Provider value={value}>{children}</EvidenceContext.Provider>;
}

function useEvidenceContext(): EvidenceContextValue {
  const value = useContext(EvidenceContext);
  if (value === null) throw new Error('Evidence components need an <EvidenceProvider>.');
  return value;
}

export function useEvidenceUrls(): EvidenceUrls {
  return useEvidenceContext().urls;
}

export function useEvidenceAudio(): EvidenceAudio {
  return useEvidenceContext().audio;
}
