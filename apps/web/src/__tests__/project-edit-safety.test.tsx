import type { ProjectDetailResponse } from '@evidomo/shared';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { checkFact, parseNumberText, payloadFromDraft } from '../lib/fact-form';
import { projectKey } from '../lib/projects';
import ProjectPage from '../pages/projects/[projectId]';
import { PROJECT_ID, RUN_ID, marketForm, projectDetail, run } from './project-fixtures';
import { mockRouter, setRoute } from './router-mock';
import { jsonResponse, meSignedIn, mockFetch, renderPage, type FetchCall } from './test-utils';

vi.mock('next/router', () => import('./router-mock'));

type Handler = (call: FetchCall) => Response | Promise<Response>;

/** Opens the project page; `server.detail` is what every GET answers, so tests can change it. */
async function openPage(initial: ProjectDetailResponse, extra: Record<string, Handler> = {}) {
  const server = { detail: initial };
  setRoute(`/projects/${PROJECT_ID}`);
  mockRouter.query = { projectId: PROJECT_ID };
  const fetchMock = mockFetch({
    'GET /api/auth/me': meSignedIn,
    [`GET /api/projects/${PROJECT_ID}`]: () => jsonResponse(200, server.detail),
    'GET /api/markets/germany/1': () => jsonResponse(200, marketForm),
    ...extra,
  });
  const { queryClient } = renderPage(ProjectPage);
  await screen.findByLabelText(/Living area/);
  const refetch = async (next: ProjectDetailResponse) => {
    server.detail = next;
    await act(() => queryClient.invalidateQueries({ queryKey: projectKey(PROJECT_ID) }));
    // TanStack Query hands observers their update on a zero-delay timer.
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  };
  return { fetchMock, refetch, server };
}

function change(label: string | RegExp, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

const area = () => screen.getByLabelText<HTMLInputElement>(/Living area/);
const putCalls = (fetchMock: ReturnType<typeof mockFetch>) =>
  fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT');
const PUT_PATH = `PUT /api/projects/${PROJECT_ID}/fact-form`;
const PATCH_PATH = `PATCH /api/projects/${PROJECT_ID}`;
const RUN_PATH = `POST /api/projects/${PROJECT_ID}/runs`;

describe('number text', () => {
  it('accepts exactly one comma or point as the decimal separator', () => {
    expect(parseNumberText('92,5')).toBe(92.5);
    expect(parseNumberText('92.5')).toBe(92.5);
    expect(parseNumberText(' 7 ')).toBe(7);
    expect(parseNumberText('-3')).toBe(-3);
    expect(parseNumberText('0,125')).toBe(0.125);
  });

  it('rejects thousands separators, repeated separators, and anything else', () => {
    for (const text of [
      '1,000',
      '1.250',
      '1,234,567',
      '1.2.3',
      '1,2,3',
      'abc',
      '1e3',
      '92,',
      ',5',
      '',
    ]) {
      expect(parseNumberText(text), text).toBeNull();
    }
  });

  it('never turns unparsable text into a cleared value', () => {
    const [areaField] = marketForm.market.facts;
    if (areaField === undefined) throw new Error('fixture');
    expect(checkFact(areaField, 'abc')).toBe('wrong_type');
    expect(() => payloadFromDraft([areaField], { living_area: 'abc' }, {})).toThrow();
  });
});

describe('typing numbers in the fact form', () => {
  it('saves "92,5" as 92.5', async () => {
    let sent: unknown;
    const { fetchMock } = await openPage(projectDetail(), {
      [PUT_PATH]: (call) => {
        sent = call.body;
        return jsonResponse(200, projectDetail({ values: { living_area: 92.5 } }));
      },
    });

    change(/Living area/, '92,5');
    fireEvent.click(screen.getByRole('button', { name: 'Save facts' }));

    expect(await screen.findByText('Facts saved.')).toBeDefined();
    expect(sent).toMatchObject({ values: { living_area: 92.5 } });
    expect(putCalls(fetchMock)).toHaveLength(1);
    expect(area().value).toBe('92.5');
  });

  it('refuses "abc" and keeps the stored value untouched', async () => {
    const { fetchMock } = await openPage(projectDetail({ values: { living_area: 80 } }));

    change(/Living area/, 'abc');
    fireEvent.click(screen.getByRole('button', { name: 'Save facts' }));

    expect(
      screen.getByText(
        'Enter a number, using one comma or point for decimals and no thousands separators.',
      ),
    ).toBeDefined();
    expect(putCalls(fetchMock)).toHaveLength(0);
  });

  it('clears a field error as soon as that field changes', async () => {
    await openPage(projectDetail());

    change(/Living area/, 'abc');
    fireEvent.click(screen.getByRole('button', { name: 'Save facts' }));
    expect(area().getAttribute('aria-invalid')).toBe('true');

    change(/Living area/, '9');
    expect(area().getAttribute('aria-invalid')).toBe('false');
    expect(area().getAttribute('aria-describedby') ?? '').not.toContain('-error');
  });
});

describe('saving the fact form', () => {
  it('sends stored extra fields and null for a cleared value', async () => {
    let sent: unknown;
    await openPage(projectDetail({ values: { living_area: 80, street_name: 'Example Row' } }), {
      [PUT_PATH]: (call) => {
        sent = call.body;
        return jsonResponse(200, projectDetail({ values: { street_name: 'Example Row' } }));
      },
    });

    expect(screen.getByText(/1 additional field is stored/)).toBeDefined();
    change(/Living area/, '');
    fireEvent.click(screen.getByRole('button', { name: 'Save facts' }));

    expect(await screen.findByText('Facts saved.')).toBeDefined();
    expect(sent).toEqual({
      values: {
        street_name: 'Example Row',
        living_area: null,
        rooms: null,
        heating_type: null,
        price: null,
        volume: null,
        has_balcony: null,
      },
    });
  });

  it('makes the controls read-only while the save is in flight', async () => {
    let finish: (response: Response) => void = () => undefined;
    await openPage(projectDetail(), {
      [PUT_PATH]: () => new Promise<Response>((resolve) => (finish = resolve)),
    });

    change(/Living area/, '50');
    fireEvent.click(screen.getByRole('button', { name: 'Save facts' }));

    await waitFor(() => expect(area().disabled).toBe(true));
    await act(async () => {
      finish(jsonResponse(200, projectDetail({ values: { living_area: 50 } })));
      await Promise.resolve();
    });
    await waitFor(() => expect(area().disabled).toBe(false));
    expect(area().value).toBe('50');
  });

  it('sends one request when the form is submitted twice', async () => {
    const { fetchMock } = await openPage(projectDetail(), {
      [PUT_PATH]: () => jsonResponse(200, projectDetail({ values: { living_area: 50 } })),
    });

    change(/Living area/, '50');
    const form = area().closest('form') as HTMLFormElement;
    fireEvent.submit(form);
    fireEvent.submit(form);

    expect(await screen.findByText('Facts saved.')).toBeDefined();
    expect(putCalls(fetchMock)).toHaveLength(1);
  });

  it('keeps a stored enum value the profile dropped visible and clearable', async () => {
    let sent: { values: Record<string, unknown> } | undefined;
    await openPage(projectDetail({ values: { heating_type: 'steam' } }), {
      [PUT_PATH]: (call) => {
        sent = call.body as { values: Record<string, unknown> };
        return jsonResponse(200, projectDetail());
      },
    });

    const select = screen.getByLabelText<HTMLSelectElement>('Heating type');
    expect(select.value).toBe('steam');
    expect(screen.getByRole('option', { name: '(invalid) steam' })).toBeDefined();

    // Saving the stale value is refused before any request.
    change(/Living area/, '40');
    fireEvent.click(screen.getByRole('button', { name: 'Save facts' }));
    expect(screen.getByText(/Choose one of: Central heating/)).toBeDefined();

    change('Heating type', '');
    fireEvent.click(screen.getByRole('button', { name: 'Save facts' }));
    expect(await screen.findByText('Facts saved.')).toBeDefined();
    expect(sent?.values['heating_type']).toBeNull();
  });
});

describe('following the saved values', () => {
  it('shows the saved values, not the draft, once inputs are locked', async () => {
    const { refetch } = await openPage(projectDetail());

    change(/Living area/, '55');
    expect(area().value).toBe('55');

    await refetch(
      projectDetail({
        inputsLocked: true,
        canStartRun: true,
        missing: [],
        values: { living_area: 80 },
      }),
    );

    expect(area().value).toBe('80');
    expect(area().disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Save facts' })).toBeNull();
  });

  it('follows new saved values while the form is untouched', async () => {
    const { refetch } = await openPage(projectDetail({ values: { living_area: 80 } }));

    await refetch(projectDetail({ values: { living_area: 95 } }));

    expect(area().value).toBe('95');
    expect(screen.queryByText(/Saved values changed elsewhere/)).toBeNull();
  });

  it('warns instead of overwriting when edits conflict with newer saved values', async () => {
    const { refetch, fetchMock } = await openPage(projectDetail({ values: { living_area: 80 } }));

    change(/Living area/, '60');
    await refetch(projectDetail({ values: { living_area: 95 } }));

    expect(screen.getByText(/Saved values changed elsewhere/)).toBeDefined();
    expect(area().value).toBe('60');
    const save = screen.getByRole<HTMLButtonElement>('button', { name: 'Save facts' });
    expect(save.disabled).toBe(true);
    fireEvent.submit(area().closest('form') as HTMLFormElement);
    expect(putCalls(fetchMock)).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Load saved values' }));
    expect(area().value).toBe('95');
    expect(screen.queryByText(/Saved values changed elsewhere/)).toBeNull();
  });

  it('applies the same rules to the project details form', async () => {
    const { refetch } = await openPage(projectDetail());

    change('Project title (required)', 'My draft title');
    await refetch(projectDetail({ title: 'Renamed elsewhere' }));
    expect(screen.getByText(/Saved values changed elsewhere/)).toBeDefined();
    expect(screen.getByLabelText<HTMLInputElement>('Project title (required)').value).toBe(
      'My draft title',
    );
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save details' }).disabled).toBe(
      true,
    );

    fireEvent.click(screen.getAllByRole('button', { name: 'Load saved values' })[0] as HTMLElement);
    expect(screen.getByLabelText<HTMLInputElement>('Project title (required)').value).toBe(
      'Renamed elsewhere',
    );
  });

  it('shows the saved office profile once it is locked, even with an unsaved edit', async () => {
    const { refetch } = await openPage(projectDetail());

    change('Agency name (required)', 'Draft Agency');
    await refetch(projectDetail({ inputsLocked: true, canStartRun: true, missing: [] }));

    const agency = screen.getByLabelText<HTMLInputElement>('Agency name (required)');
    expect(agency.value).toBe('Fictional Realty Co');
    expect(agency.disabled).toBe(true);
  });
});

describe('inputs_locked answers', () => {
  it('on PUT, refetches and shows the locked form', async () => {
    const { server } = await openPage(projectDetail(), {
      [PUT_PATH]: () => {
        server.detail = projectDetail({
          inputsLocked: true,
          canStartRun: true,
          missing: [],
          values: { living_area: 80 },
        });
        return jsonResponse(409, { error: 'inputs_locked' });
      },
    });

    change(/Living area/, '50');
    fireEvent.click(screen.getByRole('button', { name: 'Save facts' }));

    await waitFor(() => expect(area().value).toBe('80'));
    expect(area().disabled).toBe(true);
    expect(screen.getByText(/these facts are locked/)).toBeDefined();
  });

  it('on PATCH, refetches and shows the locked office profile', async () => {
    const { server } = await openPage(projectDetail(), {
      [PATCH_PATH]: () => {
        server.detail = projectDetail({ inputsLocked: true, canStartRun: true, missing: [] });
        return jsonResponse(409, { error: 'inputs_locked' });
      },
    });

    change('Agency name (required)', 'Draft Agency');
    fireEvent.click(screen.getByRole('button', { name: 'Save details' }));

    await waitFor(() =>
      expect(screen.getByLabelText<HTMLInputElement>('Agency name (required)').value).toBe(
        'Fictional Realty Co',
      ),
    );
    expect(screen.getByLabelText<HTMLInputElement>('Agency name (required)').disabled).toBe(true);
    expect(screen.getByText(/the office profile is locked/)).toBeDefined();
  });

  it('sends one PATCH when the details are submitted twice', async () => {
    const { fetchMock } = await openPage(projectDetail(), {
      [PATCH_PATH]: () => jsonResponse(200, projectDetail({ title: 'Renamed' })),
    });

    change('Project title (required)', 'Renamed');
    const form = screen
      .getByLabelText('Project title (required)')
      .closest('form') as HTMLFormElement;
    fireEvent.submit(form);
    fireEvent.submit(form);

    expect(await screen.findByText('Details saved.')).toBeDefined();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1);
  });
});

describe('starting a run with unsaved edits', () => {
  it('stays disabled until the facts are saved', async () => {
    await openPage(projectDetail({ canStartRun: true, missing: [] }), {
      [PUT_PATH]: () =>
        jsonResponse(200, projectDetail({ canStartRun: true, missing: [], values: { rooms: 3 } })),
    });
    const start = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Start run' });
    expect(start().disabled).toBe(false);

    change(/Rooms/, '3');
    expect(start().disabled).toBe(true);
    expect(screen.getByText('Save your changes first.')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Save facts' }));
    await screen.findByText('Facts saved.');
    expect(start().disabled).toBe(false);
    expect(screen.queryByText('Save your changes first.')).toBeNull();
  });

  it('is also blocked by an unsaved office profile', async () => {
    await openPage(projectDetail({ canStartRun: true, missing: [] }));

    change('Tone', 'formal');

    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Start run' }).disabled).toBe(
      true,
    );
  });

  it('sends one request for a double click and keeps the button off until the refetch lands', async () => {
    const { fetchMock } = await openPage(projectDetail({ canStartRun: true, missing: [] }), {
      [RUN_PATH]: () => jsonResponse(201, { run: run('running') }),
    });

    const start = screen.getByRole<HTMLButtonElement>('button', { name: 'Start run' });
    start.click();
    start.click();

    await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith(`/runs/${RUN_ID}`));
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(start.disabled).toBe(true);
  });

  it('clears the not_ready notice once the inputs are complete again', async () => {
    const { refetch, server } = await openPage(projectDetail({ canStartRun: true, missing: [] }), {
      [RUN_PATH]: () => {
        // The server knows better: by the time the refetch runs, the voice memo is missing.
        server.detail = projectDetail({ missing: [{ kind: 'voice_memo' }] });
        return jsonResponse(409, { error: 'not_ready', missing: [{ kind: 'voice_memo' }] });
      },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Start run' }));
    expect(await screen.findByText(/The list above shows what is missing now/)).toBeDefined();
    expect(screen.getByText('Record a voice walkthrough of the property.')).toBeDefined();

    await refetch(projectDetail({ canStartRun: true, missing: [] }));
    expect(screen.queryByText(/The list above shows what is missing now/)).toBeNull();
  });
});
