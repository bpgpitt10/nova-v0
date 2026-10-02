# GSPro Minimap Waypoint Scale Findings

Evidence set: preserved Greywolf tee minimaps from the September 12 strategy review plus the September 26 OCR corpus.

## Main finding

GSPro's rendered minimap is locally linear, but screen-reported hole/pin yardage is not always a valid straight-line ruler on routed/dogleg holes.

Across the Greywolf tee captures, ball->pin pixel separation stays approximately fixed near 676 px despite large changes in hole yardage. On holes with labeled gray GSPro waypoint markers, `waypoint_yards / ball_to_waypoint_pixels` recovers the minimap's actual local scale even when the hole's routed distance exceeds its straight-line minimap distance.

## Automatic tee-corpus result

`waypoint_scale_cv.py` detects the low-saturation gray waypoint oval, crops the nearby white numeric label, OCRs the yardage, and feeds the observation into `waypoint_scale.py`.

The detector/resolver was run against all 18 preserved Greywolf tee minimaps:

- 14 non-par-3 holes: gray waypoint marker + yardage were detected automatically and produced an authoritative scale.
- 4 par-3 holes (6, 9, 12, 15): no gray routing waypoint was required; the explicit ball->pin par-3 fallback produced the scale.
- Result: **18/18 tee minimaps resolved without a hand-entered scale or a universal correction factor.**

Automatically read waypoint labels by hole:

- H1: 212
- H2: 226
- H3: 320, 211
- H4: 228
- H5: 421, 223
- H7: 193
- H8: 225
- H10: 434, 295
- H11: 177
- H13: 209
- H14: 341, 209
- H16: 216
- H17: 210
- H18: 230

### Strong two-anchor cases

| Hole | Gray labels | Implied local scale | Anchor agreement | Old pin scale bias |
| --- | --- | --- | --- | --- |
| H3 | 320, 211 | ~0.631 yd/px | ~0.23% spread | ~+3.0% |
| H5 | 421, 223 | ~0.737 yd/px | ~0.01% spread | ~+5.2% |
| H10 | 434, 295 | ~0.793 yd/px | ~0.03% spread | ~+1.3% |
| H14 | 341, 209 | ~0.635 yd/px | ~0.21% spread | ~+3.3% |

The independent anchors agreeing within 0.23% on four unrelated hole shapes is the key validation that the gray waypoint label is a true ruler for the rendered minimap.

### Counterexamples to ball->pin scaling

- H1: 212 yd gray waypoint implies ~0.499 yd/px while `350 / ball_to_pin_pixels` gives ~0.517 yd/px, about +3.6% high. This reproduces the mismatch that previously motivated the temporary 1.0375 forward correction.
- H17: 210 yd gray waypoint implies ~0.517 yd/px while the pin-derived scale is ~0.551 yd/px, about +6.6% high.

Therefore 1.0375 is not a universal correction. It was compensating for H1's routed-yardage / straight-pixel mismatch.

## OCR hardening

The original single-threshold OCR was perfect on the clean tee PNGs but one older JPEG approach frame could turn `51` into `91`. The detector now votes across fixed bright thresholds before accepting a label. On the preserved corpus this keeps the tee labels correct and recovers the visible compressed approach labels, including 51, 177/22, 126, 27, 222 and 56.

## Zoom registration result

The older `minimap_registration.py` approach is the correct way to carry a calibrated tee frame through GSPro's post-shot zoom, pan and rotation. It solves a similarity transform from the current minimap back into the cached tee minimap.

A blind search across the OCR corpus found multiple real Greywolf post-shot states. Two strong zoom cases were validated quantitatively using three independent facts:

1. SIFT/RANSAC course-image registration solved current pixels -> tee pixels;
2. the current white pin marker was transformed and compared with the known tee pin marker;
3. the transformed current ball position was converted to yards using the corrected tee waypoint scale and compared with GSPro's visible current distance-to-pin.

Results:

| State | Registration scale/rotation | Pin cross-check | Canonical remaining distance | GSPro distance | Yard error |
| --- | --- | --- | --- | --- | --- |
| Greywolf H8 shot 2 | ~0.387x / +24.0 deg | 0.52 px | 150.71 yd | 150.6 yd | **0.11 yd** |
| Greywolf H13 shot 2 | ~0.346x / +32.7 deg | 1.57 px | 112.97 yd | 112.5 yd | **0.47 yd** |

These are strongly zoomed/rotated states, so this is direct evidence that **we do not need to rediscover yards-per-pixel after every zoom**. The correct model is:

- calibrate the tee minimap once using gray waypoints (or ball->pin on a par 3);
- when GSPro changes the minimap, solve the current->tee similarity transform;
- express the current ball and desired target in the calibrated tee frame;
- transform the desired target back into the current minimap frame for the physical click.

The blind corpus search also produced visually plausible wrong registrations. Their transformed pin markers missed the known tee pin by ~165 px and ~389 px. This makes the white-pin cross-check an effective fail-closed acceptance gate. `minimap_registration.py` now exposes `register_current_to_canonical_verified`, which permits lower feature-match counts only when the independently detected pin also lands within the configured pixel tolerance.

`canonical_position_from_hole_model` now accepts a `canonical_yards_per_pixel` override so post-shot geometry can use the corrected waypoint-derived tee scale rather than the legacy routed-hole/pin scale stored in older HoleModels.

`minimap_zoom_registration_proof.py` locks the H8/H13 acceptance math and the false-registration rejection into a deterministic proof.

## Mid-hole ruler evidence

The older corpus also contains several post-shot minimaps where gray routing labels remain visible. These are no longer required for zoom calibration if tee registration succeeds, but they remain useful independent diagnostics.

Two zoomed approach frames contain long gray rulers and a readable current PIN distance:

- Approach frame 005: gray 177 yd ruler gives ~0.3621 yd/px; current PIN 245 yd over ball->pin pixels gives ~0.3617 yd/px (~0.10% difference).
- Approach frame 006: gray 126 yd ruler gives ~0.2551 yd/px; current PIN 173 yd over ball->pin pixels gives ~0.2555 yd/px (~0.15% difference).

A preserved fairway frame also contains gray labels 177 yd and 22 yd. The very short 22 yd marker is too close to the ball to be a stable authoritative ruler; the resolver therefore prefers labels >=75 yd.

## Auto-aim implication

Looper's own map can always display a course-space aim point without knowing GSPro pixels. A physical GSPro minimap click requires the live pixel transform.

The runtime model should now be:

1. **Tee:** capture minimap and resolve authoritative scale from gray waypoints; par 3 may use direct ball->pin.
2. Cache the tee minimap as the canonical GSPro pixel frame for the hole.
3. Before every physical Auto Aim click, capture the current minimap.
4. Detect the current ball and pin markers.
5. Register current minimap -> canonical tee minimap with the similarity transform.
6. Require the transformed current pin to land on the canonical tee pin within a tight tolerance; otherwise fail closed and do not click.
7. Convert Looper's desired course/aim point into the calibrated canonical frame.
8. Invert the current->canonical transform to obtain the current GSPro minimap click pixel.
9. Click once, then use the existing magenta-target verification path to confirm GSPro accepted the intended target.

The next physical simulator gate is therefore no longer 'solve zoom scaling.' It is: **wire the corrected canonical tee scale + verified zoom registration into isolated Click Lab, then prove one real post-shot recommendation click on GSPro.** Production Live Caddie remains untouched until that passes.
