import {
  demoClaimAuditGateResponseSchema,
  demoRunExportResponseSchema,
  runSnapshotSchema,
  type RunSnapshot,
} from '@evidomo/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyReplayEvent, replayStart } from '../lib/run-monitor';
import { stepLabel } from '../lib/step-labels';
import DemoListPage from '../pages/demo/index';
import DemoRunPage from '../pages/demo/runs/[runId]';
import DemoConflictsPage from '../pages/demo/runs/[runId]/conflicts';
import DemoPackPage from '../pages/demo/runs/[runId]/pack';
import DemoReviewPage from '../pages/demo/runs/[runId]/review';
import { allDecided, auditGate, STAGED_ID, TEXT } from './claim-audit-fixtures';
import { FakeEventSource } from './fake-event-source';
import { gateWith, MATERIAL_ID, RUN_ID } from './gate-fixtures';
import { setRoute } from './router-mock';
import { jsonResponse, meSignedOut, mockFetch, renderPage, type FetchCall } from './test-utils';

vi.mock('next/router', () => import('./router-mock'));

const AT = '2026-10-29T10:00:00.000Z';
const DEMO_RUN = `/api/demo/runs/${RUN_ID}`;
const EXPORT_PATH = `${DEMO_RUN}/export`;
const HTML_ID = '11111111-1111-4111-8111-111111111111';
const JSON_ID = '22222222-2222-4222-8222-222222222222';
const SHA = 'a'.repeat(64);

type Handler = (call: FetchCall) => Response | Promise<Response>;

const step = (stepId: string, gateAfter: 'fact_conflicts' | 'claim_audit' | null = null) => ({
  stepId,
  agent: 'extractor',
  gateAfter,
  status: 'completed',
  attempt: 1,
  attempts: 1,
  executions: 1,
  totalExecutions: 1,
  startedAt: AT,
  finishedAt: '2026-10-29T10:00:40.000Z',
  gateReleasedAt: gateAfter === null ? null : '2026-10-29T10:05:00.000Z',
  error: null,
});

/** A finished run, as the demo snapshot serves it (no cost keys: costs are hidden in production). */
function finishedRun(): RunSnapshot {
  return runSnapshotSchema.parse({
    id: RUN_ID,
    projectId: '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f',
    status: 'completed',
    serviceId: 'listing-pack',
    serviceVersion: 1,
    marketProfileId: 'germany',
    marketProfileVersion: 1,
    outputLanguage: 'en',
    gate: null,
    currentStepId: null,
    failureReason: null,
    createdAt: AT,
    startedAt: AT,
    finishedAt: '2026-10-29T10:09:00.000Z',
    updatedAt: '2026-10-29T10:09:00.000Z',
    lastEventSeq: 11,
    maxExecutionsPerAttempt: 2,
    steps: [step('intake'), step('extract', 'fact_conflicts'), step('write')],
    export: {
      manifestArtifactId: '55555555-5555-4555-8555-555555555555',
      readyToPublish: true,
      fileCount: 2,
    },
  });
}

let nextSeq = 0;
function event(type: string, payload: unknown) {
  nextSeq += 1;
  return {
    seq: nextSeq,
    type,
    payload,
    occurredAt: `2026-10-29T10:0${Math.min(nextSeq, 9)}:00.000Z`,
  };
}
const status = (from: string, to: string, gate?: string) =>
  event('run_status_changed', { from, to, ...(gate === undefined ? {} : { gate }) });
const started = (stepId: string) => event('step_started', { stepId, attempt: 1, execution: 1 });
const completed = (stepId: string) =>
  event('step_completed', { stepId, attempt: 1, execution: 1, artifactIds: [] });

const fileEntry = (id: string, role: 'html' | 'portal_fields', name: string, mime: string) => ({
  artifactId: id,
  role,
  fileName: name,
  mimeType: mime,
  sizeBytes: 2048,
  sha256: SHA,
  url: `${EXPORT_PATH}/files/${id}`,
  downloadUrl: `${EXPORT_PATH}/files/${id}?download=1`,
});

const demoManifest = () =>
  demoRunExportResponseSchema.parse({
    runId: RUN_ID,
    manifestArtifactId: '55555555-5555-4555-8555-555555555555',
    approvedPackArtifactId: '66666666-6666-4666-8666-666666666666',
    readyToPublish: true,
    counts: {
      images: 0,
      originals: 0,
      staged: 0,
      blurredImages: 0,
      blurredRegions: 0,
      withheld: 0,
    },
    files: [
      fileEntry(HTML_ID, 'html', 'listing-pack.html', 'text/html'),
      fileEntry(JSON_ID, 'portal_fields', 'portal-fields.json', 'application/json'),
    ],
  });

const demoGate2 = () => demoClaimAuditGateResponseSchema.parse(allDecided({ state: 'released' }));

/** Every request a demo page made: public GETs only, and none to the owner's run routes. */
function expectOnlyPublicReads(fetchMock: ReturnType<typeof mockFetch>): void {
  for (const [input, init] of fetchMock.mock.calls) {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname : '';
    expect(init?.method ?? 'GET').toBe('GET');
    expect(path === '/api/auth/me' || path.startsWith('/api/demo/')).toBe(true);
  }
}

function mockDemo(extra: Record<string, Handler> = {}) {
  return mockFetch({
    'GET /api/auth/me': meSignedOut,
    [`GET ${DEMO_RUN}`]: () => jsonResponse(200, finishedRun()),
    ...extra,
  });
}

function openRoute(path: string): void {
  setRoute(`${path}?runId=${RUN_ID}`);
}

async function renderMonitor() {
  openRoute(`/demo/runs/${RUN_ID}`);
  const view = renderPage(DemoRunPage);
  await screen.findByRole('heading', { level: 1, name: 'Sample run replay' });
  await waitFor(() => {
    expect(FakeEventSource.instances).toHaveLength(1);
  });
  return view;
}

const stepItem = (stepId: string): HTMLElement => {
  const label = stepLabel(stepId).label;
  const item = screen
    .getAllByRole('listitem')
    .find((li) => within(li).queryByText(label, { exact: true }) !== null);
  if (item === undefined) throw new Error(`No step ${label}`);
  return item;
};

beforeEach(() => {
  nextSeq = 0;
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
});

describe('demo list', () => {
  const run = {
    id: RUN_ID,
    title: 'Sample flat on an invented street',
    marketProfileId: 'nl',
    outputLanguage: 'en',
    createdAt: AT,
    finishedAt: '2026-10-29T10:09:00.000Z',
  };

  beforeEach(() => {
    setRoute('/demo');
  });

  it('lists the published runs without a session, each linking to its replay', async () => {
    const fetchMock = mockFetch({
      'GET /api/auth/me': meSignedOut,
      'GET /api/demo/runs': () => jsonResponse(200, { runs: [run] }),
    });
    renderPage(DemoListPage);

    const link = await screen.findByRole('link', { name: run.title });
    expect(link.getAttribute('href')).toBe(`/demo/runs/${RUN_ID}`);
    const card = link.closest('li');
    expect(card?.textContent).toContain('Netherlands');
    expect(card?.textContent).toContain('English');
    expect(card?.textContent).toContain('29 Oct 2026');
    expect(screen.queryByText(/redirect|log in to/i)).toBeNull();
    expectOnlyPublicReads(fetchMock);
  });

  it('explains that no demo is published yet, with no run link', async () => {
    mockFetch({
      'GET /api/auth/me': meSignedOut,
      'GET /api/demo/runs': () => jsonResponse(200, { runs: [] }),
    });
    renderPage(DemoListPage);

    expect(await screen.findByText(/No demo is published yet/)).toBeDefined();
    expect(screen.queryByRole('link', { name: /sample/i })).toBeNull();
  });

  it('asks to wait on a 429 and retries on demand', async () => {
    let calls = 0;
    mockFetch({
      'GET /api/auth/me': meSignedOut,
      'GET /api/demo/runs': () => {
        calls += 1;
        return calls === 1
          ? jsonResponse(429, { error: 'rate_limited' }, { 'Retry-After': '5' })
          : jsonResponse(200, { runs: [run] });
      },
    });
    renderPage(DemoListPage);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Wait a few seconds');
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('link', { name: run.title })).toBeDefined();
  });

  it('offers a retry when the list cannot be loaded', async () => {
    mockFetch({
      'GET /api/auth/me': meSignedOut,
      'GET /api/demo/runs': () => jsonResponse(500, { error: 'internal_error' }),
    });
    renderPage(DemoListPage);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('could not load the demo runs');
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeDefined();
  });
});

describe('demo replay monitor', () => {
  it('starts from nothing started and plays the stored events through the demo stream', async () => {
    const fetchMock = mockDemo();
    await renderMonitor();

    expect(FakeEventSource.last.url).toBe(`${DEMO_RUN}/events?speed=1`);
    expect(within(stepItem('intake')).getByText('Waiting')).toBeDefined();
    expect(screen.getByText('0 of 3 steps done')).toBeDefined();
    expect(screen.queryByRole('link', { name: 'View pack' })).toBeNull();

    const source = FakeEventSource.last;
    act(() => {
      source.open();
      source.emit(status('queued', 'running'));
      source.emit(started('intake'));
    });
    await waitFor(() => {
      expect(within(stepItem('intake')).getByText('Running')).toBeDefined();
    });
    act(() => {
      source.emit(completed('intake'));
    });
    await waitFor(() => {
      expect(within(stepItem('intake')).getByText('Done')).toBeDefined();
    });
    expect(screen.getByText('1 of 3 steps done')).toBeDefined();

    // The snapshot is read once: events are never answered by a refetch that would show the end.
    expect(fetchMock.mock.calls.filter(([url]) => url === DEMO_RUN)).toHaveLength(1);
    expectOnlyPublicReads(fetchMock);
  });

  it('pauses at Gate 1 with a link to the read-only demo review, then finishes with the pack', async () => {
    mockDemo();
    await renderMonitor();
    const source = FakeEventSource.last;
    act(() => {
      source.open();
      source.emit(status('queued', 'running'));
      source.emit(started('extract'));
      source.emit(completed('extract'));
      source.emit(status('running', 'awaiting_gate', 'fact_conflicts'));
    });

    const link = await screen.findByRole('link', { name: 'See the conflicts' });
    expect(link.getAttribute('href')).toBe(`/demo/runs/${RUN_ID}/conflicts`);
    expect(link.className).toContain('btn-primary');
    expect(screen.getByText(/In this replay the decisions were made already/)).toBeDefined();
    expect(screen.queryByRole('link', { name: 'Review conflicts' })).toBeNull();

    act(() => {
      source.emit(status('awaiting_gate', 'running'));
      source.emit(
        event('pack_exported', {
          stepId: 'write',
          artifactId: '55555555-5555-4555-8555-555555555555',
          imageCount: 0,
          originalCount: 0,
          stagedCount: 0,
          blurredImageCount: 0,
          blurredRegionCount: 0,
          withheldCount: 0,
          checklistFailCount: 0,
          readyToPublish: true,
        }),
      );
      source.emit(status('running', 'completed'));
      source.emitNamed('end', { status: 'completed', lastEventSeq: nextSeq });
    });

    const pack = await screen.findByRole('link', { name: 'View pack' });
    expect(pack.getAttribute('href')).toBe(`/demo/runs/${RUN_ID}/pack`);
    expect(screen.getByText('The listing pack is ready')).toBeDefined();
    expect(screen.getByText('The replay has finished.')).toBeDefined();
    expect(
      screen.getAllByRole('link').filter((l) => l.className.includes('btn-primary')),
    ).toHaveLength(1);
  });

  it('reconnects from the last event with the new speed, and from the start on restart', async () => {
    mockDemo();
    await renderMonitor();
    const first = FakeEventSource.last;
    act(() => {
      first.open();
      first.emit(status('queued', 'running'));
      first.emit(started('intake'));
    });
    await waitFor(() => {
      expect(within(stepItem('intake')).getByText('Running')).toBeDefined();
    });

    expect(screen.getByRole('radio', { name: '1×' })).toHaveProperty('checked', true);
    fireEvent.click(screen.getByRole('radio', { name: '4×' }));

    await waitFor(() => {
      expect(FakeEventSource.instances).toHaveLength(2);
    });
    expect(FakeEventSource.last.url).toBe(`${DEMO_RUN}/events?after=2&speed=4`);
    expect(first.readyState).toBe(FakeEventSource.CLOSED);
    // Nothing was rewound by the speed change.
    expect(within(stepItem('intake')).getByText('Running')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Replay from the start' }));
    await waitFor(() => {
      expect(FakeEventSource.instances).toHaveLength(3);
    });
    expect(FakeEventSource.last.url).toBe(`${DEMO_RUN}/events?speed=4`);
    expect(within(stepItem('intake')).getByText('Waiting')).toBeDefined();
    expect(screen.getByText('0 of 3 steps done')).toBeDefined();
  });

  it('does not reconnect when the speed changes after the replay ended', async () => {
    mockDemo();
    await renderMonitor();
    const source = FakeEventSource.last;
    act(() => {
      source.open();
      source.emitNamed('end', { status: 'completed', lastEventSeq: 11 });
    });
    await screen.findByText('The replay has finished.');

    fireEvent.click(screen.getByRole('radio', { name: '2×' }));

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(source.readyState).toBe(FakeEventSource.CLOSED);
    fireEvent.click(screen.getByRole('button', { name: 'Replay from the start' }));
    await waitFor(() => {
      expect(FakeEventSource.instances).toHaveLength(2);
    });
    expect(FakeEventSource.last.url).toBe(`${DEMO_RUN}/events?speed=2`);
  });

  it('says so when the stream is refused, and continues from the cursor on retry', async () => {
    mockDemo();
    await renderMonitor();
    const source = FakeEventSource.last;
    act(() => {
      source.open();
      source.emit(status('queued', 'running'));
      source.fail();
    });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(
      'The replay could not continue. Try again in a few seconds',
    );
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => {
      expect(FakeEventSource.instances).toHaveLength(2);
    });
    expect(FakeEventSource.last.url).toBe(`${DEMO_RUN}/events?after=1&speed=1`);
  });

  it('applies each event once across a speed change: no duplicate, no skipped step', async () => {
    mockDemo();
    await renderMonitor();
    const first = FakeEventSource.last;
    act(() => {
      first.open();
      first.emit(status('queued', 'running'));
      first.emit(started('intake'));
    });
    fireEvent.click(screen.getByRole('radio', { name: '2×' }));
    await waitFor(() => {
      expect(FakeEventSource.instances).toHaveLength(2);
    });
    const second = FakeEventSource.last;
    // The server resumes after seq 2; a late message of the old source is ignored by the
    // closed source's owner, and a repeated seq changes nothing.
    act(() => {
      second.open();
      second.emit({ ...completed('intake'), seq: 3 });
      second.emit({ ...completed('intake'), seq: 3 });
      second.emit({ ...started('extract'), seq: 4 });
    });
    await waitFor(() => {
      expect(within(stepItem('extract')).getByText('Running')).toBeDefined();
    });
    expect(within(stepItem('intake')).getByText('Done')).toBeDefined();
    expect(screen.getByText('1 of 3 steps done')).toBeDefined();
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it('closes the stream when the page goes away', async () => {
    mockDemo();
    const view = await renderMonitor();
    const source = FakeEventSource.last;
    source.open();

    view.unmount();

    expect(source.readyState).toBe(FakeEventSource.CLOSED);
  });

  it('has no write controls and shows the banner', async () => {
    mockDemo();
    await renderMonitor();

    // Replay controls only change how stored events are played; nothing here writes.
    const buttons = screen.getAllByRole('button').map((b) => b.textContent);
    expect(buttons.filter((t) => t !== 'Replay from the start' && !/account/i.test(t))).toEqual([]);
    expect(screen.getByRole('region', { name: 'About this demo' }).textContent).toMatch(
      /replay of a sample run.*invented.*nothing is sent to a model/is,
    );
  });

  it('answers a run that is not listed with a not-found state that leads back to the list', async () => {
    mockFetch({
      'GET /api/auth/me': meSignedOut,
      [`GET ${DEMO_RUN}`]: () => jsonResponse(404, { error: 'not_found' }),
    });
    openRoute(`/demo/runs/${RUN_ID}`);
    renderPage(DemoRunPage);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('This demo run was not found');
    expect(
      within(alert).getByRole('link', { name: 'See the demo runs' }).getAttribute('href'),
    ).toBe('/demo');
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(screen.getByRole('region', { name: 'About this demo' })).toBeDefined();
  });

  it('asks to wait on a 429 and retries', async () => {
    let calls = 0;
    mockFetch({
      'GET /api/auth/me': meSignedOut,
      [`GET ${DEMO_RUN}`]: () => {
        calls += 1;
        return calls === 1
          ? jsonResponse(429, { error: 'rate_limited' }, { 'Retry-After': '7' })
          : jsonResponse(200, finishedRun());
      },
    });
    openRoute(`/demo/runs/${RUN_ID}`);
    renderPage(DemoRunPage);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Wait about 7 seconds');
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await screen.findByRole('heading', { level: 1, name: 'Sample run replay' });
  });
});

describe('demo replay state helpers', () => {
  it('takes progress back and restores the export from the stored run', () => {
    const final = finishedRun();
    const start = replayStart(final);
    expect(start.status).toBe('queued');
    expect(start.lastEventSeq).toBe(0);
    expect(start.export).toBeNull();
    expect(start.steps.every((s) => s.status === 'pending' && s.startedAt === null)).toBe(true);

    const exported = applyReplayEvent(
      final,
      { ...start, lastEventSeq: 9 },
      {
        seq: 10,
        type: 'pack_exported',
        occurredAt: AT,
        payload: {
          stepId: 'write',
          artifactId: '55555555-5555-4555-8555-555555555555',
          imageCount: 0,
          originalCount: 0,
          stagedCount: 0,
          blurredImageCount: 0,
          blurredRegionCount: 0,
          withheldCount: 0,
          checklistFailCount: 0,
          readyToPublish: true,
        },
      },
    );
    expect(exported.export).toEqual(final.export);
  });

  it('moves the cursor past a gap instead of stalling', () => {
    const final = finishedRun();
    const next = applyReplayEvent(final, replayStart(final), {
      seq: 5,
      type: 'step_started',
      occurredAt: AT,
      payload: { stepId: 'intake', attempt: 1, execution: 1 },
    });
    expect(next.lastEventSeq).toBe(5);
    expect(next.steps[0]?.status).toBe('running');
  });
});

describe('demo gates and pack', () => {
  it('shows Gate 1 read-only: decisions as made, evidence from demo files, no write controls', async () => {
    const decided = gateWith(
      {
        K01: { choice: 'accept', factIds: ['10000000-0000-4000-8000-000000000001'], decidedAt: AT },
        K02: { choice: 'reject', decidedAt: AT },
        K03: { choice: 'reject', decidedAt: AT },
      },
      'released',
    );
    const fetchMock = mockDemo({
      [`GET ${DEMO_RUN}/gates/fact-conflicts`]: () => jsonResponse(200, decided),
    });
    openRoute(`/demo/runs/${RUN_ID}/conflicts`);
    renderPage(DemoConflictsPage);

    await screen.findByRole('heading', { level: 1, name: 'Fact conflicts' });
    expect(screen.getByText(/finished in the original run/)).toBeDefined();
    for (const name of [/Use this value/, /Reject all/, /Enter a value/]) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
    // Evidence is one tap away and points at the demo files.
    expect(screen.getAllByRole('button', { name: /^Play the turn at/ }).length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'Back to run' }).getAttribute('href')).toBe(
      `/demo/runs/${RUN_ID}`,
    );
    expect(screen.getByRole('region', { name: 'About this demo' })).toBeDefined();

    // Public reads only: no market form (a signed-in route), no owner route.
    expectOnlyPublicReads(fetchMock);
  });

  it('shows Gate 2 read-only with the decisions, the demo images, and the pack link', async () => {
    const fetchMock = mockDemo({
      [`GET ${DEMO_RUN}/gates/claim-audit`]: () => jsonResponse(200, demoGate2()),
    });
    openRoute(`/demo/runs/${RUN_ID}/review`);
    renderPage(DemoReviewPage);

    await screen.findByRole('heading', { level: 1, name: 'Pack review' });
    for (const name of [
      /^Approve as written/,
      /^Edit:/,
      /^Remove:/,
      /^Accept staged image/,
      /^Reject staged image/,
      'Approve pack',
    ]) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
    const pack = screen.getByRole('link', { name: 'Open the pack' });
    expect(pack.getAttribute('href')).toBe(`/demo/runs/${RUN_ID}/pack`);

    const originals = screen.getAllByRole('img').map((img) => img.getAttribute('src'));
    expect(originals.some((src) => src?.startsWith(`${DEMO_RUN}/materials/`))).toBe(true);
    expect(originals).toContain(`${DEMO_RUN}/artifacts/${STAGED_ID}/file`);

    // The evidence behind a claim opens, from the demo's own files.
    fireEvent.click(screen.getByRole('button', { name: `Show evidence for: ${TEXT.rooms}` }));
    const panel = await screen.findByRole('complementary');
    expect(
      within(panel).getByRole('img', { name: 'Photo evidence for Rooms' }).getAttribute('src'),
    ).toBe(`${DEMO_RUN}/materials/${MATERIAL_ID}/file`);
    expectOnlyPublicReads(fetchMock);
  });

  it('never shows the deciding form of Gate 2, even for an open gate', async () => {
    const open = demoClaimAuditGateResponseSchema.parse(auditGate({ state: 'open' }));
    const fetchMock = mockDemo({
      [`GET ${DEMO_RUN}/gates/claim-audit`]: () => jsonResponse(200, open),
    });
    openRoute(`/demo/runs/${RUN_ID}/review`);
    renderPage(DemoReviewPage);

    await screen.findByRole('heading', { level: 1, name: 'Pack review' });
    expect(screen.queryByRole('heading', { name: 'Approve the pack' })).toBeNull();
    expect(screen.queryByRole('button', { name: /approve|edit|remove|accept|reject/i })).toBeNull();
    expect(screen.queryByText(/Flagged sentences need a decision/)).toBeNull();
    expectOnlyPublicReads(fetchMock);
  });

  it('renders the pack through the demo export URLs', async () => {
    const fetchMock = mockDemo({ [`GET ${EXPORT_PATH}`]: () => jsonResponse(200, demoManifest()) });
    openRoute(`/demo/runs/${RUN_ID}/pack`);
    renderPage(DemoPackPage);

    const frame = await screen.findByTitle<HTMLIFrameElement>('Listing pack preview');
    expect(frame.getAttribute('src')).toBe(`${EXPORT_PATH}/files/${HTML_ID}`);
    expect(
      screen.getByRole('link', { name: 'Download portal-fields.json' }).getAttribute('href'),
    ).toBe(`${EXPORT_PATH}/files/${JSON_ID}?download=1`);
    expect(screen.getByRole('link', { name: 'Back to the run' }).getAttribute('href')).toBe(
      `/demo/runs/${RUN_ID}`,
    );
    expect(screen.getByRole('region', { name: 'About this demo' })).toBeDefined();
    expectOnlyPublicReads(fetchMock);
  });

  it.each([
    ['conflicts', DemoConflictsPage, 'gates/fact-conflicts'],
    ['review', DemoReviewPage, 'gates/claim-audit'],
    ['pack', DemoPackPage, 'export'],
  ] as const)(
    'answers an unlisted run on /%s with the not-found state',
    async (path, Page, api) => {
      mockFetch({
        'GET /api/auth/me': meSignedOut,
        [`GET ${DEMO_RUN}`]: () => jsonResponse(404, { error: 'not_found' }),
        [`GET ${DEMO_RUN}/${api}`]: () => jsonResponse(404, { error: 'not_found' }),
      });
      openRoute(`/demo/runs/${RUN_ID}/${path}`);
      renderPage(Page);

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain('This demo run was not found');
      expect(within(alert).getByRole('link', { name: 'See the demo runs' })).toBeDefined();
    },
  );

  it.each([
    ['conflicts', DemoConflictsPage, 'gates/fact-conflicts'],
    ['review', DemoReviewPage, 'gates/claim-audit'],
    ['pack', DemoPackPage, 'export'],
  ] as const)('asks to wait when /%s is rate limited', async (path, Page, api) => {
    mockFetch({
      'GET /api/auth/me': meSignedOut,
      [`GET ${DEMO_RUN}`]: () => jsonResponse(200, finishedRun()),
      [`GET ${DEMO_RUN}/${api}`]: () => jsonResponse(429, { error: 'rate_limited' }),
    });
    openRoute(`/demo/runs/${RUN_ID}/${path}`);
    renderPage(Page);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Wait a few seconds');
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeDefined();
  });
});
