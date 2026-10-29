import {
  portalFieldsSchema,
  EXPORT_FORMAT_VERSION,
  type ApprovedPackContent,
  type MarketProfile,
  type PortalCopyVariant,
  type PortalFields,
  type PortalImage,
  type PortalWithheldImage,
  type PublicationChecklistResult,
} from '@evidomo/shared';

// The portal-fields JSON (`portalFieldsSchema`): composed from parts that are already decided,
// validated, and serialized with the schema's key order. Pure.

/** One copy variant from the approved pack: paragraphs joined by a blank line, segments by a space. */
export function copyVariant(
  pack: Pick<ApprovedPackContent, 'variants'>,
  kind: 'portal' | 'social',
): PortalCopyVariant {
  const segments = pack.variants.find((variant) => variant.kind === kind)?.segments ?? [];
  const paragraphs: string[][] = [];
  let current: number | null = null;
  for (const segment of segments) {
    if (segment.paragraph !== current) {
      paragraphs.push([]);
      current = segment.paragraph;
    }
    paragraphs.at(-1)?.push(segment.text);
  }
  return {
    text: paragraphs.map((paragraph) => paragraph.join(' ')).join('\n\n'),
    segments: segments.map((segment) => ({ ...segment, factIds: [...segment.factIds] })),
  };
}

export interface PortalFieldsParts {
  readonly runId: string;
  readonly pack: { readonly artifactId: string; readonly content: ApprovedPackContent };
  readonly market: Pick<MarketProfile, 'id' | 'version'>;
  readonly facts: PortalFields['facts'];
  readonly images: readonly PortalImage[];
  readonly withheld: readonly PortalWithheldImage[];
  readonly checklist: PublicationChecklistResult;
}

/** The validated portal fields; throws a `ZodError` if the parts do not fit the schema. */
export function composePortalFields(parts: PortalFieldsParts): PortalFields {
  const { pack } = parts;
  return portalFieldsSchema.parse({
    schemaVersion: 1,
    formatVersion: EXPORT_FORMAT_VERSION,
    runId: parts.runId,
    approvedPackArtifactId: pack.artifactId,
    approvedAt: pack.content.approvedAt,
    market: { id: parts.market.id, version: parts.market.version },
    outputLanguage: pack.content.outputLanguage,
    facts: parts.facts,
    copy: {
      portal: copyVariant(pack.content, 'portal'),
      social: copyVariant(pack.content, 'social'),
    },
    images: [...parts.images],
    withheld: [...parts.withheld],
    publicationChecklist: parts.checklist,
  } satisfies PortalFields);
}

/**
 * Stable text: the parsed object's keys follow the schema's declaration order (zod builds the
 * output from the shape), 2-space indentation, trailing newline.
 */
export function serializePortalFields(fields: PortalFields): string {
  return `${JSON.stringify(portalFieldsSchema.parse(fields), null, 2)}\n`;
}
