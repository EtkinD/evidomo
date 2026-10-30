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
    id: 'A',
    name: 'Ledger',
    tagline: 'Calm trust',
    mood: 'Deep teal and slate on cool greys. Precise, quiet, modern Dutch/Scandinavian: the product disappears and the evidence speaks.',
    fonts: { display: 'Inter', body: 'Inter', mono: 'IBM Plex Mono' },
  },
  {
    id: 'B',
    name: 'Hearth',
    tagline: 'Warm home',
    mood: 'Terracotta and brick, cream, deep green. Warm, premium Dutch real estate: it feels like the home the agent is selling.',
    fonts: { display: 'Fraunces', body: 'Source Sans 3', mono: 'System mono' },
  },
  {
    id: 'C',
    name: 'Signal',
    tagline: 'Editorial evidence',
    mood: 'Ink navy, signal amber, verification green. Forensic and high-contrast: every claim reads like a cited source.',
    fonts: { display: 'Space Grotesk', body: 'Inter', mono: 'JetBrains Mono' },
  },
];

export const SUB_PAGES = [
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
] as const;

export function directionById(id: DirectionId): Direction {
  const direction = DIRECTIONS.find((candidate) => candidate.id === id);
  if (direction === undefined) throw new Error(`Unknown direction ${id}`);
  return direction;
}
