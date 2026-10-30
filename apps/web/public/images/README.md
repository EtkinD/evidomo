# Images

## `landing/`

Responsive WebP variants (640, 1280, 1920 px wide; the illustration 640, 1280, 1600) used by the
landing page. Built by `apps/web/scripts/build-landing-images.mjs` from four approved originals; metadata is
stripped.

| File prefix    | Showcase ID | Subject                                                     |
| -------------- | ----------- | ----------------------------------------------------------- |
| `hero`         | B2-HERO-1   | Canal-house living room                                     |
| `interior-1`   | B2-INT-1    | Oak herringbone floor meeting terracotta tiles              |
| `interior-2`   | B2-INT-2    | Limewashed brick fireplace with an oak mantel               |
| `illustration` | B2-ILL-1    | Flat illustration of a white house with an open yellow door |

Provenance: generated for Evidomo with Muse Image (tools off) on 2026-10-30, from prompts written
for this project. They are synthetic: no photograph of a real property, person, or sign, and no
third-party content. Regenerate the variants with
`node apps/web/scripts/build-landing-images.mjs <directory with the originals>`.
