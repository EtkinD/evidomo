---
name: evidomo-theme
description: Evidomo's UI theme and styling conventions — the daisyUI-first choice order, the evidomo-light/evidomo-dark theme tokens and their intended use, component recipes, the contrast check, and the log of the user's design decisions. Use before any UI or styling change in apps/web, and whenever the user gives design feedback (record it here).
---

# Evidomo theme

This skill is the living design system of the web app. The user's UI feedback is recorded in the **Design decisions** log below and then applied to the theme tokens, rules, and recipes, so the site's look converges on what the user wants. Keep it current: a rule nobody follows, or a recipe the code no longer uses, gets fixed or removed.

## 1. Choice order: daisyUI → Tailwind → raw CSS

1. **daisyUI component or modifier.** `btn btn-primary`, `card`, `fieldset`, `input input-error`, `alert alert-error`, `badge`, `navbar`, `loading loading-spinner`. Look for a modifier before composing utilities (`btn-sm`, `btn-ghost`, `card-border`).
2. **Tailwind utilities** for layout and spacing that daisyUI does not cover: `flex`, `gap-4`, `px-4`, `max-w-sm`, `sm:items-center`, `truncate`.
3. **Raw CSS** only when neither can express it. It goes in `apps/web/src/styles/globals.css` as an `@utility` or `@layer components` rule, with a comment saying why. Never in component files, `style` props, or CSS modules.

When a pattern repeats, add a recipe here first; do not invent a parallel component library.

## 2. Themes and tokens

Both themes are defined with `@plugin "daisyui/theme"` in `globals.css`. Built-in daisyUI themes are disabled (`themes: false`).

| Theme           | When it applies                                                     |
| --------------- | ------------------------------------------------------------------- |
| `evidomo-light` | default                                                             |
| `evidomo-dark`  | `data-theme="evidomo-dark"`, or system dark mode with no data-theme |

Tailwind's `dark:` variant follows the same rule (`@custom-variant dark` in `globals.css`). Tokens already switch with the theme, so `dark:` is a rare escape hatch, not a styling tool.

### Colour roles

The palette is Hearth Clay: warm linen surfaces, a clay primary, a sage secondary, a honey accent (chosen 2026-10-30, see the log). The living reference with measured contrast is the dev-only `/showcase/colors`.

| Token                                | Look (light / dark)                                                  | Use for                                                                    | As text on base?         |
| ------------------------------------ | -------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------ |
| `base-100` / `base-200` / `base-300` | linen white / warm cream / sand; dark: warm brown-black, three steps | surfaces: cards and inputs / page background / borders                     | —                        |
| `base-content`                       | dark warm brown / warm off-white                                     | body text; `/70` for secondary text, never lower (`/60` fails AA in light) | yes                      |
| `primary`                            | clay terracotta / lighter clay                                       | the one main action per view, links, focus                                 | yes                      |
| `secondary`                          | sage green / lighter sage                                            | secondary emphasis (selected states, secondary actions, "needs review")    | yes                      |
| `accent`                             | honey / honey                                                        | highlight backgrounds (evidence markers, "new" chips)                      | **no** — background only |
| `neutral`                            | warm dark brown / dim warm brown                                     | dark UI chrome (tooltips, dark badges)                                     | —                        |
| `info` / `success` / `error`         | muted blue / green / brick red                                       | status: run progress, verified facts, conflicts and errors                 | yes                      |
| `warning`                            | amber                                                                | warning backgrounds (`alert-warning`, `badge-warning`)                     | **no** — background only |
| `*-content`                          | near-white (or dark on the light fills)                              | text on the matching filled colour                                         | only on its colour       |

Shape and density tokens: `--radius-selector` / `--radius-field` 0.5rem, `--radius-box` 0.875rem (sharp, editorial corners), `--border` 1px, `--depth` 0 (flat; no daisyUI depth shadows), `--noise` 0. Change these in the theme, not per component.

### Fonts

`next/font/google` in `pages/_app.tsx` self-hosts Source Sans 3 (`--font-source-sans`) and Newsreader (`--font-newsreader`) and puts the variables on the app root. `globals.css` maps them with `@theme inline`: `font-sans` (Source Sans 3, the body face, set on the root) and `font-display` (Newsreader). `h1`–`h4` and `.card-title` take Newsreader through one base rule, so components carry no font class; use `font-display` only for display text that is not a heading (a wordmark, a big figure), and `font-mono` for IDs. Source Sans 3 has no italic loaded, so italics are synthesised: use them sparingly.

## 3. Rules

- Colours only through tokens. No Tailwind palette colours (`text-red-600`), arbitrary colours (`bg-[#0f766e]`), hex or rgb in components, or inline `style` colours.
- One `btn-primary` per view. Other actions use `btn`, `btn-ghost`, or `btn-outline`.
- Status is never colour alone: pair it with an icon or text (accessibility, and the evidence UI depends on it).
- Mobile first: base classes target phone width, `sm:`/`md:` add the larger layouts. Touch targets are at least 44 px (`min-h-11`): add it to every `btn`, including `btn-sm`, and make a text link `inline-flex min-h-11 items-center`.
- Server and client errors on a field: `input-error` on the input, `aria-invalid`, and a `text-sm text-error` message linked with `aria-describedby`. daisyUI's `validator` / `validator-hint` react only to native constraint validation, so use them for pure client constraints, not for API errors.
- Disabled buttons keep a readable label: `globals.css` holds the label at `base-content/70` (about 5.2:1 light, 7.1:1 dark; daisyUI's own dimming is 1.5:1). Never hide state in a disabled control: say why next to it ("Save your changes first."), and use a badge plus text, not a disabled button, for a feature that does not exist yet.
- Every token pair used for text must pass WCAG AA (4.5:1). Run the contrast check after any token change.

## 4. Recipes

These match the code as it is. Prefer them over new markup.

```tsx
// Page section on the app background, content in a card
<main className="flex-1 bg-base-200 px-4 py-8">
  <section className="card mx-auto max-w-3xl bg-base-100 shadow-sm">
    <div className="card-body gap-6">
      <h1 className="card-title text-2xl">Projects</h1>
      <p className="text-base-content/70">…</p>
    </div>
  </section>
</main>

// Primary action with a pending state
<button type="submit" className="btn btn-primary w-full" disabled={isPending}>
  {isPending && <span className="loading loading-spinner loading-sm" aria-hidden />}
  Log in
</button>

// Form-level error
<div role="alert" className="alert alert-error">
  <span>Email or password is incorrect.</span>
</div>

// Field with title, helper text, and error (daisyUI fieldset)
<fieldset className="fieldset">
  <label htmlFor={id} className="fieldset-legend">Email</label>
  <input id={id} className={`input w-full ${invalid ? 'input-error' : ''}`} aria-invalid={invalid}
    aria-describedby={invalid ? errorId : undefined} />
  {invalid && <p id={errorId} className="text-sm text-error">{message}</p>}
</fieldset>
```

Shared building blocks (P4B-06), use them instead of re-creating the pattern:

- **Page states:** `components/PageStates.tsx` (`LoadingBlock`, `LoadError`; a 401 links to log in with `next`) for project and capture screens; the run, gate, and pack screens use `LoadingState`, `SessionExpiredState`, `LoadErrorState`, and `RunNotFound` from `components/RunMonitor.tsx`.
- **Run status:** `components/RunStatusBadge.tsx` (text plus icon, never colour alone); step names from `lib/step-labels.ts`.
- **Demo screens (P4-09):** `components/demo/` (`DemoBanner` on every demo page, `ReplayControls`, `DemoRunFrame`); the run screens read `useRunSource()` (`lib/run-source.tsx`) and a demo never renders a write control (absent, not disabled).
- **Whole-card link:** the card title is the link (`min-h-11`) with `after:absolute after:inset-0` on a `relative` card; any other action in the card gets `relative z-10`.

## 5. Helpers

- **Showcase (dev only).** `/showcase` on the dev server (port 3000) renders the approved language with the product theme: palette with contrast, type scale, logo H-LOGO-1, components, the four approved images, and sample pages (`/showcase/samples/*`). Specimens carry stable `H-` IDs for feedback. Check a theme or component change there in both modes. The routes are `src/pages/showcase/*.dev.mts` and do not exist in production builds.
- **Contrast check.** `node .claude/skills/evidomo-theme/scripts/check-contrast.ts` reads both themes from `globals.css` and checks base text (solid and at `/70`) on every surface, every `*-content` on its colour, and the text roles from the table above on every surface. It exits 1 below 4.5:1.

## 6. Recording design feedback

When the user comments on the look or feel:

1. Add a dated entry to the log below, in the user's terms, with what it changes.
2. Apply it at the lowest level that covers it: a theme token first, then a rule or recipe here, then the component.
3. Run the contrast check and the web tests, and take light and dark screenshots of the affected screens for the user. Save them without opening them; `media-inspector` reviews downscaled copies (see `task-protocol`, Images and screenshots).

## Design decisions

- **2026-10-28 — daisyUI-first.** Component and style choice follows daisyUI → Tailwind → raw CSS. Light and dark looks are daisyUI custom themes (`evidomo-light` default, `evidomo-dark` for dark preference), not per-component overrides.
- **2026-10-28 — Seed palette (awaiting the user's review).** Calm and trustworthy for a real estate tool: teal primary (hue ~200), slate-blue secondary, amber accent for highlights, cool-grey surfaces, flat surfaces (`--depth: 0`), 0.5rem fields and 0.75rem boxes. Every text pair is at least 5:1. The earlier `text-error-strong` CSS utility was removed because the theme's `error` token now passes AA as text.
- **2026-10-29 — Disabled controls (review of P4-02).** A disabled `btn` rendered at 1.5:1, unreadable on "Start run" and "Save details". `globals.css` now keeps disabled button labels at `base-content/70`; "coming soon" features are a `badge badge-outline` plus text, not a disabled button.
- **2026-10-30 — Touch targets (review of P4-06).** Actions on the Gate 1 screen were `btn-sm` (32 px) and "Back to run" a 20 px text link, too small for a phone at a property. The rule is now 44 px (`min-h-11`) for buttons and links; no token changed. Evidence cards also gained an outlined Play button with an icon (a plain text control did not read as a button), and a compact comparison row of all values at the top of each conflict on mobile.
- **2026-10-30 — Phase 4b: the design language is chosen in a showcase.** The founder had not seen a designed site yet. Three directions are presented in a dev-only `/showcase` (palettes, typography, logo, UI elements, imagery and landing drafts); only what the founder approves there enters the theme and this log. The logo is explored with Muse Image (tools off) and finished as SVG. The seed palette above stays in force until then.
- **2026-10-30 — Showcase round 1: B Hearth preferred, not yet chosen.** The founder liked B Hearth in every area: colours B-COL-1/2 (light and dark), typography B-TYPE-1/2, logos B-LOGO-* and B-SVG-*, the B components, images B-HERO-1, B-INT-1/2, B-ILL-1/2, and landing B-LAND-1. A Ledger and C Signal are dropped. Before choosing, the founder wants two variants derived from Hearth to compare against it (round 2); the product theme stays the seed palette until the choice.
- **2026-10-30 — Showcase round 2: a combination to try.** Colours from B2 Hearth Clay (light and dark), typography from B3 Hearth Canal (Newsreader + Source Sans 3), components with B3's sharper shapes ("I liked its sharp structure"), logo candidates B3-LOGO-2 (Muse concept) and B-SVG-2, images B2-HERO-1, B2-INT-1/2, B2-ILL-1. Not final: the founder reviews this combination in sample pages and sections (round 3) and gives small refinements before P4B-02.
- **2026-10-30 — Design language chosen (showcase round 3).** The founder approved the combination as a whole ("all pages are quite good"): B2 Hearth Clay colours (light and dark), B3 Hearth Canal typography (Newsreader display + Source Sans 3 body) and sharper shapes (radius 0.5 / 0.5 / 0.875 rem), logo H-LOGO-1 (the B-SVG-2 roof, window, and check mark in the new colours, with a Newsreader "Evidomo" wordmark), and images B2-HERO-1, B2-INT-1/2, B2-ILL-1. This replaces the seed palette. The showcase keeps only these approved elements as the living reference. Run costs are an operator concern: they show in development only, never to agents in production (see `docs/architecture.md`).
- **2026-10-30 — Redesign round 1: "The annotated dossier" (awaiting the founder's review).** The founder found the site template-like (the "For independent estate agents" badge, centred hero, three equal cards). The structure now borrows from an annotated property file: asymmetric 12-column compositions, oversized Newsreader headlines with real footnote markers, margin notes tied to the photo by citation lines, ruled ledger rows instead of cards, paper-like sheets with layered shadows and a grain texture, a masthead header with a double rule, and a colophon footer. Palette, fonts, logo, and images are unchanged. Motion is one hero sequence (headline lines rise, the print settles, citation lines draw, notes arrive), scroll-painted claim highlights, and hover lift; every animation lives inside `prefers-reduced-motion: no-preference`, so reduced motion renders the final state. Added tokens/utilities in `globals.css`: `shadow-sheet` / `shadow-lift`, `.grain` (noise mask in `base-content`), `.rule-double`, `.claim`, `.leader`, and the motion classes. The projects list is the first app screen in this language (folders with a market tab). Newsreader now loads its italic and optical-size axis.
