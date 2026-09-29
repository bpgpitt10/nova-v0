# Looper Experiment Ledger

This file is the canonical lightweight record of active Looper experiments. Update it when an experiment starts, changes state, is validated, is merged, or is abandoned.

## Status meanings

- **BUILT** — implementation exists but has not yet been proven in the real target environment.
- **OFFLINE VALIDATED** — deterministic/unit/replay/build checks pass, but the sim/GSPro behavior is not yet proven.
- **SIM VALIDATED** — behavior has been proven against live GSPro/sim conditions.
- **SHADOW** — runs beside the product without changing player-facing behavior or GSPro control.
- **MERGED** — experiment has graduated into the active product path.
- **PAUSED** — intentionally not being advanced.

---

## 1. Aim Descriptor / Caddie Language

**Goal**  
Describe the optimizer's already-selected absolute aim point in golfer language without changing the recommendation itself.

**Current path**  
`src/liveCaddie/aimDescriptor.ts` -> `aimDescriptorCore.ts` with shot-frame helpers in `aimDescriptorFrame.ts`.

**Current lineage**  
Originally built on `live-caddie-aim-descriptor-v1`, then integrated into the Live Caddie lineage and reconciled with the exact-pin / high-resolution green targeting work on `exact-pin-outputlog-v1`. Shot-frame hardening from `aim-descriptor-shot-frame-v1` is now fast-forwarded into `exact-pin-outputlog-v1`.

**Status**  
**SHADOW / OFFLINE BUILD VALIDATED**

**Current hierarchy**

Tee / long shots:
1. meaningful bunker/water landmark
2. fairway zone
3. fairway edge
4. nearby pin only when genuinely useful
5. center-line fallback

Approach / par-3 shots:
1. exact-pin relationship when it faithfully describes the selected point
2. green zone
3. meaningful hazard landmark
4. fairway/edge fallbacks
5. center-line fallback

**Important data contract**

- Exact GSPro pin coordinates are the anchor for pin-relative language.
- The high-resolution ~1 yd green terrain model influences strategic target, elevation, slope and rollout.
- The actual green polygon remains authoritative for green boundary, width, edge and front/middle/back/left/right zone language because the high-resolution terrain grid intentionally extends beyond the putting surface.
- `Aim at the pin` is reserved for approximately <=1.25 yd separation from the exact pin.
- Meaningful longitudinal shifts can be expressed as `short of` / `past` the pin rather than being incorrectly collapsed to `at pin`.
- Measured context can include fairway width, green width, and relevant bunker/water start distance.
- Player-facing directional language is now computed in the **current shot frame** (ball -> planning target), not global course X/Y. This applies to fairway left/center/right, fairway-edge side, green front/middle/back + left/right, and fairway/green width facts.
- Hazard `begins about N yd` context now requires the hazard to intersect the recommended line rather than using the nearest Euclidean point to the ball.

**Validated**

- Deterministic descriptor logic implemented.
- Shadow-only; does not alter club ranking, aim ranking, absolute recommendation, or GSPro execution.
- Reconciled with exact-pin + green-detail data model.
- Shot-frame branch diff touched only descriptor-layer files.
- Whitelisted validation branch `web-aim-descriptor-shot-frame-validation-v2` completed a full TypeScript/Vite production build READY.
- `aimDescriptorFrameProof.ts` now contains deterministic aligned/rotated fairway, rotated green, rotated exact-pin, and longitudinal pin-shift scenarios as regression source.
- A temporary GitHub Actions runner intended to execute those scenarios failed before recording meaningful job steps; it was removed. Do **not** count that runner as a scenario pass. The build/typecheck is the validated evidence today.

**Still to validate**

- Execute the deterministic scenario matrix in a reliable test runner rather than only compiling it.
- Review real shadow examples across tee shots, approaches, tucked pins, multiple bunkers, unusual green shapes and doglegs.
- Decide when shadow language is good enough to become player-facing.

---

## 2. Minimap Click Lab / AutoAim Actuation

**Goal**  
Prove the mechanical contract:

`recommended absolute course point -> GSPro minimap pixel -> one click -> GSPro aim changes correctly`

This experiment does not decide where to aim.

**Branch**  
`minimap-click-lab-v0`

**Location**  
`tools/minimap_probe/`

**Status**  
**PARTIAL SIM VALIDATION — CENTER CLICK PASS / HARDENED LATERAL RETEST READY**

**What exists**

- Guarded one-shot click harness.
- Preview-only default mode.
- Dynamic ball + pin registration from the current minimap.
- Dynamic yards-per-pixel calibration from current GSPro minimap state.
- Right/forward and absolute Looper-coordinate modes.
- GSPro foreground/window bounds checks before any input.
- Predicted point must be inside the minimap interior.
- Exactly one left click; previous cursor position is restored afterward.
- Before / preview / after screenshots and JSON result evidence.
- Windows launcher using an isolated `click_lab_runner.py` hardening layer around the original lab.
- Transform proof covering center/left/right handedness, rotated minimap orientation, and changed scale/zoom.
- Marker-identity proof that explicitly separates the real player marker from GSPro's magenta current-aim crosshair.
- Direct post-click verification from the magenta minimap target marker; AIM-card OCR is now fallback-only.
- Offline screenshot replay support.

**Intentionally does NOT**

- change minimap zoom
- press LEFT/RIGHT aim keys
- import Live Caddie strategy
- automatically loop clicks
- modify Live Caddie state

**Live validation — 2026-09-29**

- Windows launcher encoding issue was fixed by removing non-ASCII console text that Windows PowerShell 5.1 misparsed.
- Click Lab transform proof passed center/left/right handedness, rotated minimap handedness, and zoom/scale conversion.
- Greywolf Hole 1 was used from the tee with 350.2 yd live distance-to-pin.
- PIN-card OCR failed, so the deliberate `-Distance 350.2` fallback was used for the mechanical test.
- A 200 yd straight-ahead preview placed the predicted crosshair on the visible GSPro white aim line at the expected depth.
- A repeated 200 yd center one-shot click was accepted by GSPro and the magenta target marker appeared essentially centered on the white aim line at the intended depth. This is the first live proof that the predicted minimap pixel can actuate the intended center-line target.

**Lateral regression discovered**

- The +10 yd right preview looked geometrically plausible, but its reported scale jumped from roughly `0.52 yd/px` to `1.22 yd/px`.
- The subsequent click was accepted by GSPro but verified at roughly 270 yd radial distance rather than the requested ~200 yd.
- Root cause: after GSPro aim had been reset, the generic saturated-marker detector could select GSPro's magenta current-aim crosshair as the BALL marker.
- This was a registration/marker-identity failure, not a mouse-coordinate failure.

**Hardening completed away from sim**

- `click_lab_runner.py` now explicitly rejects the magenta GSPro aim marker as BALL, including hollow-crosshair cases where center HSV alone is insufficient.
- Registration now prints BALL, PIN, and SCALE diagnostics before actuation.
- Post-click verification now detects GSPro's actual magenta minimap target, re-registers BALL/PIN after the click, converts the accepted point back into forward/right yards, and computes vector error against the requested target.
- `PASS_DISTANCE` is retained as the legacy result label, but the primary acceptance check is now <=3 yd **2D forward/right vector error**, not merely radial distance.
- AIM-card OCR remains only a fallback when direct minimap-marker verification cannot run.
- `latest_click_lab_marker_verify.png` is produced when direct marker verification succeeds.
- `mss` capture path was updated to the non-deprecated API in the hardened runner.
- Synthetic marker proof was added so magenta-aim-vs-ball identity can be checked with `-RunProof` alongside the transform proof.

**Next live validation sequence**

1. Start directly with `+10 yd right, 200 yd forward` preview using the hardened runner; confirm BALL/PIN/SCALE diagnostics.
2. Click the same +10 target and require direct minimap-marker verification with <=3 yd vector error.
3. Repeat `-10 yd left`.
4. Manually change minimap zoom and repeat one target.
5. Repeat from an approach position after the tee shot.
6. Repeat on a rotated/dogleg minimap.
7. Feed one real Looper absolute recommendation point.

**Acceptance target**  
<=3 yd 2D forward/right vector error from the requested target, with direct visual evidence of BALL/PIN/GSPro aim registration.

**Remaining gate**  
Prove lateral, zoom, approach, rotated/dogleg, and absolute-coordinate cases repeatably. Center-line actuation is already SIM validated visually; the remaining question is repeatable registration across changing minimap states.

---

## 3. Exact Pin + High-Resolution Green Targeting

**Goal**  
Use exact GSPro pin position plus high-resolution green terrain to improve approach targeting, elevation, slope/edge handling and rollout near greens.

**Branch**  
`exact-pin-outputlog-v1`

**Status**  
**ACTIVE DEVELOPMENT / OFFLINE VALIDATED**

**Key contract**

- Exact pin comes from GSPro course-layout/output-log data when available.
- High-resolution green terrain is approximately 1 yd spacing.
- Terrain detail extends beyond the putting surface and must not be mistaken for the green polygon.
- Strategic green-target adjustment is constrained to a small move from the pin/initial target (current model hard cap <=5 yd).
- Descriptor language must report the selected strategic point rather than independently inventing a different pin/green interpretation.
- Tactical slope validity is determined by local surface fit quality, not by an arbitrary maximum slope. Greywolf contains legitimately severe banks that must be preserved when the LiDAR forms a coherent local plane.

**Green slope regression finding — 2026-09-27**

- The original all-18 audit correctly exposed extreme local derivatives, but raw slope magnitude alone was not a valid rejection rule.
- Greywolf H6 contains both a severe nonlinear front tier/ledge region and a separate coherent front-right bank with locally fitted slopes in the ~45–48% range. The latter is steep but internally consistent in the source terrain and must not be flattened solely because it exceeds a conventional green-slope threshold.
- The prior runtime safeguard that rejected 3x3 sector slopes above 12% was therefore too aggressive and was removed.
- Runtime tactical slope now fits a plane to actual ~1 yd terrain grid nodes within 3 yd of the query point, clipped to the actual green polygon.
- A local plane is accepted when at least 8 on-green samples are available and RMS fit error is <=0.35 ft. There is no slope-magnitude ceiling.
- Poorly planar tier/ledge transitions fail the fit-quality gate and fall back to the whole-green trend rather than being interpreted as an extreme putting-surface slope.
- The 3x3 sectors remain useful for coarse pin-location language but are no longer the tactical slope/vector source.

**Offline validation**

- Focused H6 audit confirmed the worst raw 1 yd jumps and 100%+ derivative estimates are concentrated around the severe front transition, while coherent steep patches also exist.
- All-18 green-clipped local-plane audit showed normal/coherent Greywolf patches generally have low residual error, while the meaningful nonlinear problem areas concentrate primarily on H4, H6 and H7.
- The <=0.35 ft RMS gate preserves coherent local slopes above 12% across many holes, including slopes into the 20s and the H6/H7 ~40%+ banks, instead of flattening them.
- Exact-pin/green-detail TypeScript + Vite production build passed after the runtime slope change.

**Current relationship to Aim Descriptor**  
Reconciled. Pin-relative wording uses the exact pin; green zone/width/edge wording uses the real green polygon; directional words and widths now use the current shot frame; context can explain a small terrain-driven strategic shift.

**Remaining gate**  
Live-course validation of the exact pin and green-detail recommendations over multiple holes / pin placements. In particular, verify that GSPro's rendered/modelled H6 severe green features correspond closely enough to the source LiDAR for tactical use; offline LiDAR consistency alone is not SIM validation.

---

## 4. Vercel Preview Validation for Experimental Branches

**Purpose**  
Build validation only; this is infrastructure, not a product experiment.

**Current rule**  
The newer Live Caddie lineage contains a `vercel.json` branch whitelist:

- `*` disabled
- `web-*` enabled
- `auth-cloud-persistence` enabled
- `course-geometry-tactical-v0` enabled

Therefore branches such as `exact-pin-outputlog-v1` intentionally do **not** auto-deploy to Vercel.

**Validated behavior**

- Merely creating a whitelisted branch does not necessarily trigger a deployment.
- An actual commit/push on a whitelisted `web-*` branch does trigger Vercel.
- Temporary validation branch `web-exact-pin-language-validation-v1` successfully built READY from the exact-pin lineage.
- Temporary validation branches `web-aim-descriptor-shot-frame-validation-v1` and `v2` built READY for the shot-frame descriptor implementation; v2 included the deterministic scenario source file in TypeScript compilation.

**Working convention**  
Do not weaken the Vercel whitelist just to validate an experiment. When a non-whitelisted branch needs browser-build validation, fork its current head into a temporary `web-*` validation branch, make a harmless non-runtime validation commit, verify the build, and record the result here.

---

## Experiment management rules

1. Keep experimental code isolated from production behavior until its validation gate is met.
2. Record the branch and exact remaining gate here before calling an experiment "done."
3. Distinguish **offline/build validation** from **live GSPro/sim validation**.
4. Do not treat a successful Vercel build as proof of GSPro behavior.
5. When an experiment graduates, record where it merged and remove obsolete experimental branches only after confirming no unique work remains.
6. If another chat changes the underlying data contract, reconcile dependent experiments here before advancing them.
