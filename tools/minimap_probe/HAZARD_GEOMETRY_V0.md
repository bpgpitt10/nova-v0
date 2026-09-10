# Unified HazardGeometry v0

Step 7 of `hazard-field-lab-v0` gives every experimental hazard source one common geometry contract. The goal is to stop carrying source-specific shapes through the rest of the field lab.

Everything in this schema is **shadow-only**. `strategy_authority` is required to be `false`, and the constructor/validator rejects attempts to set it to `true`.

## Core object

Each `looper-hazard-geometry-v0` object separates:

- `hazard_class`: `bunker`, `water`, `penalty_area`, `out_of_bounds`, `uncertain`, or `generic_hazard`
- `source`: source kind/name/artifact/object id
- `identity`: optional course, round, hole, and capture identity
- `confidence.semantic`: confidence in *what the object is*
- `confidence.geometry`: confidence in *the shape/edge geometry*
- `representations`: one or more coordinate/shape representations
- `validation`: validation state plus accumulated evidence
- `diagnostics`: source-specific evidence that should not pollute the stable contract
- `strategy_authority: false`

Semantic confidence and geometry confidence are deliberately independent. A Gemini box can be semantically strong while having no exact-geometry confidence. A SAM result can preserve Gemini semantic confidence while separately carrying a segmentation-quality score.

## Geometry representations

An object can carry multiple simultaneous representations:

- `gspro_world_xz`: direct world geometry, currently appropriate for field-established GKD x/z data
- `minimap_pixel`: pixel polygon/polyline/mask reference
- `minimap_normalized`: normalized image polygon/polyline/bbox
- `hole_local_yards`: reserved for geometry projected into the canonical tee-to-pin frame
- `unknown_asset_or_serialized_space`: Unity/course-asset geometry whose transform has not yet been proven

Supported geometry types are `polygon`, `polyline`, `bbox`, `point_set`, and `mask_ref`.

`comparable_to_gspro_world=true` is accepted only for `gspro_world_xz`. Step 4 Unity geometry is deliberately emitted in `unknown_asset_or_serialized_space` until the real field ZIP establishes its transform.

## Current adapters

`hazard_geometry_contract.py` includes adapters for:

1. Step 3 GKD `features.json`
2. Step 4 Unity `geometry_candidates.json`
3. provider-neutral VLM/Gemini bbox responses (`looper-hazard-vlm-v0`)
4. Step 6 prompt-segmentation/SAM result objects
5. the existing VLM + cheap-CV refinement objects
6. red-penalty CV objects using tolerant historical polygon/polyline field names
7. legacy bunker/water CV objects using tolerant historical polygon/contour field names

Generic GKD `hazard_unspecified` remains `generic_hazard`; it is never promoted to bunker merely because it came from a `Hazards` array.

## CLI normalizer

Existing artifacts can already be bundled without modifying their producers:

```powershell
python .\tools\minimap_probe\hazard_geometry_contract.py `
  --input path\to\features.json `
  --input path\to\geometry_candidates.json `
  --input path\to\hazard_vlm_response_gemini-3_1-flash-lite_boxes_v0.json `
  --input path\to\hazard_sam2_gemini-3_1-flash-lite_v0.json `
  --output path\to\hazard_geometry_v0.json
```

Optional `--course-key`, `--course-name`, `--round-id`, `--hole`, and `--capture-id` attach common identity to normalized objects.

The normalizer is fail-soft across input artifacts. Unrecognized source objects are reported in `adapter_errors` rather than preventing valid sources from reaching the output bundle.

## Intentional Step 7 boundary

Step 7 defines the common language and adapters. It does **not** yet modify every producer to emit the schema natively. Those integration points are tracked explicitly in `HAZARD_FIELD_LAB_WIRING_BACKLOG.md` and are implemented in later steps so this branch remains debuggable one layer at a time.
