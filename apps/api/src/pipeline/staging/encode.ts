import { UPLOAD_LIMITS } from '@evidomo/shared';
import sharp from 'sharp';
import { isEnvironmentError } from '../../media/upload-error.ts';

// The staged image as stored: the model's output re-encoded like an upload (P2-05: at most the
// stored-photo long edge, sRGB, JPEG q85, no metadata from the input), plus one XMP packet of
// our own that marks it as an AI-edited composite.
//
// Why not keep the model's metadata: it is untrusted output (Muse Image writes an XMP packet
// whose content we do not control). Why add our own: stripping alone would also remove the only
// machine-readable AI disclosure; the visible "Virtually staged" label is the primary one.

export const STAGED_IMAGE_QUALITY = 85;

/**
 * IPTC Digital Source Type for "a composite that includes trained algorithmic media": an AI
 * edit of a real photo. Muse Image itself writes `trainedAlgorithmicMedia` (fully generated).
 */
export const STAGED_DIGITAL_SOURCE_TYPE =
  'http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia';

export const STAGED_IMAGE_XMP =
  '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF ' +
  'xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" ' +
  'xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/" ' +
  `Iptc4xmpExt:DigitalSourceType="${STAGED_DIGITAL_SOURCE_TYPE}"/></rdf:RDF></x:xmpmeta>`;

/** The model's bytes could not be decoded or re-encoded as an image. */
export class StagedImageEncodeError extends Error {
  override name = 'StagedImageEncodeError';
}

export interface EncodedStagedImage {
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
}

export async function encodeStagedImage(modelOutput: Uint8Array): Promise<EncodedStagedImage> {
  try {
    const { data, info } = await sharp(modelOutput, {
      failOn: 'error',
      limitInputPixels: UPLOAD_LIMITS.photoMaxPixels,
      autoOrient: true,
    })
      .resize({
        width: UPLOAD_LIMITS.photoLongEdgePx,
        height: UPLOAD_LIMITS.photoLongEdgePx,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .flatten({ background: '#ffffff' })
      .toColourspace('srgb')
      .jpeg({ quality: STAGED_IMAGE_QUALITY, mozjpeg: true })
      .withXmp(STAGED_IMAGE_XMP)
      .toBuffer({ resolveWithObject: true });
    return {
      bytes: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      width: info.width,
      height: info.height,
    };
  } catch (error) {
    // A missing native binary or exhausted memory is ours; undecodable bytes are the model's.
    if (isEnvironmentError(error)) throw error;
    throw new StagedImageEncodeError('The staged image could not be decoded', { cause: error });
  }
}
