import { runExportResponseSchema, type RunExportResponse } from '@evidomo/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import RunPackPage from '../pages/runs/[runId]/pack';
import { mockRouter, setRoute } from './router-mock';
import { jsonResponse, meSignedIn, mockFetch, renderPage } from './test-utils';

vi.mock('next/router', () => import('./router-mock'));

const RUN_ID = '0b9f7c1e-5d2a-4e8b-9c3d-1a2b3c4d5e6f';
const HTML_ID = '11111111-1111-4111-8111-111111111111';
const JSON_ID = '22222222-2222-4222-8222-222222222222';
const IMAGE_ID = '33333333-3333-4333-8333-333333333333';
const STAGED_ID = '44444444-4444-4444-8444-444444444444';
const SHA = 'a'.repeat(64);
const EXPORT_PATH = `/api/runs/${RUN_ID}/export`;
const fileUrl = (id: string): string => `${EXPORT_PATH}/files/${id}`;

function file(
  artifactId: string,
  role: 'html' | 'portal_fields' | 'image',
  fileName: string,
  mimeType: string,
  sizeBytes: number,
) {
  return {
    artifactId,
    role,
    fileName,
    mimeType,
    sizeBytes,
    sha256: SHA,
    url: fileUrl(artifactId),
    downloadUrl: `${fileUrl(artifactId)}?download=1`,
  };
}

function manifest(readyToPublish: boolean): RunExportResponse {
  return runExportResponseSchema.parse({
    runId: RUN_ID,
    manifestArtifactId: '55555555-5555-4555-8555-555555555555',
    approvedPackArtifactId: '66666666-6666-4666-8666-666666666666',
    readyToPublish,
    counts: {
      images: 2,
      originals: 1,
      staged: 1,
      blurredImages: 0,
      blurredRegions: 0,
      withheld: 0,
    },
    files: [
      file(HTML_ID, 'html', 'listing-pack.html', 'text/html', 2_411_008),
      file(JSON_ID, 'portal_fields', 'portal-fields.json', 'application/json', 4_300),
      file(IMAGE_ID, 'image', 'photo-01.jpg', 'image/jpeg', 612),
      file(STAGED_ID, 'image', 'photo-01-staged.jpg', 'image/jpeg', 98_304),
    ],
  });
}

async function openPack(response: Response): Promise<void> {
  setRoute(`/runs/${RUN_ID}/pack`);
  mockRouter.query = { runId: RUN_ID };
  mockFetch({ 'GET /api/auth/me': meSignedIn, [`GET ${EXPORT_PATH}`]: () => response });
  renderPage(RunPackPage);
  await screen.findByRole('heading', { level: 1, name: 'Listing pack' });
  await screen.findByRole('heading', { level: 2, name: 'Preview' });
}

describe('pack viewer', () => {
  it('renders the pack in a tightly sandboxed iframe', async () => {
    await openPack(jsonResponse(200, manifest(true)));

    const frame = await screen.findByTitle<HTMLIFrameElement>('Listing pack preview');
    expect(frame.getAttribute('src')).toBe(fileUrl(HTML_ID));
    expect(frame.getAttribute('sandbox')).toBe('allow-same-origin allow-modals');
    expect(screen.getByRole('status').textContent).toContain('Ready to publish');
    expect(screen.queryByText('Not ready to publish')).toBeNull();
  });

  it('warns prominently when the pack is not ready to publish', async () => {
    await openPack(jsonResponse(200, manifest(false)));

    const warning = await screen.findByRole('alert');
    expect(within(warning).getByRole('heading', { name: 'Not ready to publish' })).toBeDefined();
    // The pack is still viewable: the failing checks are inside it.
    expect(screen.getByTitle('Listing pack preview')).toBeDefined();
  });

  it('links each file to its download URL, with names and sizes', async () => {
    await openPack(jsonResponse(200, manifest(true)));

    const href = (name: string): string | null =>
      screen.getByRole('link', { name }).getAttribute('href');
    expect(href('Download listing-pack.html')).toBe(`${fileUrl(HTML_ID)}?download=1`);
    expect(href('Download portal-fields.json')).toBe(`${fileUrl(JSON_ID)}?download=1`);
    expect(href('Download photo-01.jpg')).toBe(`${fileUrl(IMAGE_ID)}?download=1`);
    expect(href('Download photo-01-staged.jpg')).toBe(`${fileUrl(STAGED_ID)}?download=1`);
    expect(screen.getByText(/Listing pack \(HTML\) · 2\.3 MB/)).toBeDefined();
    expect(screen.getByText(/Portal fields \(JSON\) · 4\.2 KB/)).toBeDefined();
    expect(screen.getByText(/Image · 612 B/)).toBeDefined();
    expect(screen.getByText('Images (2)')).toBeDefined();
  });

  it('opens the pack full screen in a new tab for small screens', async () => {
    await openPack(jsonResponse(200, manifest(true)));

    const link = screen.getByRole('link', { name: 'Open full screen' });
    expect(link.getAttribute('href')).toBe(fileUrl(HTML_ID));
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('prints the framed pack', async () => {
    await openPack(jsonResponse(200, manifest(true)));
    const frame = screen.getByTitle<HTMLIFrameElement>('Listing pack preview');
    const print = vi.fn();
    Object.defineProperty(frame, 'contentWindow', {
      value: { focus: vi.fn(), print },
      configurable: true,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Print / Save as PDF' }));

    expect(print).toHaveBeenCalledOnce();
  });

  it('falls back to a new tab when printing the frame is refused', async () => {
    await openPack(jsonResponse(200, manifest(true)));
    const frame = screen.getByTitle<HTMLIFrameElement>('Listing pack preview');
    Object.defineProperty(frame, 'contentWindow', {
      value: {
        focus: vi.fn(),
        print: () => {
          throw new DOMException('blocked', 'SecurityError');
        },
      },
      configurable: true,
    });
    const open = vi.spyOn(window, 'open').mockReturnValue(null);

    fireEvent.click(screen.getByRole('button', { name: 'Print / Save as PDF' }));

    expect(open).toHaveBeenCalledWith(fileUrl(HTML_ID), '_blank', 'noopener');
    open.mockRestore();
  });

  it('says the pack is not ready yet on 409, with a way back to the run', async () => {
    setRoute(`/runs/${RUN_ID}/pack`);
    mockRouter.query = { runId: RUN_ID };
    mockFetch({
      'GET /api/auth/me': meSignedIn,
      [`GET ${EXPORT_PATH}`]: () => jsonResponse(409, { error: 'export_not_ready' }),
    });
    renderPage(RunPackPage);

    const notice = await screen.findByText(/The pack is not ready yet/);
    const back = within(notice.closest('[role=status]') as HTMLElement).getByRole('link', {
      name: 'Back to the run',
    });
    expect(back.getAttribute('href')).toBe(`/runs/${RUN_ID}`);
    expect(screen.queryByTitle('Listing pack preview')).toBeNull();
  });

  it('reports a run that does not exist on 404', async () => {
    setRoute(`/runs/${RUN_ID}/pack`);
    mockRouter.query = { runId: RUN_ID };
    mockFetch({
      'GET /api/auth/me': meSignedIn,
      [`GET ${EXPORT_PATH}`]: () => jsonResponse(404, { error: 'not_found' }),
    });
    renderPage(RunPackPage);

    expect(await screen.findByText(/This run was not found/)).toBeDefined();
  });

  it('offers a retry on a server error', async () => {
    setRoute(`/runs/${RUN_ID}/pack`);
    mockRouter.query = { runId: RUN_ID };
    let calls = 0;
    mockFetch({
      'GET /api/auth/me': meSignedIn,
      [`GET ${EXPORT_PATH}`]: () => {
        calls += 1;
        return calls < 4
          ? jsonResponse(500, { error: 'internal_error' })
          : jsonResponse(200, manifest(true));
      },
    });
    renderPage(RunPackPage);

    // The query retries twice by itself, then the explicit button.
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }, { timeout: 5000 }));
    await waitFor(() => expect(screen.getByTitle('Listing pack preview')).toBeDefined());
  });

  it('shows a loading status, then offers a login link when the session expired', async () => {
    setRoute(`/runs/${RUN_ID}/pack`);
    mockRouter.query = { runId: RUN_ID };
    mockFetch({
      'GET /api/auth/me': meSignedIn,
      [`GET ${EXPORT_PATH}`]: () => jsonResponse(401, { error: 'unauthenticated' }),
    });
    renderPage(RunPackPage);

    expect(await screen.findByText('Loading the pack…')).toBeDefined();
    const link = await screen.findByRole('link', { name: 'Log in again' });
    expect(link.getAttribute('href')).toBe(
      `/login?next=${encodeURIComponent(`/runs/${RUN_ID}/pack`)}`,
    );
  });
});
