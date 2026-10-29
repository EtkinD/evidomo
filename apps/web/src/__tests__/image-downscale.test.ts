import { describe, expect, it, vi } from 'vitest';
import { DownscaleError, downscaleImage, fitLongEdge } from '../lib/image-downscale';
import { stubImages } from './capture-helpers';

describe('fitLongEdge', () => {
  it('fits the long edge and keeps the aspect ratio', () => {
    expect(fitLongEdge(4000, 3000)).toEqual({ width: 2048, height: 1536 });
    expect(fitLongEdge(3000, 4000)).toEqual({ width: 1536, height: 2048 });
    expect(fitLongEdge(12000, 100)).toEqual({ width: 2048, height: 17 });
  });

  it('never enlarges and never reaches zero', () => {
    expect(fitLongEdge(1024, 768)).toEqual({ width: 1024, height: 768 });
    expect(fitLongEdge(2048, 2048)).toEqual({ width: 2048, height: 2048 });
    expect(fitLongEdge(100_000, 1)).toEqual({ width: 2048, height: 1 });
  });
});

describe('downscaleImage', () => {
  it('draws at most 2048 px on the long edge and encodes JPEG at 0.85', async () => {
    const images = stubImages(6000, 4000);

    const blob = await downscaleImage(new File(['x'], 'big.png', { type: 'image/png' }));

    expect(blob.type).toBe('image/jpeg');
    expect(images.canvases).toEqual([{ width: 2048, height: 1365 }]);
    expect(images.toBlobCalls).toEqual([{ type: 'image/jpeg', quality: 0.85 }]);
    expect(images.bitmapOptions).toEqual([{ imageOrientation: 'from-image' }]);
  });

  it('re-encodes a small photo without enlarging it', async () => {
    const images = stubImages(800, 600);

    await downscaleImage(new File(['x'], 'small.jpg', { type: 'image/jpeg' }));

    expect(images.canvases).toEqual([{ width: 800, height: 600 }]);
  });

  it('falls back to an image element when createImageBitmap cannot decode', async () => {
    const images = stubImages();
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(() => Promise.reject(new Error('no'))),
    );
    class LoadedImage {
      naturalWidth = 3000;
      naturalHeight = 2000;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal('Image', LoadedImage);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    vi.spyOn(URL, 'revokeObjectURL').mockReturnValue();

    await downscaleImage(new File(['x'], 'IMG.HEIC', { type: 'image/heic' }));

    expect(images.canvases).toEqual([{ width: 2048, height: 1365 }]);
  });

  it('reports HEIC and other undecodable files with different failures', async () => {
    stubImages();
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(() => Promise.reject(new Error('no'))),
    );
    class BrokenImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onerror?.());
      }
    }
    vi.stubGlobal('Image', BrokenImage);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    vi.spyOn(URL, 'revokeObjectURL').mockReturnValue();

    await expect(
      downscaleImage(new File(['x'], 'a.heic', { type: 'image/heic' })),
    ).rejects.toMatchObject({ failure: 'heic_unreadable' });
    await expect(
      downscaleImage(new File(['x'], 'a.jpg', { type: 'image/jpeg' })),
    ).rejects.toBeInstanceOf(DownscaleError);
    await expect(
      downscaleImage(new File(['x'], 'a.jpg', { type: 'image/jpeg' })),
    ).rejects.toMatchObject({ failure: 'undecodable' });
  });
});
