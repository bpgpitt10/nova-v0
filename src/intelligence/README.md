# Looper Intelligence Architecture

## Goal

Make Looper's intelligence understandable, testable, and changeable without requiring source-code archaeology or risking unrelated working product behavior.

This layer is intended to become the canonical home for Looper model definitions, algorithms, parameters, dependencies, explanations, and calculation traces.

## Safety rule

**Extraction must not change answers.**

When an existing model moves into this architecture, its first canonical implementation must reproduce current Looper behavior exactly. Algorithm improvements happen only after parity is proven and must be introduced as a new model/algorithm version.

That creates three distinct change types:

1. **Extraction** — same inputs, same answer, different code location.
2. **Integration** — same answer, new canonical caller.
3. **Model change** — deliberately different answer because the algorithm or assumptions changed.

Do not combine these change types in one migration step.

## Current product boundary

The current web application still persists saved sessions and the active-session draft in browser `localStorage` through `src/lib/sessions.ts`.

The intelligence layer must therefore remain storage-agnostic. A model should receive normalized inputs and must not know whether they came from localStorage, a future database, imported fixtures, GSPro, Nova, or another source.

The future persistence migration should be able to change the input adapter without changing the intelligence models.

## Model contract

Every important Looper concept should eventually have one registered model definition containing:

- stable model ID
- human-readable name
- purpose / question answered
- model version and status
- required inputs
- outputs
- algorithm summary
- configurable parameters and their base defaults
- upstream dependencies
- downstream consumers
- legacy source references during migration
- notes about known limitations or historical artifacts

Executable models should additionally return a structured calculation trace so Looper can explain how a result was produced for a specific club/session.

## One canonical implementation

Once a model has completed parity validation and is activated:

- UI code must not recreate its math.
- Higher-level models must consume the canonical model output rather than reimplementing the lower-level formula.
- Old implementations should be removed after a short rollback window.
- Fundamental algorithm changes should produce a new version rather than silently mutating historical behavior.

## Dependencies

Dependencies are first-class architecture, not something to reconstruct later from imports.

A registered model should declare both:

- what other intelligence concepts it depends on
- what known models or product surfaces consume it

This is the basis for answering, "If we change this algorithm, what else moves?"

## Parameters vs algorithms

Parameters are tunable assumptions such as thresholds, weights, minimum sample sizes, and lookback windows.

Algorithms describe how inputs and parameters become an output.

The future admin input page should edit approved parameters, not arbitrary executable formulas. Fundamental algorithm changes remain deliberate model-version changes.

## Traces / explainability

A calculation should eventually be able to return both a value and a trace, for example:

- evidence used
- observations excluded and why
- intermediate centers/spreads
- thresholds or tolerances applied
- component scores
- final combination step

This supports both a future Model Explorer and our own debugging/model-design workflow.

## Migration sequence

### Phase 0 — foundation

- establish model contracts and registry
- document migration rules
- do not change live Looper behavior

### Phase 1 — input boundary and golden fixtures

- define the normalized intelligence input boundary based on actual current data needs
- create stable test fixtures from current Looper session data
- capture legacy outputs for several representative clubs

### Phase 2 — Pattern Stability pilot

Pattern Stability is the first migration candidate because it can be calculated in parallel without changing shot classification or Stock/Pure membership.

1. Document current behavior and dependencies.
2. Reproduce the legacy algorithm in a canonical model module.
3. Run legacy and canonical calculations side-by-side on identical inputs.
4. Require parity before switching any caller.
5. Only after parity, consider an experimental v2 algorithm.

### Phase 3 — Model Explorer

Expose registry metadata, algorithm documentation, parameters, dependencies, and calculation traces in a read-only internal/admin view.

### Phase 4 — migrate remaining intelligence

Move other performance drivers, Stock, Pure, Confidence/Club Score, and later new intelligence concepts one at a time using the same parity-first process.

### Phase 5 — parameter editor and Model Lab

After canonical model configs exist:

- editable approved assumptions
- base-default reset
- per-model version visibility
- current-vs-candidate algorithm comparisons

## Pattern Stability pilot status

`models/patternStability/definition.ts` documents the current legacy behavior only. No production calculation has been moved or changed.

The initial archaeology already highlights why this architecture is needed:

- some Pattern Stability algorithm values are hard-coded directly in `scoring.ts`
- Pattern Stability also reaches into the Direction Window config for one of its tolerances
- `confidenceConfig.patternStability` contains fields that the current Pattern Stability function does not appear to consume

The next step is to establish the normalized input/test-fixture boundary and then build a shadow `legacy-v1` implementation that can be compared to the current function.
