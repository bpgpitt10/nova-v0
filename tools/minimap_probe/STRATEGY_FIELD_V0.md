# Looper Strategy Field v0

## Why this layer exists

Carry Arc v1 is a useful **course query primitive**, not the aim engine. It answers a narrow visual question at a known radius: where does this carry radius cross the current-hole fairway? Strategy Field v0 composes several of those radial slices with the player's actual landing distribution and the already-trusted bunker / penalty / OB geometry.

This prevents the architecture from collapsing into “find the fairway center.” A later decision engine can compare target directions using the player's bias and dispersion instead of assuming the geometric center is best.

## Three deliberately separate input buckets

**Player profile** stays club/variant specific: mean carry, carry sigma, lateral sigma, mean lateral bias, optional forward bias, and lateral/forward correlation. The player distribution is defined in shot-aligned coordinates and rotated for each possible aim direction.

**Course field** stays screenshot-derived: current-hole fairway intervals on multiple carry-radius slices, plus the existing precise bunker, red-penalty, and white-OB geometry. The GSPro minimap remains visual truth. Carry slices do not create a synthetic course map.

**Gameplay context** stays separate: wind, lie, elevation, temperature, and future live modifiers may be supplied, but v0 does not apply them. The output explicitly lists supplied-but-unapplied fields so later work cannot accidentally hide these adjustments inside course extraction.

## Live distance / elevation contract

The Greywolf tee and post-tee ShotState paths already preserve GSPro screen target-card distance and elevation for both the **PIN target** and the currently displayed **AIM target**. Elevation is signed `positive = uphill`, `negative = downhill`, and is stored in feet and yards.

`strategy_gameplay_context_v0.py` is the boundary adapter between those live ShotState records and Strategy Field. It preserves the PIN and AIM measurements as separate scoped observations, carries lie/wind provenance, flags unit/sign inconsistencies without rewriting the source values, and does not invent an OCR confidence value when the target-card reader has not calibrated one.

This does **not** create a terrain elevation field. PIN elevation is elevation to the pin. AIM elevation is elevation to the current GSPro aim point. Neither may be silently reused as the elevation of every candidate landing point. Candidate-specific terrain/elevation remains unavailable until Looper has a validated spatial source or an explicitly controlled query method.

The one-shot Strategy Field replay automatically looks for `shot_state.json` beside each capture. When present it writes `strategy_gameplay_context_v0.json` and passes that context into Strategy Field. A separately supplied gameplay-context JSON is retained as supplemental context rather than overwriting ShotState provenance.

## Critical distinction: aim target vs expected landing mean

The intended aim target lies on the player's mean-carry radius at a chosen direction. The player's expected landing mean may be somewhere else because of their stock bias. Strategy Field rotates that bias and the 2-D covariance into hole-local coordinates before evaluating known hazards.

This is required for Looper. A golfer who normally misses right should not have the same expected outcome from a given aim point as a golfer with a neutral pattern.

## Fairway is route evidence, not an aim fence

Candidate search is intentionally allowed to extend **outside** the visible fairway. The current-hole fairway interval supplies a trustworthy route seed, but each side of the search domain is expanded by the player's absolute stock lateral bias plus two lateral sigmas by default. That means Looper can test an aim line in rough-side space when doing so moves the expected landing pattern away from a large one-sided miss or hazard.

Those off-fairway aim lines are candidate evidence only. They are not recommendations, and they do not imply that rough is desirable. A later decision layer must decide whether the resulting outcome distribution is actually better.

## What v0 outputs

For each candidate direction sampled across the expanded route-centered search domain, v0 outputs:

- intended aim direction and intended mean-carry target;
- whether that aim direction itself lies inside the source fairway interval;
- expected landing mean after player bias;
- rotated 2-D covariance in hole-local coordinates;
- discrete current-hole fairway support across every extracted radial slice;
- bunker probability evidence from the existing risk engine;
- penalty/OB clearance and ellipse-intersection evidence;
- explicit `decision_score: null`, `recommendation: null`, and `strategy_authority: false`.

The fairway support number is intentionally labeled a **radial-slice proxy**, not a fairway probability. We are not pretending the sparse arcs form a perfect fairway polygon.

## Greywolf replay shape

For a player profile with mean carry `C` and carry sigma `S`, the Windows runner queries Carry Arc v1 at approximately:

`C-2S, C-S, C, C+S, C+2S`

That samples the longitudinal shape of the player's landing distribution instead of only interrogating one exact carry distance. The resulting field is then built for each saved Greywolf tee capture.

When a capture also contains `shot_state.json`, the runner automatically normalizes its PIN/AIM target elevation and lie context before building the field. No elevation correction is applied to the player distribution in v0.

## Known blockers before strategy authority can turn on

1. Red-penalty and white-OB line geometry still lacks a trusted **unsafe-side orientation**. Until that exists, Looper can report clearance / ellipse intersection but must not invent penalty probability.
2. Carry Arc v1 currently supplies fairway intervals only. The field preserves a `surface_class` boundary so rough, deep rough and green radial evidence can be added without redesigning the player-distribution layer.
3. Radial surface slices are discrete evidence. If we need true surface landing probability, we need either a reviewed continuous surface model or a conservative interpolation method with strong QA.
4. Live PIN/AIM elevation is now plumbed and provenance-safe, but **candidate-specific elevation is not available**. Wind, lie, elevation, temperature, and other gameplay modifiers still need explicit validated models before they can shift the expected landing distribution.
5. A later decision layer must define the utility / expected-cost logic that trades fairway, rough, bunker, penalty, OB, distance, next-shot value, and player confidence. Strategy Field v0 intentionally does none of that.

## Files

- `strategy_carry_arc_v1.py` — visual radial-slice extractor.
- `strategy_risk_v0.py` — pure landing-distribution vs trusted-hazard geometry evaluator.
- `strategy_gameplay_context_v0.py` — ShotState adapter that preserves scoped PIN/AIM elevation, lie, wind, provenance, and application status.
- `strategy_field_v0.py` — composition layer described here.
- `run_strategy_field_v0_windows.ps1` — one-shot Greywolf replay using player-specific longitudinal carry bands and automatic per-capture ShotState context when available.
- `test_strategy_gameplay_context_v0.py` — regression checks for elevation sign/scope, unit consistency, missing OCR confidence, and supplemental context separation.
- `test_strategy_field_v0.py` — regression checks for coordinate rotation, player bias, off-fairway search, surface support, and gameplay-context separation.
