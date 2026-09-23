# Course Build Pipeline

`tools/build_course.py` is the canonical course-ingestion entry point.

It is intentionally **staging-only**. It never writes to `public/course-geometry` and therefore cannot publish or replace a playable runtime course. Promotion is a separate approval step.

## Normal build

```bash
python tools/build_course.py \
  --config config/course-geometry/<course>-v1.json
```

That command performs, in order:

1. Resolve the exact configured `golf=course` OSM element and fetch a tight course snapshot.
2. Resolve one coherent 1–18 hole family before compilation. Duplicate numbered courses are handled as a whole-course family and fail closed when still ambiguous.
3. Compile canonical V7 geometry: route orientation, owned playable surfaces, tee anchor/coordinate frame, hazards, vegetation context, and tactical deep rough.
4. If the configured terrain provider is supported, fetch terrain and sample it directly in each compiled hole's authoritative coordinate frame.
5. Compose geometry and terrain only when their frame contracts match.
6. Write a single `build-summary.json` with `PASS`, `REVIEW`, or `FAIL`.

The candidate is staged at:

```text
artifacts/course-build/<slug>/candidate/
```

Key outputs are:

- `build-plan.json`
- `osm-snapshot.json`
- `geometry-v1.json`
- `geometry-validation-v1.json`
- `terrain-source-v1.json` (when terrain is built)
- `terrain-v1.json` (when terrain is built)
- `terrain-validation-v1.json` (when terrain is built)
- `course-v1.json`
- `build-summary.json`

## Build status

**PASS** means the pipeline produced all 18 geometry holes, full requested terrain, no unresolved/virtual tee anchors, and no geometry warnings.

**REVIEW** means the build is structurally valid but needs a human decision or is intentionally incomplete—for example, a virtual tee anchor, a geometry warning, unsupported/unconfigured terrain, or a partial terrain validation slice.

**FAIL** means the importer refused to produce an acceptable candidate—for example, ambiguous/missing hole families, failed geometry contract, terrain/frame mismatch, or missing requested terrain.

A `REVIEW` result is still a candidate artifact; it is not silently promoted.

## Remote workflow

GitHub Actions workflow **Build Course Candidate** exposes the same pipeline through `workflow_dispatch` with three inputs:

- config path
- terrain mode (`auto`, `required`, `off`)
- terrain holes (normally `1-18`)

The workflow uploads the staged candidate as a temporary Actions artifact. It does **not** commit generated course data and does **not** publish it.

## Development / validation slices

To validate a new terrain provider or importer change without paying the cost of all 18 holes:

```bash
python tools/build_course.py \
  --config config/course-geometry/<course>-v1.json \
  --terrain-holes 1,6
```

That should normally return `REVIEW` because terrain is intentionally partial. Once the importer behavior is accepted, rerun the same command with the default `1-18`.

## Course configuration boundary

V1 of the pipeline expects a `looper-course-build-config-v1` file with an exact OSM course element (`way` or `relation`). Course discovery from name/location is intentionally outside this pipeline for now; the importer should not guess which neighboring course boundary the user intended.

Optional course identity metadata (currently `holeIdentity.parByHole`) is used only to disambiguate duplicate OSM hole families when needed. It is not used to manufacture missing geometry.

## Terrain providers

The first automated terrain provider is `usgs-3dep-1m`. The pipeline/provider interface is course-generic, but international terrain requires another provider implementation before those courses can receive the same automated terrain step.
