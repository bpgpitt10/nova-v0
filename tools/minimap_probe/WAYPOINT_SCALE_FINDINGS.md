# GSPro Minimap Waypoint Scale Findings

Evidence set: preserved Greywolf tee minimaps from the September 12 strategy review plus the September 26 OCR corpus.

## Main finding

GSPro's rendered minimap is locally linear, but screen-reported hole/pin yardage is not always a valid straight-line ruler on routed/dogleg holes.

Across the Greywolf tee captures, ball->pin pixel separation stays approximately fixed near 676 px despite large changes in hole yardage.  On holes with labeled gray GSPro waypoint markers, `waypoint_yards / ball_to_waypoint_pixels` recovers a different local scale when the hole's routed distance exceeds its straight-line minimap distance.

### Strong two-anchor cases

| Hole | Gray labels | Implied local scale | Anchor agreement | Old pin scale bias |
| --- | --- | --- | --- | --- |
| H3 | 211, 320 | ~0.632 yd/px | ~0.7% spread | ~+2.9% |
| H5 | 223, 421 | ~0.737 yd/px | ~0.4% spread | ~+5.2% |
| H10 | 295, 434 | ~0.794 yd/px | ~0.05% spread | ~+1.1% |
| H14 | 209, 341 | ~0.635 yd/px | ~0.04% spread | ~+3.3% |

The independent anchors agreeing within <1% on four unrelated hole shapes is the key validation that the gray waypoint label can serve as the minimap's own ruler.

### Counterexamples to ball->pin scaling

- H1: 212 yd gray waypoint implies ~0.499 yd/px while `350 / ball_to_pin_pixels` gives ~0.517 yd/px, about +3.7% high.  This reproduces the mismatch that previously motivated the temporary 1.0375 forward correction.
- H17: 210 yd gray waypoint implies ~0.517 yd/px while the pin-derived scale is ~0.551 yd/px, about +6.6% high.

Therefore 1.0375 is not a universal correction.  It was compensating for H1's routed-yardage / straight-pixel mismatch.

## Mid-hole evidence

A preserved fairway frame contains gray labels 177 yd and 22 yd.  The farther 177 yd marker implies ~0.362 yd/px.  The very short 22 yd marker is within only about 59 px of the ball, so a one- or two-pixel center estimate materially changes its ratio.  The resolver should therefore prefer farther waypoints (currently >=75 yd) and treat near-field labels as non-authoritative.

This demonstrates the waypoint-ruler approach is not limited to tee shots and naturally follows GSPro zoom changes.

## Scale policy

1. Prefer labeled gray GSPro waypoints.
2. If multiple long-enough waypoint labels are visible, use their median implied scale and require <=2.5% spread.
3. Ignore very short labels for authoritative scaling because pixel-centering error becomes large in percentage terms.
4. On par-3 tee shots, ball->pin scaling is acceptable as the explicit fallback because dogleg routing is not a concern.
5. On non-par-3 states with no trusted waypoint, fail closed rather than silently use routed hole yardage as a straight-line ruler.
6. Keep pin-derived scale as a diagnostic only on non-par-3 states.

## Still to automate

The math/policy is now deterministic.  Remaining computer-vision work is to pair a detected low-saturation gray circular waypoint marker with its nearby numeric label.  Existing Click Lab already has the screenshot capture, ball detection, pin detection, Tesseract plumbing, and fail-closed execution path, so this should remain isolated until marker/label pairing is proven across the corpus.
