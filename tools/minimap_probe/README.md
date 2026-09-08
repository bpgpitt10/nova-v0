# GSPro Minimap Hazard Probe

Standalone proof-of-concept for turning the GSPro minimap into usable course geometry without touching Looper app code.

## What it does now

- Captures the GSPro monitor or analyzes a saved screenshot.
- Crops the minimap using the current GSPro layout proportions.
- Detects the player marker without assuming it is red. This is intentional because the marker may follow team color.
- Detects the white pin marker.
- Reads `DistanceToPin` from `C:\Users\<user>\AppData\LocalLow\GSPro\GSPro\currentRound.dat` when available.
- Recomputes minimap scale every shot as `DistanceToPin / ball-to-pin pixels`, so GSPro zoom changes do not need to be reverse engineered.
- Treats GSPro red boundary lines as penalty-area boundaries.
- Reports each visible penalty-boundary component in yards relative to the ball-to-pin axis, including whether it enters a configurable target corridor.
- Tee capture v8 also persists the canonical hole minimap, target green and penalty geometry for later shots.
- The `minimap-hazard-bunkers-v0` branch adds an offline/read-only bunker segmentation probe for saved tee captures.

No Looper UI, aim recommendation, or Stock/Pure integration is included yet.

## Fastest live test on the sim PC

From the repo root on Windows:

```powershell
powershell -ExecutionPolicy Bypass -File tools\minimap_probe\run_probe_windows.ps1
```

The launcher creates its own small Python virtual environment on first run, installs `numpy`, `opencv-python`, and `mss`, then checks the screen every 2 seconds.

Stop with `Ctrl+C`.

Debug images are written to:

```text
tools\minimap_probe\output\latest_crop.png
tools\minimap_probe\output\latest_debug.png
```

## Offline bunker identification v0

Bunker work is intentionally separated from live GSPro actuation while the classifier is being calibrated. It consumes the latest saved `tee_capture_*` folder, reuses `ball_pixel`, `pin_pixel`, and `yards_per_pixel` from `hole_model.json`, and analyzes `tee_hazard_safe_minimap.png` when available.

From the repo root:

```powershell
git switch minimap-hazard-bunkers-v0
git pull --ff-only origin minimap-hazard-bunkers-v0
powershell -ExecutionPolicy Bypass -File tools\minimap_probe\run_bunker_probe_windows.ps1
```

The runner does **not** focus GSPro, press keys, change zoom, or mutate the canonical HoleModel. It writes review artifacts beside the saved tee capture:

```text
bunkers_v0.json
bunker_candidates_v0.png
bunker_mask_v0.png
bunker_debug_overlay_v0.png
hole_model_bunkers_preview_v0.json
```

Each accepted bunker includes a confidence score, pixel polygon, polygon transformed into forward/lateral yards, front/back extent, lateral extent, and whether it enters the configured planning corridor.

A synthetic mechanical regression test is also available:

```powershell
powershell -ExecutionPolicy Bypass -File tools\minimap_probe\run_bunker_probe_windows.ps1 -SelfTest
```

That self-test only proves the code path; real GSPro minimaps remain the acceptance test.

### Bunker v0 validation rule

Prefer precision over recall. Do not lower thresholds merely to increase the bunker count. Review `bunker_debug_overlay_v0.png` on several different holes/courses. Only after the accepted polygons consistently match visible sand should `bunker_extractor.extract_bunkers()` be called from tee capture v8 and stored as authoritative HoleModel hazard geometry.

## One-shot screenshot test

```powershell
tools\minimap_probe\.venv\Scripts\python.exe tools\minimap_probe\probe.py --image C:\path\to\screenshot.png --distance 440
```

`--distance` is useful when testing a screenshot or if the current GSPro state file is stale.

## Useful options

```text
--monitor 1            Physical monitor index used by mss.
--watch 2              Re-run every 2 seconds.
--distance 245         Override currentRound.dat pin distance.
--corridor 40          Half-width of the target corridor in yards.
--roi x,y,w,h          Override the minimap crop in screen pixels.
--json                 Emit structured JSON instead of console prose.
```

Example with a manual ROI:

```powershell
powershell -ExecutionPolicy Bypass -File tools\minimap_probe\run_probe_windows.ps1 -Roi "1735,600,300,510"
```

## POC validation already performed

The algorithm was run against the screenshots collected in the September 5 minimap experiment.

Observed automatic map scales:

- Hole 1 tee, 440 yd: about `1.191 yd/px`
- Hole 3 tee, 344 yd: about `0.940 yd/px`
- Hole 3 fairway, 116 yd after GSPro zoomed: about `0.315 yd/px`

The same ball/pin detector found the correct markers across those zoom states, and the red penalty-boundary extractor produced the visible red geometry. This is the reason the probe recalibrates each shot instead of trying to model GSPro's zoom behavior.

## Known POC limitations

1. `currentRound.dat` is useful but has previously been observed to lag or be incomplete around some hole/tee transitions. For the probe, `--distance` is the fallback. Looper can later supply its existing live shot-state distance instead.
2. Player-marker hue is deliberately not hard-coded because testing showed it follows the GSPro team color.
3. The default minimap crop is based on the current screenshots. If the monitor/UI layout differs, pass `--roi` and then update the normalized defaults once we have the real sim-PC capture.
4. Penalty-area extraction is field-proven. Bunker identification is currently an offline v0 and must still be validated against real saved tee minimaps before integration.
5. This reports geometry; it does not yet overlay Looper dispersion or choose an aim point.

## Next step

Validate bunker overlays on several saved tee captures. If precision holds, promote bunker objects into the tee HoleModel next to `penalty_objects`, then feed both hazard classes into a later aim-risk layer that projects Looper's Stock/Pure shot pattern into the canonical hole coordinate system.
