# GSPro Minimap Waypoint Scale Findings

Evidence set: preserved Greywolf tee minimaps from the September 12 strategy review plus the September 26 OCR corpus.

## Main finding

GSPro's rendered minimap is locally linear, but screen-reported hole/pin yardage is not always a valid straight-line ruler on routed/dogleg holes.

Across the Greywolf tee captures, ball->pin pixel separation stays approximately fixed near 676 px despite large changes in hole yardage. On holes with labeled gray GSPro waypoint markers, `waypoint_yards / ball_to_waypoint_pixels` recovers the minimap's actual local scale even when the hole's routed distance exceeds its straight-line minimap distance.

## Automatic tee-corpus result

`waypoint_scale_cv.py` now detects the low-saturation gray waypoint oval, crops the nearby white numeric label, OCRs the yardage, and feeds the observation into `waypoint_scale.py`.

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

## Mid-hole evidence

A preserved fairway frame contains gray labels 177 yd and 22 yd. The farther 177 yd marker implies ~0.362 yd/px. The very short 22 yd marker is within only about 59 px of the ball, so a one- or two-pixel center estimate materially changes its ratio. The resolver therefore prefers farther waypoints (currently >=75 yd) and treats near-field labels as non-authoritative.

This demonstrates the waypoint-ruler approach is not inherently limited to tee shots and can be recomputed after GSPro zooms.

## Scale policy

1. Prefer labeled gray GSPro waypoints.
2. If multiple long-enough waypoint labels are visible, use their median implied scale and require <=2.5% spread.
3. Ignore very short labels for authoritative scaling because pixel-centering error becomes large in percentage terms.
4. On par-3 tee shots, ball->pin scaling is acceptable as the explicit fallback because dogleg routing is not a concern.
5. On non-par-3 states with no trusted waypoint, fail closed rather than silently use routed hole yardage as a straight-line ruler.
6. Keep pin-derived scale as a diagnostic only on non-par-3 states.

## Auto-aim implication

Looper's own map can always display a course-space aim point without knowing GSPro pixels. A physical GSPro minimap click is different: it requires the live minimap transform.

The safest runtime model is therefore to re-register from the current minimap immediately before every automatic click rather than trying to remember a scale from the tee. A zoom, pan, rotation, or new ball position should invalidate the previous pixel transform. The next validation task is to prove the same automatic waypoint-scale resolver on multiple preserved post-shot / zoomed minimaps and then plug that live resolver into the isolated Click Lab actuator.
