# Synthetic interior photo set

Model-generated test images for the Muse Image staging spike (P1-06) and the integrity-check
feasibility study (P1-07). Every image here was generated or edited by Meta's `muse-image-1.0`
for this project on 2026-10-28. None is a photograph, stock image, or third-party asset.

**No personal data.** The scenes are invented, empty or lightly furnished interiors. The prompts
exclude people, faces, pets, mirrors and reflections, text, logos, brands, artwork, screens, and
street views; each image was checked visually for these before it was saved. All metadata
(including the model's IPTC "trainedAlgorithmicMedia" XMP marker) was stripped.

## Files

All JPEG, long edge 1024 px, re-encoded by ffmpeg without any metadata segments.

| File                                               | Size     | What it is                                 |
| -------------------------------------------------- | -------- | ------------------------------------------ |
| `living-empty.jpg`                                 | 1024×682 | Generated: empty living room               |
| `living-dining-cluttered.jpg`                      | 1024×682 | Generated: dining table covered in clutter |
| `kitchen-cluttered.jpg`                            | 1024×682 | Generated: kitchen worktop with clutter    |
| `bedroom-empty.jpg`                                | 1024×682 | Generated: empty bedroom                   |
| `hallway.jpg`                                      | 1024×682 | Generated: narrow hallway, three doors     |
| `dining-chairs.jpg`                                | 1024×682 | Generated: dining table with dated chairs  |
| `living-empty.edit-add-sofa.jpg`                   | 1024×682 | Edit of `living-empty.jpg`                 |
| `living-dining-cluttered.edit-declutter-table.jpg` | 1024×682 | Edit of `living-dining-cluttered.jpg`      |
| `bedroom-empty.edit-add-bed.jpg`                   | 1024×682 | Edit of `bedroom-empty.jpg`                |
| `dining-chairs.edit-replace-chairs.jpg`            | 1024×682 | Edit of `dining-chairs.jpg`                |
| `hallway.edit-add-rug-plant.jpg`                   | 1024×672 | Edit of `hallway.jpg` (sent without size)  |
| `living-empty.edit-remove-window.jpg`              | 1024×682 | **Structure-altering** edit (negative)     |

Fixed elements per input, as visible in the generated image (ground truth for P1-07):

| Input                     | Windows | Doors                | Radiators |
| ------------------------- | ------- | -------------------- | --------- |
| `living-empty`            | 1       | 1                    | 1         |
| `living-dining-cluttered` | 2       | 1                    | 2         |
| `kitchen-cluttered`       | 1       | 1 (open) + 1 in hall | 1         |
| `bedroom-empty`           | 1       | 1 (+ wardrobe doors) | 1         |
| `hallway`                 | 1       | 3                    | 1         |
| `dining-chairs`           | 1       | 1                    | 1         |

`living-empty.edit-remove-window.jpg` has 0 windows (the radiator and door remain). In
`bedroom-empty.edit-add-bed.jpg` the new bed partly hides the radiator, and in
`dining-chairs.edit-replace-chairs.jpg` the chairs partly hide it: a legitimate edit can occlude
a fixed element.

## How they were made

The full-resolution originals are the recorded API responses in `fixtures/meta/p1-06/`
(`generate.files/`, `edit.files/`); the tests `apps/api/src/meta/muse-image-generate.test.ts` and
`muse-image-edit.test.ts` hold the exact requests. To re-export them without network access:

```sh
P1_06_EXPORT_DIR=/tmp/p1-06 npx vitest run --project api muse-image
```

Each original was downscaled with:

```sh
ffmpeg -i <original> -vf "scale=1024:-2:flags=lanczos" -map_metadata -1 \
  -fflags +bitexact -flags:v +bitexact -q:v 2 <name>.jpg
```

The edits took the downscaled generated JPEGs above as input.

### Generation prompts

Text-to-image (`POST /v1/images/generations`, `size: "1536x1024"`, default output format). Each
prompt is the scene description followed by the shared rules:

> Photorealistic real-estate listing photograph, eye-level wide-angle shot, soft natural
> daylight. Strictly no people, no faces, no pets, no mirrors, no glass reflections, no text, no
> lettering, no logos, no brands, no artwork, no television or screens. Windows show only
> overcast sky and tree tops: no street, no cars, no neighbouring buildings.

| Scene                     | Description                                                                                                                                                                                                                                                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `living-empty`            | An empty living room in a 1930s Dutch apartment: light oak plank floor, white walls, one large white-framed window with a white panel radiator directly beneath it, and a closed white panelled interior door on the right wall. No furniture.                                                                                                         |
| `living-dining-cluttered` | A lightly furnished living and dining room in a Dutch apartment: a wooden dining table covered with clutter (plain unmarked cardboard boxes, loose blank papers, mugs, a fruit bowl, folded towels), two tall white-framed windows with a white panel radiator under each, a closed white interior door on the left wall, light herringbone oak floor. |
| `kitchen-cluttered`       | A compact Dutch apartment kitchen: white handleless cabinets, a light grey worktop cluttered with plain unwashed dishes, unlabelled jars, a dish rack and a plain kettle, one white-framed window above the sink, a white panel radiator on the side wall, and an open white door to a hallway.                                                        |
| `bedroom-empty`           | An empty bedroom in a Dutch apartment: pale grey carpet, white walls, a white-framed window with a white panel radiator below it, a closed white interior door, and a built-in wardrobe with plain white doors. No furniture.                                                                                                                          |
| `hallway`                 | A narrow hallway in a Dutch apartment: light oak floor, white walls, three closed white panelled interior doors, a white panel radiator on the side wall, an empty coat rail, and a small frosted window high on the end wall.                                                                                                                         |
| `dining-chairs`           | A dining area in a Dutch apartment: a rectangular oak dining table with six dated dark brown wooden chairs with worn green seat cushions, a large white-framed window with a white panel radiator beneath it, a closed white interior door on the right wall, white walls, light oak floor. Otherwise empty.                                           |

### Edit prompts

Image edit (`POST /v1/images/edits`, multipart, `output_format: "jpeg"`, `size: "1536x1024"`
except where noted). Each prompt wraps one declared operation:

> Edit this photo: `<operation>`. Change nothing else: keep the camera angle, framing, walls,
> floor, ceiling, windows, doors, radiators, and lighting exactly as they are. Do not add people,
> text, or logos.

| Output                                         | Operation                                                                     |
| ---------------------------------------------- | ----------------------------------------------------------------------------- |
| `living-empty.edit-add-sofa`                   | add a light grey three-seat fabric sofa in the room, facing the window        |
| `living-dining-cluttered.edit-declutter-table` | remove all clutter from the dining table so the table top is completely clear |
| `bedroom-empty.edit-add-bed`                   | add a double bed with white linen and two pillows                             |
| `dining-chairs.edit-replace-chairs`            | replace the six dining chairs with modern light oak chairs without cushions   |
| `hallway.edit-add-rug-plant` (no `size`)       | add a long woven runner rug on the floor and a tall potted plant in a corner  |
| `living-empty.edit-remove-window`              | remove the window and replace it with a plain white wall                      |
