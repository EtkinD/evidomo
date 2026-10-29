// Test support for the export (P3-09): synthetic photos, inventory entries, and a whole run up to
// Gate 2 (materials with stored files, inventory, verified facts, copy and claims, staged images,
// integrity record, claim audit). All data is invented; nothing here makes a model call.
// Imported only by tests.
import { createHash } from 'node:crypto';
import {
  CLAIM_AUDIT_ARTIFACT_KIND,
  CLAIM_VALIDATOR_RULES_VERSION,
  INTEGRITY_CHECKS_ARTIFACT_KIND,
  PHOTO_INVENTORY_ARTIFACT_KIND,
  STAGED_IMAGE_ARTIFACT_KIND,
  STAGED_IMAGE_LABEL,
  claimAuditContentSchema,
  integrityChecksContentSchema,
  listingCopyContentSchema,
  photoInventoryContentSchema,
  stagedImageContentSchema,
  type ClaimAuditCategory,
  type ClaimAuditFlag,
  type InventoryPhoto,
  type ListingCopyContent,
  type MarketProfile,
  type PhotoInventoryContent,
  type PhotoSubject,
  type SamRegion,
  type StagedImageContent,
  type StagingOperationId,
} from '@evidomo/shared';
import sharp from 'sharp';
import type { Database, Executor } from '../db/client.ts';
import { insertArtifact } from '../db/repositories/artifacts.ts';
import { listClaims, type Claim } from '../db/repositories/claims.ts';
import { insertFacts, type Fact, type NewFact } from '../db/repositories/facts.ts';
import { addMaterial, setMaterialStatus } from '../db/repositories/materials.ts';
import type { Project } from '../db/repositories/projects.ts';
import type { Run } from '../db/repositories/runs.ts';
import { seedProject, seedRun, seedUser } from '../db/testing.ts';
import type { PublicUser } from '../db/repositories/users.ts';
import { recordedMaskAt } from '../meta/sam-test-support.ts';
import { validateClaims } from '../pipeline/claims/validator.ts';
import { buildCopyFactCatalog } from '../pipeline/creative/catalog.ts';
import { storeListingCopy } from '../pipeline/creative/handler.ts';
import {
  compareFixedElements,
  DEFAULT_INTEGRITY_THRESHOLDS,
} from '../pipeline/integrity/compare.ts';
import { encodeStagedImage } from '../pipeline/staging/encode.ts';
import {
  STAGING_PROMPT_VERSION,
  stagingOperation,
  stagingPrompt,
} from '../pipeline/staging/operations.ts';
import { toRegion } from '../pipeline/vision/regions.ts';
import {
  newMaterialStorageKey,
  newRunArtifactStorageKey,
  type Storage,
} from '../storage/storage.ts';
import type { PixelBox } from './blur.ts';

export const FRAME = { width: 1024, height: 682 } as const;

interface StoredPhoto {
  readonly materialId: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

const OPERATION = {
  living: 'furnish_living_room',
  dining: 'furnish_dining_room',
} as const satisfies Record<string, StagingOperationId>;

type Rgb = readonly [number, number, number];

/**
 * A synthetic JPEG (stored-photo settings: q85 mozjpeg, no metadata): a vertical gradient of
 * `color` with 6 px black-and-white checkerboards in `patterns`, which stand in for faces and
 * plates (high-frequency detail a blur must remove).
 */
export async function syntheticPhoto(
  color: Rgb,
  patterns: readonly PixelBox[] = [],
  frame: { readonly width: number; readonly height: number } = FRAME,
): Promise<Uint8Array> {
  const { width, height } = frame;
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    const shade = 0.7 + (0.3 * y) / height;
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      const inPattern = patterns.some((b) => x >= b.x0 && x < b.x1 && y >= b.y0 && y < b.y1);
      if (inPattern) {
        const on = (Math.floor(x / 6) + Math.floor(y / 6)) % 2 === 0;
        data.fill(on ? 255 : 0, offset, offset + 3);
      } else {
        data[offset] = Math.round(color[0] * shade);
        data[offset + 1] = Math.round(color[1] * shade);
        data[offset + 2] = Math.round(color[2] * shade);
      }
    }
  }
  const encoded = await sharp(data, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer();
  return new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength);
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function privacyRegion(
  box: PixelBox,
  mask: SamRegion['mask'] = null,
  frame: { readonly width: number; readonly height: number } = FRAME,
): SamRegion {
  return {
    objectId: 0,
    score: 0.91,
    box: { ...box },
    region: toRegion(box, frame.width, frame.height),
    mask,
  };
}

/** A recorded SAM mask payload (P1-05, synthetic interiors) and a box of exactly its size. */
export async function recordedMaskRegion(x0: number, y0: number): Promise<SamRegion> {
  const { mask } = await recordedMaskAt(0);
  const box = { x0, y0, x1: x0 + mask.width, y1: y0 + mask.height };
  return privacyRegion(box, {
    encoding: mask.encoding,
    width: mask.width,
    height: mask.height,
    payload: mask.payload,
  });
}

export type PrivacySpec =
  | { readonly status: 'clear' }
  | { readonly status: 'masked'; readonly person: SamRegion[]; readonly plate: SamRegion[] }
  | { readonly status: 'review' }
  | { readonly status: 'failed' };

export function privacyOf(spec: PrivacySpec): InventoryPhoto['privacy'] {
  switch (spec.status) {
    case 'clear':
      return {
        status: 'clear',
        phrases: [
          { status: 'checked', phrase: 'person', modelSaw: false, regions: [] },
          { status: 'checked', phrase: 'license plate', modelSaw: false, regions: [] },
        ],
      };
    case 'masked':
      return {
        status: 'masked',
        phrases: [
          { status: 'checked', phrase: 'person', modelSaw: true, regions: spec.person },
          { status: 'checked', phrase: 'license plate', modelSaw: false, regions: spec.plate },
        ],
      };
    case 'review':
      return {
        status: 'review',
        phrases: [
          { status: 'checked', phrase: 'person', modelSaw: true, regions: [] },
          { status: 'checked', phrase: 'license plate', modelSaw: false, regions: [] },
        ],
      };
    case 'failed':
      return {
        status: 'failed',
        phrases: [
          { status: 'failed', phrase: 'person', modelSaw: null, reason: 'invalid_output' },
          { status: 'checked', phrase: 'license plate', modelSaw: null, regions: [] },
        ],
      };
    default: {
      const unreachable: never = spec;
      throw new Error(`Unhandled privacy spec ${JSON.stringify(unreachable)}`);
    }
  }
}

export function inventoryEntry(input: {
  readonly materialId: string;
  readonly sha256: string;
  /** Null: the classification failed (no rank). */
  readonly subject: PhotoSubject | null;
  readonly coverRank: number;
  readonly privacy: PrivacySpec;
  readonly frame?: { readonly width: number; readonly height: number };
}): InventoryPhoto {
  const frame = input.frame ?? FRAME;
  return {
    materialId: input.materialId,
    materialSha256: input.sha256,
    width: frame.width,
    height: frame.height,
    classification:
      input.subject === null
        ? { status: 'failed', reason: 'invalid_output' }
        : {
            status: 'ok',
            subject: input.subject,
            otherSubject: null,
            furnishing: null,
            summary: 'A synthetic room.',
            quality: 'good',
            qualityIssues: [],
            coverScore: 7,
            coverRank: input.coverRank,
            repairs: [],
          },
    privacy: privacyOf(input.privacy),
    observations: [],
  };
}

export function inventoryContent(photos: readonly InventoryPhoto[]): PhotoInventoryContent {
  const privacy = (status: InventoryPhoto['privacy']['status']): number =>
    photos.filter((p) => p.privacy.status === status).length;
  const classified = photos.filter((p) => p.classification.status === 'ok').length;
  return photoInventoryContentSchema.parse({
    schemaVersion: 1,
    promptVersion: 1,
    model: 'muse-spark-1.3',
    reasoningEffort: 'low',
    maxOutputTokens: 4000,
    segmentationModel: 'sam-3.1',
    privacyPhrases: ['person', 'license plate'],
    evidence: { cap: 12, candidateCount: 0, requestCount: 0, regionCount: 0, maskCount: 0 },
    counts: {
      photos: photos.length,
      classified,
      classificationFailed: photos.length - classified,
      privacy: {
        clear: privacy('clear'),
        masked: privacy('masked'),
        review: privacy('review'),
        failed: privacy('failed'),
      },
      privacyRegions: photos
        .flatMap((p) => p.privacy.phrases)
        .reduce(
          (sum, phrase) => sum + (phrase.status === 'checked' ? phrase.regions.length : 0),
          0,
        ),
      observations: 0,
      facts: 0,
      rejectedObservations: 0,
    },
    photos: [...photos],
    rejected: [],
  } satisfies PhotoInventoryContent);
}

// --- A whole run up to Gate 2 ----------------------------------------------------------------

export const PERSON_BOX: PixelBox = { x0: 400, y0: 200, x1: 425, y1: 475 };
export const PLATE_BOX: PixelBox = { x0: 700, y0: 560, x1: 820, y1: 600 };

/** Uploads in this order; the inventory ranks the bedroom first. */
export const PHOTO_NAMES = ['living', 'bedroom', 'kitchen', 'hallway', 'dining'] as const;
export type PhotoName = (typeof PHOTO_NAMES)[number];

/** Copy segments of the synthetic draft; `injection` carries markup that must be escaped. */
export const SEGMENT_NAMES = [
  'area',
  'label',
  'year',
  'station',
  'balcony',
  'injection',
  'social',
  'unmissable',
] as const;
export type SegmentName = (typeof SEGMENT_NAMES)[number];

export const SEGMENT_TEXT: Readonly<Record<SegmentName, string>> = {
  area: 'This bright apartment offers 92 m² of living space.',
  label: 'It has energy label B.',
  year: 'Built in 1932, it stands on land without ground lease.',
  station: 'The station is a 6 minute bike ride away.',
  balcony: 'The balcony is the best in town.',
  injection: 'Neighbours call the street <script>alert("pwned")</script> & "quiet".',
  social: 'Bright apartment of 92 m² with a balcony.',
  unmissable: 'Truly unmissable.',
};

export const EDITED_BALCONY_TEXT = 'The apartment has a balcony.';

export interface ExportScenario {
  readonly user: PublicUser;
  readonly project: Project;
  readonly run: Run;
  readonly market: MarketProfile;
  readonly photos: Readonly<Record<PhotoName, StoredPhoto>>;
  readonly inventory: PhotoInventoryContent;
  readonly facts: readonly Fact[];
  readonly draftArtifactId: string;
  readonly claims: Readonly<Partial<Record<SegmentName, Claim>>>;
  /** What the verification stand-in stores in its commit: staged images, integrity, audit. */
  storeVerification(
    tx: Executor,
  ): Promise<{ readonly staged: Readonly<Record<'living' | 'dining', string>> }>;
}

async function storePhoto(
  db: Database,
  storage: Storage,
  projectId: string,
  bytes: Uint8Array,
): Promise<string> {
  const stored = await storage.put(newMaterialStorageKey(projectId, 'jpg'), bytes);
  const material = await addMaterial(db, {
    projectId,
    kind: 'photo',
    storageKey: stored.key,
    mimeType: 'image/jpeg',
    sizeBytes: stored.sizeBytes,
    sha256: stored.sha256,
    status: 'processing',
  });
  await setMaterialStatus(db, material.id, 'ready', {
    width: FRAME.width,
    height: FRAME.height,
    sourceFormat: 'jpeg',
    sourceWidth: FRAME.width,
    sourceHeight: FRAME.height,
  });
  return material.id;
}

function factSpecs(livingMaterialId: string, energyLabel: boolean): NewFact[] {
  const base = { stepId: 'reconciliation', status: 'verified' as const };
  const facts: NewFact[] = [
    {
      ...base,
      key: 'living_area',
      value: 92,
      unit: 'm2',
      basis: 'NEN2580',
      source: { kind: 'form', field: 'living_area' },
    },
    {
      ...base,
      key: 'build_year',
      value: 1932,
      stepId: 'gate:fact_conflicts',
      source: {
        kind: 'gate_decision',
        gate: 'fact_conflicts',
        conflictsArtifactId: '6f0c5d1e-2a3b-4c5d-8e9f-0a1b2c3d4e5f',
        conflictId: 'K01',
      },
    },
    { ...base, key: 'ground_lease', value: false, source: { kind: 'form', field: 'ground_lease' } },
    {
      ...base,
      key: 'other:station_cycling_time_minutes',
      value: 6,
      source: { kind: 'form', field: 'station_cycling_time_minutes' },
    },
    {
      ...base,
      key: 'other:street_character',
      value: '<b>Quiet</b> & "green"',
      source: { kind: 'form', field: 'street_character' },
    },
    {
      ...base,
      key: 'other:balcony',
      value: 1,
      stepId: 'vision_inventory',
      source: {
        kind: 'photo_region',
        materialId: livingMaterialId,
        region: { x: 0, y: 0, width: 1, height: 1 },
      },
    },
  ];
  if (energyLabel) {
    facts.unshift({
      ...base,
      key: 'energy_label',
      value: 'B',
      source: { kind: 'form', field: 'energy_label' },
    });
  }
  return facts;
}

interface SegmentSpec {
  readonly name: SegmentName;
  readonly variant: 'portal' | 'social';
  readonly paragraph: number;
  readonly cites: readonly string[];
}

function segmentSpecs(energyLabel: boolean): SegmentSpec[] {
  return [
    { name: 'area', variant: 'portal', paragraph: 0, cites: ['living_area'] },
    ...(energyLabel
      ? [{ name: 'label', variant: 'portal', paragraph: 0, cites: ['energy_label'] } as const]
      : []),
    { name: 'year', variant: 'portal', paragraph: 1, cites: ['build_year', 'ground_lease'] },
    {
      name: 'station',
      variant: 'portal',
      paragraph: 1,
      cites: ['other:station_cycling_time_minutes'],
    },
    { name: 'balcony', variant: 'portal', paragraph: 1, cites: ['other:balcony'] },
    { name: 'injection', variant: 'portal', paragraph: 2, cites: ['other:street_character'] },
    { name: 'social', variant: 'social', paragraph: 0, cites: ['living_area', 'other:balcony'] },
    { name: 'unmissable', variant: 'social', paragraph: 0, cites: ['living_area'] },
  ];
}

function listingCopy(
  market: MarketProfile,
  facts: readonly Fact[],
  inventory: PhotoInventoryContent,
  specs: readonly SegmentSpec[],
): ListingCopyContent {
  const catalog = buildCopyFactCatalog(market, facts, inventory);
  const entriesFor = (key: string) => catalog.facts.filter((entry) => entry.key === key);
  const segments = specs.map((spec, index) => {
    const entries = spec.cites.flatMap(entriesFor);
    if (entries.length !== spec.cites.length) throw new Error(`segment ${spec.name}: missing fact`);
    return {
      variant: spec.variant,
      segment: {
        index,
        paragraph: spec.paragraph,
        text: SEGMENT_TEXT[spec.name],
        catalogIds: entries.map((entry) => entry.id),
        factIds: entries.flatMap((entry) => entry.factIds),
      },
    };
  });
  const validation = validateClaims({
    language: 'en',
    segments: segments.map(({ variant, segment }) => ({
      variant,
      segmentIndex: segment.index,
      text: segment.text,
      factIds: segment.factIds,
    })),
    facts,
  });
  const cited = new Set(segments.flatMap(({ segment }) => segment.catalogIds));
  return listingCopyContentSchema.parse({
    schemaVersion: 1,
    promptVersion: 1,
    modelRun: {
      model: 'muse-spark-1.3',
      reasoningEffort: 'medium',
      maxOutputTokens: 16000,
      fallbackFrom: null,
    },
    outputLanguage: 'en',
    tone: 'warm',
    revision: 0,
    previousArtifactId: null,
    catalog: catalog.facts.map((entry) => ({ id: entry.id, factIds: [...entry.factIds] })),
    variants: (['portal', 'social'] as const).map((kind) => ({
      kind,
      languageCheck: 'match',
      segments: segments.filter((s) => s.variant === kind).map((s) => s.segment),
    })),
    repairs: { mergedUncited: 0, droppedUncitedParagraphs: 0, droppedEmpty: 0 },
    counts: {
      catalogFacts: catalog.facts.length,
      citedCatalogFacts: cited.size,
      segments: segments.length,
    },
    validation: { ...validation, rulesVersion: CLAIM_VALIDATOR_RULES_VERSION },
  } satisfies ListingCopyContent);
}

function stagedContent(
  materialId: string,
  originalSha256: string,
  operationId: StagingOperationId,
  stored: {
    readonly sha256: string;
    readonly sizeBytes: number;
    readonly width: number;
    readonly height: number;
  },
): StagedImageContent {
  const operation = stagingOperation(operationId);
  return stagedImageContentSchema.parse({
    schemaVersion: 1,
    promptVersion: STAGING_PROMPT_VERSION,
    original: { materialId, sha256: originalSha256, ...FRAME },
    operation,
    prompt: stagingPrompt(operation),
    model: 'muse-image-1.0',
    requestedSize: `${FRAME.width}x${FRAME.height}`,
    toolsDisabled: true,
    modelOutput: { format: 'jpeg', width: stored.width, height: stored.height },
    stored: {
      mimeType: 'image/jpeg',
      width: stored.width,
      height: stored.height,
      sizeBytes: stored.sizeBytes,
      sha256: stored.sha256,
    },
    aspectRatioChange: 0,
    disclosure: { label: STAGED_IMAGE_LABEL, visibleLabelRequired: true },
  } satisfies StagedImageContent);
}

const WINDOW = { box: { x0: 100, y0: 100, x1: 300, y1: 400 }, score: 0.9 };

function checkedIntegrityPhoto(
  materialId: string,
  operationId: StagingOperationId,
  stagedArtifactId: string,
  personCount: number,
) {
  const segmentation = { ...FRAME, segments: { window: [WINDOW], door: [], radiator: [] } };
  const verdict = compareFixedElements(segmentation, segmentation);
  const privacyPassed = personCount === 0;
  const passed = verdict.passed && privacyPassed;
  return {
    materialId,
    operationId,
    original: segmentation,
    attempts: [
      {
        status: 'checked' as const,
        attempt: 1 as const,
        stagedArtifactId,
        passed,
        edit: segmentation,
        verdict: {
          ...verdict,
          failures: [...verdict.failures],
          failedClasses: [...verdict.failedClasses],
          classes: verdict.classes.map((c) => ({
            ...c,
            matches: [...c.matches],
            unmatchedOriginal: [...c.unmatchedOriginal],
            unmatchedEdit: [...c.unmatchedEdit],
            failures: [...c.failures],
          })),
          thresholds: { ...verdict.thresholds },
        },
        privacy: { passed: privacyPassed, phrases: [{ phrase: 'person', count: personCount }] },
      },
    ],
    outcome: passed ? ('passed' as const) : ('fallback_original' as const),
    finalStagedArtifactId: passed ? stagedArtifactId : null,
  };
}

/** The remaining flags of the synthetic audit: three claims, one decision each at Gate 2. */
export const FLAGGED: readonly {
  readonly name: SegmentName;
  readonly category: ClaimAuditCategory;
  readonly problem: string;
}[] = [
  {
    name: 'balcony',
    category: 'unverifiable_superlative',
    problem: 'An unverifiable superlative.',
  },
  { name: 'injection', category: 'claim_support', problem: 'No cited fact states this.' },
  {
    name: 'unmissable',
    category: 'unverifiable_superlative',
    problem: 'Sales talk without a fact.',
  },
];

/**
 * Seeds a run of the `nl` market up to the verification step: five stored photos (living room
 * clear and staged, bedroom with a person and a plate, kitchen in privacy review, hallway with a
 * failed privacy check and no classification, dining room clear and staged), their inventory,
 * verified facts, and the English draft with its claims. `storeVerification` stores the rest.
 */
export async function seedExportScenario(
  db: Database,
  storage: Storage,
  market: MarketProfile,
  options: {
    readonly energyLabel?: boolean;
    readonly serviceId: string;
    readonly serviceVersion: number;
  },
): Promise<ExportScenario> {
  const energyLabel = options.energyLabel ?? true;
  const user = await seedUser(db);
  const project = await seedProject(db, user.id, {
    title: 'Synthetic apartment <Canal> & "Co"',
    officeProfile: {
      agencyName: 'Example Makelaardij',
      contactBlock: 'Example Makelaardij\ninfo@example.test\n+31 20 000 0000',
      tone: 'warm',
    },
  });
  const run = await seedRun(db, project.id, {
    serviceId: options.serviceId,
    serviceVersion: options.serviceVersion,
  });

  const person = await recordedMaskRegion(PERSON_BOX.x0, PERSON_BOX.y0);
  const personBox: PixelBox = person.box;
  const colors: Record<PhotoName, Rgb> = {
    living: [214, 196, 170],
    bedroom: [180, 196, 214],
    kitchen: [220, 220, 210],
    hallway: [200, 180, 160],
    dining: [190, 210, 180],
  };
  const makePhoto = async (name: PhotoName): Promise<StoredPhoto> => {
    const photoBytes = await syntheticPhoto(
      colors[name],
      name === 'bedroom' ? [personBox, PLATE_BOX] : [],
    );
    return {
      materialId: await storePhoto(db, storage, project.id, photoBytes),
      bytes: photoBytes,
      sha256: sha256Hex(photoBytes),
    };
  };
  // Sequential, so the materials keep the upload order.
  const living = await makePhoto('living');
  const bedroom = await makePhoto('bedroom');
  const kitchen = await makePhoto('kitchen');
  const hallway = await makePhoto('hallway');
  const dining = await makePhoto('dining');
  const photos: Record<PhotoName, StoredPhoto> = { living, bedroom, kitchen, hallway, dining };
  const entry = (
    name: PhotoName,
    subject: PhotoSubject | null,
    coverRank: number,
    privacy: PrivacySpec,
  ) =>
    inventoryEntry({
      materialId: photos[name].materialId,
      sha256: photos[name].sha256,
      subject,
      coverRank,
      privacy,
    });
  const inventory = inventoryContent([
    entry('living', 'living_room', 2, { status: 'clear' }),
    entry('bedroom', 'bedroom', 1, {
      status: 'masked',
      person: [person],
      plate: [privacyRegion(PLATE_BOX)],
    }),
    entry('kitchen', 'kitchen', 3, { status: 'review' }),
    entry('hallway', null, 5, { status: 'failed' }),
    entry('dining', 'dining_room', 4, { status: 'clear' }),
  ]);
  await insertArtifact(db, {
    runId: run.id,
    stepId: 'vision_inventory',
    kind: PHOTO_INVENTORY_ARTIFACT_KIND,
    content: inventory,
  });

  const facts = await insertFacts(db, run.id, factSpecs(living.materialId, energyLabel));
  const specs = segmentSpecs(energyLabel);
  const content = listingCopy(market, facts, inventory, specs);
  const { artifact: draft } = await storeListingCopy(db, {
    runId: run.id,
    stepId: 'creative',
    content,
  });
  const storedClaims = await listClaims(db, draft.id);
  const claims: Partial<Record<SegmentName, Claim>> = {};
  specs.forEach((spec, index) => {
    const claim = storedClaims.find((c) => c.segmentIndex === index);
    if (claim !== undefined) claims[spec.name] = claim;
  });

  async function storeVerification(tx: Executor) {
    const stageOne = async (name: 'living' | 'dining'): Promise<string> => {
      const edit = await syntheticPhoto(colors[name], [{ x0: 300, y0: 380, x1: 760, y1: 600 }]);
      const encoded = await encodeStagedImage(edit);
      const stored = await storage.put(
        newRunArtifactStorageKey(project.id, run.id, 'jpg'),
        encoded.bytes,
      );
      const artifact = await insertArtifact(tx, {
        runId: run.id,
        stepId: 'staging',
        kind: STAGED_IMAGE_ARTIFACT_KIND,
        content: stagedContent(photos[name].materialId, photos[name].sha256, OPERATION[name], {
          sha256: stored.sha256,
          sizeBytes: stored.sizeBytes,
          width: encoded.width,
          height: encoded.height,
        }),
        file: { storageKey: stored.key, mimeType: 'image/jpeg' },
      });
      return artifact.id;
    };
    const staged = { living: await stageOne('living'), dining: await stageOne('dining') };
    const integrityPhotos = (['living', 'dining'] as const).map((name) =>
      checkedIntegrityPhoto(photos[name].materialId, OPERATION[name], staged[name], 0),
    );
    await insertArtifact(tx, {
      runId: run.id,
      stepId: 'integrity',
      kind: INTEGRITY_CHECKS_ARTIFACT_KIND,
      content: integrityChecksContentSchema.parse({
        schemaVersion: 1,
        segmentationModel: 'sam-3.1',
        stagedImagesArtifactId: '0d9e8f7a-6b5c-4d3e-8f1a-2b3c4d5e6f70',
        fixedElements: [
          { phrase: 'window', occlusionTolerant: false },
          { phrase: 'door', occlusionTolerant: true },
          { phrase: 'radiator', occlusionTolerant: true },
        ],
        thresholds: DEFAULT_INTEGRITY_THRESHOLDS,
        editPrivacyPhrases: ['person'],
        counts: {
          photos: 2,
          passed: 2,
          passedOnRetry: 0,
          fallbackOriginal: 0,
          retries: 0,
          unchecked: 0,
        },
        photos: integrityPhotos,
      }),
    });

    const flags: ClaimAuditFlag[] = FLAGGED.map((flag) => {
      const claim = claims[flag.name];
      const spec = specs.find((s) => s.name === flag.name);
      if (claim === undefined || spec === undefined) throw new Error(`no claim ${flag.name}`);
      const variantSpecs = specs.filter((s) => s.variant === spec.variant);
      return {
        source: 'verifier',
        category: flag.category,
        code: null,
        artifactId: draft.id,
        variant: spec.variant,
        segment: variantSpecs.indexOf(spec),
        segmentIndex: claim.segmentIndex,
        claimId: claim.id,
        problem: flag.problem,
        suggestion: null,
        carried: false,
      };
    });
    const segments = specs.length;
    await insertArtifact(tx, {
      runId: run.id,
      stepId: 'verification',
      kind: CLAIM_AUDIT_ARTIFACT_KIND,
      content: claimAuditContentSchema.parse({
        schemaVersion: 1,
        promptVersion: 1,
        outputLanguage: 'en',
        market: { id: market.id, version: market.version },
        rubric: [
          { category: 'claim_support', rule: 'Say only what the cited facts say.' },
          { category: 'unverifiable_superlative', rule: 'No unverifiable superlatives.' },
          { category: 'investment_promise', rule: 'No investment promises.' },
          { category: 'exclusionary', rule: 'No exclusionary phrasing.' },
        ],
        maxRevisionLoops: 0,
        stopReason: 'loop_limit',
        initialDraftArtifactId: draft.id,
        finalDraftArtifactId: draft.id,
        passes: [
          {
            draftArtifactId: draft.id,
            revision: 0,
            segments,
            auditedSegments: segments,
            carriedSegments: 0,
            modelRun: null,
            flags,
            dropped: {
              unknownSegment: 0,
              notAudited: 0,
              unknownCategory: 0,
              emptyProblem: 0,
              duplicate: 0,
            },
          },
        ],
        remainingFlags: flags,
        counts: {
          passes: 1,
          revisions: 0,
          verifierCalls: 0,
          remainingFlags: flags.length,
          remainingValidatorFlags: 0,
          remainingVerifierFlags: flags.length,
          flaggedClaims: flags.length,
          finalClaims: segments,
        },
        fallbackUsed: false,
      }),
    });
    return { staged };
  }

  return {
    user,
    project,
    run,
    market,
    photos,
    inventory,
    facts,
    draftArtifactId: draft.id,
    claims,
    storeVerification,
  };
}
