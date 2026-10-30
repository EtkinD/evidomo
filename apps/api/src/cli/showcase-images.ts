import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { MetaClients } from '../meta/clients.ts';
import { generateMetaImageToolsOff, type MetaImageSize } from '../meta/images.ts';
import type { InMemoryUsageRecorder } from '../meta/usage.ts';

// Design-exploration images for the dev-only showcase (P4B-01), generated with every Muse Image
// tool off so that no searched or third-party content can enter them (docs/model-notes.md,
// "Muse Image"). The manifest shape is the contract with the web showcase.

export const SHOWCASE_KINDS = ['logo-concept', 'hero', 'interior', 'illustration'] as const;
export type ShowcaseKind = (typeof SHOWCASE_KINDS)[number];

export const SHOWCASE_DIRECTION_IDS = ['B', 'B2', 'B3'] as const;
export type ShowcaseDirectionId = (typeof SHOWCASE_DIRECTION_IDS)[number];

/** How the tools were turned off: the endpoint whose JSON body validates `tool_enablement`. */
export type ShowcaseToolsOffMethod = 'generations' | 'edit-json';

export interface ShowcaseDirection {
  readonly id: ShowcaseDirectionId;
  readonly name: string;
  readonly mood: string;
  /** Appended to every prompt of the direction. */
  readonly palette: string;
}

export interface ShowcaseImageSpec {
  readonly direction: ShowcaseDirectionId;
  readonly kind: ShowcaseKind;
  /** Content only; style, palette, and constraints are added by {@link planShowcaseImages}. */
  readonly subject: string;
}

interface KindLayout {
  readonly idPart: string;
  readonly filePart: string;
  readonly size: MetaImageSize;
  readonly style: string;
}

const KIND_LAYOUT: Readonly<Record<ShowcaseKind, KindLayout>> = {
  'logo-concept': {
    idPart: 'LOGO',
    filePart: 'logo',
    size: '1024x1024',
    style:
      'Logo concept: an abstract mark only, flat vector style, solid colours, clean geometric ' +
      'shapes, no gradients or shadows, centred on a plain flat background with generous margin, ' +
      'square format.',
  },
  hero: {
    idPart: 'HERO',
    filePart: 'hero',
    size: '1536x1024',
    style:
      'Wide 3:2 hero image for a property website, photorealistic, natural light, uncluttered ' +
      'composition with calm negative space.',
  },
  interior: {
    idPart: 'INT',
    filePart: 'interior',
    size: '1536x1024',
    style: 'Interior detail photograph, 3:2, photorealistic, natural materials, calm composition.',
  },
  illustration: {
    idPart: 'ILL',
    filePart: 'illustration',
    size: '1024x1024',
    style:
      'Flat vector illustration for an app empty state, simple shapes, limited palette, soft ' +
      'plain background, square format.',
  },
};

/** Appended to every prompt. Exploration assets must be new work without people or text. */
export const SHOWCASE_CONSTRAINTS =
  'Original artwork created from scratch. No people, no faces, no hands, no animals. No text, ' +
  'no letters, no numbers, no words, no captions, no watermarks, no signatures. No logos, no ' +
  'brand names, no trademarks. No licence plates, no house numbers, no street signs. No ' +
  'recognisable real buildings, landmarks, or artworks.';

export interface PlannedShowcaseImage {
  readonly id: string;
  readonly direction: ShowcaseDirectionId;
  readonly kind: ShowcaseKind;
  /** Relative to the output directory, POSIX separators (the web app serves it as a URL). */
  readonly file: string;
  readonly prompt: string;
  readonly size: MetaImageSize;
}

export class ShowcasePlanError extends Error {
  override name = 'ShowcasePlanError';
}

/**
 * Numbers the specs per direction and kind in list order (`B2-LOGO-1`, `B2/logo-1.webp`) and
 * composes each full prompt: subject, kind style, direction palette, constraints.
 */
export function planShowcaseImages(
  directions: readonly ShowcaseDirection[],
  specs: readonly ShowcaseImageSpec[],
): PlannedShowcaseImage[] {
  const byId = new Map(directions.map((direction) => [direction.id, direction]));
  if (byId.size !== directions.length) throw new ShowcasePlanError('Duplicate direction ID');
  const counters = new Map<string, number>();
  return specs.map((spec) => {
    const direction = byId.get(spec.direction);
    if (direction === undefined) {
      throw new ShowcasePlanError(`Unknown direction ${spec.direction}`);
    }
    const layout = KIND_LAYOUT[spec.kind];
    const key = `${spec.direction}-${layout.idPart}`;
    const n = (counters.get(key) ?? 0) + 1;
    counters.set(key, n);
    return {
      id: `${key}-${n}`,
      direction: spec.direction,
      kind: spec.kind,
      file: `${spec.direction}/${layout.filePart}-${n}.webp`,
      prompt: [spec.subject.trim(), layout.style, direction.palette, SHOWCASE_CONSTRAINTS].join(
        ' ',
      ),
      size: layout.size,
    };
  });
}

const manifestItemSchema = z.object({
  id: z.string().min(1),
  direction: z.enum(SHOWCASE_DIRECTION_IDS),
  kind: z.enum(SHOWCASE_KINDS),
  file: z.string().min(1),
  prompt: z.string().min(1),
  width: z.int().positive(),
  height: z.int().positive(),
});

export const showcaseManifestSchema = z.object({
  generatedAt: z.iso.datetime(),
  toolsOff: z.enum(['generations', 'edit-json']),
  items: z.array(manifestItemSchema),
});

export type ShowcaseManifestItem = z.infer<typeof manifestItemSchema>;
export type ShowcaseManifest = z.infer<typeof showcaseManifestSchema>;

/** The manifest for the generated items, in plan order; planned items not yet generated are left out. */
export function buildShowcaseManifest(
  plan: readonly PlannedShowcaseImage[],
  generated: ReadonlyMap<string, ShowcaseManifestItem>,
  generatedAt: Date,
  toolsOff: ShowcaseToolsOffMethod,
): ShowcaseManifest {
  const items = plan.flatMap((planned) => {
    const item = generated.get(planned.id);
    return item === undefined ? [] : [item];
  });
  return { generatedAt: generatedAt.toISOString(), toolsOff, items };
}

export const SHOWCASE_MANIFEST_FILE = 'manifest.json';

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Items of an earlier run that can be kept: same ID, file, and prompt as planned, and the file
 * is still on disk. A missing manifest means nothing to keep; an invalid one is an error.
 */
async function reusableItems(
  outDir: string,
  plan: readonly PlannedShowcaseImage[],
  toolsOff: ShowcaseToolsOffMethod,
): Promise<Map<string, ShowcaseManifestItem>> {
  const manifestPath = path.join(outDir, SHOWCASE_MANIFEST_FILE);
  if (!(await exists(manifestPath))) return new Map();
  const previous = showcaseManifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
  const kept = new Map<string, ShowcaseManifestItem>();
  // Images made another way are not reused under this run's `toolsOff` label.
  if (previous.toolsOff !== toolsOff) return kept;
  const planned = new Map(plan.map((item) => [item.id, item]));
  for (const item of previous.items) {
    const match = planned.get(item.id);
    if (match?.file !== item.file || match.prompt !== item.prompt) continue;
    if (await exists(path.join(outDir, item.file))) kept.set(item.id, item);
  }
  return kept;
}

export interface GenerateShowcaseOptions {
  readonly clients: MetaClients;
  /** The usage recorder behind `clients`; spend is summed from it, failed billed calls included. */
  readonly usage: InMemoryUsageRecorder;
  /** From the service definition. */
  readonly modelId: string;
  readonly outDir: string;
  readonly plan: readonly PlannedShowcaseImage[];
  /** Regenerate exactly these IDs (and nothing else), even when a kept image exists. */
  readonly only?: ReadonlySet<string>;
  /** No call starts that could take the spend of this invocation above this amount. */
  readonly maxUsd: number;
  /** The price of one returned image, from the price table. */
  readonly usdPerImage: number;
  readonly concurrency: number;
  readonly progress: (line: string) => void;
  readonly now?: () => Date;
}

export interface ShowcaseFailure {
  readonly id: string;
  readonly error: string;
}

export interface GenerateShowcaseResult {
  readonly manifest: ShowcaseManifest;
  readonly generated: readonly string[];
  readonly kept: readonly string[];
  readonly failed: readonly ShowcaseFailure[];
  /** Planned items not attempted because the budget would have been exceeded. */
  readonly notAttempted: readonly string[];
  readonly spentUsd: number;
}

export class ShowcaseSpendUnknownError extends Error {
  override name = 'ShowcaseSpendUnknownError';
}

function spentUsd(usage: InMemoryUsageRecorder): number {
  let total = 0;
  for (const entry of usage.entries) {
    if (entry.estimatedCostUsd === undefined) {
      throw new ShowcaseSpendUnknownError(
        `A ${entry.modelId} call has no cost estimate; stopping before the spend is unknown`,
      );
    }
    total += entry.estimatedCostUsd;
  }
  return total;
}

/**
 * Generates the planned images that are missing (or the `only` IDs) through
 * {@link generateMetaImageToolsOff}, writes each as `<outDir>/<file>`, and rewrites the manifest
 * after every image, so an interrupted run keeps what it paid for.
 */
export async function generateShowcaseImages(
  options: GenerateShowcaseOptions,
): Promise<GenerateShowcaseResult> {
  const { clients, usage, modelId, outDir, plan, only, maxUsd, usdPerImage, progress } = options;
  const now = options.now ?? (() => new Date());
  const toolsOff: ShowcaseToolsOffMethod = 'generations';
  if (only !== undefined) {
    const unknown = [...only].filter((id) => !plan.some((item) => item.id === id));
    if (unknown.length > 0) throw new ShowcasePlanError(`Unknown IDs: ${unknown.join(', ')}`);
  }

  const items = await reusableItems(outDir, plan, toolsOff);
  const kept = plan
    .filter((item) => items.has(item.id) && only?.has(item.id) !== true)
    .map((item) => item.id);
  const todo = plan.filter((item) =>
    only === undefined ? !items.has(item.id) : only.has(item.id),
  );
  const startingSpend = spentUsd(usage);

  let writes = Promise.resolve();
  const writeManifest = (): Promise<void> => {
    writes = writes.then(async () => {
      const manifestPath = path.join(outDir, SHOWCASE_MANIFEST_FILE);
      const manifest = buildShowcaseManifest(plan, items, now(), toolsOff);
      await writeFile(`${manifestPath}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`);
      await rename(`${manifestPath}.tmp`, manifestPath);
    });
    return writes;
  };

  const generated: string[] = [];
  const failed: ShowcaseFailure[] = [];
  const notAttempted: string[] = [];
  let inFlight = 0;
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const item = todo[next];
      if (item === undefined) return;
      next += 1;
      // Reserve the price of every running call, so parallel workers cannot overshoot together.
      const committed = spentUsd(usage) - startingSpend + (inFlight + 1) * usdPerImage;
      if (committed > maxUsd + 1e-9) {
        notAttempted.push(item.id);
        continue;
      }
      inFlight += 1;
      try {
        const result = await generateMetaImageToolsOff(clients, {
          modelId,
          prompt: item.prompt,
          size: item.size,
          outputFormat: 'webp',
        });
        const [image] = result.images;
        if (image === undefined || result.images.length !== 1 || image.format !== 'webp') {
          throw new Error(`expected one WebP image, got ${String(result.images.length)}`);
        }
        const target = path.join(outDir, ...item.file.split('/'));
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, image.bytes);
        items.set(item.id, {
          id: item.id,
          direction: item.direction,
          kind: item.kind,
          file: item.file,
          prompt: item.prompt,
          width: image.width,
          height: image.height,
        });
        await writeManifest();
        generated.push(item.id);
        progress(
          `${item.id}: ${String(image.width)}x${String(image.height)}, ` +
            `${(result.usage.latencyMs / 1000).toFixed(1)} s`,
        );
      } catch (error) {
        if (error instanceof ShowcaseSpendUnknownError) throw error;
        const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        failed.push({ id: item.id, error: message });
        progress(`${item.id}: FAILED ${message}`);
      } finally {
        inFlight -= 1;
      }
    }
  };

  await mkdir(outDir, { recursive: true });
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency) }, () => worker()));
  await writeManifest();

  return {
    manifest: buildShowcaseManifest(plan, items, now(), toolsOff),
    generated,
    kept,
    failed,
    notAttempted,
    spentUsd: spentUsd(usage) - startingSpend,
  };
}
