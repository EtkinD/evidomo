# Concept: The audited page (redesign round 5)

Status: partly superseded. The founder approved this direction on 2026-10-31. After reviewing
the build on 2026-11-01, they found the landing too crowded ("too much text, too many underlined
phrases"). The landing went back to its earlier structure, shortened, with a light Show sources
switch that marks six claims. The specimen, ledger, numbers, and boundaries moved to the
`/method` detail page. The work-screen notes and stamps, and the demo entry, shipped as
described. The `evidomo-theme` decision log records what is current.

Built on branch `wip/redesign` and reviewed in rounds before merging. Brand, palette (Hearth Clay), type (Newsreader + Source Sans 3), logo
H-LOGO-1, and the annotated-dossier language stay; see the `evidomo-theme` skill. This document
decides what that language leaves open for the landing page, the demo entry, and status display.

## Job

- **Visitors.** (1) Hackathon judges: desktop, a few minutes, evaluating what it is, whether it
  works, and whether it is honest. (2) Independent estate agents: sceptical, often on a phone,
  some at a property; they want proof that the pack does not invent things and that they stay in
  charge. (3) Returning agents: they go straight to their projects; the landing is not for them.
- **The one thing.** See a finished run and believe that every claim in it has a source. The
  sample run is the strongest asset we have; the landing leads to it.
- **Content available.** The sample run (synthetic three-room apartment, Netherlands profile,
  English output: 11 synthetic photos in `fixtures/samples/synthetic-interiors/`, a Dutch
  walkthrough transcript, a fact form with two planted conflicts, the approved copy with
  evidence, staged images, the exported pack). The seeded-defect eval results and their limits
  (README "Eval results", `docs/model-notes.md` P5-01). The product's hard boundaries and privacy
  rules (`docs/product.md` §8–9). The approved brand images.
- **Missing, and not faked.** Customer quotes, client logos, usage numbers, pricing.
- **Constraints.** Pages Router, Tailwind 4 + daisyUI 5 with the `evidomo-light`/`evidomo-dark`
  themes, use-intl with five locales (en, tr, nl, it, es), 44 px targets, WCAG 2.2 AA, reduced
  motion respected, no new dependencies, feature freeze CP4 (Nov 3, 12:00 ET).

## Concepts considered

1. **The audited page** (spec sheet + specimen): the product's principle applied to its own
   landing page. Every claim on the page has a source, and the visitor can turn the sources on.
2. **The life of a file** (narrative scroll): one property from walkthrough to pack, chapter by
   chapter, a folder that grows thicker as you scroll.
3. **The file on the desk** (tool first): the landing is the demo; the visitor resolves a
   conflict and watches the pack assemble.

Discarded as closest to the default: **2**, because a scroll-told "how it works" is the most
common SaaS move after the landing sequence, and the current page already is a three-step story.
Not chosen: **3**, because demos never render write controls (a simulated decision blurs that
rule) and its scope does not fit before the freeze. Its live-evidence idea survives, read-only, in
concept 1's first screen.
Chosen: **1**.

## Architecture

Spec sheet led by a specimen. First screen: the headline and one real sentence from the sample
run whose claims open their evidence.

| #   | Section                       | Purpose (for the visitor)                                     | Content                                                                                                                                                                                                                                                | Layout idea                                                                                                                                                                                                                        |
| --- | ----------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | Masthead                      | Orientation, account, the sources switch                      | Logo, Demo, Log in, Create account, **Show sources**                                                                                                                                                                                                   | Existing double-ruled masthead; the switch sits at the right end on desktop                                                                                                                                                        |
| 1   | The specimen                  | Understand the product in one look and try it                 | Headline (keep "Every claim in your listing, linked to its evidence."), one or two sentences from the sample run's approved portal copy with their claims highlighted, the evidence of the selected claim, one action **Open the sample file**         | A spread: the sentence set large in Newsreader across 8 columns, the evidence in the margin column (photo crop with the region outlined, the Dutch voice turn with its timestamp, the form field); the first claim is open on load |
| 2   | What happened to this listing | Show the process with real facts, and where the agent decides | The sample run's steps as ledger lines: what the step did in _this_ run (11 photos read, 2 conflicts found: build year 1986 vs 1987 and VvE 175 vs 165, n claims flagged and resolved, staged images kept or refused) and who decided (Evidomo or you) | One ruled ledger (number, step, what happened, decided by), the two gate lines set heavier with "The run stops here"                                                                                                               |
| 3   | The numbers, and their limits | Evidence that the mechanism works, stated honestly            | The eval table from the README (date, fixture mode, six synthetic sets) and its limits                                                                                                                                                                 | A ruled table on the left, the limits as margin notes on the right; no big-number row                                                                                                                                              |
| 4   | What it will not do           | Trust through boundaries                                      | Hard boundaries (no valuation, no legal interpretation, no buyer screening, no auto-publishing, no structure-altering edits) and what it removes (GPS and metadata at upload, faces and plates in exports, everything on project deletion)             | A plain numbered list in a narrow column, like the closing clauses of a file                                                                                                                                                       |
| 5   | Colophon                      | Close usefully                                                | Open the sample file, repository, built during the hackathon, language, theme                                                                                                                                                                          | Existing colophon footer; no CTA band                                                                                                                                                                                              |

Deliberately left out: the three equal step rows, the 2×2 trust cards, the "Ready for your next
listing?" band, the separate "Every claim has a source" demo section (merged into the specimen),
three buttons under the headline.

## The bold move: Show sources

A persistent switch, **Show sources**, in the masthead (desktop) and in a sticky bottom bar
(mobile, next to **Open the sample file**). When it is on, every factual claim on the landing page
is marked like a claim in a pack: a honey highlight, a footnote number, and a margin note naming
its source.

- **Source types** (each note says which): _Sample run_ (links to the demo screen where it is
  visible), _Eval report_ (date, mode; links to the README section on GitHub until round 6 adds
  `/method`), _Enforced in code_ (the file that enforces it, on GitHub), _Product rule_
  (`docs/product.md` section on GitHub).
- **No source, no sentence.** A claim on the page that cannot be given a source is rewritten or
  removed. This is the page's contract, not decoration.
- **State.** Off by default except in the specimen, whose claims are always annotated. The choice
  is remembered per viewer (`localStorage`, wrapped in try/catch, page works without it) and can
  be shared with `?sources=on`. It is a real toggle button (`aria-pressed`), keyboard operable,
  44 px.
- **Mobile.** Notes appear inline under their paragraph, numbered, instead of in a margin.
- **Motion.** Highlights paint left to right and notes slide in from the margin with a short
  stagger, inside `prefers-reduced-motion: no-preference`; otherwise they appear at once.

Why it belongs to Evidomo: the product's promise is "the listing pack that can't make things up".
The landing page makes the same promise about itself and lets the visitor check it.

## Visual system

- **Idea:** the annotated property file (unchanged), now with the claim audit as the page's own
  apparatus.
- **Type, colour, grid, shape:** unchanged tokens. Section numbers set like file sections
  (`§ 2`) in the margin column. Honey (`accent`) stays background only.
- **Imagery:** the specimen and the ledger use the sample run's own synthetic photos (web copies
  in `apps/web/public/images/sample-run/`, sized and lazy-loaded, captioned "Sample run,
  synthetic photo"). The approved brand images remain for atmosphere where they are not evidence
  (open point below).
- **Components:** daisyUI where it fits (`btn`, toggle semantics, `table` themed); custom
  Tailwind components for the specimen, the margin notes, and the ledger; plain CSS in
  `globals.css` only for the highlight paint and the note entrance.

## Work screens in the same system

- **Notes instead of alerts.** The `alert-info` / `alert-success` / `alert-warning` boxes (11
  components, bright blue and green against the clay palette) become one dossier note component:
  a left rule in the status colour, an icon, text on the sheet or desk surface. `alert-error`
  usages that are failures already follow the failure-note recipe; align them with it.
- **Stamps for evidence states.** Verified, Needs your decision, Kept, Removed, Virtually staged,
  and Sample file read as ink stamps (outlined, small caps, letter-spaced; never colour alone).
  Run status badges may stay badges if stamps would crowd the ledger; decide by the screen.
- **Demo banner becomes a running head:** a thin ruled line at the top of the sheet: "Sample file:
  a replay of a synthetic run. Nothing you do here is saved."
- **Demo entry.** `/demo` opens the sample file directly when there is one demo run (a list only
  when there are several): a cover sheet (property, market, language, finished date) and folder
  tabs that persist on every demo screen (Walkthrough, Conflicts, Review, Pack), each with one
  line on what happened there in this run.

## Default-pattern review

| Pattern                          | Used?           | Justification or replacement                                                                 |
| -------------------------------- | --------------- | -------------------------------------------------------------------------------------------- |
| DP-01 Landing sequence           | No              | Specimen → this run's ledger → numbers → boundaries → colophon                               |
| DP-02 Full-width bands           | No              | Spread, ledger, table with margin notes, narrow list: containers differ by content           |
| DP-03 Section header formula     | No              | Headings in the margin column with file section numbers                                      |
| DP-04 CTA band                   | No              | The one action stays reachable (masthead, mobile bottom bar, colophon)                       |
| DP-05 FAQ                        | No              | —                                                                                            |
| DP-10 Badge above headline       | No              | —                                                                                            |
| DP-11 Two buttons under headline | No              | One action, Open the sample file; accounts live in the masthead                              |
| DP-12 Split hero                 | No              | The sentence dominates; the photo is evidence in the margin                                  |
| DP-14 Stats row                  | Yes, as a table | The eval numbers are real, dated, reproducible (`npm run eval`), and shown with their limits |
| DP-20 Equal icon cards           | No              | Ledger lines and a numbered list                                                             |
| DP-21 Soft cards everywhere      | No              | Rules and the sheet surface group content                                                    |
| DP-30 Indigo gradient            | No              | Hearth Clay                                                                                  |
| DP-31 Default type               | No              | Newsreader + Source Sans 3                                                                   |
| DP-36 Unthemed library           | Fixed           | daisyUI alerts replaced by the note component                                                |
| DP-40 Empty headline vocabulary  | No              | Existing headline states the product                                                         |
| DP-41 Generic button labels      | No              | "Open the sample file"                                                                       |
| DP-50 Fade-up everywhere         | No              | Motion only for the sources switch and the existing hero sequence                            |

## Open points for the founder

- The approved hero image (B2-HERO-1) is illustrative, not from the sample run. In the specimen
  the evidence must be real, so the run's own photo takes that place. Keep B2-HERO-1 elsewhere
  (ledger, Open Graph) or retire it from the landing?
- The sample sentence is model output in English and is not translated (UI rule); the five
  locales translate everything around it. The Dutch voice turn is quoted as spoken.
- Round 6 adds `/method` and `/privacy`; the source notes then point there instead of GitHub.
