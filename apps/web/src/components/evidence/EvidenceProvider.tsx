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
        audio.removeEventListener('loadedmetadata', seek);
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
      function seek() {
        if (!active) return;
        audio.removeEventListener('loadedmetadata', seek);
        audio.currentTime = clip.startMs / 1000;
        seeked = true;
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
      if (audio.readyState >= 1) seek();
      else audio.addEventListener('loadedmetadata', seek);
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
    () => ({ urls, audio: { playingId, failedId, toggle } }),
    [urls, playingId, failedId, toggle],
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
