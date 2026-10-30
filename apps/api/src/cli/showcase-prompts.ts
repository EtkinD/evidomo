import type { ShowcaseDirection, ShowcaseImageSpec } from './showcase-images.ts';

// Prompt list for the Phase 4b design showcase (P4B-01). Exploration only: nothing generated from
// it is committed. Every prompt is composed with its kind's style line, the direction's palette,
// and SHOWCASE_CONSTRAINTS (showcase-images.ts), so each subject below describes content only.

export const SHOWCASE_DIRECTIONS: readonly ShowcaseDirection[] = [
  {
    id: 'A',
    name: 'Ledger',
    mood: 'calm trust',
    palette:
      'Palette: deep teal (#0F4C5C) and slate (#3E4C59) on cool light greys (#E9EDF0, #F6F7F8). ' +
      'Mood: calm, precise, and quiet; modern Dutch and Scandinavian minimalism.',
  },
  {
    id: 'B',
    name: 'Hearth',
    mood: 'warm home',
    palette:
      'Palette: terracotta and brick red (#B5523B), warm cream (#F4ECDF), and deep green (#1F4D3A). ' +
      'Mood: warm, welcoming, and premium Dutch real estate; brick, oak, and soft daylight.',
  },
  {
    id: 'C',
    name: 'Signal',
    mood: 'editorial evidence',
    palette:
      'Palette: ink navy and near-black (#0E1726, #151B23), signal amber (#F2A900), and ' +
      'verification green (#1E9E5A) on off-white (#F5F4F0). Mood: forensic, high-contrast, editorial.',
  },
];

export const SHOWCASE_IMAGES: readonly ShowcaseImageSpec[] = [
  // A "Ledger"
  {
    direction: 'A',
    kind: 'logo-concept',
    subject:
      'A minimal house roofline drawn as one continuous single-weight stroke whose right side ' +
      'continues into a check mark.',
  },
  {
    direction: 'A',
    kind: 'logo-concept',
    subject:
      'A simple rectangular document shape with a folded top corner, where the fold forms the ' +
      'pitched roof of a house.',
  },
  {
    direction: 'A',
    kind: 'logo-concept',
    subject:
      'A geometric location pin whose inner negative space is the silhouette of a small house ' +
      'with a pitched roof.',
  },
  {
    direction: 'A',
    kind: 'logo-concept',
    subject:
      'An abstract geometric emblem: a roof chevron above a short horizontal bar and an open ' +
      'circular arc, evoking a lowercase e without being a typeface letter.',
  },
  {
    direction: 'A',
    kind: 'hero',
    subject:
      'A bright, empty, minimalist Dutch apartment living room with pale grey walls, a light oak ' +
      'floor, a slim slate-grey sofa, one deep teal armchair, and a large window with soft ' +
      'overcast north light. Wide architectural interior photograph, eye-level.',
  },
  {
    direction: 'A',
    kind: 'hero',
    subject:
      'A generic, invented modern Dutch row of terraced houses with flat grey brick facades, ' +
      'large black-framed windows, and one deep teal front door, under a soft overcast sky. ' +
      'Architectural exterior photograph. No house numbers, street signs, or cars.',
  },
  {
    direction: 'A',
    kind: 'interior',
    subject:
      'Close-up detail of a minimalist kitchen: a pale grey stone worktop, a slate-grey tap, and ' +
      'a backsplash of matte deep teal rectangular tiles, in soft daylight. Shallow depth of field.',
  },
  {
    direction: 'A',
    kind: 'interior',
    subject:
      'Close-up detail of a tall white window frame with a slim metal handle, a cool grey wall, ' +
      'and a light oak windowsill with a single small ceramic vase, soft diffuse daylight.',
  },
  {
    direction: 'A',
    kind: 'illustration',
    subject:
      'Empty-state illustration: a simple outline of a house standing on a dotted path that ' +
      'leads towards it, with a small plus sign floating beside it, lots of calm empty space.',
  },
  {
    direction: 'A',
    kind: 'illustration',
    subject:
      'Empty-state illustration: a clipboard with three rows of plain grey bars and a check mark ' +
      'beside each row, resting next to a small potted plant.',
  },

  // B "Hearth"
  {
    direction: 'B',
    kind: 'logo-concept',
    subject:
      'A stylised stepped canal-house gable silhouette with a small check mark forming the ' +
      'arched doorway.',
  },
  {
    direction: 'B',
    kind: 'logo-concept',
    subject: 'A round magnifying glass whose lens contains a simple house with a pitched roof.',
  },
  {
    direction: 'B',
    kind: 'logo-concept',
    subject:
      'A soft rounded house shape with a single warm leaf or flame shape in its centre, like a ' +
      'hearth, built from two overlapping flat shapes.',
  },
  {
    direction: 'B',
    kind: 'logo-concept',
    subject:
      'An abstract emblem: a curved roof arc that wraps around a short horizontal bar, evoking a ' +
      'lowercase e without being a typeface letter, inside a rounded square tile.',
  },
  {
    direction: 'B',
    kind: 'hero',
    subject:
      'A warm, empty, high-ceilinged Dutch canal-house living room with an exposed red brick ' +
      'wall, wide oak floorboards, tall white sash windows with warm afternoon daylight, a cream ' +
      'linen sofa, and a deep green velvet armchair. Wide architectural interior photograph.',
  },
  {
    direction: 'B',
    kind: 'hero',
    subject:
      'An invented, generic narrow Dutch brick townhouse facade with a stepped gable, white ' +
      'window frames, a deep green front door, and a few potted plants, in warm late-afternoon ' +
      'light. Architectural exterior photograph. No house numbers, street signs, or cars.',
  },
  {
    direction: 'B',
    kind: 'interior',
    subject:
      'Close-up detail of a herringbone oak floor meeting terracotta-tiled kitchen flooring, with ' +
      'a warm stripe of sunlight falling across it. Shallow depth of field.',
  },
  {
    direction: 'B',
    kind: 'interior',
    subject:
      'Close-up detail of a red brick fireplace surround with a simple oak mantel, a cream wall, ' +
      'and a stack of firewood, in soft warm daylight.',
  },
  {
    direction: 'B',
    kind: 'illustration',
    subject:
      'Empty-state illustration: a cosy house with its front door open, warm light spilling out ' +
      'onto the step, and a small potted plant beside the door.',
  },
  {
    direction: 'B',
    kind: 'illustration',
    subject:
      'Empty-state illustration: a simple camera floating in front of an open window frame, with ' +
      'a few soft circles of light around it, suggesting adding photos.',
  },

  // C "Signal"
  {
    direction: 'C',
    kind: 'logo-concept',
    subject:
      'A bold geometric magnifying glass whose handle bends upward into a check mark, with the ' +
      'lens ring in ink navy and the check in signal amber.',
  },
  {
    direction: 'C',
    kind: 'logo-concept',
    subject:
      'A document shape with a folded corner and a bold verification-green check stamp ' +
      'overlapping its lower right edge.',
  },
  {
    direction: 'C',
    kind: 'logo-concept',
    subject:
      'A sharp geometric location pin with a house-shaped cut-out and a small signal amber dot ' +
      'above the roof.',
  },
  {
    direction: 'C',
    kind: 'logo-concept',
    subject:
      'A house roofline enclosed in four corner brackets like a camera focus frame or crosshair, ' +
      'heavy strokes, one amber accent.',
  },
  {
    direction: 'C',
    kind: 'hero',
    subject:
      'A dramatic, empty, modern living room with dark ink-navy walls, a polished concrete floor, ' +
      'a single low black sofa, and one amber floor lamp casting a warm pool of light at dusk. ' +
      'High-contrast editorial architectural photograph.',
  },
  {
    direction: 'C',
    kind: 'hero',
    subject:
      'An invented, generic modern Dutch house exterior at blue hour: dark brick and glass, ' +
      'one window glowing amber, crisp geometry, deep navy sky. High-contrast editorial ' +
      'architectural photograph. No house numbers, street signs, or cars.',
  },
  {
    direction: 'C',
    kind: 'interior',
    subject:
      'Close-up detail of a dark navy wall with a crisp white door frame edge and a single ' +
      'brass light switch, lit by a narrow beam of light. High-contrast, editorial.',
  },
  {
    direction: 'C',
    kind: 'interior',
    subject:
      'Close-up detail of a steel and oak staircase in a dark interior, with a thin amber light ' +
      'strip under the handrail. High-contrast editorial architectural photograph.',
  },
  {
    direction: 'C',
    kind: 'illustration',
    subject:
      'Empty-state illustration: a large magnifying glass hovering over a blank document that ' +
      'shows only plain grey bars, with a small amber spark at the lens edge.',
  },
  {
    direction: 'C',
    kind: 'illustration',
    subject:
      'Empty-state illustration: a neat stack of three blank documents with a large ' +
      'verification-green check mark badge on top.',
  },
];
