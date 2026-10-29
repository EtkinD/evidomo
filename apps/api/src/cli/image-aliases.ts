import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Interaction } from '../meta/fixtures.ts';
import { encodeStagedImage, StagedImageEncodeError } from '../pipeline/staging/encode.ts';
import { imageForClassification } from '../pipeline/vision/downscale.ts';

// Stable cassette keys for a full recorded run. Requests are matched by a hash of their body,
// and three kinds of image in those bodies are our own sharp re-encodes, whose bytes may differ
// between arm64 (where runs are recorded) and x86-64 (CI) (docs/model-notes.md, "Cross-cutting
// gotchas"):
//
// - stored photos (upload processing re-encodes every upload) → named after the uploaded file;
// - their classification copies (vision downscales photos above `classification_long_edge_px`);
// - stored staged images (staging re-encodes Muse Image's output) → named after the model's
//   output bytes, which come from the cassette and are identical on every machine.
//
// The names replace the image bytes in the request hash (`MatchOptions.imageAlias`).

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const imageEditsResponseSchema = z.object({
  data: z.array(z.object({ b64_json: z.string().min(1) })),
});

export interface FixtureImageAliases {
  /** For `MatchOptions.imageAlias`. */
  readonly alias: (sha256: string) => string | undefined;
  /** For `MetaReplayOptions.onInteraction`: names the stored form of every Muse Image output. */
  readonly onInteraction: (interaction: Interaction) => Promise<void>;
  /** Names a stored photo, and its classification copy, after the uploaded file. */
  registerPhoto(
    stored: { readonly bytes: Uint8Array; readonly width: number; readonly height: number },
    sourceSha256: string,
    classificationLongEdgePx: number | undefined,
  ): Promise<void>;
  /** Images sent without a name: their requests are keyed on bytes (platform-dependent). */
  readonly unnamedImageCount: () => number;
}

export function createFixtureImageAliases(): FixtureImageAliases {
  const names = new Map<string, string>();
  const unnamed = new Set<string>();

  function register(bytes: Uint8Array, name: string): void {
    names.set(sha256Hex(bytes), name);
  }

  return {
    alias(sha256) {
      const name = names.get(sha256);
      if (name === undefined) unnamed.add(sha256);
      return name;
    },
    async onInteraction(interaction) {
      if (interaction.request.path !== '/v1/images/edits') return;
      const { body } = interaction.response;
      if (body.type !== 'json') return;
      const parsed = imageEditsResponseSchema.safeParse(body.value);
      if (!parsed.success) return; // The step rejects this response itself (invalid_output).
      for (const item of parsed.data.data) {
        const output = new Uint8Array(Buffer.from(item.b64_json, 'base64'));
        try {
          const encoded = await encodeStagedImage(output);
          register(encoded.bytes, `staged:${sha256Hex(output)}`);
        } catch (error) {
          // Undecodable output is never stored or sent on (staging records invalid_output).
          if (!(error instanceof StagedImageEncodeError)) throw error;
        }
      }
    },
    async registerPhoto(stored, sourceSha256, classificationLongEdgePx) {
      register(stored.bytes, `photo:${sourceSha256}`);
      if (classificationLongEdgePx === undefined) return;
      const copy = await imageForClassification(
        {
          bytes: stored.bytes,
          mediaType: 'image/jpeg',
          width: stored.width,
          height: stored.height,
        },
        classificationLongEdgePx,
      );
      if (copy.bytes !== stored.bytes) {
        register(copy.bytes, `photo:${sourceSha256}:classification-${classificationLongEdgePx}`);
      }
    },
    unnamedImageCount: () => unnamed.size,
  };
}
