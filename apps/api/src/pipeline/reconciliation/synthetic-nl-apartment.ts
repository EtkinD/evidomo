import type { ReconciliationInput } from './schema.ts';

// Synthetic reconciliation input: one fictional Dutch apartment. The address is invented and
// deliberately invalid (Dutch postcodes start at 1000); there are no names, faces, or plates.
// Reused by the P1-03 model matrix, the P2-09 step tests, and the seeded-defect eval.
//
// The transcript is Dutch (the source language of a real walkthrough); candidate facts are what
// the P2-07 extraction would produce from it. Photos are vision-inventory summaries, not images.
//
// Planted defects (see SYNTHETIC_NL_APARTMENT_EXPECTATIONS):
// - C05 vs F.living_area: same basis (NEN 2580), different value (95 vs 92 m2) -> real conflict.
// - C06: gross area incl. storage and walls, no basis (104 m2) -> different basis, NOT a conflict.
// - C12 vs INV1/P05-P07: "two bedrooms" vs three distinct bedroom photos -> real conflict.
// - C21: seller's opinion and value prediction -> must never become a verified fact.
// Agreeing sources without a stated basis (C11 balcony 7 m2, C17 storage 6 m2, C22 volume 298 m3)
// equal the form values and must not be reported as conflicts either.

const T = (
  turnId: string,
  speaker: 'agent' | 'seller',
  startMs: number,
  endMs: number,
  text: string,
): ReconciliationInput['transcript'][number] => ({ turnId, speaker, startMs, endMs, text });

const transcript: ReconciliationInput['transcript'] = [
  T(
    'T01',
    'agent',
    0,
    9_800,
    'Oké, we beginnen bij de voordeur. Dit is het appartement op de derde verdieping, je komt binnen via de centrale hal en er is een lift in het gebouw.',
  ),
  T(
    'T02',
    'agent',
    9_800,
    21_400,
    'Het gebouw is in 1996 opgeleverd, dus het is goed geïsoleerd. Het energielabel is A, dat staat ook op het registratiebewijs.',
  ),
  T(
    'T03',
    'agent',
    21_400,
    36_800,
    'We lopen nu de woonkamer in. Volgens het meetrapport is de woonoppervlakte 95 vierkante meter, gemeten volgens NEN 2580.',
  ),
  T(
    'T04',
    'seller',
    36_800,
    44_100,
    'Klopt, en door die grote ramen heb je hier de hele middag licht.',
  ),
  T(
    'T05',
    'agent',
    44_100,
    58_900,
    'Als je alles meetelt, dus ook de berging in de onderbouw en de muren, zit je bruto op zo’n 104 vierkante meter.',
  ),
  T(
    'T06',
    'agent',
    58_900,
    70_200,
    'De keuken is in 2021 vernieuwd, met een inductiekookplaat en een vaatwasser.',
  ),
  T(
    'T07',
    'agent',
    70_200,
    82_600,
    'Via de keuken kom je op het balkon. Het balkon ligt op het zuidwesten en is ongeveer 7 vierkante meter.',
  ),
  T('T08', 'seller', 82_600, 90_400, 'Daar zitten we in de zomer bijna elke avond.'),
  T(
    'T09',
    'agent',
    90_400,
    104_000,
    'Dan de gang door naar de slaapkamers. Het appartement heeft twee slaapkamers, allebei aan de rustige achterkant.',
  ),
  T(
    'T10',
    'agent',
    104_000,
    116_500,
    'Dit is de grootste slaapkamer, met een inbouwkast over de volle breedte.',
  ),
  T(
    'T11',
    'agent',
    116_500,
    127_900,
    'En hier de tweede slaapkamer, met een raam aan de achterzijde.',
  ),
  T(
    'T12',
    'agent',
    127_900,
    139_300,
    'De badkamer heeft een inloopdouche, een wastafelmeubel en een tweede toilet.',
  ),
  T('T13', 'agent', 139_300, 148_000, 'Het eerste toilet zit apart bij de voordeur.'),
  T(
    'T14',
    'agent',
    148_000,
    161_500,
    'De verwarming gaat via een cv-ketel uit 2019, die is vorig jaar nog onderhouden.',
  ),
  T(
    'T15',
    'agent',
    161_500,
    173_800,
    'In de onderbouw is er een eigen berging van 6 vierkante meter, met stroom.',
  ),
  T(
    'T16',
    'agent',
    173_800,
    188_200,
    'De VvE is actief. De servicekosten zijn 185 euro per maand, en er is een meerjarenonderhoudsplan.',
  ),
  T('T17', 'agent', 188_200, 199_500, 'Het is eigen grond, dus er is geen erfpacht.'),
  T(
    'T18',
    'seller',
    199_500,
    212_600,
    'Eerlijk gezegd is dit de mooiste straat van de hele wijk, en de woning wordt hier alleen maar meer waard.',
  ),
  T('T19', 'agent', 212_600, 223_000, 'De inhoud is ongeveer 298 kubieke meter.'),
  T(
    'T20',
    'agent',
    223_000,
    236_400,
    'Parkeren gaat met een vergunning; er is geen eigen parkeerplaats.',
  ),
  T(
    'T21',
    'agent',
    236_400,
    246_000,
    'Er liggen houten vloeren in de woonkamer en in de slaapkamers.',
  ),
  T('T22', 'agent', 246_000, 255_300, 'Dat was de rondgang. Ik maak nog foto’s van de meterkast.'),
];

function turn(turnId: string): ReconciliationInput['transcript'][number] {
  const found = transcript.find((item) => item.turnId === turnId);
  if (found === undefined) throw new Error(`Synthetic fixture references unknown turn ${turnId}`);
  return found;
}

const C = (
  id: string,
  key: string,
  value: number | string,
  unit: string | null,
  basis: string | null,
  turnId: string,
  quote: string,
): ReconciliationInput['candidates'][number] => {
  const { startMs, endMs } = turn(turnId);
  return { id, key, value, unit, basis, quote, turnId, startMs, endMs };
};

const candidates: ReconciliationInput['candidates'] = [
  C('C01', 'floor_level', 3, null, null, 'T01', 'het appartement op de derde verdieping'),
  C('C02', 'elevator', 'yes', null, null, 'T01', 'er is een lift in het gebouw'),
  C('C03', 'build_year', 1996, null, null, 'T02', 'Het gebouw is in 1996 opgeleverd'),
  C('C04', 'energy_label', 'A', null, null, 'T02', 'Het energielabel is A'),
  C(
    'C05',
    'living_area',
    95,
    'm2',
    'NEN2580',
    'T03',
    'de woonoppervlakte 95 vierkante meter, gemeten volgens NEN 2580',
  ),
  C(
    'C06',
    'floor_area',
    104,
    'm2',
    null,
    'T05',
    'ook de berging in de onderbouw en de muren, zit je bruto op zo’n 104 vierkante meter',
  ),
  C('C07', 'kitchen_renovation_year', 2021, null, null, 'T06', 'De keuken is in 2021 vernieuwd'),
  C(
    'C08',
    'kitchen_appliances',
    'induction hob, dishwasher',
    null,
    null,
    'T06',
    'met een inductiekookplaat en een vaatwasser',
  ),
  C('C09', 'balcony', 'yes', null, null, 'T07', 'Via de keuken kom je op het balkon'),
  C('C10', 'balcony_orientation', 'south-west', null, null, 'T07', 'ligt op het zuidwesten'),
  C('C11', 'balcony_area', 7, 'm2', null, 'T07', 'is ongeveer 7 vierkante meter'),
  C('C12', 'bedrooms', 2, null, null, 'T09', 'Het appartement heeft twee slaapkamers'),
  C(
    'C13',
    'built_in_wardrobe',
    'full-width, in the largest bedroom',
    null,
    null,
    'T10',
    'met een inbouwkast over de volle breedte',
  ),
  C(
    'C14',
    'bathroom_features',
    'walk-in shower, vanity unit, toilet',
    null,
    null,
    'T12',
    'De badkamer heeft een inloopdouche, een wastafelmeubel en een tweede toilet',
  ),
  C('C15', 'toilets', 2, null, null, 'T12', 'een tweede toilet'),
  C('C16', 'heating_boiler_year', 2019, null, null, 'T14', 'een cv-ketel uit 2019'),
  C('C17', 'storage_area', 6, 'm2', null, 'T15', 'een eigen berging van 6 vierkante meter'),
  C(
    'C18',
    'vve_monthly_contribution',
    185,
    'EUR',
    null,
    'T16',
    'De servicekosten zijn 185 euro per maand',
  ),
  C('C19', 'vve_maintenance_plan', 'yes', null, null, 'T16', 'er is een meerjarenonderhoudsplan'),
  C('C20', 'ground_lease', 'none (freehold)', null, null, 'T17', 'Het is eigen grond'),
  C(
    'C21',
    'location_quality',
    'most beautiful street in the neighbourhood; value will only increase',
    null,
    null,
    'T18',
    'dit de mooiste straat van de hele wijk, en de woning wordt hier alleen maar meer waard',
  ),
  C('C22', 'volume', 298, 'm3', null, 'T19', 'De inhoud is ongeveer 298 kubieke meter'),
  C(
    'C23',
    'parking',
    'permit parking, no private space',
    null,
    null,
    'T20',
    'Parkeren gaat met een vergunning; er is geen eigen parkeerplaats',
  ),
  C(
    'C24',
    'flooring',
    'wooden floors in living room and bedrooms',
    null,
    null,
    'T21',
    'houten vloeren in de woonkamer en in de slaapkamers',
  ),
];

export const SYNTHETIC_NL_APARTMENT: ReconciliationInput = {
  property: {
    label: 'Fictieweg 1-3 (fictional), 0000 XX Voorbeeldstad',
    market: 'nl',
    propertyType: 'apartment',
    sourceLanguage: 'nl',
    outputLanguage: 'en',
  },
  form: [
    { id: 'F.property_type', field: 'property_type', value: 'apartment', unit: null, basis: null },
    { id: 'F.energy_label', field: 'energy_label', value: 'A', unit: null, basis: null },
    { id: 'F.living_area', field: 'living_area', value: 92, unit: 'm2', basis: 'NEN2580' },
    {
      id: 'F.outdoor_area',
      field: 'outdoor_area',
      value: 7,
      unit: 'm2',
      basis: 'NEN2580',
    },
    {
      id: 'F.external_storage_area',
      field: 'external_storage_area',
      value: 6,
      unit: 'm2',
      basis: 'NEN2580',
    },
    { id: 'F.volume', field: 'volume', value: 298, unit: 'm3', basis: 'NEN2580' },
    { id: 'F.plot_area', field: 'plot_area', value: null, unit: 'm2', basis: null },
    { id: 'F.build_year', field: 'build_year', value: 1996, unit: null, basis: null },
    {
      id: 'F.vve_monthly_contribution',
      field: 'vve_monthly_contribution',
      value: 185,
      unit: 'EUR',
      basis: null,
    },
    {
      id: 'F.ground_lease',
      field: 'ground_lease',
      value: 'none (freehold)',
      unit: null,
      basis: null,
    },
    { id: 'F.floor_level', field: 'floor_level', value: 3, unit: null, basis: null },
  ],
  transcript,
  candidates,
  photos: [
    {
      photoId: 'P01',
      room: 'living_room',
      summary:
        'Living room seen from the hallway door; two large windows on the front wall, wooden floor.',
      observations: [
        { id: 'P01.R1', label: 'window', detail: 'Two large windows on one wall.' },
        { id: 'P01.R2', label: 'wooden_floor', detail: 'Wooden plank floor across the room.' },
      ],
    },
    {
      photoId: 'P02',
      room: 'living_room',
      summary: 'Same living room from the opposite corner; dining table near the kitchen opening.',
      observations: [{ id: 'P02.R1', label: 'dining_area', detail: 'Table with four chairs.' }],
    },
    {
      photoId: 'P03',
      room: 'kitchen',
      summary: 'Modern kitchen with a flat black cooktop and integrated appliances.',
      observations: [
        { id: 'P03.R1', label: 'cooktop', detail: 'Flat black cooktop without burners.' },
        { id: 'P03.R2', label: 'dishwasher', detail: 'Integrated dishwasher, door ajar.' },
      ],
    },
    {
      photoId: 'P04',
      room: 'balcony',
      summary: 'Balcony reached through a door from the kitchen; metal railing, two chairs.',
      observations: [
        {
          id: 'P04.R1',
          label: 'balcony',
          detail: 'Balcony floor and railing; size not measurable.',
        },
      ],
    },
    {
      photoId: 'P05',
      room: 'bedroom',
      summary:
        'Bedroom with a double bed and a full-width built-in wardrobe; white walls, window on the left.',
      observations: [
        { id: 'P05.R1', label: 'bed', detail: 'Double bed.' },
        { id: 'P05.R2', label: 'built_in_wardrobe', detail: 'Wardrobe spanning the full wall.' },
      ],
    },
    {
      photoId: 'P06',
      room: 'bedroom',
      summary:
        'Bedroom with a double bed and no wardrobe; light grey walls, one window opposite the door.',
      observations: [{ id: 'P06.R1', label: 'bed', detail: 'Double bed with grey headboard.' }],
    },
    {
      photoId: 'P07',
      room: 'bedroom',
      summary:
        'Small bedroom with a single bed and a desk; blue accent wall, window above the desk.',
      observations: [
        { id: 'P07.R1', label: 'bed', detail: 'Single bed along the blue wall.' },
        { id: 'P07.R2', label: 'desk', detail: 'Desk with chair under the window.' },
      ],
    },
    {
      photoId: 'P08',
      room: 'bathroom',
      summary: 'Bathroom with a walk-in shower, a vanity unit, and a wall-hung toilet.',
      observations: [
        { id: 'P08.R1', label: 'shower', detail: 'Walk-in shower with glass screen.' },
        { id: 'P08.R2', label: 'vanity', detail: 'Vanity unit with one basin.' },
        { id: 'P08.R3', label: 'toilet', detail: 'Wall-hung toilet.' },
      ],
    },
    {
      photoId: 'P09',
      room: 'toilet',
      summary: 'Separate toilet room next to the front door.',
      observations: [{ id: 'P09.R1', label: 'toilet', detail: 'Wall-hung toilet, small basin.' }],
    },
    {
      photoId: 'P10',
      room: 'hallway',
      summary: 'Hallway from the front door towards the bedrooms; wooden floor continues.',
      observations: [{ id: 'P10.R1', label: 'front_door', detail: 'Front door, inside view.' }],
    },
    {
      photoId: 'P11',
      room: 'storage',
      summary: 'Small storage room with a concrete floor, shelving, and a wall socket.',
      observations: [
        { id: 'P11.R1', label: 'storage_room', detail: 'Shelving unit, size not measurable.' },
        { id: 'P11.R2', label: 'socket', detail: 'Electrical wall socket.' },
      ],
    },
    {
      photoId: 'P12',
      room: 'communal_hallway',
      summary: 'Communal stairwell landing with elevator doors; no people visible.',
      observations: [{ id: 'P12.R1', label: 'elevator', detail: 'Closed elevator doors.' }],
    },
  ],
  inventory: [
    {
      id: 'INV1',
      key: 'bedrooms_observed',
      value: 3,
      photoIds: ['P05', 'P06', 'P07'],
      detail:
        'Three distinct bedrooms: different wall colours, window positions, beds, and furniture; no two photos show the same room.',
    },
    {
      id: 'INV2',
      key: 'bathrooms_observed',
      value: 1,
      photoIds: ['P08'],
      detail: 'One bathroom; the separate toilet room (P09) has no shower or bath.',
    },
    {
      id: 'INV3',
      key: 'toilets_observed',
      value: 2,
      photoIds: ['P08', 'P09'],
      detail: 'One toilet in the bathroom and one in a separate toilet room.',
    },
  ],
};

/** What a correct reconciliation of SYNTHETIC_NL_APARTMENT must and must not do. */
export interface ReconciliationExpectations {
  /** Planted conflicts: a conflict must cite every `all` ID and at least one `anyOf` ID. */
  readonly conflicts: readonly {
    readonly id: string;
    readonly all: readonly string[];
    readonly anyOf: readonly string[];
  }[];
  /** Evidence that must never appear in any conflict (different basis, or agreeing values). */
  readonly neverInConflict: readonly {
    readonly id: string;
    readonly evidenceIds: readonly string[];
  }[];
  /** Evidence that must never support a verified fact (opinion, conflicted sides). */
  readonly neverVerified: readonly {
    readonly id: string;
    readonly evidenceIds: readonly string[];
  }[];
  /** Opinion candidates; ideally rejected with reason `opinion`. */
  readonly opinions: readonly string[];
  /** Evidence that a complete fact sheet cites in some verified fact. */
  readonly expectedVerified: readonly string[];
}

export const SYNTHETIC_NL_APARTMENT_EXPECTATIONS: ReconciliationExpectations = {
  conflicts: [
    { id: 'living_area_same_basis', all: ['F.living_area', 'C05'], anyOf: [] },
    {
      id: 'bedrooms_transcript_vs_photos',
      all: ['C12'],
      anyOf: ['INV1', 'P05.R1', 'P06.R1', 'P07.R1'],
    },
  ],
  neverInConflict: [
    { id: 'gross_area_different_basis', evidenceIds: ['C06'] },
    { id: 'agreeing_values_without_basis', evidenceIds: ['C11', 'C17', 'C22'] },
  ],
  neverVerified: [
    { id: 'opinion', evidenceIds: ['C21'] },
    { id: 'conflicted_living_area', evidenceIds: ['F.living_area', 'C05'] },
    { id: 'conflicted_bedrooms', evidenceIds: ['C12', 'INV1'] },
  ],
  opinions: ['C21'],
  expectedVerified: [
    'F.energy_label',
    'F.build_year',
    'F.volume',
    'F.vve_monthly_contribution',
    'F.ground_lease',
    'F.floor_level',
    'F.outdoor_area',
    'F.external_storage_area',
    'C02',
    'C07',
    'C10',
    'C16',
    'C19',
    'C23',
    'INV2',
    'INV3',
  ],
};
