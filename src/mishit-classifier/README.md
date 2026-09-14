# Mishit Classifier

Portable, deterministic shot-population classifier for identifying shots that should be retained as golf-performance events but excluded from planning statistics.

## Boundary

This directory is intentionally independent from the Looper application.

It MUST NOT import:

- React or UI code
- Looper `Shot` types
- Looper `confidenceConfig`
- GSPro, SimRead, Nova, or OpenGolfCoach code
- localStorage or browser APIs
- Stock, Pure, club-score, or session-scoring code

The public API accepts plain shot data and returns plain classification data. A separate Looper adapter can map application shots into this format later.

## Product meaning

A **bad golf shot is not automatically a mishit**.

The classifier is intended to separate two different truths:

1. **Planning population** — shots a player can reasonably plan around. These are eligible for Stock/Pure calculations.
2. **Execution failures** — unusually poor strikes/outcomes worth measuring as part of the player's performance history, but not appropriate for defining expected Stock/Pure behavior.

Every raw shot remains stored. This package never deletes or mutates source shots.

## Classifications

- `unclassified` — not enough reference data to make a reliable call. Planning eligible by default.
- `normal` — part of the current planning population.
- `mishit` — strong evidence of an abnormal execution failure. Not planning eligible.
- `severe_mishit` — catastrophic execution failure. Not planning eligible.

The word `shank` is intentionally not used. Extreme directional misses are not necessarily literal shanks.

## Current signals

The first version evaluates only transparent, inspectable signals:

- carry loss versus the robust carry center
- absolute offline distance and deviation from the robust offline center
- ball-speed loss versus the robust ball-speed center
- smash-factor loss versus the robust smash-factor center
- compound evidence when multiple non-severe failure signals occur together

OpenGolfCoach rank is intentionally not a mishit signal. A low-ranked shot can still be a normal bad golf shot and therefore belong in the planning distribution.

Total distance, launch, spin, and club-delivery fields are intentionally not classification signals in v1. They can be added only as explicit, documented assumptions.

## Baseline

The baseline uses medians and median absolute deviations (MAD), not arithmetic means. This makes the initial reference resistant to a small number of catastrophic shots.

Reference shots are limited to the most recent `maxReferenceShots` observations. All historical shots can still be retained for mishit-rate/history analytics; they are simply not all required to define today's normal pattern.

Baseline states:

- `insufficient`: fewer than `provisionalSampleSize` reference shots
- `provisional`: enough to classify, but still expected to move
- `stable`: at least `stableSampleSize` reference shots

The baseline is optionally refined by removing only first-pass `severe_mishit` shots and rebuilding. Ordinary `mishit` shots are not removed from the baseline-refinement pass because the first version should remain conservative.

## Player-specific personalization

Shared mishit boundaries are cold-start priors, not permanent floors. Each homogeneous club + shot-variant population earns increasing control of its own boundaries as its sample matures.

The automatic personal boundary is derived from that population's robust MAD and blended with the shared prior. By default the player evidence receives 10% weight at provisional sample size, 50% at stable, 80% at mature population size, and 95% at a full reference window. These are shadow-mode assumptions and are centrally editable inputs.

Because the blend is two-way, a highly consistent golfer can earn a tighter boundary and a high-variance golfer can earn a wider boundary. Player-specific human-review/manual calibration is a separate layer and may also tighten or widen the boundary.

Only small statistical sanity minimums remain as hard lower constraints to prevent zero/tiny MAD samples from producing nonsensical near-zero thresholds. Those constraints are stored separately from golf-performance priors and are exposed independently for a future Inputs page.

## Refresh policy

A new shot can be classified immediately against the current baseline. The baseline itself is not rebuilt after every swing.

Default behavior:

- rebuild after every 5 new shots while the population is early/provisional
- rebuild when crossing the provisional or stable sample thresholds
- after the population matures, rebuild every 10 new shots
- after a mature rebuild, reclassify the full population only if the baseline moved materially
- otherwise classify only the new shots and preserve existing classifications
- changing the shared input version or player calibration version forces deterministic reclassification

All tunable values live under `inputs/`. `config.ts` is only a compatibility export; classifier engine files should not embed numeric assumptions.

## Initial shared priors

All numbers below are INITIAL cold-start assumptions for shadow-mode validation. They are not Brian-specific and they are not permanent floors. None are yet wired into Looper Stock/Pure.

| Assumption | Default cold-start prior |
| --- | ---: |
| Provisional sample | 5 shots |
| Stable sample | 12 shots |
| Mature population | 30 shots |
| Max baseline reference window | 100 shots |
| Mishit carry prior | max(15% of carry center, 12 yd) |
| Severe carry prior | max(22% of carry center, 20 yd) |
| Mishit absolute offline prior | max(35 yd, 20% of carry center) |
| Severe absolute offline prior | max(55 yd, 25% of carry center) |
| Mishit deviation prior | 30 yd from offline center |
| Severe deviation prior | 45 yd from offline center |
| Mishit ball-speed prior | 12% loss |
| Severe ball-speed prior | 18% loss |
| Mishit smash prior | 0.08 loss |
| Severe smash prior | 0.13 loss |
| Compound mishit | 2+ mishit-level signals |
| Compound severe mishit | 3+ mishit-level signals |

Default player-population blend weights are 10% at provisional, 50% at stable, 80% at mature, and 95% at the full reference window. Statistical sanity minimums are defined separately in `inputs/defaults.ts` and should not be interpreted as golf-performance targets.

These values should be tuned against real shot histories before the classifier becomes authoritative for Stock/Pure.

## Public API

```ts
import {
  DEFAULT_MISHIT_CONFIG,
  analyzeShotPopulation,
  buildMishitBaseline,
  classifyShot,
  classifyShots,
  refreshMishitAnalysis,
} from './mishit-classifier'
```

Typical shadow-mode use:

```ts
const analysis = analyzeShotPopulation(shots, DEFAULT_MISHIT_CONFIG)

analysis.baseline.status
analysis.effectiveThresholds
analysis.classifications
```

Incremental refresh use:

```ts
const next = refreshMishitAnalysis({
  shots,
  previous: priorAnalysis,
  config: DEFAULT_MISHIT_CONFIG,
  calibration: optionalPlayerPopulationCalibration,
})
```

## Integration rule for Looper

When this is eventually integrated, Looper should have one adapter that maps application shots into `MishitShot`. Stock/Pure should consume one planning-eligible set rather than embedding mishit checks throughout their calculations.

Conceptually:

```ts
const planningShots = shots.filter((shot) => classificationById[shot.id]?.planningEligible !== false)
```

The classifier remains derived state. Raw shot data is source truth. Shared inputs, player baseline state, player calibration state, and final effective thresholds remain separately inspectable.
