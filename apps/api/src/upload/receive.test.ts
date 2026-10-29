import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink } from 'node:fs/promises';
import { createServer, request, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createUploadTempDir,
  declaredLength,
  receiveUploadToTempFile,
  UnsafeUploadTempDirError,
  verifyPrivateDir,
  UploadAbortedError,
  UploadBodyTooLargeError,
} from './receive.ts';

// The receiver against a real HTTP server, so client disconnects and chunked bodies behave as
// they do in production.

let dir: string;
let server: Server;
let port: number;
let outcome: Promise<string> | undefined;
const MAX = 64 * 1024;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'evidomo-receive-'));
  server = createServer((req: IncomingMessage, res) => {
    outcome = receiveUploadToTempFile(req, { maxBytes: MAX, tempDir: dir });
    outcome.then(
      (file) => {
        res.writeHead(200).end(file);
      },
      (error: unknown) => {
        if (error instanceof UploadBodyTooLargeError) {
          res.writeHead(413, { Connection: 'close' }).end();
        } else if (!res.destroyed) {
          res.writeHead(500).end();
        }
      },
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

function send(
  body: Buffer,
  headers: Record<string, string>,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: 'POST', path: '/', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function settled(): Promise<unknown> {
  if (outcome === undefined) throw new Error('no request reached the server');
  return outcome.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('receiveUploadToTempFile', () => {
  it('writes the body to a private temp file that the caller owns', async () => {
    const body = Buffer.alloc(MAX, 7);
    const response = await send(body, { 'Content-Length': String(body.length) });
    expect(response.status).toBe(200);
    const file = response.text;
    expect(path.dirname(file)).toBe(dir);
    expect(await readFile(file)).toEqual(body);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await rm(file);
  });

  it('stops at the limit for a chunked body and removes the partial file', async () => {
    const response = await send(Buffer.alloc(MAX * 4, 1), { 'Transfer-Encoding': 'chunked' }).catch(
      (error: unknown) => ({ status: -1, text: String(error) }),
    );
    // The server answers 413 and closes; a client still sending may see the reset instead.
    expect([413, -1]).toContain(response.status);
    expect(await settled()).toBeInstanceOf(UploadBodyTooLargeError);
    expect(await readdir(dir)).toEqual([]);
  });

  it('removes the partial file when the client disconnects mid-body', async () => {
    await new Promise<void>((resolve) => {
      const req = request({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/',
        headers: { 'Content-Length': String(MAX) },
      });
      req.on('error', () => resolve());
      req.write(Buffer.alloc(1024, 2), () => {
        setTimeout(() => {
          req.destroy();
          resolve();
        }, 50);
      });
    });
    await expect.poll(async () => settled(), { timeout: 2000 }).toBeInstanceOf(UploadAbortedError);
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('declaredLength', () => {
  it('reads a numeric Content-Length only', () => {
    const req = (value: string | undefined) =>
      ({ headers: value === undefined ? {} : { 'content-length': value } }) as IncomingMessage;
    expect(declaredLength(req('42'))).toBe(42);
    expect(declaredLength(req(undefined))).toBeUndefined();
    expect(declaredLength(req('4e2'))).toBeUndefined();
  });
});

describe('upload temp directory', () => {
  it('creates one private per-process directory by default', async () => {
    const resolve = createUploadTempDir();
    const first = await resolve();
    try {
      expect(await resolve()).toBe(first);
      expect(path.basename(first)).toMatch(/^evidomo-uploads-.{6}$/);
      expect((await stat(first)).mode & 0o777).toBe(0o700);
      expect(await verifyPrivateDir(first)).toBe(first);
    } finally {
      await rm(first, { recursive: true, force: true });
    }
  });

  it('refuses a configured directory that others can access or that is a symlink', async () => {
    const open = path.join(dir, 'open');
    await mkdir(open, { mode: 0o755 });
    await chmod(open, 0o755);
    await expect(verifyPrivateDir(open)).rejects.toBeInstanceOf(UnsafeUploadTempDirError);

    const target = path.join(dir, 'target');
    await mkdir(target, { mode: 0o700 });
    const link = path.join(dir, 'link');
    await symlink(target, link);
    await expect(createUploadTempDir(link)()).rejects.toBeInstanceOf(UnsafeUploadTempDirError);
    expect(await createUploadTempDir(target)()).toBe(target);
    await rm(open, { recursive: true });
    await rm(target, { recursive: true });
    await rm(link);
  });
});
