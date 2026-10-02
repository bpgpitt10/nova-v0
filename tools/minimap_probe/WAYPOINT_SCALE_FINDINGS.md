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

## OCR hardening

The original single-threshold OCR was perfect on the clean tee PNGs but one older JPEG approach frame could turn `51` into `91`. The detector now votes across fixed bright thresholds before accepting a label. On the preserved corpus this keeps the tee labels correct and recovers the visible compressed approach labels, including 51, 177/22, 126, 27, 222 and 56.

## Mid-hole / zoom evidence

The older corpus contains several post-shot minimaps where GSPro has zoomed the map. Gray routing labels are not present in every zoomed state, so waypoint-only scaling cannot be the entire runtime solution.

Two zoomed approach frames do contain long gray rulers and a readable current PIN distance, allowing an independent scale check:

- Approach frame 005: gray 177 yd ruler gives ~0.3621 yd/px; current PIN 245 yd over ball->pin pixels gives ~0.3617 yd/px (**~0.10% difference**).
- Approach frame 006: gray 126 yd ruler gives ~0.2551 yd/px; current PIN 173 yd over ball->pin pixels gives ~0.2555 yd/px (**~0.15% difference**).

This is encouraging evidence that after GSPro re-centers/zooms around a post-shot state, the current PIN distance may be a valid straight-line ruler even though tee-shot hole yardage was not. Two cases are not enough to make that a universal fallback yet.

A preserved fairway frame also contains gray labels 177 yd and 22 yd. The very short 22 yd marker is too close to the ball to be a stable authoritative ruler; the resolver therefore prefers labels >=75 yd.

## Scale policy

1. Prefer labeled gray GSPro waypoints whenever a long-enough one is visible.
2. If multiple long-enough waypoint labels are visible, use their median implied scale and require <=2.5% spread.
3. Ignore very short labels for authoritative scaling because pixel-centering error becomes large in percentage terms.
4. On par-3 tee shots, ball->pin scaling is acceptable as the explicit fallback because dogleg routing is not a concern.
5. At non-par-3 tee states with no trusted waypoint, fail closed rather than silently use routed hole yardage as a straight-line ruler.
6. Keep testing the current post-shot PIN ruler as the likely fallback after zoom; do not promote it to universal authority until more independent zoomed cases are validated.

## Auto-aim implication

Looper's own map can always display a course-space aim point without knowing GSPro pixels. A physical GSPro minimap click is different: it requires the live minimap transform.

The safest runtime model is to re-register from the current minimap immediately before every automatic click rather than trying to remember a scale from the tee. A zoom, pan, rotation, or new ball position should invalidate the previous pixel transform.

Current proposed resolver order:

1. fresh screenshot of current GSPro minimap;
2. fresh hardened ball marker + pin marker;
3. long gray waypoint ruler if visible;
4. explicit par-3 tee ball->pin fallback;
5. post-shot current-PIN fallback only after the remaining zoom validation proves it sufficiently;
6. fail closed if no trustworthy ruler is available.

The next actuator gate is to plug this fresh scale resolver into the isolated Click Lab and prove one tee click plus one post-shot/zoomed click. Production Live Caddie should remain untouched until those physical tests pass.
