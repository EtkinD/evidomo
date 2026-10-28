# Product Definition

Status: Draft — under founder review
Name: **Evidomo** — evidence for every home

## 1. Summary

Evidomo is a listing launch service for residential real estate agents. The agent captures raw property photos and a voice walkthrough on site, in their own language. The service turns them into a verified, publication-ready listing pack in the buyer's language — and every factual claim in that pack links to the evidence it came from.

**Positioning:** the listing pack that can't make things up.

The service runs on an Agent-as-a-Service architecture: the workflow is a declarative service definition (inputs, steps, rubric, human gates, outputs) executed by a generic run engine, and country-specific rules live in declarative market profiles. That architecture is how the product scales to new markets; it is not the pitch.

## 2. Users and niche

- **Who:** independent real estate agents and small offices (1–10 agents).
- **What:** residential resale listings (apartments, houses).
- **Out of scope:** commercial real estate, new-build/off-plan sales, rentals, property management.
- **Where:** a global product. Market-specific fields, units, and listing rules are encoded in market profiles. The MVP ships two: **International** (default) and **Netherlands**.

## 3. Problem

Preparing a single listing takes an agent roughly 2–4 hours: scattered phone photos, incomplete or contradictory property facts, listing copy that is exaggerated or unsupported, and the same content re-produced for each channel. Listings go live late, and buyers increasingly distrust what they read. International buyers add a language barrier on top.

## 4. User flow

1. **Capture** on site from a phone: take photos and record a voice walkthrough in the browser, or upload existing files.
2. **Confirm facts** in a structured form generated from the selected market profile (the form is the source of truth).
3. **Run** the service: transcription, fact extraction, photo inventory, fact reconciliation.
4. **Gate 1 — resolve conflicts.** Contradictions between sources stop the run until the agent decides.
5. **Generate and verify:** listing copy, buyer Q&A, virtual staging variants, structural integrity check, claim audit.
6. **Gate 2 — review.** The agent approves, edits, or removes every flagged claim and approves staged images.
7. **Export** the listing pack.

## 5. Inputs

| Input                | Requirement                                                                                                                                          |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Property photos      | 10–30 raw photos (JPEG/PNG/HEIC). Downscaled client-side; metadata (including GPS) stripped on upload.                                               |
| Voice walkthrough    | Up to 10 minutes, recorded in any language supported by Muse Voice Transcribe (25 languages, incl. Dutch and English). Converted to WAV server-side. |
| Structured fact form | Fields defined by the base property schema plus the market profile. Designated source of truth.                                                      |
| Office profile       | Agency name, logo, contact block, preferred tone.                                                                                                    |
| Output language      | Selectable per run (default from the market profile).                                                                                                |

## 6. Output: the Listing Pack

1. **Verified Fact Sheet** — the single source of truth for the property. Area values are stored as value + unit + measurement basis (e.g., gross vs. net, or a national standard), so differing bases are not mistaken for contradictions.
2. **Photo inventory and visual audit** — room/subject classification, cover-photo ranking, duplicate and low-quality flags, privacy items (faces, license plates) blurred in exports.
3. **Virtual staging variants** — labeled "Virtually staged", always shown next to the original, and passed through a structural integrity check. Scope depends on the Phase 1 feasibility result (fallback: decluttering and object removal only).
4. **Listing copy** — portal (long) and social (short) variants in the selected output language. Every factual claim is linked to its evidence.
5. **Buyer Q&A cards** — generated from verified facts only.
6. **Claim Audit report** — unsupported claims, promises, and exclusionary phrasing, each resolved by the agent before export.
7. **Publication checklist** — market-profile compliance items (e.g., energy label present, staging disclosed). It assists the agent; it does not certify legal compliance.
8. **Exports** — print-ready HTML pack (browser "Save as PDF") and structured portal-fields JSON.

## 7. Market profiles

A market profile is a declarative file that defines, for one market:

- fact schema extensions (market-specific fields and which are mandatory),
- units and accepted area measurement standards,
- the publication checklist,
- flagged and banned phrasing rules,
- source languages and the default output language.

Adding a market means adding a profile, not changing the pipeline.

### International (default)

- Area in m² or sq ft with an explicit measurement basis.
- Checklist: staging disclosed, no exclusionary language, no price-appreciation or investment promises.

### Netherlands (MVP country profile)

Items below are to be verified with a practicing Dutch agent before they are encoded:

- **Energy label (energielabel)** shown in the listing — required for advertisements under the EU Energy Performance of Buildings Directive.
- **Living area (woonoppervlakte)** measured per NEN 2580 / the BBMI measurement instruction; also volume (inhoud, m³), plot area (perceel), build year (bouwjaar).
- **Ownership specifics:** ground lease (erfpacht) status and terms; owners' association (VvE) monthly contribution.
- **Portal context:** Funda as the main portal; whether portal rules require a specific virtual-staging disclosure is to be confirmed.
- **Languages:** Dutch source materials; English default output for international buyers, Dutch optional.
- **Equal treatment:** exclusionary phrasing flagged; exact legal references to be confirmed.

### Later profiles (not in the MVP)

United States (fair housing advertising rules, MLS staging disclosure), United Kingdom (material information in listings), Turkey (electronic listing verification, EİDS), and other EU markets (energy performance indicator).

## 8. Hard boundaries

The service never:

- gives price valuations or investment advice,
- interprets law, drafts contracts, or advises on title,
- screens, scores, or ranks buyers or tenants,
- publishes to listing portals automatically,
- scrapes portal listings,
- produces visual edits that hide defects or alter a property's structure,
- uses demographic targeting language.

## 9. Data, privacy, and trust

- Meta Model API is used in **Standard mode only** (customer content is not used for model training). Contributor-mode model variants are never used for customer data.
- Hosting is in the EU. Photos and voice recordings may contain personal data; the product applies data minimization: metadata/GPS stripped at upload, faces and plates blurred in exports, and project deletion hard-deletes all materials and artifacts.
- Sample and demo materials are used only with the written consent of the providing agent; exact addresses are removed.

## 10. MVP success criteria

- A real Dutch property — 15–30 photos and a 2–5 minute Dutch voice walkthrough — becomes a complete English listing pack in under 15 minutes of processing (human gate time excluded).
- 100% of factual claims carry valid evidence links (enforced in code, not by prompt).
- A seeded-defect evaluation set reports the catch rate for planted conflicts and unsupported claims; all planted defects on the demo property are caught.
- The staging integrity check passes valid edits and rejects a structure-altering edit (or the documented fallback is in place).
- Cost per run is measured, displayed, and capped (target: under $0.50).
- The product is live on a public HTTPS deployment, with a replayable demo run that needs no login.

## 11. Non-goals for the MVP

- Education features of any kind (courses, lessons, quizzes).
- A catalog of multiple services or a service-builder UI (definitions stay as files).
- Marketplace, payments, subscriptions.
- Native mobile apps (the web app is mobile-responsive instead).
- Portal integrations and auto-publishing; CRM and lead management.
- Multi-user office roles beyond a single operator account.
- Fine-tuning and self-hosted open-weight inference.

**Deferred to later versions:** floor plan processing, office style profile learned from corrections, premium copy variant, viewing talk track, short-video storyboard, channel-specific social captions.
