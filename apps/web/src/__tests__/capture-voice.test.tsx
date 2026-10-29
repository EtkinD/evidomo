import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CapturePage from '../pages/projects/[projectId]/capture';
import {
  FakeProject,
  removeMediaDevices,
  stubObjectUrls,
  stubRecorder,
  stubXhr,
  type UploadRecord,
  type XhrResult,
} from './capture-helpers';
import { PROJECT_ID } from './project-fixtures';
import { mockRouter, setRoute } from './router-mock';
import { jsonResponse, meSignedIn, mockFetch, renderPage } from './test-utils';

vi.mock('next/router', () => import('./router-mock'));

const VOICE_URL = `/api/projects/${PROJECT_ID}/materials/voice-memo`;
const WEBM = 'audio/webm;codecs=opus';

let project: FakeProject;
let urls: ReturnType<typeof stubObjectUrls>;

beforeEach(() => {
  project = new FakeProject();
  urls = stubObjectUrls();
});

afterEach(() => {
  vi.useRealTimers();
  removeMediaDevices();
});

function accept(upload: UploadRecord): XhrResult {
  if (upload.url !== VOICE_URL) return { status: 404, body: { error: 'not_found' } };
  return { status: 200, body: { material: project.setVoiceMemo() } };
}

async function openPage(): Promise<{ unmount: () => void }> {
  setRoute(`/projects/${PROJECT_ID}/capture`);
  mockRouter.query = { projectId: PROJECT_ID };
  mockFetch({
    'GET /api/auth/me': meSignedIn,
    [`GET /api/projects/${PROJECT_ID}`]: () => jsonResponse(200, project.detail()),
  });
  const { unmount } = renderPage(CapturePage);
  await screen.findByRole('heading', { name: 'Voice walkthrough' });
  return { unmount };
}

describe('voice walkthrough', () => {
  it('records, previews, and uploads the walkthrough, then plays the stored one', async () => {
    const recorder = stubRecorder({ supportedTypes: [WEBM, 'audio/webm'] });
    const xhr = stubXhr((upload) => accept(upload));
    await openPage();

    fireEvent.click(screen.getByRole('button', { name: 'Start recording' }));
    expect(await screen.findByRole('timer', { name: 'Recording time' })).toBeDefined();
    expect(recorder.constructed).toEqual([{ mimeType: WEBM }]);

    fireEvent.click(screen.getByRole('button', { name: 'Stop recording' }));
    const preview = await screen.findByLabelText('Preview of the new walkthrough');
    expect(preview.getAttribute('src')).toMatch(/^blob:/);
    // The microphone is released as soon as the recording stops.
    expect(recorder.stoppedTracks()).toBe(1);
    expect(xhr.uploads).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Upload walkthrough' }));

    await screen.findByLabelText('Current walkthrough', { selector: 'audio' });
    expect(xhr.uploads).toHaveLength(1);
    expect(xhr.uploads[0]).toMatchObject({ method: 'PUT', url: VOICE_URL, contentType: WEBM });
    expect(await xhr.uploads[0]?.blob.text()).toBe('voice');
    expect(screen.queryByLabelText('Preview of the new walkthrough')).toBeNull();
    // Readiness refreshed: the voice item left the list of what is still needed.
    expect(screen.queryByText('Record a voice walkthrough of the property.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Record a new walkthrough' })).toBeDefined();
  });

  it('falls back to MP4 where the browser cannot record WebM (older Safari)', async () => {
    const recorder = stubRecorder({ supportedTypes: ['audio/mp4'] });
    const xhr = stubXhr((upload) => accept(upload));
    await openPage();

    fireEvent.click(screen.getByRole('button', { name: 'Start recording' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Stop recording' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Upload walkthrough' }));

    await waitFor(() => expect(xhr.uploads).toHaveLength(1));
    expect(recorder.constructed).toEqual([{ mimeType: 'audio/mp4' }]);
    expect(xhr.uploads[0]?.contentType).toBe('audio/mp4');
  });

  it('discards a recording when re-recording', async () => {
    const recorder = stubRecorder({ supportedTypes: [WEBM] });
    stubXhr((upload) => accept(upload));
    await openPage();

    fireEvent.click(screen.getByRole('button', { name: 'Start recording' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Stop recording' }));
    await screen.findByLabelText('Preview of the new walkthrough');

    fireEvent.click(screen.getByRole('button', { name: 'Record again' }));

    expect(await screen.findByRole('timer', { name: 'Recording time' })).toBeDefined();
    expect(screen.queryByLabelText('Preview of the new walkthrough')).toBeNull();
    expect(recorder.constructed).toHaveLength(2);
  });

  it('stops 1.5 s before the limit, so the server never sees a memo over it', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    stubRecorder({ supportedTypes: [WEBM] });
    await openPage();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start recording' }));
      await Promise.resolve();
    });
    expect(screen.getByRole('timer', { name: 'Recording time' }).textContent).toBe('0:00 / 10:00');

    // Just before the margin it is still recording.
    await act(async () => {
      vi.advanceTimersByTime(598_000);
      await Promise.resolve();
    });
    expect(screen.getByRole('timer', { name: 'Recording time' })).toBeDefined();

    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });

    expect(screen.getByLabelText('Preview of the new walkthrough')).toBeDefined();
    // The measured length, under the 10:00 limit, not a rounded-up clamp.
    expect(screen.getByText('Preview: Recording, 9:58')).toBeDefined();
  });

  it('checks the limit when the tab becomes visible again, as background timers are throttled', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    stubRecorder({ supportedTypes: [WEBM] });
    await openPage();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start recording' }));
      await Promise.resolve();
    });

    // The clock moved on while the interval did not run.
    await act(async () => {
      vi.setSystemTime(Date.now() + 599_000);
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });

    expect(screen.getByLabelText('Preview of the new walkthrough')).toBeDefined();
  });

  it('releases the microphone and says so when the recorder cannot start', async () => {
    const recorder = stubRecorder({ supportedTypes: [WEBM], startThrows: true });
    await openPage();

    fireEvent.click(screen.getByRole('button', { name: 'Start recording' }));

    expect(await screen.findByText(/Recording failed/)).toBeDefined();
    expect(recorder.stoppedTracks()).toBe(1);
    expect(screen.queryByRole('timer')).toBeNull();
  });

  it('switches off the microphone when the screen is left mid-recording', async () => {
    const recorder = stubRecorder({ supportedTypes: [WEBM] });
    const page = await openPage();
    fireEvent.click(screen.getByRole('button', { name: 'Start recording' }));
    await screen.findByRole('timer', { name: 'Recording time' });
    expect(recorder.stoppedTracks()).toBe(0);

    page.unmount();

    expect(recorder.stoppedTracks()).toBe(1);
  });

  it('aborts the upload and releases the object URLs when the screen is left', async () => {
    stubRecorder({ supportedTypes: [WEBM] });
    const xhr = stubXhr(() => new Promise(() => {}));
    const page = await openPage();
    fireEvent.click(screen.getByRole('button', { name: 'Start recording' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Stop recording' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Upload walkthrough' }));
    await waitFor(() => expect(xhr.uploads).toHaveLength(1));
    expect(urls.created).toHaveLength(1);

    page.unmount();

    expect(xhr.aborts()).toBe(1);
    expect(urls.revoked).toEqual(urls.created);
  });

  it('asks before leaving with a recording in progress or a recording not uploaded', async () => {
    stubRecorder({ supportedTypes: [WEBM] });
    const confirm = vi.fn<(message?: string) => boolean>().mockReturnValue(false);
    window.confirm = confirm;
    await openPage();
    mockRouter.events.emit('routeChangeStart', '/projects');
    expect(confirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Start recording' }));
    await screen.findByText('A recording is in progress.');
    expect(() => mockRouter.events.emit('routeChangeStart', '/projects')).toThrow();

    fireEvent.click(screen.getByRole('button', { name: 'Stop recording' }));
    await screen.findByText('A recording is ready but not uploaded yet.');
    expect(() => mockRouter.events.emit('routeChangeStart', '/projects')).toThrow();
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('shows the recording state with a word and hides the old walkthrough while recording', async () => {
    project.setVoiceMemo();
    stubRecorder({ supportedTypes: [WEBM] });
    await openPage();
    expect(screen.getByText('Up to 10 minutes.', { exact: false })).toBeDefined();
    expect(screen.getByLabelText('Current walkthrough', { selector: 'audio' })).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Record a new walkthrough' }));
    const stop = await screen.findByRole('button', { name: 'Stop recording' });

    expect(screen.getByText('Recording')).toBeDefined();
    expect(screen.queryByLabelText('Current walkthrough', { selector: 'audio' })).toBeNull();
    // The page does not claim everything is in place while a recording is not uploaded.
    expect(screen.queryByText('Photos and walkthrough are in place.')).toBeNull();
    expect(document.activeElement).toBe(stop);

    fireEvent.click(stop);
    await screen.findByLabelText('Preview of the new walkthrough');
    expect(screen.getByText(/Previous walkthrough \(replaced when you upload\)/)).toBeDefined();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Upload walkthrough' }));
  });

  it('explains a blocked microphone and keeps file upload available', async () => {
    stubRecorder({ supportedTypes: [WEBM], denyWith: 'NotAllowedError' });
    await openPage();

    fireEvent.click(screen.getByRole('button', { name: 'Start recording' }));

    expect(await screen.findByText(/Microphone access is blocked/)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Try recording again' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Upload an audio file' })).toBeDefined();
  });

  it('says so when the browser has no microphone', async () => {
    stubRecorder({ supportedTypes: [WEBM], denyWith: 'NotFoundError' });
    await openPage();

    fireEvent.click(screen.getByRole('button', { name: 'Start recording' }));

    expect(await screen.findByText(/No microphone was found/)).toBeDefined();
  });

  it('offers only file upload where recording is not supported', async () => {
    await openPage();

    expect(screen.getByText(/This browser cannot record audio/)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Start recording' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Upload an audio file' })).toBeDefined();
  });

  it('uploads an existing audio file, naming its type from the extension when the browser does not', async () => {
    const xhr = stubXhr((upload) => accept(upload));
    await openPage();

    fireEvent.change(screen.getByLabelText('Audio file'), {
      target: { files: [new File(['m4a'], 'walkthrough.m4a', { type: '' })] },
    });
    expect(await screen.findByText('Preview: walkthrough.m4a')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Upload walkthrough' }));

    await screen.findByLabelText('Current walkthrough', { selector: 'audio' });
    expect(xhr.uploads[0]).toMatchObject({ method: 'PUT', contentType: 'audio/mp4' });
  });

  it('refuses an audio file the server would not take', async () => {
    const xhr = stubXhr((upload) => accept(upload));
    await openPage();

    fireEvent.change(screen.getByLabelText('Audio file'), {
      target: { files: [new File(['x'], 'notes.txt', { type: 'text/plain' })] },
    });

    expect(await screen.findByText(/This audio format is not supported/)).toBeDefined();
    expect(xhr.uploads).toHaveLength(0);
  });

  it('shows the server reason when the walkthrough is refused and allows another try', async () => {
    stubRecorder({ supportedTypes: [WEBM] });
    stubXhr((upload, index) =>
      index === 0
        ? { status: 422, body: { error: 'upload_rejected', reason: 'too_long' } }
        : accept(upload),
    );
    await openPage();

    fireEvent.click(screen.getByRole('button', { name: 'Start recording' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Stop recording' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Upload walkthrough' }));

    expect(
      await screen.findByText('The recording is longer than the allowed length.'),
    ).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Try upload again' }));
    await screen.findByLabelText('Current walkthrough', { selector: 'audio' });
  });

  it('plays the stored walkthrough from the file endpoint and is read-only when locked', async () => {
    const memo = project.setVoiceMemo();
    project.locked = true;
    stubRecorder({ supportedTypes: [WEBM] });
    await openPage();

    const player = screen.getByLabelText('Current walkthrough', { selector: 'audio' });
    expect(player.getAttribute('src')).toBe(
      `/api/projects/${PROJECT_ID}/materials/${memo.id}/file`,
    );
    expect(screen.getByText(/the walkthrough is locked/)).toBeDefined();
    expect(screen.queryByRole('button', { name: /recording/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Upload an audio file' })).toBeNull();
  });
});
