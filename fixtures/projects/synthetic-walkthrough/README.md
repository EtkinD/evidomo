# Synthetic walkthrough (headless pipeline demo)

A pipeline project directory for `npm run pipeline` (format: docs/architecture.md §5,
"Headless pipeline CLI"). Everything here is synthetic: the photos are the model-generated
interiors in `fixtures/samples/synthetic-interiors/`, the street and town in the fact form are
invented (they match the fictional walkthrough script `fixtures/meta/p1-04/walkthrough-nl.txt`),
and the office is a placeholder.

- `project.json`: market `nl`, English output, 11 photos, and a fact form with two planted
  conflicts against the walkthrough (build year 1986 vs 1987, VvE contribution 175 vs 165).
- `decisions.json`: accept the walkthrough's build year; otherwise accept the form's value
  (or reject a conflict without one), remove flagged claims, and accept every staged image the
  integrity check offers.
- `voice-memo-standin.wav`: one second of silence. The walkthrough was recorded from macOS TTS,
  which is not committed (docs/model-notes.md, P1-04). Fixture mode matches the voice memo by
  its file name, so the stand-in replays the recorded transcript. For a meaningful live run,
  generate the TTS file and pass it with `--voice-memo` (docs/model-notes.md, P3-10).

```sh
npm run pipeline -- fixtures/projects/synthetic-walkthrough            # replay, no network
npm run pipeline -- fixtures/projects/synthetic-walkthrough --mode live \
  --voice-memo data/p1-04/walkthrough-nl.m4a                           # spends ~$0.50
```
