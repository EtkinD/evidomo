import { UPLOAD_LIMITS, projectMaterialFileUrl, type ProjectDetailResponse } from '@evidomo/shared';
import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import {
  checkAudioFile,
  describeLimit,
  describeUploadFailure,
  formatDuration,
} from '../lib/capture';
import { useUploadVoiceMemo } from '../lib/materials';
import { useVoiceRecorder, type RecorderState } from '../lib/voice-recorder';

interface Candidate {
  blob: Blob;
  contentType: string;
  url: string;
  label: string;
}

const FAILURE_MESSAGES: Record<Extract<RecorderState, { phase: 'failed' }>['reason'], string> = {
  denied:
    'Microphone access is blocked. Allow the microphone for this site in your browser settings, then try again. You can also upload an audio file.',
  no_microphone: 'No microphone was found on this device. You can upload an audio file instead.',
  unusable_format:
    'This browser records in a format Evidomo cannot accept. Upload an audio file instead.',
  error: 'Recording failed. Try again, or upload an audio file instead.',
};

function Alert({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="alert alert-error">
      <span>{children}</span>
    </div>
  );
}

export type VoiceStatus = 'idle' | 'recording' | 'unsent';

// One width for every action in this section, so Stop does not jump around between states.
const ACTION = 'h-14 w-full sm:h-12 sm:w-56';

/** Record the walkthrough in the browser (or pick a file), preview it, and upload it. */
export function VoiceCapture({
  detail,
  onStatusChange,
}: {
  detail: ProjectDetailResponse;
  /** Anything but `idle` is lost when the page is left. */
  onStatusChange: (status: VoiceStatus) => void;
}) {
  const projectId = detail.project.id;
  const locked = detail.readiness.inputsLocked;
  const { maxSeconds } = detail.readiness.voiceMemo;
  const maxMs = Math.min(maxSeconds * 1000, UPLOAD_LIMITS.voiceMemoMaxDurationMs);
  const stored = detail.materials.find(
    (material) => material.kind === 'voice_memo' && material.status === 'ready',
  );

  const recorder = useVoiceRecorder(maxMs);
  const upload = useUploadVoiceMemo(projectId);
  const [fileCandidate, setFileCandidate] = useState<Candidate | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  // The walkthrough uploaded in this session plays from the device, not from the server.
  const [local, setLocal] = useState<{ id: string; url: string } | null>(null);
  const [playbackFailed, setPlaybackFailed] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadAbort = useRef<AbortController | null>(null);
  // The upload must not outlive the screen: leaving aborts the request.
  useEffect(() => () => uploadAbort.current?.abort(), []);

  // Object URLs are released when the value they belong to is replaced, cleared, or unmounted.
  useEffect(() => {
    if (fileCandidate === null) return;
    return () => URL.revokeObjectURL(fileCandidate.url);
  }, [fileCandidate]);
  useEffect(() => {
    if (local === null) return;
    return () => URL.revokeObjectURL(local.url);
  }, [local]);

  const recorderAnnouncement =
    recorder.state.phase === 'recording'
      ? 'Recording started.'
      : recorder.state.phase === 'recorded'
        ? 'Recording stopped. You can preview it before uploading.'
        : '';
  const recorded = recorder.state.phase === 'recorded' ? recorder.state : null;
  const candidate: Candidate | null =
    fileCandidate ??
    (recorded === null
      ? null
      : {
          blob: recorded.blob,
          contentType: recorded.blob.type,
          url: recorded.url,
          label: `Recording, ${formatDuration(recorded.durationMs)}`,
        });

  const recordingPhase = recorder.state.phase;
  const status: VoiceStatus =
    recordingPhase === 'recording' || recordingPhase === 'requesting'
      ? 'recording'
      : candidate !== null
        ? 'unsent'
        : 'idle';
  useEffect(() => {
    onStatusChange(status);
  }, [status, onStatusChange]);

  function focusHeading(): void {
    document.getElementById('voice-heading')?.focus();
  }

  function clearFileCandidate(): void {
    setFileCandidate(null);
  }

  async function onStart(): Promise<void> {
    clearFileCandidate();
    setFileError(null);
    setUploadError(null);
    setAnnouncement('');
    await recorder.start();
  }

  function onStop(): void {
    recorder.stop();
  }

  function onDiscard(): void {
    clearFileCandidate();
    recorder.reset();
    setUploadError(null);
    setAnnouncement('Recording discarded.');
    focusHeading();
  }

  function onFileChosen(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file === undefined) return;
    const check = checkAudioFile(file);
    if (!check.ok) {
      setFileError(check.message);
      return;
    }
    setFileError(null);
    setUploadError(null);
    recorder.reset();
    clearFileCandidate();
    setFileCandidate({
      blob: file,
      contentType: check.contentType,
      url: URL.createObjectURL(file),
      label: file.name,
    });
  }

  function onUpload(): void {
    if (candidate === null || upload.isPending) return;
    setUploadError(null);
    setProgress(0);
    setAnnouncement('Uploading the walkthrough.');
    const sent = candidate;
    const abort = new AbortController();
    uploadAbort.current = abort;
    upload.mutate(
      {
        blob: sent.blob,
        contentType: sent.contentType,
        onProgress: setProgress,
        signal: abort.signal,
      },
      {
        onSuccess: (material) => {
          setLocal({ id: material.id, url: URL.createObjectURL(sent.blob) });
          setPlaybackFailed(false);
          clearFileCandidate();
          recorder.reset();
          setAnnouncement('Walkthrough uploaded.');
          focusHeading();
        },
        onError: (error) => {
          const message = describeUploadFailure(error).message;
          setUploadError(message);
          setAnnouncement(`Upload failed. ${message}`);
        },
      },
    );
  }

  const storedUrl =
    stored === undefined
      ? null
      : local?.id === stored.id
        ? local.url
        : projectMaterialFileUrl(projectId, stored.id);

  const recording = status === 'recording';
  const unsupported = recorder.support.status === 'unsupported';

  return (
    <section aria-labelledby="voice-heading" className="card border border-base-300 bg-base-100">
      <div className="card-body gap-4">
        <h2 id="voice-heading" tabIndex={-1} className="card-title text-2xl">
          Voice walkthrough
        </h2>
        <p className="text-base-content/70">
          Walk through the property and say what you see: rooms, condition, anything the photos
          cannot show. Up to {describeLimit(maxMs)}.
        </p>

        {/* Hidden while recording, so the old memo cannot play into the microphone. */}
        {stored !== undefined && storedUrl !== null && !recording && (
          <div className="flex flex-col gap-2">
            <p className="font-medium">
              {candidate === null
                ? 'Current walkthrough'
                : 'Previous walkthrough (replaced when you upload)'}
              {stored.durationMs !== null && (
                <span className="font-normal text-base-content/70">
                  {' '}
                  · {formatDuration(stored.durationMs)}
                </span>
              )}
            </p>
            <audio
              controls
              preload="metadata"
              src={storedUrl}
              aria-label="Current walkthrough"
              className="w-full"
              onError={() => setPlaybackFailed(true)}
            />
            {playbackFailed && (
              <p className="text-sm text-base-content/70">Playback is not available right now.</p>
            )}
          </div>
        )}

        {locked ? (
          <div role="note" className="alert alert-info">
            <span>
              A run has been started, so the walkthrough is locked: the run cites it as evidence.
            </span>
          </div>
        ) : (
          <>
            {stored !== undefined && candidate === null && !recording && (
              <p className="text-sm text-base-content/70">
                A new recording or file replaces the current walkthrough.
              </p>
            )}

            {unsupported && (
              <div role="note" className="alert alert-warning">
                <span>
                  {recorder.support.status === 'unsupported' &&
                  recorder.support.reason === 'insecure_context'
                    ? 'Recording needs a secure (HTTPS) connection. You can upload an audio file instead.'
                    : 'This browser cannot record audio. You can upload an audio file instead.'}
                </span>
              </div>
            )}

            {recorder.state.phase === 'requesting' && (
              <p className="flex items-center gap-2">
                <span className="loading loading-spinner loading-sm" aria-hidden />
                Waiting for microphone permission…
              </p>
            )}

            {recorder.state.phase === 'recording' && (
              <div className="flex flex-col gap-3">
                <p className="flex items-center gap-3 text-lg font-medium">
                  {/* A dot plus the word: the state is never colour alone. It pulses unless the
                      user asked for less motion. */}
                  <span className="flex items-center gap-2">
                    <span
                      aria-hidden
                      className="size-3 animate-pulse rounded-full bg-error motion-reduce:animate-none"
                    />
                    Recording
                  </span>
                  <span role="timer" aria-label="Recording time">
                    {formatDuration(recorder.state.elapsedMs)} / {formatDuration(maxMs)}
                  </span>
                </p>
                <button
                  type="button"
                  className={`btn btn-error ${ACTION}`}
                  onClick={onStop}
                  // The Start button this replaces had the focus.
                  autoFocus
                >
                  Stop recording
                </button>
              </div>
            )}

            {recorder.state.phase === 'failed' && (
              <Alert>{FAILURE_MESSAGES[recorder.state.reason]}</Alert>
            )}

            {candidate !== null && (
              <div className="flex flex-col gap-3">
                <p className="font-medium">Preview: {candidate.label}</p>
                <audio
                  controls
                  src={candidate.url}
                  aria-label="Preview of the new walkthrough"
                  className="w-full"
                />
                {upload.isPending && (
                  <progress
                    className="progress progress-secondary w-full"
                    aria-label="Uploading the walkthrough"
                    value={Math.round(progress * 100)}
                    max={100}
                  />
                )}
                {uploadError !== null && <Alert>{uploadError}</Alert>}
                <div className="flex flex-col gap-2 sm:flex-row">
                  <button
                    type="button"
                    className={`btn btn-secondary ${ACTION}`}
                    disabled={upload.isPending}
                    onClick={onUpload}
                    // The Stop button this replaces had the focus.
                    autoFocus
                  >
                    {upload.isPending && (
                      <span className="loading loading-spinner loading-sm" aria-hidden />
                    )}
                    {uploadError === null ? 'Upload walkthrough' : 'Try upload again'}
                  </button>
                  <button
                    type="button"
                    className={`btn btn-outline ${ACTION}`}
                    disabled={upload.isPending}
                    onClick={() => (fileCandidate === null ? void onStart() : onDiscard())}
                  >
                    {fileCandidate === null ? 'Record again' : 'Discard'}
                  </button>
                </div>
              </div>
            )}

            {candidate === null && !recording && (
              <div className="flex flex-col gap-2 sm:flex-row">
                {!unsupported && (
                  <button
                    type="button"
                    className={`btn btn-secondary ${ACTION}`}
                    disabled={recorder.support.status === 'checking'}
                    onClick={() => void onStart()}
                  >
                    {recorder.state.phase === 'failed'
                      ? 'Try recording again'
                      : stored === undefined
                        ? 'Start recording'
                        : 'Record a new walkthrough'}
                  </button>
                )}
                <button
                  type="button"
                  className={`btn btn-outline ${ACTION}`}
                  onClick={() => fileInput.current?.click()}
                >
                  Upload an audio file
                </button>
              </div>
            )}
            <input
              ref={fileInput}
              type="file"
              accept="audio/*"
              className="hidden"
              aria-label="Audio file"
              onChange={onFileChosen}
            />
            {fileError !== null && <Alert>{fileError}</Alert>}
          </>
        )}

        <div role="status" aria-live="polite" className="sr-only">
          <span>{recorderAnnouncement}</span> <span>{announcement}</span>
        </div>
      </div>
    </section>
  );
}
