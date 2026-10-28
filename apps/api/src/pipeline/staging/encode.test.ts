import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { imageDimensions } from '../../meta/images.ts';
import {
  encodeStagedImage,
  STAGED_DIGITAL_SOURCE_TYPE,
  STAGED_IMAGE_XMP,
  StagedImageEncodeError,
} from './encode.ts';

// The stored form of a staged image: model metadata dropped, our AI-composite marker added.

const MODEL_XMP =
  '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
  '<rdf:Description rdf:about="" xmlns:iptcExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/" ' +
  'iptcExt:DigitalSourceType="http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia" ' +
  'xmlns:dc="http://purl.org/dc/elements/1.1/" dc:creator="model-written"/></rdf:RDF></x:xmpmeta>';

/** A model-like output: JPEG with EXIF and an XMP packet of the model's own. */
async function modelOutput(width: number, height: number): Promise<Uint8Array> {
  const data = await sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 180, b: 160 } },
  })
    .jpeg()
    .withExif({ IFD0: { Copyright: 'model-written', Software: 'model-written' } })
    .withXmp(MODEL_XMP)
    .toBuffer();
  return new Uint8Array(data);
}

describe('encodeStagedImage', () => {
  it('re-encodes as JPEG without EXIF, ICC, or the model XMP, and adds the composite marker', async () => {
    const encoded = await encodeStagedImage(await modelOutput(1920, 1280));
    expect(encoded).toMatchObject({ width: 1920, height: 1280 });
    expect(imageDimensions(encoded.bytes)).toEqual({ format: 'jpeg', width: 1920, height: 1280 });

    const metadata = await sharp(encoded.bytes).metadata();
    expect(metadata.exif).toBeUndefined();
    expect(metadata.icc).toBeUndefined();
    expect(metadata.iptc).toBeUndefined();
    const xmp = metadata.xmp?.toString('utf8') ?? '';
    expect(xmp).toContain(STAGED_DIGITAL_SOURCE_TYPE);
    expect(xmp).not.toContain('model-written');
    expect(xmp).not.toContain('digitalsourcetype/trainedAlgorithmicMedia"');
    expect(STAGED_IMAGE_XMP).toContain('compositeWithTrainedAlgorithmicMedia');
    expect(Buffer.from(encoded.bytes).includes('model-written')).toBe(false);
  });

  it('fits the stored-photo long edge without enlarging smaller outputs', async () => {
    expect(await encodeStagedImage(await modelOutput(3000, 2000))).toMatchObject({
      width: 2048,
      height: 1365,
    });
    expect(await encodeStagedImage(await modelOutput(960, 640))).toMatchObject({
      width: 960,
      height: 640,
    });
  });

  it('rejects bytes that are not an image', async () => {
    await expect(encodeStagedImage(new TextEncoder().encode('not an image'))).rejects.toThrow(
      StagedImageEncodeError,
    );
  });
});
