import type { ShowcaseDirection, ShowcaseImageSpec } from './showcase-images.ts';

// Prompt list for the Phase 4b design showcase (P4B-01). Exploration only: nothing generated from
// it is committed. Every prompt is composed with its kind's style line, the direction's palette,
// and SHOWCASE_CONSTRAINTS (showcase-images.ts), so each subject below describes content only.
// Round 2: the founder kept B "Hearth" (A and C are dropped); B2 and B3 are variants of it. B's
// specs must stay byte-identical, or the generator would regenerate the images already approved.

export const SHOWCASE_DIRECTIONS: readonly ShowcaseDirection[] = [
  {
    id: 'B',
    name: 'Hearth',
    mood: 'warm home',
    palette:
      'Palette: terracotta and brick red (#B5523B), warm cream (#F4ECDF), and deep green (#1F4D3A). ' +
      'Mood: warm, welcoming, and premium Dutch real estate; brick, oak, and soft daylight.',
  },
  {
    id: 'B2',
    name: 'Hearth Clay',
    mood: 'soft, airy home',
    palette:
      'Palette: linen and oat (#F5EFE4, #E7DCC8), light clay terracotta (#C98466), sage and olive ' +
      'green (#8C9C7A, #5F6B46), and a honey accent (#D9A548). Mood: soft, light, and airy Dutch ' +
      'home; linen, pale oak, plants, soft shadows, and gentle morning light.',
  },
  {
    id: 'B3',
    name: 'Hearth Canal',
    mood: 'deep, grounded editorial',
    palette:
      'Palette: deep brick and crimson red (#8C2D27), deep canal-water teal green (#1D4A4A), a ' +
      'brass accent (#B08A4E), and warm ivory (#EFE6D6). Mood: deep, grounded, and editorial ' +
      'Dutch canal house; brick, dark oak, brass details, and low late-afternoon to evening light.',
  },
];

export const SHOWCASE_IMAGES: readonly ShowcaseImageSpec[] = [
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

  // B2 "Hearth Clay": the liked B subjects (B-LOGO-3, B-LOGO-2, B-HERO-1, B-INT-1/2, B-ILL-1/2)
  // with only mood, palette, and light moved, so the founder compares variants of one idea.
  {
    direction: 'B2',
    kind: 'logo-concept',
    subject:
      'A soft rounded house shape with a single sage leaf shape in its centre, like a hearth, ' +
      'built from two overlapping flat shapes, light and airy.',
  },
  {
    direction: 'B2',
    kind: 'logo-concept',
    subject:
      'A round magnifying glass with a thin, light ring whose lens contains a simple rounded ' +
      'house with a pitched roof.',
  },
  {
    direction: 'B2',
    kind: 'hero',
    subject:
      'A light, airy, empty, high-ceilinged Dutch canal-house living room with a pale limewashed ' +
      'brick wall, wide pale oak floorboards, tall white sash windows with sheer linen curtains ' +
      'and soft morning sunlight, an oat linen sofa, a sage green armchair, and a large leafy ' +
      'plant in a clay pot. Wide architectural interior photograph.',
  },
  {
    direction: 'B2',
    kind: 'hero',
    subject:
      'A bright, empty window bay in a high-ceilinged Dutch canal-house living room: tall white ' +
      'sash windows with sheer linen curtains, a pale oak window seat with oat linen cushions, a ' +
      'few potted plants, and long soft morning shadows on a pale oak floor. Only soft, ' +
      'out-of-focus greenery is visible outside. Wide architectural interior photograph.',
  },
  {
    direction: 'B2',
    kind: 'interior',
    subject:
      'Close-up detail of a pale oak herringbone floor meeting light clay terracotta kitchen ' +
      'floor tiles, with a soft stripe of morning sunlight and a gentle leaf shadow falling ' +
      'across it. Shallow depth of field.',
  },
  {
    direction: 'B2',
    kind: 'interior',
    subject:
      'Close-up detail of a pale limewashed brick fireplace surround with a simple pale oak ' +
      'mantel, a linen-white wall, a small trailing plant in a ceramic pot on the mantel, and a ' +
      'few birch logs, in soft morning daylight.',
  },
  {
    direction: 'B2',
    kind: 'illustration',
    subject:
      'Empty-state illustration: a cosy rounded house with its front door open, soft honey ' +
      'morning light spilling out onto the step, and a small sage green potted plant beside the ' +
      'door, light and airy.',
  },
  {
    direction: 'B2',
    kind: 'illustration',
    subject:
      'Empty-state illustration: a simple rounded camera floating in front of an open window ' +
      'frame with a sheer linen curtain, with a few soft circles of morning light around it, ' +
      'suggesting adding photos.',
  },

  // B3 "Hearth Canal": the liked B subjects (B-LOGO-1, B-LOGO-4, B-HERO-1, B-INT-1/2, B-ILL-1/2)
  // with only mood, palette, and light moved.
  {
    direction: 'B3',
    kind: 'logo-concept',
    subject:
      'A stylised tall stepped canal-house gable silhouette in deep brick red with a small brass ' +
      'check mark forming the arched doorway.',
  },
  {
    direction: 'B3',
    kind: 'logo-concept',
    subject:
      'An abstract emblem: a curved roof arc that wraps around a short horizontal bar, evoking a ' +
      'lowercase e without being a typeface letter, in brass inside a deep teal green rounded ' +
      'square tile.',
  },
  {
    direction: 'B3',
    kind: 'hero',
    subject:
      'A deep, grounded, empty, high-ceilinged Dutch canal-house living room with an exposed deep ' +
      'red brick wall, wide dark oak floorboards, tall canal-house windows with dark painted ' +
      'frames letting in low golden late-afternoon light, a deep crimson velvet sofa, a deep teal ' +
      'green armchair, and a brass floor lamp. Wide editorial architectural interior photograph.',
  },
  {
    direction: 'B3',
    kind: 'hero',
    subject:
      'An empty, tall canal-house window bay in early evening: a dark oak window seat, deep teal ' +
      'green painted wall panelling, brass window fittings, and warm lamplight inside; only ' +
      'soft, out-of-focus trees and canal water are visible outside. Wide editorial ' +
      'architectural interior photograph.',
  },
  {
    direction: 'B3',
    kind: 'interior',
    subject:
      'Close-up detail of a dark oak herringbone floor meeting deep red terracotta kitchen floor ' +
      'tiles, with a low golden stripe of late-afternoon sunlight falling across it. Shallow ' +
      'depth of field.',
  },
  {
    direction: 'B3',
    kind: 'interior',
    subject:
      'Close-up detail of a deep red brick fireplace surround with a dark oak mantel, a brass ' +
      'candle holder, a deep teal green wall, and a stack of firewood, in warm early-evening light.',
  },
  {
    direction: 'B3',
    kind: 'illustration',
    subject:
      'Empty-state illustration: a tall narrow canal house with a stepped gable and its front ' +
      'door open, warm brass-gold evening light spilling out onto the step, and a small potted ' +
      'plant beside the door.',
  },
  {
    direction: 'B3',
    kind: 'illustration',
    subject:
      'Empty-state illustration: a simple camera floating in front of a tall arched canal-house ' +
      'window frame at dusk, with a few warm circles of lamplight around it, suggesting adding ' +
      'photos.',
  },
];
