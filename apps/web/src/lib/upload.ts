import { uploadMaterialResponseSchema, type UploadMaterialResponse } from '@evidomo/shared';
import { apiRequestErrorFrom, UnexpectedResponseError } from './api';

export interface UploadRequest {
  path: string;
  method: 'POST' | 'PUT';
  body: Blob;
  contentType: string;
  /** 0..1 of the request body sent; called often, so keep the handler cheap. */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

/**
 * Raw-body upload of one file (the API takes no multipart). XMLHttpRequest, not fetch, because
 * only XHR reports upload progress. A non-2xx answer rejects with `ApiRequestError`, a network
 * failure with a `TypeError` (as fetch does, so `describeRequestFailure` covers both), and an
 * aborted request with an `AbortError`.
 */
export function uploadMaterial(request: UploadRequest): Promise<UploadMaterialResponse> {
  return new Promise((resolve, reject) => {
    const { signal } = request;
    if (signal?.aborted === true) {
      reject(new DOMException('Upload aborted', 'AbortError'));
      return;
    }

    const xhr = new XMLHttpRequest();
    xhr.open(request.method, request.path);
    // The session cookie is httpOnly and goes along with same-origin requests.
    xhr.setRequestHeader('Content-Type', request.contentType);
    xhr.setRequestHeader('Accept', 'application/json');

    const onAbort = (): void => xhr.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const settle = (): void => signal?.removeEventListener('abort', onAbort);

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        request.onProgress?.(Math.min(1, event.loaded / event.total));
      }
    };
    xhr.onload = () => {
      settle();
      let body: unknown = undefined;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // Not JSON (a proxy's error page): the status still tells the caller enough.
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        const parsed = uploadMaterialResponseSchema.safeParse(body);
        if (parsed.success) resolve(parsed.data);
        else reject(new UnexpectedResponseError(request.path, xhr.status));
        return;
      }
      reject(apiRequestErrorFrom(xhr.status, body, xhr.getResponseHeader('Retry-After')));
    };
    xhr.onerror = () => {
      settle();
      reject(new TypeError('Network request failed'));
    };
    xhr.onabort = () => {
      settle();
      reject(new DOMException('Upload aborted', 'AbortError'));
    };

    xhr.send(request.body);
  });
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
