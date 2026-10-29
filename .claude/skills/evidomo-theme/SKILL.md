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

| Token                                | Use for                                                                    | As text on base?         |
| ------------------------------------ | -------------------------------------------------------------------------- | ------------------------ |
| `base-100` / `base-200` / `base-300` | surfaces: cards and inputs / page background / borders                     | —                        |
| `base-content`                       | body text; `/70` for secondary text, never lower (`/60` fails AA in light) | yes                      |
| `primary`                            | the one main action per view, links, focus                                 | yes                      |
| `secondary`                          | secondary emphasis (selected states, secondary actions)                    | yes                      |
| `accent`                             | highlight backgrounds (evidence markers, "new" chips)                      | **no** — background only |
| `neutral`                            | dark UI chrome (tooltips, dark badges)                                     | —                        |
| `info` / `success` / `error`         | status: run progress, verified facts, conflicts and errors                 | yes                      |
| `warning`                            | warning backgrounds (`alert-warning`, `badge-warning`)                     | **no** — background only |
| `*-content`                          | text on the matching filled colour                                         | only on its colour       |

Shape and density tokens: `--radius-field` / `--radius-selector` 0.5rem, `--radius-box` 0.75rem, `--border` 1px, `--depth` 0 (flat; no daisyUI depth shadows), `--noise` 0. Change these in the theme, not per component.

## 3. Rules

- Colours only through tokens. No Tailwind palette colours (`text-red-600`), arbitrary colours (`bg-[#0f766e]`), hex or rgb in components, or inline `style` colours.
- One `btn-primary` per view. Other actions use `btn`, `btn-ghost`, or `btn-outline`.
- Status is never colour alone: pair it with an icon or text (accessibility, and the evidence UI depends on it).
- Mobile first: base classes target phone width, `sm:`/`md:` add the larger layouts. Touch targets are at least 44 px (`min-h-11`): add it to every `btn`, including `btn-sm`, and make a text link `inline-flex min-h-11 items-center`.
- Server and client errors on a field: `input-error` on the input, `aria-invalid`, and a `text-sm text-error` message linked with `aria-describedby`. daisyUI's `validator` / `validator-hint` react only to native constraint validation, so use them for pure client constraints, not for API errors.
- Disabled buttons keep a readable label: `globals.css` holds the label at `base-content/70` (about 5.5:1 light, 6.3:1 dark; daisyUI's own dimming is 1.5:1). Never hide state in a disabled control: say why next to it ("Save your changes first."), and use a badge plus text, not a disabled button, for a feature that does not exist yet.
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

The auth form (P4-01) predates this skill and uses `label` + `flex flex-col gap-1` instead of `fieldset`. Move it to the fieldset recipe the next time it changes.

## 5. Helpers

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
