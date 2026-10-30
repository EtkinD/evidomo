import {
  isRunStreamTerminal,
  RUN_STREAM_END_EVENT,
  RUN_STREAM_RESYNC_EVENT,
  runEventsUrl,
  runSnapshotSchema,
  runStreamEndSchema,
  runStreamEventSchema,
  runUrl,
  type RunSnapshot,
} from '@evidomo/shared';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiRequestError, apiJson, isClientError } from './api';
import { applyRunEnd, applyRunEvent, eventNeedsSnapshot, runQueryKey } from './run-monitor';

/**
 * - `connecting`: the first connection is being opened.
 * - `live`: events are flowing.
 * - `reconnecting`: the connection stayed down past `RECONNECT_NOTICE_DELAY_MS`; `EventSource`
 *   keeps retrying by itself with `Last-Event-ID`.
 * - `unavailable`: the browser gave up (a non-200 answer such as 429 `too_many_streams`).
 * - `idle`: no stream is needed (the run is finished) or it ended normally.
 */
export type StreamState = 'connecting' | 'live' | 'reconnecting' | 'unavailable' | 'idle';

/** Short drops (the hourly lifetime reconnect, a proxy restart) should not alarm anyone. */
export const RECONNECT_NOTICE_DELAY_MS = 1500;

export interface RunMonitor {
  /** The part of the query result the screens read (the demo replay builds its own). */
  snapshot: Pick<UseQueryResult<RunSnapshot>, 'data' | 'error' | 'isError' | 'refetch'>;
  streamState: StreamState;
  /** The last snapshot refresh failed; what is shown may lag until the next event or retry. */
  refreshFailed: boolean;
  /** The last refresh was answered 401. */
  sessionExpired: boolean;
  retryStream: () => void;
}

const isTerminalSnapshot = (data: RunSnapshot | undefined): boolean =>
  data !== undefined && isRunStreamTerminal(data.status);

/** The `seq` of a message the schema rejected, when it still has one. */
function rawSeq(data: unknown): number {
  if (typeof data === 'object' && data !== null && 'seq' in data) {
    const { seq } = data;
    if (typeof seq === 'number' && Number.isSafeInteger(seq)) return seq;
  }
  return 0;
}

/**
 * Server state of the run monitor: the snapshot lives in the TanStack Query cache and stream
 * events are applied to it in place. Nothing here blocks rendering; the page shows the snapshot
 * as soon as it arrives and the stream state beside it. Mount it with `key={runId}`.
 */
export function useRunMonitor(runId: string | null): RunMonitor {
  const queryClient = useQueryClient();
  const snapshot = useQuery({
    queryKey: runQueryKey(runId ?? ''),
    enabled: runId !== null,
    queryFn: ({ signal }) => apiJson(runUrl(runId ?? ''), runSnapshotSchema, { signal }),
    // Events keep a live run fresh, so a refetch could only race them. A finished run has no
    // stream: it is re-read on mount and focus, which also notices a resume done elsewhere.
    staleTime: (query) => (isTerminalSnapshot(query.state.data) ? 0 : Infinity),
    refetchOnWindowFocus: (query) => isTerminalSnapshot(query.state.data),
    refetchOnReconnect: false,
    retry: (failureCount, error) => !isClientError(error) && failureCount < 2,
  });

  const [streamState, setStreamState] = useState<StreamState>('connecting');
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [connectNonce, setConnectNonce] = useState(0);
  const sourceRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Highest event seq seen on the wire; a snapshot older than it cannot be the whole truth.
  const maxSeenSeqRef = useRef(0);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const joinedRef = useRef(false);
  const pendingTrustRef = useRef(false);
  // After a `resync` the cache cursor may be ahead of the server until a snapshot lands.
  const invalidRef = useRef(false);
  const sessionExpiredRef = useRef(false);

  const hasSnapshot = snapshot.data !== undefined;
  const terminal = isTerminalSnapshot(snapshot.data);

  const refresh = useCallback(
    (options: { trustServer: boolean }): Promise<void> => {
      if (runId === null) return Promise.resolve();
      // One fetch at a time: a burst of unknown events must not become a burst of requests. A
      // caller that joins an older request gets one trailing fetch, since that response may
      // predate the reason it asked.
      if (inFlightRef.current !== null) {
        joinedRef.current = true;
        pendingTrustRef.current ||= options.trustServer;
        return inFlightRef.current;
      }
      const key = runQueryKey(runId);
      const run = async (): Promise<void> => {
        let trust = options.trustServer;
        for (let pass = 0; pass < 2; pass += 1) {
          joinedRef.current = false;
          const fresh = await apiJson(runUrl(runId), runSnapshotSchema);
          queryClient.setQueryData<RunSnapshot>(key, (current) =>
            // A snapshot read before events we already applied would roll the view back; only a
            // trusted one (the server says our cursor is wrong) overrides newer local state.
            !trust && current && current.lastEventSeq > fresh.lastEventSeq ? current : fresh,
          );
          if (trust) {
            invalidRef.current = false;
            maxSeenSeqRef.current = fresh.lastEventSeq;
          }
          setRefreshFailed(false);
          sessionExpiredRef.current = false;
          setSessionExpired(false);
          trust = pendingTrustRef.current;
          pendingTrustRef.current = false;
          if (!joinedRef.current && fresh.lastEventSeq >= maxSeenSeqRef.current) return;
        }
      };
      const request = run()
        .catch((error: unknown) => {
          setRefreshFailed(true);
          sessionExpiredRef.current = error instanceof ApiRequestError && error.status === 401;
          setSessionExpired(sessionExpiredRef.current);
        })
        .finally(() => {
          inFlightRef.current = null;
          pendingTrustRef.current = false;
        });
      inFlightRef.current = request;
      return request;
    },
    [queryClient, runId],
  );

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
  }, []);

  const closeSource = useCallback(() => {
    clearReconnectTimer();
    sourceRef.current?.close();
    sourceRef.current = null;
  }, [clearReconnectTimer]);

  useEffect(() => {
    if (runId === null || !hasSnapshot || terminal) return;
    // Keep an open stream through the terminal transition: `end` arrives after the last events.
    if (sourceRef.current !== null) return;
    const current = queryClient.getQueryData<RunSnapshot>(runQueryKey(runId));
    if (current === undefined) return;

    const key = runQueryKey(runId);
    const source = new EventSource(runEventsUrl(runId, current.lastEventSeq));
    sourceRef.current = source;
    source.onopen = () => {
      clearReconnectTimer();
      setStreamState('live');
    };
    source.onerror = () => {
      // CLOSED means the browser will not retry (a non-200 answer such as 429, or a closed
      // stream); CONNECTING means it is already reconnecting.
      if (source.readyState === EventSource.CLOSED) {
        clearReconnectTimer();
        sourceRef.current = null;
        setStreamState('unavailable');
      } else if (reconnectTimerRef.current === null) {
        reconnectTimerRef.current = setTimeout(() => {
          setStreamState('reconnecting');
        }, RECONNECT_NOTICE_DELAY_MS);
      }
    };
    source.onmessage = (message: MessageEvent<unknown>) => {
      let data: unknown;
      try {
        data = JSON.parse(String(message.data));
      } catch {
        void refresh({ trustServer: invalidRef.current });
        return;
      }
      const parsed = runStreamEventSchema.safeParse(data);
      if (!parsed.success) {
        // An event type this client does not know yet: the snapshot still describes it.
        maxSeenSeqRef.current = Math.max(maxSeenSeqRef.current, rawSeq(data));
        void refresh({ trustServer: invalidRef.current });
        return;
      }
      const event = parsed.data;
      maxSeenSeqRef.current = Math.max(maxSeenSeqRef.current, event.seq);
      if (invalidRef.current) {
        // The cache cursor is not trustworthy until a resync snapshot lands: no event can be
        // applied against it, so each one asks again.
        void refresh({ trustServer: true });
        return;
      }
      const base = queryClient.getQueryData<RunSnapshot>(key);
      if (base === undefined) return;
      const next = applyRunEvent(base, event);
      if (next === null) {
        void refresh({ trustServer: false });
        return;
      }
      if (next !== base) queryClient.setQueryData(key, next);
      if (eventNeedsSnapshot(event)) void refresh({ trustServer: false });
    };
    source.addEventListener(RUN_STREAM_RESYNC_EVENT, () => {
      // The cursor was wrong, whatever the payload says: the server's snapshot is the truth.
      invalidRef.current = true;
      void refresh({ trustServer: true });
    });
    source.addEventListener(RUN_STREAM_END_EVENT, (message) => {
      closeSource();
      setStreamState('idle');
      try {
        const end = runStreamEndSchema.safeParse(JSON.parse(String(message.data)));
        if (end.success) {
          maxSeenSeqRef.current = Math.max(maxSeenSeqRef.current, end.data.lastEventSeq);
          queryClient.setQueryData<RunSnapshot>(key, (cached) =>
            cached === undefined ? cached : applyRunEnd(cached, end.data),
          );
        }
      } catch {
        // An unreadable `end` still means the run is over: the snapshot below tells how.
      }
      // The final snapshot also carries what events do not: the export summary. If it fails,
      // `refreshFailed` offers the retry.
      void refresh({ trustServer: invalidRef.current });
    });
  }, [
    runId,
    hasSnapshot,
    terminal,
    connectNonce,
    queryClient,
    refresh,
    clearReconnectTimer,
    closeSource,
  ]);

  // Close on unmount (the page remounts the hook per run ID).
  useEffect(() => closeSource, [closeSource]);

  const retryStream = useCallback(() => {
    closeSource();
    setStreamState('connecting');
    void refresh({ trustServer: true }).then(() => {
      // An expired session cannot stream either: the login link is the way forward.
      if (sessionExpiredRef.current) return;
      setConnectNonce((nonce) => nonce + 1);
    });
  }, [closeSource, refresh]);

  return {
    snapshot,
    // A run that was already finished when the page opened never connects.
    streamState: terminal && streamState === 'connecting' ? 'idle' : streamState,
    refreshFailed,
    sessionExpired,
    retryStream,
  };
}
