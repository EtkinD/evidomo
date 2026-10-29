import { expect, test, type Page } from '@playwright/test';
import { createProjectAndOpenCapture } from './support/capture.ts';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Registers an account and uploads to the local stack, so it never runs against a deployment.
test.skip(Boolean(process.env['E2E_BASE_URL']), 'creates accounts; local stack only');

// The service needs 10 photos: three ordered ones, eight interiors, and one deleted again.
const INTERIORS_DIR = fileURLToPath(
  new URL('../fixtures/samples/synthetic-interiors/', import.meta.url),
);
const INTERIORS = readdirSync(INTERIORS_DIR)
  .filter((name) => name.endsWith('.jpg'))
  .sort()
  .slice(0, 8)
  .map((name) => join(INTERIORS_DIR, name));

/** One second of a 440 Hz tone: 16 kHz, 16-bit mono PCM in a WAV container. */
function toneWav(): Buffer {
  const sampleRate = 16_000;
  const samples = sampleRate;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    data.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / sampleRate)), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

// Chromium's fake capture device feeds the recorder a test tone without a microphone or prompt.
test.use({
  permissions: ['microphone'],
  launchOptions: {
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  },
});

/** Three JPEGs that differ in width, so the server's stored widths reveal the upload order. */
async function orderedJpegs(
  page: Page,
  widths: readonly number[],
): Promise<{ name: string; mimeType: string; buffer: Buffer }[]> {
  // A script string: this tsconfig has no DOM types, and the code runs in the page anyway.
  const result: unknown = await page.evaluate(`(() => {
    return ${JSON.stringify(widths)}.map((width) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = 200;
      const context = canvas.getContext('2d');
      context.fillStyle = '#808080';
      context.fillRect(0, 0, width, 200);
      return canvas.toDataURL('image/jpeg', 0.9).split(',')[1];
    });
  })()`);
  const base64s = Array.isArray(result)
    ? result.filter((item): item is string => typeof item === 'string')
    : [];
  expect(base64s).toHaveLength(widths.length);
  return base64s.map((data, index) => ({
    name: `order-${index + 1}.jpg`,
    mimeType: 'image/jpeg',
    buffer: Buffer.from(data, 'base64'),
  }));
}

// One account and one project for the whole journey: registration is limited to 20 per hour per
// IP, so every extra account spends from a budget the other specs need.
test('capture: photos in order, delete, an audio file, a recording, and readiness', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await createProjectAndOpenCapture(page);
  const needed = page.getByRole('region', { name: 'What is still needed' });
  const grid = page.getByRole('list', { name: 'Photos' });
  const projectId = /\/projects\/([0-9a-f-]{36})\/capture$/.exec(page.url())?.[1];
  expect(projectId).toBeDefined();

  await test.step('nothing is there yet', async () => {
    await expect(needed.getByText(/Add at least 10 photos \(0 so far\)/)).toBeVisible();
    await expect(needed.getByText(/Record a voice walkthrough/)).toBeVisible();
  });

  await test.step('photos are uploaded in the order they were chosen', async () => {
    const widths = [320, 480, 640];
    await page.getByLabel('Photo files').setInputFiles(await orderedJpegs(page, widths));
    await expect(page.getByText('3 photos uploaded.')).toBeAttached({ timeout: 30_000 });
    await expect(grid.getByRole('listitem')).toHaveCount(3);
    // The API numbers photos by commit order; the stored widths prove which file is which.
    const response = await page.request.get(`/api/projects/${projectId ?? ''}`);
    const detail: unknown = await response.json();
    expect(detail).toMatchObject({
      materials: [
        { kind: 'photo', position: 1, width: 320 },
        { kind: 'photo', position: 2, width: 480 },
        { kind: 'photo', position: 3, width: 640 },
      ],
    });
  });

  await test.step('eight more photos from the synthetic interiors', async () => {
    await page.getByLabel('Photo files').setInputFiles(INTERIORS);
    await expect(page.getByText('8 photos uploaded.')).toBeAttached({ timeout: 60_000 });
    await expect(page.getByText('11 of 30')).toBeVisible();
    await expect(grid.getByRole('img', { name: 'Photo 11' })).toBeVisible();
  });

  await test.step('deleting one updates the count', async () => {
    await page.getByRole('button', { name: 'Delete photo 11' }).click();
    await expect(page.getByText('10 of 30')).toBeVisible();
    await expect(grid.getByRole('listitem')).toHaveCount(10);
    await expect(needed.getByText(/Add at least 10 photos/)).toHaveCount(0);
  });

  await test.step('an audio file is previewed, then uploaded', async () => {
    await page
      .getByLabel('Audio file')
      .setInputFiles({ name: 'walkthrough.wav', mimeType: 'audio/wav', buffer: toneWav() });
    await expect(page.getByText('Preview: walkthrough.wav')).toBeVisible();
    await page.getByRole('button', { name: 'Upload walkthrough' }).click();
    await expect(page.locator('audio[aria-label="Current walkthrough"]')).toBeVisible();
    await expect(needed.getByText(/Record a voice walkthrough/)).toHaveCount(0);
  });

  await test.step('a new recording from the fake microphone replaces it', async () => {
    await page.getByRole('button', { name: 'Record a new walkthrough' }).click();
    await expect(page.getByRole('timer', { name: 'Recording time' })).toBeVisible();
    await page.waitForTimeout(1500);
    await page.getByRole('button', { name: 'Stop recording' }).click();
    await expect(page.getByLabel('Preview of the new walkthrough')).toBeVisible();
    await page.getByRole('button', { name: 'Upload walkthrough' }).click();
    await expect(page.getByText('Walkthrough uploaded.')).toBeAttached();
    await expect(page.getByRole('button', { name: 'Record a new walkthrough' })).toBeVisible();
  });

  await test.step('the project page agrees', async () => {
    await page.getByRole('link', { name: 'Back to the project' }).click();
    const readiness = page.getByRole('region', { name: 'Ready to run?' });
    await expect(readiness.getByText(/Add at least 10 photos/)).toHaveCount(0);
    await expect(readiness.getByText(/Record a voice walkthrough/)).toHaveCount(0);
    await expect(
      page.getByRole('region', { name: 'Materials' }).getByText('Recorded'),
    ).toBeVisible();
  });
});
