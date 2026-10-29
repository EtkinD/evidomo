import { describe, expect, it } from 'vitest';
import {
  exportManifestContentSchema,
  portalImageSchema,
  portalProfileFieldSchema,
  type ExportFile,
  type ExportManifestContent,
} from './export.ts';
import { packExportedPayloadSchema } from './run-events.ts';

const ID = '3bfcf0bb-5581-4e10-8691-6cc7a8e66dcf';
const SHA = 'a'.repeat(64);

describe('portalProfileFieldSchema', () => {
  const base = {
    key: 'living_area',
    label: 'Living area',
    required: true,
    type: 'area',
    unit: 'm2',
    basis: { id: 'NEN2580', label: 'NEN 2580' },
    sources: ['form'],
  } as const;

  it('accepts a verified value, a missing one, and an ambiguous one', () => {
    expect(
      portalProfileFieldSchema.safeParse({ ...base, status: 'verified', value: 92, factIds: [ID] })
        .success,
    ).toBe(true);
    expect(
      portalProfileFieldSchema.safeParse({
        ...base,
        sources: [],
        status: 'missing',
        value: null,
        factIds: [],
      }).success,
    ).toBe(true);
    expect(
      portalProfileFieldSchema.safeParse({
        ...base,
        status: 'ambiguous',
        value: null,
        factIds: [ID, ID],
      }).success,
    ).toBe(true);
  });

  it('refuses a value that its status does not allow and a value of the wrong type', () => {
    expect(
      portalProfileFieldSchema.safeParse({ ...base, status: 'missing', value: 92, factIds: [] })
        .success,
    ).toBe(false);
    expect(
      portalProfileFieldSchema.safeParse({
        ...base,
        status: 'verified',
        value: null,
        factIds: [ID],
      }).success,
    ).toBe(false);
    expect(
      portalProfileFieldSchema.safeParse({
        ...base,
        status: 'ambiguous',
        value: null,
        factIds: [ID],
      }).success,
    ).toBe(false);
    expect(
      portalProfileFieldSchema.safeParse({
        ...base,
        status: 'verified',
        value: '92',
        factIds: [ID],
      }).success,
    ).toBe(false);
  });
});

describe('portalImageSchema', () => {
  it('requires the burned-in disclosure on a staged image', () => {
    const staged = {
      position: 1,
      fileName: 'photo-01-staged.jpg',
      fileArtifactId: ID,
      materialId: ID,
      width: 10,
      height: 10,
      sizeBytes: 10,
      sha256: SHA,
      kind: 'staged',
      stagedArtifactId: ID,
      operationId: 'furnish_bedroom',
      disclosure: {
        label: 'Virtually staged',
        burnedIn: true,
        digitalSourceType:
          'http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia',
      },
      originalFileName: 'photo-01.jpg',
    };
    expect(portalImageSchema.safeParse(staged).success).toBe(true);
    expect(
      portalImageSchema.safeParse({
        ...staged,
        disclosure: { ...staged.disclosure, burnedIn: false },
      }).success,
    ).toBe(false);
    expect(portalImageSchema.safeParse({ ...staged, fileName: '../x.jpg' }).success).toBe(false);
  });
});

describe('exportManifestContentSchema', () => {
  const file = (
    role: ExportFile['role'],
    fileName: string,
    mimeType: ExportFile['mimeType'],
  ): ExportFile => ({
    artifactId: ID,
    role,
    fileName,
    mimeType,
    sizeBytes: 100,
    sha256: SHA,
  });
  const manifest = {
    schemaVersion: 1,
    formatVersion: 1,
    approvedPackArtifactId: ID,
    inventoryArtifactId: ID,
    readyToPublish: true,
    files: [
      file('html', 'listing-pack.html', 'text/html'),
      file('portal_fields', 'portal-fields.json', 'application/json'),
      file('image', 'photo-01.jpg', 'image/jpeg'),
    ],
    counts: {
      images: 1,
      originals: 1,
      staged: 0,
      blurredImages: 0,
      blurredRegions: 0,
      withheld: 2,
    },
  } satisfies ExportManifestContent;

  it('accepts the HTML, the JSON, then one entry per image', () => {
    expect(exportManifestContentSchema.safeParse(manifest).success).toBe(true);
  });

  it('refuses another order or counts that do not add up', () => {
    const [html, json, image] = manifest.files;
    expect(
      exportManifestContentSchema.safeParse({ ...manifest, files: [json, html, image] }).success,
    ).toBe(false);
    expect(
      exportManifestContentSchema.safeParse({
        ...manifest,
        counts: { ...manifest.counts, staged: 1 },
      }).success,
    ).toBe(false);
  });
});

describe('pack_exported payload', () => {
  it('carries counts only', () => {
    const payload = {
      stepId: 'export',
      artifactId: ID,
      imageCount: 4,
      originalCount: 3,
      stagedCount: 1,
      blurredImageCount: 1,
      blurredRegionCount: 2,
      withheldCount: 2,
      checklistFailCount: 0,
      readyToPublish: true,
    };
    expect(packExportedPayloadSchema.parse(payload)).toEqual(payload);
    expect(
      packExportedPayloadSchema.safeParse({ ...payload, fileName: 'photo-01.jpg' }).success,
    ).toBe(false);
  });
});
