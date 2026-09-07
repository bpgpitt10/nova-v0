# Looper Live Caddie Engine v0

This package is the pure recommendation/lifecycle layer for **full shots only**. It contains no putting logic.

## Hard architecture rule

Capture/orchestration code reports facts. The engine calculates recommendations. UI renders results.
All tunable thresholds, weights and behavior assumptions live in `config/looper-live-caddie.json`.
Calculation identity/version/dependencies live in `registry.py`. Do not bury new golf assumptions in
React components, probe orchestration, or ad-hoc constants.

## State / lifecycle calculations

### Tee-state inference

`tee_state.py` is a pure evidence calculator. It accepts:

- current + previous course/hole identity;
- optional future upper-left shot number;
- optional future upper-left distance-to-pin;
- PIN-card DTP fallback;
- number of Looper-recorded shots on the current hole;
- optional previous-hole made/gimme/terminal signal;
- optional flat-lie signal;
- optional full-hole-minimap signal.

It returns `confirmed`, `probable`, or `not-tee` plus confidence/reasons. It never captures a screen or starts tee capture itself.

The important product behavior is that a **course/hole transition can confirm the next tee even when the made/gimme result screen is too fast to capture**. Future upper-left `shot = 1` will make that still stronger without changing the calculation.

### Round tracker

`round_tracker.py` keeps the last accepted active hole until a new tee is accepted. If GSPro jumps directly from a made/gimme to the next tee, repeated frames on the new hole continue to compare against the previous active hole, so the transition anchor is not lost.

## Recommendation inputs

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
python -m unittest tools.minimap_probe.test_round_identity_cache -v
```

These tests exercise recommendation/lifecycle/cache logic without GSPro. Live validation is still required for W/Y UI timing, the future upper-left OCR adapter, and final aim actuation.
