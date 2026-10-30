"""One-off helper: outline the brand text in Newsreader and print JSON path data.

The font is NOT part of the repository. Download the variable font from the Google Fonts
repository into a scratch directory first, then run (see apps/web/public/brand/README.md):

  uvx --from fonttools --with uharfbuzz python apps/web/scripts/brand-wordmark-outline.py \
    <scratch>/Newsreader.ttf <scratch>/instance.ttf

The result is pasted into apps/web/scripts/brand-assets.mjs (WORDMARK). Newsreader is
licensed under the SIL Open Font License 1.1; outlines of the logo text are allowed.

With `--og` as a third argument it prints the outlines of the Open Graph tagline in every
language instead (apps/web/scripts/brand-og-outlines.json). Those lines use the characters of
Turkish, Dutch, Italian and Spanish, so a glyph the font does not have fails loudly instead of
drawing a missing-glyph box.
"""

import json
import sys

import uharfbuzz as hb
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

# (key, text, weight, letter-spacing in em). opsz 16 is the axis default, which is what the app's
# live text uses (next/font loads the weight axis only).
RUNS = [
    ("wordmark", "Evidomo", 700, -0.025),
]


# The Open Graph tagline per locale, one entry per printed line. Keep in step with `meta.tagline`
# in apps/web/messages/*.json (a test compares the joined lines).
OG_TAGLINES = {
    "en": ["Evidence", "for every", "home."],
    "tr": ["Her ev", "için kanıt."],
    "nl": ["Bewijs", "voor elk", "huis."],
    "it": ["La prova", "per ogni", "casa."],
    "es": ["Evidencia", "para cada", "hogar."],
}
# The display look of the landing headline: Newsreader 500 at its largest optical size.
OG_WEIGHT = 500
OG_OPSZ = 72


def fmt(value: float) -> str:
    return ("%.1f" % value).rstrip("0").rstrip(".")


def outline(
    src: str, scratch_ttf: str, text: str, weight: int, tracking_em: float, opsz: int = 16
) -> dict:
    font = instancer.instantiateVariableFont(TTFont(src), {"wght": weight, "opsz": opsz})
    font.save(scratch_ttf)
    font = TTFont(scratch_ttf)
    hb_font = hb.Font(hb.Face(hb.Blob.from_file_path(scratch_ttf)))
    buf = hb.Buffer()
    buf.add_str(text)
    buf.guess_segment_properties()
    hb.shape(hb_font, buf, {"kern": True, "liga": True})
    upem = font["head"].unitsPerEm
    glyphs = font.getGlyphSet()
    order = font.getGlyphOrder()
    track = tracking_em * upem
    x = 0.0
    parts = []
    for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
        if info.codepoint == 0:
            raise SystemExit(f"The font has no glyph for a character in {text!r}")
        pen = SVGPathPen(glyphs, ntos=fmt)
        # Flip y so the baseline sits at y = 0 and the glyphs extend upwards (negative y).
        glyphs[order[info.codepoint]].draw(TransformPen(pen, (1, 0, 0, -1, x + pos.x_offset, 0)))
        parts.append(pen.getCommands())
        x += pos.x_advance + track
    x -= track
    os2 = font["OS/2"]
    return {
        "text": text,
        "unitsPerEm": upem,
        "width": x,
        "capHeight": os2.sCapHeight,
        "xHeight": os2.sxHeight,
        "d": "".join(parts),
    }


if __name__ == "__main__":
    source, scratch = sys.argv[1], sys.argv[2]
    if "--og" in sys.argv[3:]:
        og = {
            "taglines": {
                locale: [outline(source, scratch, line, OG_WEIGHT, -0.02, OG_OPSZ) for line in lines]
                for locale, lines in OG_TAGLINES.items()
            },
            # The numbered pins on the photograph.
            "digits": {digit: outline(source, scratch, digit, 700, 0.0) for digit in "123"},
        }
        print(json.dumps(og, ensure_ascii=False))
    else:
        print(json.dumps({k: outline(source, scratch, t, w, tr) for k, t, w, tr in RUNS}))
