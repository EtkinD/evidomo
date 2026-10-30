# Evidomo brand files

Static brand assets for the web app (`apps/web/public`). Chosen design: H-LOGO-1, a clay roof over a
sage window with a check mark, with an "Evidomo" wordmark in Newsreader.

| File                                                   | Use                                                                            |
| ------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `brand/evidomo-mark.svg`                               | Mark only, light colours. The HTML pack inlines it.                            |
| `brand/evidomo-lockup-light.svg` / `-dark.svg`         | Mark and wordmark for light and dark backgrounds (transparent).                |
| `favicon.svg`                                          | Browser tab icon; switches colours with `prefers-color-scheme`.                |
| `favicon.ico`                                          | 16 and 32 px fallback on a rounded light tile (an ICO cannot adapt).           |
| `apple-touch-icon.png`, `icon-192.png`, `icon-512.png` | Home-screen icons on the light `base-200` tile.                                |
| `icon-maskable-512.png`                                | Maskable icon; the mark stays inside the 40 % safe-zone circle.                |
| `site.webmanifest`                                     | Name, icons, `theme_color` (`base-100`) and `background_color` (`base-200`).   |
| `og.png`                                               | 1200 x 630 Open Graph image: lockup and the tagline "Evidence for every home." |

In the app, `src/components/brand/Logo.tsx` draws the same geometry with theme tokens and live
Newsreader text. Static files cannot load fonts, so their text is outlined paths.

## Provenance

- The wordmark and tagline outlines come from **Newsreader** (Production Type), licensed under the
  **SIL Open Font License 1.1**. Outlines of the logo text are generated for this logo; the font file
  is not committed.
- Wordmark: weight 700, optical size 16 (what the app's live text uses), kerning on, letter-spacing
  -0.025 em (Tailwind `tracking-tight`). Tagline: weight 400, no tracking.
- Colours are the hex values of the `evidomo-light` / `evidomo-dark` oklch tokens in
  `src/styles/globals.css` (`base-100`, `base-200`, `base-content`, `primary`, `secondary`,
  `secondary-content`). When a token changes, update the constants in `scripts/brand-assets.mjs`,
  `site.webmanifest`, and the `theme-color` tags in `src/pages/_document.tsx`.

## How the files are made

1. Outline the text once (outside the repository, nothing downloaded is committed):

   ```sh
   S=$(mktemp -d)
   curl -sL -o "$S/Newsreader.ttf" 'https://raw.githubusercontent.com/google/fonts/main/ofl/newsreader/Newsreader%5Bopsz,wght%5D.ttf'
   uvx --from fonttools --with uharfbuzz python apps/web/scripts/brand-wordmark-outline.py \
     "$S/Newsreader.ttf" "$S/instance.ttf" > "$S/runs.json"
   ```

   The `d` strings of `wordmark` and `tagline` in the JSON are the `WORDMARK` and `TAGLINE`
   constants in `apps/web/scripts/brand-assets.mjs`.

2. Generate every file in this directory from the repository root (uses the installed `sharp`):

   ```sh
   node apps/web/scripts/brand-assets.mjs
   ```

   The output is deterministic; rerunning it rewrites the same files.
