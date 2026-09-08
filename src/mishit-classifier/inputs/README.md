# Mishit classifier inputs

This directory is the only home for tunable mishit-classifier inputs.

## Separation rule

- `defaults.ts` contains shared starter policy and statistical sanity constraints only.
- `definitions.ts` contains UI-ready metadata for a future Inputs page.
- `types.ts` defines optional per-player/per-population calibration overrides and exposes how an effective boundary was resolved.
- `resolve.ts` combines shared policy with the current player's robust baseline and optional player overrides.
- classifier engine files should not embed new numeric assumptions.

The user's raw shot history is never converted into a universal Looper threshold.

## Personalization model

Every club + shot variant gets its own robust baseline. Shared mishit numbers are **cold-start priors, not permanent floors**.

Once a population reaches the provisional sample size, its own median absolute deviation (MAD) begins receiving weight. That weight increases continuously through stable, mature, and full-reference-window milestones. The player-derived boundary is allowed to be either tighter or wider than the shared prior.

The current default blend is:

- provisional sample: 10% player / 90% shared prior
- stable sample: 50% player / 50% shared prior
- mature population: 80% player / 20% shared prior
- full reference window: 95% player / 5% shared prior

These weights are initial shadow-mode assumptions and live in `defaults.ts` / `definitions.ts`, not in resolver logic.

This allows a highly consistent golfer to earn tighter mishit boundaries while a naturally high-variance golfer can earn wider boundaries. Neither golfer inherits another golfer's calibrated boundary.

## Sanity constraints

A separate `personalization.sanityMinimums` block prevents a zero or tiny observed MAD from collapsing an effective threshold toward zero. These values are intentionally much smaller than the starter priors and are statistical guardrails, not golf-performance assumptions.

They are a distinct input scope (`sanity_constraint`) so a future Inputs page can display them separately from starter policy.

## Player calibration

Human-review-derived or manual player calibration lives outside the shared defaults as `MishitPlayerCalibration`, keyed by club + shot variant in Looper.

An explicit player override may tighten or widen the automatic maturity-blended boundary. It still respects only the small statistical sanity constraint. Automatic learning from human labels is intentionally not enabled yet; shadow validation should establish the learning rules first.

Effective-threshold output records the global prior, player variation, player weight, blended boundary, optional player override, sanity minimum, and final effective value so validation exports remain fully auditable.
