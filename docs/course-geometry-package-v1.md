# CourseGeometryPackage v1

`CourseGeometryPackage v1` is Looper's deterministic, course-wide static-geometry boundary. It replaces per-screenshot geometry registration with one fixed course coordinate system while keeping live GSPro sensors independent.

## Source authority

| Concern | Authority | Package behavior |
| --- | --- | --- |
| Fairway, green, tee, bunker, rough, mapped water | Preserved OpenStreetMap snapshot | Compiled once into course-wide Polygon/MultiPolygon features |
| Ball position after a shot | GSPro `currentRound` world X/Z | Converted with the validated course registration transform |
| Opening-tee position | Trusted hole identity + cached selected OSM tee | Does not trust stale `currentRound` from the prior hole |
| Wind | GSPro top-center HUD OCR (`gspro-screen-wind-panel`) | Required live state; never embedded or inferred from OSM |
| Red penalty, OB, green heatmap, simulator overrides | GSPro screen/minimap sensors | Separate overlay/fallback layers |
| Terrain | Official LiDAR where compiled | Separate static terrain extension; Hole 1 render proof currently available |

Wind OCR failure means **unavailable**, never zero/calm. The displayed cardinal direction retains `gspro-display` semantics until wind-from versus wind-toward is field-validated.

## Package guarantees

- One fixed east/north course coordinate system in yards.
- Correct GeoJSON-style `Polygon` and `MultiPolygon` topology, including inner rings.
- Course-wide feature storage with a 100-yard spatial index.
- Eighteen hole views that reference shared feature IDs and apply a bounded render clip.
- Locked selected-tee and target-green anchors with residual checks against preserved GSPro yardages.
- A GSPro-world-to-course transform fitted to 17 preserved tie points.
- `render-and-strategy-shadow-only`; the package has no recommendation authority.

The Greywolf proof currently resolves the 17 registration tie points with a maximum package-space residual below 0.002 yard. The broader preserved field proof remains the activation evidence: 38 of 40 tested surface endpoints were inside the expected OSM surface and all 40 were within 3 yards.

## Rebuild and verify

From the repository root:

```bash
npm run course-geometry:build
npm run course-geometry:test
npm run course-geometry:check
npm run build
```

Inputs live under `artifacts/osm-proof/` plus `config/course-geometry/greywolf-v1.json`. The committed web payload is `public/course-geometry/greywolf-v1.json`. Builds are deterministic and fail when the committed payload is stale.

## Current display limitations

- Hole 1 includes the preserved LiDAR contours, green terrain summary, elevation profile, and Round 215 live-position proof.
- Holes 2–18 currently render their OSM geometry only and say so in the UI.
- Greywolf's OSM route tag reports Hole 6 as par 6 and omits Hole 15 par. The renderer shows `Par unverified` instead of presenting either value as fact.
- No OSM geometry or LiDAR value is yet applied to club choice or aim. Strategy use remains shadow-only until its separate acceptance gates pass.
