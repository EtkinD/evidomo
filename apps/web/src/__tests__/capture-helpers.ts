import { projectDetailResponseSchema, type ProjectDetailResponse } from '@evidomo/shared';
import { vi } from 'vitest';
import { PROJECT_ID } from './project-fixtures';

const NOW = '2026-10-29T10:00:00.000Z';

// --- a stand-in for the project API's state ---------------------------------------------------

type Material = ProjectDetailResponse['materials'][number];

export class FakeProject {
  photos: Material[] = [];
  voiceMemo: Material | null = null;
  locked = false;
  photoMax = 30;

  addPhoto(): Material {
    const material: Material = {
      id: crypto.randomUUID(),
      kind: 'photo',
      status: 'ready',
      position: this.photos.length + 1,
      mimeType: 'image/jpeg',
      sizeBytes: 1000,
      width: 2048,
      height: 1536,
      durationMs: null,
      failureReason: null,
      createdAt: NOW,
    };
    this.photos.push(material);
    return material;
  }

  setVoiceMemo(): Material {
    this.voiceMemo = {
      id: crypto.randomUUID(),
      kind: 'voice_memo',
      status: 'ready',
      position: 1,
      mimeType: 'audio/wav',
      sizeBytes: 5000,
      width: null,
      height: null,
      durationMs: 12_000,
      failureReason: null,
      createdAt: NOW,
    };
    return this.voiceMemo;
  }

  deletePhoto(id: string): void {
    this.photos = this.photos
      .filter((photo) => photo.id !== id)
      .map((photo, index) => ({ ...photo, position: index + 1 }));
  }

  detail(): ProjectDetailResponse {
    const missing: ProjectDetailResponse['readiness']['missing'] = [];
    if (this.photos.length < 3) {
      missing.push({ kind: 'photos', count: this.photos.length, min: 3, max: this.photoMax });
    }
    if (this.voiceMemo === null) missing.push({ kind: 'voice_memo' });
    return projectDetailResponseSchema.parse({
      project: {
        id: PROJECT_ID,
        title: 'Alder Falls Cottage 4',
        status: 'draft',
        officeProfile: { agencyName: 'Fictional Realty Co' },
        market: { id: 'germany', version: 1, name: 'Germany' },
        outputLanguage: 'de',
        service: { id: 'listing-launch', version: 1 },
        createdAt: NOW,
        updatedAt: NOW,
      },
      factForm: { values: {} },
      materials: [...this.photos, ...(this.voiceMemo === null ? [] : [this.voiceMemo])],
      readiness: {
        canStartRun: missing.length === 0 && !this.locked,
        inputsLocked: this.locked,
        activeRunId: null,
        missing,
        photos: { count: this.photos.length, min: 3, max: this.photoMax, required: true },
        voiceMemo: { present: this.voiceMemo !== null, required: true, maxSeconds: 600 },
      },
      latestRun: this.locked
        ? { id: crypto.randomUUID(), status: 'completed', gate: null, createdAt: NOW }
        : null,
    });
  }
}

// --- XMLHttpRequest ---------------------------------------------------------------------------

export interface XhrResult {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Network failure instead of a response. */
  networkError?: boolean;
}

export interface UploadRecord {
  method: string;
  url: string;
  contentType: string | undefined;
  blob: Blob;
}

type XhrHandler = (upload: UploadRecord, index: number) => XhrResult | Promise<XhrResult>;

/** Replaces XMLHttpRequest: records each upload and answers it with `handler`. */
export function stubXhr(handler: XhrHandler): {
  uploads: UploadRecord[];
  maxInFlight: () => number;
  aborts: () => number;
} {
  const uploads: UploadRecord[] = [];
  let aborts = 0;
  let inFlight = 0;
  let maxInFlight = 0;

  class FakeXhr {
    readonly upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    status = 0;
    responseText = '';
    private method = '';
    private url = '';
    private readonly requestHeaders: Record<string, string> = {};
    private responseHeaders: Record<string, string> = {};
    private aborted = false;

    open(method: string, url: string): void {
      this.method = method;
      this.url = url;
    }
    setRequestHeader(name: string, value: string): void {
      this.requestHeaders[name.toLowerCase()] = value;
    }
    getResponseHeader(name: string): string | null {
      return this.responseHeaders[name.toLowerCase()] ?? null;
    }
    abort(): void {
      this.aborted = true;
      aborts += 1;
      this.onabort?.();
    }
    send(blob: Blob): void {
      const record: UploadRecord = {
        method: this.method,
        url: this.url,
        contentType: this.requestHeaders['content-type'],
        blob,
      };
      const index = uploads.push(record) - 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      void (async () => {
        await Promise.resolve();
        const result = await handler(record, index);
        inFlight -= 1;
        if (this.aborted) return;
        if (result.networkError === true) {
          this.onerror?.();
          return;
        }
        this.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 2 } as ProgressEvent);
        this.status = result.status;
        this.responseText = result.body === undefined ? '' : JSON.stringify(result.body);
        this.responseHeaders = Object.fromEntries(
          Object.entries(result.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
        );
        this.onload?.();
      })();
    }
  }

  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  return { uploads, maxInFlight: () => maxInFlight, aborts: () => aborts };
}

// --- image decoding and canvas ----------------------------------------------------------------

export interface ImageStub {
  /** Canvas sizes and `toBlob` arguments, per photo. */
  canvases: { width: number; height: number }[];
  toBlobCalls: { type: string | undefined; quality: unknown }[];
  bitmapOptions: unknown[];
  /** How many decoded bitmaps were released with `close()`. */
  bitmapsClosed: () => number;
  /** Every canvas created, to check it is emptied afterwards. */
  canvasElements: HTMLCanvasElement[];
}

/**
 * Stubs `createImageBitmap` (every photo is `width` x `height`, tagged with its file name) and
 * the canvas it is drawn on. The encoded blob contains the file name, so a test can tell which
 * photo an upload carried.
 */
export function stubImages(width = 4000, height = 3000): ImageStub {
  let closed = 0;
  const result: ImageStub = {
    canvases: [],
    toBlobCalls: [],
    bitmapOptions: [],
    bitmapsClosed: () => closed,
    canvasElements: [],
  };
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn((source: Blob & { name?: string }, options: unknown) => {
      result.bitmapOptions.push(options);
      return Promise.resolve({
        width,
        height,
        close: () => {
          closed += 1;
        },
        tag: source.name ?? '',
      });
    }),
  );

  let drawn = '';
  const context = {
    fillStyle: '',
    fillRect: vi.fn(),
    drawImage: vi.fn((source: { tag?: string }) => {
      drawn = source.tag ?? '';
    }),
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => context as unknown as RenderingContext & CanvasRenderingContext2D,
  );
  HTMLCanvasElement.prototype.toBlob = function (
    this: HTMLCanvasElement,
    callback: BlobCallback,
    type?: string,
    quality?: unknown,
  ): void {
    result.canvases.push({ width: this.width, height: this.height });
    result.canvasElements.push(this);
    result.toBlobCalls.push({ type, quality });
    callback(new Blob([drawn], { type: 'image/jpeg' }));
  };
  return result;
}

let objectUrlCounter = 0;
export function stubObjectUrls(): { created: string[]; revoked: string[] } {
  const created: string[] = [];
  const revoked: string[] = [];
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
    objectUrlCounter += 1;
    const url = `blob:test/${objectUrlCounter}`;
    created.push(url);
    return url;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
    revoked.push(url);
  });
  return { created, revoked };
}

export function imageFile(name: string, type = 'image/jpeg'): File {
  return new File([name], name, { type });
}

// --- MediaRecorder ----------------------------------------------------------------------------

export interface RecorderStub {
  constructed: { mimeType: string | undefined }[];
  getUserMedia: ReturnType<typeof vi.fn>;
  stoppedTracks: () => number;
}

export function stubRecorder(options: {
  supportedTypes: readonly string[];
  /** Rejects `getUserMedia` with a DOMException of this name. */
  denyWith?: string;
  /** `MediaRecorder.start()` throws. */
  startThrows?: boolean;
}): RecorderStub {
  const constructed: { mimeType: string | undefined }[] = [];
  let stopped = 0;

  class FakeMediaRecorder {
    static isTypeSupported(type: string): boolean {
      return options.supportedTypes.includes(type);
    }
    state: 'inactive' | 'recording' = 'inactive';
    mimeType: string;
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(_stream: unknown, init?: { mimeType?: string }) {
      constructed.push({ mimeType: init?.mimeType });
      this.mimeType = init?.mimeType ?? 'audio/webm';
    }
    start(): void {
      if (options.startThrows === true) throw new DOMException('cannot start', 'InvalidStateError');
      this.state = 'recording';
    }
    stop(): void {
      this.state = 'inactive';
      this.ondataavailable?.({ data: new Blob(['voice'], { type: this.mimeType }) });
      this.onstop?.();
    }
  }

  const getUserMedia = vi.fn(() => {
    if (options.denyWith !== undefined) {
      return Promise.reject(new DOMException('blocked', options.denyWith));
    }
    return Promise.resolve({
      getTracks: () => [
        {
          stop: () => {
            stopped += 1;
          },
        },
      ],
    });
  });
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia },
    configurable: true,
  });
  return { constructed, getUserMedia, stoppedTracks: () => stopped };
}

export function removeMediaDevices(): void {
  Reflect.deleteProperty(navigator, 'mediaDevices');
}
