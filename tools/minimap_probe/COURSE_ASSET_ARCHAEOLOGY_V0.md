# GSPro Course Asset Archaeology v0

This is Step 4 of the isolated `hazard-field-lab-v0` work. It inspects the installed GSPro course assets for physical course-feature evidence: bunker/sand objects, water, penalty and OB structures, splines/control points, terrain, materials, meshes, transforms, and related serialized Unity objects.

It is deliberately **read-only**. Every output remains `strategy_authority=false`.

## Why this exists

The minimap/VLM work can identify *what a feature looks like on screen*. This probe asks whether the installed course itself already contains better geometry. If a bunker GameObject, material, spline, MonoBehaviour, or container path can be connected to a Mesh or coordinate structure, Looper may eventually be able to use source course geometry rather than infer exact edges from pixels.

## What it scans

The probe reuses Step 3 course resolution, then inventories the full resolved course folder. It attempts Unity parsing on likely serialized targets including:

- `.gspcrse`
- `.unity3d`
- `.bundle`
- `.assets`
- extensionless files
- any file with `UnityFS`, `UnityWeb`, or `UnityRaw` magic

Resource sidecars such as `.resource` / `.resS` are inventoried and string-scanned but are not treated as independent Unity files unless explicitly supplied.

## Unity object archaeology

The runner installs `UnityPy` only inside `tools/minimap_probe/.venv` when needed. For each successfully loaded asset it records:

- object type and path ID
- object/container name
- bounded typetree/object preview
- parse failures
- PPtr references
- relevant ASCII / UTF-16 strings from raw serialized bytes
- semantic hits
- coordinate-bearing structures and bounds

It supports both current UnityPy-style `parse_as_dict` / `parse_as_object` and older `read_typetree` / `read` APIs.

## Semantic linking instead of name-only guessing

Direct names are useful but insufficient. A common Unity structure looks like:

`Bunker_Left GameObject -> MeshFilter -> Mesh`

or:

`Sand Material -> MeshRenderer -> GameObject / MeshFilter -> Mesh`

The probe builds a file-local reference graph from Unity PPtrs and propagates strong semantic evidence up to two graph hops. This lets a generically named `Mesh_17` become a bunker geometry candidate because it is actually attached to an object named `Bunker_Left`.

External-file PPtrs (`m_FileID != 0`) are preserved but are **not falsely joined** to same-numbered path IDs in the current file.

## Geometry hunting

The probe recursively searches parsed object data for coordinate-bearing fields such as:

- vertices / points / coords / positions
- spline / control points / knots
- polygon / polyline / boundary / outline
- transform positions
- bounds / AABB

For each coordinate structure it stores the source object, field path, point count, x/z bounds, centroid, optional y bounds, and a bounded point list.

For Mesh objects that inherit strong hazard semantics through the reference graph, the probe also attempts a UnityPy OBJ export. Candidate OBJ files are capped by count and per-file size so a pathological course does not generate an enormous review package.

## Critical interpretation rule

A semantic hit is evidence, not truth.

- `Hazard` does not automatically mean bunker.
- `Mesh` does not automatically mean course hazard.
- `boundary` may be OB, penalty, terrain, or unrelated scene geometry.
- a material named `sand` is strong evidence but still needs spatial validation.

Nothing from this step is allowed to drive live Looper strategy yet.

## Outputs

A run creates:

`tools/minimap_probe/output/course_asset_archaeology_<timestamp>/`

with:

- `summary.json`
- `asset_inventory.json`
- `unity_objects.json`
- `semantic_candidates.json`
- `geometry_candidates.json`
- `reference_graph.json`
- `mesh_exports.json`
- `candidate_meshes/*.obj` when relevant meshes can be exported
- `round_course_context.json`
- `manifest.json`

It also creates an upload-friendly archive:

`tools/minimap_probe/output/course_asset_archaeology_review_<timestamp>.zip`

## Run on the simulator PC

```powershell
git pull
powershell -ExecutionPolicy Bypass -File .\tools\minimap_probe\run_course_asset_archaeology_windows.ps1
```

The normal run requires no path arguments. If automatic course resolution misses, the runner accepts `-CourseFolder` or one or more `-AssetFile` overrides.

## Unit tests

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\minimap_probe\run_course_asset_archaeology_tests_windows.ps1
```

The tests cover semantic classification, PPtr parsing, coordinate extraction, two-hop GameObject-to-Mesh propagation, cross-file reference safety, and the rule that a generic Mesh is not itself a hazard seed.

## What Step 4 does not do

It does not change GSPro, press keys, capture the screen, call Gemini, run SAM, change the HoleModel, or alter strategy. The first field run is meant to tell us whether GSPro course assets contain usable source geometry and exactly where it lives.
