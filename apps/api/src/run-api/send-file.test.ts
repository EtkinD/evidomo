import { Readable } from 'node:stream';
import { apiErrorSchema } from '@evidomo/shared';
import express from 'express';
import { pino } from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { unusedStorage } from '../http/testing.ts';
import { StorageNotFoundError, type Storage } from '../storage/storage.ts';
import { etagMatches, sendStoredFile, type StoredFileResponse } from './send-file.ts';

const logger = pino({ enabled: false });
const BYTES = Buffer.from('0123456789');

const file: StoredFileResponse = {
  storageKey: 'projects/p/materials/a.wav',
  contentType: 'audio/wav',
  etag: 'abc',
  fileName: 'voice-memo-a.wav',
  disposition: 'inline',
  rangeable: true,
};

function appWith(storage: Storage) {
  const app = express();
  app.get('/file', async (req, res) => {
    await sendStoredFile(req, res, storage, file, logger);
  });
  return app;
}

const working: Storage = {
  ...unusedStorage(),
  stat: () => Promise.resolve({ sizeBytes: BYTES.byteLength }),
  get: (_key, options = {}) => {
    const { range } = options;
    return Promise.resolve(
      Readable.from([range === undefined ? BYTES : BYTES.subarray(range.start, range.end + 1)]),
    );
  },
};

describe('sendStoredFile', () => {
  it('answers a clean 500 without file headers when opening the file fails', async () => {
    const failing: Storage = {
      ...working,
      get: (key) => Promise.reject(new StorageNotFoundError(key)),
    };
    const response = await request(appWith(failing)).get('/file').set('Range', 'bytes=0-3');

    expect(response.status).toBe(500);
    expect(apiErrorSchema.parse(response.body).error).toBe('internal_error');
    // Express adds its own weak ETag to JSON bodies; the file's must not leak onto the error.
    expect(response.get('etag')).not.toBe('"abc"');
    for (const header of [
      'content-disposition',
      'content-range',
      'accept-ranges',
      'cache-control',
    ]) {
      expect(response.get(header), header).toBeUndefined();
    }
  });

  it('sets the file headers on success and only cache headers on 304 and 416', async () => {
    const ok = await request(appWith(working)).get('/file').set('Range', 'bytes=2-5');
    expect(ok.status).toBe(206);
    expect(ok.get('content-range')).toBe('bytes 2-5/10');
    expect(ok.get('etag')).toBe('"abc"');

    const notModified = await request(appWith(working))
      .get('/file')
      .set('If-None-Match', 'W/"other", "abc"');
    expect(notModified.status).toBe(304);
    expect(notModified.get('etag')).toBe('"abc"');
    expect(notModified.get('content-disposition')).toBeUndefined();

    const unsatisfiable = await request(appWith(working)).get('/file').set('Range', 'bytes=10-');
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.get('content-range')).toBe('bytes */10');
    expect(unsatisfiable.get('content-disposition')).toBeUndefined();
  });
});

describe('etagMatches', () => {
  it('matches `*`, lists, and weak forms of the same tag', () => {
    expect(etagMatches('"abc"', '"abc"')).toBe(true);
    expect(etagMatches('*', '"abc"')).toBe(true);
    expect(etagMatches('"x", W/"abc"', '"abc"')).toBe(true);
    expect(etagMatches('"abcd"', '"abc"')).toBe(false);
    expect(etagMatches(undefined, '"abc"')).toBe(false);
  });
});
