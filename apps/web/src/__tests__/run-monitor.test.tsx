import type { RunSnapshot, RunStepSnapshot } from '@evidomo/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useRunMonitor } from '../lib/use-run-monitor';
import RunPage from '../pages/runs/[runId]';
import { FakeEventSource } from './fake-event-source';
import { setRoute } from './router-mock';
import { jsonResponse, meSignedIn, mockFetch, renderPage } from './test-utils';

vi.mock('next/router', () => import('./router-mock'));

const RUN_ID = '0b9f7c1e-5d2a-4e8b-9c3d-1a2b3c4d5e6f';
const PROJECT_ID = '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
const RUN_PATH = `/api/runs/${RUN_ID}`;
const AT = '2026-10-29T10:00:00.000Z';

function step(overrides: Partial<RunStepSnapshot> & { stepId: string }): RunStepSnapshot {
  return {
    agent: 'extractor',
    gateAfter: null,
    status: 'pending',
    attempt: null,
    attempts: 0,
    executions: 0,
    totalExecutions: 0,
    costUsd: '0',
    startedAt: null,
    finishedAt: null,
    gateReleasedAt: null,
    error: null,
    ...overrides,
  };
}

function snapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    id: RUN_ID,
    projectId: PROJECT_ID,
    status: 'running',
    serviceId: 'listing-pack',
    serviceVersion: 1,
    marketProfileId: 'de',
    marketProfileVersion: 1,
    outputLanguage: 'de',
    gate: null,
    currentStepId: 'intake',
    failureReason: null,
    createdAt: AT,
    startedAt: AT,
    finishedAt: null,
    updatedAt: AT,
    costUsd: '0.5',
    lastEventSeq: 4,
    costCapUsd: '2',
    maxExecutionsPerAttempt: 2,
    steps: [
      step({
        stepId: 'intake',
        status: 'completed',
        attempt: 1,
        attempts: 1,
        executions: 1,
        totalExecutions: 1,
        costUsd: '0.5',
        startedAt: AT,
        finishedAt: '2026-10-29T10:00:42.000Z',
      }),
      step({ stepId: 'extract' }),
      step({ stepId: 'write' }),
    ],
    export: null,
    ...overrides,
  };
}

let seq = 4;
function event(type: string, payload: unknown, at = '2026-10-29T10:01:00.000Z') {
  seq += 1;
  return { seq, type, payload, occurredAt: at };
}

function mockRun(initial: RunSnapshot, later: () => RunSnapshot = () => initial) {
  let calls = 0;
  mockFetch({
    'GET /api/auth/me': meSignedIn,
    [`GET ${RUN_PATH}`]: () => {
      calls += 1;
      return jsonResponse(200, calls === 1 ? initial : later());
    },
  });
  return () => calls;
}

async function renderMonitor() {
  const view = renderPage(RunPage);
  await screen.findByRole('heading', { level: 1, name: 'Run' });
  await waitFor(() => {
    expect(FakeEventSource.instances).toHaveLength(1);
  });
  return view;
}

function stepItem(name: string): HTMLElement {
  const item = screen
    .getAllByRole('listitem')
    .find((li) => within(li).queryByText(name, { exact: true }) !== null);
  if (item === undefined) throw new Error(`No step ${name}`);
  return item;
}

describe('run monitor', () => {
  beforeEach(() => {
    seq = 4;
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    setRoute(`/runs/${RUN_ID}`);
    // The router mock exposes the dynamic segment through `query`.
    setRoute(`/runs/${RUN_ID}?runId=${RUN_ID}`);
  });

  it('renders the snapshot and opens the stream at its cursor', async () => {
    mockRun(snapshot());
    await renderMonitor();

    expect(FakeEventSource.last.url).toBe(`${RUN_PATH}/events?after=4`);
    expect(within(stepItem('intake')).getByText('Completed')).toBeDefined();
    expect(within(stepItem('intake')).getByText('42 s')).toBeDefined();
    expect(within(stepItem('extract')).getByText('Pending')).toBeDefined();
    const bar = screen.getByRole('progressbar', { name: 'Run cost against the cap' });
    expect(bar.getAttribute('value')).toBe('25');
    expect(
      within(screen.getByRole('region', { name: 'Cost' })).getByText(/\$0\.5000/),
    ).toBeDefined();
  });

  it('updates step status and attempts from step events', async () => {
    mockRun(snapshot());
    await renderMonitor();
    const source = FakeEventSource.last;
    source.open();

    act(() => {
      source.emit(event('step_started', { stepId: 'extract', attempt: 1, execution: 1 }));
    });
    await waitFor(() => {
      expect(within(stepItem('extract')).getByText('Running')).toBeDefined();
    });

    act(() => {
      source.emit(
        event('step_failed', {
          stepId: 'extract',
          attempt: 1,
          execution: 1,
          reason: 'Step "extract" timed out after 600 s',
          willRetry: true,
          stepCostUsd: '0.1',
          runCostUsd: '0.6',
        }),
      );
    });
    await waitFor(() => {
      expect(within(stepItem('extract')).getByText('Queued')).toBeDefined();
    });
    expect(within(stepItem('extract')).getByText(/timed out after 600 s/)).toBeDefined();

    act(() => {
      source.emit(event('step_started', { stepId: 'extract', attempt: 1, execution: 2 }));
      source.emit(
        event('step_completed', {
          stepId: 'extract',
          attempt: 1,
          execution: 2,
          artifactIds: [],
          stepCostUsd: '0.3',
          runCostUsd: '0.8',
        }),
      );
    });
    await waitFor(() => {
      expect(within(stepItem('extract')).getByText('Completed')).toBeDefined();
    });
    expect(within(stepItem('extract')).queryByText(/timed out/)).toBeNull();
  });

  it('updates cost from usage_recorded, idempotently, without touching the live region', async () => {
    mockRun(snapshot());
    await renderMonitor();
    const source = FakeEventSource.last;
    const live = document.querySelector('[aria-live="polite"]');
    const before = live?.textContent;

    const usage = event('usage_recorded', {
      stepId: 'intake',
      stepCostUsd: '0.9',
      runCostUsd: '1',
    });
    act(() => {
      source.emit(usage);
      source.emit(usage);
    });

    await waitFor(() => {
      expect(
        within(screen.getByRole('region', { name: 'Cost' })).getByText(/\$1\.0000/),
      ).toBeDefined();
    });
    expect(within(stepItem('intake')).getByText('$0.9000')).toBeDefined();
    expect(screen.getByRole('progressbar').getAttribute('value')).toBe('50');
    expect(live?.textContent).toBe(before);
  });

  it('shows the gate state without a dead link, and the failure reason', async () => {
    mockRun(snapshot());
    await renderMonitor();
    const source = FakeEventSource.last;

    act(() => {
      source.emit(
        event('run_status_changed', {
          from: 'running',
          to: 'awaiting_gate',
          gate: 'fact_conflicts',
        }),
      );
    });
    const region = await screen.findByRole('region', { name: 'Review needed' });
    expect(within(region).getByText('Gate 1: resolve fact conflicts')).toBeDefined();
    expect(
      within(region).getByRole('link', { name: 'Review conflicts' }).getAttribute('href'),
    ).toBe(`/runs/${RUN_ID}/conflicts`);
    expect(within(region).queryByRole('button')).toBeNull();

    act(() => {
      source.emit(
        event('run_status_changed', {
          from: 'awaiting_gate',
          to: 'failed',
          reason: 'Budget exceeded',
        }),
      );
    });
    expect((await screen.findByRole('alert')).textContent).toContain('Budget exceeded');
    expect(screen.queryByRole('region', { name: 'Review needed' })).toBeNull();
  });

  it('links the Gate 2 pause to the review page', async () => {
    mockRun(snapshot({ status: 'awaiting_gate', gate: 'claim_audit', lastEventSeq: 3 }));
    await renderMonitor();

    const region = await screen.findByRole('region', { name: 'Review needed' });
    expect(within(region).getByText('Gate 2: review the pack')).toBeDefined();
    expect(within(region).getByRole('link', { name: 'Review the pack' }).getAttribute('href')).toBe(
      `/runs/${RUN_ID}/review`,
    );
    expect(screen.queryByText('Review screen coming soon')).toBeNull();
  });

  it('refetches the snapshot on resync', async () => {
    const calls = mockRun(snapshot(), () => snapshot({ lastEventSeq: 2, costUsd: '0.25' }));
    await renderMonitor();

    act(() => {
      FakeEventSource.last.emitNamed('resync', { lastEventSeq: 2 });
    });
    await waitFor(() => {
      expect(calls()).toBe(2);
    });
    // The server's snapshot wins even though its cursor is lower than ours.
    await screen.findByText(/\$0\.2500/);
  });

  it('refetches on an unparsable or unknown event', async () => {
    const calls = mockRun(snapshot());
    await renderMonitor();

    act(() => {
      FakeEventSource.last.emitRaw('not json');
    });
    await waitFor(() => {
      expect(calls()).toBe(2);
    });
    act(() => {
      FakeEventSource.last.emit(event('something_new', { a: 1 }));
    });
    await waitFor(() => {
      expect(calls()).toBe(3);
    });
  });

  it('closes the stream on end and shows the final snapshot with the export', async () => {
    const calls = mockRun(snapshot(), () =>
      snapshot({
        status: 'completed',
        finishedAt: AT,
        lastEventSeq: 9,
        export: { manifestArtifactId: PROJECT_ID, readyToPublish: true, fileCount: 7 },
      }),
    );
    await renderMonitor();
    const source = FakeEventSource.last;

    act(() => {
      source.emitNamed('end', { status: 'completed', lastEventSeq: 9 });
    });
    expect(source.readyState).toBe(FakeEventSource.CLOSED);
    await waitFor(() => {
      expect(calls()).toBe(2);
    });
    expect(await screen.findByText(/Export ready: 7 files/)).toBeDefined();
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it('shows a reconnecting state, then recovers', async () => {
    mockRun(snapshot());
    await renderMonitor();
    const source = FakeEventSource.last;
    source.open();

    act(() => {
      source.drop();
    });
    // A short drop stays quiet; only one that lasts is announced.
    expect(screen.queryByText(/Reconnecting/)).toBeNull();
    expect((await screen.findByRole('status', {}, { timeout: 3000 })).textContent).toContain(
      'Reconnecting',
    );
    expect(screen.getByRole('heading', { name: 'Steps' })).toBeDefined();

    act(() => {
      source.open();
    });
    await waitFor(() => {
      expect(screen.queryByText(/Reconnecting/)).toBeNull();
    });
  });

  it('shows a calm message when the browser gives up, and resumes on request', async () => {
    mockRun(snapshot());
    await renderMonitor();

    act(() => {
      FakeEventSource.last.fail();
    });
    expect((await screen.findByRole('alert')).textContent).toContain('Live updates are paused');

    act(() => {
      screen.getByRole('button', { name: 'Resume live updates' }).click();
    });
    await waitFor(() => {
      expect(FakeEventSource.instances).toHaveLength(2);
    });
  });

  it('does not open a stream for a finished run', async () => {
    mockRun(snapshot({ status: 'completed', finishedAt: AT }));
    renderPage(RunPage);
    await screen.findByRole('heading', { level: 1, name: 'Run' });
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it('shows not found for a 404 and an invalid id', async () => {
    mockFetch({
      'GET /api/auth/me': meSignedIn,
      [`GET ${RUN_PATH}`]: () => jsonResponse(404, { error: 'not_found' }),
    });
    renderPage(RunPage);
    expect((await screen.findByRole('alert')).textContent).toContain('This run was not found');
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it('rejects a malformed run id without calling the API', async () => {
    setRoute('/runs/nope?runId=nope');
    const fetchMock = mockFetch({ 'GET /api/auth/me': meSignedIn });
    renderPage(RunPage);
    expect((await screen.findByRole('alert')).textContent).toContain('This run was not found');
    expect(fetchMock).not.toHaveBeenCalledWith(RUN_PATH, expect.anything());
  });

  it('offers a login link when the session expired', async () => {
    mockFetch({
      'GET /api/auth/me': meSignedIn,
      [`GET ${RUN_PATH}`]: () => jsonResponse(401, { error: 'unauthenticated' }),
    });
    renderPage(RunPage);
    const link = await screen.findByRole('link', { name: 'Log in again' });
    expect(link.getAttribute('href')).toBe(`/login?next=${encodeURIComponent(`/runs/${RUN_ID}`)}`);
  });
  it('does not announce a failure twice: the alert carries it, the live region stays empty', async () => {
    mockRun(snapshot({ status: 'failed', failureReason: 'Budget exceeded', finishedAt: AT }));
    renderPage(RunPage);
    expect((await screen.findByRole('alert')).textContent).toContain('Budget exceeded');
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe('');
  });

  it('notices a resume of a failed run and reopens the stream at the new cursor', async () => {
    const failed = snapshot({
      status: 'failed',
      failureReason: 'Boom',
      finishedAt: AT,
      lastEventSeq: 8,
    });
    const resumed = snapshot({ status: 'running', lastEventSeq: 12 });
    const calls = mockRun(failed, () => resumed);
    const view = renderPage(RunPage);
    await screen.findByRole('alert');
    expect(FakeEventSource.instances).toHaveLength(0);

    await act(async () => {
      await view.queryClient.invalidateQueries({ queryKey: ['runs', RUN_ID] });
    });
    expect(calls()).toBe(2);
    await waitFor(() => {
      expect(FakeEventSource.instances).toHaveLength(1);
    });
    expect(FakeEventSource.last.url).toBe(`${RUN_PATH}/events?after=12`);
  });

  it('refetches on a gap in the sequence and shows the gate the missed events opened', async () => {
    const calls = mockRun(snapshot(), () =>
      snapshot({ status: 'awaiting_gate', gate: 'claim_audit', lastEventSeq: 7 }),
    );
    await renderMonitor();

    act(() => {
      FakeEventSource.last.emit({
        seq: 7,
        type: 'usage_recorded',
        payload: { stepId: 'intake', stepCostUsd: '0.6', runCostUsd: '0.7' },
        occurredAt: AT,
      });
    });
    await waitFor(() => {
      expect(calls()).toBe(2);
    });
    expect(await screen.findByText('Gate 2: review the pack')).toBeDefined();
  });

  it('never lets an older snapshot overwrite newer events, and refetches once more', async () => {
    let calls = 0;
    let releaseStale: () => void = () => undefined;
    const stale = new Promise<void>((resolve) => {
      releaseStale = resolve;
    });
    mockFetch({
      'GET /api/auth/me': meSignedIn,
      [`GET ${RUN_PATH}`]: async () => {
        calls += 1;
        if (calls === 1) return jsonResponse(200, snapshot());
        if (calls === 2) {
          await stale;
          return jsonResponse(200, snapshot());
        }
        return jsonResponse(200, snapshot({ lastEventSeq: 5, costUsd: '1' }));
      },
    });
    await renderMonitor();
    const source = FakeEventSource.last;

    act(() => {
      source.emit(event('something_new', { a: 1 }));
    });
    await waitFor(() => {
      expect(calls).toBe(2);
    });
    // A newer known event lands while the older snapshot request is still out.
    act(() => {
      source.emit({
        seq: 6,
        type: 'usage_recorded',
        payload: { stepId: 'intake', stepCostUsd: '0.9', runCostUsd: '1.5' },
        occurredAt: AT,
      });
    });
    releaseStale();
    await waitFor(() => {
      expect(calls).toBe(3);
    });
    // Seq 6 was a gap against the cached cursor, so it only asked for a snapshot; the stale
    // response did not roll anything back and the trailing one is what is shown.
    await within(screen.getByRole('region', { name: 'Cost' })).findByText(/\$1\.0000/);
  });

  it('keeps asking for a snapshot after a failed resync until one lands', async () => {
    let calls = 0;
    mockFetch({
      'GET /api/auth/me': meSignedIn,
      [`GET ${RUN_PATH}`]: () => {
        calls += 1;
        if (calls === 1) return jsonResponse(200, snapshot());
        if (calls === 2) return jsonResponse(500, { error: 'internal_error' });
        return jsonResponse(200, snapshot({ lastEventSeq: 3, costUsd: '0.25' }));
      },
    });
    await renderMonitor();

    act(() => {
      FakeEventSource.last.emitNamed('resync', { lastEventSeq: 2 });
    });
    await screen.findByText(/Could not refresh the run just now/);

    act(() => {
      FakeEventSource.last.emit({
        seq: 3,
        type: 'usage_recorded',
        payload: { stepId: 'intake', stepCostUsd: '0.25', runCostUsd: '0.25' },
        occurredAt: AT,
      });
    });
    await waitFor(() => {
      expect(calls).toBe(3);
    });
    await within(screen.getByRole('region', { name: 'Cost' })).findByText(/\$0\.2500/);
  });

  it('applies end immediately and offers a retry when the final refresh fails', async () => {
    let calls = 0;
    mockFetch({
      'GET /api/auth/me': meSignedIn,
      [`GET ${RUN_PATH}`]: () => {
        calls += 1;
        return calls === 1
          ? jsonResponse(200, snapshot())
          : jsonResponse(500, { error: 'internal_error' });
      },
    });
    await renderMonitor();

    act(() => {
      FakeEventSource.last.emitNamed('end', { status: 'completed', lastEventSeq: 9 });
    });
    expect(await screen.findByText('Run completed.')).toBeDefined();
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeDefined();
  });

  it('shows the login link when the retry finds the session expired', async () => {
    let calls = 0;
    mockFetch({
      'GET /api/auth/me': meSignedIn,
      [`GET ${RUN_PATH}`]: () => {
        calls += 1;
        return calls === 1
          ? jsonResponse(200, snapshot())
          : jsonResponse(401, { error: 'unauthenticated' });
      },
    });
    await renderMonitor();
    act(() => {
      FakeEventSource.last.fail();
    });
    act(() => {
      screen.getByRole('button', { name: 'Resume live updates' }).click();
    });
    expect(await screen.findByRole('link', { name: 'Log in again' })).toBeDefined();
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it('closes the stream on unmount', async () => {
    mockRun(snapshot());
    const view = await renderMonitor();
    const source = FakeEventSource.last;
    view.unmount();
    expect(source.readyState).toBe(FakeEventSource.CLOSED);
  });
  describe('without disclosed costs (production)', () => {
    function hiddenSnapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
      const { costUsd: _cost, costCapUsd: _cap, steps, ...rest } = snapshot(overrides);
      return { ...rest, steps: steps.map(({ costUsd: _stepCost, ...kept }) => kept) };
    }

    function expectNoCostUi(): void {
      expect(screen.queryByRole('region', { name: 'Cost' })).toBeNull();
      expect(screen.queryByRole('progressbar')).toBeNull();
      expect(screen.queryByText('Cost', { exact: true })).toBeNull();
      expect(screen.queryByText(/\$\d/)).toBeNull();
      expect(screen.queryByText(/cost cap/)).toBeNull();
    }

    it('shows no cost card, step cost, or cap message', async () => {
      mockRun(hiddenSnapshot());
      await renderMonitor();
      expect(within(stepItem('intake')).getByText('Completed')).toBeDefined();
      expectNoCostUi();
    });

    it('applies withheld and cost-less events without refetching the snapshot', async () => {
      const calls = mockRun(hiddenSnapshot());
      await renderMonitor();
      const source = FakeEventSource.last;
      const reason = 'Step "extract" failed after 1 execution: This run reached its budget limit.';

      act(() => {
        source.emit(event('step_started', { stepId: 'extract', attempt: 1, execution: 1 }));
        source.emit(event('withheld', {}));
        source.emit(event('withheld', {}));
        source.emit(
          event('step_failed', {
            stepId: 'extract',
            attempt: 1,
            execution: 1,
            reason,
            willRetry: false,
          }),
        );
        source.emit(event('run_status_changed', { from: 'running', to: 'failed', reason }));
      });

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain(reason);
      expect(within(stepItem('extract')).getByText('Failed')).toBeDefined();
      // A withheld message that did not move the cursor would make the next event a gap, and a
      // gap refetches; wait past any refetch that could still be scheduled.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(calls()).toBe(1);
      expectNoCostUi();
    });
  });
});

describe('useRunMonitor lifecycle', () => {
  it('closes the stream of the old run when the run ID changes', async () => {
    const OTHER_ID = '1c9f7c1e-5d2a-4e8b-9c3d-1a2b3c4d5e6f';
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    mockFetch({
      [`GET ${RUN_PATH}`]: () => jsonResponse(200, snapshot()),
      [`GET /api/runs/${OTHER_ID}`]: () => jsonResponse(200, snapshot({ id: OTHER_ID })),
    });
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    // The page remounts the hook per run (`key={runId}`), which is what this models.
    const first = renderHook(() => useRunMonitor(RUN_ID), { wrapper });
    await waitFor(() => {
      expect(FakeEventSource.instances).toHaveLength(1);
    });
    const firstSource = FakeEventSource.last;
    first.unmount();
    expect(firstSource.readyState).toBe(FakeEventSource.CLOSED);

    renderHook(() => useRunMonitor(OTHER_ID), { wrapper });
    await waitFor(() => {
      expect(FakeEventSource.instances).toHaveLength(2);
    });
    expect(FakeEventSource.last.url).toContain(OTHER_ID);
  });
});
