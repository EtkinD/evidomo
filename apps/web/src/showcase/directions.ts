import type { DirectionId } from './palettes';

export interface Direction {
  readonly id: DirectionId;
  readonly name: string;
  readonly tagline: string;
  readonly mood: string;
  readonly fonts: {
    readonly display: string;
    readonly body: string;
    readonly mono: string;
  };
}

export const DIRECTIONS: readonly Direction[] = [
  {
    id: 'B',
    name: 'Hearth',
    tagline: 'Warm home',
    mood: 'The round-1 favourite, unchanged: terracotta and brick, cream, deep green, Fraunces.',
    fonts: { display: 'Fraunces', body: 'Source Sans 3', mono: 'System mono' },
  },
  {
    id: 'B2',
    name: 'Hearth Clay',
    tagline: 'Softer, airier',
    mood: 'Lighter and rounder: linen surfaces, clay primary, sage secondary, honey accent, soft Fraunces with Figtree.',
    fonts: { display: 'Fraunces Soft', body: 'Figtree', mono: 'System mono' },
  },
  {
    id: 'B3',
    name: 'Hearth Canal',
    tagline: 'Deeper, editorial',
    mood: 'Deeper and tighter: brick primary, canal teal, brass accent, a much deeper dark mode, Newsreader serif.',
    fonts: { display: 'Newsreader', body: 'Source Sans 3', mono: 'System mono' },
  },
];

export const SUB_PAGES = [
  {
    slug: 'combo',
    label: 'Combination',
    summary:
      'The founder’s mix as real sample pages: B2 colours, B3 type and shape, new logo marks.',
  },
  {
    slug: 'colors',
    label: 'Colours',
    summary: 'Palettes by role, light and dark, with measured contrast.',
  },
  {
    slug: 'typography',
    label: 'Typography',
    summary: 'Type scale, body text, mono IDs, Dutch and English listing sample.',
  },
  { slug: 'logo', label: 'Logo', summary: 'Muse concepts and two SVG candidates per direction.' },
  {
    slug: 'components',
    label: 'Components',
    summary: 'Buttons, forms, badges, evidence card, run steps, conflict view.',
  },
  { slug: 'imagery', label: 'Imagery', summary: 'Muse heroes, interiors and illustrations.' },
  { slug: 'landing', label: 'Landing', summary: 'Hero and how-it-works draft per direction.' },
  {
    slug: 'compare',
    label: 'Compare',
    summary: 'B, B2 and B3 side by side: palette, type, buttons, evidence card, logo, hero.',
  },
] as const;

export function directionById(id: DirectionId): Direction {
  const direction = DIRECTIONS.find((candidate) => candidate.id === id);
  if (direction === undefined) throw new Error(`Unknown direction ${id}`);
  return direction;
}
