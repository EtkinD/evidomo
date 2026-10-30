import {
  demoRunEventsUrl,
  RUN_STREAM_END_EVENT,
  RUN_STREAM_RESYNC_EVENT,
  runSnapshotSchema,
  runStreamEventSchema,
  type RunSnapshot,
} from '@evidomo/shared';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiJson, isClientError } from './api';
import { applyReplayEvent, replayStart } from './run-monitor';
import { demoRunSource, runScopedKey } from './run-source';
import { RECONNECT_NOTICE_DELAY_MS, type RunMonitor, type StreamState } from './use-run-monitor';

export interface DemoReplay {
  monitor: RunMonitor;
  /** Starts again from the first event, whatever state the replay is in. */
  restart: () => void;
  /** The replay reached its end (the stream said so). */
  finished: boolean;
}

function rawSeq(data: unknown): number {
  if (typeof data === 'object' && data !== null && 'seq' in data) {
    const { seq } = data;
    if (typeof seq === 'number' && Number.isSafeInteger(seq)) return seq;
  }
  return 0;
}

/**
 * The run monitor's data for a demo: the finished run's snapshot is read once, taken back to
 * "nothing started", and the demo stream's stored events move it forward at their original pace
 * (`speed` multiplies it). Unlike the live monitor it never refetches the snapshot mid-replay,
 * which would show the end result at once. Changing `speed` reconnects from the last event seen;
 * after the replay ended it only applies to the next replay. Mount it with `key={runId}`.
 */
export function useDemoReplay(runId: string, speed: number): DemoReplay {
  const finalQuery = useQuery({
    queryKey: runScopedKey(demoRunSource, runId),
    queryFn: ({ signal }) =>
      apiJson(demoRunSource.snapshotUrl(runId), runSnapshotSchema, { signal }),
    retry: (failureCount, error) => !isClientError(error) && failureCount < 2,
  });
  const final = finalQuery.data;
  const finalRef = useRef<RunSnapshot | undefined>(undefined);
  // Synced in an effect (declared before the ones that read it), not during render.
  useEffect(() => {
    finalRef.current = final;
  }, [final]);

  const [replay, setReplay] = useState<RunSnapshot | null>(null);
  const [streamState, setStreamState] = useState<StreamState>('connecting');
  const [finished, setFinished] = useState(false);
  const [connectNonce, setConnectNonce] = useState(0);
  const lastSeqRef = useRef(0);
  const endedRef = useRef(false);
  const ready = final !== undefined;

  // The first snapshot arms the replay; later refetches (window focus) must not rewind it.
  const armedRef = useRef(false);
  useEffect(() => {
    if (final === undefined || armedRef.current) return;
    armedRef.current = true;
    setReplay(replayStart(final));
  }, [final]);

  const restart = useCallback(() => {
    const current = finalRef.current;
    if (current === undefined) return;
    endedRef.current = false;
    lastSeqRef.current = 0;
    setFinished(false);
    setStreamState('connecting');
    setReplay(replayStart(current));
    setConnectNonce((nonce) => nonce + 1);
  }, []);

  useEffect(() => {
    if (!ready || endedRef.current) return;
    const after = lastSeqRef.current;
    const source = new EventSource(
      demoRunEventsUrl(runId, { ...(after > 0 ? { after } : {}), speed }),
    );
    let noticeTimer: ReturnType<typeof setTimeout> | null = null;
    const clearNotice = () => {
      if (noticeTimer !== null) clearTimeout(noticeTimer);
      noticeTimer = null;
    };

    source.onopen = () => {
      clearNotice();
      setStreamState('live');
    };
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) {
        clearNotice();
        setStreamState('unavailable');
      } else if (noticeTimer === null) {
        noticeTimer = setTimeout(() => {
          setStreamState('reconnecting');
        }, RECONNECT_NOTICE_DELAY_MS);
      }
    };
    source.onmessage = (message: MessageEvent<unknown>) => {
      let data: unknown;
      try {
        data = JSON.parse(String(message.data));
      } catch {
        return;
      }
      const parsed = runStreamEventSchema.safeParse(data);
      if (!parsed.success) {
        // An event type this client does not know: only the cursor moves.
        const seq = rawSeq(data);
        lastSeqRef.current = Math.max(lastSeqRef.current, seq);
        setReplay((prev) =>
          prev === null ? prev : { ...prev, lastEventSeq: Math.max(prev.lastEventSeq, seq) },
        );
        return;
      }
      const event = parsed.data;
      lastSeqRef.current = Math.max(lastSeqRef.current, event.seq);
      setReplay((prev) => {
        const target = finalRef.current;
        return prev === null || target === undefined ? prev : applyReplayEvent(target, prev, event);
      });
    };
    source.addEventListener(RUN_STREAM_RESYNC_EVENT, () => {
      // The cursor was beyond the stored run: play it from the start instead.
      source.close();
      clearNotice();
      restart();
    });
    source.addEventListener(RUN_STREAM_END_EVENT, () => {
      clearNotice();
      source.close();
      endedRef.current = true;
      setStreamState('idle');
      setFinished(true);
      // The run is over: show it as stored (the export summary included).
      setReplay(finalRef.current ?? null);
    });

    return () => {
      clearNotice();
      source.close();
    };
  }, [runId, ready, speed, connectNonce, restart]);

  const retryStream = useCallback(() => {
    setStreamState('connecting');
    setConnectNonce((nonce) => nonce + 1);
  }, []);

  return {
    monitor: {
      snapshot: {
        data: replay ?? undefined,
        error: finalQuery.error,
        isError: finalQuery.isError,
        refetch: finalQuery.refetch,
      },
      streamState,
      refreshFailed: false,
      sessionExpired: false,
      retryStream,
    },
    restart,
    finished,
  };
}
