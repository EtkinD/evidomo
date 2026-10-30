import type { RunSnapshot, RunStepSnapshot } from '@evidomo/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FailureNotice } from '../components/RunFailure';
import RunPage from '../pages/runs/[runId]';
import { FakeEventSource } from './fake-event-source';
import { setRoute } from './router-mock';
import {
  IntlTest,
  jsonResponse,
  meSignedIn,
  mockFetch,
  renderPage,
  type FetchCall,
} from './test-utils';

vi.mock('next/router', () => import('./router-mock'));

const RUN_ID = '0b9f7c1e-5d2a-4e8b-9c3d-1a2b3c4d5e6f';
const PROJECT_ID = '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
const RUN_PATH = `/api/runs/${RUN_ID}`;
const RESUME_PATH = `${RUN_PATH}/resume`;
const STORAGE_KEY = 'evidomo.liveRunAccessCode';
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
    status: 'failed',
    serviceId: 'listing-pack',
    serviceVersion: 1,
    marketProfileId: 'de',
    marketProfileVersion: 1,
    outputLanguage: 'de',
    gate: null,
    currentStepId: 'creative',
    failureReason: 'Step "creative" failed after 2 executions: the model did not answer.',
    createdAt: AT,
    startedAt: AT,
    finishedAt: AT,
    updatedAt: AT,
    lastEventSeq: 9,
    maxExecutionsPerAttempt: 2,
    steps: [
      step({ stepId: 'intake', status: 'completed', attempt: 1, attempts: 1, executions: 1 }),
      step({
        stepId: 'fact_extraction',
        status: 'completed',
        attempt: 1,
        attempts: 1,
        executions: 1,
      }),
      step({
        stepId: 'creative',
        status: 'failed',
        attempt: 1,
        attempts: 1,
        executions: 2,
        error: 'the model did not answer',
      }),
      step({ stepId: 'export' }),
    ],
    export: null,
    ...overrides,
  };
}

const running = (): RunSnapshot =>
  snapshot({
    status: 'running',
    failureReason: null,
    finishedAt: null,
    lastEventSeq: 12,
    steps: snapshot().steps.map((s) =>
      s.stepId === 'creative' ? { ...s, status: 'queued' as const, error: null } : s,
    ),
  });

let sent: unknown;

function open(
  initial: RunSnapshot,
  resume: (call: FetchCall) => Response = () => jsonResponse(200, { run: running() }),
) {
  sent = undefined;
  setRoute(`/runs/${RUN_ID}?runId=${RUN_ID}`);
  mockFetch({
    'GET /api/auth/me': meSignedIn,
    [`GET ${RUN_PATH}`]: () => jsonResponse(200, initial),
    [`POST ${RESUME_PATH}`]: (call) => {
      sent = call.body;
      return resume(call);
    },
  });
  renderPage(RunPage);
}

const resumeButton = () => screen.findByRole('button', { name: 'Resume run' });

describe('failed run: what stopped, what is kept, what to do', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    window.sessionStorage.clear();
  });

  it('names the failed step, quotes the API reason, and says finished steps are kept', async () => {
    open(snapshot());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The run failed');
    expect(within(alert).getByText('Stopped at: Writing the listing')).toBeDefined();
    expect(within(alert).getByText(/the model did not answer/)).toBeDefined();
    expect(
      within(alert).getByText('Finished steps are kept: 2 of 4 will not run again.'),
    ).toBeDefined();
    expect(await resumeButton()).toBeDefined();
  });

  it('resumes: sends no code by default, shows the run running, and keeps focus on a status line', async () => {
    open(snapshot());
    fireEvent.click(await resumeButton());
    const status = await screen.findByText(
      'Resumed from “Writing the listing”. The steps already done were kept.',
    );
    expect(sent).toEqual({});
    expect(document.activeElement).toBe(status);
    expect(screen.queryByRole('button', { name: 'Resume run' })).toBeNull();
    await waitFor(() => {
      expect(FakeEventSource.instances).toHaveLength(1);
    });
    expect(FakeEventSource.last.url).toBe(`${RUN_PATH}/events?after=12`);
  });

  it('sends the access code and remembers it for the session', async () => {
    open(snapshot());
    await resumeButton();
    fireEvent.change(screen.getByLabelText('Access code'), { target: { value: ' open sesame ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Resume run' }));
    await screen.findByText(/Resumed from/);
    expect(sent).toEqual({ accessCode: 'open sesame' });
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBe('open sesame');
  });

  it('403 access_code_invalid: field error, stored code forgotten, can try again', async () => {
    window.sessionStorage.setItem(STORAGE_KEY, 'old');
    open(snapshot(), () => jsonResponse(403, { error: 'access_code_invalid' }));
    fireEvent.click(await resumeButton());
    expect(await screen.findByText('This access code is not valid.')).toBeDefined();
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(screen.getByLabelText('Access code').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Resume run' }).disabled).toBe(
      false,
    );
  });

  it('409 run_budget_exhausted: says it cannot be resumed and points to a new run', async () => {
    open(snapshot(), () => jsonResponse(409, { error: 'run_budget_exhausted' }));
    fireEvent.click(await resumeButton());
    expect(await screen.findByText(/used up its own cost allowance/)).toBeDefined();
    expect(
      screen.getByRole('link', { name: 'Start a new run from the project' }).getAttribute('href'),
    ).toBe(`/projects/${PROJECT_ID}`);
    expect(screen.queryByRole('button', { name: 'Resume run' })).toBeNull();
  });

  it('409 daily_budget_reached: names the wait when Retry-After is sent, else says tomorrow', async () => {
    open(snapshot(), () =>
      jsonResponse(409, { error: 'daily_budget_reached' }, { 'Retry-After': '7200' }),
    );
    fireEvent.click(await resumeButton());
    expect(await screen.findByText(/you can resume this run in about 2 hours/)).toBeDefined();
  });

  it('409 daily_budget_reached without Retry-After', async () => {
    open(snapshot(), () => jsonResponse(409, { error: 'daily_budget_reached' }));
    fireEvent.click(await resumeButton());
    expect(await screen.findByText(/resume this run tomorrow/)).toBeDefined();
  });

  it('409 run_not_resumable: explains, refreshes the run, and shows its real state', async () => {
    let reads = 0;
    sent = undefined;
    setRoute(`/runs/${RUN_ID}?runId=${RUN_ID}`);
    mockFetch({
      'GET /api/auth/me': meSignedIn,
      [`GET ${RUN_PATH}`]: () => {
        reads += 1;
        return jsonResponse(200, reads === 1 ? snapshot() : running());
      },
      [`POST ${RESUME_PATH}`]: () => jsonResponse(409, { error: 'run_not_resumable' }),
    });
    renderPage(RunPage);
    fireEvent.click(await resumeButton());
    await waitFor(() => {
      expect(reads).toBe(2);
    });
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Resume run' })).toBeNull();
    });
  });

  it('429 run_limit_reached with Retry-After', async () => {
    open(snapshot(), () =>
      jsonResponse(429, { error: 'run_limit_reached' }, { 'Retry-After': '1800' }),
    );
    fireEvent.click(await resumeButton());
    expect(await screen.findByText(/You can try again in 30 minutes/)).toBeDefined();
  });

  it('429 rate_limited (too many wrong codes)', async () => {
    open(snapshot(), () => jsonResponse(429, { error: 'rate_limited' }, { 'Retry-After': '60' }));
    fireEvent.click(await resumeButton());
    expect(await screen.findByText('Too many wrong codes. Try again later.')).toBeDefined();
  });

  it('404: the run is gone', async () => {
    open(snapshot(), () => jsonResponse(404, { error: 'not_found' }));
    fireEvent.click(await resumeButton());
    expect(await screen.findByText('This run no longer exists.')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Resume run' })).toBeNull();
  });

  it('a network failure keeps the button so the agent can retry', async () => {
    open(snapshot(), () => {
      throw new TypeError('Failed to fetch');
    });
    fireEvent.click(await resumeButton());
    expect(await screen.findByText(/Could not reach Evidomo/)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Resume run' })).toBeDefined();
  });
});

describe('a step that is retrying and the stream states', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
  });

  it('marks a failed execution that will run again as Retrying, with the reason', async () => {
    open(
      snapshot({
        status: 'running',
        failureReason: null,
        finishedAt: null,
        steps: snapshot().steps.map((s) =>
          s.stepId === 'creative' ? { ...s, status: 'queued' as const } : s,
        ),
      }),
    );
    expect(await screen.findByText('Retrying')).toBeDefined();
    expect(
      screen.getByText('Retrying automatically after: the model did not answer'),
    ).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Resume run' })).toBeNull();
  });
});

describe('resume contract additions', () => {
  it('a code a future server adds still gets the generic message and keeps the button', async () => {
    open(snapshot(), () => jsonResponse(409, { error: 'from_the_future' }));
    fireEvent.click(await resumeButton());
    expect(await screen.findByText(/Something went wrong on our side/)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Resume run' })).toBeDefined();
  });

  it('mentions that a resume uses one of the day’s starts, next to the button', async () => {
    open(snapshot());
    await resumeButton();
    expect(screen.getByText(/Resuming uses one of today’s run starts/)).toBeDefined();
  });

  it('409 run_active: explains and links to the project, which lists the active run', async () => {
    open(snapshot(), () => jsonResponse(409, { error: 'run_active' }));
    fireEvent.click(await resumeButton());
    expect(
      await screen.findByText(/Another run of this project is already in progress/),
    ).toBeDefined();
    expect(screen.getByRole('link', { name: 'Open the project' }).getAttribute('href')).toBe(
      `/projects/${PROJECT_ID}`,
    );
    expect(screen.queryByRole('button', { name: 'Resume run' })).toBeNull();
  });

  it('409 run_not_resumable also points to a new run for changed inputs', async () => {
    open(snapshot(), () => jsonResponse(409, { error: 'run_not_resumable' }));
    fireEvent.click(await resumeButton());
    expect(await screen.findByText(/photos, voice memo, or facts changed/)).toBeDefined();
    expect(
      screen.getByRole('link', { name: 'Start a new run from the project' }).getAttribute('href'),
    ).toBe(`/projects/${PROJECT_ID}`);
  });

  it.each([
    ['inputs_changed', /photos, voice memo, or facts changed/],
    ['definition_unavailable', /no longer available/],
    ['budget_exhausted', /used up its own cost allowance/],
    ['other_run_active', /Another run of this project/],
    ['daily_budget_reached', /resume this run tomorrow/],
  ] as const)('with resume = %s the button is replaced by the explanation', (reason, text) => {
    const queryClient = new QueryClient();
    render(
      <IntlTest>
        <QueryClientProvider client={queryClient}>
          <FailureNotice
            run={snapshot({ resume: reason })}
            runId={RUN_ID}
            onResumed={() => undefined}
          />
        </QueryClientProvider>
      </IntlTest>,
    );
    expect(screen.getByText(text)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Resume run' })).toBeNull();
    expect(screen.queryByLabelText('Access code')).toBeNull();
  });
});
