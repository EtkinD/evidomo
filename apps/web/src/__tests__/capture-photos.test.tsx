import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uploadTiming } from '../lib/capture';
import CapturePage from '../pages/projects/[projectId]/capture';
import {
  FakeProject,
  imageFile,
  stubImages,
  stubObjectUrls,
  stubXhr,
  type UploadRecord,
  type XhrResult,
} from './capture-helpers';
import { PROJECT_ID } from './project-fixtures';
import { mockRouter, setRoute } from './router-mock';
import { jsonResponse, meSignedIn, mockFetch, renderPage } from './test-utils';

vi.mock('next/router', () => import('./router-mock'));

const PHOTO_URL = `/api/projects/${PROJECT_ID}/materials/photos`;

let project: FakeProject;
let urls: ReturnType<typeof stubObjectUrls>;
const DEFAULT_TIMING = { ...uploadTiming };

beforeEach(() => {
  project = new FakeProject();
  urls = stubObjectUrls();
  // No real waiting: the backoff and Retry-After floor are the product's, not the test's.
  uploadTiming.backoffMs = [0, 0, 0];
  uploadTiming.minBusyMs = 0;
});

afterEach(() => {
  Object.assign(uploadTiming, DEFAULT_TIMING);
  vi.restoreAllMocks();
});

/** Stores the upload as the project's next photo, like the real route. */
function accept(upload: UploadRecord): XhrResult {
  if (upload.url !== PHOTO_URL) return { status: 404, body: { error: 'not_found' } };
  return { status: 201, body: { material: project.addPhoto() } };
}

async function openPage(
  extraRoutes: Parameters<typeof mockFetch>[0] = {},
): Promise<ReturnType<typeof mockFetch> & { unmount: () => void }> {
  setRoute(`/projects/${PROJECT_ID}/capture`);
  mockRouter.query = { projectId: PROJECT_ID };
  const fetchMock = mockFetch({
    'GET /api/auth/me': meSignedIn,
    [`GET /api/projects/${PROJECT_ID}`]: () => jsonResponse(200, project.detail()),
    ...extraRoutes,
  });
  const { unmount } = renderPage(CapturePage);
  await screen.findByRole('heading', { name: 'Photos' });
  return Object.assign(fetchMock, { unmount });
}

function choose(files: File[]): void {
  fireEvent.change(screen.getByLabelText('Photo files'), { target: { files } });
}

describe('photo capture', () => {
  it('downscales each photo, uploads them one at a time in the chosen order, and shows them', async () => {
    const images = stubImages(4000, 3000);
    const xhr = stubXhr((upload) => accept(upload));
    await openPage();

    choose([imageFile('a.jpg'), imageFile('b.jpg'), imageFile('c.jpg')]);

    await screen.findByText('3 photos uploaded.');
    // Order is commit order: the bodies are the downscaled photos, in the order chosen.
    const bodies = await Promise.all(xhr.uploads.map((upload) => upload.blob.text()));
    expect(bodies).toEqual(['a.jpg', 'b.jpg', 'c.jpg']);
    expect(xhr.maxInFlight()).toBe(1);
    expect(xhr.uploads.map((upload) => upload.contentType)).toEqual([
      'image/jpeg',
      'image/jpeg',
      'image/jpeg',
    ]);
    expect(xhr.uploads.every((upload) => upload.method === 'POST')).toBe(true);

    // 4000x3000 fits to a 2048 long edge, encoded as JPEG at 0.85, EXIF applied by the decoder.
    expect(images.canvases).toEqual([
      { width: 2048, height: 1536 },
      { width: 2048, height: 1536 },
      { width: 2048, height: 1536 },
    ]);
    expect(images.toBlobCalls[0]).toEqual({ type: 'image/jpeg', quality: 0.85 });
    expect(images.bitmapOptions[0]).toEqual({ imageOrientation: 'from-image' });

    const grid = screen.getByRole('list', { name: 'Photos' });
    const tiles = within(grid).getAllByRole('listitem');
    expect(tiles).toHaveLength(3);
    expect(within(grid).getByText('Photo 3')).toBeDefined();
    expect(screen.getByText('3 of 30 photos')).toBeDefined();
    expect(screen.getByText('Enough photos')).toBeDefined();
  });

  it('shows the server reason for a refused photo, skips it, and keeps uploading the rest', async () => {
    stubImages();
    const xhr = stubXhr((upload, index) =>
      index === 0
        ? { status: 422, body: { error: 'upload_rejected', reason: 'undecodable' } }
        : accept(upload),
    );
    await openPage();

    choose([imageFile('broken.jpg'), imageFile('fine.jpg')]);

    await screen.findByText('1 photo uploaded. 1 photo skipped.');
    // A refusal is not retried: it would only repeat.
    expect(xhr.uploads).toHaveLength(2);
    expect(
      screen.getByText('Skipped: The file could not be read. It may be damaged.'),
    ).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Retry broken.jpg' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Remove broken.jpg' }));
    expect(screen.queryByText('broken.jpg')).toBeNull();
    // Removing the tile moved focus to a control that still exists.
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Photos' }));
  });

  it('waits for Retry-After on 429 and then uploads the same photo', async () => {
    stubImages();
    const xhr = stubXhr((upload, index) =>
      index === 0
        ? { status: 429, body: { error: 'too_many_uploads' }, headers: { 'Retry-After': '0' } }
        : accept(upload),
    );
    await openPage();

    choose([imageFile('a.jpg')]);

    await screen.findByText('1 photo uploaded.');
    expect(xhr.uploads).toHaveLength(2);
    expect(await xhr.uploads[1]?.blob.text()).toBe('a.jpg');
    expect(screen.queryByText(/Skipped|paused/)).toBeNull();
  });

  it('shows the busy state and lets the user skip the waiting photo', async () => {
    stubImages();
    const xhr = stubXhr((upload, index) =>
      index === 0
        ? { status: 429, body: { error: 'too_many_uploads' }, headers: { 'Retry-After': '30' } }
        : accept(upload),
    );
    await openPage();

    choose([imageFile('a.jpg'), imageFile('b.jpg')]);

    await screen.findByText('Server busy, trying again shortly…');
    expect(screen.getByText('The server is busy. Retrying in 30 seconds.')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Skip a.jpg' }));

    await screen.findByText('1 photo uploaded. 1 photo skipped.');
    expect(await Promise.all(xhr.uploads.map((upload) => upload.blob.text()))).toEqual([
      'a.jpg',
      'b.jpg',
    ]);
  });

  it('retries a transient failure by itself and keeps the chosen order', async () => {
    const images = stubImages();
    const xhr = stubXhr((upload, index) =>
      index === 0 ? { status: 0, networkError: true } : accept(upload),
    );
    await openPage();

    choose([imageFile('a.jpg'), imageFile('b.jpg'), imageFile('c.jpg')]);

    await screen.findByText('3 photos uploaded.');
    // A failed once, was retried before B started, and is not prepared a second time.
    expect(await Promise.all(xhr.uploads.map((upload) => upload.blob.text()))).toEqual([
      'a.jpg',
      'a.jpg',
      'b.jpg',
      'c.jpg',
    ]);
    expect(images.canvases).toHaveLength(3);
    expect(project.photos.map((photo) => photo.position)).toEqual([1, 2, 3]);
  });

  it('treats a 5xx answer as transient', async () => {
    stubImages();
    const xhr = stubXhr((upload, index) =>
      index === 0 ? { status: 503, body: { error: 'internal_error' } } : accept(upload),
    );
    await openPage();

    choose([imageFile('a.jpg')]);

    await screen.findByText('1 photo uploaded.');
    expect(xhr.uploads).toHaveLength(2);
  });

  describe('when a photo keeps failing', () => {
    // Every attempt of A fails: the first try and three automatic retries.
    const failA = (upload: UploadRecord, index: number, healed: { value: boolean }): XhrResult =>
      index < 4 && !healed.value ? { status: 0, networkError: true } : accept(upload);

    it('pauses the queue so later photos cannot overtake it, and Retry resumes in order', async () => {
      stubImages();
      const healed = { value: false };
      const xhr = stubXhr((upload, index) => failA(upload, index, healed));
      await openPage();

      choose([imageFile('a.jpg'), imageFile('b.jpg'), imageFile('c.jpg')]);

      await screen.findByText(/Upload paused: Could not reach Evidomo/);
      expect(xhr.uploads).toHaveLength(4);
      expect(screen.getAllByText('Waiting to upload')).toHaveLength(2);
      expect(screen.getByText('Upload paused on a.jpg.', { exact: false })).toBeDefined();

      healed.value = true;
      fireEvent.click(screen.getByRole('button', { name: 'Retry a.jpg' }));

      // Each photo counts once: the retry does not add to the batch.
      await screen.findByText('3 photos uploaded.');
      const bodies = await Promise.all(xhr.uploads.map((upload) => upload.blob.text()));
      expect(bodies.slice(4)).toEqual(['a.jpg', 'b.jpg', 'c.jpg']);
    });

    it('Skip gives up on the photo and the rest carry on', async () => {
      stubImages();
      const xhr = stubXhr((upload, index) => failA(upload, index, { value: false }));
      await openPage();

      choose([imageFile('a.jpg'), imageFile('b.jpg'), imageFile('c.jpg')]);
      await screen.findByText(/Upload paused: Could not reach/);
      fireEvent.click(screen.getByRole('button', { name: 'Skip a.jpg' }));

      await screen.findByText('2 photos uploaded. 1 photo skipped.');
      const bodies = await Promise.all(xhr.uploads.map((upload) => upload.blob.text()));
      expect(bodies.slice(4)).toEqual(['b.jpg', 'c.jpg']);
    });
  });

  it('stops at the service maximum and tells the uploader', async () => {
    stubImages();
    project.photoMax = 2;
    project.addPhoto();
    await openPage();
    const xhr = stubXhr((upload) => accept(upload));

    choose([imageFile('a.jpg'), imageFile('b.jpg'), imageFile('c.jpg')]);

    await screen.findByText('1 photo uploaded.');
    expect(xhr.uploads).toHaveLength(1);
    expect(
      screen.getByText('2 photos not added: the project can hold no more photos.'),
    ).toBeDefined();
    expect(screen.getByRole('button', { name: 'Choose photos' }).hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('stops the queue when the server reports the maximum', async () => {
    stubImages();
    const xhr = stubXhr(() => ({ status: 409, body: { error: 'photo_limit_reached' } }));
    await openPage();

    choose([imageFile('a.jpg'), imageFile('b.jpg')]);

    await waitFor(() => {
      expect(screen.getAllByText('Skipped: The maximum number of photos is reached.')).toHaveLength(
        2,
      );
    });
    expect(xhr.uploads).toHaveLength(1);
  });

  it('deletes a photo and refreshes the count', async () => {
    const first = project.addPhoto();
    project.addPhoto();
    project.addPhoto();
    const fetchMock = await openPage({
      [`DELETE /api/projects/${PROJECT_ID}/materials/${first.id}`]: () => {
        project.deletePhoto(first.id);
        return new Response(null, { status: 204 });
      },
    });
    expect(screen.getByText('Enough photos')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Delete photo 1' }));

    await waitFor(() => expect(screen.queryByText('Enough photos')).toBeNull());
    expect(screen.getByText('2 of 30 photos')).toBeDefined();
    expect(screen.getByText('Photo 1 deleted. 2 photos left.')).toBeDefined();
    // Positions are renumbered by the server.
    expect(screen.queryByRole('button', { name: 'Delete photo 3' })).toBeNull();
    const methods = fetchMock.mock.calls.map(([, init]) => init?.method ?? 'GET');
    expect(methods).toContain('DELETE');
  });

  it('is read-only while inputs are locked', async () => {
    project.addPhoto();
    project.locked = true;
    await openPage();

    expect(screen.getByText(/the photos are locked/)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Choose photos' })).toBeNull();
    expect(screen.queryByLabelText('Photo files')).toBeNull();
    expect(screen.queryByRole('button', { name: /Delete photo/ })).toBeNull();
    expect(screen.getByAltText('Photo 1')).toBeDefined();
  });

  it('keeps the tile when a stored photo has no file to show', async () => {
    project.addPhoto();
    await openPage();

    fireEvent.error(screen.getByAltText('Photo 1'));

    expect(screen.getByText('Preview unavailable')).toBeDefined();
    expect(screen.getByText('Photo 1')).toBeDefined();
  });

  it('points a stored photo at the file endpoint', async () => {
    const material = project.addPhoto();
    await openPage();

    expect(screen.getByAltText('Photo 1').getAttribute('src')).toBe(
      `/api/projects/${PROJECT_ID}/materials/${material.id}/file`,
    );
  });

  it('explains an unreadable HEIC photo', async () => {
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(() => Promise.reject(new Error('cannot decode'))),
    );
    class FailingImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onerror?.());
      }
    }
    vi.stubGlobal('Image', FailingImage);
    const xhr = stubXhr((upload) => accept(upload));
    await openPage();

    choose([imageFile('IMG_0001.HEIC', 'image/heic')]);

    expect(await screen.findByText(/This browser cannot read HEIC photos/)).toBeDefined();
    expect(xhr.uploads).toHaveLength(0);
  });

  it('shows the camera action only for touch devices and marks it as a camera capture', async () => {
    await openPage();

    const camera = screen.getByLabelText('Camera');
    expect(camera.getAttribute('capture')).toBe('environment');
    expect(camera.getAttribute('accept')).toBe('image/*');
    const picker = screen.getByLabelText('Photo files');
    expect(picker.hasAttribute('multiple')).toBe(true);
    expect(screen.getByRole('button', { name: 'Take photo' }).className).toContain(
      'pointer-coarse',
    );
  });

  it('gives each deletion its own announcement and moves focus to the next photo', async () => {
    const first = project.addPhoto();
    const second = project.addPhoto();
    const third = project.addPhoto();
    await openPage({
      [`DELETE /api/projects/${PROJECT_ID}/materials/${first.id}`]: () => {
        project.deletePhoto(first.id);
        return new Response(null, { status: 204 });
      },
      [`DELETE /api/projects/${PROJECT_ID}/materials/${second.id}`]: () => {
        project.deletePhoto(second.id);
        return new Response(null, { status: 204 });
      },
      [`DELETE /api/projects/${PROJECT_ID}/materials/${third.id}`]: () => {
        project.deletePhoto(third.id);
        return new Response(null, { status: 204 });
      },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Delete photo 1' }));
    await screen.findByText('Photo 1 deleted. 2 photos left.');
    // The old photo 2 is photo 1 now, and its Delete button has the focus.
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Delete photo 1' })),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Delete photo 1' }));
    await screen.findByText('Photo 1 deleted. 1 photo left.');

    fireEvent.click(screen.getByRole('button', { name: 'Delete photo 1' }));
    await screen.findByText('Photo 1 deleted. 0 photos left.');
    // Nothing left to focus: the heading takes over.
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Photos' })),
    );
  });

  describe('leaving the screen', () => {
    it('aborts an upload in flight, drops the object URLs, and does not decode for a closed screen', async () => {
      stubImages();
      const xhr = stubXhr((upload, index) =>
        index === 0 ? accept(upload) : new Promise(() => {}),
      );
      const page = await openPage();

      choose([imageFile('a.jpg'), imageFile('b.jpg')]);
      await waitFor(() => expect(xhr.uploads).toHaveLength(2));
      await screen.findByText('1 of 30', { exact: false });
      // A's preview is kept for its stored tile, B's for its tile in the queue.
      expect(urls.created).toHaveLength(2);

      page.unmount();

      expect(xhr.aborts()).toBe(1);
      expect(urls.revoked.sort()).toEqual([...urls.created].sort());
    });

    it('releases a photo that finishes decoding after the screen closed', async () => {
      stubImages();
      let finishDecoding: (() => void) | undefined;
      vi.stubGlobal(
        'createImageBitmap',
        vi.fn(
          () =>
            new Promise((resolve) => {
              finishDecoding = () => resolve({ width: 100, height: 100, close: vi.fn() });
            }),
        ),
      );
      const xhr = stubXhr((upload) => accept(upload));
      const page = await openPage();

      choose([imageFile('a.jpg')]);
      await waitFor(() => expect(finishDecoding).toBeDefined());
      page.unmount();
      finishDecoding?.();
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(urls.created).toHaveLength(0);
      expect(xhr.uploads).toHaveLength(0);
    });

    it('asks before a navigation or a reload while photos are uploading, and not otherwise', async () => {
      stubImages();
      stubXhr(() => new Promise(() => {}));
      const confirm = vi.fn<(message?: string) => boolean>();
      window.confirm = confirm;
      await openPage();

      // Idle: nothing to protect.
      mockRouter.events.emit('routeChangeStart', '/projects');
      expect(confirm).not.toHaveBeenCalled();
      const idleUnload = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(idleUnload);
      expect(idleUnload.defaultPrevented).toBe(false);

      choose([imageFile('a.jpg')]);
      await screen.findByText('Photos are still uploading. Stay on this page.');

      confirm.mockReturnValue(false);
      expect(() => mockRouter.events.emit('routeChangeStart', '/projects')).toThrow();
      expect(confirm).toHaveBeenCalledTimes(1);
      confirm.mockReturnValue(true);
      expect(() => mockRouter.events.emit('routeChangeStart', '/projects')).not.toThrow();
      const unload = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(unload);
      expect(unload.defaultPrevented).toBe(true);
    });
  });

  it('releases the decoded bitmap and empties the canvas after every photo', async () => {
    const images = stubImages();
    stubXhr((upload) => accept(upload));
    await openPage();

    choose([imageFile('a.jpg'), imageFile('b.jpg')]);

    await screen.findByText('2 photos uploaded.');
    expect(images.bitmapsClosed()).toBe(2);
    expect(images.canvasElements).toHaveLength(2);
    for (const canvas of images.canvasElements) {
      expect([canvas.width, canvas.height]).toEqual([0, 0]);
    }
  });
});
