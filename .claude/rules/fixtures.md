---
paths:
  - 'fixtures/**'
---

# Fixtures (recorded API responses, sample projects, eval data)

- **New work only.** Fixtures contain synthetic or self-made material: model-generated interiors, TTS walkthroughs of invented scripts, invented facts. Never include raw property samples (`../samples/`), third-party photos (Pexels and other stock, even when licensed), or anything derived from them: cassettes, masks, staged images, exports.
- **No personal data:** no faces, plates, real addresses, names, or contact details. Use invented places and `example.invalid` / `example.test` contacts.
- **Cassettes are re-recorded, never hand-edited**, except for documented reuse of a byte-identical request.
- **Keys must not depend on our own re-encodes.** Re-encodes differ across platforms, so use the replay aliases (`docs/model-notes.md`, P3-10).
- **Remove what a re-recording orphans:** stale interactions and unreferenced `.files/` blobs.
- **Audio stays out:** large or derived audio (TTS walkthroughs) lives in the gitignored `data/`. Commit only the silent stand-ins replay needs.
