import type { ClaimAuditGateResponse } from '@evidomo/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ReviewPage from '../pages/runs/[runId]/review';
import {
  CFACT,
  CLAIM,
  STAGED_ID,
  TEXT,
  allDecided,
  auditGate,
  decided,
} from './claim-audit-fixtures';
import { MATERIAL_ID, RUN_ID, runSnapshot } from './gate-fixtures';
import { marketForm } from './project-fixtures';
import { mockRouter, setRoute } from './router-mock';
import { jsonResponse, meSignedIn, mockFetch, renderPage, type FetchCall } from './test-utils';

vi.mock('next/router', () => import('./router-mock'));

const GATE_PATH = `/api/runs/${RUN_ID}/gates/claim-audit`;
const claimPath = (id: string) => `${GATE_PATH}/claims/${id}/decision`;
const imagePath = (id: string) => `${GATE_PATH}/images/${id}/decision`;
const APPROVE_PATH = `${GATE_PATH}/approve`;

type Handler = (call: FetchCall) => Response | Promise<Response>;

function mockAudit(
  gate: Handler,
  writes: Record<string, Handler> = {},
  run: Handler = () => jsonResponse(200, runSnapshot()),
) {
  return mockFetch({
    'GET /api/auth/me': meSignedIn,
    [`GET /api/runs/${RUN_ID}`]: run,
    'GET /api/markets/germany/1': () => jsonResponse(200, marketForm),
    [`GET ${GATE_PATH}`]: gate,
    ...writes,
  });
}

const serve =
  (gate: ClaimAuditGateResponse): Handler =>
  () =>
    jsonResponse(200, gate);
const putTo = (id: string, after: ClaimAuditGateResponse): Record<string, Handler> => ({
  [`PUT ${claimPath(id)}`]: () => jsonResponse(200, after),
});

const calls = (fetchMock: ReturnType<typeof mockFetch>, method: string) =>
  fetchMock.mock.calls.filter(([, init]) => (init?.method ?? 'GET') === method);
const bodyOf = (call: ReturnType<typeof calls>[number] | undefined): unknown =>
  JSON.parse((call?.[1]?.body as string | undefined) ?? 'null');
const getsOf = (fetchMock: ReturnType<typeof mockFetch>, path: string) =>
  calls(fetchMock, 'GET').filter(([url]) => url === path).length;

const isDisabled = (element: HTMLElement): boolean => (element as HTMLButtonElement).disabled;
const flagged = (name: string) => screen.findByRole('group', { name });
const segmentButton = (text: string) =>
  screen.getByRole('button', { name: `Show evidence for: ${text}` });

describe('Gate 2 review page', () => {
  beforeEach(() => {
    setRoute(`/runs/${RUN_ID}/review?runId=${RUN_ID}`);
    mockRouter.push.mockClear();
  });

  describe('listing and evidence', () => {
    it('lists flagged and unflagged segments by variant, with decisions only on flagged ones', async () => {
      mockAudit(serve(auditGate()));
      renderPage(ReviewPage);

      expect(
        await screen.findByRole('heading', { level: 1, name: 'Review the pack' }),
      ).toBeDefined();
      expect(screen.getByRole('heading', { level: 3, name: 'Portal text' })).toBeDefined();
      expect(screen.getByRole('heading', { level: 3, name: 'Social caption' })).toBeDefined();
      expect(screen.getByText('Flagged claims: 5 (5 open)')).toBeDefined();

      // An unflagged segment is listed and clickable, but is not in a flagged group.
      expect(segmentButton(TEXT.area)).toBeDefined();
      expect(screen.queryByRole('group', { name: `Flagged: ${TEXT.area}` })).toBeNull();
      expect(screen.queryByRole('button', { name: `Remove: ${TEXT.area}` })).toBeNull();

      const rooms = await flagged(`Flagged: ${TEXT.rooms}`);
      expect(within(rooms).getByText('Claim not supported')).toBeDefined();
      expect(
        within(rooms).getByText('Nothing in the facts says the rooms are quiet.'),
      ).toBeDefined();
      expect(within(rooms).getByText('Suggestion: Drop the claim about quiet.')).toBeDefined();
      expect(within(rooms).getByText('Needs your decision.')).toBeDefined();
      for (const action of ['Approve as written', 'Edit', 'Remove']) {
        expect(
          within(rooms).getByRole('button', { name: `${action}: ${TEXT.rooms}` }),
        ).toBeDefined();
      }

      const best = await flagged(`Flagged: ${TEXT.best}`);
      expect(within(best).getByText('Unverifiable superlative')).toBeDefined();
    });

    it('shows a form field as the evidence of an unflagged segment and closes it with focus back', async () => {
      mockAudit(serve(auditGate()));
      renderPage(ReviewPage);
      await screen.findByRole('heading', { level: 1, name: 'Review the pack' });

      const button = segmentButton(TEXT.area);
      expect(screen.queryByRole('complementary')).toBeNull();
      fireEvent.click(button);

      const panel = screen.getByRole('complementary', { name: `Evidence for “${TEXT.area}”` });
      expect(within(panel).getByText('This segment cites 1 fact.')).toBeDefined();
      expect(within(panel).getByText('Form field')).toBeDefined();
      expect(within(panel).getByText('Living area:', { exact: false })).toBeDefined();
      expect(button.getAttribute('aria-expanded')).toBe('true');

      fireEvent.click(within(panel).getByRole('button', { name: 'Close evidence' }));
      expect(screen.queryByRole('complementary')).toBeNull();
      expect(document.activeElement).toBe(button);
    });

    it('shows a transcript turn and a photo with its mask for the facts a flagged claim cites', async () => {
      mockAudit(serve(auditGate()));
      renderPage(ReviewPage);
      await screen.findByRole('heading', { level: 1, name: 'Review the pack' });

      fireEvent.click(segmentButton(TEXT.rooms));
      const panel = screen.getByRole('complementary', { name: `Evidence for “${TEXT.rooms}”` });
      expect(within(panel).getByText('This segment cites 2 facts.')).toBeDefined();

      // Transcript turn: the quote and a play control at the turn's start.
      expect(within(panel).getByText(/about ninety-two square metres/)).toBeDefined();
      expect(within(panel).getByRole('button', { name: 'Play the turn at 01:23' })).toBeDefined();

      // Photo: served from the run's material file, with the mask overlay once the mask loads.
      const photo = within(panel).getByRole('img', { name: 'Photo evidence for Rooms' });
      expect(photo.getAttribute('src')).toBe(`/api/runs/${RUN_ID}/materials/${MATERIAL_ID}/file`);
      expect(screen.queryByTestId('mask-overlay')).toBeNull();
      const probes: { src: string; onload: (() => void) | null }[] = [];
      vi.stubGlobal(
        'Image',
        class {
          src = '';
          onload: (() => void) | null = null;
          onerror: (() => void) | null = null;
          constructor() {
            probes.push(this);
          }
        },
      );
      Object.defineProperty(photo, 'naturalWidth', { value: 1600, configurable: true });
      Object.defineProperty(photo, 'naturalHeight', { value: 1200, configurable: true });
      fireEvent.load(photo);
      expect(probes[0]?.src).toBe(`/api/runs/${RUN_ID}/facts/${CFACT.roomsPhoto}/mask.png`);
      probes[0]?.onload?.();
      await waitFor(() => {
        expect(screen.getByTestId('mask-overlay')).toBeDefined();
      });
      vi.unstubAllGlobals();
    });

    it('switches the evidence to another segment and closes it with Escape', async () => {
      mockAudit(serve(auditGate()));
      renderPage(ReviewPage);
      await screen.findByRole('heading', { level: 1, name: 'Review the pack' });

      fireEvent.click(segmentButton(TEXT.area));
      fireEvent.click(segmentButton(TEXT.socialPlain));
      const panel = screen.getByRole('complementary', {
        name: `Evidence for “${TEXT.socialPlain}”`,
      });
      expect(screen.getAllByRole('complementary')).toHaveLength(1);
      expect(within(panel).getByRole('img', { name: 'Photo evidence for Rooms' })).toBeDefined();

      fireEvent.keyDown(panel, { key: 'Escape' });
      expect(screen.queryByRole('complementary')).toBeNull();
    });
  });

  describe('claim decisions', () => {
    it('approves a flagged claim as written and shows the response without another read', async () => {
      const fetchMock = mockAudit(
        serve(auditGate()),
        putTo(CLAIM.rooms, auditGate({ decisions: { [CLAIM.rooms]: decided.accept } })),
      );
      renderPage(ReviewPage);

      const rooms = await flagged(`Flagged: ${TEXT.rooms}`);
      fireEvent.click(
        within(rooms).getByRole('button', { name: `Approve as written: ${TEXT.rooms}` }),
      );

      expect(await screen.findByText('Flagged claims: 5 (4 open)')).toBeDefined();
      expect(calls(fetchMock, 'PUT')).toHaveLength(1);
      expect(calls(fetchMock, 'PUT')[0]?.[0]).toBe(claimPath(CLAIM.rooms));
      expect(bodyOf(calls(fetchMock, 'PUT')[0])).toEqual({ choice: 'accept' });
      expect(getsOf(fetchMock, GATE_PATH)).toBe(1);
      expect(within(rooms).getByText('Approved as written.')).toBeDefined();
      expect(
        within(rooms).queryByRole('button', { name: `Approve as written: ${TEXT.rooms}` }),
      ).toBeNull();
      // Still changeable while the gate is open.
      expect(within(rooms).getByRole('button', { name: `Remove: ${TEXT.rooms}` })).toBeDefined();
      expect(document.activeElement?.textContent).toBe('Approved as written.');
    });

    it('warns that approving exclusionary wording keeps the checklist failure', async () => {
      mockAudit(serve(auditGate()));
      renderPage(ReviewPage);

      const young = await flagged(`Flagged: ${TEXT.young}`);
      const approve = within(young).getByRole('button', {
        name: `Approve as written: ${TEXT.young}`,
      });
      const note = within(young).getByText(/keeps exclusionary wording/);
      expect(approve.getAttribute('aria-describedby')).toBe(note.id);
    });

    it('edits a claim: sends the new text, shows it, and keeps the original visible', async () => {
      const edited = 'It has 4 rooms.';
      const fetchMock = mockAudit(
        serve(auditGate()),
        putTo(CLAIM.rooms, auditGate({ decisions: { [CLAIM.rooms]: decided.edit(edited) } })),
      );
      renderPage(ReviewPage);

      const rooms = await flagged(`Flagged: ${TEXT.rooms}`);
      fireEvent.click(within(rooms).getByRole('button', { name: `Edit: ${TEXT.rooms}` }));
      const field = within(rooms).getByRole('textbox', { name: `New text for “${TEXT.rooms}”` });
      expect(document.activeElement).toBe(field);
      expect((field as HTMLTextAreaElement).value).toBe(TEXT.rooms);

      fireEvent.change(field, { target: { value: edited } });
      fireEvent.click(within(rooms).getByRole('button', { name: 'Save text' }));

      expect(await within(rooms).findByText('Edited by you.')).toBeDefined();
      expect(bodyOf(calls(fetchMock, 'PUT')[0])).toEqual({ choice: 'edit', text: edited });
      expect(
        within(rooms).getByRole('button', { name: `Show evidence for: ${edited}` }),
      ).toBeDefined();
      expect(within(rooms).getByText(`Original: “${TEXT.rooms}”`)).toBeDefined();
      expect(within(rooms).queryByRole('textbox')).toBeNull();
    });

    it('does not send an empty edit', async () => {
      const fetchMock = mockAudit(serve(auditGate()));
      renderPage(ReviewPage);

      const rooms = await flagged(`Flagged: ${TEXT.rooms}`);
      fireEvent.click(within(rooms).getByRole('button', { name: `Edit: ${TEXT.rooms}` }));
      const field = within(rooms).getByRole('textbox');
      fireEvent.change(field, { target: { value: '   ' } });
      fireEvent.click(within(rooms).getByRole('button', { name: 'Save text' }));

      expect(within(rooms).getByText('Enter the new text, or cancel.')).toBeDefined();
      expect(field.getAttribute('aria-invalid')).toBe('true');
      expect(calls(fetchMock, 'PUT')).toHaveLength(0);
    });

    it('shows the validator findings of a rejected edit at the field and keeps the form open', async () => {
      mockAudit(serve(auditGate()), {
        [`PUT ${claimPath(CLAIM.rooms)}`]: () =>
          jsonResponse(400, {
            error: 'claim_edit_rejected',
            findings: [
              {
                variant: 'portal',
                segmentIndex: 1,
                code: 'number_not_in_facts',
                token: '5 rooms',
                factId: null,
                detail: 'The number "5 rooms" does not match any cited fact.',
              },
            ],
          }),
      });
      renderPage(ReviewPage);

      const rooms = await flagged(`Flagged: ${TEXT.rooms}`);
      fireEvent.click(within(rooms).getByRole('button', { name: `Edit: ${TEXT.rooms}` }));
      const field = within(rooms).getByRole('textbox', { name: `New text for “${TEXT.rooms}”` });
      fireEvent.change(field, { target: { value: 'It has 5 rooms.' } });
      fireEvent.click(within(rooms).getByRole('button', { name: 'Save text' }));

      const finding = await within(rooms).findByText(
        'The number "5 rooms" does not match any cited fact.',
      );
      expect(field.getAttribute('aria-invalid')).toBe('true');
      const errorId = field.getAttribute('aria-describedby')?.split(' ').at(-1);
      expect(errorId).toBeDefined();
      expect(document.getElementById(errorId ?? '')?.contains(finding)).toBe(true);
      // The typed text survives, and the claim stays undecided.
      expect((field as HTMLTextAreaElement).value).toBe('It has 5 rooms.');
      expect(within(rooms).getByText('Needs your decision.')).toBeDefined();
      expect(isDisabled(within(rooms).getByRole('button', { name: 'Save text' }))).toBe(false);

      // The refused save returns focus to the field it disabled.
      expect(document.activeElement).toBe(field);

      fireEvent.click(within(rooms).getByRole('button', { name: 'Cancel' }));
      expect(within(rooms).queryByRole('textbox')).toBeNull();
      // Cancelling clears the refusal instead of turning it into an error banner.
      expect(screen.queryByRole('alert')).toBeNull();
      expect(document.activeElement?.textContent).toBe('Needs your decision.');
    });

    it('removes a claim and shows the missing-required-fact warning at the item and before approving', async () => {
      const fetchMock = mockAudit(
        serve(auditGate()),
        putTo(
          CLAIM.rooms,
          auditGate({
            decisions: { [CLAIM.rooms]: decided.remove },
            warnings: [
              {
                kind: 'market_fact_unmentioned',
                variant: 'portal',
                factKey: 'living_area',
                required: true,
                removedClaimIds: [CLAIM.rooms],
              },
            ],
          }),
        ),
      );
      renderPage(ReviewPage);

      const rooms = await flagged(`Flagged: ${TEXT.rooms}`);
      fireEvent.click(within(rooms).getByRole('button', { name: `Remove: ${TEXT.rooms}` }));

      expect(await within(rooms).findByText('Removed from the pack.')).toBeDefined();
      expect(bodyOf(calls(fetchMock, 'PUT')[0])).toEqual({ choice: 'remove' });
      const line = 'Portal text: the required fact “Living area” is no longer mentioned.';
      const atItem = within(rooms).getByRole('list', { name: 'Warnings for this removal' });
      expect(within(atItem).getByText(line, { exact: false })).toBeDefined();

      const approve = screen.getByRole('region', { name: 'Warnings' });
      expect(within(approve).getByText(line, { exact: false })).toBeDefined();
      // The warning sits in the approve section, above the button it concerns.
      const section = screen
        .getByRole('heading', { level: 2, name: 'Approve the pack' })
        .closest('section');
      expect(section?.contains(approve)).toBe(true);
    });

    it('explains that removing a Q&A answer drops the card, and that its other answer then needs nothing', async () => {
      const fetchMock = mockAudit(
        serve(auditGate()),
        putTo(CLAIM.qaGain, auditGate({ decisions: { [CLAIM.qaGain]: decided.remove } })),
      );
      renderPage(ReviewPage);

      const card = await screen.findByRole('group', {
        name: 'Question 1: Will the flat gain value?',
      });
      const first = within(card).getByRole('group', { name: `Flagged: ${TEXT.qaGain}` });
      expect(within(first).getByText(/drops the whole card, question included/)).toBeDefined();
      fireEvent.click(within(first).getByRole('button', { name: `Remove: ${TEXT.qaGain}` }));

      expect(
        await within(first).findByText('Removed. The whole card is dropped from the pack.'),
      ).toBeDefined();
      expect(bodyOf(calls(fetchMock, 'PUT')[0])).toEqual({ choice: 'remove' });
      expect(within(card).getByText('Dropped: this card is not published.')).toBeDefined();
      const second = within(card).getByRole('group', { name: `Flagged: ${TEXT.qaGainTwo}` });
      expect(within(second).getByText('Not needed: this card is dropped.')).toBeDefined();
      expect(within(second).queryByRole('button', { name: /^Remove:/ })).toBeNull();
      // Three copy claims and the unneeded answer are not counted as open.
      expect(screen.getByText('Flagged claims: 5 (3 open)')).toBeDefined();
    });

    it('shows the buyer Q&A cards with the evidence of their answers, flagged or not', async () => {
      mockAudit(serve(auditGate()));
      renderPage(ReviewPage);

      expect(
        await screen.findByRole('heading', { level: 2, name: 'Buyer questions' }),
      ).toBeDefined();
      const plain = screen.getByRole('group', { name: 'Question 2: How big is it?' });
      fireEvent.click(
        within(plain).getByRole('button', { name: `Show evidence for: ${TEXT.qaSize}` }),
      );
      const panel = screen.getByRole('complementary', { name: `Evidence for “${TEXT.qaSize}”` });
      expect(within(panel).getByText(/about ninety-two square metres/)).toBeDefined();

      const card = screen.getByRole('group', { name: 'Question 1: Will the flat gain value?' });
      expect(within(card).getAllByText('Investment promise')).toHaveLength(2);
    });
  });

  describe('locking while a write is in flight or a text is being edited', () => {
    it('locks an open edit form while another claim is saving, so only one write is sent', async () => {
      let finish: (response: Response) => void = () => undefined;
      const fetchMock = mockAudit(serve(auditGate()), {
        [`PUT ${claimPath(CLAIM.best)}`]: () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      });
      renderPage(ReviewPage);

      const rooms = await flagged(`Flagged: ${TEXT.rooms}`);
      fireEvent.click(within(rooms).getByRole('button', { name: `Edit: ${TEXT.rooms}` }));
      const field = within(rooms).getByRole('textbox');
      fireEvent.change(field, { target: { value: 'It has 4 rooms.' } });
      const save = within(rooms).getByRole('button', { name: 'Save text' });
      expect(isDisabled(save)).toBe(false);

      fireEvent.click(screen.getByRole('button', { name: `Remove: ${TEXT.best}` }));
      await within(screen.getByRole('group', { name: `Flagged: ${TEXT.best}` })).findByText(
        'Saving your decision…',
      );

      expect((field as HTMLTextAreaElement).disabled).toBe(true);
      expect(isDisabled(save)).toBe(true);
      fireEvent.click(save);
      expect(calls(fetchMock, 'PUT')).toHaveLength(1);

      finish(jsonResponse(200, auditGate({ decisions: { [CLAIM.best]: decided.remove } })));
      await waitFor(() => {
        expect(isDisabled(within(rooms).getByRole('button', { name: 'Save text' }))).toBe(false);
      });
      // The typed draft survived the wait.
      expect(within(rooms).getByRole<HTMLTextAreaElement>('textbox').value).toBe('It has 4 rooms.');
    });

    it('keeps Approve pack disabled while a text is being edited, and enables it after Cancel', async () => {
      const fetchMock = mockAudit(serve(allDecided()));
      renderPage(ReviewPage);

      const approve = await screen.findByRole('button', { name: 'Approve pack' });
      expect(isDisabled(approve)).toBe(false);

      const rooms = screen.getByRole('group', { name: `Flagged: ${TEXT.rooms}` });
      fireEvent.click(within(rooms).getByRole('button', { name: `Edit: ${TEXT.rooms}` }));
      expect(isDisabled(approve)).toBe(true);
      expect(screen.getByText('Save or cancel the text you are editing first.')).toBeDefined();
      fireEvent.click(approve);
      expect(calls(fetchMock, 'POST')).toHaveLength(0);

      fireEvent.click(within(rooms).getByRole('button', { name: 'Cancel' }));
      expect(isDisabled(screen.getByRole('button', { name: 'Approve pack' }))).toBe(false);
      expect(screen.queryByText('Save or cancel the text you are editing first.')).toBeNull();
    });
  });

  describe('evidence panel details', () => {
    it('closes on Escape from anywhere, but not when Escape is for the larger-photo dialog', async () => {
      mockAudit(serve(auditGate()));
      renderPage(ReviewPage);
      await screen.findByRole('heading', { level: 1, name: 'Review the pack' });

      fireEvent.click(segmentButton(TEXT.rooms));
      const panel = screen.getByRole('complementary', { name: `Evidence for “${TEXT.rooms}”` });
      fireEvent.click(within(panel).getByRole('button', { name: 'Open larger photo for Rooms' }));
      const dialog = document.querySelector('dialog');
      expect(dialog?.hasAttribute('open')).toBe(true);

      fireEvent.keyDown(dialog as HTMLElement, { key: 'Escape' });
      expect(screen.getByRole('complementary')).toBeDefined();

      dialog?.removeAttribute('open');
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(screen.queryByRole('complementary')).toBeNull();
    });

    it('shows a visible line when a cited fact is missing from the review', async () => {
      const gate = auditGate();
      mockAudit(serve({ ...gate, facts: gate.facts.filter((f) => f.id !== CFACT.areaTurn) }));
      renderPage(ReviewPage);
      await screen.findByRole('heading', { level: 1, name: 'Review the pack' });

      fireEvent.click(segmentButton(TEXT.rooms));
      const panel = screen.getByRole('complementary', { name: `Evidence for “${TEXT.rooms}”` });
      expect(within(panel).getByText('This segment cites 2 facts.')).toBeDefined();
      expect(within(panel).getByText(/Missing evidence:/).textContent).toContain(CFACT.areaTurn);
      expect(within(panel).getByRole('img', { name: 'Photo evidence for Rooms' })).toBeDefined();
    });
  });

  describe('staged images', () => {
    it('shows the original and the staged image side by side with the disclosure label', async () => {
      mockAudit(serve(auditGate()));
      renderPage(ReviewPage);

      const card = await screen.findByRole('group', {
        name: 'Staged image: Furnish living room (photo 1)',
      });
      const original = within(card).getByRole('img', {
        name: 'Original photo for Furnish living room (photo 1)',
      });
      const staged = within(card).getByRole('img', {
        name: 'Staged version for Furnish living room (photo 1)',
      });
      expect(original.getAttribute('src')).toMatch(
        new RegExp(`^/api/runs/${RUN_ID}/materials/[0-9a-f-]+/file$`),
      );
      expect(staged.getAttribute('src')).toBe(`/api/runs/${RUN_ID}/artifacts/${STAGED_ID}/file`);
      // The disclosure label is the caption of the staged image itself.
      const caption = within(card).getByText('Virtually staged');
      expect(caption.tagName).toBe('FIGCAPTION');
      expect(caption.closest('figure')?.contains(staged)).toBe(true);
      expect(within(card).getByText('Original')).toBeDefined();
      expect(within(card).getByText(/Integrity check passed on the second attempt/)).toBeDefined();
      expect(within(card).getByText(/Accept publishes the staged image/)).toBeDefined();
      // Both figures share one grid row on a wide screen.
      expect(original.closest('div')).toBe(staged.closest('div'));

      expect(
        within(card).getByText('Outcome: passed on the second attempt.', { exact: false }),
      ).toBeDefined();
      expect(within(card).getByText('Needs your decision.')).toBeDefined();
    });

    it('accepts a staged image and rejects it again', async () => {
      const accepted = auditGate({ image: 'accept' });
      const rejected = auditGate({ image: 'reject' });
      let answer = accepted;
      const fetchMock = mockAudit(serve(auditGate()), {
        [`PUT ${imagePath(STAGED_ID)}`]: () => jsonResponse(200, answer),
      });
      renderPage(ReviewPage);

      const card = await screen.findByRole('group', {
        name: 'Staged image: Furnish living room (photo 1)',
      });
      fireEvent.click(
        within(card).getByRole('button', {
          name: 'Accept staged image: Furnish living room (photo 1)',
        }),
      );
      expect(
        await within(card).findByText(
          'Accepted: the staged image is published next to the original.',
        ),
      ).toBeDefined();
      expect(bodyOf(calls(fetchMock, 'PUT')[0])).toEqual({ choice: 'accept' });
      expect(calls(fetchMock, 'PUT')[0]?.[0]).toBe(imagePath(STAGED_ID));
      expect(document.activeElement?.textContent).toContain('Accepted');

      answer = rejected;
      fireEvent.click(
        within(card).getByRole('button', {
          name: 'Reject staged image: Furnish living room (photo 1)',
        }),
      );
      expect(
        await within(card).findByText('Rejected: only the original is published.'),
      ).toBeDefined();
      expect(bodyOf(calls(fetchMock, 'PUT')[1])).toEqual({ choice: 'reject' });
    });

    it('lists a photo whose staging the integrity check rejected with the original only', async () => {
      const gate = auditGate();
      const withFallback = {
        ...gate,
        images: [],
        counts: { ...gate.counts, offeredImages: 0, openImages: 0 },
        openCount: gate.counts.openClaims,
        integrityFallbacks: [
          {
            materialId: MATERIAL_ID,
            operationId: 'declutter' as const,
            attempts: [
              {
                attempt: 1 as const,
                status: 'edit_failed' as const,
                stagedArtifactId: null,
                passed: false,
                failedClasses: [],
                privacyPassed: null,
                target: null,
                reason: null,
              },
            ],
          },
        ],
      };
      mockAudit(serve(withFallback));
      renderPage(ReviewPage);

      expect(
        await screen.findByRole('heading', {
          level: 3,
          name: 'Staging rejected by the integrity check',
        }),
      ).toBeDefined();
      expect(
        screen.getByRole('img', { name: 'Original photo for Declutter (rejected)' }),
      ).toBeDefined();
      expect(screen.queryByRole('img', { name: /^Staged version/ })).toBeNull();
      expect(screen.queryByRole('button', { name: /^Accept staged image/ })).toBeNull();
    });
  });

  describe('approving the pack', () => {
    it('keeps Approve pack disabled while items are open and says what is open', async () => {
      const fetchMock = mockAudit(
        serve(auditGate({ decisions: { [CLAIM.rooms]: decided.accept } })),
      );
      renderPage(ReviewPage);

      const section = (
        await screen.findByRole('heading', { level: 2, name: 'Approve the pack' })
      ).closest('section') as HTMLElement;
      expect(isDisabled(within(section).getByRole('button', { name: 'Approve pack' }))).toBe(true);
      expect(within(section).getByText('Still open before you can approve:')).toBeDefined();
      expect(within(section).getByText('4 flagged claims')).toBeDefined();
      expect(within(section).getByText('1 staged image')).toBeDefined();
      expect(calls(fetchMock, 'POST')).toHaveLength(0);
    });

    it('approves once everything is decided, resumes the run, and refreshes the monitor snapshot', async () => {
      const released = allDecided({ state: 'released' });
      let runReads = 0;
      const fetchMock = mockAudit(
        serve(allDecided()),
        { [`POST ${APPROVE_PATH}`]: () => jsonResponse(200, released) },
        () => {
          runReads += 1;
          return jsonResponse(200, runSnapshot());
        },
      );
      renderPage(ReviewPage);

      const button = await screen.findByRole('button', { name: 'Approve pack' });
      expect((button as HTMLButtonElement).disabled).toBe(false);
      await waitFor(() => {
        expect(runReads).toBe(1);
      });
      fireEvent.click(button);

      await waitFor(() => {
        expect(mockRouter.push).toHaveBeenCalledWith(`/runs/${RUN_ID}`);
      });
      expect(calls(fetchMock, 'POST')).toHaveLength(1);
      expect(calls(fetchMock, 'POST')[0]?.[0]).toBe(APPROVE_PATH);
      // The whole gate came back and replaced the cache; the monitor's cached run was refetched.
      expect(
        await screen.findByText('This review is finished. Your decisions are shown below.'),
      ).toBeDefined();
      expect(screen.queryByRole('button', { name: 'Approve pack' })).toBeNull();
      await waitFor(() => {
        expect(runReads).toBe(2);
      });
      expect(getsOf(fetchMock, GATE_PATH)).toBe(1);
    });

    it('handles a 409 for items still undecided by showing what is open', async () => {
      let reads = 0;
      mockAudit(
        () => {
          reads += 1;
          // The page believed everything was decided; the server knows one more is open.
          return jsonResponse(
            200,
            reads === 1
              ? allDecided()
              : auditGate({
                  image: 'accept',
                  decisions: {
                    [CLAIM.rooms]: decided.accept,
                    [CLAIM.young]: decided.accept,
                    [CLAIM.best]: decided.accept,
                    [CLAIM.qaGain]: decided.accept,
                  },
                }),
          );
        },
        { [`POST ${APPROVE_PATH}`]: () => jsonResponse(409, { error: 'gate_decisions_pending' }) },
      );
      renderPage(ReviewPage);

      fireEvent.click(await screen.findByRole('button', { name: 'Approve pack' }));

      expect(
        await screen.findByText(
          'Something still needs a decision, so the pack was not approved. The page now shows what is open.',
        ),
      ).toBeDefined();
      await waitFor(() => {
        expect(screen.getByText('Still open before you can approve:')).toBeDefined();
      });
      expect(reads).toBe(2);
      expect(mockRouter.push).not.toHaveBeenCalled();
      expect(isDisabled(screen.getByRole('button', { name: 'Approve pack' }))).toBe(true);
    });
  });

  describe('one decision at a time', () => {
    it('disables every other decision while one is saving and sends a single request', async () => {
      let finish: (response: Response) => void = () => undefined;
      const fetchMock = mockAudit(serve(auditGate()), {
        [`PUT ${claimPath(CLAIM.rooms)}`]: () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      });
      renderPage(ReviewPage);

      const rooms = await flagged(`Flagged: ${TEXT.rooms}`);
      const remove = within(rooms).getByRole('button', { name: `Remove: ${TEXT.rooms}` });
      fireEvent.click(remove);

      expect(await within(rooms).findByText('Saving your decision…')).toBeDefined();
      const others = [
        screen.getByRole('button', { name: `Remove: ${TEXT.best}` }),
        screen.getByRole('button', { name: `Edit: ${TEXT.young}` }),
        screen.getByRole('button', { name: 'Accept staged image: Furnish living room (photo 1)' }),
        screen.getByRole('button', { name: 'Approve pack' }),
        remove,
      ];
      for (const button of others) expect((button as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(remove);
      fireEvent.click(others[0] as HTMLElement);
      expect(calls(fetchMock, 'PUT')).toHaveLength(1);

      finish(jsonResponse(200, auditGate({ decisions: { [CLAIM.rooms]: decided.remove } })));
      await waitFor(() => {
        expect(isDisabled(screen.getByRole('button', { name: `Remove: ${TEXT.best}` }))).toBe(
          false,
        );
      });
    });
  });

  describe('gate states', () => {
    it('says the run has not reached the review yet, without any copy', async () => {
      mockAudit(serve(auditGate({ state: 'not_reached' })));
      renderPage(ReviewPage);

      expect(await screen.findByText(/The run has not reached this review yet/)).toBeDefined();
      expect(screen.queryByRole('heading', { name: 'Copy' })).toBeNull();
      expect(screen.queryByRole('button', { name: /Approve|Remove|Edit/ })).toBeNull();
    });

    it('shows a released review read-only with the decisions and a link to the pack', async () => {
      mockAudit(
        serve(
          allDecided({
            state: 'released',
            decisions: { [CLAIM.rooms]: decided.edit('It has 4 rooms.') },
          }),
        ),
      );
      renderPage(ReviewPage);

      expect(
        await screen.findByText('This review is finished. Your decisions are shown below.'),
      ).toBeDefined();
      expect(screen.getByRole('link', { name: 'Open the pack' }).getAttribute('href')).toBe(
        `/runs/${RUN_ID}/pack`,
      );
      const rooms = screen.getByRole('group', { name: `Flagged: ${TEXT.rooms}` });
      expect(within(rooms).getByText('Edited by you.')).toBeDefined();
      expect(
        screen.queryByRole('button', { name: /^(Approve|Edit|Remove|Accept|Reject)/ }),
      ).toBeNull();
      expect(screen.queryByRole('heading', { name: 'Approve the pack' })).toBeNull();
      // The evidence stays one click away.
      fireEvent.click(segmentButton(TEXT.area));
      expect(screen.getByRole('complementary')).toBeDefined();
    });

    it('shows a suspended review read-only and explains how to reopen it', async () => {
      mockAudit(
        serve(auditGate({ state: 'suspended', decisions: { [CLAIM.rooms]: decided.accept } })),
      );
      renderPage(ReviewPage);

      expect((await screen.findByRole('alert')).textContent).toContain('decisions are paused');
      expect(
        screen.queryByRole('button', { name: /^(Approve|Edit|Remove|Accept|Reject)/ }),
      ).toBeNull();
      expect(
        within(screen.getByRole('group', { name: `Flagged: ${TEXT.rooms}` })).getByText(
          'Approved as written.',
        ),
      ).toBeDefined();
    });

    it('shows the not-found state for a run that does not exist', async () => {
      mockAudit(() => jsonResponse(404, { error: 'not_found' }));
      renderPage(ReviewPage);

      expect(await screen.findByText(/^This run was not found\./)).toBeDefined();
      expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    });

    it('shows a loading status before the review arrives', async () => {
      mockAudit(serve(auditGate()));
      renderPage(ReviewPage);

      expect(await screen.findByText('Loading the review…')).toBeDefined();
      expect(
        await screen.findByRole('heading', { level: 1, name: 'Review the pack' }),
      ).toBeDefined();
    });

    it('offers a retry after a load error and shows the review when it works', async () => {
      let reads = 0;
      mockAudit(() => {
        reads += 1;
        return reads === 1
          ? jsonResponse(500, { error: 'internal_error' })
          : jsonResponse(200, auditGate());
      });
      renderPage(ReviewPage);

      expect((await screen.findByRole('alert')).textContent).toContain(
        'We could not load the review.',
      );
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      expect(
        await screen.findByRole('heading', { level: 1, name: 'Review the pack' }),
      ).toBeDefined();
      expect(reads).toBe(2);
    });

    it('sends a signed-out visitor to log in again with the way back', async () => {
      mockAudit(() => jsonResponse(401, { error: 'unauthenticated' }));
      renderPage(ReviewPage);

      const link = await screen.findByRole('link', { name: 'Log in again' });
      expect(decodeURIComponent(link.getAttribute('href') ?? '')).toContain(
        `/runs/${RUN_ID}/review`,
      );
    });
  });

  it('shows the not-found state for a malformed run ID without calling the API', async () => {
    setRoute('/runs/not-a-uuid/review?runId=not-a-uuid');
    const fetchMock = mockAudit(serve(auditGate()));
    renderPage(ReviewPage);

    expect(await screen.findByText(/^This run was not found\./)).toBeDefined();
    expect(getsOf(fetchMock, GATE_PATH)).toBe(0);
  });
});
