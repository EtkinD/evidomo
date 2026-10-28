import { COVER_SCORE_RANGE, type EvidenceObject } from '@evidomo/shared';
import { OTHER_OBJECT } from './schema.ts';

// Vision inventory prompt (docs/model-notes.md, P2-08). The system prompt depends only on the
// market's evidence objects and the step's privacy phrases, so it is identical for every photo
// of a run (a cacheable prefix); the user message is one fixed sentence plus the image.
// Changing the wording changes the request hash: re-record `fixtures/meta/p2-08/` and bump
// VISION_PROMPT_VERSION when the meaning changes.

export const PHOTO_USER_TEXT = 'Inventory this listing photo.';

export function buildPhotoSystemPrompt(
  evidenceObjects: readonly EvidenceObject[],
  privacyPhrases: readonly string[],
): string {
  const objects = evidenceObjects.map((item) => `- ${item.id}: ${item.label}`).join('\n');
  const privacy = privacyPhrases.map((phrase) => `- ${phrase}`).join('\n');
  return `You inventory one photo of a property that is being listed for sale or rent. Your answer feeds a listing pack that must not claim anything the evidence does not show, so report only what is clearly visible in this photo.

Rules:
1. subject: the main room or subject of the photo. Use "other" only when nothing fits, with otherSubject a short English name; otherwise otherSubject is null. floor_plan and document are for drawings, certificates, and paperwork.
2. summary: one short factual English sentence about the room and its fixed features and finishes. Never describe people, faces, vehicles, number plates, or any visible text, and never guess an address, location, brand, size, measurement, or year.
3. quality: "good" for a sharp, well-lit, level photo that could be published as is; "poor" when it should be retaken; otherwise "acceptable". qualityIssues lists every issue that applies (empty when there is none).
4. coverScore: an integer from ${COVER_SCORE_RANGE.min} to ${COVER_SCORE_RANGE.max} for how well the photo would work as the listing's main photo. A bright, sharp, wide shot of the main living space or of the outside of the property scores high; bathrooms, toilets, storage, hallways, close-ups, documents, floor plans, and photos with quality issues score low.
5. observations: every object from the list below that is clearly visible, once per object, with count = how many instances are visible in this photo and detail = a short factual phrase (no brands, sizes, or years). Also list other fixed features a buyer would ask about (for example built_in_wardrobe, skylight, wooden_floor) as object "${OTHER_OBJECT}" with otherObject a snake_case English name. Never list an object you cannot see, or one you only assume is behind a door or cabinet front. At most 15 observations.
6. privacySubjects: each of the privacy subjects below that is visible anywhere in the photo, even partly, small, blurred, in a mirror or window reflection, on a screen, in a framed photo or poster, or outside through a window. When unsure, include it.

Objects (id: what to look for):
${objects === '' ? '(none)' : objects}

Privacy subjects:
${privacy}`;
}
