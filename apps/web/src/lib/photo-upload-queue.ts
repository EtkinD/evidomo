import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  busyDelayMs,
  describeDownscaleFailure,
  describeUploadFailure,
  isTooManyUploads,
  isTransientFailure,
  MAX_BUSY_RETRIES,
  uploadTiming,
} from './capture';
import type { Translator } from './i18n';
import { DownscaleError, downscaleImage } from './image-downscale';
import { isAbortError, uploadMaterial } from './upload';

export type PhotoItemStatus =
  | 'queued'
  | 'preparing'
  | 'uploading'
  /** Backing off before another attempt (busy server or a transient failure). */
  | 'waiting'
  /** Failed after the automatic retries: the queue stops here until Retry or Skip. */
  | 'paused'
  /** Refused for good (not retryable): skipped, kept visible with its reason. */
  | 'failed';

export interface PhotoItem {
  id: string;
  name: string;
  status: PhotoItemStatus;
  /** 0..1 while `uploading`. */
  progress: number;
  /** Set on `paused` and `failed`. */
  error: string | null;
  /** Object URL of the downscaled photo, once it is prepared. */
  previewUrl: string | null;
}

export interface PhotoQueueState {
  items: readonly PhotoItem[];
  /** Object URLs of photos uploaded in this session, by stored material ID. */
  previews: Readonly<Record<string, string>>;
  /** Text for the polite live region: a few messages per batch, never per byte. */
  announcement: string;
  /** Why some chosen files were not queued. */
  notice: string | null;
}

export interface PhotoQueueConfig {
  projectId: string;
  /** Translators for the messages the queue writes itself; refreshed on every render. */
  t: Translator<'capture'>;
  tApi: Translator<'apiErrors'>;
  /** How many more photos the project can take, counting the stored ones. */
  getCapacity: () => number;
  /** Refetches the project detail; resolves when the new readiness is in the cache. */
  refresh: () => Promise<void>;
}

const EMPTY_STATE: PhotoQueueState = { items: [], previews: {}, announcement: '', notice: null };

const ACTIVE: readonly PhotoItemStatus[] = [
  'queued',
  'preparing',
  'uploading',
  'waiting',
  'paused',
];

/**
 * Photos go up strictly one at a time, in the order they were chosen: the server numbers photos
 * by commit order, and that order is the evidence order. So the queue never reorders:
 *
 * - a transient failure (network, 5xx) is retried automatically with a short backoff;
 * - a photo that still fails pauses the queue, the photos behind it stay queued, and the user
 *   chooses Retry (same place in line) or Skip;
 * - a refusal that repeats itself (`upload_rejected`, ...) is skipped with its reason.
 *
 * Plain class + `useSyncExternalStore` so the upload loop is not tied to render timing.
 */
export class PhotoUploadQueue {
  private state: PhotoQueueState = EMPTY_STATE;
  private readonly listeners = new Set<() => void>();
  private readonly files = new Map<string, File>();
  private readonly blobs = new Map<string, Blob>();
  private readonly cancelWaits = new Map<string, () => void>();
  private controller: AbortController | null = null;
  private pumping = false;
  private nextId = 0;
  private batch = { done: 0, skipped: 0 };

  constructor(private config: PhotoQueueConfig) {}

  configure(config: PhotoQueueConfig): void {
    this.config = config;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): PhotoQueueState => this.state;

  /** Starts (or restarts, after a strict-mode remount) accepting work. */
  connect(): () => void {
    this.controller = new AbortController();
    return () => this.disconnect();
  }

  private disconnect(): void {
    this.controller?.abort();
    this.controller = null;
    for (const item of this.state.items) {
      if (item.previewUrl !== null) URL.revokeObjectURL(item.previewUrl);
    }
    for (const url of Object.values(this.state.previews)) URL.revokeObjectURL(url);
    this.files.clear();
    this.blobs.clear();
    this.cancelWaits.clear();
    this.state = EMPTY_STATE;
    this.pumping = false;
  }

  private set(patch: Partial<PhotoQueueState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private patchItem(id: string, patch: Partial<PhotoItem>): void {
    this.set({
      items: this.state.items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    });
  }

  private removeItem(id: string): void {
    this.files.delete(id);
    this.blobs.delete(id);
    this.set({ items: this.state.items.filter((item) => item.id !== id) });
  }

  private announce(message: string): void {
    this.set({ announcement: message });
  }

  private isBatchActive(): boolean {
    return this.state.items.some((item) => ACTIVE.includes(item.status));
  }

  addFiles(files: readonly File[]): void {
    if (files.length === 0) return;
    const active = this.state.items.filter((item) => item.status !== 'failed').length;
    const room = Math.max(0, this.config.getCapacity() - active);
    const accepted = files.slice(0, room);
    const skipped = files.length - accepted.length;
    const notice = skipped > 0 ? this.config.t('queue.notAdded', { count: skipped }) : null;
    if (accepted.length === 0) {
      this.set({ notice });
      return;
    }

    if (!this.isBatchActive()) {
      this.batch = { done: 0, skipped: 0 };
      this.announce(this.config.t('queue.uploading', { count: accepted.length }));
    }
    const added: PhotoItem[] = accepted.map((file) => {
      const id = `photo-${this.nextId++}`;
      this.files.set(id, file);
      return {
        id,
        name: file.name,
        status: 'queued',
        progress: 0,
        error: null,
        previewUrl: null,
      };
    });
    this.set({ items: [...this.state.items, ...added], notice });
    void this.pump();
  }

  /** A paused photo is tried again where it stands, before the photos behind it. */
  retry(id: string): void {
    const item = this.state.items.find((candidate) => candidate.id === id);
    if (item === undefined || item.status !== 'paused') return;
    this.patchItem(id, { status: 'queued', progress: 0, error: null });
    this.set({ notice: null });
    void this.pump();
  }

  /** Gives up on a paused (or waiting) photo; the photos behind it carry on. */
  skip(id: string): void {
    const item = this.state.items.find((candidate) => candidate.id === id);
    if (item === undefined || (item.status !== 'paused' && item.status !== 'waiting')) return;
    this.batch.skipped += 1;
    if (item.previewUrl !== null) URL.revokeObjectURL(item.previewUrl);
    this.removeItem(id);
    // A waiting photo is inside `process`; releasing its wait lets the loop move on.
    this.cancelWaits.get(id)?.();
    void this.pump();
  }

  /** Removes a photo that was refused for good. */
  dismiss(id: string): void {
    const item = this.state.items.find((candidate) => candidate.id === id);
    if (item === undefined || item.status !== 'failed') return;
    if (item.previewUrl !== null) URL.revokeObjectURL(item.previewUrl);
    this.removeItem(id);
  }

  /** Drops the local preview of a photo that was deleted. */
  forgetPreview(materialId: string): void {
    const url = this.state.previews[materialId];
    if (url === undefined) return;
    URL.revokeObjectURL(url);
    const { [materialId]: _removed, ...previews } = this.state.previews;
    this.set({ previews });
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    const controller = this.controller;
    if (controller === null) return;
    this.pumping = true;
    try {
      for (;;) {
        if (controller.signal.aborted) break;
        // A paused photo blocks the ones behind it: they must not overtake it.
        if (this.state.items.some((item) => item.status === 'paused')) break;
        const next = this.state.items.find((item) => item.status === 'queued');
        if (next === undefined) break;
        await this.process(next.id, controller.signal);
      }
    } finally {
      if (!controller.signal.aborted) {
        this.pumping = false;
        if (!this.isBatchActive()) this.announceSummary();
      }
    }
  }

  private announceSummary(): void {
    const { done, skipped } = this.batch;
    const parts = [
      done > 0 ? this.config.t('queue.uploaded', { count: done }) : '',
      skipped > 0 ? this.config.t('queue.skipped', { count: skipped }) : '',
    ].filter((part) => part !== '');
    if (parts.length > 0) this.announce(parts.join(' '));
  }

  private fail(id: string, message: string): void {
    this.batch.skipped += 1;
    this.patchItem(id, { status: 'failed', error: message });
    this.blobs.delete(id);
  }

  private async prepare(id: string, signal: AbortSignal): Promise<Blob | null> {
    const existing = this.blobs.get(id);
    if (existing !== undefined) return existing;
    const file = this.files.get(id);
    if (file === undefined) {
      this.fail(id, describeDownscaleFailure(this.config.t, 'undecodable'));
      return null;
    }
    this.patchItem(id, { status: 'preparing' });
    try {
      const blob = await downscaleImage(file);
      // Unmounted while decoding: nothing may hold the result (no object URL, no blob).
      if (signal.aborted) return null;
      this.blobs.set(id, blob);
      this.files.delete(id);
      this.patchItem(id, { previewUrl: URL.createObjectURL(blob) });
      return blob;
    } catch (error) {
      if (signal.aborted) return null;
      const message =
        error instanceof DownscaleError
          ? describeDownscaleFailure(this.config.t, error.failure)
          : describeDownscaleFailure(this.config.t, 'undecodable');
      this.fail(id, message);
      return null;
    }
  }

  /** Resolves true after `ms`, false when the wait was cancelled or the queue disconnected. */
  private wait(id: string, ms: number, signal: AbortSignal): Promise<boolean> {
    this.patchItem(id, { status: 'waiting' });
    return new Promise((resolve) => {
      const finish = (elapsed: boolean): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        this.cancelWaits.delete(id);
        resolve(elapsed);
      };
      const onAbort = (): void => finish(false);
      const timer = setTimeout(() => finish(true), ms);
      signal.addEventListener('abort', onAbort, { once: true });
      this.cancelWaits.set(id, () => finish(false));
    });
  }

  private async process(id: string, signal: AbortSignal): Promise<void> {
    const blob = await this.prepare(id, signal);
    if (blob === null || signal.aborted) return;
    const { projectId } = this.config;
    let busyRetries = 0;
    let transientRetries = 0;

    for (;;) {
      this.patchItem(id, { status: 'uploading', progress: 0 });
      let materialId: string;
      try {
        const { material } = await uploadMaterial({
          path: `/api/projects/${projectId}/materials/photos`,
          method: 'POST',
          body: blob,
          contentType: 'image/jpeg',
          signal,
          onProgress: (progress) => this.patchItem(id, { progress }),
        });
        materialId = material.id;
      } catch (error) {
        if (isAbortError(error) || signal.aborted) return;
        if (isTooManyUploads(error) && busyRetries < MAX_BUSY_RETRIES) {
          busyRetries += 1;
          const delay = busyDelayMs(error);
          this.announce(this.config.t('queue.busy', { seconds: Math.ceil(delay / 1000) }));
          if (!(await this.wait(id, delay, signal))) return;
          continue;
        }
        const backoff = uploadTiming.backoffMs[transientRetries];
        if (isTransientFailure(error) && backoff !== undefined) {
          transientRetries += 1;
          if (!(await this.wait(id, backoff, signal))) return;
          continue;
        }
        const failure = describeUploadFailure(this.config.t, this.config.tApi, error);
        if (failure.retryable) {
          const item = this.state.items.find((candidate) => candidate.id === id);
          this.patchItem(id, { status: 'paused', error: failure.message });
          this.announce(
            this.config.t('queue.paused', {
              name: item?.name ?? this.config.t('queue.aPhoto'),
              message: failure.message,
            }),
          );
          return;
        }
        this.fail(id, failure.message);
        if (failure.stopsQueue) {
          for (const item of this.state.items) {
            if (item.status === 'queued') this.fail(item.id, failure.message);
          }
          await this.config.refresh();
        }
        return;
      }

      const previewUrl = this.state.items.find((item) => item.id === id)?.previewUrl ?? null;
      if (previewUrl !== null) {
        this.set({ previews: { ...this.state.previews, [materialId]: previewUrl } });
      }
      this.batch.done += 1;
      // The tile leaves the queue only once the stored photo is in the grid.
      await this.config.refresh();
      this.removeItem(id);
      return;
    }
  }
}

/** One queue per mounted capture screen. */
export function usePhotoUploads(config: PhotoQueueConfig): {
  queue: PhotoUploadQueue;
  state: PhotoQueueState;
} {
  const [queue] = useState(() => new PhotoUploadQueue(config));
  useEffect(() => {
    queue.configure(config);
  });
  useEffect(() => queue.connect(), [queue]);
  const state = useSyncExternalStore(queue.subscribe, queue.getSnapshot, queue.getSnapshot);
  return { queue, state };
}
