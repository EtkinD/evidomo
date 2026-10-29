import type {
  ChecklistItemStatus,
  ExportWithheldReason,
  FactSourceKind,
  PhrasingCategory,
} from '@evidomo/shared';

// The HTML pack's fixed wording, in the market output languages of v1 (`en`, `nl`); other
// languages fall back to English. Market labels, checklist details, and the "Virtually staged"
// label come from their own sources and are not translated here.

export interface PackStrings {
  readonly packTitle: string;
  readonly approved: (date: string) => string;
  readonly market: (name: string) => string;
  readonly notReadyTitle: string;
  readonly reviewTitle: string;
  readonly refusedTitle: (categories: string) => string;
  readonly phrasingCategory: Readonly<Record<PhrasingCategory, string>>;
  readonly notReadyBody: (failing: number) => string;
  readonly overridesTitle: string;
  readonly overridesNone: string;
  readonly editedTitle: string;
  readonly warningsTitle: string;
  readonly warningUnmentioned: (variant: string, fact: string, required: boolean) => string;
  readonly warningEmpty: (variant: string) => string;
  readonly copyTitle: string;
  readonly portalTitle: string;
  readonly socialTitle: string;
  readonly variantEmpty: string;
  readonly variantName: { readonly portal: string; readonly social: string };
  readonly factsTitle: string;
  readonly factColumn: string;
  readonly valueColumn: string;
  readonly basisColumn: string;
  readonly sourceColumn: string;
  readonly missing: string;
  readonly ambiguous: string;
  readonly yes: string;
  readonly no: string;
  readonly otherFactsTitle: string;
  readonly presencesTitle: string;
  readonly presenceNote: string;
  readonly seenIn: (rooms: string) => string;
  readonly sources: Readonly<Record<FactSourceKind, string>>;
  readonly photosTitle: string;
  readonly photo: (n: number) => string;
  readonly original: string;
  readonly blurred: string;
  readonly noPhotos: string;
  readonly withheldTitle: string;
  readonly upload: (n: number, staged: boolean) => string;
  readonly withheld: Readonly<Record<ExportWithheldReason, string>>;
  readonly checklistTitle: string;
  readonly itemColumn: string;
  readonly statusColumn: string;
  readonly detailColumn: string;
  readonly status: Readonly<Record<ChecklistItemStatus, string>>;
  readonly generated: (runId: string) => string;
}

const en: PackStrings = {
  packTitle: 'Listing pack',
  approved: (date) => `Approved at Gate 2 on ${date} UTC`,
  market: (name) => `Market: ${name}`,
  notReadyTitle: 'Not ready to publish',
  reviewTitle: 'Review before publishing',
  refusedTitle: (categories) =>
    `Approved as written, which is not allowed for ${categories}: edit or remove before publishing`,
  phrasingCategory: {
    exclusionary: 'exclusionary language',
    investment_promise: 'investment promises',
    unverifiable_superlative: 'unverifiable superlatives',
  },
  notReadyBody: (n) =>
    `${n} publication checklist ${n === 1 ? 'item fails' : 'items fail'}. Resolve ${n === 1 ? 'it' : 'them'} before publishing:`,
  overridesTitle: 'Approved as written despite an audit flag (operator override)',
  overridesNone: 'No flagged text was approved as written.',
  editedTitle: 'Rewritten at Gate 2 (not re-audited)',
  warningsTitle: 'Gate 2 warnings',
  warningUnmentioned: (variant, fact, required) =>
    `The ${variant} no longer mentions ${fact}${required ? ' (required by the market)' : ''}.`,
  warningEmpty: (variant) => `Every segment of the ${variant} was removed.`,
  copyTitle: 'Listing copy',
  portalTitle: 'Portal description',
  socialTitle: 'Social media caption',
  variantEmpty: 'No text: every segment was removed at Gate 2.',
  variantName: { portal: 'portal description', social: 'social media caption' },
  factsTitle: 'Fact sheet',
  factColumn: 'Fact',
  valueColumn: 'Value',
  basisColumn: 'Measurement basis',
  sourceColumn: 'Source',
  missing: 'Not verified',
  ambiguous: 'Several verified values; none shown',
  yes: 'Yes',
  no: 'No',
  otherFactsTitle: 'Other verified facts',
  presencesTitle: 'Seen in the photos',
  presenceNote: 'Presence only: photos never support a count or a measurement.',
  seenIn: (rooms) => `seen in: ${rooms}`,
  sources: {
    form: 'Fact form',
    transcript_turn: 'Walkthrough',
    photo_region: 'Photo',
    gate_decision: 'Gate 1 decision',
  },
  photosTitle: 'Photos',
  photo: (n) => `Photo ${n}`,
  original: 'Original',
  blurred: 'faces and license plates blurred',
  noPhotos: 'No photo can be published.',
  withheldTitle: 'Withheld photos',
  upload: (n, staged) => `Upload ${n}${staged ? ', staged version' : ''}`,
  withheld: {
    privacy_review: 'withheld: privacy check incomplete',
    privacy_failed: 'withheld: privacy check incomplete',
    privacy_regions_invalid: 'withheld: privacy regions could not be read',
    blur_failed: 'withheld: blurring failed',
    original_withheld: 'withheld together with its original',
    staged_unverified: 'withheld: the integrity check does not confirm it',
    label_failed: 'withheld: the disclosure label could not be applied',
  },
  checklistTitle: 'Publication checklist',
  itemColumn: 'Item',
  statusColumn: 'Status',
  detailColumn: 'Detail',
  status: { pass: 'Pass', fail: 'Fail', not_applicable: 'Not applicable' },
  generated: (runId) => `Generated from run ${runId}.`,
};

const nl: PackStrings = {
  packTitle: 'Advertentiepakket',
  approved: (date) => `Goedgekeurd bij Gate 2 op ${date} UTC`,
  market: (name) => `Markt: ${name}`,
  notReadyTitle: 'Nog niet klaar voor publicatie',
  reviewTitle: 'Controleer vóór publicatie',
  refusedTitle: (categories) =>
    `Ongewijzigd goedgekeurd, wat niet is toegestaan bij ${categories}: pas aan of verwijder vóór publicatie`,
  phrasingCategory: {
    exclusionary: 'uitsluitend taalgebruik',
    investment_promise: 'beleggingsbeloften',
    unverifiable_superlative: 'onbewijsbare superlatieven',
  },
  notReadyBody: (n) =>
    `${n} ${n === 1 ? 'punt' : 'punten'} van de publicatiecontrole ${n === 1 ? 'voldoet' : 'voldoen'} niet. Los dit op vóór publicatie:`,
  overridesTitle: 'Ongewijzigd goedgekeurd ondanks een auditmelding (besluit van de gebruiker)',
  overridesNone: 'Geen gemarkeerde tekst is ongewijzigd goedgekeurd.',
  editedTitle: 'Herschreven bij Gate 2 (niet opnieuw gecontroleerd)',
  warningsTitle: 'Waarschuwingen van Gate 2',
  warningUnmentioned: (variant, fact, required) =>
    `De ${variant} noemt ${fact} niet meer${required ? ' (verplicht in deze markt)' : ''}.`,
  warningEmpty: (variant) => `Alle zinnen van de ${variant} zijn verwijderd.`,
  copyTitle: 'Advertentietekst',
  portalTitle: 'Omschrijving voor de woningsite',
  socialTitle: 'Tekst voor sociale media',
  variantEmpty: 'Geen tekst: alle zinnen zijn bij Gate 2 verwijderd.',
  variantName: { portal: 'omschrijving', social: 'tekst voor sociale media' },
  factsTitle: 'Feitenoverzicht',
  factColumn: 'Kenmerk',
  valueColumn: 'Waarde',
  basisColumn: 'Meetgrondslag',
  sourceColumn: 'Bron',
  missing: 'Niet geverifieerd',
  ambiguous: 'Meerdere geverifieerde waarden; geen getoond',
  yes: 'Ja',
  no: 'Nee',
  otherFactsTitle: 'Overige geverifieerde feiten',
  presencesTitle: 'Zichtbaar op de foto’s',
  presenceNote: 'Alleen aanwezigheid: foto’s onderbouwen nooit een aantal of een maat.',
  seenIn: (rooms) => `gezien in: ${rooms}`,
  sources: {
    form: 'Feitenformulier',
    transcript_turn: 'Rondleiding',
    photo_region: 'Foto',
    gate_decision: 'Besluit bij Gate 1',
  },
  photosTitle: 'Foto’s',
  photo: (n) => `Foto ${n}`,
  original: 'Origineel',
  blurred: 'gezichten en kentekens onherkenbaar gemaakt',
  noPhotos: 'Er kan geen foto worden gepubliceerd.',
  withheldTitle: 'Achtergehouden foto’s',
  upload: (n, staged) => `Upload ${n}${staged ? ', gestylde versie' : ''}`,
  withheld: {
    privacy_review: 'achtergehouden: privacycontrole onvolledig',
    privacy_failed: 'achtergehouden: privacycontrole onvolledig',
    privacy_regions_invalid: 'achtergehouden: privacygebieden onleesbaar',
    blur_failed: 'achtergehouden: onherkenbaar maken mislukt',
    original_withheld: 'achtergehouden samen met het origineel',
    staged_unverified: 'achtergehouden: de integriteitscontrole bevestigt deze niet',
    label_failed: 'achtergehouden: het label kon niet worden aangebracht',
  },
  checklistTitle: 'Publicatiecontrole',
  itemColumn: 'Punt',
  statusColumn: 'Status',
  detailColumn: 'Toelichting',
  status: { pass: 'Voldoet', fail: 'Voldoet niet', not_applicable: 'Niet van toepassing' },
  generated: (runId) => `Gemaakt uit run ${runId}.`,
};

export function packStrings(language: string): PackStrings {
  return language === 'nl' ? nl : en;
}
