# GSPro Minimap Hazard Probe

Standalone proof-of-concept for turning the GSPro minimap into usable course geometry without touching Looper app code.

## What it does now

- Captures the GSPro monitor or analyzes a saved screenshot.
- Crops the minimap using the current GSPro layout proportions.
- Detects the player marker without assuming it is red; testing showed the marker follows GSPro team color.
- Detects the white pin marker.
- Recomputes minimap scale from ball-to-pin pixels and real pin distance, so GSPro zoom does not need to be reverse engineered.
- Treats GSPro red boundary lines as high-confidence penalty-area boundaries.
- Reports penalty geometry in yards relative to the ball-to-pin axis.
- Tee capture v8 persists the canonical hole minimap, target green and penalty geometry for later shots.
- `bunker_extractor.py` adds offline/read-only bunker candidate segmentation for saved tee captures.
- `water_extractor.py` adds offline/read-only water-surface segmentation for saved tee captures.

No Looper UI, aim recommendation, or Stock/Pure integration is included in these semantic extractors yet.

## Hazard semantics

Keep recognition separate from risk/strategy.

- `penalty_objects`: red GSPro boundary geometry. This remains the authoritative penalty-area cue when present.
- `bunker_objects`: visually segmented filled sand surfaces, currently unvalidated v0.
- `water_objects`: visually segmented filled water surfaces, currently unvalidated v0.
- Green geometry is stored separately under `green_surface`.

Water does not replace the red-boundary logic. A water polygon can corroborate a nearby red penalty boundary, but a blue/cyan rendered surface by itself is not promoted to an authoritative golf-rule penalty area.

## Fastest live test on the sim PC

From the repo root on Windows:

```powershell
powershell -ExecutionPolicy Bypass -File tools\minimap_probe\run_probe_windows.ps1
```

The launcher creates its own Python virtual environment on first run. Stop with `Ctrl+C`.

## Offline bunker identification v0

Bunker work is intentionally separated from live GSPro actuation while the classifier is calibrated. It consumes a saved `tee_capture_*` folder, reuses `ball_pixel`, `pin_pixel`, and `yards_per_pixel` from `hole_model.json`, and analyzes `tee_hazard_safe_minimap.png` when available.

```powershell
powershell -ExecutionPolicy Bypass -File tools\minimap_probe\run_bunker_probe_windows.ps1
```

Artifacts are written beside the saved tee capture:

```text
bunkers_v0.json
bunker_candidates_v0.png
bunker_mask_v0.png
bunker_debug_overlay_v0.png
hole_model_bunkers_preview_v0.json
```

Each accepted bunker includes confidence, pixel/yard polygons, forward/lateral extents, and corridor overlap.

Bunker v0 deliberately prefers precision over recall. Sand coloring varies across courses, so the current pale-tan/warm-gray mask is a candidate generator rather than a finished universal classifier. Cart paths can also share bunker colors. Long continuous, relatively constant-width shapes should ultimately be treated as `path_candidate`/non-bunker using geometry and topology rather than color alone.

Synthetic regression check:

```powershell
powershell -ExecutionPolicy Bypass -File tools\minimap_probe\run_bunker_probe_windows.ps1 -SelfTest
```

## Offline water identification v0

Water v0 uses the same saved normal-color tee minimap and canonical transform. It supports bright blue/cyan and darker teal-blue candidates and intentionally does **not** heavily penalize long irregular shapes because streams and long ponds are legitimate water.

```powershell
powershell -ExecutionPolicy Bypass -File tools\minimap_probe\run_water_probe_windows.ps1
```

Artifacts:

```text
water_v0.json
water_candidates_v0.png
water_mask_v0.png
water_debug_overlay_v0.png
hole_model_water_preview_v0.json
```

Synthetic regression check:

```powershell
powershell -ExecutionPolicy Bypass -File tools\minimap_probe\run_water_probe_windows.ps1 -SelfTest
```

The self-test only proves the mechanical code path. Real GSPro course minimaps are the acceptance test because community-course palettes can vary.

## Combined semantic-hazard review

Run both bunker and water review on the latest saved tee capture:

```powershell
powershell -ExecutionPolicy Bypass -File tools\minimap_probe\run_semantic_hazard_review_windows.ps1
```

Or target a specific capture:

```powershell
powershell -ExecutionPolicy Bypass -File tools\minimap_probe\run_semantic_hazard_review_windows.ps1 -CaptureDir "C:\path\to\tee_capture_YYYYMMDD_HHMMSS"
```

This command is offline/read-only: no GSPro focus, keypresses, zoom changes, or canonical HoleModel mutation.

## Live capture calibration plan

Normal tee capture already creates the useful validation dataset. Do not stop play to hand-label every hole.

For each encountered hole, preserve:

- normal-color canonical tee minimap (`tee_hazard_safe_minimap.png`);
- heatmap/canonical minimap and HoleModel transform;
- detector candidate masks;
- accepted masks and debug overlays;
- JSON diagnostics/confidence.

Then improve the classifiers from real failures encountered during play: different bunker palettes, tan cart paths, unusual water colors, labels overlapping hazards, narrow streams, etc. If a specific hole is obviously wrong, record the hole/course note and retain that tee capture for targeted tuning.

## One-shot screenshot test

```powershell
tools\minimap_probe\.venv\Scripts\python.exe tools\minimap_probe\probe.py --image C:\path\to\screenshot.png --distance 440
```

## POC validation already performed

Observed automatic map scales from the September 5 minimap experiment:

- Hole 1 tee, 440 yd: about `1.191 yd/px`
- Hole 3 tee, 344 yd: about `0.940 yd/px`
- Hole 3 fairway, 116 yd after GSPro zoomed: about `0.315 yd/px`

The same marker approach held across those zoom states, and red penalty-boundary extraction produced visible red geometry. Tee capture subsequently proved the canonical whole-hole HoleModel path.

## Current validation state

1. Penalty-area red-boundary extraction: field-proven enough to remain the high-confidence semantic class.
2. Green tee capture/extraction: proven first-slice canonical layer.
3. Bunker identification: offline v0; collect/tune against real course variation before live integration.
4. Water identification: offline v0; collect/tune against real course variation before live integration.
5. Cart-path classification: not implemented yet. Use bunker false positives from live captures to design geometry/topology rejection instead of hard-coding one sand color.
6. Strategy layer: not yet connected; semantic geometry should remain separate from Looper dispersion/Stock/Pure/mishit risk math.

## Next step

Run the combined semantic-hazard review across several real tee captures. If water precision is strong, correlate water surfaces with red penalty boundaries. Continue collecting bunker/path variation rather than loosening thresholds blindly. Only then promote validated semantic objects into the canonical tee HoleModel used by live aim-risk logic.
