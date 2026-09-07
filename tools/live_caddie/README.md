# Looper Live Caddie Engine v0

This package is the pure recommendation layer for **full shots only**. It contains no putting logic.

## Hard architecture rule

Capture/orchestration code reports facts. The engine calculates recommendations. UI renders results.
All tunable thresholds, weights and behavior assumptions live in `config/looper-live-caddie.json`.
Calculation identity/version/dependencies live in `registry.py`. Do not bury new golf assumptions in
React components, probe orchestration, or ad-hoc constants.

## Inputs

- `ClubProfile`: existing Looper Stock / Pure reference / variability / dispersion outputs.
- `LiveShotState`: PIN, elevation, canonical aim context, external wind adjustment, confidence.
- `HazardBoundary`: canonical authoritative red penalty-boundary polylines.
- `GreenSurface`: canonical target-green polygon and optional heatmap metadata.

## Candidate policy

By default each club produces:
- Stock
- Smooth = 90% of Stock
- explicit learned variants, when supplied

Pure is retained as a reference and is **not** automatically selected as a planned shot by default.

## Hazard semantics

v0 computes **penalty-boundary proximity risk**. It does not call that metric probability of entering
a penalty area because the extracted red line does not yet always establish which side of an open
boundary is the penalty side.

## Strategic vs approach aiming

- `strategic`: GSPro's current aim is the baseline; Looper tests whether the player's personal pattern
  warrants shifting it.
- `approach`: green containment, distance fit and hazard boundaries can drive the target.

## Wind

Wind is not reimplemented here. The existing Looper wind path supplies `external_carry_adjustment_yds`
and `external_lateral_adjustment_yds`.

## Tests

From repo root:

```powershell
python -m unittest discover -s tools/live_caddie/tests -v
```

These tests exercise recommendation logic without GSPro. Live validation is still required for W/Y UI
timing and final aim actuation.
