import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { checkFact, payloadFromDraft } from '../lib/fact-form';
import ProjectPage from '../pages/projects/[projectId]';
import { PROJECT_ID, RUN_ID, marketForm, projectDetail, run } from './project-fixtures';
import { mockRouter, setRoute } from './router-mock';
import { jsonResponse, meSignedIn, mockFetch, renderPage, type FetchCall } from './test-utils';

vi.mock('next/router', () => import('./router-mock'));

type Handler = (call: FetchCall) => Response;

async function openPage(
  detail = projectDetail(),
  extra: Record<string, Handler> = {},
): Promise<ReturnType<typeof mockFetch>> {
  setRoute(`/projects/${PROJECT_ID}`);
  mockRouter.query = { projectId: PROJECT_ID };
  const fetchMock = mockFetch({
    'GET /api/auth/me': meSignedIn,
    [`GET /api/projects/${PROJECT_ID}`]: () => jsonResponse(200, detail),
    'GET /api/markets/germany/1': () => jsonResponse(200, marketForm),
    ...extra,
  });
  renderPage(ProjectPage);
  await screen.findByLabelText(/Living area/);
  return fetchMock;
}

function change(label: string | RegExp, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe('project page header and materials', () => {
  it('shows the title, market, language, and read-only material counts', async () => {
    await openPage();

    expect(screen.getByRole('heading', { level: 1, name: 'Alder Falls Cottage 4' })).toBeDefined();
    expect(screen.getByText('Germany · German')).toBeDefined();
    const materials = screen.getByRole('region', { name: 'Materials' });
    expect(within(materials).getByText('1 added (3 to 30 needed)')).toBeDefined();
    expect(within(materials).getByText('Not recorded yet')).toBeDefined();
    // A placeholder, not a dead link or a disabled button.
    expect(within(materials).getByText('Coming soon')).toBeDefined();
    expect(within(materials).queryByRole('button')).toBeNull();
    expect(within(materials).queryByRole('link')).toBeNull();
  });

  it('reports a missing project', async () => {
    setRoute(`/projects/${PROJECT_ID}`);
    mockRouter.query = { projectId: PROJECT_ID };
    mockFetch({
      'GET /api/auth/me': meSignedIn,
      [`GET /api/projects/${PROJECT_ID}`]: () => jsonResponse(404, { error: 'not_found' }),
    });
    renderPage(ProjectPage);

    expect(await screen.findByText('This project does not exist.')).toBeDefined();
  });
});

describe('fact form generated from the market profile', () => {
  it('renders one control per fact type with required markers, units, and bounds', async () => {
    await openPage();

    const area = screen.getByLabelText<HTMLInputElement>('Living area (required)');
    expect(area.type).toBe('text');
    expect(area.inputMode).toBe('decimal');
    expect(area.getAttribute('aria-describedby')).toBe(
      screen.getByText('In m². Basis: Living area (Wohnfläche).').id,
    );

    const rooms = screen.getByLabelText<HTMLInputElement>('Rooms (required)');
    expect(rooms.type).toBe('text');
    expect(rooms.inputMode).toBe('numeric');
    expect(screen.getByText('Whole number from 1 to 20.')).toBeDefined();

    const heating = screen.getByRole('combobox', { name: 'Heating type' });
    expect(Array.from((heating as HTMLSelectElement).options).map((o) => o.value)).toEqual([
      '',
      'central_heating',
      'district_heating',
    ]);
    expect(within(heating).getByRole('option', { name: 'Central heating' })).toBeDefined();

    expect(screen.getByText('In EUR.')).toBeDefined();
    expect(screen.getByText('In m³.')).toBeDefined();

    const balcony = screen.getByRole('group', { name: 'Balcony' });
    expect(
      within(balcony)
        .getAllByRole('radio')
        .map((r) => r.parentElement?.textContent),
    ).toEqual(['Yes', 'No', 'Unknown']);
    // Not required: no marker.
    expect(screen.queryByLabelText('Heating type (required)')).toBeNull();
  });

  it('fills the controls from the saved values', async () => {
    await openPage(
      projectDetail({
        values: {
          living_area: 84.5,
          rooms: 3,
          heating_type: 'district_heating',
          has_balcony: false,
        },
      }),
    );

    expect(screen.getByLabelText<HTMLInputElement>(/Living area/).value).toBe('84.5');
    expect(screen.getByLabelText<HTMLInputElement>(/Rooms/).value).toBe('3');
    expect(screen.getByLabelText<HTMLSelectElement>('Heating type').value).toBe('district_heating');
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'No' }).checked).toBe(true);
  });

  it('validates on the client without calling the API', async () => {
    const fetchMock = await openPage();

    change(/Rooms/, '2.5');
    change(/Living area/, '-3');
    fireEvent.click(screen.getByRole('button', { name: 'Save facts' }));

    expect(screen.getByText('Enter a number of 0 or more.')).toBeDefined();
    expect(screen.getByText('Enter a whole number.')).toBeDefined();
    // Focus goes to the first invalid control in profile order.
    expect(document.activeElement).toBe(screen.getByLabelText(/Living area/));
    expect(screen.getByLabelText(/Rooms/).getAttribute('aria-invalid')).toBe('true');
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);

    change(/Rooms/, '99');
    fireEvent.click(screen.getByRole('button', { name: 'Save facts' }));
    expect(screen.getByText('Enter a number from 1 to 20.')).toBeDefined();
  });

  it('saves the whole form, with nulls for empty facts, and shows the saved state', async () => {
    let sent: unknown;
    await openPage(projectDetail(), {
      [`PUT /api/projects/${PROJECT_ID}/fact-form`]: (call) => {
        sent = call.body;
        return jsonResponse(
          200,
          projectDetail({ values: { living_area: 84.5, rooms: 3, has_balcony: true } }),
        );
      },
    });

    const save = screen.getByRole<HTMLButtonElement>('button', { name: 'Save facts' });
    expect(save.disabled).toBe(true);

    change(/Living area/, '84.5');
    change(/Rooms/, '3');
    fireEvent.click(screen.getByRole('radio', { name: 'Yes' }));
    expect(save.disabled).toBe(false);
    expect(screen.getByText('You have unsaved changes.')).toBeDefined();
    fireEvent.click(save);

    expect(await screen.findByText('Facts saved.')).toBeDefined();
    expect(sent).toEqual({
      values: {
        living_area: 84.5,
        rooms: 3,
        heating_type: null,
        price: null,
        volume: null,
        has_balcony: true,
      },
    });
    expect(save.disabled).toBe(true);
  });

  it('shows the server fields map on the matching controls', async () => {
    await openPage(projectDetail(), {
      [`PUT /api/projects/${PROJECT_ID}/fact-form`]: () =>
        jsonResponse(400, {
          error: 'validation_failed',
          issues: [{ path: ['values', 'rooms'], message: 'x' }],
          fields: { rooms: 'out_of_range', heating_type: 'not_allowed' },
        }),
    });

    change(/Rooms/, '4');
    fireEvent.click(screen.getByRole('button', { name: 'Save facts' }));

    const rooms = screen.getByLabelText(/Rooms/);
    await waitFor(() => expect(rooms.getAttribute('aria-invalid')).toBe('true'));
    expect(rooms.getAttribute('aria-describedby')).toContain(
      screen.getByText('Enter a number from 1 to 20.').id,
    );
    expect(screen.getByLabelText('Heating type').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('Choose one of: Central heating, District heating.')).toBeDefined();
    expect(document.activeElement).toBe(rooms);
    // The draft is kept, so the user can correct it.
    expect((rooms as HTMLInputElement).value).toBe('4');
  });

  it('keeps stored extra fields in the PUT body', () => {
    const payload = payloadFromDraft(
      marketForm.market.facts,
      { living_area: '50', has_balcony: 'no' },
      { street_name: 'Example Row', living_area: 40 },
    );
    expect(payload['street_name']).toBe('Example Row');
    expect(payload['living_area']).toBe(50);
    expect(payload['has_balcony']).toBe(false);
    expect(payload['rooms']).toBeNull();
  });

  it('checks values the way the server does', () => {
    const [area, rooms, heating] = marketForm.market.facts;
    if (area === undefined || rooms === undefined || heating === undefined)
      throw new Error('fixture');
    expect(checkFact(area, '')).toBeNull();
    expect(checkFact(area, 'abc')).toBe('wrong_type');
    expect(checkFact(area, '-1')).toBe('out_of_range');
    expect(checkFact(rooms, '1.5')).toBe('not_an_integer');
    expect(checkFact(rooms, '0')).toBe('out_of_range');
    expect(checkFact(heating, 'steam')).toBe('not_allowed');
  });
});

describe('locked inputs', () => {
  it('renders the facts and office profile read-only, keeping the title editable', async () => {
    await openPage(
      projectDetail({
        inputsLocked: true,
        canStartRun: true,
        missing: [],
        values: { living_area: 80 },
        latestRun: run('completed'),
      }),
    );

    expect(screen.getByText(/these facts are locked/)).toBeDefined();
    expect(screen.getByText(/the office profile is locked/)).toBeDefined();
    expect(screen.getByLabelText<HTMLInputElement>(/Living area/).disabled).toBe(true);
    expect(screen.getByLabelText<HTMLInputElement>(/Living area/).value).toBe('80');
    expect(screen.getByLabelText<HTMLInputElement>('Agency name (required)').disabled).toBe(true);
    expect(screen.getByLabelText<HTMLInputElement>('Project title (required)').disabled).toBe(
      false,
    );
    expect(screen.queryByRole('button', { name: 'Save facts' })).toBeNull();
  });

  it('sends only the title while locked', async () => {
    let sent: unknown;
    await openPage(projectDetail({ inputsLocked: true, canStartRun: true, missing: [] }), {
      [`PATCH /api/projects/${PROJECT_ID}`]: (call) => {
        sent = call.body;
        return jsonResponse(200, projectDetail({ inputsLocked: true, title: 'Renamed' }));
      },
    });

    change('Project title (required)', 'Renamed');
    fireEvent.click(screen.getByRole('button', { name: 'Save details' }));

    expect(await screen.findByText('Details saved.')).toBeDefined();
    expect(sent).toEqual({ title: 'Renamed' });
  });
});

describe('office profile and title', () => {
  it('patches only what changed and maps server issues', async () => {
    const bodies: unknown[] = [];
    await openPage(projectDetail(), {
      [`PATCH /api/projects/${PROJECT_ID}`]: (call) => {
        bodies.push(call.body);
        return bodies.length === 1
          ? jsonResponse(400, {
              error: 'validation_failed',
              issues: [{ path: ['officeProfile', 'agencyName'], message: 'x' }],
            })
          : jsonResponse(200, projectDetail());
      },
    });

    change('Agency name (required)', 'Neue Immobilien');
    change('Tone', '');
    fireEvent.click(screen.getByRole('button', { name: 'Save details' }));

    expect(
      await screen.findByText('Use at most 200 characters for the agency name.'),
    ).toBeDefined();
    expect(bodies[0]).toEqual({ officeProfile: { agencyName: 'Neue Immobilien' } });
  });

  it('refuses an empty agency name on the client', async () => {
    const fetchMock = await openPage();
    change('Agency name (required)', '  ');
    fireEvent.click(screen.getByRole('button', { name: 'Save details' }));

    expect(screen.getByText('Enter your agency name.')).toBeDefined();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
  });
});

describe('readiness and starting a run', () => {
  it('lists what is missing and keeps Start run disabled', async () => {
    await openPage();

    const panel = screen.getByRole('region', { name: 'Ready to run?' });
    const items = within(panel)
      .getAllByRole('listitem')
      .map((item) => item.textContent);
    expect(items).toEqual([
      'Add at least 3 photos (1 so far).',
      'Record a voice walkthrough of the property.',
      'Fill in the required fact: Living area.',
    ]);
    expect(
      within(panel).getByRole<HTMLButtonElement>('button', { name: 'Start run' }).disabled,
    ).toBe(true);
  });

  it('starts the run and opens the run monitor', async () => {
    await openPage(projectDetail({ canStartRun: true, missing: [] }), {
      [`POST /api/projects/${PROJECT_ID}/runs`]: () => jsonResponse(201, { run: run('running') }),
    });

    expect(screen.getByText('All inputs are in place. You can start a run.')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Start run' }));

    await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith(`/runs/${RUN_ID}`));
  });

  it('on not_ready, refreshes the readiness', async () => {
    let reads = 0;
    await openPage(projectDetail({ canStartRun: true, missing: [] }), {
      [`GET /api/projects/${PROJECT_ID}`]: () => {
        reads += 1;
        return jsonResponse(
          200,
          reads === 1
            ? projectDetail({ canStartRun: true, missing: [] })
            : projectDetail({ missing: [{ kind: 'voice_memo' }] }),
        );
      },
      [`POST /api/projects/${PROJECT_ID}/runs`]: () =>
        jsonResponse(409, { error: 'not_ready', missing: [{ kind: 'voice_memo' }] }),
    });

    fireEvent.click(screen.getByRole('button', { name: 'Start run' }));

    expect(await screen.findByText(/Some inputs changed since this page loaded/)).toBeDefined();
    expect(await screen.findByText('Record a voice walkthrough of the property.')).toBeDefined();
    expect(mockRouter.push).not.toHaveBeenCalled();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Start run' }).disabled).toBe(
      true,
    );
  });

  it('on run_active, links to the active run', async () => {
    let reads = 0;
    await openPage(projectDetail({ canStartRun: true, missing: [] }), {
      [`GET /api/projects/${PROJECT_ID}`]: () => {
        reads += 1;
        return jsonResponse(
          200,
          reads === 1
            ? projectDetail({ canStartRun: true, missing: [] })
            : projectDetail({
                inputsLocked: true,
                activeRunId: RUN_ID,
                missing: [],
                latestRun: run('running'),
              }),
        );
      },
      [`POST /api/projects/${PROJECT_ID}/runs`]: () => jsonResponse(409, { error: 'run_active' }),
    });

    fireEvent.click(screen.getByRole('button', { name: 'Start run' }));

    const alert = await screen.findByText(/A run is already in progress for this project\./);
    await waitFor(() => {
      const links = within(alert.closest('[role=alert]') as HTMLElement).getAllByRole('link');
      expect(links[0]?.getAttribute('href')).toBe(`/runs/${RUN_ID}`);
    });
    expect(mockRouter.push).not.toHaveBeenCalled();
  });

  it('on daily_budget_reached, shows a calm message', async () => {
    await openPage(projectDetail({ canStartRun: true, missing: [] }), {
      [`POST /api/projects/${PROJECT_ID}/runs`]: () =>
        jsonResponse(409, { error: 'daily_budget_reached' }),
    });

    fireEvent.click(screen.getByRole('button', { name: 'Start run' }));

    expect(await screen.findByText(/run budget has been used up/)).toBeDefined();
    expect(mockRouter.push).not.toHaveBeenCalled();
    // Still startable: the budget resets, nothing about the inputs changed.
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Start run' }).disabled).toBe(
      false,
    );
  });

  it('shows a generic error for other failures', async () => {
    await openPage(projectDetail({ canStartRun: true, missing: [] }), {
      [`POST /api/projects/${PROJECT_ID}/runs`]: () =>
        jsonResponse(500, { error: 'internal_error' }),
    });

    fireEvent.click(screen.getByRole('button', { name: 'Start run' }));

    expect(await screen.findByText(/Something went wrong on our side/)).toBeDefined();
  });
});
