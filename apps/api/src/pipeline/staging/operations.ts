import type { PhotoSubject, StagingOperation, StagingOperationId } from '@evidomo/shared';

// The declared operations of the staging step (docs/architecture.md §5) and the prompt that
// wraps them. Operations are a fixed catalog, chosen by code from the photo inventory, so the
// stored record of a staged image says exactly what was asked; no model writes them.
//
// Within the P1-07 decision: furniture added or replaced, clutter and loose objects removed.
// Nothing structural, and nothing that P1-07 found likely to be falsely rejected by the
// integrity check (tall furniture against a window wall, wardrobes and cabinets, which SAM counts
// as doors; mirrors, pictures, and screens, which SAM can take for windows).

/** Bump when an operation text or the wrapper changes: recorded with every staged image. */
export const STAGING_PROMPT_VERSION = 1;

const OPERATIONS: { readonly [K in StagingOperationId]: StagingOperation & { readonly id: K } } = {
  furnish_living_room: {
    id: 'furnish_living_room',
    kind: 'furnish',
    text:
      'furnish the living room with a light grey three-seat fabric sofa, a low light oak ' +
      'coffee table, and a neutral wool rug, replacing any loose furniture that is already there',
  },
  furnish_dining_room: {
    id: 'furnish_dining_room',
    kind: 'furnish',
    text:
      'furnish the dining area with a light oak dining table and six matching chairs without ' +
      'cushions, replacing any dining table and chairs that are already there',
  },
  furnish_bedroom: {
    id: 'furnish_bedroom',
    kind: 'furnish',
    text:
      'furnish the bedroom with a double bed with white linen and two pillows and one low ' +
      'bedside table, replacing any loose furniture that is already there',
  },
  furnish_study: {
    id: 'furnish_study',
    kind: 'furnish',
    text:
      'furnish the room as a study with a simple light oak desk and a matching office chair, ' +
      'replacing any loose furniture that is already there',
  },
  declutter: {
    id: 'declutter',
    kind: 'declutter',
    text:
      'remove all clutter and loose personal belongings, such as dishes, papers, bags, ' +
      'clothes, and small objects, from every surface and from the floor, so that all surfaces ' +
      'are clear; keep all furniture and built-in fittings exactly where they are',
  },
};

export function stagingOperation(id: StagingOperationId): StagingOperation {
  return OPERATIONS[id];
}

/** Rooms that are furnished, one operation each. Kitchens and bathrooms are built in. */
export const FURNISH_OPERATION_BY_SUBJECT: Readonly<
  Partial<Record<PhotoSubject, StagingOperationId>>
> = {
  living_room: 'furnish_living_room',
  dining_room: 'furnish_dining_room',
  bedroom: 'furnish_bedroom',
  study: 'furnish_study',
};

/**
 * Interior subjects that may be decluttered. Exteriors, gardens, balconies, views, plans, and
 * documents are excluded: the integrity check was measured on interiors only (P1-07).
 */
export const DECLUTTER_SUBJECTS: ReadonlySet<PhotoSubject> = new Set<PhotoSubject>([
  'living_room',
  'kitchen',
  'dining_room',
  'bedroom',
  'bathroom',
  'toilet',
  'hallway',
  'staircase',
  'study',
  'laundry_room',
  'storage_room',
  'attic',
  'basement',
]);

/**
 * The edit prompt: one declared operation inside fixed preservation instructions. The wrapper
 * extends the P1-06 prompt (which kept every fixed element in 5/5 harmless edits) with the
 * P1-07 false-rejection risks.
 */
export function stagingPrompt(operation: StagingOperation): string {
  return (
    `Edit this photo: ${operation.text}. Change nothing else: keep the camera angle, framing, ` +
    'walls, floor, ceiling, windows, doors, radiators, built-in fittings, and lighting exactly ' +
    'as they are, and do not place anything in front of a window or a door. Do not add ' +
    'people, animals, text, logos, mirrors, pictures, screens, curtains, wardrobes, cabinets, ' +
    'or other tall furniture.'
  );
}
