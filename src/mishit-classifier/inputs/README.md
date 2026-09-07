# Mishit classifier inputs

This directory is the only home for tunable mishit-classifier inputs.

## Separation rule

- `defaults.ts` contains shared starter policy only.
- `definitions.ts` contains UI-ready metadata for a future Inputs page.
- `types.ts` defines optional per-player/per-population calibration overrides.
- `resolve.ts` combines shared policy with the current player's robust baseline and optional player overrides.
- classifier engine files should not embed new numeric assumptions.

The user's raw shot history is never converted into a universal Looper threshold.

## Personalization model

Every club + shot variant gets its own robust baseline. Once that baseline is stable, the resolver can widen the global starter boundary using that population's median absolute deviation (MAD).

V1 is deliberately conservative: player-specific variability and player overrides can only widen the exclusion boundary. They cannot make the classifier more aggressive than the shared starter floor.

This means a golfer with naturally wider Driver dispersion does not inherit a tighter player's directional boundary. It also means an unusually consistent golfer does not suddenly have ordinary misses removed from planning simply because their MAD is tiny.

Human-review-derived calibration can be added later by writing a `MishitPlayerCalibration` outside the engine. That calibration remains player/population data and must not be copied into shared defaults.
