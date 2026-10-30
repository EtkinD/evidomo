import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ConflictsPage from '../pages/runs/[runId]/conflicts';
import {
  DECIDED_AT,
  FACT,
  RUN_ID,
  gateWith,
  mixedTypeGate,
  mixedUnitGate,
  openGate,
  runSnapshot,
} from './gate-fixtures';
import { marketForm } from './project-fixtures';
import { setRoute } from './router-mock';
import { jsonResponse, meSignedIn, mockFetch, renderPage, type FetchCall } from './test-utils';

vi.mock('next/router', () => import('./router-mock'));

const GATE_PATH = `/api/runs/${RUN_ID}/gates/fact-conflicts`;
const decisionPath = (id: string) => `${GATE_PATH}/conflicts/${id}/decision`;

function mockGate(
  gate: () => Response,
  decide: Record<string, (call: FetchCall) => Response> = {},
  market: () => Response | Promise<Response> = () => jsonResponse(200, marketForm),
) {
  const handlers: Parameters<typeof mockFetch>[0] = {
    'GET /api/auth/me': meSignedIn,
    [`GET /api/runs/${RUN_ID}`]: () => jsonResponse(200, runSnapshot()),
    'GET /api/markets/germany/1': market,
    [`GET ${GATE_PATH}`]: gate,
  };
  for (const [id, handler] of Object.entries(decide)) handlers[`PUT ${decisionPath(id)}`] = handler;
  return mockFetch(handlers);
}

function conflict(name: RegExp | string): HTMLElement {
  return screen.getByRole('group', { name });
}

/** "Enter a value" waits for the market profile, which says what the value must look like. */
async function openEditor(name: string): Promise<void> {
  const button = await screen.findByRole('button', { name });
  await waitFor(() => {
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });
  fireEvent.click(button);
}

const calls = (fetchMock: ReturnType<typeof mockFetch>, method: string) =>
  fetchMock.mock.calls.filter(([, init]) => (init?.method ?? 'GET') === method);

describe('Gate 1 page', () => {
  beforeEach(() => {
    setRoute(`/runs/${RUN_ID}/conflicts?runId=${RUN_ID}`);
  });

  it('lists every conflict with both values and their evidence', async () => {
    mockGate(() => jsonResponse(200, openGate()));
    renderPage(ConflictsPage);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Resolve fact conflicts' }),
    ).toBeDefined();
    expect(screen.getByText('3 of 3 conflicts still open')).toBeDefined();
    expect(
      screen.getByRole('progressbar', { name: 'Conflicts decided' }).getAttribute('value'),
    ).toBe('0');

    const area = await screen.findByRole('group', { name: 'Living area' });
    expect(
      within(area).getByText('The form and the walkthrough disagree about the living area.'),
    ).toBeDefined();
    const sideA = within(area).getByRole('group', {
      name: /^92 m² \(Living area \(Wohnfläche\)\)$/,
    });
    const sideB = within(area).getByRole('group', { name: /^98 m²/ });
    expect(within(sideA).getByText('Form field')).toBeDefined();
    expect(within(sideA).getByText('Living area:', { exact: false })).toBeDefined();
    expect(within(sideA).getByText(/about ninety-two square metres/)).toBeDefined();
    expect(within(sideA).getByRole('button', { name: 'Play the turn at 01:23' })).toBeDefined();
    expect(within(sideB).getByText(/ninety-eight with the extension/)).toBeDefined();
    expect(within(sideB).getByRole('button', { name: 'Play the turn at 02:22' })).toBeDefined();

    const rooms = screen.getByRole('group', { name: 'Rooms' });
    const photo = within(rooms).getByRole('img', { name: 'Photo evidence for Rooms' });
    expect(photo.getAttribute('src')).toMatch(/^\/api\/runs\/.+\/materials\/.+\/file$/);
    expect(photo.getAttribute('loading')).toBe('lazy');

    // A key outside the market profile gets a readable label and no profile unit lookup.
    expect(screen.getByRole('group', { name: 'Station minutes' })).toBeDefined();
  });

  it('accepts a side in one action and puts the response into the cache', async () => {
    const after = gateWith({
      K01: { choice: 'accept', factIds: [FACT.areaOther], decidedAt: DECIDED_AT },
    });
    const fetchMock = mockGate(() => jsonResponse(200, openGate()), {
      K01: () => jsonResponse(200, { ...after, resumed: false }),
    });
    renderPage(ConflictsPage);

    const area = await screen.findByRole('group', { name: 'Living area' });
    fireEvent.click(within(area).getByRole('button', { name: /^Use this value: 98 m²/ }));

    expect(await screen.findByText('2 of 3 conflicts still open')).toBeDefined();
    const put = calls(fetchMock, 'PUT');
    expect(put).toHaveLength(1);
    expect(put[0]?.[0]).toBe(decisionPath('K01'));
    expect(JSON.parse(put[0]?.[1]?.body as string)).toEqual({
      choice: 'accept',
      factId: FACT.areaOther,
    });
    // The decision is shown from the response, without a second GET.
    expect(calls(fetchMock, 'GET').filter(([url]) => url === GATE_PATH)).toHaveLength(1);
    const decided = conflict('Living area');
    expect(within(decided).getByText('You kept 98 m² (Living area (Wohnfläche)).')).toBeDefined();
    expect(within(decided).getByText('Decided')).toBeDefined();
    expect(within(decided).getByText('Kept')).toBeDefined();
    expect(within(decided).queryByRole('button', { name: /^Use this value: 98/ })).toBeNull();
    // The other side can still be picked: a decision may change while the gate is open.
    expect(within(decided).getByRole('button', { name: /^Use this value: 92/ })).toBeDefined();
  });

  it('rejects all values with one action', async () => {
    const after = gateWith({ K02: { choice: 'reject', decidedAt: DECIDED_AT } });
    const fetchMock = mockGate(() => jsonResponse(200, openGate()), {
      K02: () => jsonResponse(200, { ...after, resumed: false }),
    });
    renderPage(ConflictsPage);

    fireEvent.click(await screen.findByRole('button', { name: 'Reject all values for Rooms' }));

    expect(
      await screen.findByText('You rejected all values. Nothing is kept for this fact.'),
    ).toBeDefined();
    expect(JSON.parse(calls(fetchMock, 'PUT')[0]?.[1]?.body as string)).toEqual({
      choice: 'reject',
    });
    expect(screen.queryByRole('button', { name: 'Reject all values for Rooms' })).toBeNull();
  });

  it('validates an edited market value before sending it, then sends the number', async () => {
    const after = gateWith({
      K02: {
        choice: 'edit',
        key: 'rooms',
        value: 6,
        unit: null,
        basis: null,
        decidedAt: DECIDED_AT,
      },
    });
    const fetchMock = mockGate(() => jsonResponse(200, openGate()), {
      K02: () => jsonResponse(200, { ...after, resumed: false }),
    });
    renderPage(ConflictsPage);

    await openEditor('Enter a value for Rooms');
    const input = await screen.findByRole('textbox', { name: 'New value for Rooms' });
    expect(screen.getByText('Whole number from 1 to 20.')).toBeDefined();

    fireEvent.change(input, { target: { value: 'many' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save value' }));
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText(/Enter a number/)).toBeDefined();
    expect(calls(fetchMock, 'PUT')).toHaveLength(0);

    fireEvent.change(input, { target: { value: '21' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save value' }));
    expect(screen.getByText('Enter a number from 1 to 20.')).toBeDefined();

    fireEvent.change(input, { target: { value: '6' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save value' }));

    expect(await screen.findByText('You entered 6.')).toBeDefined();
    expect(JSON.parse(calls(fetchMock, 'PUT')[0]?.[1]?.body as string)).toEqual({
      choice: 'edit',
      value: 6,
    });
    expect(screen.queryByRole('textbox', { name: 'New value for Rooms' })).toBeNull();
  });

  it('types an edited value of an unlisted key from its sides and keeps their unit', async () => {
    const after = gateWith({
      K03: {
        choice: 'edit',
        key: 'other:station_minutes',
        value: 15.5,
        unit: 'minute',
        basis: null,
        decidedAt: DECIDED_AT,
      },
    });
    const fetchMock = mockGate(() => jsonResponse(200, openGate()), {
      K03: () => jsonResponse(200, { ...after, resumed: false }),
    });
    renderPage(ConflictsPage);

    await openEditor('Enter a value for Station minutes');
    expect(screen.getByText('A number, in minute.')).toBeDefined();
    fireEvent.change(screen.getByRole('textbox', { name: 'New value for Station minutes' }), {
      target: { value: '15,5' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save value' }));

    expect(await screen.findByText('You entered 15.5 minute.')).toBeDefined();
    expect(JSON.parse(calls(fetchMock, 'PUT')[0]?.[1]?.body as string)).toEqual({
      choice: 'edit',
      value: 15.5,
      unit: 'minute',
    });
  });

  it('announces that the run continues after the last decision', async () => {
    const released = {
      ...gateWith(
        {
          K01: { choice: 'reject', decidedAt: DECIDED_AT },
          K02: { choice: 'reject', decidedAt: DECIDED_AT },
          K03: { choice: 'reject', decidedAt: DECIDED_AT },
        },
        'released',
      ),
      resumed: true,
    };
    const fetchMock = mockGate(() => jsonResponse(200, openGate()), {
      K03: () => jsonResponse(200, released),
    });
    renderPage(ConflictsPage);

    fireEvent.click(
      await screen.findByRole('button', { name: 'Reject all values for Station minutes' }),
    );

    expect(
      await screen.findByText('All conflicts are decided. The run is continuing.'),
    ).toBeDefined();
    expect(screen.getByRole('link', { name: 'Back to run' }).getAttribute('href')).toBe(
      `/runs/${RUN_ID}`,
    );
    expect(screen.queryByRole('button', { name: /^Use this value/ })).toBeNull();
    // The monitor keeps its snapshot for good, so the resumed run must make it refetch: the
    // page's own observer of that entry reads it again.
    await waitFor(() => {
      expect(calls(fetchMock, 'GET').filter(([url]) => url === `/api/runs/${RUN_ID}`)).toHaveLength(
        2,
      );
    });
    expect(calls(fetchMock, 'PUT')).toHaveLength(1);
  });

  it('disables the other decisions while one is being saved', async () => {
    let finish: (response: Response) => void = () => undefined;
    mockGate(() => jsonResponse(200, openGate()), {
      K02: () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }) as unknown as Response,
    });
    renderPage(ConflictsPage);

    fireEvent.click(await screen.findByRole('button', { name: 'Reject all values for Rooms' }));
    expect(await screen.findByText('Saving your decision…')).toBeDefined();
    const other = screen.getByRole('button', { name: 'Reject all values for Living area' });
    expect((other as HTMLButtonElement).disabled).toBe(true);
    finish(
      jsonResponse(200, {
        ...gateWith({ K02: { choice: 'reject', decidedAt: DECIDED_AT } }),
        resumed: false,
      }),
    );
    await waitFor(() => {
      expect((other as HTMLButtonElement).disabled).toBe(false);
    });
  });

  describe('errors', () => {
    it('refetches and explains a decision on a gate that is no longer open', async () => {
      let gets = 0;
      mockGate(
        () => {
          gets += 1;
          return jsonResponse(200, gets === 1 ? openGate() : gateWith({}, 'released'));
        },
        { K02: () => jsonResponse(409, { error: 'gate_not_open' }) },
      );
      renderPage(ConflictsPage);

      fireEvent.click(await screen.findByRole('button', { name: 'Reject all values for Rooms' }));

      await waitFor(() => {
        expect(
          screen.getByText('This review is finished. Your decisions are shown below.'),
        ).toBeDefined();
      });
      expect(gets).toBe(2);
      expect(screen.queryByRole('button', { name: /^Reject all/ })).toBeNull();
    });

    it('shows the server reason for a refused edit under the field and keeps the form', async () => {
      mockGate(() => jsonResponse(200, openGate()), {
        K02: () =>
          jsonResponse(400, {
            error: 'validation_failed',
            issues: [{ path: ['value'], message: 'rooms must be at most 20' }],
          }),
      });
      renderPage(ConflictsPage);

      await openEditor('Enter a value for Rooms');
      fireEvent.change(screen.getByRole('textbox', { name: 'New value for Rooms' }), {
        target: { value: '7' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Save value' }));

      expect(
        await screen.findByText('That value was not accepted: rooms must be at most 20'),
      ).toBeDefined();
      expect(
        screen.getByRole('textbox', { name: 'New value for Rooms' }).getAttribute('aria-invalid'),
      ).toBe('true');
    });

    it('refetches when the chosen value is no longer part of the conflict', async () => {
      let gets = 0;
      mockGate(
        () => {
          gets += 1;
          return jsonResponse(200, openGate());
        },
        { K02: () => jsonResponse(400, { error: 'fact_not_in_conflict' }) },
      );
      renderPage(ConflictsPage);

      const rooms = await screen.findByRole('group', { name: 'Rooms' });
      fireEvent.click(within(rooms).getByRole('button', { name: /^Use this value: 5/ }));

      expect(
        await within(await screen.findByRole('group', { name: 'Rooms' })).findByRole('alert'),
      ).toBeDefined();
      expect(screen.getByRole('alert').textContent).toContain('no longer part of this conflict');
      expect(gets).toBe(2);
    });
  });

  describe('states', () => {
    it('points back to the run when the review is not reached', async () => {
      mockGate(() =>
        jsonResponse(200, {
          ...openGate(),
          state: 'not_reached',
          runStatus: 'running',
          factSheetArtifactId: null,
          conflictsArtifactId: null,
          conflictCount: 0,
          openCount: 0,
          conflicts: [],
        }),
      );
      renderPage(ConflictsPage);

      expect(await screen.findByText(/has not reached this review yet/)).toBeDefined();
      expect(screen.getByRole('link', { name: 'Back to run' }).getAttribute('href')).toBe(
        `/runs/${RUN_ID}`,
      );
      expect(screen.queryByRole('progressbar')).toBeNull();
    });

    it('shows a released review read-only with the decisions', async () => {
      mockGate(() =>
        jsonResponse(
          200,
          gateWith(
            {
              K01: {
                choice: 'accept',
                factIds: [FACT.areaForm, FACT.areaTurn],
                decidedAt: DECIDED_AT,
              },
              K02: { choice: 'reject', decidedAt: DECIDED_AT },
              K03: {
                choice: 'edit',
                key: 'other:station_minutes',
                value: 15,
                unit: 'minute',
                basis: null,
                decidedAt: DECIDED_AT,
              },
            },
            'released',
          ),
        ),
      );
      renderPage(ConflictsPage);

      expect(
        await screen.findByRole('heading', { level: 1, name: 'Fact conflicts' }),
      ).toBeDefined();
      expect(await screen.findByText('You kept 92 m² (Living area (Wohnfläche)).')).toBeDefined();
      expect(screen.getByText('You entered 15 minute.')).toBeDefined();
      expect(
        screen.queryByRole('button', { name: /^(Use this value|Reject all|Enter a value)/ }),
      ).toBeNull();
      expect(screen.queryByRole('progressbar')).toBeNull();
      expect(screen.getByRole('link', { name: 'Back to run' })).toBeDefined();
      // The evidence stays available for the audit.
      expect(screen.getAllByRole('button', { name: /^Play the turn/ }).length).toBeGreaterThan(0);
    });

    it('explains a suspended review', async () => {
      mockGate(() => jsonResponse(200, gateWith({}, 'suspended')));
      renderPage(ConflictsPage);

      expect((await screen.findByRole('alert')).textContent).toContain('Resume the run');
      expect(screen.queryByRole('button', { name: /^Use this value/ })).toBeNull();
    });

    it('reports a run that is not found', async () => {
      mockGate(() => jsonResponse(404, { error: 'not_found' }));
      renderPage(ConflictsPage);

      expect((await screen.findByRole('alert')).textContent).toContain('This run was not found');
      expect(screen.getByRole('link', { name: 'Go to your projects' })).toBeDefined();
    });

    it('shows a loading status before the conflicts arrive', async () => {
      mockGate(() => jsonResponse(200, openGate()));
      renderPage(ConflictsPage);

      expect(await screen.findByText('Loading the fact conflicts…')).toBeDefined();
      expect(await screen.findByText('3 of 3 conflicts still open')).toBeDefined();
    });

    it('offers a login link with the way back when the session expired', async () => {
      mockGate(() => jsonResponse(401, { error: 'unauthenticated' }));
      renderPage(ConflictsPage);

      const link = await screen.findByRole('link', { name: 'Log in again' });
      expect(decodeURIComponent(link.getAttribute('href') ?? '')).toContain(
        `/runs/${RUN_ID}/conflicts`,
      );
    });

    it('offers a retry when loading fails', async () => {
      let attempts = 0;
      mockGate(() => {
        attempts += 1;
        return attempts === 1
          ? jsonResponse(500, { error: 'internal_error' })
          : jsonResponse(200, openGate());
      });
      renderPage(ConflictsPage);

      fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
      expect(await screen.findByText('3 of 3 conflicts still open')).toBeDefined();
    });
  });

  describe('review fixes', () => {
    const pending = () => {
      let finish: (response: Response) => void = () => undefined;
      const promise = new Promise<Response>((resolve) => {
        finish = resolve;
      });
      return { promise: promise as unknown as Response, finish };
    };
    const rejected = (id: string) => ({
      ...gateWith({ [id]: { choice: 'reject', decidedAt: DECIDED_AT } }),
      resumed: false,
    });

    it('locks an open edit form while another decision is being saved', async () => {
      const slow = pending();
      const fetchMock = mockGate(() => jsonResponse(200, openGate()), {
        K02: () => slow.promise,
      });
      renderPage(ConflictsPage);

      await openEditor('Enter a value for Station minutes');
      const input = screen.getByRole('textbox', { name: 'New value for Station minutes' });
      fireEvent.change(input, { target: { value: '15' } });
      fireEvent.click(screen.getByRole('button', { name: 'Reject all values for Rooms' }));
      await screen.findByText('Saving your decision…');

      expect((input as HTMLInputElement).disabled).toBe(true);
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save value' }).disabled).toBe(
        true,
      );
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Cancel' }).disabled).toBe(true);
      fireEvent.submit(input.closest('form') as HTMLFormElement);
      expect(calls(fetchMock, 'PUT')).toHaveLength(1);
      slow.finish(jsonResponse(200, rejected('K02')));
      await waitFor(() => {
        expect((input as HTMLInputElement).disabled).toBe(false);
      });
    });

    it('asks for the unit when the sides disagree and shows what was saved', async () => {
      const after = mixedUnitGate({
        K03: {
          choice: 'edit',
          key: 'other:station_minutes',
          value: 15,
          unit: 'hour',
          basis: null,
          decidedAt: DECIDED_AT,
        },
      });
      const fetchMock = mockGate(() => jsonResponse(200, mixedUnitGate({})), {
        K03: () => jsonResponse(200, { ...after, resumed: false }),
      });
      renderPage(ConflictsPage);

      await openEditor('Enter a value for Station minutes');
      expect(screen.getByText('A number. Choose its unit below.')).toBeDefined();
      fireEvent.change(screen.getByRole('textbox', { name: 'New value for Station minutes' }), {
        target: { value: '15' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Save value' }));
      expect(screen.getByText('Choose the unit of the value.')).toBeDefined();
      expect(calls(fetchMock, 'PUT')).toHaveLength(0);

      const unit = screen.getByRole('combobox', { name: 'Unit' });
      expect(
        within(unit)
          .getAllByRole('option')
          .map((o) => o.textContent),
      ).toEqual(['Choose…', 'minute', 'hour']);
      fireEvent.change(unit, { target: { value: 'hour' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save value' }));

      expect(await screen.findByText('You entered 15 hour.')).toBeDefined();
      expect(JSON.parse(calls(fetchMock, 'PUT')[0]?.[1]?.body as string)).toEqual({
        choice: 'edit',
        value: 15,
        unit: 'hour',
      });
    });

    it('offers text input when the sides of an unlisted key have mixed types', async () => {
      const fetchMock = mockGate(() => jsonResponse(200, mixedTypeGate()), {
        K03: () => jsonResponse(200, { ...gateWith({}), resumed: false }),
      });
      renderPage(ConflictsPage);

      await openEditor('Enter a value for Station minutes');
      const input = screen.getByRole('textbox', { name: 'New value for Station minutes' });
      expect(input.getAttribute('inputmode')).toBe('text');
      fireEvent.change(input, { target: { value: 'ten minutes' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save value' }));
      await waitFor(() => {
        expect(JSON.parse(calls(fetchMock, 'PUT')[0]?.[1]?.body as string)).toEqual({
          choice: 'edit',
          value: 'ten minutes',
          unit: 'minute',
        });
      });
    });

    it('keeps the "not saved" message when the gate closed during an edit', async () => {
      let gets = 0;
      mockGate(
        () => {
          gets += 1;
          return jsonResponse(200, gets === 1 ? openGate() : gateWith({}, 'released'));
        },
        { K02: () => jsonResponse(409, { error: 'gate_not_open' }) },
      );
      renderPage(ConflictsPage);

      await openEditor('Enter a value for Rooms');
      fireEvent.change(screen.getByRole('textbox', { name: 'New value for Rooms' }), {
        target: { value: '7' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Save value' }));

      expect((await screen.findByRole('alert')).textContent).toContain('decision was not saved');
      expect(screen.queryByRole('textbox', { name: 'New value for Rooms' })).toBeNull();
    });

    it('clears an earlier error when the form is reopened', async () => {
      mockGate(() => jsonResponse(200, openGate()), {
        K02: () => jsonResponse(400, { error: 'validation_failed', issues: [] }),
      });
      renderPage(ConflictsPage);

      await openEditor('Enter a value for Rooms');
      fireEvent.change(screen.getByRole('textbox', { name: 'New value for Rooms' }), {
        target: { value: '7' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Save value' }));
      await screen.findByText('That value was not accepted. Check it and try again.');

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      await openEditor('Enter a value for Rooms');
      expect(screen.queryByText(/was not accepted/)).toBeNull();
    });

    it('closes the form when another choice is saved, and shows a failed one on the card', async () => {
      let fail = true;
      mockGate(() => jsonResponse(200, openGate()), {
        K02: () =>
          fail
            ? jsonResponse(500, { error: 'internal_error' })
            : jsonResponse(200, {
                ...gateWith({
                  K02: { choice: 'accept', factIds: [FACT.roomsPhoto], decidedAt: DECIDED_AT },
                }),
                resumed: false,
              }),
      });
      renderPage(ConflictsPage);

      await openEditor('Enter a value for Rooms');
      const rooms = screen.getByRole('group', { name: 'Rooms' });
      fireEvent.click(within(rooms).getByRole('button', { name: /^Use this value: 5/ }));

      // The failed accept is not blamed on the open field.
      const alert = await within(rooms).findByRole('alert');
      expect(alert.textContent).toContain('Something went wrong');
      expect(
        screen.getByRole('textbox', { name: 'New value for Rooms' }).getAttribute('aria-invalid'),
      ).toBe('false');

      fail = false;
      fireEvent.click(within(rooms).getByRole('button', { name: /^Use this value: 5/ }));
      await waitFor(() => {
        expect(screen.queryByRole('textbox', { name: 'New value for Rooms' })).toBeNull();
      });
    });

    it('keeps one edit form open at a time', async () => {
      mockGate(() => jsonResponse(200, openGate()));
      renderPage(ConflictsPage);

      await openEditor('Enter a value for Rooms');
      await openEditor('Enter a value for Station minutes');

      expect(screen.getAllByRole('button', { name: 'Save value' })).toHaveLength(1);
      expect(screen.queryByRole('textbox', { name: 'New value for Rooms' })).toBeNull();
      expect(document.activeElement).toBe(
        screen.getByRole('textbox', { name: 'New value for Station minutes' }),
      );
    });

    it('moves focus to the conflict heading when the pressed button goes away', async () => {
      mockGate(() => jsonResponse(200, openGate()), {
        K02: () => jsonResponse(200, rejected('K02')),
      });
      renderPage(ConflictsPage);

      fireEvent.click(await screen.findByRole('button', { name: 'Reject all values for Rooms' }));

      await waitFor(() => {
        expect(document.activeElement).toBe(
          screen.getByRole('heading', { level: 2, name: 'Rooms' }),
        );
      });
    });

    it('waits for the market profile before letting a value be entered', async () => {
      const market = pending();
      mockGate(
        () => jsonResponse(200, openGate()),
        {},
        () => market.promise,
      );
      renderPage(ConflictsPage);

      const button = await screen.findByRole('button', { name: 'Enter a value for Rooms' });
      expect((button as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getAllByText('Loading the field type…').length).toBeGreaterThan(0);

      market.finish(jsonResponse(200, marketForm));
      await waitFor(() => {
        expect((button as HTMLButtonElement).disabled).toBe(false);
      });
    });

    it('compares the values at the top of each card and uses a heading outline', async () => {
      mockGate(() => jsonResponse(200, openGate()));
      renderPage(ConflictsPage);

      const area = await screen.findByRole('group', { name: 'Living area' });
      const row = within(area).getByRole('list', { name: 'Values in conflict' });
      const items = within(row)
        .getAllByRole('listitem')
        .map((li) => li.textContent);
      expect(items[0]).toMatch(/^92 m².*2 sources$/);
      expect(items[1]).toMatch(/^98 m².*1 source$/);
      expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
      expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(3);
    });
  });
});
