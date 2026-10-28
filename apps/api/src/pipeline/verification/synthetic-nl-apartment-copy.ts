import type { VerificationInput } from './schema.ts';

// Synthetic verification input for the fictional apartment in
// ../reconciliation/synthetic-nl-apartment.ts, after Gate 1 (living area resolved to the form's
// 92 m2, bedrooms to the photos' 3). Every segment passes the code-level claim validator (known
// fact IDs, numbers equal to the cited facts); the planted defects need semantic judgment.

export const SYNTHETIC_NL_APARTMENT_COPY: VerificationInput = {
  outputLanguage: 'en',
  facts: [
    { id: 'VF01', key: 'property_type', value: 'apartment', unit: null, basis: null },
    { id: 'VF02', key: 'energy_label', value: 'A', unit: null, basis: null },
    { id: 'VF03', key: 'living_area', value: 92, unit: 'm2', basis: 'NEN2580' },
    { id: 'VF04', key: 'bedrooms', value: 3, unit: null, basis: null },
    { id: 'VF05', key: 'build_year', value: 1996, unit: null, basis: null },
    { id: 'VF06', key: 'floor_level', value: 3, unit: null, basis: null },
    { id: 'VF07', key: 'elevator', value: 'yes', unit: null, basis: null },
    { id: 'VF08', key: 'outdoor_area', value: 7, unit: 'm2', basis: 'NEN2580' },
    { id: 'VF09', key: 'balcony_orientation', value: 'south-west', unit: null, basis: null },
    { id: 'VF10', key: 'external_storage_area', value: 6, unit: 'm2', basis: 'NEN2580' },
    { id: 'VF11', key: 'volume', value: 298, unit: 'm3', basis: 'NEN2580' },
    {
      id: 'VF12',
      key: 'gross_floor_area_incl_storage_and_walls',
      value: 104,
      unit: 'm2',
      basis: null,
    },
    { id: 'VF13', key: 'kitchen_renovation_year', value: 2021, unit: null, basis: null },
    {
      id: 'VF14',
      key: 'kitchen_appliances',
      value: 'induction hob, dishwasher',
      unit: null,
      basis: null,
    },
    { id: 'VF15', key: 'bathrooms', value: 1, unit: null, basis: null },
    { id: 'VF16', key: 'toilets', value: 2, unit: null, basis: null },
    { id: 'VF17', key: 'heating_boiler_year', value: 2019, unit: null, basis: null },
    { id: 'VF18', key: 'vve_monthly_contribution', value: 185, unit: 'EUR', basis: null },
    { id: 'VF19', key: 'vve_maintenance_plan', value: 'yes', unit: null, basis: null },
    { id: 'VF20', key: 'ground_lease', value: 'none (freehold)', unit: null, basis: null },
    {
      id: 'VF21',
      key: 'parking',
      value: 'permit parking, no private space',
      unit: null,
      basis: null,
    },
    {
      id: 'VF22',
      key: 'flooring',
      value: 'wooden floors in living room and bedrooms',
      unit: null,
      basis: null,
    },
    {
      id: 'VF23',
      key: 'built_in_wardrobe',
      value: 'full-width, in the largest bedroom',
      unit: null,
      basis: null,
    },
  ],
  marketRules: [
    { id: 'energy_label_shown', rule: 'The portal description states the energy label.' },
    {
      id: 'area_basis',
      rule: 'A living-area figure must be the NEN 2580 living area; any other area must say what it measures.',
    },
    {
      id: 'no_exclusionary',
      rule: 'No phrasing that excludes or prefers buyers by family status, age, origin, religion, disability, or similar.',
    },
    { id: 'no_investment_promise', rule: 'No promises or predictions of value growth or returns.' },
    {
      id: 'no_unverifiable_superlative',
      rule: 'No superlatives the facts cannot verify ("best", "most sought-after", "unique").',
    },
  ],
  segments: [
    {
      id: 'S01',
      artifact: 'portal',
      text: 'A 3-bedroom apartment on the 3rd floor of a 1996 building with a lift.',
      factIds: ['VF04', 'VF06', 'VF05', 'VF07'],
    },
    {
      id: 'S02',
      artifact: 'portal',
      text: 'The NEN 2580 living area is 92 m², and the energy label is A.',
      factIds: ['VF03', 'VF02'],
    },
    {
      id: 'S03',
      artifact: 'portal',
      text: 'With 104 m² of living space, there is room for everyone.',
      factIds: ['VF12'],
    },
    {
      id: 'S04',
      artifact: 'portal',
      text: 'The kitchen was renewed in 2021 and has an induction hob and a dishwasher.',
      factIds: ['VF13', 'VF14'],
    },
    {
      id: 'S05',
      artifact: 'portal',
      text: 'Underfloor heating keeps the wooden floors warm all winter.',
      factIds: ['VF22', 'VF17'],
    },
    {
      id: 'S06',
      artifact: 'portal',
      text: 'From the kitchen you step onto a 7 m² south-west-facing balcony.',
      factIds: ['VF08', 'VF09'],
    },
    {
      id: 'S07',
      artifact: 'portal',
      text: 'The largest bedroom has a full-width built-in wardrobe.',
      factIds: ['VF23'],
    },
    {
      id: 'S08',
      artifact: 'portal',
      text: 'Located on the most sought-after street in the neighbourhood, on the 3rd floor with a lift.',
      factIds: ['VF06', 'VF07'],
    },
    {
      id: 'S09',
      artifact: 'portal',
      text: 'There is 1 bathroom, and there are 2 toilets in total.',
      factIds: ['VF15', 'VF16'],
    },
    {
      id: 'S10',
      artifact: 'portal',
      text: 'Heating is provided by a central-heating boiler from 2019.',
      factIds: ['VF17'],
    },
    {
      id: 'S11',
      artifact: 'portal',
      text: 'A private 6 m² storage room comes with the apartment.',
      factIds: ['VF10'],
    },
    {
      id: 'S12',
      artifact: 'portal',
      text: 'With a multi-year maintenance plan in place, this apartment is a safe investment that will only increase in value.',
      factIds: ['VF19'],
    },
    {
      id: 'S13',
      artifact: 'portal',
      text: 'Service costs are EUR 185 per month, and the apartment is on freehold land.',
      factIds: ['VF18', 'VF20'],
    },
    {
      id: 'S14',
      artifact: 'portal',
      text: 'Parking is by permit; there is no private parking space.',
      factIds: ['VF21'],
    },
    {
      id: 'S15',
      artifact: 'social',
      text: '3 bedrooms, 92 m² (NEN 2580), energy label A.',
      factIds: ['VF04', 'VF03', 'VF02'],
    },
    {
      id: 'S16',
      artifact: 'social',
      text: 'South-west balcony and a kitchen renewed in 2021.',
      factIds: ['VF09', 'VF13'],
    },
    {
      id: 'S17',
      artifact: 'social',
      text: 'Perfect for young professionals, not suited to families with children.',
      factIds: ['VF06'],
    },
    {
      id: 'S18',
      artifact: 'social',
      text: 'Wooden floors in the living room and bedrooms.',
      factIds: ['VF22'],
    },
    {
      id: 'S19',
      artifact: 'qa',
      text: 'Q: What is the energy label? A: The energy label is A.',
      factIds: ['VF02'],
    },
    {
      id: 'S20',
      artifact: 'qa',
      text: 'Q: How large is the apartment? A: The NEN 2580 living area is 92 m², and the volume is 298 m³.',
      factIds: ['VF03', 'VF11'],
    },
    {
      id: 'S21',
      artifact: 'qa',
      text: 'Q: What are the monthly service costs? A: EUR 185 per month.',
      factIds: ['VF18'],
    },
    {
      id: 'S22',
      artifact: 'qa',
      text: 'Q: Is there a lift? A: Yes, the building has a lift.',
      factIds: ['VF07'],
    },
    {
      id: 'S23',
      artifact: 'qa',
      text: 'Q: Is it leasehold? A: No, the apartment is on freehold land.',
      factIds: ['VF20'],
    },
    {
      id: 'S24',
      artifact: 'qa',
      text: 'Q: How old is the boiler? A: The boiler dates from 2019 and is serviced every year.',
      factIds: ['VF17'],
    },
    {
      id: 'S25',
      artifact: 'qa',
      text: 'Q: Is there parking? A: Parking is by permit; there is no private space.',
      factIds: ['VF21'],
    },
    {
      id: 'S26',
      artifact: 'qa',
      text: 'Q: How many bedrooms are there? A: 3.',
      factIds: ['VF04'],
    },
  ],
};

/** Segments with a planted defect; every other segment is supported by its cited facts. */
export const SYNTHETIC_NL_APARTMENT_COPY_DEFECTS: Readonly<Record<string, string>> = {
  S03: 'gross area incl. storage and walls presented as living space (area_basis)',
  S05: 'underfloor heating is not in any cited fact',
  S08: 'unverifiable superlative',
  S12: 'investment promise',
  S17: 'exclusionary phrasing (family status, age)',
  S24: 'annual servicing is not in the cited fact',
};
