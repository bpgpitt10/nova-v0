# Hazard World Truth v0

Step 5 of `hazard-field-lab-v0` validates candidate hazard geometry against GSPro physical shot truth in the shared x/z coordinate frame.

This is a **read-only, shadow-only** validator. Every artifact remains `strategy_authority=false`.

## What it uses as truth

`currentRound.dat` is normalized through `gspro_structured.py`.

For physical shots the validator creates observations from:

- `StartingPOS` + `StartingSurface`
- `EndingPOS` + `EndingSurface`
- `HazardLastPointOfEntry` when `waterhit=true`
- material evidence such as `TVGsand` when available

Field-observed surface mappings remain partial: tee 18, fairway 2, rough 1, sand 11, green 5.

GSPro synthetic gimme closure records are retained as terminal evidence but excluded from geometry validation. A gimme record with a repeated `GlobalShotNumber` is explicitly marked `gimme-terminal-repeated-global`.

## Candidate geometry inputs

The validator currently understands three source shapes:

1. Step 3 `gkd_archaeology_*/features.json`
2. Step 4 `course_asset_archaeology_*/geometry_candidates.json`
3. Future/unified `hazards[]` JSON containing `world_polygon` / `points_xz`

GKD coordinates are marked world-comparable because prior field archaeology established direct alignment with currentRound x/z positions.

Step 4 Unity coordinates are **not** automatically trusted. They remain `unproven-local-or-serialized-space` unless a future parser explicitly proves/applies the world transform. Their distances are retained for diagnostics but cannot produce a pass/fail validation verdict.

## Validation rules

Positive truth:

- a shot starting/ending in sand should be inside or near a candidate bunker/sand polygon;
- a water event should be inside or near water/penalty geometry;
- `HazardLastPointOfEntry` is evaluated against the candidate boundary rather than requiring polygon containment.

Negative truth:

- a known tee/fairway/rough/green point inside trusted hazard geometry is a contradiction;
- a safe point outside all hazards is only `no-contradiction`. It does **not** prove the source is complete.

Generic GKD `Hazards` remains `hazard_unspecified`; it cannot validate a bunker merely because a sand shot exists nearby.

The default near threshold is `3.0` **GSPro world units**. The validator deliberately does not call those units yards. The threshold is configurable and remains diagnostic until we have enough field evidence to calibrate it.

## Outputs

A run creates `tools/minimap_probe/output/hazard_world_truth_<timestamp>/` with:

- `shots.json`
- `shot_observations.json`
- `geometry_inventory.json`
- `validation_results.json`
- `source_scorecard.json`
- `summary.json`
- `manifest.json`

and, by default:

`tools/minimap_probe/output/hazard_world_truth_review_<timestamp>.zip`

## Windows run

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\minimap_probe\run_hazard_world_truth_windows.ps1
```

If explicit paths are not supplied, the standalone runner uses the live `currentRound.dat` plus the newest Step 3 GKD and Step 4 Unity geometry outputs it can find.

For a saved corpus:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\minimap_probe\run_hazard_world_truth_windows.ps1 `
  -CaptureRoot C:\path\to\saved-corpus `
  -GeometryJson C:\path\to\gkd\features.json,C:\path\to\unity\geometry_candidates.json
```

The later combined field-lab launcher will pass exact run-specific paths so unrelated course outputs cannot be mixed.

## Important boundaries

This step does not capture the screen, call Gemini, run SAM, modify GSPro, alter the watcher, or promote any hazard source into live caddie strategy.
