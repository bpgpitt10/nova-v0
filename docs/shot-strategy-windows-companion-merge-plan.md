# Plan: merge partial Shot Strategy and Windows Companion Auto Aim

> **2026-10-13 Partial Shot integration update:** The Shot Strategy **portion** is now selectively integrated on `live-caddie-partial-shot-integration-v1` from the real production branch `web-alpha-mishits` (current baseline `b414c068`). The separate native Windows Auto Aim component is **not enabled or merged as part of this change**. No alternate beta URL is intended for daily testing; production target is `thelooper.golf` after CI and deployment approval.

> **Changes ported:** `shotStrategy.ts` and `shotStrategyTerrain.ts` from `live-caddie-shot-strategy-v1`; tactical-target elevation bypass in `LiveCaddieWorker.ts`; the strategy-only ledger interface in `ConditionsMathPanel.tsx`; strategy card, map target, disabled unvalidated risk percentages and per-shot club-choice UX in `LiveCaddiePage.tsx`; appended scoped CSS. No wholesale branch merge or replacement of current GSPro session, tee, wind, or green logic.

> **Correctness fixes over original partial branch:** precise LiDAR green aim requires a **source-validated exact GSPro pin**, never just an estimated pin. When exact pin unavailable, keep the live tactical target and label the confidence limit. Recalculate playing distance/adjustment scale from the **same strategy map target**. Hazard search uses closest polygon **edge/inside** rather than checking polygon vertices, closing the long straight bunker-edge failure. In Shot Strategy mode, native read-only full-shot intent has `club:null` and `targetLocalYds:null`, even if the player selected a physical club. All Driver/Mini Driver non-tee restrictions and first-tee hold apply unchanged.

> **Release checks:** `tools/test-live-partial-shot-strategy.mjs` checks 5/60/75yd under-range, 88/95yd above floor, uncalibrated model, segment/inside bunker, exact pin confidence, disabled risk percentages, and no native command target. Run the full preexisting farm/movement/wind/surface/green/auth/shot-state regressions. Physical validation of 60yd target and on-green transition still outstanding until user is at simulator.



> **Scope clarification (2026-10-11):** This remains the plan for manually
> reconciling **partial Shot Strategy** across diverged branches; it is NOT the
> overarching native Windows Companion implementation plan. For current EXE
> read-only simulator findings, Live Caddie state ownership, OCR/capture repair,
> secure native click and acceptance criteria, see
> [Windows Companion / Native AutoAim execution plan V2](./windows-companion-autoaim-execution-plan-v2.md).
> Preserve the existing Live Caddie ball/tee/hole transition system unchanged.


**Date:** 2026-10-06. **Status: PLAN ONLY; branches intentionally remain separate.**
**Base for eventual integration:** rebase/create a *new isolated integration
branch* from the then-current working Live Caddie/Importer branch after the
simulator capture/discovery gate. Never merge to main or production based only
on successful synthetic tests.

## Actual upstream branches audited

- Windows helper: auto-aim-windows-companion-v1
  (at 7666d68 during this review, with subsequent DPI hardening).
- Partial strategy: live-caddie-shot-strategy-v1 at cf904f7.
- The tips diverged from ea29e84e; 30 companion commits and 22 strategy
  commits existed at review time. **Only src/pages/LiveCaddiePage.tsx was
  modified in both descendant ranges.** A wholesale merge will also carry
  dormant historic Tauri native Auto Aim work and unrelated changes.
- Partial branch's latest Shot Strategy CI success: GitHub Actions run
  37546316341 (7c5270c). The final cf904f7 removes its temporary build
  gate; do not call that final commit independently tested until rebuild.
- Companion's staged Windows build 37571279871 passed 28 synthetic tests,
  packaged executable smoke, and the isolated prerelease. This does not
  prove actual GSPro pixels, authenticated clicks, or physical DPI correctness.

## Preserve user's settled shorter-shot product requirements

When actual planned distance is shorter than the shortest *supported calibrated
shot variant*, show **SHOT STRATEGY** instead of recommending a named club.
Carry *all* the relevant adjustments (wind, altitude, elevation, lie,
surface) with short-distance scaling; display effective playing distance and
effective L/R, tactical target, prominent green contour/shelf/rise warning,
hazards and safe miss. Show these through chips from off-green states.

Never infer the player's partial-shot dispersion/success probability from
full swings. Hide success and risk percentages, total/finish dispersion
predictions, shot trajectory or rollout prescriptions until empirically
calibrated partial-shot records exist. User may choose/arm the club they are
actually holding, but that choice is not a Looper club recommendation.
On green/putts: record the scoring state; disable aim recommendation and
native Auto Aim entirely.

## Minimal selective source integration, in dependency order

1. Copy the **two new pure strategy modules** from the strategy branch:
   src/liveCaddie/shotStrategy.ts and shotStrategyTerrain.ts. Retain
   green slope and topographic fallback, and the shortest-supported-shot
   detection. Do not copy historic native Tauri/auto-aim scripts.
2. Port ONLY the 26-line tactical-target elevation guard in
   src/pages/LiveCaddieWorker.ts. It ensures under-range ledger elevation
   refers to the true tactical target instead of a nominal full-shot landing
   location. Preserve worker cache/decision ranking behavior for normal shots.
   Version the cache if the changed result shape causes stale cached outputs.
3. Port ConditionsMathPanel.tsx's strategy-only props and adjustmentScale
   ledger, along with the appended strategy-mode block in
   LiveCaddieDesignTune.css. Existing full-shot outcomes/ledger must remain
   mathematically and visually identical at adjustmentScale=1.
4. MANUALLY reconcile src/pages/LiveCaddiePage.tsx (the sole overlapping
   changed file): retain native background companion status badge/polling and
   prepareReadOnlyNativeAimIntent; add strategy selection, UI card, map marker,
   safe-miss/hazard/green data, muted under-range club selection and omission
   of unvalidated success percentages.
5. Introduce one explicit decision intent union *before* any native command:
   {kind:'evaluated-shot', club, aimPoint} vs
   {kind:'shot-strategy', suggestedTacticalPoint, clubRecommendation:null}.
   Both use course-local coordinates for browser display. In strategy mode,
   NEVER substitute a private full-shot referenceEvaluation/club/bestCandidate
   as a genuine recommendation. A player's selected club is metadata only.
   Use the strategy tactical map point as the possible aim target; do not
   silently pass inspectedCandidate (null in strategy mode) or translate
   course-local XY directly to GSPro screen pixels.
6. Keep native request/routing **disabled** until the simulator validation
   gates pass. Later, map either intent to verified shared GSPro/course
   coordinates via tee/pin anchor checks; sign/bind to native observed
   course/hole/shot/recommendation revision and explicit per-shot arm.
   Native one-click accepts only authenticated/recent shot targets,
   never arbitrary window-pixel coordinates. No auto aim on green.
7. Preserve immutable recommendation vs actual-club vs partial-shot intent
   lineage; never label user-selected partial shots as full-stock practice data.

## Risks surfaced by this audit, to test/fix in integration

- **Hazard distances:** shotStrategyTerrain.nearestHazardPoint only inspects
  polygon VERTICES within 28 yd of pin. A long straight hazard edge can pass
  one yard from a target with no nearby vertex: false 'no hazard'. Measure
  point-to-segment/polygon-edge distance (including target inside hazard) and
  add long-edge fixtures before publishing strategy advice.
- **Shot Strategy target vs distance:** strategy chooses greenGuidance.target
  but effectiveDistanceYds uses distance(ball, prior landing target). Confirm
  playing-distance display is derived from the same tactical target and
  validated GSPro pin, especially near sharp slopes / intentional layups.
- **Strategy switch:** entering/leaving under-range mode mid-hole must clear
  stale inspected candidate and previous arm/nonce. Existing read-only
  nativeAimIntent currently needs a club and inspectedCandidate; it cannot be
  reused unchanged for strategy, especially when club selection is optional.
- **Partial environment:** reference full-shot flight response is only a
  linear proxy, not calibrated chip trajectory. Keep that explicit and avoid
  exactness claims from wind/lie adjustments on low flights.
- **Greens and identity:** shot starts/restarts, surface change to green,
  pin changes, hole transitions, mulligans, menu overlays and stale files
  must invalidate previews. A present previous magenta marker is not proof a
  new native click was accepted.
- **DPI and frame freshness:** mixed-display scaling, relocated windows,
  Windows Graphics Capture fallback and truly new screenshot content need
  live validation. See Auto Aim architecture handoff for all gates.

## Integration test and release gate

Automated tests: normal full-shot card and risk model unchanged; at <minimum
calibrated range show Shot Strategy, not a club/risk percentage; wind/elevation
and lateral ledger scale and reconcile; green terrain/hazards/inside-edge and
safe misses; map target same as displayed distance; 5 yd chip vs 75 yd pitch
vs 95 yd at threshold; green/putts never native aim; shot/mode/target changes
invalidate the intent; no HTTP POST to /companion/v1/aim in read-only build.

Run npm ci && npm run build on the integration branch, 31+ companion Windows
safety tests, existing full-shot/short-shot validation, and preview deployment.
Inspect screenshots side-by-side in a known Greywolf hole. Then, on the sim:
GSPro discovery -> read-only window capture parity -> reliable screenshot
registration + physical DPI -> one manually armed controlled click -> >=3
real accepted-marker confirmations with <=3 yd error -> only then integrate
genuine recommendation/strategy target into the paired native command.
Production rollout and cross-PC beta require their own explicit gate.
