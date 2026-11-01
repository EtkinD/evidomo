import { UI_LOCALES } from '@evidomo/shared';
import type {
  ChecklistItemStatus,
  ExportWithheldReason,
  FactSourceKind,
  PhrasingCategory,
  UiLocale,
} from '@evidomo/shared';

// The HTML pack's fixed wording, in every language the product ships (`PACK_LANGUAGES`: en, tr,
// nl, it, es). A market profile's output language must be one of them; the boot check uses
// `hasPackStrings` to refuse a profile that is not. Market labels come from the profile
// (translated there, picked by output language); checklist details and the "Virtually staged"
// label come from their own sources and are not translated here.
//
// Sentence templates that embed a variable noun (a variant name, a fact label, a run ID) are
// built so the surrounding words never need to agree with it (case suffixes in Turkish, articles
// and participles in Italian and Spanish): the noun sits in quotes or after a colon.

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
  readonly variantName: { readonly portal: string; readonly social: string; readonly qa: string };
  /** The buyer Q&A section (P3-03), shown only when the pack has cards. */
  readonly qaTitle: string;
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
  variantName: { portal: 'portal description', social: 'social media caption', qa: 'buyer Q&A' },
  qaTitle: 'Buyer questions and answers',
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
  variantName: {
    portal: 'omschrijving',
    social: 'tekst voor sociale media',
    qa: 'vragen van kopers',
  },
  qaTitle: 'Vragen en antwoorden voor kopers',
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

const tr: PackStrings = {
  packTitle: 'İlan dosyası',
  approved: (date) => `Gate 2’de ${date} UTC tarihinde onaylandı`,
  market: (name) => `Pazar: ${name}`,
  notReadyTitle: 'Yayımlanmaya henüz hazır değil',
  reviewTitle: 'Yayımlamadan önce kontrol edin',
  refusedTitle: (categories) =>
    `Olduğu gibi onaylandı; ${categories} için buna izin verilmez: yayımlamadan önce düzenleyin veya kaldırın`,
  phrasingCategory: {
    exclusionary: 'dışlayıcı dil',
    investment_promise: 'yatırım vaatleri',
    unverifiable_superlative: 'doğrulanamayan üstünlük ifadeleri',
  },
  notReadyBody: (n) =>
    `Yayın kontrol listesinde ${n} madde karşılanmıyor. Yayımlamadan önce ${n === 1 ? 'bunu' : 'bunları'} giderin:`,
  overridesTitle: 'Denetim uyarısına rağmen olduğu gibi onaylandı (kullanıcının kararı)',
  overridesNone: 'Olduğu gibi onaylanan işaretli metin yok.',
  editedTitle: 'Gate 2’de yeniden yazıldı (yeniden denetlenmedi)',
  warningsTitle: 'Gate 2 uyarıları',
  warningUnmentioned: (variant, fact, required) =>
    `“${variant}” bölümü artık “${fact}” bilgisini içermiyor${required ? ' (bu pazar için zorunlu)' : ''}.`,
  warningEmpty: (variant) => `“${variant}” bölümündeki tüm cümleler kaldırıldı.`,
  copyTitle: 'İlan metni',
  portalTitle: 'Portal açıklaması',
  socialTitle: 'Sosyal medya metni',
  variantEmpty: 'Metin yok: tüm cümleler Gate 2’de kaldırıldı.',
  variantName: {
    portal: 'portal açıklaması',
    social: 'sosyal medya metni',
    qa: 'alıcı soruları ve yanıtları',
  },
  qaTitle: 'Alıcı soruları ve yanıtları',
  factsTitle: 'Bilgi tablosu',
  factColumn: 'Özellik',
  valueColumn: 'Değer',
  basisColumn: 'Ölçüm esası',
  sourceColumn: 'Kaynak',
  missing: 'Doğrulanmadı',
  ambiguous: 'Birden fazla doğrulanmış değer var; hiçbiri gösterilmiyor',
  yes: 'Evet',
  no: 'Hayır',
  otherFactsTitle: 'Diğer doğrulanmış bilgiler',
  presencesTitle: 'Fotoğraflarda görülenler',
  presenceNote: 'Yalnızca varlık: fotoğraflar hiçbir zaman bir adedi veya ölçüyü doğrulamaz.',
  seenIn: (rooms) => `görüldüğü yerler: ${rooms}`,
  sources: {
    form: 'Bilgi formu',
    transcript_turn: 'Mülk turu',
    photo_region: 'Fotoğraf',
    gate_decision: 'Gate 1 kararı',
  },
  photosTitle: 'Fotoğraflar',
  photo: (n) => `Fotoğraf ${n}`,
  original: 'Orijinal',
  blurred: 'yüzler ve plakalar bulanıklaştırıldı',
  noPhotos: 'Yayımlanabilecek fotoğraf yok.',
  withheldTitle: 'Hariç tutulan fotoğraflar',
  upload: (n, staged) => `Yükleme ${n}${staged ? ', sanal döşenmiş sürüm' : ''}`,
  withheld: {
    privacy_review: 'hariç tutuldu: gizlilik kontrolü tamamlanmadı',
    privacy_failed: 'hariç tutuldu: gizlilik kontrolü tamamlanmadı',
    privacy_regions_invalid: 'hariç tutuldu: gizlilik bölgeleri okunamadı',
    blur_failed: 'hariç tutuldu: bulanıklaştırma başarısız oldu',
    original_withheld: 'orijinaliyle birlikte hariç tutuldu',
    staged_unverified: 'hariç tutuldu: bütünlük kontrolü bunu doğrulamıyor',
    label_failed: 'hariç tutuldu: bilgilendirme etiketi uygulanamadı',
  },
  checklistTitle: 'Yayın kontrol listesi',
  itemColumn: 'Madde',
  statusColumn: 'Durum',
  detailColumn: 'Ayrıntı',
  status: { pass: 'Uygun', fail: 'Uygun değil', not_applicable: 'Geçerli değil' },
  generated: (runId) => `Oluşturan çalıştırma: ${runId}.`,
};

const it: PackStrings = {
  packTitle: 'Pacchetto annuncio',
  approved: (date) => `Approvato al Gate 2 il ${date} UTC`,
  market: (name) => `Mercato: ${name}`,
  notReadyTitle: 'Non ancora pronto per la pubblicazione',
  reviewTitle: 'Da verificare prima della pubblicazione',
  refusedTitle: (categories) =>
    `Approvato così com’è, il che non è consentito per ${categories}: modificare o rimuovere prima della pubblicazione`,
  phrasingCategory: {
    exclusionary: 'linguaggio escludente',
    investment_promise: 'promesse di investimento',
    unverifiable_superlative: 'superlativi non verificabili',
  },
  notReadyBody: (n) =>
    `${n} ${n === 1 ? 'voce' : 'voci'} della checklist di pubblicazione ${n === 1 ? 'non supera' : 'non superano'} il controllo. ${n === 1 ? 'Risolverla' : 'Risolverle'} prima della pubblicazione:`,
  overridesTitle:
    'Approvato così com’è nonostante una segnalazione dell’audit (decisione dell’utente)',
  overridesNone: 'Nessun testo segnalato è stato approvato così com’è.',
  editedTitle: 'Riscritto al Gate 2 (non sottoposto a un nuovo audit)',
  warningsTitle: 'Avvisi del Gate 2',
  warningUnmentioned: (variant, fact, required) =>
    `Nella sezione «${variant}» non compare più «${fact}»${required ? ' (richiesto dal mercato)' : ''}.`,
  warningEmpty: (variant) => `Nella sezione «${variant}» tutte le frasi sono state rimosse.`,
  copyTitle: 'Testo dell’annuncio',
  portalTitle: 'Descrizione per il portale',
  socialTitle: 'Didascalia per i social media',
  variantEmpty: 'Nessun testo: tutte le frasi sono state rimosse al Gate 2.',
  variantName: {
    portal: 'descrizione per il portale',
    social: 'didascalia per i social media',
    qa: 'domande e risposte degli acquirenti',
  },
  qaTitle: 'Domande e risposte degli acquirenti',
  factsTitle: 'Scheda dei dati',
  factColumn: 'Caratteristica',
  valueColumn: 'Valore',
  basisColumn: 'Base di misurazione',
  sourceColumn: 'Fonte',
  missing: 'Non verificato',
  ambiguous: 'Più valori verificati; nessuno mostrato',
  yes: 'Sì',
  no: 'No',
  otherFactsTitle: 'Altri dati verificati',
  presencesTitle: 'Visto nelle foto',
  presenceNote: 'Solo presenza: le foto non attestano mai una quantità o una misura.',
  seenIn: (rooms) => `visto in: ${rooms}`,
  sources: {
    form: 'Modulo dei dati',
    transcript_turn: 'Visita guidata',
    photo_region: 'Foto',
    gate_decision: 'Decisione al Gate 1',
  },
  photosTitle: 'Foto',
  photo: (n) => `Foto ${n}`,
  original: 'Originale',
  blurred: 'volti e targhe sfocati',
  noPhotos: 'Nessuna foto può essere pubblicata.',
  withheldTitle: 'Foto escluse',
  upload: (n, staged) => `Caricamento ${n}${staged ? ', versione con home staging virtuale' : ''}`,
  withheld: {
    privacy_review: 'esclusa: controllo della privacy incompleto',
    privacy_failed: 'esclusa: controllo della privacy incompleto',
    privacy_regions_invalid: 'esclusa: le aree per la privacy non sono leggibili',
    blur_failed: 'esclusa: sfocatura non riuscita',
    original_withheld: 'esclusa insieme all’originale',
    staged_unverified: 'esclusa: il controllo di integrità non la conferma',
    label_failed: 'esclusa: non è stato possibile applicare l’etichetta di segnalazione',
  },
  checklistTitle: 'Checklist di pubblicazione',
  itemColumn: 'Voce',
  statusColumn: 'Stato',
  detailColumn: 'Dettaglio',
  status: { pass: 'Superato', fail: 'Non superato', not_applicable: 'Non applicabile' },
  generated: (runId) => `Generato dal run ${runId}.`,
};

const es: PackStrings = {
  packTitle: 'Paquete del anuncio',
  approved: (date) => `Aprobado en el Gate 2 el ${date} UTC`,
  market: (name) => `Mercado: ${name}`,
  notReadyTitle: 'Aún no está listo para publicar',
  reviewTitle: 'Revisar antes de publicar',
  refusedTitle: (categories) =>
    `Aprobado tal como está, lo cual no está permitido para ${categories}: editar o eliminar antes de publicar`,
  phrasingCategory: {
    exclusionary: 'lenguaje excluyente',
    investment_promise: 'promesas de inversión',
    unverifiable_superlative: 'superlativos no verificables',
  },
  notReadyBody: (n) =>
    `${n} ${n === 1 ? 'punto' : 'puntos'} de la lista de verificación de publicación ${n === 1 ? 'no se cumple' : 'no se cumplen'}. Hay que ${n === 1 ? 'resolverlo' : 'resolverlos'} antes de publicar:`,
  overridesTitle: 'Aprobado tal como está pese a una alerta de la auditoría (decisión del usuario)',
  overridesNone: 'Ningún texto marcado se aprobó tal como está.',
  editedTitle: 'Reescrito en el Gate 2 (sin una nueva auditoría)',
  warningsTitle: 'Avisos del Gate 2',
  warningUnmentioned: (variant, fact, required) =>
    `En el apartado «${variant}» ya no se menciona «${fact}»${required ? ' (obligatorio en este mercado)' : ''}.`,
  warningEmpty: (variant) => `En el apartado «${variant}» se eliminaron todas las frases.`,
  copyTitle: 'Texto del anuncio',
  portalTitle: 'Descripción para el portal',
  socialTitle: 'Texto para redes sociales',
  variantEmpty: 'Sin texto: se eliminaron todas las frases en el Gate 2.',
  variantName: {
    portal: 'descripción para el portal',
    social: 'texto para redes sociales',
    qa: 'preguntas y respuestas de compradores',
  },
  qaTitle: 'Preguntas y respuestas de compradores',
  factsTitle: 'Ficha de datos',
  factColumn: 'Dato',
  valueColumn: 'Valor',
  basisColumn: 'Base de medición',
  sourceColumn: 'Fuente',
  missing: 'No verificado',
  ambiguous: 'Varios valores verificados; no se muestra ninguno',
  yes: 'Sí',
  no: 'No',
  otherFactsTitle: 'Otros datos verificados',
  presencesTitle: 'Visto en las fotos',
  presenceNote: 'Solo presencia: las fotos nunca respaldan una cantidad ni una medida.',
  seenIn: (rooms) => `visto en: ${rooms}`,
  sources: {
    form: 'Formulario de datos',
    transcript_turn: 'Recorrido',
    photo_region: 'Foto',
    gate_decision: 'Decisión del Gate 1',
  },
  photosTitle: 'Fotos',
  photo: (n) => `Foto ${n}`,
  original: 'Original',
  blurred: 'rostros y placas de matrícula difuminados',
  noPhotos: 'No se puede publicar ninguna foto.',
  withheldTitle: 'Fotos excluidas',
  upload: (n, staged) => `Archivo ${n}${staged ? ', versión con home staging virtual' : ''}`,
  withheld: {
    privacy_review: 'excluida: comprobación de privacidad incompleta',
    privacy_failed: 'excluida: comprobación de privacidad incompleta',
    privacy_regions_invalid: 'excluida: no se pudieron leer las zonas de privacidad',
    blur_failed: 'excluida: falló el difuminado',
    original_withheld: 'excluida junto con su original',
    staged_unverified: 'excluida: la comprobación de integridad no la confirma',
    label_failed: 'excluida: no se pudo aplicar la etiqueta de aviso',
  },
  checklistTitle: 'Lista de verificación de publicación',
  itemColumn: 'Punto',
  statusColumn: 'Estado',
  detailColumn: 'Detalle',
  status: { pass: 'Cumple', fail: 'No cumple', not_applicable: 'No aplica' },
  generated: (runId) => `Generado a partir del run ${runId}.`,
};

/** Every language the HTML pack has wording for: the languages the product ships. */
export const PACK_LANGUAGES: readonly UiLocale[] = UI_LOCALES;

const BY_LANGUAGE: Readonly<Record<UiLocale, PackStrings>> = { en, nl, tr, it, es };

export function hasPackStrings(language: string): language is UiLocale {
  return Object.hasOwn(BY_LANGUAGE, language);
}

/**
 * The pack wording for an output language. A language without strings gets English; the boot
 * check (`hasPackStrings`) is what keeps a market profile from ever reaching that fallback.
 */
export function packStrings(language: string): PackStrings {
  return hasPackStrings(language) ? BY_LANGUAGE[language] : en;
}
